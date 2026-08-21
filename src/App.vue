<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import NetdiskBatch from "./NetdiskBatch.vue";
import AutomationAnswer from "./AutomationAnswer.vue";

const bridge = window.wangpanAPI;
const DEFAULT_CLOUD_RULES_URL = "https://bd.aiserve.top/rules.json";
const DEFAULT_TITLE_PROMPT = "标题语气自然，像用户咨询素材获取；根据素材类型灵活使用“求、哪里可以获取、怎么获取”等表达，避免所有标题使用同一句式。";
const DEFAULT_INTRO_PROMPT = "书籍/小说：说明题材类型、核心人物身份与特点、主线脉络及叙事主题，避免虚构无法从标题判断的具体情节。影视：说明题材、核心主题、主要看点、风格定位和适合人群。学习资料：说明知识领域、适用学段或考试场景、核心模块、内容范围、配套形式、学习收获和目标人群。";
const DEFAULT_ANSWER_PROMPT = `请生成百度知道优质回答，只输出自然连贯的回答正文。
内容依次用自然段完成以下表达：先开门见山给出核心观点；再以第一人称亲身经历举例，贴近普通人生活；接着分析现象背后的深层原因；然后提供可落地、能直接执行的办法；最后延伸感悟，引发情感共鸣。

规则：
禁止输出任何段落标题、板块名称、方括号标签、总结标签或序号；
直接从回答内容开始，使用自然段衔接，不使用项目符号；
语气为热心分享经验的普通网友，拒绝生硬教科书式文字；
内容贴合情感生活类问答，逻辑通顺，具备共情力；
不要过度口语化，满足平台优质回答审核标准；
回答尽量简洁。`;
const aiConcurrencyOptions = [...Array.from({ length: 30 }, (_, index) => index + 1), 40, 50, 60, 80, 100];
const localResourceTypeLabels = {
  auto: "自动识别",
  study: "学习资料",
  book: "书籍小说",
  film: "影视资源",
  template: "设计模板",
  general: "通用素材",
};
const activePage = ref("home");
const sourcePath = ref("");
const source = ref(null);
const localResourceType = ref("auto");
const tasks = ref([]);
const activeTaskId = ref("");
const busy = ref(false);
const settingsOpen = ref(false);
const licenseKey = ref("");
const licenseBusy = ref(false);
const initialLoaded = ref(false);
const startupError = ref("");
const requiresStartupActivation = computed(() => Boolean(settings.configurableApiBase && !settings.license?.valid));
const settingsTab = ref("ai");
const aiAdvancedOpen = ref(false);
const customRuleEditorOpen = ref(false);
const cloudRulesBusy = ref(false);
const updateBusy = ref(false);
const updateState = reactive({ status: "idle", currentVersion: "", availableVersion: "", percent: 0, notes: "", error: "", configured: false });
const updateDialogOpen = ref(false);
const dismissedUpdateVersion = ref("");
const editingCustomRuleId = ref("");
const customRuleDraft = reactive({ name: "", keywords: "", titlePrefix: "求", titleSuffix: "网盘链接获取", introTemplate: "", enabled: true });
const netdiskFormatOpen = ref(false);
const pendingNetdiskFormat = ref(null);
const netdiskFormatMode = ref("ai");
const netdiskFormatResourceType = ref("auto");
const selectedRow = ref(null);
const rowEditTitle = ref("");
const rowEditAnswer = ref("");
const rowActionBusy = ref(false);
const exportAudit = ref(null);
const selectedRowIds = ref([]);
const deleteConfirmOpen = ref(false);
const taskDeleteConfirmOpen = ref(false);
const pendingDeleteTaskId = ref("");
const regenerateConfirmOpen = ref(false);
const pendingRegenerateRowIds = ref([]);
const jumpPage = ref(1);
const notice = reactive({ show: false, type: "success", text: "" });
const settings = reactive({
  mode: "ai",
  baseUrl: "https://geekai.co/api/v1",
  model: "glm-4-flash",
  answerModel: "gpt-5.6-sol",
  answerPrompt: DEFAULT_ANSWER_PROMPT,
  apiKey: "",
  hasApiKey: false,
  configurableApiBase: false,
  concurrency: 15,
  maxAttempts: 3,
  titleMode: "ai",
  titlePrompt: DEFAULT_TITLE_PROMPT,
  introPrompt: DEFAULT_INTRO_PROMPT,
  customRules: [],
  cloudRulesUrl: DEFAULT_CLOUD_RULES_URL,
  cloudRulesAutoUpdate: true,
  disabledCloudRuleIds: [],
  cloudRules: [],
  cloudRulesMeta: { version: "", updatedAt: "", sourceUrl: "" },
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
});
const rowSearch = ref("");
const rowStatus = ref("all");
const rowPage = ref(1);
const rowPageSize = ref(20);
const rowData = reactive({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
  pageCount: 1,
  counts: { all: 0, pending: 0, running: 0, completed: 0, failed: 0 },
});
let unsubscribeProgress;
let unsubscribeCloudRules;
let unsubscribeUpdateState;
let unsubscribeLicenseState;
let noticeTimer;
let rowRefreshTimer;
let rowSearchTimer;

const isLocalEdition = computed(() => activePage.value === "local");
const currentFormatMode = computed(() => isLocalEdition.value ? "rules" : "ai");
const formatTasks = computed(() => tasks.value.filter((task) => task.mode === currentFormatMode.value));
const activeTask = computed(() => tasks.value.find((task) => task.id === activeTaskId.value && task.mode === currentFormatMode.value) || null);
const pendingDeleteTask = computed(() => tasks.value.find((task) => task.id === pendingDeleteTaskId.value) || null);
const enabledCustomRules = computed(() => (Array.isArray(settings.customRules) ? settings.customRules : []).filter((rule) => rule.enabled !== false));
const enabledCloudRules = computed(() => (Array.isArray(settings.cloudRules) ? settings.cloudRules : []).filter((rule) => rule.enabled !== false && !settings.disabledCloudRuleIds.includes(rule.id)));
const currentLocalRules = computed(() => [...enabledCustomRules.value, ...enabledCloudRules.value]);
const progress = computed(() => {
  const task = activeTask.value;
  if (!task?.total) return 0;
  return Math.round((task.completed / task.total) * 100);
});
const canStart = computed(() => {
  const task = activeTask.value;
  return task && !["running", "completed"].includes(task.status);
});
const canExport = computed(() => {
  const task = activeTask.value;
  return task && task.total > 0;
});
const allPageRowsSelected = computed(() => (
  rowData.items.length > 0
  && rowData.items.every((row) => selectedRowIds.value.includes(row.id))
));

const statusMap = {
  ready: ["等待开始", "neutral"],
  running: ["正在处理", "running"],
  paused: ["已暂停", "warning"],
  completed: ["已完成", "success"],
  completed_with_errors: ["部分失败", "danger"],
};
const rowStatusMap = {
  pending: ["待处理", "neutral"],
  running: ["处理中", "running"],
  completed: ["已完成", "success"],
  failed: ["失败", "danger"],
};

function statusOf(status) {
  return statusMap[status] || ["未知状态", "neutral"];
}

function rowStatusOf(status) {
  return rowStatusMap[status] || ["未知", "neutral"];
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function toast(text, type = "success") {
  clearTimeout(noticeTimer);
  notice.text = text;
  notice.type = type;
  notice.show = true;
  noticeTimer = setTimeout(() => { notice.show = false; }, 3600);
}

function settingsPayload() {
  return {
    mode: "ai",
    baseUrl: String(settings.baseUrl),
    model: String(settings.model),
    answerModel: String(settings.answerModel || "gpt-5.6-sol"),
    answerPrompt: String(settings.answerPrompt || DEFAULT_ANSWER_PROMPT),
    apiKey: String(settings.apiKey),
    concurrency: Number(settings.concurrency),
    maxAttempts: Number(settings.maxAttempts),
    titleMode: settings.titleMode === "fixed" ? "fixed" : "ai",
    titlePrompt: String(settings.titlePrompt || ""),
    introPrompt: String(settings.introPrompt || ""),
    customRules: plainCustomRules(settings.customRules),
    cloudRulesUrl: String(settings.cloudRulesUrl || ""),
    cloudRulesAutoUpdate: Boolean(settings.cloudRulesAutoUpdate),
    disabledCloudRuleIds: Array.from(settings.disabledCloudRuleIds || [], String),
    netdiskTransferDestination: String(settings.netdiskTransferDestination),
    netdiskSeparateFolders: Boolean(settings.netdiskSeparateFolders),
    netdiskTransferConcurrency: Number(settings.netdiskTransferConcurrency),
    netdiskAutoShare: Boolean(settings.netdiskAutoShare),
    netdiskSharePeriod: Number(settings.netdiskSharePeriod),
    netdiskRandomPassword: Boolean(settings.netdiskRandomPassword),
    netdiskFixedPassword: String(settings.netdiskFixedPassword),
    netdiskShareConcurrency: Number(settings.netdiskShareConcurrency),
    netdiskMaxDepth: Number(settings.netdiskMaxDepth),
    netdiskMaxItems: Number(settings.netdiskMaxItems),
    startPage: settings.startPage === "netdisk" ? "netdisk" : "qa",
  };
}

function applyUpdateState(state) {
  if (!state) return;
  Object.assign(updateState, state);
  if (state.status === "available" && state.availableVersion !== dismissedUpdateVersion.value) updateDialogOpen.value = true;
  if (["downloading", "downloaded"].includes(state.status)) updateDialogOpen.value = true;
}

function dismissUpdateDialog() {
  dismissedUpdateVersion.value = updateState.availableVersion;
  updateDialogOpen.value = false;
}

async function checkAppUpdate() {
  updateBusy.value = true;
  try {
    applyUpdateState(await bridge.checkForUpdates());
    if (updateState.status === "up-to-date") toast("当前已是最新版本");
  } catch (error) { toast(error.message || String(error), "error"); }
  finally { updateBusy.value = false; }
}

async function downloadAppUpdate() {
  updateBusy.value = true;
  try { applyUpdateState(await bridge.downloadUpdate()); }
  catch (error) { toast(error.message || String(error), "error"); }
  finally { updateBusy.value = false; }
}

async function installAppUpdate() {
  try { await bridge.installUpdate(); }
  catch (error) { toast(error.message || String(error), "error"); }
}

function taskRunOptions(task = activeTask.value) {
  const mode = task?.mode === "rules" || (!task && isLocalEdition.value) ? "rules" : "ai";
  return {
    mode,
    baseUrl: String(settings.baseUrl),
    model: String(settings.model),
    concurrency: Number(settings.concurrency),
    maxAttempts: Number(settings.maxAttempts),
    titleMode: mode === "rules" ? "local" : settings.titleMode === "fixed" ? "fixed" : "ai",
    resourceType: mode === "rules" ? String(task?.options?.resourceType || localResourceType.value) : "auto",
    customRules: mode === "rules" ? plainCustomRules(task ? task.options?.customRules : currentLocalRules.value) : [],
    titlePrompt: String(settings.titlePrompt || ""),
    introPrompt: String(settings.introPrompt || ""),
  };
}

function ensureApiKeyConfigured() {
  if (settings.hasApiKey || (settings.apiKey && !settings.apiKey.includes("•"))) return true;
  settingsOpen.value = true;
  toast("请先配置API密钥", "error");
  return false;
}

function resourceTypeLabel(value) {
  const customId = String(value || "").startsWith("custom:") ? String(value).slice(7) : "";
  if (customId) {
    const taskRules = activeTask.value?.options?.customRules || [];
    return [...taskRules, ...(settings.customRules || []), ...(settings.cloudRules || [])].find((rule) => rule.id === customId)?.name || "自定义规则";
  }
  return localResourceTypeLabels[value] || localResourceTypeLabels.auto;
}

function plainCustomRules(rules) {
  return (Array.isArray(rules) ? rules : []).map((rule) => ({
    id: String(rule?.id || ""),
    name: String(rule?.name || ""),
    keywords: Array.isArray(rule?.keywords) ? rule.keywords.map(String) : String(rule?.keywords || "").split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean),
    titlePrefix: String(rule?.titlePrefix || ""),
    titleSuffix: String(rule?.titleSuffix || ""),
    introTemplate: String(rule?.introTemplate || ""),
    enabled: rule?.enabled !== false,
  }));
}

