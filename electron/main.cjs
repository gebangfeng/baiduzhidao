const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, session, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { TaskDatabase } = require("./database.cjs");
const { LicenseService, publicKeyFromConfig } = require("./license-service.cjs");
const {
  readSourceWorkbook,
  readShareHistoryWorkbook,
  exportResultWorkbook,
  exportTransferShareWorkbook,
  exportShareHistoryWorkbook,
  validateNetdiskLink,
} = require("./excel-service.cjs");
const { TaskRunner } = require("./task-runner.cjs");
const { AutomationAnswerService } = require("./automation-service.cjs");
const { UpdateService } = require("./update-service.cjs");
const {
  getBdstoken,
  listDirectory,
  listDirectoryRecursive,
  ensureDirectory,
  transferOne,
  createShareForFsIds,
  shareOne,
} = require("./baidu-netdisk-service.cjs");
const {
  FIXED_API_BASE,
  API_KEY_GUIDE_URL,
  USER_GUIDE_URL,
  DEFAULT_MODEL,
  normalizeModel,
  normalizeApiBaseUrl,
} = require("./service-config.cjs");
const packageMetadata = require("../package.json");
const CONFIGURABLE_API_BASE = packageMetadata.configurableApiBase === true
  || process.env.CONFIGURABLE_API_BASE === "1";
const LICENSE_PURCHASE_TEXT = String(process.env.LICENSE_PURCHASE_TEXT || packageMetadata.licensePurchaseText || "请联系软件提供方购买授权").trim().slice(0, 100);
const LICENSE_PURCHASE_URL = String(process.env.LICENSE_PURCHASE_URL || packageMetadata.licensePurchaseUrl || "").trim();

function effectiveApiBase(value) {
  if (!CONFIGURABLE_API_BASE) return FIXED_API_BASE;
  if (!licenseService?.state().valid) return FIXED_API_BASE;
  try { return normalizeApiBaseUrl(value || FIXED_API_BASE); }
  catch { return FIXED_API_BASE; }
}

function configuredApiBase(value) {
  if (!CONFIGURABLE_API_BASE) return FIXED_API_BASE;
  licenseService?.assertValid();
  return normalizeApiBaseUrl(value || FIXED_API_BASE);
}

app.setAppUserModelId("cn.local.wangpan.qa");

let mainWindow;
let database;
let licenseService;
let runner;
let automationService;
let updateService;
let automationShutdownStarted = false;
let secretPath;
let baiduCookiePath;
let baiduCookiesDir;
const netdiskRuns = new Map();
const netdiskDirectoryReads = new Map();
const DEFAULT_TITLE_PROMPT = "标题语气自然，像用户咨询素材获取；根据素材类型灵活使用“求、哪里可以获取、怎么获取”等表达，避免所有标题使用同一句式。";
const DEFAULT_INTRO_PROMPT = "书籍/小说：说明题材类型、核心人物身份与特点、主线脉络及叙事主题，避免虚构无法从标题判断的具体情节。影视：说明题材、核心主题、主要看点、风格定位和适合人群。学习资料：说明知识领域、适用学段或考试场景、核心模块、内容范围、配套形式、学习收获和目标人群。";
const DEFAULT_ANSWER_MODEL = "gpt-5.6-sol";
const MODEL_LIBRARY_URL = "https://geekai.co/models";
const DEFAULT_CLOUD_RULES_URL = "https://bd.aiserve.top/rules.json";
const UPDATE_MANIFEST_URL = "https://bd.aiserve.top/latest.json";
const DEFAULT_ANSWER_PROMPT = `请生成百度知道优质回答，只输出自然连贯的回答正文。
内容依次用自然段完成以下表达：先开门见山给出核心观点；再以第一人称亲身经历举例，贴近普通人生活；接着分析现象背后的深层原因；然后提供可落地、能直接执行的办法；最后延伸感悟，引发情感共鸣。

规则：
禁止输出任何段落标题、板块名称、方括号标签、总结标签或序号；
直接从回答内容开始，使用自然段衔接，不使用项目符号；
语气为热心分享经验的普通网友，拒绝生硬教科书式文字；
内容贴合情感生活类问答，逻辑通顺，具备共情力；
不要过度口语化，满足平台优质回答审核标准；
回答尽量简洁。`;

function normalizeAnswerModel(model) {
  const value = String(model || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) ? value : DEFAULT_ANSWER_MODEL;
}

function normalizeAnswerPrompt(prompt) {
  return String(prompt || "").trim().slice(0, 4000) || DEFAULT_ANSWER_PROMPT;
}

function normalizeResourceType(value) {
  const type = String(value || "auto");
  if (/^custom:[a-zA-Z0-9_-]{1,80}$/.test(type)) return type;
  return ["auto", "study", "book", "film", "template", "general"].includes(type) ? type : "auto";
}

function normalizeCustomRules(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 50).map((rule, index) => {
    const rawId = String(rule?.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    const keywords = Array.isArray(rule?.keywords)
      ? rule.keywords
      : String(rule?.keywords || "").split(/[,，、\n]/);
    return {
      id: rawId || `rule_${Date.now()}_${index}`,
      name: String(rule?.name || "自定义规则").trim().slice(0, 30) || "自定义规则",
      keywords: keywords.map((item) => String(item || "").trim().slice(0, 50)).filter(Boolean).slice(0, 30),
      titlePrefix: String(rule?.titlePrefix || "求").trim().slice(0, 20),
      titleSuffix: String(rule?.titleSuffix || "网盘链接获取").trim().slice(0, 30),
      introTemplate: String(rule?.introTemplate || "").trim().slice(0, 800),
      enabled: rule?.enabled !== false,
    };
  });
}

function normalizeCloudRulesUrl(value) {
  const url = String(value || "").trim().slice(0, 1000);
  if (!url) return "";
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("云端规则地址格式不正确"); }
  if (parsed.protocol !== "https:") throw new Error("云端规则地址必须使用HTTPS");
  return parsed.toString();
}

function cloudRulesCache() {
  const saved = database?.getSetting("cloudRulesCache", {}) || {};
  return {
    version: String(saved.version || "").slice(0, 80),
    updatedAt: String(saved.updatedAt || "").slice(0, 80),
    sourceUrl: String(saved.sourceUrl || "").slice(0, 1000),
    rules: normalizeCustomRules(saved.rules),
  };
}

async function syncCloudRules(inputUrl) {
  const sourceUrl = normalizeCloudRulesUrl(inputUrl);
  if (!sourceUrl) throw new Error("请先填写云端规则地址");
  const response = await fetch(sourceUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`云端规则下载失败（HTTP ${response.status}）`);
  const body = await response.text();
  if (body.length > 1000000) throw new Error("云端规则文件过大，最大支持1MB");
  let document;
  try { document = JSON.parse(body); } catch { throw new Error("云端规则不是有效的JSON文件"); }
  const incoming = Array.isArray(document) ? document : document?.rules;
  if (!Array.isArray(incoming) || !incoming.length) throw new Error("云端规则文件中没有有效规则");
  const seenRuleIds = new Set();
  const rules = normalizeCustomRules(incoming.filter((rule) => rule?.id)).map((rule) => ({
    ...rule,
    id: rule.id.startsWith("cloud_") ? rule.id : `cloud_${rule.id}`,
  })).filter((rule) => {
    if (seenRuleIds.has(rule.id)) return false;
    seenRuleIds.add(rule.id);
    return true;
  });
  if (!rules.length) throw new Error("云端规则必须包含稳定的id字段");
  const cache = {
    version: String(Array.isArray(document) ? "" : document?.version || "未标注").slice(0, 80),
    updatedAt: new Date().toISOString(),
    sourceUrl,
    rules,
  };
  database.setSetting("cloudRulesCache", cache);
  return structuredClone(cache);
}
const smokeMode = process.argv.includes("--smoke-test");
const captureNetdiskMode = process.argv.includes("--capture-netdisk");
const captureShareMode = process.argv.includes("--capture-share");
const captureTransferFilledMode = process.argv.includes("--capture-transfer-filled");
const captureSettingsMode = process.argv.includes("--capture-settings");
const captureAutomationMode = process.argv.includes("--capture-automation");
const captureMode = process.argv.includes("--capture-ui") || captureNetdiskMode || captureShareMode || captureTransferFilledMode || captureSettingsMode || captureAutomationMode;
if (smokeMode || captureMode) {
  app.setPath(
    "userData",
    path.join(app.getPath("temp"), captureMode ? "wangpan-qa-studio-capture" : "wangpan-qa-studio-smoke"),
  );
}

