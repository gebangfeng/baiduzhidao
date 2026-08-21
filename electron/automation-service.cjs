const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");

const MAX_CONCURRENT_ACCOUNTS = 3;

class AutomationAnswerService {
  constructor({ app, shell, database, getApiKey, getSettings, notify }) {
    this.app = app;
    this.shell = shell;
    this.database = database;
    this.getApiKey = getApiKey;
    this.getSettings = getSettings;
    this.notify = notify;
    this.automationProcesses = new Map();
    this.browserProcesses = new Map();
  }

  defaultState() {
    return {
      version: 1,
      selectedAccountId: "default",
      accounts: [{ id: "default", name: "默认账号", submissionLimit: 10, startPage: 1 }],
    };
  }

  loadState() {
    const saved = this.database.getSetting("answerAutomation", null);
    if (!saved || !Array.isArray(saved.accounts) || !saved.accounts.length) return this.defaultState();
    return saved;
  }

  saveState(state) {
    this.database.setSetting("answerAutomation", state);
  }

  accountDirectory(accountId) {
    return path.join(this.app.getPath("userData"), "answer-automation", "accounts", accountId);
  }

  progressPath(accountId) {
    return path.join(this.accountDirectory(accountId), "question-progress.json");
  }

  processedCount(accountId) {
    try {
      const rows = JSON.parse(fs.readFileSync(this.progressPath(accountId), "utf8"));
      return Array.isArray(rows) ? rows.length : 0;
    } catch {
      return 0;
    }
  }

  publicAccount(account) {
    return {
      id: account.id,
      name: account.name,
      submissionLimit: Number(account.submissionLimit) || 10,
      startPage: Number(account.startPage) || 1,
      running: this.automationProcesses.has(account.id),
      browserOpen: this.browserProcesses.has(account.id),
      processedCount: this.processedCount(account.id),
    };
  }

  listAccounts() {
    const state = this.loadState();
    const selectedAccountId = state.accounts.some((item) => item.id === state.selectedAccountId)
      ? state.selectedAccountId
      : state.accounts[0].id;
    return {
      selectedAccountId,
      maxConcurrentAccounts: MAX_CONCURRENT_ACCOUNTS,
      accounts: state.accounts.map((account) => this.publicAccount(account)),
    };
  }

  getAccount(accountId) {
    const account = this.loadState().accounts.find((item) => item.id === String(accountId || ""));
    if (!account) throw new Error("找不到所选百度账号配置");
    return account;
  }

  createAccount(name) {
    const cleanName = String(name || "").replace(/\s+/g, " ").trim().slice(0, 30);
    if (!cleanName) throw new Error("账号名称不能为空");
    const state = this.loadState();
    if (state.accounts.length >= 20) throw new Error("最多创建20个账号配置");
    const account = { id: crypto.randomUUID(), name: cleanName, submissionLimit: 10, startPage: 1 };
    state.accounts.push(account);
    state.selectedAccountId = account.id;
    this.saveState(state);
    return this.publicAccount(account);
  }

  deleteAccount(accountId, deleteData = false) {
    const id = String(accountId || "");
    if (id === "default") throw new Error("默认账号不能删除");
    if (this.automationProcesses.has(id) || this.browserProcesses.has(id)) throw new Error("请先停止该账号并关闭浏览器");
    const state = this.loadState();
    const index = state.accounts.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("找不到所选百度账号配置");
    state.accounts.splice(index, 1);
    state.selectedAccountId = "default";
    this.saveState(state);
    if (deleteData) {
      const target = path.resolve(this.accountDirectory(id));
      const parent = path.resolve(path.join(this.app.getPath("userData"), "answer-automation", "accounts"));
      if (!target.startsWith(`${parent}${path.sep}`)) throw new Error("账号数据目录校验失败");
      fs.rmSync(target, { recursive: true, force: true });
    }
    return this.listAccounts();
  }