function resetCustomRuleDraft() {
  Object.assign(customRuleDraft, { name: "", keywords: "", titlePrefix: "求", titleSuffix: "网盘链接获取", introTemplate: "", enabled: true });
  editingCustomRuleId.value = "";
}

function openNewCustomRule() {
  resetCustomRuleDraft();
  customRuleEditorOpen.value = true;
}

function editCustomRule(rule) {
  editingCustomRuleId.value = rule.id;
  Object.assign(customRuleDraft, {
    name: rule.name,
    keywords: (rule.keywords || []).join("，"),
    titlePrefix: rule.titlePrefix || "求",
    titleSuffix: rule.titleSuffix || "网盘链接获取",
    introTemplate: rule.introTemplate || "",
    enabled: rule.enabled !== false,
  });
  customRuleEditorOpen.value = true;
}

function saveCustomRuleDraft() {
  const name = customRuleDraft.name.trim();
  const keywords = customRuleDraft.keywords.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);
  if (!name) return toast("请填写规则名称", "error");
  if (!keywords.length) return toast("请至少填写一个匹配关键词", "error");
  if (customRuleDraft.introTemplate.trim().length < 10) return toast("简介核心说明至少填写10个字", "error");
  const id = editingCustomRuleId.value || (globalThis.crypto?.randomUUID?.() || `rule_${Date.now()}`);
  const record = {
    id,
    name,
    keywords,
    titlePrefix: customRuleDraft.titlePrefix.trim() || "求",
    titleSuffix: customRuleDraft.titleSuffix.trim() || "网盘链接获取",
    introTemplate: customRuleDraft.introTemplate.trim(),
    enabled: customRuleDraft.enabled,
  };
  const index = settings.customRules.findIndex((rule) => rule.id === id);
  if (index >= 0) settings.customRules.splice(index, 1, record);
  else settings.customRules.push(record);
  customRuleEditorOpen.value = false;
  resetCustomRuleDraft();
  toast("规则已更新，点击底部保存全局设置后永久生效");
}

function deleteCustomRule(rule) {
  settings.customRules = settings.customRules.filter((item) => item.id !== rule.id);
  if (localResourceType.value === `custom:${rule.id}`) localResourceType.value = "auto";
  toast("规则已移除，点击底部保存全局设置后永久生效");
}

function applyCloudRulesCache(cache) {
  settings.cloudRules = plainCustomRules(cache?.rules || []);
  settings.cloudRulesMeta = {
    version: String(cache?.version || ""),
    updatedAt: String(cache?.updatedAt || ""),
    sourceUrl: String(cache?.sourceUrl || ""),
  };
}

async function syncCloudRulesNow() {
  if (cloudRulesBusy.value) return;
  if (typeof bridge.syncCloudRules !== "function") return toast("云端规则功能尚未载入，请完全重启客户端", "error");
  cloudRulesBusy.value = true;
  try {
    const cache = await bridge.syncCloudRules({ url: String(settings.cloudRulesUrl || "") });
    applyCloudRulesCache(cache);
    toast(`云端规则已更新：${cache.rules.length} 条，版本 ${cache.version || "未标注"}`);
  } catch (error) {
    toast(error.message || String(error), "error");
  } finally {
    cloudRulesBusy.value = false;
  }
}

function toggleCloudRule(rule) {
  const disabled = new Set(settings.disabledCloudRuleIds || []);
  if (disabled.has(rule.id)) disabled.delete(rule.id);
  else disabled.add(rule.id);
  settings.disabledCloudRuleIds = [...disabled];
  if (disabled.has(rule.id) && localResourceType.value === `custom:${rule.id}`) localResourceType.value = "auto";
}

function activeTaskNeedsApi() {
  return activeTask.value?.mode !== "rules";
}

function resetTitlePrompt() {
  settings.titlePrompt = DEFAULT_TITLE_PROMPT;
  toast("已恢复默认标题提示词");
}

function resetIntroPrompt() {
  settings.introPrompt = DEFAULT_INTRO_PROMPT;
  toast("已恢复默认素材简介要求");
}

function resetAnswerPrompt() {
  settings.answerPrompt = DEFAULT_ANSWER_PROMPT;
  toast("已恢复默认答题提示词");
}

function updateTask(incoming) {
  if (!incoming?.id) return;
  const index = tasks.value.findIndex((task) => task.id === incoming.id);
  if (index >= 0) tasks.value.splice(index, 1, incoming);
  else tasks.value.unshift(incoming);
  if (incoming.runnerError) toast(incoming.runnerError, "error");
  if (incoming.id === activeTaskId.value) scheduleTaskRowsRefresh();
}

async function loadTaskRows(resetPage = false) {
  if (resetPage) rowPage.value = 1;
  if (!activeTaskId.value) {
    Object.assign(rowData, {
      items: [],
      total: 0,
      page: 1,
      pageCount: 1,
      counts: { all: 0, pending: 0, running: 0, completed: 0, failed: 0 },
    });
    return;
  }
  try {
    const result = await bridge.getTaskRows({
      taskId: activeTaskId.value,
      page: rowPage.value,
      pageSize: rowPageSize.value,
      status: rowStatus.value,
      query: rowSearch.value,
    });
    Object.assign(rowData, result);
    rowPage.value = result.page;
    jumpPage.value = result.page;
  } catch (error) {
    toast(error.message || String(error), "error");
  }
}

function scheduleTaskRowsRefresh() {
  if (rowRefreshTimer) return;
  rowRefreshTimer = setTimeout(() => {
    rowRefreshTimer = null;
    loadTaskRows(false);
  }, 100);
}

function searchTaskRows() {
  clearTimeout(rowSearchTimer);
  rowSearchTimer = setTimeout(() => loadTaskRows(true), 250);
}

function filterTaskRows(status) {
  rowStatus.value = status;
  loadTaskRows(true);
}

function changeTaskPage(page) {
  if (page < 1 || page > rowData.pageCount || page === rowPage.value) return;
  rowPage.value = page;
  loadTaskRows(false);
}

function changePageSize() {
  selectedRowIds.value = [];
  loadTaskRows(true);
}

function jumpToTaskPage() {
  const page = Math.max(1, Math.min(rowData.pageCount, Number(jumpPage.value) || 1));
  changeTaskPage(page);
}

function selectTask(taskId) {
  activeTaskId.value = taskId;
  selectedRow.value = null;
  selectedRowIds.value = [];
  loadTaskRows(true);
}

function openFormatEdition(page) {
  activePage.value = page === "local" ? "local" : "qa";
  const mode = page === "local" ? "rules" : "ai";
  const current = tasks.value.find((task) => task.id === activeTaskId.value && task.mode === mode);
  const next = current || tasks.value.find((task) => task.mode === mode) || null;
  activeTaskId.value = next?.id || "";
  selectedRow.value = null;
  selectedRowIds.value = [];
  loadTaskRows(true);
}

function toggleRowSelection(rowId) {
  if (selectedRowIds.value.includes(rowId)) {
    selectedRowIds.value = selectedRowIds.value.filter((id) => id !== rowId);
  } else {
    selectedRowIds.value = [...selectedRowIds.value, rowId];
  }
}

function toggleCurrentPageSelection() {
  const pageIds = rowData.items.map((row) => row.id);
  if (allPageRowsSelected.value) {
    selectedRowIds.value = selectedRowIds.value.filter((id) => !pageIds.includes(id));
  } else {
    selectedRowIds.value = [...new Set([...selectedRowIds.value, ...pageIds])];
  }
}