function assertTrusted(event) {
  const url = event.senderFrame?.url || "";
  const trusted = url.startsWith("file://")
    || url.startsWith("http://127.0.0.1:5173");
  if (!trusted) throw new Error("拒绝来自非应用页面的请求");
}

function validateFilePath(filePath) {
  if (typeof filePath !== "string" || !/\.xlsx$/i.test(filePath)) {
    throw new Error("请选择.xlsx格式的Excel文件");
  }
  return path.resolve(filePath);
}

function normalizeApiKeyValue(value, { allowEmpty = true } = {}) {
  let apiKey = String(value || "").trim();
  if (apiKey === "••••••••") return apiKey;
  apiKey = apiKey.replace(/^Bearer\s+/i, "").trim();
  if ((apiKey.startsWith('"') && apiKey.endsWith('"')) || (apiKey.startsWith("'") && apiKey.endsWith("'"))) {
    apiKey = apiKey.slice(1, -1).trim();
  }
  if (!apiKey) {
    if (allowEmpty) return "";
    throw new Error("请先填写API密钥");
  }
  if (apiKey.length > 1024) throw new Error("API密钥过长，请只粘贴密钥本身");
  if (!/^[\x21-\x7E]+$/.test(apiKey)) {
    throw new Error("API密钥格式不正确：检测到中文、全角字符或空格，请只粘贴密钥本身");
  }
  return apiKey;
}