  updateAccount(input) {
    const state = this.loadState();
    const account = state.accounts.find((item) => item.id === String(input?.accountId || ""));
    if (!account) throw new Error("找不到所选百度账号配置");
    const name = String(input?.accountName || account.name).replace(/\s+/g, " ").trim().slice(0, 30);
    const submissionLimit = Number(input?.submissionLimit);
    const startPage = Number(input?.startPage);
    if (!name) throw new Error("账号名称不能为空");
    if (!Number.isInteger(submissionLimit) || submissionLimit < 1 || submissionLimit > 100) throw new Error("每轮回答数量必须为1～100");
    if (!Number.isInteger(startPage) || startPage < 1) throw new Error("起始页码必须大于或等于1");
    Object.assign(account, { name, submissionLimit, startPage });
    state.selectedAccountId = account.id;
    this.saveState(state);
    return account;
  }

  emit(channel, payload) {
    this.notify(channel, payload);
  }

  appendStream(stream, level, account) {
    if (!stream) return;
    let pending = "";
    stream.setEncoding("utf8");
    const send = (line) => {
      const text = String(line || "").replace(/\u001b\[[0-9;]*m/g, "").trim();
      if (text) this.emit("automation:log", { accountId: account.id, accountName: account.name, level, text, at: new Date().toISOString() });
    };
    stream.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      lines.forEach(send);
    });
    stream.on("end", () => send(pending));
  }

  forkWorker(fileName, account, env) {
    const appPath = this.app.getAppPath();
    let workerCwd = appPath;
    try {
      if (!fs.statSync(appPath).isDirectory()) workerCwd = path.dirname(appPath);
    } catch {
      workerCwd = path.dirname(appPath);
    }
    const child = fork(path.join(__dirname, fileName), [], {
      cwd: workerCwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PLAYWRIGHT_BROWSERS_PATH: "0", ...env },
      silent: true,
    });
    this.appendStream(child.stdout, "info", account);
    this.appendStream(child.stderr, "error", account);
    return child;
  }

  playwrightBrowsersPath() {
    if (this.app.isPackaged) {
      return path.join(process.resourcesPath, "playwright-browsers");
    }
    return "0";
  }

  sendMessage(child, message) {
    if (!child) return false;
    if (child.connected && typeof child.send === "function") {
      child.send(message, () => {});
      return true;
    }
    return false;
  }

  waitForSpawn(child, label) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        const detail = error?.message || [error].flat().filter(Boolean).join(" ") || "未知错误";
        reject(new Error(`${label}启动失败：${detail}`));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  async start(input) {
    const accountId = String(input?.accountId || "");
    if (this.automationProcesses.has(accountId)) throw new Error("该账号的自动答题任务已经在运行");
    if (this.automationProcesses.size >= MAX_CONCURRENT_ACCOUNTS) throw new Error(`最多同时运行${MAX_CONCURRENT_ACCOUNTS}个账号`);
    const account = this.updateAccount(input);
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error("请先在全局设置中配置API密钥");
    await this.stopBrowser(account.id);
    const dataDirectory = this.accountDirectory(account.id);
    fs.mkdirSync(dataDirectory, { recursive: true });
    const settings = this.getSettings();
    const child = this.forkWorker("automation-worker.cjs", account, {
      GEEKAI_API_KEY: apiKey,
      AI_API_BASE: settings.baseUrl,
      AI_MODEL: settings.answerModel || "gpt-5.6-sol",
      ANSWER_SYSTEM_PROMPT: String(settings.answerPrompt || ""),
      AI_SUBMISSION_LIMIT: String(account.submissionLimit),
      START_PAGE: String(account.startPage),
      AUTOMATION_DATA_DIR: dataDirectory,
      AI_LOCK_FILE: path.join(this.app.getPath("userData"), "answer-automation", "ai-request.lock"),
      PLAYWRIGHT_BROWSERS_PATH: this.playwrightBrowsersPath(),
      CLOSE_BROWSER_ON_COMPLETE: "1",
      USE_BUNDLED_CHROMIUM: "1",
    });
    await this.waitForSpawn(child, "任务进程");
    this.automationProcesses.set(account.id, child);
    this.emit("automation:log", {
      accountId: account.id,
      accountName: account.name,
      level: "info",
      text: "任务进程已启动，正在检查并启动应用自带的 Chromium。",
      at: new Date().toISOString(),
    });
    child.on("error", (error) => this.emit("automation:log", { accountId: account.id, accountName: account.name, level: "error", text: `任务进程异常：${error.message}` }));
    child.on("exit", (code, signal) => {
      this.automationProcesses.delete(account.id);
      this.emit("automation:state", {
        accountId: account.id,
        running: false,
        processedCount: this.processedCount(account.id),
        message: signal || code === null ? "任务已停止" : code === 0 ? "本轮任务已完成" : `任务异常结束（代码${code}）`,
      });
    });
    this.emit("automation:state", { accountId: account.id, running: true, message: "任务运行中" });
    return { ok: true };
  }

  async stop(accountId) {
    const id = String(accountId || "");
    const child = this.automationProcesses.get(id);
    if (!child) return { ok: true };
    this.sendMessage(child, { type: "stop" });
    await new Promise((resolve) => {
      const timer = setTimeout(() => { if (!child.killed) child.kill(); resolve(); }, 8000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    return { ok: true };
  }

  async stopAll() {
    await Promise.all([...this.automationProcesses.keys()].map((id) => this.stop(id)));
    return { ok: true };
  }

  async stopBrowser(accountId) {
    const id = String(accountId || "");
    const child = this.browserProcesses.get(id);
    if (!child) return;
    this.sendMessage(child, { type: "stop" });
    await new Promise((resolve) => {
      const timer = setTimeout(() => { if (!child.killed) child.kill(); resolve(); }, 8000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  async openPage(accountId, type) {
    const account = this.getAccount(accountId);
    const running = this.automationProcesses.get(account.id);
    const messageType = type === "workbench" ? "open-creator-workbench" : "open-answer-history";
    if (this.sendMessage(running, { type: messageType })) {
      return { mode: "automation" };
    }
    if (running) this.automationProcesses.delete(account.id);
    const existing = this.browserProcesses.get(account.id);
    if (this.sendMessage(existing, { type: messageType })) {
      return { mode: "browser" };
    }
    if (existing) this.browserProcesses.delete(account.id);
    const dataDirectory = this.accountDirectory(account.id);
    fs.mkdirSync(dataDirectory, { recursive: true });
    const isWorkbench = type === "workbench";
    const child = this.forkWorker("automation-history-worker.cjs", account, {
      AUTOMATION_DATA_DIR: dataDirectory,
      INITIAL_PAGE_URL: isWorkbench ? "https://zhidao.baidu.com/b/batch/batch-upload" : "https://zhidao.baidu.com/ihome/homepage/myanwser",
      INITIAL_PAGE_LABEL: isWorkbench ? "答主工作台" : "答题记录页面",
    });
    await this.waitForSpawn(child, "浏览器");
    this.browserProcesses.set(account.id, child);
    child.on("exit", () => this.browserProcesses.delete(account.id));
    child.on("error", (error) => this.emit("automation:log", { accountId: account.id, accountName: account.name, level: "error", text: `浏览器启动失败：${error.message}` }));
    return { mode: "browser" };
  }

  clearProgress(accountId) {
    const id = String(accountId || "");
    this.getAccount(id);
    if (this.automationProcesses.has(id)) throw new Error("请先停止该账号的任务");
    const filePath = this.progressPath(id);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { ok: true, processedCount: 0 };
  }

  async openDataFolder(accountId) {
    const account = this.getAccount(accountId);
    const directory = this.accountDirectory(account.id);
    fs.mkdirSync(directory, { recursive: true });
    await this.shell.openPath(directory);
    return { ok: true };
  }

  async shutdown() {
    await Promise.all([
      this.stopAll(),
      ...[...this.browserProcesses.keys()].map((id) => this.stopBrowser(id)),
    ]);
  }

  hasActiveProcesses() {
    return this.automationProcesses.size > 0 || this.browserProcesses.size > 0;
  }
}

module.exports = { AutomationAnswerService, MAX_CONCURRENT_ACCOUNTS };