function plainRowIds(ids) {
  return [...new Set(Array.from(ids || [], (id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
}

async function confirmDeleteRows() {
  if (!activeTask.value || !selectedRowIds.value.length || rowActionBusy.value) return;
  rowActionBusy.value = true;
  try {
    const result = await bridge.deleteTaskRows({
      taskId: activeTask.value.id,
      rowIds: plainRowIds(selectedRowIds.value),
    });
    updateTask(result.task);
    selectedRowIds.value = [];
    deleteConfirmOpen.value = false;
    selectedRow.value = null;
    await loadTaskRows(true);
    toast(`已删除 ${result.deleted.toLocaleString()} 条数据`);
  } catch (error) {
    toast(error.message || String(error), "error");
  } finally {
    rowActionBusy.value = false;
  }
}

async function confirmDeleteTask() {
  const task = pendingDeleteTask.value;
  if (!task || rowActionBusy.value) return;
  if (task.status === "running") return toast("请先暂停任务再删除", "error");
  if (typeof bridge.deleteTask !== "function") {
    taskDeleteConfirmOpen.value = false;
    return toast("删除任务功能尚未载入，请完全退出软件后重新启动", "error");
  }
  rowActionBusy.value = true;
  try {
    const result = await bridge.deleteTask(task.id);
    const deletingActiveTask = activeTaskId.value === task.id;
    tasks.value = tasks.value.filter((item) => item.id !== task.id);
    if (deletingActiveTask) {
      const nextTask = formatTasks.value[0] || null;
      activeTaskId.value = nextTask?.id || "";
      selectedRow.value = null;
      selectedRowIds.value = [];
      exportAudit.value = null;
      await loadTaskRows(true);
    }
    taskDeleteConfirmOpen.value = false;
    pendingDeleteTaskId.value = "";
    toast(`任务已删除，同时移除 ${Number(result?.deletedRows || 0).toLocaleString()} 条数据`);
  } catch (error) {
    toast(error.message || String(error), "error");
  } finally {
    rowActionBusy.value = false;
  }
}

function requestDeleteTask(task) {
  if (!task) return;
  if (task.status === "running") return toast("请先暂停任务再删除", "error");
  pendingDeleteTaskId.value = task.id;
  taskDeleteConfirmOpen.value = true;
}

function requestRegenerateRows(rowIds) {
  const ids = plainRowIds(rowIds);
  if (!ids.length) return;
  pendingRegenerateRowIds.value = ids;
  regenerateConfirmOpen.value = true;
}

async function confirmRegenerateRows() {
  if (!activeTask.value || !pendingRegenerateRowIds.value.length || rowActionBusy.value) return;
  if (activeTaskNeedsApi() && !ensureApiKeyConfigured()) return;
  rowActionBusy.value = true;
  try {
    if (activeTaskNeedsApi()) await saveSettings(false);
    const result = await bridge.regenerateTaskRows({
      taskId: activeTask.value.id,
      rowIds: plainRowIds(pendingRegenerateRowIds.value),
      options: taskRunOptions(),
    });
    updateTask(result.task);
    regenerateConfirmOpen.value = false;
    pendingRegenerateRowIds.value = [];
    selectedRowIds.value = [];
    await loadTaskRows(false);
    toast(`已重新生成 ${result.processed.toLocaleString()} 条问答`);
  } catch (error) {
    toast(error.message || String(error), "error");
  } finally {
    rowActionBusy.value = false;
  }
}

async function copyRowLink(row) {
  try {
    await bridge.copyText(row.link);
    toast("网盘链接已复制");
  } catch (error) {
    toast(error.message || String(error), "error");
  }
}

function openRowDetail(row) {
  selectedRow.value = row;
  rowEditTitle.value = row?.title || "";
  rowEditAnswer.value = row?.answer || "";
}

function shortLink(value) {
  const match = String(value || "").match(/https:\/\/(?:pan\.baidu\.com|pan\.quark\.cn|pan\.xunlei\.com)\/[^\s<>"']+/i);
  if (!match) return String(value || "");
  const url = match[0];
  if (url.length <= 42) return url;
  return `${url.slice(0, 32)}…${url.slice(-8)}`;
}

function extractionCode(value) {
  const text = String(value || "");
  try {
    const match = text.match(/https:\/\/(?:pan\.baidu\.com|pan\.quark\.cn|pan\.xunlei\.com)\/[^\s<>"']+/i);
    const code = match ? new URL(match[0]).searchParams.get("pwd") : "";
    if (code) return code;
  } catch {
    // Continue with plain-text extraction.
  }
  return text.match(/(?:提取码|密码)\s*[:：]?\s*([A-Za-z0-9]{4})/i)?.[1] || "";
}

async function loadInitialData() {
  const [savedSettings, recentTasks] = await Promise.all([
    bridge.getSettings(),
    bridge.listTasks(),
  ]);
  Object.assign(settings, savedSettings, {
    apiKey: savedSettings.hasApiKey ? "••••••••" : "",
  });
  activePage.value = savedSettings.startPage === "netdisk" ? "netdisk" : "qa";
  tasks.value = recentTasks;
  const initialTask = recentTasks.find((task) => task.mode === "ai") || null;
  if (initialTask) {
    activeTaskId.value = initialTask.id;
    await loadTaskRows(true);
  }
}

async function chooseFile() {
  try {
    const selected = await bridge.chooseExcel();
    if (!selected) return;
    sourcePath.value = selected;
    busy.value = true;
    source.value = await bridge.analyzeExcel(selected);
    if (source.value.isValid) {
      toast(`格式校验通过，共 ${source.value.total.toLocaleString()} 条有效数据`);
    } else {
      toast(`格式校验未通过，发现 ${source.value.issues.length} 处问题`, "error");
    }
  } catch (error) {
    toast(error.message || String(error), "error");
  } finally {
    busy.value = false;
  }
}

function cancelImport() {
  if (busy.value) return;
  source.value = null;
  sourcePath.value = "";
}

async function createAndStart() {
  if (!source.value || busy.value) return;
  const mode = isLocalEdition.value ? "rules" : "ai";
  if (mode === "ai" && !settings.hasApiKey && !settings.apiKey) {
    settingsOpen.value = true;
    toast("AI模式需要先配置API密钥", "error");
    return;
  }
  busy.value = true;
  try {
    if (mode === "ai") await saveSettings(false);
    const task = await bridge.createTask({
      sourcePath: sourcePath.value,
      options: {
        mode,
        baseUrl: settings.baseUrl,
        model: settings.model,
        concurrency: settings.concurrency,
        maxAttempts: settings.maxAttempts,
        titleMode: mode === "rules" ? "local" : settings.titleMode,
        resourceType: mode === "rules" ? localResourceType.value : "auto",
        customRules: mode === "rules" ? plainCustomRules(currentLocalRules.value) : [],
        titlePrompt: settings.titlePrompt,
        introPrompt: settings.introPrompt,
      },
    });
    if (task?.mode !== mode) {
      throw new Error(mode === "rules"
        ? "本地转换后台尚未更新，请完全退出软件后重新启动"
        : "任务模式与当前页面不一致，请完全退出软件后重新启动");
    }
    updateTask(task);
    activeTaskId.value = task.id;
    await loadTaskRows(true);
    source.value = null;
    sourcePath.value = "";
    const startedTask = await bridge.startTask({ taskId: task.id, options: taskRunOptions(task) });
    if (!startedTask?.id || startedTask.id !== task.id || startedTask.mode !== mode) {
      throw new Error("任务启动状态异常，请完全退出软件后重新启动");
    }
    updateTask(startedTask);
    toast(mode === "rules" ? "本地转换已开始，全程无需调用AI接口" : "任务已开始，可在后台持续处理");
  } catch (error) {
    toast(error.message || String(error), "error");
  } finally {
    busy.value = false;
  }
}

async function createTaskFromNetdisk(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows.map((row) => ({
    name: String(row?.name || ""),
    link: String(row?.link || ""),
  })) : [];
  if (!rows.length) return toast("暂无可发送到格式转换的分享结果", "error");
  pendingNetdiskFormat.value = {
    rows,
    sourceType: payload?.sourceType === "transfer" ? "transfer" : "share",
  };
  netdiskFormatMode.value = "ai";
  netdiskFormatResourceType.value = "auto";
  netdiskFormatOpen.value = true;
}

async function confirmNetdiskFormat() {
  if (busy.value || !pendingNetdiskFormat.value?.rows?.length) return;
  const mode = netdiskFormatMode.value === "rules" ? "rules" : "ai";
  if (mode === "ai" && !ensureApiKeyConfigured()) {
    netdiskFormatOpen.value = false;
    return;
  }
  const rows = pendingNetdiskFormat.value.rows.map((row) => ({
    name: String(row?.name || ""),
    link: String(row?.link || ""),
  }));
  const sourceType = pendingNetdiskFormat.value.sourceType === "transfer" ? "transfer" : "share";
  if (typeof bridge.createTaskFromNetdisk !== "function") return toast("格式转换接口尚未加载，请完全重启客户端", "error");
  busy.value = true;
  try {
    if (mode === "ai") await saveSettings(false);
    const options = {
      mode,
      baseUrl: String(settings.baseUrl),
      model: String(settings.model),
      concurrency: Number(settings.concurrency),
      maxAttempts: Number(settings.maxAttempts),
      titleMode: mode === "rules" ? "local" : settings.titleMode === "fixed" ? "fixed" : "ai",
      resourceType: mode === "rules" ? netdiskFormatResourceType.value : "auto",
      customRules: mode === "rules" ? plainCustomRules(currentLocalRules.value) : [],
      titlePrompt: String(settings.titlePrompt || ""),
      introPrompt: String(settings.introPrompt || ""),
    };
    const task = await bridge.createTaskFromNetdisk({
      rows,
      sourceType,
      options,
    });
    if (task?.mode !== mode) throw new Error("格式转换后台尚未更新，请完全退出软件后重新启动");
    updateTask(task);
    activeTaskId.value = task.id;
    activePage.value = mode === "rules" ? "local" : "qa";
    rowSearch.value = "";
    rowStatus.value = "all";
    selectedRowIds.value = [];
    await loadTaskRows(true);
    const startedTask = await bridge.startTask({ taskId: task.id, options: taskRunOptions(task) });
    updateTask(startedTask);
    netdiskFormatOpen.value = false;
    pendingNetdiskFormat.value = null;
    toast(`已发送 ${rows.length.toLocaleString()} 条分享结果，并开始${mode === "rules" ? "本地" : "AI"}格式转换`);
  } catch (error) {
    toast(error.message || String(error), "error");
  } finally {
    busy.value = false;
  }
}

async function startActive() {
  if (!activeTask.value) return;
  if (activeTaskNeedsApi() && !ensureApiKeyConfigured()) return;
  try {
    if (activeTaskNeedsApi()) await saveSettings(false);
    await bridge.startTask({
      taskId: activeTask.value.id,
      options: taskRunOptions(),
    });
    toast(`任务已按当前配置继续：${activeTask.value.mode === "rules" ? "本地规则" : settings.model}`);
  } catch (error) {
    toast(error.message || String(error), "error");
  }
}

async function pauseActive() {
  if (!activeTask.value) return;
  try {
    updateTask(await bridge.pauseTask(activeTask.value.id));
    toast("任务已暂停");
  } catch (error) {
    toast(error.message || String(error), "error");
  }
}

async function retryActive() {
  if (!activeTask.value) return;
  if (activeTaskNeedsApi() && !ensureApiKeyConfigured()) return;
  try {
    if (activeTaskNeedsApi()) await saveSettings(false);
    await bridge.retryTask({
      taskId: activeTask.value.id,
      options: taskRunOptions(),
    });
    toast("失败记录已进入重试队列");
  } catch (error) {
    toast(error.message || String(error), "error");
  }
}

async function exportActive() {
  if (!activeTask.value) return;
  try {
    exportAudit.value = await bridge.auditTask(activeTask.value.id);
  } catch (error) {
    toast(error.message || String(error), "error");
  }
}

async function confirmExport() {
  if (!activeTask.value || !exportAudit.value?.canExport) return;
  try {
    const result = await bridge.exportTask(activeTask.value.id);
    if (result) {
      exportAudit.value = null;
      toast(`已导出 ${result.count.toLocaleString()} 条问答`);
    }
  } catch (error) {
    toast(error.message || String(error), "error");
  }
}

async function saveSelectedRow() {
  if (!activeTask.value || !selectedRow.value || rowActionBusy.value) return;
  rowActionBusy.value = true;
  try {
    const updated = await bridge.updateTaskRow({
      taskId: activeTask.value.id,
      rowId: selectedRow.value.id,
      title: rowEditTitle.value,
      answer: rowEditAnswer.value,
    });
    selectedRow.value = updated;
    rowEditTitle.value = updated.title || "";
    rowEditAnswer.value = updated.answer || "";
    await loadTaskRows(false);
    toast("本条问答已保存");
  } catch (error) {
    toast(error.message || String(error), "error");
  } finally {
    rowActionBusy.value = false;
  }
}

async function regenerateSelectedRow() {
  if (!activeTask.value || !selectedRow.value || rowActionBusy.value) return;
  if (activeTaskNeedsApi() && !ensureApiKeyConfigured()) return;
  rowActionBusy.value = true;
  try {
    if (activeTaskNeedsApi()) await saveSettings(false);
    const updated = await bridge.regenerateTaskRow({
      taskId: activeTask.value.id,
      rowId: selectedRow.value.id,
      options: taskRunOptions(),
    });
    selectedRow.value = updated;
    rowEditTitle.value = updated.title || "";
    rowEditAnswer.value = updated.answer || "";
    await loadTaskRows(false);
    toast("本条问答已重新生成");
  } catch (error) {
    toast(error.message || String(error), "error");
  } finally {
    rowActionBusy.value = false;
  }
}

async function saveSettings(close = true) {
  if (!settings.netdiskRandomPassword && !/^[a-zA-Z0-9]{4}$/.test(settings.netdiskFixedPassword)) {
    settingsTab.value = "netdisk";
    toast("网盘固定提取码必须为4位字母或数字", "error");
    throw new Error("网盘固定提取码格式不正确");
  }
  try {
    const saved = await bridge.saveSettings(settingsPayload());
    Object.assign(settings, saved, {
      apiKey: saved.hasApiKey ? "••••••••" : "",
    });
    if (close) {
      settingsOpen.value = false;
      toast("设置已安全保存");
    }
  } catch (error) {
    toast(error.message || String(error), "error");
    throw error;
  }
}

async function activateLicense() {
  licenseBusy.value = true;
  try { settings.license = await bridge.activateLicense(licenseKey.value); licenseKey.value = ""; toast("授权激活成功"); }
  catch (error) { toast(error.message || String(error), "error"); }
  finally { licenseBusy.value = false; }
}

async function refreshLicense() {
  licenseBusy.value = true;
  try { settings.license = await bridge.refreshLicense(); toast("授权状态已更新"); }
  catch (error) { toast(error.message || String(error), "error"); }
  finally { licenseBusy.value = false; }
}

async function openLicensePurchase() {
  try { await bridge.openLicensePurchase(); }
  catch (error) { toast(error.message || String(error), "error"); }
}

async function testApi() {
  busy.value = true;
  try {
    await bridge.testApi(settingsPayload());
    toast("AI接口连接成功");
  } catch (error) {
    toast(error.message || String(error), "error");
  } finally {
    busy.value = false;
  }
}

async function openApiKeyGuide() {
  try {
    await bridge.openApiKeyGuide();
  } catch (error) {
    toast(error.message || "无法打开密钥获取页面", "error");
  }
}

async function openUserGuide() {
  try {
    await bridge.openUserGuide();
  } catch (error) {
    toast(error.message || "无法打开使用说明", "error");
  }
}

async function openModelLibrary() {
  try {
    if (typeof bridge.openModelLibrary !== "function") throw new Error("模型列表入口尚未加载，请完全重启客户端");
    await bridge.openModelLibrary();
  } catch (error) {
    toast(error.message || "无法打开模型列表", "error");
  }
}

function openAutomationSettings(section = "model") {
  settingsTab.value = "automation";
  settingsOpen.value = true;
  if (section !== "prompt") return;
  nextTick(() => {
    const field = document.querySelector('[data-answer-prompt="true"]');
    field?.scrollIntoView({ behavior: "smooth", block: "center" });
    field?.focus({ preventScroll: true });
  });
}

onMounted(async () => {
  unsubscribeProgress = bridge.onTaskProgress(updateTask);
  unsubscribeCloudRules = bridge.onCloudRulesUpdated?.(applyCloudRulesCache);
  unsubscribeUpdateState = bridge.onUpdateState?.(applyUpdateState);
  unsubscribeLicenseState = bridge.onLicenseState?.((license) => { settings.license = license; });
  try {
    await loadInitialData();
    applyUpdateState(await bridge.getUpdateState?.());
  } catch (error) {
    startupError.value = error.message || String(error);
    toast(`初始化失败：${error.message || error}`, "error");
  } finally {
    initialLoaded.value = true;
  }
});

onBeforeUnmount(() => {
  unsubscribeProgress?.();
  unsubscribeCloudRules?.();
  unsubscribeUpdateState?.();
  unsubscribeLicenseState?.();
  clearTimeout(noticeTimer);
  clearTimeout(rowRefreshTimer);
  clearTimeout(rowSearchTimer);
});
</script>

<template>
  <div v-if="!initialLoaded" class="startup-license-screen"><div class="startup-license-card"><div class="startup-license-mark">AI</div><h1>正在启动</h1><p>正在检查本机配置与授权状态…</p></div></div>
  <div v-else-if="requiresStartupActivation" class="startup-license-screen">
    <section class="startup-license-card activation">
      <div class="startup-license-mark">AI</div>
      <span class="section-kicker">LICENSE ACTIVATION</span>
      <h1>激活可配置接口版本</h1>
      <p>此版本首次使用需要联网激活。激活成功后，每次联网验证可获得 7 天离线使用时间。</p>
      <label>授权码</label>
      <input v-model.trim="licenseKey" autofocus placeholder="请输入购买后获得的授权码" @keyup.enter="activateLicense" />
      <button class="primary-button" :disabled="licenseBusy || !licenseKey" @click="activateLicense">{{ licenseBusy ? "正在激活…" : "联网激活" }}</button>
      <div class="startup-license-purchase"><span>还没有授权码？</span><button type="button" @click="openLicensePurchase">{{ settings.licensePurchaseText || "联系软件提供方购买" }}</button></div>
      <small v-if="startupError" class="startup-license-error">{{ startupError }}</small>
      <small>设备标识：{{ settings.license?.deviceId?.slice(0, 16) }}…</small>
    </section>
    <transition name="toast"><div v-if="notice.show" class="toast-message" :class="notice.type"><span>{{ notice.type === "error" ? "!" : "✓" }}</span>{{ notice.text }}</div></transition>
  </div>
  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 7.5a5 5 0 0 1 9.7-1.7A4.6 4.6 0 0 1 18 14.9H7.2A3.7 3.7 0 0 1 7 7.5Z" />
            <path d="M9 11.5h6M12 8.5v6" />
          </svg>
        </div>
        <div>
          <strong>百度知道助手</strong>
          <span>本地批量处理</span>
        </div>
      </div>

      <nav class="nav-list">
          <button class="nav-item home-nav" :class="{ active: activePage === 'home' }" @click="activePage = 'home'">
            <svg viewBox="0 0 24 24"><path d="m4 11 8-7 8 7v9H4z"/><path d="M9 20v-6h6v6"/></svg>
            工作台首页
          </button>
          <button class="nav-item" :class="{ active: activePage === 'automation' }" @click="activePage = 'automation'">
          <svg viewBox="0 0 24 24"><path d="M8 4h8M9 2h6v4H9zM5 8h14v12H5z"/><path d="M9 12h.01M15 12h.01M9 16h6"/></svg>
          自动化答题
        </button>
        <button class="nav-item" :class="{ active: activePage === 'qa' }" @click="openFormatEdition('qa')">
          <svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg>
          格式转换AI版(慢)
        </button>
        <button class="nav-item" :class="{ active: activePage === 'local' }" @click="openFormatEdition('local')">
          <svg viewBox="0 0 24 24"><path d="M5 5h14v14H5z"/><path d="M9 9h6v6H9zM12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
          格式转换本地版(快)
        </button>
        <button class="nav-item" :class="{ active: activePage === 'netdisk' }" @click="activePage = 'netdisk'">
          <svg viewBox="0 0 24 24"><path d="M7 7.5a5 5 0 0 1 9.7-1.7A4.6 4.6 0 0 1 18 14.9H7.2A3.7 3.7 0 0 1 7 7.5Z"/><path d="M9 11.5h6M12 8.5v6"/></svg>
          网盘批处理
        </button>
        <button class="nav-item" @click="settingsOpen = true">
          <svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="m4.9 4.9 2 1.1 1.7-.7.6-2.3h5.6l.6 2.3 1.7.7 2-1.1 2.8 4.8-1.7 1.6.2 1.8 2.1 1v5.6l-2.3.6-.7 1.7 1.1 2"/></svg>
          全局设置
        </button>
      </nav>

      <div class="privacy-card">
        <svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.7 2.9 8.4 7 10 4.1-1.6 7-5.3 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></svg>
        <div>
          <strong>链接只留在本机</strong>
          <span>AI仅接收素材名称，不上传网盘地址</span>
        </div>
      </div>
    </aside>

    <main class="main-content">
      <header class="topbar">
        <div>
          <p class="eyebrow">WORKSPACE</p>
          <h1>{{ activePage === "home" ? "工作台首页" : activePage === "qa" ? "格式转换AI版" : activePage === "local" ? "格式转换本地版" : activePage === "netdisk" ? "网盘批处理" : "自动化答题" }}</h1>
        </div>
        <div class="topbar-actions">
          <div class="author-badge">
            <span>作者微信</span>
            <strong>f2468558247</strong>
          </div>
          <button class="guide-button" @click="openUserGuide">
            <svg viewBox="0 0 24 24"><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z"/><path d="M8 20a3 3 0 0 1 3-3h8M9 8h6M9 12h5"/></svg>
            使用说明
          </button>
          <button  class="icon-button" title="全局设置" @click="settingsOpen = true">
            <svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg>
          </button>
        </div>
      </header>

      <section v-if="activePage === 'home'" class="home-dashboard">
        <div class="home-hero"><div><span class="section-kicker">WORKSPACE HOME</span><h2>欢迎回来，开始今天的处理工作</h2><p>从这里快速进入内容生成、网盘批处理和自动答题。</p></div><button class="primary-button" @click="settingsOpen = true">检查全局配置</button></div>
        <div class="home-status-grid"><div class="home-status-card"><span>AI接口</span><strong>{{ settings.hasApiKey ? "已配置" : "未配置" }}</strong><small>{{ settings.hasApiKey ? "可以开始生成" : "请先填写 API Key" }}</small></div><div class="home-status-card"><span>进行中任务</span><strong>{{ tasks.filter((task) => task.status === 'running').length }}</strong><small>格式转换任务</small></div><div class="home-status-card"><span>百度网盘</span><strong>进入后检查</strong><small>Cookie 状态在网盘批处理页查看</small></div></div>
        <div class="home-entry-grid"><button class="home-entry-card" @click="openFormatEdition('qa')"><span>AI GENERATION</span><strong>格式转换AI版</strong><small>调用AI生成个性化标题和素材简介</small><b>进入工作区 →</b></button><button class="home-entry-card" @click="openFormatEdition('local')"><span>LOCAL RULES</span><strong>格式转换本地版</strong><small>选择资源类型，使用内置规则离线生成</small><b>进入工作区 →</b></button><button class="home-entry-card" @click="activePage = 'netdisk'"><span>NETDISK WORKBENCH</span><strong>网盘批处理</strong><small>批量转存、分享和目录管理</small><b>进入工作区 →</b></button><button class="home-entry-card" @click="activePage = 'automation'"><span>AUTOMATION</span><strong>自动化答题</strong><small>管理百度账号并运行自动答题任务</small><b>进入工作区 →</b></button></div>
        <div v-if="tasks.length" class="home-recent"><div class="panel-heading"><div><span class="section-kicker">RECENT TASKS</span><h3>最近任务</h3></div><button class="text-button" @click="openFormatEdition('qa')">查看AI版</button></div><div v-for="task in tasks.slice(0, 5)" :key="task.id" class="home-task-row"><strong>{{ task.fileName || task.id }}</strong><span>{{ task.mode === 'rules' ? '本地版' : 'AI版' }} · {{ statusOf(task.status)[0] }}</span><small>{{ formatTime(task.createdAt) }}</small></div></div>
      </section>

      <div v-show="activePage === 'qa' || activePage === 'local'" class="qa-workspace-page">

      <section v-if="!activeTask" class="upload-card">
        <div class="upload-copy">
          <span class="section-kicker">新建任务</span>
          <h2>{{ isLocalEdition ? "使用本地规则转换网盘资源表" : "把网盘资源表转换成AI问答数据" }}</h2>
          <p>{{ isLocalEdition ? "无需API密钥，根据所选资源类型在本机生成问题标题和约200字素材简介。" : "自动补全合并单元格，每条链接调用AI独立生成标题和HTML回答。" }}</p>
          <div v-if="!isLocalEdition" class="quick-settings">
            <span class="service-state" :class="{ ready: settings.hasApiKey }">
              <i></i>{{ settings.hasApiKey ? "接口已配置" : "接口未配置" }}
            </span>
            <input
              v-model.trim="settings.model"
              aria-label="输入AI模型ID"
              placeholder="输入模型ID"
            />
            <button @click="settingsOpen = true">详细设置</button>
          </div>
          <div v-else class="quick-settings local-quick-settings">
            <span class="local-state"><i></i>完全本地处理</span>
            <select v-model="localResourceType" aria-label="选择本地资源类型">
              <option value="auto">自动识别资源类型</option><option value="study">学习资料</option><option value="book">书籍 / 小说</option><option value="film">影视资源</option><option value="template">设计模板 / 素材</option><option value="general">通用素材</option>
              <optgroup v-if="enabledCustomRules.length" label="我的自定义规则"><option v-for="rule in enabledCustomRules" :key="rule.id" :value="`custom:${rule.id}`">{{ rule.name }}</option></optgroup>
              <optgroup v-if="enabledCloudRules.length" label="云端官方规则"><option v-for="rule in enabledCloudRules" :key="rule.id" :value="`custom:${rule.id}`">{{ rule.name }}</option></optgroup>
            </select>
          </div>
        </div>
        <button class="upload-button" :disabled="busy" @click="chooseFile">
          <span class="upload-icon">
            <svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M5 14v5h14v-5"/></svg>
          </span>
          <strong>{{ busy ? "正在读取…" : "选择 Excel 文件" }}</strong>
          <small>支持 .xlsx，默认读取前两列</small>
        </button>
      </section>

      <div class="workbench-grid">
        <div class="control-column">
          <section class="panel task-panel">
          <div class="panel-heading compact">
            <div>
              <span class="section-kicker">当前任务</span>
              <h3>{{ activeTask?.fileName || "暂无任务" }}</h3>
            </div>
            <div v-if="activeTask" class="task-heading-actions">
              <span class="status-chip" :class="statusOf(activeTask.status)[1]">
                <i></i>{{ statusOf(activeTask.status)[0] }}
              </span>
              <button class="task-delete-link" :disabled="activeTask.status === 'running'" @click="requestDeleteTask(activeTask)">删除任务</button>
            </div>
          </div>

          <div v-if="activeTask" class="task-body">
            <div class="progress-summary">
              <div class="progress-number">{{ progress }}<small>%</small></div>
              <div class="progress-copy">
                <strong>{{ activeTask.completed.toLocaleString() }} / {{ activeTask.total.toLocaleString() }}</strong>
                <span>已完成问答</span>
              </div>
              <div class="progress-stats">
                <span><i class="success-dot"></i>{{ activeTask.completed }} 成功</span>
                <span><i class="danger-dot"></i>{{ activeTask.failed }} 失败</span>
              </div>
            </div>
            <div class="progress-track"><i :style="{ width: `${progress}%` }"></i></div>
            <div class="task-meta">
              <span>{{ activeTask.mode === "ai" ? "AI个性化模式" : `本地规则 · ${resourceTypeLabel(activeTask.options?.resourceType)}` }}</span>
              <span>创建于 {{ formatTime(activeTask.createdAt) }}</span>
            </div>
            <div class="live-processing">
              <div class="live-heading">
                <div>
                  <strong>实时处理明细</strong>
                  <span v-if="activeTask.status === 'running'">任务运行中，数据会自动刷新</span>
                  <span v-else>显示最近的处理记录</span>
                </div>
                <span v-if="activeTask.currentItems?.length" class="live-count">
                  {{ activeTask.currentItems.length }} 条处理中
                </span>
              </div>

              <div v-if="activeTask.currentItems?.length" class="current-items">
                <div v-for="item in activeTask.currentItems" :key="`current-${item.sourceRow}`" class="activity-row current">
                  <span class="activity-state"><i></i>处理中</span>
                  <strong>第 {{ item.sourceRow }} 行</strong>
                  <span class="activity-name" :title="item.name">{{ item.name }}</span>
                </div>
              </div>
              <div v-else-if="activeTask.status === 'running'" class="activity-waiting">
                <i></i>正在读取并调度下一条数据…
              </div>

              <div v-if="activeTask.recentItems?.length" class="recent-items">
                <div
                  v-for="item in activeTask.recentItems"
                  :key="`recent-${item.sourceRow}-${item.updatedAt}`"
                  class="activity-row"
                >
                  <span class="activity-state" :class="item.status">
                    {{ item.status === "completed" ? "已完成" : "失败" }}
                  </span>
                  <strong>第 {{ item.sourceRow }} 行</strong>
                  <span class="activity-name" :title="item.name">{{ item.name }}</span>
                  <small v-if="item.error" :title="item.error">{{ item.error }}</small>
                </div>
              </div>
              <div v-else-if="activeTask.status !== 'running'" class="activity-empty">暂无处理记录</div>
            </div>
            <div class="task-actions">
              <button v-if="activeTask.status === 'running'" class="secondary-button" @click="pauseActive">暂停</button>
              <button v-else-if="canStart" class="secondary-button" @click="startActive">继续处理</button>
              <button v-if="activeTask.failed" class="secondary-button" @click="retryActive">重试失败项</button>
              <button class="primary-button" :disabled="!canExport" @click="exportActive">
                导出自问自答结果
                <svg viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M5 20h14"/></svg>
              </button>
            </div>
          </div>
          <div v-else class="empty-state">
            <div class="empty-icon"><svg viewBox="0 0 24 24"><path d="M4 5h6l2 2h8v12H4z"/></svg></div>
            <strong>还没有处理任务</strong>
            <span>选择上方Excel文件即可开始</span>
          </div>
          </section>

          <section class="panel history-panel">
          <div class="panel-heading compact">
            <div>
              <span class="section-kicker">最近任务</span>
              <h3>处理记录</h3>
            </div>
            <span class="count-badge">{{ formatTasks.length }}</span>
          </div>
          <div class="history-list">
            <div
              v-for="task in formatTasks.slice(0, 7)"
              :key="task.id"
              class="history-item-row"
              :class="{ active: task.id === activeTaskId }"
            >
              <button class="history-item" @click="selectTask(task.id)">
                <span class="file-icon">X</span>
                <span class="history-copy">
                  <strong>{{ task.fileName }}</strong>
                  <small>{{ task.completed }}/{{ task.total }} · {{ formatTime(task.updatedAt) }}</small>
                </span>
                <span class="mini-status" :class="statusOf(task.status)[1]"></span>
              </button>
              <button class="history-task-delete" :disabled="task.status === 'running'" title="删除这个任务" @click.stop="requestDeleteTask(task)">删除</button>
            </div>
            <div v-if="!formatTasks.length" class="history-empty">暂无历史记录</div>
          </div>
          </section>
        </div>

        <section class="panel data-workbench">
          <div class="workbench-heading">
            <div>
              <span class="section-kicker">DATA WORKBENCH</span>
              <h3>逐条处理明细</h3>
            </div>
            <div v-if="activeTask" class="workbench-header-controls">
              <label class="task-switcher">
                <span>切换任务</span>
                <select :value="activeTaskId" @change="selectTask($event.target.value)">
                  <option v-for="task in formatTasks" :key="task.id" :value="task.id">
                    {{ task.fileName }}（{{ task.completed }}/{{ task.total }}）
                  </option>
                </select>
              </label>
              <span class="status-chip" :class="statusOf(activeTask.status)[1]">
                <i></i>{{ statusOf(activeTask.status)[0] }}
              </span>
              <button class="secondary-button compact-command" :disabled="busy" @click="chooseFile">
                导入新文件
              </button>
              <button
                class="workbench-delete-task"
                :disabled="activeTask.status === 'running'"
                title="删除当前任务"
                @click="requestDeleteTask(activeTask)"
              >
                删除任务
              </button>
            </div>
          </div>

          <div v-if="activeTask" class="task-command-bar">
            <div class="compact-progress">
              <div class="compact-progress-copy">
                <strong>{{ progress }}%</strong>
                <span>
                  {{ activeTask.completed.toLocaleString() }} / {{ activeTask.total.toLocaleString() }} 已完成
                  <em v-if="activeTask.failed"> · {{ activeTask.failed }} 条失败</em>
                </span>
              </div>
              <div class="progress-track"><i :style="{ width: `${progress}%` }"></i></div>
            </div>
            <div class="command-actions">
              <button v-if="activeTask.status === 'running'" class="secondary-button" @click="pauseActive">暂停</button>
              <button v-else-if="canStart" class="secondary-button" @click="startActive">继续处理</button>
              <button v-if="activeTask.failed" class="secondary-button" @click="retryActive">重试失败项</button>
              <button class="primary-button" :disabled="!canExport" @click="exportActive">
                导出自问自答结果
                <svg viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M5 20h14"/></svg>
              </button>
            </div>
          </div>

          <div v-if="activeTask" class="row-metrics">
            <button :class="{ active: rowStatus === 'all' }" @click="filterTaskRows('all')">
              <span>全部</span><strong>{{ rowData.counts.all }}</strong>
            </button>
            <button :class="{ active: rowStatus === 'pending' }" @click="filterTaskRows('pending')">
              <span>待处理</span><strong>{{ rowData.counts.pending }}</strong>
            </button>
            <button :class="{ active: rowStatus === 'running' }" @click="filterTaskRows('running')">
              <span>处理中</span><strong class="blue">{{ rowData.counts.running }}</strong>
            </button>
            <button :class="{ active: rowStatus === 'completed' }" @click="filterTaskRows('completed')">
              <span>已完成</span><strong class="green">{{ rowData.counts.completed }}</strong>
            </button>
            <button :class="{ active: rowStatus === 'failed' }" @click="filterTaskRows('failed')">
              <span>失败</span><strong class="red">{{ rowData.counts.failed }}</strong>
            </button>
          </div>

          <div v-if="activeTask" class="table-toolbar">
            <label class="row-search">
              <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
              <input
                v-model="rowSearch"
                placeholder="搜索素材名称、链接、标题或错误"
                @input="searchTaskRows"
              />
            </label>
            <div class="table-toolbar-actions">
              <div class="status-filters">
                <button
                  v-for="option in [
                    ['all', '全部'],
                    ['pending', '待处理'],
                    ['running', '处理中'],
                    ['completed', '已完成'],
                    ['failed', '失败'],
                  ]"
                  :key="option[0]"
                  :class="{ active: rowStatus === option[0] }"
                  @click="filterTaskRows(option[0])"
                >
                  {{ option[1] }}
                </button>
              </div>
            </div>
          </div>

          <div v-if="activeTask" class="data-table-wrap">
            <div class="data-table-head">
              <span class="select-cell">
                <input
                  type="checkbox"
                  :checked="allPageRowsSelected"
                  aria-label="全选当前页"
                  @change="toggleCurrentPageSelection"
                />
              </span>
              <span>源行</span>
              <span>素材名称</span>
              <span>网盘链接 / 提取码</span>
              <span>问题标题</span>
              <span>状态</span>
              <span>操作</span>
            </div>
            <div
              v-for="row in rowData.items"
              :key="row.id"
              class="data-table-row"
              :class="[
                `is-${row.status}`,
                {
                  selected: selectedRow?.id === row.id,
                  'batch-selected': selectedRowIds.includes(row.id),
                },
              ]"
              @dblclick="openRowDetail(row)"
            >
              <span class="select-cell" @dblclick.stop>
                <input
                  type="checkbox"
                  :checked="selectedRowIds.includes(row.id)"
                  :aria-label="`选择第${row.sourceRow}行`"
                  @change="toggleRowSelection(row.id)"
                  @click.stop
                />
              </span>
              <span class="source-row">第 {{ row.sourceRow }} 行</span>
              <span class="material-cell">
                <strong :title="row.name">{{ row.name }}</strong>
                <small v-if="row.error" :title="row.error">{{ row.error }}</small>
              </span>
              <span class="link-cell">
                <strong :title="row.link">{{ shortLink(row.link) }}</strong>
                <small>提取码：{{ extractionCode(row.link) || "未识别" }}</small>
              </span>
              <span class="title-cell" :title="row.title || ''">
                {{ row.title || (row.status === "running" ? "正在生成标题…" : "等待生成") }}
              </span>
              <span>
                <em class="row-status-chip" :class="rowStatusOf(row.status)[1]">
                  <i v-if="row.status === 'running'"></i>{{ rowStatusOf(row.status)[0] }}
                </em>
              </span>
              <span class="row-quick-actions">
                <button title="复制链接" @click="copyRowLink(row)">
                  <svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                </button>
                <button title="编辑问答" :disabled="!row.answer && !row.error" @click="openRowDetail(row)">
                  <svg viewBox="0 0 24 24"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m13.5 8 3 3"/></svg>
                </button>
                <button
                  title="重新生成"
                  :disabled="activeTask.status === 'running' || row.status === 'running'"
                  @click="requestRegenerateRows([row.id])"
                >
                  <svg viewBox="0 0 24 24"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 9a7 7 0 0 1 11.5-2L20 12M4 12l2.4 5a7 7 0 0 0 11.5-2"/></svg>
                </button>
              </span>
            </div>
            <div v-if="!rowData.items.length" class="table-empty">
              {{ rowSearch || rowStatus !== "all" ? "没有符合条件的数据" : "暂无任务明细" }}
            </div>
          </div>

          <div v-if="activeTask && selectedRowIds.length" class="batch-action-bar">
            <div>
              <strong>已选择 {{ selectedRowIds.length.toLocaleString() }} 条</strong>
              <span>可跨页继续选择</span>
            </div>
            <div class="batch-action-buttons">
              <button class="text-button" @click="selectedRowIds = []">清除选择</button>
              <button
                class="secondary-button"
                :disabled="activeTask.status === 'running'"
                @click="requestRegenerateRows(selectedRowIds)"
              >
                重新生成选中
              </button>
              <button
                class="batch-delete-button"
                :disabled="activeTask.status === 'running'"
                @click="deleteConfirmOpen = true"
              >
                删除选中
              </button>
            </div>
          </div>

          <div v-if="activeTask" class="table-pagination">
            <span>共 {{ rowData.total.toLocaleString() }} 条</span>
            <div>
              <button :disabled="rowPage <= 1" @click="changeTaskPage(rowPage - 1)">上一页</button>
              <strong>{{ rowPage }} / {{ rowData.pageCount }}</strong>
              <button :disabled="rowPage >= rowData.pageCount" @click="changeTaskPage(rowPage + 1)">下一页</button>
            </div>
            <div class="pagination-options">
              <select v-model.number="rowPageSize" @change="changePageSize">
                <option :value="20">20 条/页</option>
                <option :value="50">50 条/页</option>
                <option :value="100">100 条/页</option>
                <option :value="200">200 条/页</option>
              </select>
              <label>
                跳至
                <input v-model.number="jumpPage" type="number" min="1" :max="rowData.pageCount" @keyup.enter="jumpToTaskPage" />
                页
              </label>
              <button @click="jumpToTaskPage">跳转</button>
            </div>
          </div>

          <div v-else class="workbench-empty">
            <div class="empty-icon"><svg viewBox="0 0 24 24"><path d="M4 5h6l2 2h8v12H4z"/></svg></div>
            <strong>导入Excel后在这里查看全部数据</strong>
            <span>支持实时状态、搜索、筛选和分页</span>
          </div>
        </section>
      </div>
      </div>

      <NetdiskBatch v-show="activePage === 'netdisk'" :global-settings="settings" @send-to-format="createTaskFromNetdisk" />
      <AutomationAnswer v-show="activePage === 'automation'" :global-settings="settings" @open-settings="openAutomationSettings" />
    </main>

    <div v-if="netdiskFormatOpen" class="detail-backdrop" @click.self="netdiskFormatOpen = false">
      <section class="netdisk-format-dialog">
        <div class="drawer-heading import-heading"><div><span class="section-kicker">SEND TO FORMAT</span><h2>选择格式转换方式</h2></div><button class="close-button" :disabled="busy" @click="netdiskFormatOpen = false">×</button></div>
        <p class="netdisk-format-summary">将发送 {{ pendingNetdiskFormat?.rows?.length || 0 }} 条网盘分享结果，无需先导出和重新上传Excel。</p>
        <div class="format-target-options">
          <label :class="{ active: netdiskFormatMode === 'ai' }"><input v-model="netdiskFormatMode" type="radio" value="ai" /><span><strong>格式转换AI版</strong><small>调用当前AI模型生成更个性化的问题标题和素材简介</small></span><i>AI</i></label>
          <label :class="{ active: netdiskFormatMode === 'rules' }"><input v-model="netdiskFormatMode" type="radio" value="rules" /><span><strong>格式转换本地版</strong><small>使用内置或自定义规则，不需要API密钥</small></span><i>本地</i></label>
        </div>
        <label v-if="netdiskFormatMode === 'rules'" class="netdisk-local-rule-select"><span><strong>选择资源类型</strong><small>自动识别会逐条匹配用户规则、云端规则和内置规则</small></span><select v-model="netdiskFormatResourceType"><option value="auto">自动识别资源类型</option><option value="study">学习资料</option><option value="book">书籍 / 小说</option><option value="film">影视资源</option><option value="template">设计模板 / 素材</option><option value="general">通用素材</option><optgroup v-if="enabledCustomRules.length" label="我的自定义规则"><option v-for="rule in enabledCustomRules" :key="rule.id" :value="`custom:${rule.id}`">{{ rule.name }}</option></optgroup><optgroup v-if="enabledCloudRules.length" label="云端官方规则"><option v-for="rule in enabledCloudRules" :key="rule.id" :value="`custom:${rule.id}`">{{ rule.name }}</option></optgroup></select></label>
        <div class="confirm-actions"><button class="secondary-button" :disabled="busy" @click="netdiskFormatOpen = false">取消</button><button class="primary-button" :disabled="busy" @click="confirmNetdiskFormat">{{ busy ? '正在创建任务…' : `发送到${netdiskFormatMode === 'rules' ? '本地版' : 'AI版'}` }}</button></div>
      </section>
    </div>

    <div v-if="source" class="detail-backdrop import-backdrop" @click.self="cancelImport">
      <section class="import-dialog">
        <div class="drawer-heading import-heading">
          <div><span class="section-kicker">IMPORT EXCEL</span><h2>确认导入新文件</h2></div>
          <button class="close-button" :disabled="busy" @click="cancelImport">×</button>
        </div>
        <div class="import-file-card">
          <span class="import-file-icon">X</span>
          <div><strong>{{ source.fileName }}</strong><small>工作表：{{ source.sheetName }}</small></div>
          <button :disabled="busy" @click="chooseFile">重新选择</button>
        </div>
        <div class="import-metrics">
          <div><strong>{{ source.inputRows.toLocaleString() }}</strong><span>数据行</span></div>
          <div><strong>{{ source.total.toLocaleString() }}</strong><span>有效链接</span></div>
          <div :class="{ invalid: source.issues.length }"><strong>{{ source.issues.length }}</strong><span>格式错误</span></div>
        </div>
        <label v-if="isLocalEdition" class="import-resource-type">
          <span><strong>资源类型</strong><small>选择后将整份文件按对应的本地规则生成；“自动识别”会逐行判断。</small></span>
          <select v-model="localResourceType">
            <option value="auto">自动识别资源类型</option><option value="study">学习资料</option><option value="book">书籍 / 小说</option><option value="film">影视资源</option><option value="template">设计模板 / 素材</option><option value="general">通用素材</option>
            <optgroup v-if="enabledCustomRules.length" label="我的自定义规则"><option v-for="rule in enabledCustomRules" :key="rule.id" :value="`custom:${rule.id}`">{{ rule.name }}</option></optgroup>
            <optgroup v-if="enabledCloudRules.length" label="云端官方规则"><option v-for="rule in enabledCloudRules" :key="rule.id" :value="`custom:${rule.id}`">{{ rule.name }}</option></optgroup>
          </select>
        </label>
        <div v-if="source.issues.length" class="validation-alert import-validation">
          <div class="validation-title"><span>!</span><p><strong>文件未通过格式校验</strong><small>请修正以下问题后重新选择文件。</small></p></div>
          <ul><li v-for="issue in source.issues.slice(0, 6)" :key="`${issue.row}-${issue.type}`"><strong>第 {{ issue.row }} 行</strong><span>{{ issue.message }}</span></li></ul>
          <p v-if="source.issues.length > 6" class="more-issues">另有 {{ source.issues.length - 6 }} 处问题未显示</p>
        </div>
        <div v-else class="import-ready-note"><i>✓</i><span><strong>格式校验通过</strong><small>将生成 {{ source.total.toLocaleString() }} 条独立问答，每条网盘链接对应一条记录。{{ isLocalEdition ? "本地版不会调用任何AI接口。" : "" }}</small></span></div>
        <div class="import-actions">
          <button class="secondary-button" :disabled="busy" @click="cancelImport">取消</button>
          <button class="primary-button" :disabled="busy || !source.isValid" @click="createAndStart">{{ busy ? "正在创建任务…" : source.isValid ? "开始转换" : "格式未通过" }}<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></button>
        </div>
      </section>
    </div>

    <div v-if="selectedRow" class="detail-backdrop" @click.self="selectedRow = null">
      <section class="row-detail-dialog">
        <div class="drawer-heading">
          <div>
            <span class="section-kicker">ROW DETAIL</span>
            <h2>第 {{ selectedRow.sourceRow }} 行处理详情</h2>
          </div>
          <button class="close-button" @click="selectedRow = null">×</button>
        </div>
        <dl class="row-detail-meta">
          <div><dt>素材名称</dt><dd>{{ selectedRow.name }}</dd></div>
          <div><dt>网盘链接</dt><dd>{{ selectedRow.link }}</dd></div>
          <div><dt>处理状态</dt><dd>{{ rowStatusOf(selectedRow.status)[0] }}</dd></div>
        </dl>
        <div v-if="selectedRow.error" class="detail-error">{{ selectedRow.error }}</div>
        <div class="row-edit-fields">
          <label>
            <span>问题标题（5～49字）</span>
            <input v-model="rowEditTitle" :disabled="rowActionBusy" />
          </label>
          <label>
            <span>HTML回答内容</span>
            <textarea v-model="rowEditAnswer" :disabled="rowActionBusy"></textarea>
          </label>
        </div>
        <div class="row-detail-actions">
          <button class="secondary-button" :disabled="rowActionBusy" @click="regenerateSelectedRow">
            {{ rowActionBusy ? "处理中…" : "重新生成本条" }}
          </button>
          <button class="primary-button" :disabled="rowActionBusy" @click="saveSelectedRow">
            保存修改
          </button>
        </div>
      </section>
    </div>

    <div v-if="exportAudit" class="detail-backdrop" @click.self="exportAudit = null">
      <section class="audit-dialog">
        <div class="drawer-heading">
          <div>
            <span class="section-kicker">EXPORT CHECK</span>
            <h2>导出前质量检查</h2>
          </div>
          <button class="close-button" @click="exportAudit = null">×</button>
        </div>
        <div class="audit-summary" :class="{ passed: exportAudit.canExport }">
          <strong>{{ exportAudit.canExport ? "检查通过，可以导出" : "暂不能导出，请先处理异常项" }}</strong>
          <span>{{ exportAudit.completed }} / {{ exportAudit.total }} 条已完成</span>
        </div>
        <div class="audit-grid">
          <div><span>未完成</span><strong :class="{ danger: exportAudit.incomplete }">{{ exportAudit.incomplete }}</strong></div>
          <div><span>空标题</span><strong :class="{ danger: exportAudit.emptyTitle }">{{ exportAudit.emptyTitle }}</strong></div>
          <div><span>标题字数异常</span><strong :class="{ danger: exportAudit.invalidTitleLength }">{{ exportAudit.invalidTitleLength }}</strong></div>
          <div><span>空回答</span><strong :class="{ danger: exportAudit.emptyAnswer }">{{ exportAudit.emptyAnswer }}</strong></div>
          <div><span>HTML结构异常</span><strong :class="{ danger: exportAudit.invalidHtml }">{{ exportAudit.invalidHtml }}</strong></div>
          <div><span>简介字数提醒</span><strong :class="{ warning: exportAudit.introLengthWarning }">{{ exportAudit.introLengthWarning }}</strong></div>
          <div><span>重复链接提醒</span><strong :class="{ warning: exportAudit.duplicateLinks }">{{ exportAudit.duplicateLinks }}</strong></div>
        </div>
        <p class="audit-note">简介字数和重复链接仅作提醒，不会阻止导出；未完成、空内容或HTML结构异常会阻止导出。</p>
        <div class="audit-actions">
          <button class="secondary-button" @click="exportAudit = null">返回检查</button>
          <button class="primary-button" :disabled="!exportAudit.canExport" @click="confirmExport">确认导出</button>
        </div>
      </section>
    </div>

    <div v-if="deleteConfirmOpen" class="detail-backdrop" @click.self="deleteConfirmOpen = false">
      <section class="confirm-dialog">
        <div class="confirm-icon">!</div>
        <h2>删除选中的数据？</h2>
        <p>将从当前任务中永久删除 {{ selectedRowIds.length }} 条记录，任务总数和导出检查结果会同步更新。</p>
        <div class="confirm-actions">
          <button class="secondary-button" :disabled="rowActionBusy" @click="deleteConfirmOpen = false">取消</button>
          <button class="danger-button" :disabled="rowActionBusy" @click="confirmDeleteRows">
            {{ rowActionBusy ? "正在删除…" : "确认删除" }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="taskDeleteConfirmOpen" class="detail-backdrop" @click.self="taskDeleteConfirmOpen = false">
      <section class="confirm-dialog">
        <div class="confirm-icon">!</div>
        <h2>删除整个任务？</h2>
        <p>将永久删除“{{ pendingDeleteTask?.fileName }}”及其中 {{ pendingDeleteTask?.total || 0 }} 条处理数据。已经导出到电脑的Excel文件不会被删除。</p>
        <div class="confirm-actions">
          <button class="secondary-button" :disabled="rowActionBusy" @click="taskDeleteConfirmOpen = false">取消</button>
          <button class="danger-button" :disabled="rowActionBusy" @click="confirmDeleteTask">
            {{ rowActionBusy ? "正在删除…" : "确认删除任务" }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="regenerateConfirmOpen" class="detail-backdrop" @click.self="regenerateConfirmOpen = false">
      <section class="confirm-dialog">
        <div class="confirm-icon regenerate">↻</div>
        <h2>重新生成选中的问答？</h2>
        <p>将重新调用当前生成方式处理 {{ pendingRegenerateRowIds.length }} 条数据，并覆盖这些记录已有的标题和回答。</p>
        <div class="confirm-actions">
          <button class="secondary-button" :disabled="rowActionBusy" @click="regenerateConfirmOpen = false">取消</button>
          <button class="primary-button" :disabled="rowActionBusy" @click="confirmRegenerateRows">
            {{ rowActionBusy ? "正在生成…" : "确认重新生成" }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="settingsOpen" class="drawer-backdrop">
      <aside class="settings-drawer">
        <div class="drawer-heading">
          <div>
            <span class="section-kicker">SETTINGS</span>
            <h2>全局设置</h2>
          </div>
          <button class="close-button" @click="settingsOpen = false">×</button>
        </div>

        <div class="global-setting-tabs">
          <button :class="{ active: settingsTab === 'ai' }" @click="settingsTab = 'ai'"><strong>AI格式转换</strong><span>模型与生成</span></button>
          <button :class="{ active: settingsTab === 'localRules' }" @click="settingsTab = 'localRules'"><strong>本地规则</strong><span>自定义规则库</span></button>
          <button :class="{ active: settingsTab === 'automation' }" @click="settingsTab = 'automation'"><strong>自动化答题</strong><span>专用模型</span></button>
          <button :class="{ active: settingsTab === 'netdisk' }" @click="settingsTab = 'netdisk'"><strong>网盘批处理</strong><span>转存与分享</span></button>
          <button :class="{ active: settingsTab === 'general' }" @click="settingsTab = 'general'"><strong>通用</strong><span>启动偏好</span></button>
        </div>

        <div v-if="settingsTab === 'ai'" class="global-setting-panel">
          <div class="settings-section-title"><strong>AI生成设置</strong><span>用于格式转换AI版的新任务和重新生成</span></div>
          <div class="field">
            <div class="field-label-row">
              <label>API密钥</label>
              <button type="button" class="key-guide-link" @click="openApiKeyGuide">没有密钥？点击获取</button>
            </div>
            <input v-model="settings.apiKey" type="password" placeholder="请输入API密钥" />
            <small>获取后复制到这里。密钥使用Windows系统加密，仅保存在当前电脑。</small>
          </div>
          <div v-if="settings.configurableApiBase" class="field">
            <label>API Base URL</label>
            <input v-model.trim="settings.baseUrl" type="url" placeholder="https://example.com/v1" />
            <small>填写 OpenAI 兼容接口的基础地址，不要包含 /chat/completions。</small>
          </div>
          <div v-if="settings.configurableApiBase" class="field">
            <label>接口版本授权</label>
            <input v-if="!settings.license?.valid" v-model.trim="licenseKey" placeholder="请输入授权码" />
            <small v-if="settings.license?.valid">已激活；离线可用至 {{ formatTime(settings.license.offlineUntil) }}</small>
            <small v-else>首次使用必须联网激活，之后每次验证可获得 7 天离线宽限期。</small>
            <button v-if="!settings.license?.valid" class="test-button" :disabled="licenseBusy || !licenseKey" @click="activateLicense">激活授权</button>
            <button v-else class="test-button" :disabled="licenseBusy" @click="refreshLicense">立即联网验证</button>
          </div>
          <div class="field">
            <label>模型名称</label>
            <input v-model.trim="settings.model" placeholder="请输入模型ID" />
            <small>默认使用glm-4-flash，也可以输入接口支持的其他模型ID。</small>
            <button type="button" class="model-library-link" @click="openModelLibrary">查找可用模型 →</button>
          </div>
          <button class="test-button" :disabled="busy" @click="testApi">测试接口连接</button>
          <div class="setting-grid">
            <div class="field"><label>同时处理</label><select v-model.number="settings.concurrency"><option v-for="value in aiConcurrencyOptions" :key="value" :value="value">{{ value }} 条{{ value === 15 ? "（推荐）" : "" }}</option></select><small>支持最高100条；过高可能触发接口限流，建议逐步增加。</small></div>
            <div class="field"><label>失败重试</label><select v-model.number="settings.maxAttempts"><option v-for="value in 5" :key="value" :value="value">{{ value }} 次</option></select></div>
          </div>
          <div class="advanced-settings-block" :class="{ open: aiAdvancedOpen }">
            <button type="button" class="advanced-settings-toggle" :aria-expanded="aiAdvancedOpen" @click="aiAdvancedOpen = !aiAdvancedOpen">
              <span class="advanced-settings-icon">⚙</span>
              <span><strong>高级配置</strong><small>标题生成方式与个性化提示词</small></span>
              <i>⌄</i>
            </button>
            <div v-if="aiAdvancedOpen" class="advanced-settings-content">
              <div class="field">
                <label>问题标题生成方式</label>
                <select v-model="settings.titleMode"><option value="ai">AI智能生成（推荐）</option><option value="fixed">固定规则生成</option></select>
                <small>智能生成会根据文件名反推自然问题；校验不通过时自动使用固定标题。</small>
              </div>
              <div v-if="settings.titleMode === 'ai'" class="field title-prompt-field">
                <div class="field-label-row"><label>标题补充提示词</label><button type="button" class="key-guide-link" @click="resetTitlePrompt">恢复默认</button></div>
                <textarea v-model="settings.titlePrompt" maxlength="1000" placeholder="例如：语气自然，学习资料优先使用“哪里可以获取”，书籍优先使用“求完整版”"></textarea>
                <small>这里只填写风格偏好。素材名称、网盘关键词和5～49字限制由程序强制执行。</small>
              </div>
              <div class="field title-prompt-field">
                <div class="field-label-row"><label>素材简介补充要求</label><button type="button" class="key-guide-link" @click="resetIntroPrompt">恢复默认</button></div>
                <textarea v-model="settings.introPrompt" maxlength="1000" placeholder="例如：学习资料重点说明适用年级和知识模块；小说避免剧透结局"></textarea>
                <small>用于补充简介的内容侧重点。180～220字、素材分类和输出格式仍由程序强制执行；留空则只使用内置规则。</small>
              </div>
            </div>
          </div>
        </div>

        <div v-else-if="settingsTab === 'localRules'" class="global-setting-panel">
          <div class="settings-section-title rule-library-heading"><div><strong>本地规则库</strong><span>匹配优先级：用户自定义 → 云端官方 → 软件内置</span></div><button class="rule-add-button" @click="openNewCustomRule">＋ 新增规则</button></div>
          <div class="cloud-rule-config">
            <div class="cloud-rule-config-title"><div><strong>云端官方规则</strong><small>填写你维护的HTTPS规则JSON地址，下载成功后会缓存到本机。</small></div><span v-if="settings.cloudRulesMeta.version">版本 {{ settings.cloudRulesMeta.version }}</span></div>
            <div class="cloud-rule-url-row"><input v-model.trim="settings.cloudRulesUrl" :placeholder="DEFAULT_CLOUD_RULES_URL" /><button :disabled="cloudRulesBusy" @click="syncCloudRulesNow">{{ cloudRulesBusy ? '正在同步…' : '立即同步' }}</button></div>
            <label class="cloud-auto-update"><input v-model="settings.cloudRulesAutoUpdate" type="checkbox" /><span>软件启动时自动检查更新</span><small v-if="settings.cloudRulesMeta.updatedAt">上次成功：{{ formatTime(settings.cloudRulesMeta.updatedAt) }} · {{ settings.cloudRules.length }} 条</small></label>
          </div>
          <div v-if="settings.cloudRules.length" class="cloud-rule-list">
            <div v-for="rule in settings.cloudRules" :key="rule.id" class="cloud-rule-row" :class="{ disabled: settings.disabledCloudRuleIds.includes(rule.id) }"><label class="rule-enable"><input type="checkbox" :checked="!settings.disabledCloudRuleIds.includes(rule.id)" @change="toggleCloudRule(rule)" /><span></span></label><div><strong>{{ rule.name }}</strong><small>{{ (rule.keywords || []).join('、') }}</small></div><em>云端</em></div>
          </div>
          <div class="built-in-rule-note"><strong>内置规则</strong><span>学习资料、书籍小说、影视资源、设计模板和通用素材由程序维护，不会被误删。</span></div>
          <div v-if="settings.customRules.length" class="custom-rule-list">
            <div v-for="rule in settings.customRules" :key="rule.id" class="custom-rule-card" :class="{ disabled: !rule.enabled }">
              <label class="rule-enable"><input v-model="rule.enabled" type="checkbox" /><span></span></label>
              <div><strong>{{ rule.name }}</strong><small>匹配：{{ (rule.keywords || []).join('、') || '未设置关键词' }}</small><em>{{ rule.titlePrefix }}{资源名称}{{ rule.titleSuffix }}</em></div>
              <button @click="editCustomRule(rule)">编辑</button><button class="remove" @click="deleteCustomRule(rule)">删除</button>
            </div>
          </div>
          <div v-else class="rule-library-empty"><strong>还没有自定义规则</strong><span>新增后可在本地版导入时选择，也能用于文件名自动识别。</span></div>
          <div v-if="customRuleEditorOpen" class="custom-rule-editor">
            <div class="settings-section-title"><strong>{{ editingCustomRuleId ? '编辑规则' : '新增规则' }}</strong><span>所有处理都在本机完成，不调用AI接口</span></div>
            <div class="setting-grid"><div class="field"><label>规则名称</label><input v-model.trim="customRuleDraft.name" maxlength="30" placeholder="例如：软件工具" /></div><div class="field"><label>匹配关键词</label><input v-model="customRuleDraft.keywords" placeholder="软件，安装包，Windows" /><small>用逗号分隔，自动识别按顺序优先匹配。</small></div></div>
            <div class="setting-grid"><div class="field"><label>标题前缀</label><input v-model="customRuleDraft.titlePrefix" maxlength="20" placeholder="求" /></div><div class="field"><label>标题后缀</label><input v-model="customRuleDraft.titleSuffix" maxlength="30" placeholder="网盘链接获取" /></div></div>
            <div class="field"><label>简介核心说明</label><textarea v-model="customRuleDraft.introTemplate" maxlength="800" placeholder="说明这类素材通常包含什么、适用场景、使用注意事项和适合人群。可使用 {资源名称} 代入文件名。"></textarea><small>程序会围绕这段说明补全为180～220字，并自动保持HTML回答格式。</small></div>
            <label class="global-check"><input v-model="customRuleDraft.enabled" type="checkbox" /><span><strong>立即启用这条规则</strong><small>关闭后仍保留配置，但不会参与自动识别和导入选择</small></span></label>
            <div class="custom-rule-editor-actions"><button class="secondary-button" @click="customRuleEditorOpen = false; resetCustomRuleDraft()">取消</button><button class="primary-button" @click="saveCustomRuleDraft">保存到规则库</button></div>
          </div>
        </div>

        <div v-else-if="settingsTab === 'automation'" class="global-setting-panel">
          <div class="field">
            <div class="field-label-row">
              <label>API密钥</label>
              <button type="button" class="key-guide-link" @click="openApiKeyGuide">没有密钥？点击获取</button>
            </div>
            <input v-model="settings.apiKey" type="password" placeholder="请输入API密钥" />
            <small>与“AI生成”中的API密钥为同一项配置，任意一处修改都会同步生效。</small>
          </div>
          <div v-if="settings.configurableApiBase" class="field">
            <label>API Base URL</label>
            <input v-model.trim="settings.baseUrl" type="url" placeholder="https://example.com/v1" />
            <small>与“AI生成”共用同一个 OpenAI 兼容接口地址，修改后会同步生效。</small>
          </div>
          <div v-if="settings.configurableApiBase && !settings.license?.valid" class="field">
            <label>接口版本授权</label>
            <input v-model.trim="licenseKey" placeholder="请输入授权码" />
            <small>激活后才可使用自定义 API Base URL。</small>
            <button class="test-button" :disabled="licenseBusy || !licenseKey" @click="activateLicense">激活授权</button>
          </div>
          <div class="settings-section-title"><strong>自动化答题模型</strong><span>单独用于百度知道回答生成，不影响格式转换任务</span></div>
          <div class="field">
            <label>答题专用模型名称</label>
            <input v-model.trim="settings.answerModel" placeholder="请输入模型ID" />
            <small>默认使用gpt-5.6-sol。建议选择理解、推理和中文表达能力较强的模型。</small>
            <button type="button" class="model-library-link" @click="openModelLibrary">查找高质量模型 →</button>
          </div>
          <div class="field title-prompt-field">
            <div class="field-label-row"><label>答题系统提示词</label><button type="button" class="key-guide-link" @click="resetAnswerPrompt">恢复默认</button></div>
            <textarea v-model="settings.answerPrompt" data-answer-prompt="true" maxlength="4000" placeholder="请输入自动化答题使用的系统提示词"></textarea>
            <small>修改后仅影响新启动的答题任务。段落标签仍会在提交前自动清理；清空保存会恢复默认提示词。</small>
          </div>
          <div class="automation-model-note"><i>AI</i><p><strong>为什么单独配置？</strong><span>格式转换更侧重速度和批量成本，自动答题更重视问题理解、逻辑连贯和自然表达，因此可以分别选择不同模型。</span></p></div>
          <div class="drawer-note general-note"><svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.7 2.9 8.4 7 10 4.1-1.6 7-5.3 7-10V6l-7-3Z"/></svg><p><strong>接口配置已同步</strong><span>{{ settings.configurableApiBase ? "自动答题与AI生成共用 API 密钥和 Base URL，无需分别维护。" : "自动答题与AI生成共用 API 密钥和固定服务地址，无需分别维护。" }}</span></p></div>
          <button class="test-button" :disabled="busy" @click="testApi">测试接口连接</button>
        </div>

        <div v-else-if="settingsTab === 'netdisk'" class="global-setting-panel">
          <div class="settings-section-title"><strong>批量转存默认值</strong><span>进入网盘批处理时自动带入，页面内仍可临时修改</span></div>
          <div class="field"><label>默认保存目录</label><input v-model.trim="settings.netdiskTransferDestination" placeholder="网盘批量转存" /></div>
          <div class="setting-grid">
            <div class="field"><label>转存方式</label><select v-model.number="settings.netdiskTransferConcurrency"><option :value="1">串行处理（推荐）</option></select><small>按参考项目方式逐条转存，降低分享验证接口触发风控的概率。</small></div>
            <div class="field"><label>分享并发</label><select v-model.number="settings.netdiskShareConcurrency"><option v-for="value in 10" :key="value" :value="value">{{ value }} 条{{ value === 5 ? "（推荐）" : "" }}</option></select><small>推荐5条，最高10条；出现访问频繁时请降低并发。</small></div>
          </div>
          <label class="global-check"><input v-model="settings.netdiskSeparateFolders" type="checkbox" /><span><strong>每条链接单独建立文件夹</strong><small>默认按 0001、0002 创建子目录</small></span></label>
          <label class="global-check"><input v-model="settings.netdiskAutoShare" type="checkbox" /><span><strong>转存成功后自动分享</strong><small>作为新转存任务的默认状态</small></span></label>

          <div class="settings-section-title divided"><strong>分享链接默认值</strong><span>用于转存后自动分享和批量分享</span></div>
          <div class="setting-grid">
            <div class="field"><label>默认有效期</label><select v-model.number="settings.netdiskSharePeriod"><option :value="1">1 天</option><option :value="7">7 天</option><option :value="30">30 天</option><option :value="0">永久</option></select></div>
            <div class="field"><label>提取码方式</label><select v-model="settings.netdiskRandomPassword"><option :value="true">随机提取码</option><option :value="false">固定提取码</option></select></div>
          </div>
          <div v-if="!settings.netdiskRandomPassword" class="field"><label>默认固定提取码</label><input v-model.trim="settings.netdiskFixedPassword" maxlength="4" placeholder="4位字母或数字" /></div>

          <div class="settings-section-title divided"><strong>目录读取限制</strong><span>数值越大，读取大型目录耗时越长</span></div>
          <div class="setting-grid">
            <div class="field"><label>最大递归层级</label><select v-model.number="settings.netdiskMaxDepth"><option v-for="value in 20" :key="value" :value="value">{{ value }} 层</option></select></div>
            <div class="field"><label>单次读取上限</label><select v-model.number="settings.netdiskMaxItems"><option :value="500">500 项</option><option :value="1000">1000 项</option><option :value="3000">3000 项</option><option :value="5000">5000 项</option><option :value="10000">10000 项</option><option :value="20000">20000 项（推荐）</option><option :value="50000">50000 项</option></select></div>
          </div>
        </div>

        <div v-else class="global-setting-panel">
          <div class="settings-section-title"><strong>启动偏好</strong><span>设置每次打开客户端后默认显示的功能</span></div>
          <div class="startup-options">
            <label :class="{ active: settings.startPage === 'qa' }"><input v-model="settings.startPage" type="radio" value="qa" /><strong>格式转换AI版</strong><span>Excel 转问答与任务管理</span></label>
            <label :class="{ active: settings.startPage === 'netdisk' }"><input v-model="settings.startPage" type="radio" value="netdisk" /><strong>网盘批处理</strong><span>批量转存与批量分享</span></label>
          </div>
          <div class="drawer-note general-note"><svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.7 2.9 8.4 7 10 4.1-1.6 7-5.3 7-10V6l-7-3Z"/></svg><p><strong>本地优先</strong><span>全局配置和任务记录均保存在当前电脑。API密钥与百度网盘Cookie使用Windows系统加密。</span></p></div>
          <div class="settings-section-title divided"><strong>软件更新</strong><span>启动时自动检测，也可以在这里手动检查</span></div>
          <div class="update-card">
            <div><strong>当前版本 {{ updateState.currentVersion || '—' }}</strong><span v-if="updateState.availableVersion && updateState.status !== 'up-to-date'">发现新版本 {{ updateState.availableVersion }}</span><span v-else-if="updateState.status === 'up-to-date'">已是最新版本</span><span v-else-if="updateState.status === 'development'">开发模式不执行更新</span><span v-else>尚未检查更新</span></div>
            <button v-if="updateState.status === 'available'" :disabled="updateBusy" @click="downloadAppUpdate">下载更新</button><button v-else-if="updateState.status === 'downloaded'" @click="installAppUpdate">重启并安装</button><button v-else :disabled="updateBusy" @click="checkAppUpdate">{{ updateState.status === 'checking' ? '检查中…' : '检查更新' }}</button>
          </div>
          <div v-if="updateState.status === 'downloading'" class="update-progress"><i :style="{ width: `${updateState.percent}%` }"></i><span>{{ updateState.percent ? `${updateState.percent}%` : '下载中…' }}</span></div>
          <p v-if="updateState.error" class="update-error">{{ updateState.error }}</p><p v-if="updateState.notes" class="update-notes">{{ updateState.notes }}</p>
        </div>

        <div class="drawer-note">
          <svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.7 2.9 8.4 7 10 4.1-1.6 7-5.3 7-10V6l-7-3Z"/></svg>
          <p><strong>配置生效范围</strong><span>新任务使用最新全局默认值；页面内修改只影响本次操作，不会覆盖全局配置。</span></p>
        </div>
        <button class="primary-button drawer-save" @click="saveSettings(true)">保存全局设置</button>
      </aside>
    </div>

    <div v-if="updateDialogOpen" class="drawer-backdrop update-dialog-backdrop">
      <section class="confirm-dialog update-dialog">
        <div class="update-dialog-icon">↑</div>
        <span class="section-kicker">SOFTWARE UPDATE</span>
        <h2>发现新版本 {{ updateState.availableVersion }}</h2>
        <p>当前版本 {{ updateState.currentVersion }}，建议更新后继续使用。</p>
        <div v-if="updateState.notes" class="update-dialog-notes">{{ updateState.notes }}</div>
        <div v-if="updateState.status === 'downloading'" class="update-progress"><i :style="{ width: `${updateState.percent}%` }"></i><span>{{ updateState.percent ? `正在下载 ${updateState.percent}%` : '正在下载…' }}</span></div>
        <p v-if="updateState.error" class="update-error">{{ updateState.error }}</p>
        <div class="confirm-actions">
          <button v-if="updateState.status !== 'downloading'" class="secondary-button" @click="dismissUpdateDialog">稍后提醒</button>
          <button v-if="updateState.status === 'downloaded'" class="primary-button" @click="installAppUpdate">重启并安装</button>
          <button v-else class="primary-button" :disabled="updateBusy || updateState.status === 'downloading'" @click="downloadAppUpdate">{{ updateState.status === 'downloading' ? '正在下载…' : '立即更新' }}</button>
        </div>
      </section>
    </div>

    <transition name="toast">
      <div v-if="notice.show" class="toast-message" :class="notice.type">
        <span>{{ notice.type === "error" ? "!" : "✓" }}</span>{{ notice.text }}
      </div>
    </transition>
  </div>
</template>