async function saveApiKey(apiKey) {
  if (!apiKey) {
    await fs.rm(secretPath, { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("当前Windows账户无法使用系统加密存储");
  }
  const encrypted = safeStorage.encryptString(apiKey);
  await fs.writeFile(secretPath, encrypted);
}

async function getApiKey() {
  try {
    const encrypted = await fs.readFile(secretPath);
    return safeStorage.decryptString(encrypted);
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function getValidatedApiKey() {
  return normalizeApiKeyValue(await getApiKey());
}

async function saveBaiduCookie(cookie) {
  return saveBaiduAccountCookie(getSelectedBaiduAccountId(), cookie);
}

function safeBaiduAccountId(accountId) {
  const value = String(accountId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return value || "default";
}

function baiduAccountCookiePath(accountId) {
  return path.join(baiduCookiesDir, `${safeBaiduAccountId(accountId)}.bin`);
}

function defaultBaiduAccountsState() {
  return {
    version: 1,
    selectedAccountId: "default",
    accounts: [{ id: "default", name: "默认账号", uk: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
  };
}

function normalizeBaiduAccountsState(saved) {
  const fallback = defaultBaiduAccountsState();
  if (!saved || !Array.isArray(saved.accounts) || !saved.accounts.length) return fallback;
  const seen = new Set();
  const accounts = saved.accounts.map((account, index) => {
    const id = safeBaiduAccountId(account?.id || (index === 0 ? "default" : ""));
    if (seen.has(id)) return null;
    seen.add(id);
    return {
      id,
      name: String(account?.name || (id === "default" ? "默认账号" : "网盘账号")).replace(/\s+/g, " ").trim().slice(0, 30) || "网盘账号",
      uk: String(account?.uk || "").slice(0, 80),
      createdAt: String(account?.createdAt || new Date().toISOString()),
      updatedAt: String(account?.updatedAt || new Date().toISOString()),
    };
  }).filter(Boolean).slice(0, 20);
  if (!accounts.length) return fallback;
  const selectedAccountId = accounts.some((account) => account.id === saved.selectedAccountId)
    ? saved.selectedAccountId
    : accounts[0].id;
  return { version: 1, selectedAccountId, accounts };
}

function getBaiduAccountsState() {
  return normalizeBaiduAccountsState(database.getSetting("baiduNetdiskAccounts", null));
}

function saveBaiduAccountsState(state) {
  database.setSetting("baiduNetdiskAccounts", normalizeBaiduAccountsState(state));
}

function getSelectedBaiduAccountId() {
  return getBaiduAccountsState().selectedAccountId;
}

function getBaiduAccount(accountId) {
  const state = getBaiduAccountsState();
  const id = safeBaiduAccountId(accountId || state.selectedAccountId);
  const account = state.accounts.find((item) => item.id === id);
  if (!account) throw new Error("找不到所选百度网盘账号");
  return account;
}

async function saveBaiduAccountCookie(accountId, cookie) {
  const id = getBaiduAccount(accountId).id;
  const filePath = baiduAccountCookiePath(id);
  if (!cookie) {
    await fs.rm(filePath, { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("当前Windows账户无法使用系统加密存储");
  await fs.mkdir(baiduCookiesDir, { recursive: true });
  await fs.writeFile(filePath, safeStorage.encryptString(cookie));
}

async function getBaiduCookie(accountId) {
  const id = getBaiduAccount(accountId).id;
  try {
    return safeStorage.decryptString(await fs.readFile(baiduAccountCookiePath(id)));
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function publicBaiduAccount(account) {
  return {
    id: account.id,
    name: account.name,
    uk: account.uk,
    hasCookie: Boolean(await getBaiduCookie(account.id)),
  };
}

async function listBaiduAccounts() {
  const state = getBaiduAccountsState();
  return {
    selectedAccountId: state.selectedAccountId,
    accounts: await Promise.all(state.accounts.map(publicBaiduAccount)),
  };
}

function updateBaiduAccount(accountId, patch) {
  const state = getBaiduAccountsState();
  const account = state.accounts.find((item) => item.id === safeBaiduAccountId(accountId));
  if (!account) throw new Error("找不到所选百度网盘账号");
  Object.assign(account, patch, { updatedAt: new Date().toISOString() });
  saveBaiduAccountsState(state);
  return account;
}

async function createBaiduAccount(name) {
  const cleanName = String(name || "").replace(/\s+/g, " ").trim().slice(0, 30);
  if (!cleanName) throw new Error("账号名称不能为空");
  const state = getBaiduAccountsState();
  if (state.accounts.length >= 20) throw new Error("最多创建20个网盘账号");
  const account = { id: crypto.randomUUID(), name: cleanName, uk: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  state.accounts.push(account);
  state.selectedAccountId = account.id;
  saveBaiduAccountsState(state);
  return listBaiduAccounts();
}

async function deleteBaiduAccount(accountId) {
  const id = safeBaiduAccountId(accountId);
  if (id === "default") throw new Error("默认账号不能删除");
  const state = getBaiduAccountsState();
  const index = state.accounts.findIndex((account) => account.id === id);
  if (index < 0) throw new Error("找不到所选百度网盘账号");
  state.accounts.splice(index, 1);
  state.selectedAccountId = state.accounts[0]?.id || "default";
  saveBaiduAccountsState(state);
  await fs.rm(baiduAccountCookiePath(id), { force: true });
  return listBaiduAccounts();
}

async function selectBaiduAccount(accountId) {
  const state = getBaiduAccountsState();
  const id = safeBaiduAccountId(accountId);
  if (!state.accounts.some((account) => account.id === id)) throw new Error("找不到所选百度网盘账号");
  state.selectedAccountId = id;
  saveBaiduAccountsState(state);
  return listBaiduAccounts();
}

async function migrateLegacyBaiduCookie() {
  try {
    const legacyCookie = safeStorage.decryptString(await fs.readFile(baiduCookiePath));
    if (legacyCookie && !(await getBaiduCookie("default"))) await saveBaiduAccountCookie("default", legacyCookie);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function openBaiduLoginWindow(accountId) {
  const account = getBaiduAccount(accountId);
  const loginSession = session.fromPartition(`persist:baidu-netdisk-login-${account.id}`);
  const loginWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    parent: mainWindow,
    modal: false,
    title: "登录百度网盘",
    autoHideMenuBar: true,
    webPreferences: {
      session: loginSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  loginWindow.webContents.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36");
  loginWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/([\w-]+\.)*baidu\.com\//i.test(url)) return { action: "allow" };
    shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  loginWindow.webContents.on("will-navigate", (event, url) => {
    if (!/^https:\/\/([\w-]+\.)*baidu\.com\//i.test(url)) event.preventDefault();
  });
  await loginWindow.loadURL("https://pan.baidu.com/disk/main");

  return new Promise((resolve) => {
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      resolve(result);
    };
    const checkLogin = async () => {
      try {
        const cookies = await loginSession.cookies.get({ url: "https://pan.baidu.com" });
        const cookie = cookies.map((item) => `${item.name}=${item.value}`).join("; ");
        if (!/BAIDUID=/i.test(cookie)) return;
        const result = await getBdstoken(cookie);
        await saveBaiduAccountCookie(account.id, cookie);
        updateBaiduAccount(account.id, { uk: String(result.uk || "") });
        finish({ ok: true, accountId: account.id, uk: String(result.uk || "") });
        if (!loginWindow.isDestroyed()) loginWindow.close();
      } catch {
        // 登录完成前接口通常会返回未登录，继续等待用户操作。
      }
    };
    const timer = setInterval(checkLogin, 1500);
    loginWindow.on("closed", () => finish({ ok: false, cancelled: true }));
    checkLogin();
  });
}

function emitNetdiskProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("netdisk:progress", payload);
}

async function waitWhilePaused(run) {
  while (run.paused && !run.cancelled) await new Promise((resolve) => setTimeout(resolve, 200));
  if (run.cancelled) throw new Error("任务已停止");
}

async function runNetdiskBatch(type, items, concurrency, handler) {
  if (netdiskRuns.has(type)) throw new Error(type === "transfer" ? "已有转存任务正在运行" : "已有分享任务正在运行");
  const run = { paused: false, cancelled: false };
  netdiskRuns.set(type, run);
  const results = Array(items.length);
  let cursor = 0;
  let completed = 0;
  const worker = async () => {
    while (true) {
      await waitWhilePaused(run);
      const index = cursor++;
      if (index >= items.length) return;
      const requestedIndex = Number(items[index]?.resultIndex);
      const resultIndex = Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < 5000
        ? requestedIndex
        : index;
      emitNetdiskProgress({ type, phase: "running", index: resultIndex, completed, total: items.length, item: items[index] });
      try {
        results[index] = { ...(await handler(items[index], index)), index: resultIndex, status: "completed" };
      } catch (error) {
        results[index] = { index: resultIndex, status: "failed", error: error.message || String(error) };
      }
      completed += 1;
      emitNetdiskProgress({ type, phase: "item", completed, total: items.length, result: results[index] });
      if (type === "transfer" && index < items.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };
  try {
    const count = type === "transfer"
      ? 1
      : Math.max(1, Math.min(10, Number(concurrency) || 1));
    await Promise.all(Array.from({ length: Math.min(count, items.length) }, () => worker()));
    const summary = {
      type,
      phase: "finished",
      completed,
      total: items.length,
      succeeded: results.filter((item) => item?.status === "completed").length,
      failed: results.filter((item) => item?.status === "failed").length,
      results,
    };
    emitNetdiskProgress(summary);
    return summary;
  } finally {
    netdiskRuns.delete(type);
  }
}

function publicSettings() {
  const defaults = {
    mode: "ai",
    baseUrl: FIXED_API_BASE,
    model: DEFAULT_MODEL,
    answerModel: DEFAULT_ANSWER_MODEL,
    answerPrompt: DEFAULT_ANSWER_PROMPT,
    concurrency: 15,
    maxAttempts: 3,
    titleMode: "ai",
    titlePrompt: DEFAULT_TITLE_PROMPT,
    introPrompt: DEFAULT_INTRO_PROMPT,
    customRules: [],
    cloudRulesUrl: DEFAULT_CLOUD_RULES_URL,
    cloudRulesAutoUpdate: true,
    disabledCloudRuleIds: [],
    netdiskTransferDestination: "网盘批量转存",
    netdiskSeparateFolders: false,
    netdiskTransferConcurrency: 1,
    netdiskAutoShare: false,
    netdiskSharePeriod: 0,
    netdiskRandomPassword: false,
    netdiskFixedPassword: "6666",
    netdiskShareConcurrency: 5,
    netdiskMaxDepth: 10,
    netdiskMaxItems: 20000,
    startPage: "qa",
  };
  const saved = database.getSetting("generation", {});
  const cloudCache = cloudRulesCache();
  return {
    ...defaults,
    ...saved,
    mode: "ai",
    baseUrl: effectiveApiBase(saved.baseUrl),
      configurableApiBase: CONFIGURABLE_API_BASE,
      licensePurchaseText: LICENSE_PURCHASE_TEXT,
      licensePurchaseUrl: LICENSE_PURCHASE_URL,
    model: normalizeModel(saved.model),
    answerModel: normalizeAnswerModel(saved.answerModel),
    answerPrompt: normalizeAnswerPrompt(saved.answerPrompt),
    customRules: normalizeCustomRules(saved.customRules),
    cloudRulesUrl: (() => {
      try { return normalizeCloudRulesUrl(saved.cloudRulesUrl || DEFAULT_CLOUD_RULES_URL); }
      catch { return DEFAULT_CLOUD_RULES_URL; }
    })(),
    cloudRulesAutoUpdate: saved.cloudRulesAutoUpdate !== false,
    disabledCloudRuleIds: Array.isArray(saved.disabledCloudRuleIds) ? saved.disabledCloudRuleIds.map(String).slice(0, 200) : [],
    cloudRules: cloudCache.rules,
    cloudRulesMeta: { version: cloudCache.version, updatedAt: cloudCache.updatedAt, sourceUrl: cloudCache.sourceUrl },
  };
}

function localFileStamp(date = new Date()) {
  const pad = (value, length = 2) => String(value).padStart(length, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${pad(date.getMilliseconds(), 3)}`;
}

function sanitizeNetdiskWorkspace(input = {}) {
  const text = (value, max = 2000) => String(value || "").slice(0, max);
  const status = (value) => ["pending", "running", "completed", "failed"].includes(value) ? value : "pending";
  const transferRows = Array.isArray(input?.transfer?.rows) ? input.transfer.rows.slice(0, 5000).map((row, index) => ({
    index: Number.isInteger(Number(row?.index)) ? Number(row.index) : index,
    source: text(row?.source, 3000),
    customName: text(row?.customName, 500),
    status: status(row?.status),
    names: Array.isArray(row?.names) ? row.names.slice(0, 50).map((name) => text(name, 500)) : [],
    destination: text(row?.destination, 500),
    shareLink: text(row?.shareLink, 3000),
    password: text(row?.password, 20),
    shareStatus: ["pending", "running", "completed", "failed"].includes(row?.shareStatus) ? row.shareStatus : "",
    shareError: text(row?.shareError, 1000),
    savedFsIds: Array.isArray(row?.savedFsIds) ? row.savedFsIds.slice(0, 100).map((id) => text(id, 40)).filter((id) => /^\d+$/.test(id)) : [],
    savedPaths: Array.isArray(row?.savedPaths) ? row.savedPaths.slice(0, 100).map((item) => text(item, 1500)) : [],
    error: text(row?.error, 1000),
  })) : [];
  const shareRows = Array.isArray(input?.share?.rows) ? input.share.rows.slice(0, 5000).map((row, index) => ({
    index: Number.isInteger(Number(row?.index)) ? Number(row.index) : index,
    fsId: text(row?.fsId, 40),
    name: text(row?.name, 500),
    path: text(row?.path, 1500),
    isDir: Boolean(row?.isDir),
    size: Math.max(0, Number(row?.size) || 0),
    depth: Math.max(0, Number(row?.depth) || 0),
    relativePath: text(row?.relativePath, 1500),
    parentPath: text(row?.parentPath, 1500),
    status: status(row?.status),
    shareLink: text(row?.shareLink, 3000),
    password: text(row?.password, 20),
    error: text(row?.error, 1000),
  })) : [];
  const shareHistory = Array.isArray(input?.share?.history) ? input.share.history.slice(-50000).map((row) => ({
    fsId: text(row?.fsId, 40),
    name: text(row?.name, 500),
    path: text(row?.path, 1500),
    isDir: Boolean(row?.isDir),
    shareLink: text(row?.shareLink, 3000),
    password: text(row?.password, 20),
    sharedAt: text(row?.sharedAt, 80),
  })).filter((row) => /^\d+$/.test(row.fsId) && row.shareLink) : [];
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    activeTab: input?.activeTab === "share" ? "share" : "transfer",
    transfer: {
      raw: text(input?.transfer?.raw, 1000000),
      importFileName: text(input?.transfer?.importFileName, 500),
      importedItems: Array.isArray(input?.transfer?.importedItems) ? input.transfer.importedItems.slice(0, 1000).map((item) => ({
        raw: text(item?.raw, 3000),
        customName: text(item?.customName, 500),
      })).filter((item) => item.raw && item.customName) : [],
      destination: text(input?.transfer?.destination, 500),
      separateFolders: Boolean(input?.transfer?.separateFolders),
      concurrency: Math.max(1, Math.min(5, Number(input?.transfer?.concurrency) || 2)),
      autoShare: Boolean(input?.transfer?.autoShare),
      sharePeriod: [0, 1, 7, 30].includes(Number(input?.transfer?.sharePeriod)) ? Number(input.transfer.sharePeriod) : 7,
      randomSharePassword: input?.transfer?.randomSharePassword !== false,
      sharePassword: text(input?.transfer?.sharePassword, 4),
      showResults: Boolean(input?.transfer?.showResults) && transferRows.length > 0,
      completed: Math.max(0, Number(input?.transfer?.completed) || 0),
      rows: transferRows,
    },
    share: {
      folder: text(input?.share?.folder, 1500),
      scope: ["current", "level-folders", "folders", "files", "both"].includes(input?.share?.scope) ? input.share.scope : "both",
      period: [0, 1, 7, 30].includes(Number(input?.share?.period)) ? Number(input.share.period) : 7,
      randomPassword: input?.share?.randomPassword !== false,
      password: text(input?.share?.password, 4),
      concurrency: Math.max(1, Math.min(10, Number(input?.share?.concurrency) || 5)),
      typeFilter: ["all", "folder", "file"].includes(input?.share?.typeFilter) ? input.share.typeFilter : "all",
      completed: Math.max(0, Number(input?.share?.completed) || 0),
      history: shareHistory,
      rows: shareRows,
    },
  };
}

function applyTaskRunOptions(taskId, input = {}) {
  const task = database.getTask(taskId);
  if (!task) throw new Error("任务不存在");
  const previous = task.options || {};
  const mode = task.mode === "rules" ? "rules" : "ai";
  const options = {
    ...previous,
    mode,
    baseUrl: effectiveApiBase(input?.baseUrl || previous.baseUrl),
    model: normalizeModel(input?.model || previous.model),
    concurrency: Math.max(1, Math.min(100, Number(input?.concurrency || previous.concurrency || 15))),
    maxAttempts: Math.max(1, Math.min(5, Number(input?.maxAttempts || previous.maxAttempts || 3))),
    titleMode: mode === "rules" ? "local" : input?.titleMode === "fixed" ? "fixed" : "ai",
    resourceType: normalizeResourceType(input?.resourceType || previous.resourceType),
    customRules: normalizeCustomRules(input?.customRules ?? previous.customRules),
    titlePrompt: String(input?.titlePrompt ?? previous.titlePrompt ?? DEFAULT_TITLE_PROMPT).trim().slice(0, 1000),
    introPrompt: String(input?.introPrompt ?? previous.introPrompt ?? DEFAULT_INTRO_PROMPT).trim().slice(0, 1000),
  };
  database.updateTaskOptions(taskId, options);
  return options;
}

function emitProgress(task) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("tasks:progress", task);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#F4F7FB",
    title: "百度知道助手",
    show: !captureMode && !smokeMode,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    if (!captureMode && !smokeMode) {
      mainWindow.webContents.once("did-finish-load", () => {
        mainWindow.webContents.openDevTools({ mode: "right" });
      });
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
  if (smokeMode) {
    mainWindow.webContents.once("did-finish-load", async () => {
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        const before = await window.wangpanAPI.getSettings();
        await window.wangpanAPI.saveBaiduWorkspace({
          activeTab: "transfer",
          transfer: { rows: [{ index: 0, source: "https://pan.baidu.com/s/smoke", status: "completed", names: ["测试资源"] }] },
          share: { rows: [] },
        });
        const restoredWorkspace = await window.wangpanAPI.getBaiduWorkspace();
        const directTask = await window.wangpanAPI.createTaskFromNetdisk({
          rows: [{ name: "直达转换测试资源", link: "https://pan.baidu.com/s/smokeDirect?pwd=abcd" }],
          sourceType: "share",
          options: before,
        });
        const automationAccounts = await window.wangpanAPI.listAutomationAccounts();
        const settingsButton = document.querySelector('button[title="全局设置"]');
        settingsButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const modelInput = document.querySelector('.settings-drawer input[placeholder*="模型ID"]');
        if (modelInput) {
          modelInput.value = "provider/smoke-custom-model";
          modelInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
        const saveButton = [...document.querySelectorAll("button")]
          .find((button) => button.textContent.includes("保存全局设置"));
        saveButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
        const saved = await window.wangpanAPI.getSettings();
        const answerSettings = await window.wangpanAPI.saveSettings({ ...saved, answerModel: "provider/smoke-answer-model", answerPrompt: "smoke answer prompt" });
        await window.wangpanAPI.saveSettings({ ...before });
        return {
          title: document.title,
          hasBridge: Boolean(window.wangpanAPI),
          hasRoot: Boolean(document.querySelector("#app")),
          settingsSaved: Boolean(saveButton) && !document.querySelector(".settings-drawer"),
          customModelSaved: saved.model === "provider/smoke-custom-model",
          answerModelSaved: answerSettings.answerModel === "provider/smoke-answer-model",
          answerPromptSaved: answerSettings.answerPrompt === "smoke answer prompt",
          workspaceSaved: restoredWorkspace?.transfer?.rows?.[0]?.names?.[0] === "测试资源",
          directTaskCreated: directTask?.total === 1 && directTask?.sheetName === "网盘批量分享",
          automationReady: automationAccounts?.accounts?.[0]?.id === "default",
        };
      })()`);
      console.log(`Electron smoke passed: ${JSON.stringify(result)}`);
      if (!result.hasBridge || !result.hasRoot || !result.settingsSaved || !result.customModelSaved || !result.answerModelSaved || !result.answerPromptSaved || !result.workspaceSaved || !result.directTaskCreated || !result.automationReady) app.exit(1);
      else app.quit();
    });
  }
  if (captureMode) {
    mainWindow.webContents.once("did-finish-load", async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (captureNetdiskMode || captureShareMode || captureTransferFilledMode) {
        await mainWindow.webContents.executeJavaScript(`
          [...document.querySelectorAll('.nav-item')]
            .find((button) => button.textContent.includes('网盘批处理'))?.click();
        `);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (captureAutomationMode) {
        await mainWindow.webContents.executeJavaScript(`
          [...document.querySelectorAll('.nav-item')]
            .find((button) => button.textContent.includes('自动化答题'))?.click();
        `);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (captureShareMode) {
        await mainWindow.webContents.executeJavaScript(`
          [...document.querySelectorAll('.batch-tabs button')]
            .find((button) => button.textContent.includes('批量分享'))?.click();
        `);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (captureTransferFilledMode) {
        await mainWindow.webContents.executeJavaScript(`
          const textarea = document.querySelector('.transfer-config-grid textarea');
          if (textarea) {
            textarea.value = 'https://pan.baidu.com/s/example1?pwd=abcd\\nhttps://pan.baidu.com/s/example2?pwd=efgh';
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          }
          [...document.querySelectorAll('.auto-share-toggle')]
            .find((label) => label.textContent.includes('自动分享'))?.querySelector('input')?.click();
        `);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (captureSettingsMode) {
        await mainWindow.webContents.executeJavaScript(`
          [...document.querySelectorAll('.nav-item')]
            .find((button) => button.textContent.includes('全局设置'))?.click();
        `);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await mainWindow.webContents.executeJavaScript(`
          [...document.querySelectorAll('.global-setting-tabs button')]
            .find((button) => button.textContent.includes('网盘批处理'))?.click();
        `);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const image = await mainWindow.webContents.capturePage();
      const outputName = captureShareMode
        ? "ui-netdisk-share-preview.png"
        : captureTransferFilledMode ? "ui-netdisk-filled-preview.png" : captureSettingsMode ? "ui-global-settings-preview.png" : captureAutomationMode ? "ui-automation-preview.png" : captureNetdiskMode ? "ui-netdisk-preview.png" : "ui-preview.png";
      const outputPath = path.join(process.cwd(), outputName);
      await fs.writeFile(outputPath, image.toPNG());
      console.log(`UI capture saved: ${outputPath}`);
      app.quit();
    });
  }
}

function registerIpc() {
  ipcMain.handle("update:state", (event) => {
    assertTrusted(event);
    return updateService.getState();
  });
  ipcMain.handle("update:check", (event, manifestUrl) => {
    assertTrusted(event);
    return updateService.check(manifestUrl);
  });
  ipcMain.handle("update:download", (event) => {
    assertTrusted(event);
    return updateService.download();
  });
  ipcMain.handle("update:install", (event) => {
    assertTrusted(event);
    return updateService.install();
  });
  ipcMain.handle("automation:accounts", (event) => {
    assertTrusted(event);
    return automationService.listAccounts();
  });
  ipcMain.handle("automation:account-create", (event, name) => {
    assertTrusted(event);
    return automationService.createAccount(name);
  });
  ipcMain.handle("automation:account-delete", (event, payload) => {
    assertTrusted(event);
    return automationService.deleteAccount(payload?.accountId, Boolean(payload?.deleteData));
  });
  ipcMain.handle("automation:start", async (event, payload) => {
    assertTrusted(event);
    return automationService.start(payload);
  });
  ipcMain.handle("automation:stop", async (event, accountId) => {
    assertTrusted(event);
    return automationService.stop(accountId);
  });
  ipcMain.handle("automation:stop-all", async (event) => {
    assertTrusted(event);
    return automationService.stopAll();
  });
  ipcMain.handle("automation:open-page", async (event, payload) => {
    assertTrusted(event);
    return automationService.openPage(payload?.accountId, payload?.type);
  });
  ipcMain.handle("automation:progress-clear", (event, accountId) => {
    assertTrusted(event);
    return automationService.clearProgress(accountId);
  });
  ipcMain.handle("automation:data-open", async (event, accountId) => {
    assertTrusted(event);
    return automationService.openDataFolder(accountId);
  });
  ipcMain.handle("settings:open-api-key-guide", async (event) => {
    assertTrusted(event);
    await shell.openExternal(API_KEY_GUIDE_URL);
    return { ok: true };
  });
  ipcMain.handle("settings:open-model-library", async (event) => {
    assertTrusted(event);
    await shell.openExternal(MODEL_LIBRARY_URL);
    return { ok: true };
  });
  ipcMain.handle("rules:sync", async (event, input) => {
    assertTrusted(event);
    return syncCloudRules(input?.url);
  });
  ipcMain.handle("app:open-user-guide", async (event) => {
    assertTrusted(event);
    await shell.openExternal(USER_GUIDE_URL);
    return { ok: true };
  });
  ipcMain.handle("app:copy-text", (event, value) => {
    assertTrusted(event);
    clipboard.writeText(String(value || ""));
    return { ok: true };
  });

  ipcMain.handle("netdisk:open-home", async (event) => {
    assertTrusted(event);
    await shell.openExternal("https://pan.baidu.com/disk/main");
    return { ok: true };
  });
  ipcMain.handle("netdisk:login", async (event, input) => {
    assertTrusted(event);
    return openBaiduLoginWindow(input?.accountId);
  });
  ipcMain.handle("netdisk:accounts", async (event) => {
    assertTrusted(event);
    return listBaiduAccounts();
  });
  ipcMain.handle("netdisk:account-create", async (event, name) => {
    assertTrusted(event);
    return createBaiduAccount(name);
  });
  ipcMain.handle("netdisk:account-delete", async (event, accountId) => {
    assertTrusted(event);
    return deleteBaiduAccount(accountId);
  });
  ipcMain.handle("netdisk:account-select", async (event, accountId) => {
    assertTrusted(event);
    return selectBaiduAccount(accountId);
  });
  ipcMain.handle("netdisk:account-get", async (event) => {
    assertTrusted(event);
    const state = await listBaiduAccounts();
    const account = state.accounts.find((item) => item.id === state.selectedAccountId) || state.accounts[0];
    return { ...account, selectedAccountId: state.selectedAccountId, accounts: state.accounts };
  });
  ipcMain.handle("netdisk:account-save", async (event, input) => {
    assertTrusted(event);
    const cookie = String(input?.cookie || "").trim();
    if (cookie && (/[^\x20-\x7E]/.test(cookie) || /[\r\n]/.test(cookie))) throw new Error("Cookie 中包含无法识别的字符");
    if (cookie && !/BAIDUID=/i.test(cookie)) throw new Error("Cookie 不完整，未找到 BAIDUID");
    const account = getBaiduAccount(input?.accountId);
    await saveBaiduAccountCookie(account.id, cookie);
    if (!cookie) updateBaiduAccount(account.id, { uk: "" });
    return { accountId: account.id, hasCookie: Boolean(cookie) };
  });
  ipcMain.handle("netdisk:account-test", async (event, input) => {
    assertTrusted(event);
    const account = getBaiduAccount(input?.accountId);
    const cookie = String(input?.cookie || "").trim() || await getBaiduCookie(account.id);
    if (!cookie) throw new Error("请先填写百度网盘 Cookie");
    const result = await getBdstoken(cookie);
    updateBaiduAccount(account.id, { uk: String(result.uk || "") });
    return { ok: true, accountId: account.id, uk: String(result.uk || "") };
  });
  ipcMain.handle("netdisk:list-directory", async (event, input) => {
    assertTrusted(event);
    const purpose = String(input?.purpose || "default").slice(0, 40);
    const readKey = `${event.sender.id}:${purpose}`;
    netdiskDirectoryReads.get(readKey)?.abort();
    const controller = new AbortController();
    netdiskDirectoryReads.set(readKey, controller);
    const requestId = String(input?.requestId || "");
    try {
      const account = getBaiduAccount(input?.accountId);
      const cookie = await getBaiduCookie(account.id);
      if (!cookie) throw new Error("请先保存并验证百度网盘 Cookie");
      const { bdstoken } = await getBdstoken(cookie);
      return await listDirectoryRecursive(cookie, bdstoken, input?.folder || "", {
        recursive: Boolean(input?.recursive),
        maxDepth: input?.maxDepth,
        maxItems: input?.maxItems,
        concurrency: input?.concurrency,
        signal: controller.signal,
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send("netdisk:directory-progress", { ...progress, requestId, purpose });
        },
      });
    } finally {
      if (netdiskDirectoryReads.get(readKey) === controller) netdiskDirectoryReads.delete(readKey);
    }
  });
  ipcMain.handle("netdisk:list-directory-cancel", (event, input) => {
    assertTrusted(event);
    const purpose = String(input?.purpose || "default").slice(0, 40);
    const readKey = `${event.sender.id}:${purpose}`;
    netdiskDirectoryReads.get(readKey)?.abort();
    netdiskDirectoryReads.delete(readKey);
    return { ok: true };
  });
  ipcMain.handle("netdisk:workspace-get", (event, input) => {
    assertTrusted(event);
    const account = getBaiduAccount(input?.accountId);
    return database.getSetting(`netdiskWorkspace:${account.id}`, null) || (account.id === "default" ? database.getSetting("netdiskWorkspace", null) : null);
  });
  ipcMain.handle("netdisk:workspace-save", (event, input) => {
    assertTrusted(event);
    const workspace = sanitizeNetdiskWorkspace(input);
    const account = getBaiduAccount(input?.accountId);
    database.setSetting(`netdiskWorkspace:${account.id}`, workspace);
    return { ok: true, savedAt: workspace.savedAt };
  });
  ipcMain.handle("netdisk:transfer-run", async (event, input) => {
    assertTrusted(event);
    const items = Array.isArray(input?.items) ? input.items.slice(0, 1000) : [];
    if (!items.length) throw new Error("请先粘贴至少一条百度网盘链接");
    const account = getBaiduAccount(input?.accountId);
    const cookie = await getBaiduCookie(account.id);
    if (!cookie) throw new Error("请先保存并验证百度网盘 Cookie");
    const { bdstoken } = await getBdstoken(cookie);
    const baseFolder = String(input?.destination || "").trim();
    await ensureDirectory(cookie, bdstoken, baseFolder);
    return runNetdiskBatch("transfer", items, input?.concurrency, async (item, index) => {
      let destination = baseFolder;
      if (input?.separateFolders) {
        const originalIndex = Number.isInteger(Number(item?.resultIndex)) ? Number(item.resultIndex) : index;
        destination = [baseFolder, String(originalIndex + 1).padStart(4, "0")].filter(Boolean).join("/");
        await ensureDirectory(cookie, bdstoken, destination);
      }
      const result = await transferOne(cookie, bdstoken, item.raw || item.link || item, destination);
      const rowResult = {
        source: item.raw || item.link || String(item),
        customName: String(item?.customName || "").trim().slice(0, 500),
        ...result,
      };
      if (input?.autoShare) {
        try {
          const expectedPaths = new Set(result.savedPaths || []);
          const expectedNames = new Set(result.names || []);
          let fsIds = [...(result.savedFsIds || [])];
          let lookupError;
          for (let attempt = 0; attempt < 8 && !fsIds.length; attempt += 1) {
            if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
            try {
              const destinationItems = await listDirectory(cookie, bdstoken, destination);
              fsIds = destinationItems
                .filter((saved) => expectedPaths.has(saved.path) || expectedNames.has(saved.name))
                .map((saved) => saved.fsId);
            } catch (error) {
              lookupError = error;
            }
          }
          if (!fsIds.length && lookupError) throw lookupError;
          if (!fsIds.length) throw new Error("转存成功，但目标目录暂未读取到新文件，请稍后重试分享");
          Object.assign(rowResult, await createShareForFsIds(cookie, bdstoken, fsIds, {
            period: input?.sharePeriod,
            randomPassword: input?.randomSharePassword,
            password: input?.sharePassword,
          }), { shareStatus: "completed" });
        } catch (error) {
          rowResult.shareStatus = "failed";
          rowResult.shareError = error.message || String(error);
        }
      }
      return rowResult;
    });
  });
  ipcMain.handle("netdisk:transfer-share-retry", async (event, input) => {
    assertTrusted(event);
    const items = Array.isArray(input?.items) ? input.items.slice(0, 1000) : [];
    if (!items.length) throw new Error("没有需要重试分享的转存记录");
    const account = getBaiduAccount(input?.accountId);
    const cookie = await getBaiduCookie(account.id);
    if (!cookie) throw new Error("请先保存并验证百度网盘 Cookie");
    const { bdstoken } = await getBdstoken(cookie);
    return runNetdiskBatch("transfer", items, 1, async (item) => {
      const destination = String(item?.destination || "").trim();
      const expectedPaths = new Set(Array.isArray(item?.savedPaths) ? item.savedPaths.map(String) : []);
      const expectedNames = new Set(Array.isArray(item?.names) ? item.names.map(String) : []);
      let fsIds = Array.isArray(item?.savedFsIds)
        ? item.savedFsIds.map(String).filter((id) => /^\d+$/.test(id))
        : [];
      let lookupError;
      for (let attempt = 0; attempt < 4 && !fsIds.length; attempt += 1) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const destinationItems = await listDirectory(cookie, bdstoken, destination);
          fsIds = destinationItems
            .filter((saved) => expectedPaths.has(saved.path) || expectedNames.has(saved.name))
            .map((saved) => String(saved.fsId));
        } catch (error) {
          lookupError = error;
        }
      }
      if (!fsIds.length && lookupError) throw lookupError;
      if (!fsIds.length) throw new Error("目标目录中未找到本次已转存的文件");
      return {
        source: String(item?.source || ""),
        customName: String(item?.customName || "").trim().slice(0, 500),
        ...(await createShareForFsIds(cookie, bdstoken, fsIds, {
          period: input?.sharePeriod,
          randomPassword: input?.randomSharePassword,
          password: input?.sharePassword,
        })),
        shareStatus: "completed",
        shareError: "",
      };
    });
  });
  ipcMain.handle("netdisk:share-run", async (event, input) => {
    assertTrusted(event);
    const items = Array.isArray(input?.items) ? input.items.slice(0, 5000) : [];
    if (!items.length) throw new Error("请至少选择一个文件或文件夹");
    const account = getBaiduAccount(input?.accountId);
    const cookie = await getBaiduCookie(account.id);
    if (!cookie) throw new Error("请先保存并验证百度网盘 Cookie");
    const { bdstoken } = await getBdstoken(cookie);
    return runNetdiskBatch("share", items, input?.concurrency, async (item) => shareOne(cookie, bdstoken, item, input));
  });
  ipcMain.handle("netdisk:control", (event, input) => {
    assertTrusted(event);
    const type = input?.type === "share" ? "share" : "transfer";
    const run = netdiskRuns.get(type);
    if (!run) return { running: false, paused: false };
    if (input?.action === "pause") run.paused = true;
    if (input?.action === "resume") run.paused = false;
    if (input?.action === "stop") { run.cancelled = true; run.paused = false; }
    return { running: true, paused: run.paused };
  });
  ipcMain.handle("netdisk:export-transfer-results", async (event, input) => {
    assertTrusted(event);
    const rows = Array.isArray(input?.rows) ? input.rows.slice(0, 5000).map((item) => ({
      name: String(item?.name || "").slice(0, 500),
      link: String(item?.link || "").slice(0, 2000),
    })) : [];
    const stamp = localFileStamp();
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出转存分享结果",
      defaultPath: path.join(app.getPath("downloads"), `网盘批量转存结果_${stamp}.xlsx`),
      filters: [{ name: "Excel工作簿", extensions: ["xlsx"] }],
    });
    if (result.canceled || !result.filePath) return null;
    return exportTransferShareWorkbook(rows, result.filePath);
  });
  ipcMain.handle("netdisk:export-share-results", async (event, input) => {
    assertTrusted(event);
    const rows = Array.isArray(input?.rows) ? input.rows.slice(0, 5000).map((item) => ({
      name: String(item?.name || "").slice(0, 500),
      link: String(item?.link || "").slice(0, 2000),
    })).filter((item) => item.name && item.link) : [];
    if (!rows.length) throw new Error("暂无可导出的分享结果");
    const stamp = localFileStamp();
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出批量分享结果",
      defaultPath: path.join(app.getPath("downloads"), `网盘批量分享结果_${stamp}.xlsx`),
      filters: [{ name: "Excel工作簿", extensions: ["xlsx"] }],
    });
    if (result.canceled || !result.filePath) return null;
    return exportTransferShareWorkbook(rows, result.filePath);
  });
  ipcMain.handle("netdisk:export-share-history", async (event, input) => {
    assertTrusted(event);
    const rows = Array.isArray(input?.rows) ? input.rows.slice(0, 50000).map((item) => ({
      fsId: String(item?.fsId || "").slice(0, 40),
      name: String(item?.name || "").slice(0, 500),
      path: String(item?.path || "").slice(0, 1500),
      isDir: Boolean(item?.isDir),
      shareLink: String(item?.shareLink || "").slice(0, 3000),
      password: String(item?.password || "").slice(0, 20),
      sharedAt: String(item?.sharedAt || "").slice(0, 80),
    })).filter((item) => /^\d+$/.test(item.fsId) && item.shareLink) : [];
    if (!rows.length) throw new Error("暂无可导出的分享历史");
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出分享历史备份",
      defaultPath: path.join(app.getPath("downloads"), `网盘分享历史备份_${localFileStamp()}.xlsx`),
      filters: [{ name: "Excel工作簿", extensions: ["xlsx"] }],
    });
    if (result.canceled || !result.filePath) return null;
    return exportShareHistoryWorkbook(rows, result.filePath);
  });
  ipcMain.handle("netdisk:import-share-history", async (event) => {
    assertTrusted(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "导入分享历史备份",
      properties: ["openFile"],
      filters: [{ name: "Excel工作簿", extensions: ["xlsx"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return readShareHistoryWorkbook(validateFilePath(result.filePaths[0]));
  });

  ipcMain.handle("dialog:choose-excel", async (event) => {
    assertTrusted(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择网盘资源Excel",
      properties: ["openFile"],
      filters: [{ name: "Excel工作簿", extensions: ["xlsx"] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("excel:analyze", async (event, filePath) => {
    assertTrusted(event);
    return readSourceWorkbook(validateFilePath(filePath));
  });

  ipcMain.handle("tasks:create", async (event, payload) => {
    assertTrusted(event);
    const sourcePath = validateFilePath(payload?.sourcePath);
    const source = await readSourceWorkbook(sourcePath);
    if (!source.isValid) {
      const firstIssues = source.issues
        .slice(0, 3)
        .map((issue) => `第${issue.row}行：${issue.message}`)
        .join("；");
      throw new Error(`Excel格式校验未通过，共${source.issues.length}处问题。${firstIssues}`);
    }
    const requestedOptions = payload?.options || {};
    const mode = requestedOptions.mode === "rules" ? "rules" : "ai";
    const options = {
      ...publicSettings(),
      ...requestedOptions,
      mode,
      baseUrl: effectiveApiBase(requestedOptions.baseUrl),
      model: normalizeModel(requestedOptions.model),
      titleMode: mode === "rules" ? "local" : requestedOptions.titleMode === "fixed" ? "fixed" : "ai",
      resourceType: normalizeResourceType(requestedOptions.resourceType),
      customRules: normalizeCustomRules(requestedOptions.customRules),
    };
    const now = new Date().toISOString();
    return database.createTask({
      id: crypto.randomUUID(),
      fileName: source.fileName,
      sourcePath,
      sheetName: source.sheetName,
      mode,
      options,
      createdAt: now,
    }, source.rows);
  });
  ipcMain.handle("tasks:create-from-netdisk", async (event, payload) => {
    assertTrusted(event);
    const incoming = Array.isArray(payload?.rows) ? payload.rows.slice(0, 5000) : [];
    if (!incoming.length) throw new Error("没有可发送到格式转换的分享结果");
    const rows = incoming.map((item, index) => {
      const name = String(item?.name || "").replace(/\s+/g, " ").trim().slice(0, 500);
      const link = String(item?.link || "").replace(/\s+/g, " ").trim().slice(0, 3000);
      if (!name) throw new Error(`第${index + 1}条结果缺少资源名称`);
      const checked = validateNetdiskLink(link);
      if (!checked.valid) throw new Error(`第${index + 1}条分享链接无效：${checked.reason}`);
      return { sourceRow: index + 1, name, link };
    });
    const requestedOptions = payload?.options || {};
    const mode = requestedOptions.mode === "rules" ? "rules" : "ai";
    const options = {
      ...publicSettings(),
      ...requestedOptions,
      mode,
      baseUrl: effectiveApiBase(requestedOptions.baseUrl),
      model: normalizeModel(requestedOptions.model),
      titleMode: mode === "rules" ? "local" : requestedOptions.titleMode === "fixed" ? "fixed" : "ai",
      resourceType: normalizeResourceType(requestedOptions.resourceType),
      customRules: normalizeCustomRules(requestedOptions.customRules),
      titlePrompt: String(requestedOptions.titlePrompt || "").slice(0, 1000),
      introPrompt: String(requestedOptions.introPrompt ?? DEFAULT_INTRO_PROMPT).slice(0, 1000),
    };
    const sourceLabel = payload?.sourceType === "transfer" ? "网盘批量转存" : "网盘批量分享";
    const now = new Date().toISOString();
    return database.createTask({
      id: crypto.randomUUID(),
      fileName: `${sourceLabel}_${localFileStamp()}`,
      sourcePath: "",
      sheetName: sourceLabel,
      mode,
      options,
      createdAt: now,
    }, rows);
  });

  ipcMain.handle("tasks:list", (event) => {
    assertTrusted(event);
    return database.listTasks();
  });
  ipcMain.handle("tasks:get", (event, taskId) => {
    assertTrusted(event);
    return database.getTask(String(taskId));
  });
  ipcMain.handle("tasks:rows", (event, payload) => {
    assertTrusted(event);
    return database.getTaskRows(String(payload?.taskId || ""), {
      page: payload?.page,
      pageSize: payload?.pageSize,
      status: payload?.status,
      query: payload?.query,
    });
  });
  ipcMain.handle("tasks:audit", (event, taskId) => {
    assertTrusted(event);
    return database.getTaskAudit(String(taskId));
  });
  ipcMain.handle("tasks:update-row", (event, payload) => {
    assertTrusted(event);
    const taskId = String(payload?.taskId || "");
    const updated = database.updateRowContent(taskId, payload?.rowId, {
      title: payload?.title,
      answer: payload?.answer,
    });
    emitProgress(database.getTask(taskId));
    return updated;
  });
  ipcMain.handle("tasks:delete-rows", (event, payload) => {
    assertTrusted(event);
    const taskId = String(payload?.taskId || "");
    const result = database.deleteRows(taskId, payload?.rowIds);
    emitProgress(result.task);
    return result;
  });
  ipcMain.handle("tasks:delete", (event, taskId) => {
    assertTrusted(event);
    return database.deleteTask(String(taskId || ""));
  });
  ipcMain.handle("tasks:regenerate-row", async (event, payload) => {
    assertTrusted(event);
    const taskId = String(payload?.taskId || "");
    const options = applyTaskRunOptions(taskId, payload?.options);
    const updated = await runner.regenerateRow(taskId, payload?.rowId, options);
    emitProgress(database.getTask(taskId));
    return updated;
  });
  ipcMain.handle("tasks:regenerate-rows", async (event, payload) => {
    assertTrusted(event);
    const taskId = String(payload?.taskId || "");
    const options = applyTaskRunOptions(taskId, payload?.options);
    const result = await runner.regenerateRows(taskId, payload?.rowIds, options);
    emitProgress(result.task);
    return result;
  });
  ipcMain.handle("tasks:start", (event, payload) => {
    assertTrusted(event);
    const id = String(payload?.taskId || payload || "");
    const options = applyTaskRunOptions(id, payload?.options);
    runner.start(id, options).catch((error) => {
      database.setTaskStatus(id, "paused");
      emitProgress({ ...database.getTask(id), runnerError: error.message });
    });
    return database.getTask(id);
  });
  ipcMain.handle("tasks:pause", (event, taskId) => {
    assertTrusted(event);
    return runner.pause(String(taskId));
  });
  ipcMain.handle("tasks:retry", (event, payload) => {
    assertTrusted(event);
    const id = String(payload?.taskId || payload || "");
    const options = applyTaskRunOptions(id, payload?.options);
    database.resetFailed(id);
    runner.start(id, options).catch((error) => {
      emitProgress({ ...database.getTask(id), runnerError: error.message });
    });
    return database.getTask(id);
  });
  ipcMain.handle("tasks:export", async (event, taskId) => {
    assertTrusted(event);
    const task = database.getTask(String(taskId));
    if (!task) throw new Error("任务不存在");
    const audit = database.getTaskAudit(task.id);
    if (!audit.canExport) throw new Error("导出检查未通过，请先修正未完成或格式异常的数据");
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出问答Excel",
      defaultPath: path.join(path.dirname(task.sourcePath), `${path.parse(task.fileName).name}_问答格式.xlsx`),
      filters: [{ name: "Excel工作簿", extensions: ["xlsx"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const rows = database.getCompletedRows(task.id);
    const exported = await exportResultWorkbook(rows, result.filePath);
    database.setTaskOutput(task.id, result.filePath);
    emitProgress(database.getTask(task.id));
    return exported;
  });

  ipcMain.handle("settings:get", async (event) => {
    assertTrusted(event);
    return {
      ...publicSettings(),
      hasApiKey: Boolean(await getApiKey()),
      license: licenseService.state(),
    };
  });
  ipcMain.handle("settings:save", async (event, input) => {
    assertTrusted(event);
    const settings = {
      mode: "ai",
      baseUrl: configuredApiBase(input?.baseUrl),
      model: normalizeModel(String(input?.model || DEFAULT_MODEL).trim()),
      answerModel: normalizeAnswerModel(input?.answerModel),
      answerPrompt: normalizeAnswerPrompt(input?.answerPrompt),
      concurrency: Math.max(1, Math.min(100, Number(input?.concurrency || 15))),
      maxAttempts: Math.max(1, Math.min(5, Number(input?.maxAttempts || 3))),
      titleMode: input?.titleMode === "fixed" ? "fixed" : "ai",
      titlePrompt: String(input?.titlePrompt ?? DEFAULT_TITLE_PROMPT).trim().slice(0, 1000),
      introPrompt: String(input?.introPrompt ?? DEFAULT_INTRO_PROMPT).trim().slice(0, 1000),
      customRules: normalizeCustomRules(input?.customRules),
      cloudRulesUrl: normalizeCloudRulesUrl(input?.cloudRulesUrl || DEFAULT_CLOUD_RULES_URL),
      cloudRulesAutoUpdate: input?.cloudRulesAutoUpdate !== false,
      disabledCloudRuleIds: Array.isArray(input?.disabledCloudRuleIds) ? input.disabledCloudRuleIds.map(String).slice(0, 200) : [],
      netdiskTransferDestination: String(input?.netdiskTransferDestination || "网盘批量转存").trim().slice(0, 300) || "网盘批量转存",
      netdiskSeparateFolders: Boolean(input?.netdiskSeparateFolders),
      netdiskTransferConcurrency: 1,
      netdiskAutoShare: Boolean(input?.netdiskAutoShare),
      netdiskSharePeriod: [0, 1, 7, 30].includes(Number(input?.netdiskSharePeriod)) ? Number(input.netdiskSharePeriod) : 0,
      netdiskRandomPassword: input?.netdiskRandomPassword === true,
      netdiskFixedPassword: /^[a-zA-Z0-9]{4}$/.test(String(input?.netdiskFixedPassword || "")) ? String(input.netdiskFixedPassword) : "6666",
      netdiskShareConcurrency: Math.max(1, Math.min(10, Number(input?.netdiskShareConcurrency || 5))),
      netdiskMaxDepth: Math.max(1, Math.min(20, Number(input?.netdiskMaxDepth || 10))),
      netdiskMaxItems: Math.max(100, Math.min(50000, Number(input?.netdiskMaxItems || 20000))),
      startPage: input?.startPage === "netdisk" ? "netdisk" : "qa",
    };
    if (Object.hasOwn(input || {}, "apiKey") && input.apiKey !== "••••••••") {
      await saveApiKey(normalizeApiKeyValue(input.apiKey));
    }
    database.setSetting("generation", settings);
    return {
      ...settings,
      hasApiKey: Boolean(await getApiKey()),
      license: licenseService.state(),
    };
  });
  ipcMain.handle("license:state", async (event) => { assertTrusted(event); return licenseService.state(); });
  ipcMain.handle("license:activate", async (event, key) => { assertTrusted(event); return licenseService.activate(key); });
  ipcMain.handle("license:refresh", async (event) => { assertTrusted(event); return licenseService.refresh(true); });
  ipcMain.handle("license:purchase", async (event) => {
    assertTrusted(event);
    if (!LICENSE_PURCHASE_URL) throw new Error(LICENSE_PURCHASE_TEXT);
    if (!/^https:\/\//i.test(LICENSE_PURCHASE_URL)) throw new Error("购买链接配置无效");
    await shell.openExternal(LICENSE_PURCHASE_URL);
    return { ok: true };
  });
  ipcMain.handle("settings:test-api", async (event, input) => {
    assertTrusted(event);
    const rawApiKey = input?.apiKey && input.apiKey !== "••••••••"
      ? input.apiKey
      : await getApiKey();
    const apiKey = normalizeApiKeyValue(rawApiKey, { allowEmpty: false });
    const baseUrl = configuredApiBase(input?.baseUrl || publicSettings().baseUrl);
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`连接失败：HTTP ${response.status}`);
    return { ok: true };
  });
}

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  await fs.mkdir(userData, { recursive: true });
  secretPath = path.join(userData, "api-key.bin");
  baiduCookiePath = path.join(userData, "baidu-cookie.bin");
  baiduCookiesDir = path.join(userData, "baidu-netdisk-accounts");
  database = new TaskDatabase(path.join(userData, "tasks.sqlite"), {
    legacyJsonPath: path.join(userData, "tasks.json"),
  });
  licenseService = new LicenseService({
    enabled: CONFIGURABLE_API_BASE,
    serverUrl: process.env.LICENSE_SERVER_URL || packageMetadata.licenseServerUrl,
    publicKey: publicKeyFromConfig(packageMetadata),
    credentialPath: path.join(userData, "license.json"),
  });
  await fs.mkdir(baiduCookiesDir, { recursive: true });
  await migrateLegacyBaiduCookie();
  const resumableTaskIds = database.recoverInterruptedTasks();
  runner = new TaskRunner(database, getValidatedApiKey, emitProgress);
  automationService = new AutomationAnswerService({
    app,
    shell,
    database,
    getApiKey: getValidatedApiKey,
    getSettings: publicSettings,
    notify: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    },
  });
  updateService = new UpdateService({
    app,
    getManifestUrl: () => UPDATE_MANIFEST_URL,
    notify: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    },
  });
  registerIpc();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  createWindow();
  if (CONFIGURABLE_API_BASE) licenseService.refresh().then((state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send("license:state", state);
  }).catch(() => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send("license:state", licenseService.state());
  });
  if (!smokeMode && !captureMode && app.isPackaged) {
    mainWindow.webContents.once("did-finish-load", () => setTimeout(() => updateService.check().catch(() => {}), 3000));
  }
  const cloudSettings = publicSettings();
  if (!smokeMode && !captureMode && cloudSettings.cloudRulesAutoUpdate && cloudSettings.cloudRulesUrl) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        syncCloudRules(cloudSettings.cloudRulesUrl).then((cache) => {
          if (!mainWindow.isDestroyed()) mainWindow.webContents.send("rules:updated", cache);
        }).catch(() => {});
      }, 1200);
    });
  }
  if (!smokeMode && !captureMode && resumableTaskIds.length) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        for (const taskId of resumableTaskIds) {
          const task = database.getTask(taskId);
          runner.start(taskId, {
            baseUrl: effectiveApiBase(task?.options?.baseUrl),
            model: normalizeModel(task?.options?.model),
          }).catch((error) => {
            database.setTaskStatus(taskId, "paused", { resumeOnLaunch: false });
            emitProgress({ ...database.getTask(taskId), runnerError: `自动恢复失败：${error.message}` });
          });
        }
      }, 500);
    });
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (automationService?.hasActiveProcesses() && !automationShutdownStarted) {
    event.preventDefault();
    automationShutdownStarted = true;
    runner?.stopAll();
    automationService.shutdown().finally(() => app.quit());
    return;
  }
  runner?.stopAll();
  database?.close();
});
