<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

const bridge = window.wangpanAPI;
const MAX_TRANSFER_LINKS = 1000;
const SHARE_BATCH_SIZE = 1000;
const MAX_SHARE_ITEMS = 5000;
const props = defineProps({ globalSettings: { type: Object, default: () => ({}) } });
const emit = defineEmits(["send-to-format"]);
const activeTab = ref("transfer");
const sharePage = ref(1);
const SHARE_PAGE_SIZE = 100;
const account = reactive({
  accounts: [],
  selectedAccountId: "default",
  newAccountName: "",
  adding: false,
  cookie: "",
  hasCookie: false,
  verified: false,
  uk: "",
  busy: false,
  manualOpen: false,
});
const notice = reactive({ text: "", type: "success" });
const transfer = reactive({
  raw: "", destination: "网盘批量转存", separateFolders: false, concurrency: 1,
  autoShare: false, sharePeriod: 0, randomSharePassword: false, sharePassword: "6666",
  importFileName: "", importedItems: [],
  running: false, paused: false, showResults: false, exporting: false, importing: false, rows: [], completed: 0,
});
const share = reactive({
  folder: "网盘批量转存", files: [], selected: [], period: 0, randomPassword: false,
  password: "6666", concurrency: 5, loading: false, running: false, paused: false,
  scope: "both", folderItem: null, typeFilter: "all", truncated: false, rows: [], completed: 0, exporting: false,
  history: [], historyBusy: false, maxDepth: 10, maxItems: 20000,
  scanRequestId: "", scannedDirectories: 0, queuedDirectories: 0, foundItems: 0,
});
const folderPicker = reactive({ open: false, loading: false, path: "/", items: [], currentItem: null, trail: [] });
let unsubscribe;
let unsubscribeDirectoryProgress;
let noticeTimer;
let workspaceSaveTimer;
let workspaceSaveInFlight = false;
let workspaceSaveQueued = false;
let lastWorkspaceSavedAt = 0;
let workspaceRestored = false;
let transferDestinationLocked = false;
let transferRunMode = "full";
let shareRunMode = "full";

watch(() => [
  props.globalSettings.netdiskTransferDestination,
  props.globalSettings.netdiskSeparateFolders,
  props.globalSettings.netdiskTransferConcurrency,
  props.globalSettings.netdiskAutoShare,
  props.globalSettings.netdiskSharePeriod,
  props.globalSettings.netdiskRandomPassword,
  props.globalSettings.netdiskFixedPassword,
  props.globalSettings.netdiskShareConcurrency,
  props.globalSettings.netdiskMaxDepth,
  props.globalSettings.netdiskMaxItems,
], () => {
  if (!transfer.running) {
    if (!transferDestinationLocked) {
      transfer.destination = props.globalSettings.netdiskTransferDestination || "网盘批量转存";
    }
    transfer.separateFolders = Boolean(props.globalSettings.netdiskSeparateFolders);
    transfer.concurrency = 1;
    transfer.autoShare = Boolean(props.globalSettings.netdiskAutoShare);
    transfer.sharePeriod = Number(props.globalSettings.netdiskSharePeriod ?? 0);
    transfer.randomSharePassword = props.globalSettings.netdiskRandomPassword === true;
    transfer.sharePassword = props.globalSettings.netdiskFixedPassword || "6666";
  }
  if (!share.running) {
    share.period = Number(props.globalSettings.netdiskSharePeriod ?? 0);
    share.randomPassword = props.globalSettings.netdiskRandomPassword === true;
    share.password = props.globalSettings.netdiskFixedPassword || "6666";
    share.concurrency = Math.min(10, Number(props.globalSettings.netdiskShareConcurrency) || 2);
    share.maxDepth = Number(props.globalSettings.netdiskMaxDepth) || 10;
    share.maxItems = Number(props.globalSettings.netdiskMaxItems) || 20000;
  }
}, { immediate: true });

function workspaceSnapshot() {
  return {
    activeTab: activeTab.value,
    transfer: {
      raw: transfer.raw,
      importFileName: transfer.importFileName,
      importedItems: transfer.importedItems.map((item) => ({ raw: item.raw, customName: item.customName })),
      destination: transfer.destination,
      separateFolders: transfer.separateFolders,
      concurrency: transfer.concurrency,
      autoShare: transfer.autoShare,
      sharePeriod: transfer.sharePeriod,
      randomSharePassword: transfer.randomSharePassword,
      sharePassword: transfer.sharePassword,
      showResults: transfer.showResults,
      completed: transfer.completed,
      rows: transfer.rows.map((row) => ({
        index: row.index, source: row.source, customName: row.customName, status: row.status, names: Array.isArray(row.names) ? [...row.names] : [],
        destination: row.destination, shareLink: row.shareLink, password: row.password,
        shareStatus: row.shareStatus, shareError: row.shareError,
        savedFsIds: Array.isArray(row.savedFsIds) ? [...row.savedFsIds] : [],
        savedPaths: Array.isArray(row.savedPaths) ? [...row.savedPaths] : [],
        error: row.error,
      })),
    },
    share: {
      folder: share.folder,
      scope: share.scope,
      period: share.period,
      randomPassword: share.randomPassword,
      password: share.password,
      concurrency: share.concurrency,
      typeFilter: share.typeFilter,
      completed: share.completed,
      history: share.history.map((row) => ({
        fsId: row.fsId, name: row.name, path: row.path, isDir: row.isDir, shareLink: row.shareLink,
        password: row.password, sharedAt: row.sharedAt,
      })),
      rows: share.rows.map((row) => ({
        index: row.index, fsId: row.fsId, name: row.name, path: row.path, isDir: row.isDir, size: row.size,
        depth: row.depth, relativePath: row.relativePath, parentPath: row.parentPath, status: row.status,
        shareLink: row.shareLink, password: row.password, error: row.error,
      })),
    },
  };
}

async function saveWorkspaceNow() {
  if (!workspaceRestored || typeof bridge.saveBaiduWorkspace !== "function") return;
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = undefined;
  if (workspaceSaveInFlight) {
    workspaceSaveQueued = true;
    return;
  }
  workspaceSaveInFlight = true;
  try {
    await bridge.saveBaiduWorkspace(accountPayload(workspaceSnapshot()));
    lastWorkspaceSavedAt = Date.now();
  } catch { /* Keep UI work available in memory. */ }
  finally {
    workspaceSaveInFlight = false;
    if (workspaceSaveQueued) {
      workspaceSaveQueued = false;
      workspaceSaveTimer = setTimeout(saveWorkspaceNow, transfer.running || share.running ? 2000 : 0);
    }
  }
}

function scheduleWorkspaceSave() {
  if (!workspaceRestored) return;
  const isRunning = transfer.running || share.running;
  if (isRunning) {
    if (workspaceSaveInFlight) {
      workspaceSaveQueued = true;
      return;
    }
    if (workspaceSaveTimer) return;
    const delay = Math.max(0, 2000 - (Date.now() - lastWorkspaceSavedAt));
    workspaceSaveTimer = setTimeout(saveWorkspaceNow, delay);
    return;
  }
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = setTimeout(saveWorkspaceNow, 500);
}

function restoreInterruptedRows(rows, type) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (row.status !== "running" && row.status !== "pending") return { ...row };
    return {
      ...row,
      status: "failed",
      error: row.error || (type === "transfer" ? "上次转存因客户端关闭而中断" : "上次分享因客户端关闭而中断"),
    };
  });
}

function resetWorkspaceState() {
  transfer.raw = "";
  transfer.importFileName = "";
  transfer.importedItems = [];
  transfer.rows = [];
  transfer.completed = 0;
  transfer.showResults = false;
  transfer.running = false;
  transfer.paused = false;
  transfer.exporting = false;
  transfer.importing = false;
  share.files = [];
  share.selected = [];
  share.rows = [];
  share.completed = 0;
  share.history = [];
  share.truncated = false;
  share.loading = false;
  share.running = false;
  share.paused = false;
  share.exporting = false;
  share.historyBusy = false;
}

async function restoreWorkspace() {
  if (typeof bridge.getBaiduWorkspace !== "function") return;
  const saved = await bridge.getBaiduWorkspace(accountPayload());
  if (!saved) return;
  activeTab.value = saved.activeTab === "share" ? "share" : "transfer";
  if (saved.transfer) {
    if (Object.hasOwn(saved.transfer, "destination")) transferDestinationLocked = true;
    const rows = restoreInterruptedRows(saved.transfer.rows, "transfer");
    Object.assign(transfer, saved.transfer, { rows, running: false, paused: false, exporting: false, showResults: Boolean(rows.length && saved.transfer.showResults) });
  }
  if (saved.share) {
    const rows = restoreInterruptedRows(saved.share.rows, "share");
    Object.assign(share, saved.share, {
      rows,
      files: rows.map((row) => ({ ...row })),
      selected: [],
      running: false,
      paused: false,
      loading: false,
      exporting: false,
    });
  }
}

function rememberTransferDestination() {
  transferDestinationLocked = true;
}

watch([activeTab, transfer, share], scheduleWorkspaceSave, { deep: true });

const transferLines = computed(() => transfer.raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
const transferRequestItems = computed(() => {
  if (transfer.importedItems.length === transferLines.value.length
    && transfer.importedItems.every((item, index) => item.raw === transferLines.value[index])) {
    return transfer.importedItems.map((item) => ({ raw: item.raw, customName: item.customName }));
  }
  return transferLines.value.map((raw) => ({ raw, customName: "" }));
});
const transferLimitExceeded = computed(() => transferLines.value.length > MAX_TRANSFER_LINKS);
const transferBatchCount = computed(() => Math.ceil(transferLines.value.length / MAX_TRANSFER_LINKS));
const transferStats = computed(() => ({
  total: transfer.rows.length,
  success: transfer.rows.filter((row) => row.status === "completed").length,
  failed: transfer.rows.filter((row) => row.status === "failed").length,
  pending: transfer.rows.filter((row) => row.status === "pending" || row.status === "running").length,
}));
const failedTransferRows = computed(() => transfer.rows.filter((row) => row.status === "failed"));
const failedTransferShareRows = computed(() => transfer.rows.filter((row) => row.status === "completed" && row.shareError));
const transferExportRows = computed(() => transfer.rows
  .filter((row) => row.shareLink)
  .map((row) => ({ name: row.customName || row.names?.join("、") || `资源${row.index + 1}`, link: row.shareLink })));
const shareStats = computed(() => ({
  total: share.rows.length,
  success: share.rows.filter((row) => row.status === "completed").length,
  failed: share.rows.filter((row) => row.status === "failed").length,
  pending: share.rows.filter((row) => row.status === "pending" || row.status === "running").length,
}));
const failedShareRows = computed(() => share.rows.filter((row) => row.status === "failed"));
const shareExportRows = computed(() => share.rows
  .filter((row) => row.status === "completed" && row.shareLink)
  .map((row, index) => ({ name: row.name || `资源${index + 1}`, link: row.shareLink })));
const visibleShareFiles = computed(() => share.files.filter((item) => (
  share.typeFilter === "all"
  || (share.typeFilter === "folder" && item.isDir)
  || (share.typeFilter === "file" && !item.isDir)
)));
const sharedShareIds = computed(() => new Set([
  ...share.history.map((row) => String(row.fsId)),
  ...share.rows.filter((row) => row.status === "completed" && row.shareLink).map((row) => String(row.fsId)),
]));
const unsharedShareFiles = computed(() => share.files.filter((item) => !sharedShareIds.value.has(String(item.fsId))));
const currentSharedCount = computed(() => share.files.length - unsharedShareFiles.value.length);
const visibleShareIds = computed(() => visibleShareFiles.value.filter((item) => !sharedShareIds.value.has(String(item.fsId))).map((item) => item.fsId));
const sharePageCount = computed(() => Math.max(1, Math.ceil(visibleShareFiles.value.length / SHARE_PAGE_SIZE)));
const pagedShareFiles = computed(() => visibleShareFiles.value.slice((sharePage.value - 1) * SHARE_PAGE_SIZE, sharePage.value * SHARE_PAGE_SIZE));
const allFilesSelected = computed(() => (
  visibleShareIds.value.length > 0
  && visibleShareIds.value.every((id) => share.selected.includes(id))
));
const allShareContentSelected = computed(() => (
  unsharedShareFiles.value.length > 0
  && unsharedShareFiles.value.slice(0, MAX_SHARE_ITEMS).every((item) => share.selected.includes(item.fsId))
));
const shareLimitExceeded = computed(() => share.selected.length > MAX_SHARE_ITEMS);
const shareBatchCount = computed(() => Math.ceil(share.selected.length / SHARE_BATCH_SIZE));
const shareRowsByFsId = computed(() => {
  const rows = new Map(share.history.map((row) => [String(row.fsId), { ...row, status: "completed" }]));
  for (const row of share.rows) rows.set(String(row.fsId), row);
  return rows;
});
const selectedAccount = computed(() => account.accounts.find((item) => item.id === account.selectedAccountId) || null);

function accountPayload(extra = {}) {
  return { accountId: account.selectedAccountId, ...extra };
}

function applySelectedAccountState() {
  const selected = selectedAccount.value;
  account.hasCookie = Boolean(selected?.hasCookie);
  account.verified = Boolean(selected?.hasCookie && selected?.uk);
  account.uk = selected?.uk || "";
  account.cookie = "";
}

watch(() => share.typeFilter, () => { sharePage.value = 1; });
watch(() => share.files.length, () => { sharePage.value = 1; });
watch(sharePageCount, (count) => { if (sharePage.value > count) sharePage.value = count; });

function clearTransferResults() {
  transfer.rows = [];
  transfer.completed = 0;
  transfer.showResults = false;
}

function handleTransferLinksInput() {
  transfer.importFileName = "";
  transfer.importedItems = [];
  if (!transfer.running && transfer.rows.length) clearTransferResults();
}

async function importTransferExcel() {
  if (transfer.running || transfer.importing) return;
  transfer.importing = true;
  try {
    const filePath = await bridge.chooseExcel();
    if (!filePath) return;
    const source = await bridge.analyzeExcel(filePath);
    if (!source.rows?.length) throw new Error("表格中没有可导入的有效名称和网盘链接");
    if (source.rows.length > MAX_TRANSFER_LINKS) {
      throw new Error(`表格包含 ${source.rows.length} 条有效数据，单次最多导入 ${MAX_TRANSFER_LINKS} 条`);
    }
    const items = source.rows.map((row) => ({ raw: row.link, customName: row.name }));
    transfer.importFileName = source.fileName || "已导入Excel";
    transfer.importedItems = items;
    transfer.raw = items.map((item) => item.raw).join("\n");
    clearTransferResults();
    const skipped = Number(source.invalidRows) || 0;
    showNotice(skipped
      ? `已导入 ${items.length} 条，另有 ${skipped} 条格式错误未导入`
      : `已导入 ${items.length} 条名称和网盘链接`, skipped ? "warning" : "success");
  } catch (error) {
    const message = error.message || String(error);
    failUnfinishedRows(transfer, message);
    showNotice(message, "error");
  } finally {
    transfer.importing = false;
  }
}

async function splitTransferBatch() {
  if (transfer.running || !transferLimitExceeded.value) return;
  const current = transferLines.value.slice(0, MAX_TRANSFER_LINKS);
  const remaining = transferLines.value.slice(MAX_TRANSFER_LINKS);
  await bridge.copyText(remaining.join("\n"));
  transfer.raw = current.join("\n");
  clearTransferResults();
  showNotice(`已保留前 ${MAX_TRANSFER_LINKS} 条，剩余 ${remaining.length} 条已复制到剪贴板`);
}

function showNotice(text, type = "success") {
  clearTimeout(noticeTimer);
  notice.text = text;
  notice.type = type;
  noticeTimer = setTimeout(() => { notice.text = ""; }, 3600);
}

async function loadAccounts({ verify = false } = {}) {
  const result = typeof bridge.listBaiduAccounts === "function"
    ? await bridge.listBaiduAccounts()
    : await bridge.getBaiduAccount();
  account.accounts = result.accounts || [{ id: "default", name: "默认账号", hasCookie: Boolean(result.hasCookie), uk: result.uk || "" }];
  account.selectedAccountId = result.selectedAccountId || account.accounts[0]?.id || "default";
  applySelectedAccountState();
  if (verify && account.hasCookie) {
    try {
      const verified = await bridge.testBaiduAccount(accountPayload());
      const selected = selectedAccount.value;
      if (selected) {
        selected.uk = verified.uk;
        selected.hasCookie = true;
      }
      account.verified = true;
      account.uk = verified.uk;
    } catch { account.verified = false; }
  }
}

async function switchAccount() {
  if (transfer.running || share.running) return;
  account.busy = true;
  try {
    await saveWorkspaceNow();
    if (typeof bridge.selectBaiduAccount === "function") {
      await bridge.selectBaiduAccount(account.selectedAccountId);
    }
    applySelectedAccountState();
    workspaceRestored = false;
    resetWorkspaceState();
    await restoreWorkspace();
    workspaceRestored = true;
  } catch (error) {
    showNotice(error.message || String(error), "error");
  } finally {
    workspaceRestored = true;
    account.busy = false;
  }
}

async function createAccount() {
  const name = account.newAccountName.trim();
  if (!name || account.busy) return;
  account.busy = true;
  try {
    const result = await bridge.createBaiduAccount(name);
    account.accounts = result.accounts || [];
    account.selectedAccountId = result.selectedAccountId || account.accounts.at(-1)?.id || "default";
    account.newAccountName = "";
    account.adding = false;
    applySelectedAccountState();
    workspaceRestored = false;
    resetWorkspaceState();
    await restoreWorkspace();
    showNotice(`已创建网盘账号“${selectedAccount.value?.name || name}”`);
  } catch (error) {
    showNotice(error.message || String(error), "error");
  } finally {
    workspaceRestored = true;
    account.busy = false;
  }
}

async function deleteCurrentAccount() {
  const current = selectedAccount.value;
  if (!current || current.id === "default" || account.busy) return;
  if (!window.confirm(`确定删除网盘账号“${current.name}”吗？该账号的本地 Cookie 会一并清除。`)) return;
  account.busy = true;
  try {
    const result = await bridge.deleteBaiduAccount(current.id);
    account.accounts = result.accounts || [];
    account.selectedAccountId = result.selectedAccountId || "default";
    applySelectedAccountState();
    workspaceRestored = false;
    resetWorkspaceState();
    await restoreWorkspace();
    showNotice("已删除网盘账号");
  } catch (error) {
    showNotice(error.message || String(error), "error");
  } finally {
    workspaceRestored = true;
    account.busy = false;
  }
}

async function saveAndVerifyAccount() {
  if (account.busy) return;
  account.busy = true;
  try {
    if (account.cookie.trim()) {
      const saved = await bridge.saveBaiduAccount(accountPayload({ cookie: account.cookie.trim() }));
      account.hasCookie = saved.hasCookie;
    }
    const result = await bridge.testBaiduAccount(accountPayload({ cookie: account.cookie.trim() }));
    const selected = selectedAccount.value;
    if (selected) {
      selected.hasCookie = true;
      selected.uk = result.uk;
    }
    account.verified = true;
    account.uk = result.uk;
    account.cookie = "";
    account.manualOpen = false;
    showNotice("百度网盘账号验证成功");
  } catch (error) {
    account.verified = false;
    showNotice(error.message || String(error), "error");
  } finally {
    account.busy = false;
  }
}

async function loginBaiduAccount() {
  if (account.busy) return;
  account.busy = true;
  try {
    const result = await bridge.loginBaiduAccount(accountPayload());
    if (result?.ok) {
      const selected = selectedAccount.value;
      if (selected) {
        selected.hasCookie = true;
        selected.uk = result.uk;
      }
      account.hasCookie = true;
      account.verified = true;
      account.uk = result.uk;
      account.cookie = "";
      showNotice("百度网盘登录成功");
    }
  } catch (error) { showNotice(error.message || String(error), "error"); }
  finally { account.busy = false; }
}

async function clearAccount() {
  try {
    await bridge.saveBaiduAccount(accountPayload({ cookie: "" }));
    const selected = selectedAccount.value;
    if (selected) {
      selected.hasCookie = false;
      selected.uk = "";
    }
    Object.assign(account, { cookie: "", hasCookie: false, verified: false, uk: "" });
    account.manualOpen = false;
    showNotice("已清除本机保存的百度网盘登录信息");
  } catch (error) { showNotice(error.message || String(error), "error"); }
}

async function startTransfer() {
  if (transfer.running) return;
  if (!account.hasCookie) return showNotice("请先保存并验证百度网盘 Cookie", "error");
  if (!transferLines.value.length) return showNotice("请粘贴要转存的百度网盘链接", "error");
  if (transferLimitExceeded.value) {
    return showNotice(`单次最多转存 ${MAX_TRANSFER_LINKS} 条，当前共 ${transferLines.value.length} 条，请拆分后再执行`, "error");
  }
  if (transfer.autoShare && !transfer.randomSharePassword && !/^[a-zA-Z0-9]{4}$/.test(transfer.sharePassword)) {
    return showNotice("固定提取码必须为4位字母或数字", "error");
  }
  const requestItems = transferRequestItems.value;
  transfer.rows = requestItems.map((item, index) => ({ index, source: item.raw, customName: item.customName, status: "pending" }));
  transfer.completed = 0;
  transfer.showResults = true;
  transfer.running = true;
  transfer.paused = false;
  transferRunMode = "full";
  try {
    await bridge.runBaiduTransfer({
      accountId: account.selectedAccountId,
      items: requestItems,
      destination: transfer.destination,
      separateFolders: transfer.separateFolders,
      concurrency: transfer.concurrency,
      autoShare: transfer.autoShare,
      sharePeriod: transfer.sharePeriod,
      randomSharePassword: transfer.randomSharePassword,
      sharePassword: transfer.sharePassword,
    });
  } catch (error) {
    const message = error.message || String(error);
    failUnfinishedRows(transfer, message);
    showNotice(message, "error");
  } finally {
    transfer.running = false;
    transfer.paused = false;
  }
}

async function retryFailedTransfers() {
  if (transfer.running || !failedTransferRows.value.length) return;
  if (!account.hasCookie) return showNotice("请先保存并验证百度网盘 Cookie", "error");
  if (transfer.autoShare && !transfer.randomSharePassword && !/^[a-zA-Z0-9]{4}$/.test(transfer.sharePassword)) {
    return showNotice("固定提取码必须为4位字母或数字", "error");
  }
  const items = transfer.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.status === "failed")
    .map(({ row, index }) => ({ raw: row.source, customName: row.customName, resultIndex: index }));
  for (const item of items) {
    Object.assign(transfer.rows[item.resultIndex], {
      status: "pending", error: "", names: [], destination: "", shareLink: "", password: "",
      shareStatus: "", shareError: "", savedFsIds: [], savedPaths: [],
    });
  }
  transferRunMode = "retry-transfer";
  transfer.showResults = true;
  transfer.running = true;
  transfer.paused = false;
  try {
    await bridge.runBaiduTransfer({
      accountId: account.selectedAccountId,
      items,
      destination: transfer.destination,
      separateFolders: transfer.separateFolders,
      concurrency: transfer.concurrency,
      autoShare: transfer.autoShare,
      sharePeriod: transfer.sharePeriod,
      randomSharePassword: transfer.randomSharePassword,
      sharePassword: transfer.sharePassword,
    });
  } catch (error) {
    const message = error.message || String(error);
    failUnfinishedRows(transfer, message);
    showNotice(message, "error");
  } finally {
    transfer.running = false;
    transfer.paused = false;
    transferRunMode = "full";
  }
}

async function retryFailedTransferShares() {
  if (transfer.running || !failedTransferShareRows.value.length) return;
  if (!account.hasCookie) return showNotice("请先保存并验证百度网盘 Cookie", "error");
  if (!transfer.randomSharePassword && !/^[a-zA-Z0-9]{4}$/.test(transfer.sharePassword)) {
    return showNotice("固定提取码必须为4位字母或数字", "error");
  }
  const items = transfer.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.status === "completed" && row.shareError)
    .map(({ row, index }) => ({
      resultIndex: index,
      source: row.source,
      customName: row.customName,
      destination: row.destination,
      names: Array.isArray(row.names) ? [...row.names] : [],
      savedFsIds: Array.isArray(row.savedFsIds) ? [...row.savedFsIds] : [],
      savedPaths: Array.isArray(row.savedPaths) ? [...row.savedPaths] : [],
    }));
  for (const item of items) {
    Object.assign(transfer.rows[item.resultIndex], { shareStatus: "pending", shareError: "" });
  }
  transferRunMode = "retry-share";
  transfer.showResults = true;
  transfer.running = true;
  transfer.paused = false;
  try {
    await bridge.retryBaiduTransferShares({
      accountId: account.selectedAccountId,
      items,
      sharePeriod: transfer.sharePeriod,
      randomSharePassword: transfer.randomSharePassword,
      sharePassword: transfer.sharePassword,
    });
  } catch (error) {
    const message = error.message || String(error);
    failUnfinishedTransferShares(message);
    showNotice(message, "error");
  } finally {
    transfer.running = false;
    transfer.paused = false;
    transferRunMode = "full";
  }
}

function archiveSuccessfulShares() {
  const byFsId = new Map(share.history.map((row) => [String(row.fsId), row]));
  for (const row of share.rows) {
    if (row.status !== "completed" || !row.shareLink || !row.fsId) continue;
    byFsId.set(String(row.fsId), {
      fsId: String(row.fsId), name: String(row.name || ""), path: String(row.path || ""),
      isDir: Boolean(row.isDir), shareLink: String(row.shareLink), password: String(row.password || ""),
      sharedAt: new Date().toISOString(), status: "completed",
    });
  }
  share.history = [...byFsId.values()].slice(-50000);
}

function clearShareResults({ clearFiles = false } = {}) {
  archiveSuccessfulShares();
  share.rows = [];
  share.completed = 0;
  share.selected = [];
  share.truncated = false;
  if (clearFiles) share.files = [];
}

function cancelShareDirectoryRead() {
  share.scanRequestId = "";
  share.loading = false;
  bridge.cancelBaiduDirectory?.({ purpose: "share-scan" }).catch(() => {});
}

function handleShareScopeChange() {
  cancelShareDirectoryRead();
  clearShareResults({ clearFiles: true });
}

async function loadShareDirectory() {
  if (share.loading || share.running) return;
  if (!account.hasCookie) return showNotice("请先保存并验证百度网盘 Cookie", "error");
  clearShareResults({ clearFiles: true });
  share.scannedDirectories = 0;
  share.queuedDirectories = 0;
  share.foundItems = 0;
  share.loading = true;
  const requestId = `share-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  share.scanRequestId = requestId;
  try {
    if (share.scope === "current") {
      if (!share.folderItem?.fsId) return showNotice("根目录本身不能直接分享，请选择一个具体文件夹", "warning");
      share.files = [{ ...share.folderItem, depth: 0, relativePath: share.folderItem.name }];
      share.truncated = false;
      share.selected = [];
      showNotice(currentSharedCount.value ? "已载入所选目录，该目录已存在分享记录" : "已载入所选目录，可在下方勾选后生成分享链接");
      return;
    }
    const result = await bridge.listBaiduDirectory({
      accountId: account.selectedAccountId,
      folder: share.folder,
      recursive: ["folders", "files", "both"].includes(share.scope),
      maxDepth: share.maxDepth,
      maxItems: share.maxItems,
      concurrency: 4,
      purpose: "share-scan",
      requestId,
    });
    if (share.scanRequestId !== requestId) return;
    const items = result.items || [];
    const selectedBeforeComplete = new Set(share.selected);
    share.files = items.filter((item) => (
      share.scope === "both"
      || (share.scope === "level-folders" && item.isDir)
      || (share.scope === "folders" && item.isDir)
      || (share.scope === "files" && !item.isDir)
    ));
    share.truncated = Boolean(result.truncated);
    share.selected = share.files.filter((item) => selectedBeforeComplete.has(item.fsId)).map((item) => item.fsId);
    const historyMessage = currentSharedCount.value ? `，识别到 ${currentSharedCount.value} 个已分享项目` : "";
    showNotice(`已读取 ${share.files.length} 个文件或文件夹${historyMessage}${share.truncated ? `，已达到${share.maxItems}项读取上限` : ""}`, share.truncated ? "warning" : "success");
  } catch (error) {
    if (share.scanRequestId === requestId && !String(error?.message || error).includes("目录读取已取消")) {
      showNotice(error.message || String(error), "error");
    }
  } finally {
    if (share.scanRequestId === requestId) {
      share.loading = false;
      share.scanRequestId = "";
    }
  }
}

function normalizePickerPath(value) {
  const path = `/${String(value || "").replace(/\\/g, "/")}`.replace(/\/+/g, "/");
  return path.length > 1 ? path.replace(/\/$/, "") : "/";
}

function pickerParentPath() {
  if (folderPicker.path === "/") return "/";
  const parts = folderPicker.path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

async function loadPickerFolder(path, currentItem = null) {
  if (folderPicker.loading) return;
  folderPicker.loading = true;
  try {
    const normalized = normalizePickerPath(path);
    const result = await bridge.listBaiduDirectory(accountPayload({ folder: normalized, recursive: false, maxDepth: 1, purpose: "folder-picker" }));
    folderPicker.path = normalized;
    folderPicker.currentItem = currentItem;
    folderPicker.items = (result.items || []).filter((item) => item.isDir);
  } catch (error) { showNotice(error.message || String(error), "error"); }
  finally { folderPicker.loading = false; }
}

async function openFolderPicker() {
  if (share.running) return;
  if (!account.hasCookie) return showNotice("请先保存并验证百度网盘 Cookie", "error");
  folderPicker.open = true;
  folderPicker.trail = [];
  await loadPickerFolder("/", null);
}

async function enterPickerFolder(item) {
  folderPicker.trail.push(item);
  await loadPickerFolder(item.path, item);
}

async function goPickerParent() {
  folderPicker.trail.pop();
  await loadPickerFolder(pickerParentPath(), folderPicker.trail.at(-1) || null);
}

function choosePickerFolder() {
  const folderChanged = share.folder !== folderPicker.path;
  share.folder = folderPicker.path;
  share.folderItem = folderPicker.currentItem ? { ...folderPicker.currentItem } : null;
  if (folderChanged) {
    cancelShareDirectoryRead();
    clearShareResults({ clearFiles: true });
  }
  folderPicker.open = false;
}

function toggleAllFiles() {
  if (allFilesSelected.value) {
    share.selected = share.selected.filter((id) => !visibleShareIds.value.includes(id));
  } else {
    share.selected = [...new Set([...share.selected, ...visibleShareIds.value])];
  }
}

function toggleAllShareContent() {
  if (allShareContentSelected.value) {
    share.selected = [];
    return;
  }
  const selectable = unsharedShareFiles.value.slice(0, MAX_SHARE_ITEMS);
  share.selected = selectable.map((item) => item.fsId);
  showNotice(unsharedShareFiles.value.length > MAX_SHARE_ITEMS
    ? `已自动选择前 ${MAX_SHARE_ITEMS} 个未分享项目，完成后可继续选择剩余项目`
    : `已选择 ${selectable.length} 个未分享项目`);
}

function plainShareItem(item) {
  return {
    fsId: String(item?.fsId || ""),
    name: String(item?.name || ""),
    path: String(item?.path || ""),
    isDir: Boolean(item?.isDir),
    size: Number(item?.size) || 0,
    depth: Number(item?.depth) || 0,
    relativePath: String(item?.relativePath || item?.name || ""),
    parentPath: String(item?.parentPath || ""),
  };
}

async function startShare() {
  if (share.running) return;
  if (!account.hasCookie) return showNotice("请先保存并验证百度网盘 Cookie", "error");
  if (shareLimitExceeded.value) {
    return showNotice(`单次任务最多分享 ${MAX_SHARE_ITEMS} 项，当前已选择 ${share.selected.length} 项`, "error");
  }
  const items = share.files
    .filter((item) => share.selected.includes(item.fsId))
    .map(plainShareItem);
  if (!items.length) return showNotice("请至少选择一个要分享的文件或文件夹", "error");
  if (!share.randomPassword && !/^[a-zA-Z0-9]{4}$/.test(share.password)) return showNotice("固定提取码必须为4位字母或数字", "error");
  archiveSuccessfulShares();
  share.rows = items.map((item, index) => ({ index, ...item, status: "pending" }));
  share.completed = 0;
  share.running = true;
  share.paused = false;
  shareRunMode = "full";
  try {
    await bridge.runBaiduShare({
      accountId: account.selectedAccountId,
      items,
      period: share.period,
      randomPassword: share.randomPassword,
      password: share.password,
      concurrency: share.concurrency,
    });
  } catch (error) {
    const message = error.message || String(error);
    failUnfinishedRows(share, message);
    showNotice(message, "error");
  }
  finally { share.running = false; share.paused = false; }
}

async function retryFailedShares() {
  if (share.running || !failedShareRows.value.length) return;
  if (!account.hasCookie) return showNotice("请先保存并验证百度网盘 Cookie", "error");
  if (!share.randomPassword && !/^[a-zA-Z0-9]{4}$/.test(share.password)) {
    return showNotice("固定提取码必须为4位字母或数字", "error");
  }
  const items = share.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.status === "failed")
    .map(({ row, index }) => ({ ...plainShareItem(row), resultIndex: index }));
  for (const item of items) {
    Object.assign(share.rows[item.resultIndex], { status: "pending", error: "" });
  }
  shareRunMode = "retry";
  share.running = true;
  share.paused = false;
  try {
    await bridge.runBaiduShare({
      accountId: account.selectedAccountId,
      items,
      period: share.period,
      randomPassword: share.randomPassword,
      password: share.password,
      concurrency: share.concurrency,
    });
  } catch (error) {
    const message = error.message || String(error);
    failUnfinishedRows(share, message);
    showNotice(message, "error");
  } finally {
    share.running = false;
    share.paused = false;
    shareRunMode = "full";
  }
}

function keepAllowedShareItems() {
  if (share.running || !shareLimitExceeded.value) return;
  const removed = share.selected.length - MAX_SHARE_ITEMS;
  share.selected = share.selected.slice(0, MAX_SHARE_ITEMS);
  showNotice(`已保留前 ${MAX_SHARE_ITEMS} 项，取消选择其余 ${removed} 项`);
}

async function togglePause(type) {
  const target = type === "transfer" ? transfer : share;
  const action = target.paused ? "resume" : "pause";
  const result = await bridge.controlBaiduTask({ type, action });
  target.paused = result.paused;
}

async function stopTask(type) {
  await bridge.controlBaiduTask({ type, action: "stop" });
}

function failUnfinishedRows(target, message = "任务未能完成") {
  target.rows = target.rows.map((row) => (
    row.status === "pending" || row.status === "running"
      ? { ...row, status: "failed", error: row.error || message }
      : row
  ));
  target.completed = target.rows.filter((row) => row.status === "completed" || row.status === "failed").length;
}

function failUnfinishedTransferShares(message = "重新分享未能完成") {
  transfer.rows = transfer.rows.map((row) => (
    row.shareStatus === "pending" || row.shareStatus === "running"
      ? { ...row, status: "completed", shareStatus: "failed", shareError: row.shareError || message }
      : row
  ));
}

function applyNetdiskResult(type, result) {
  const target = type === "transfer" ? transfer : share;
  if (!result || !target.rows[result.index]) return;
  if (type === "transfer" && transferRunMode === "retry-share") {
    const current = target.rows[result.index];
    if (result.status === "failed") {
      target.rows[result.index] = { ...current, status: "completed", shareStatus: "failed", shareError: result.error || "重新分享失败" };
    } else {
      const { error, ...completedResult } = result;
      target.rows[result.index] = { ...current, ...completedResult, status: "completed", shareStatus: "completed", shareError: "" };
    }
  } else {
    target.rows[result.index] = { ...target.rows[result.index], ...result };
  }
}

function handleProgress(payload) {
  const target = payload.type === "transfer" ? transfer : share;
  if (payload.phase === "running" && target.rows[payload.index]) {
    if (payload.type === "transfer" && transferRunMode === "retry-share") target.rows[payload.index].shareStatus = "running";
    else target.rows[payload.index].status = "running";
  }
  if (payload.phase === "item" && payload.result) {
    applyNetdiskResult(payload.type, payload.result);
    target.completed = target.rows.filter((row) => row.status === "completed" || row.status === "failed").length;
  }
  if (payload.phase === "finished") {
    if (Array.isArray(payload.results)) payload.results.forEach((result) => applyNetdiskResult(payload.type, result));
    if (payload.type === "transfer" && transferRunMode === "retry-share") {
      failUnfinishedTransferShares("任务结束但未收到分享结果");
    } else {
      failUnfinishedRows(target, "任务结束但未收到处理结果");
    }
    if (payload.type === "share") {
      share.selected = share.selected.filter((id) => !sharedShareIds.value.has(String(id)));
    }
    target.running = false;
    target.paused = false;
    if (payload.type === "transfer" && transferRunMode === "retry-share") {
      showNotice(`分享重试完成：成功 ${payload.succeeded} 条，失败 ${payload.failed} 条`, payload.failed ? "warning" : "success");
    } else if (payload.type === "transfer" && transferRunMode === "retry-transfer") {
      showNotice(`转存重试完成：成功 ${payload.succeeded} 条，失败 ${payload.failed} 条`, payload.failed ? "warning" : "success");
    } else if (payload.type === "share" && shareRunMode === "retry") {
      showNotice(`分享重试完成：成功 ${payload.succeeded} 条，失败 ${payload.failed} 条`, payload.failed ? "warning" : "success");
    } else {
      showNotice(`处理完成：成功 ${payload.succeeded} 条，失败 ${payload.failed} 条`, payload.failed ? "warning" : "success");
    }
  }
}

async function copyValue(value, message = "已复制") {
  await bridge.copyText(value || "");
  showNotice(message);
}

async function copyShareResults() {
  const text = share.rows.filter((row) => row.shareLink).map((row) => `${row.name}\t${row.shareLink}`).join("\n");
  if (!text) return showNotice("暂无成功的分享结果", "error");
  await copyValue(text, `已复制 ${share.rows.filter((row) => row.shareLink).length} 条分享结果`);
}

async function copyFailedTransferLinks() {
  const text = failedTransferRows.value.map((row) => row.source).filter(Boolean).join("\n");
  if (!text) return showNotice("暂无转存失败的链接", "error");
  await copyValue(text, `已复制 ${failedTransferRows.value.length} 条失败链接`);
}

function sendResultsToFormat(rows, sourceType) {
  const plainRows = rows.map((row) => ({
    name: String(row?.name || ""),
    link: String(row?.link || ""),
  }));
  if (!plainRows.length) return showNotice("暂无可发送到格式转换的分享结果", "error");
  emit("send-to-format", { rows: plainRows, sourceType });
}

async function exportTransferResults() {
  if (!transferExportRows.value.length || transfer.exporting) return showNotice("暂无可导出的分享链接", "error");
  transfer.exporting = true;
  try {
    const result = await bridge.exportBaiduTransferResults({ rows: transferExportRows.value });
    if (result) showNotice(`已导出 ${result.count} 条转存分享结果`);
  } catch (error) { showNotice(error.message || String(error), "error"); }
  finally { transfer.exporting = false; }
}

async function exportShareResults() {
  if (!shareExportRows.value.length || share.exporting) return showNotice("暂无可导出的分享链接", "error");
  share.exporting = true;
  try {
    const rows = shareExportRows.value.map((row) => ({ name: String(row.name), link: String(row.link) }));
    const exportResults = typeof bridge.exportBaiduShareResults === "function"
      ? bridge.exportBaiduShareResults
      : bridge.exportBaiduTransferResults;
    if (typeof exportResults !== "function") throw new Error("导出接口尚未加载，请完全关闭并重新启动客户端");
    const result = await exportResults({ rows });
    if (result) showNotice(`已导出 ${result.count} 条批量分享结果`);
  } catch (error) { showNotice(error.message || String(error), "error"); }
  finally { share.exporting = false; }
}

function plainShareHistoryRow(row) {
  return {
    fsId: String(row?.fsId || ""), name: String(row?.name || ""), path: String(row?.path || ""),
    isDir: Boolean(row?.isDir), shareLink: String(row?.shareLink || ""),
    password: String(row?.password || ""), sharedAt: String(row?.sharedAt || ""),
  };
}

async function exportShareHistory() {
  if (share.historyBusy) return;
  archiveSuccessfulShares();
  if (!share.history.length) return showNotice("暂无可导出的分享历史", "error");
  share.historyBusy = true;
  try {
    const result = await bridge.exportBaiduShareHistory({ rows: share.history.map(plainShareHistoryRow) });
    if (result) showNotice(`已导出 ${result.count} 条分享历史`);
  } catch (error) { showNotice(error.message || String(error), "error"); }
  finally { share.historyBusy = false; }
}

async function importShareHistory() {
  if (share.historyBusy || share.running) return;
  share.historyBusy = true;
  try {
    const result = await bridge.importBaiduShareHistory();
    if (!result) return;
    archiveSuccessfulShares();
    const byFsId = new Map(share.history.map((row) => [String(row.fsId), row]));
    for (const row of result.rows || []) byFsId.set(String(row.fsId), { ...plainShareHistoryRow(row), status: "completed" });
    share.history = [...byFsId.values()].slice(-50000);
    await saveWorkspaceNow();
    showNotice(`已从 ${result.fileName} 导入 ${result.total} 条分享历史`);
  } catch (error) { showNotice(error.message || String(error), "error"); }
  finally { share.historyBusy = false; }
}

async function clearCurrentShareHistory() {
  if (!currentSharedCount.value || share.running) return;
  if (!window.confirm(`确定清除当前读取范围内 ${currentSharedCount.value} 条已分享标记吗？清除后可以重新选择并分享。`)) return;
  const currentIds = new Set(share.files.map((item) => String(item.fsId)));
  share.history = share.history.filter((row) => !currentIds.has(String(row.fsId)));
  share.rows = share.rows.filter((row) => !(currentIds.has(String(row.fsId)) && row.status === "completed" && row.shareLink));
  share.selected = [];
  share.completed = share.rows.filter((row) => row.status === "completed" || row.status === "failed").length;
  await saveWorkspaceNow();
  showNotice("已清除当前读取范围的分享标记");
}

async function clearAllShareHistory() {
  archiveSuccessfulShares();
  if (!share.history.length || share.running) return;
  if (!window.confirm(`确定清除全部 ${share.history.length} 条分享历史吗？此操作不会删除百度网盘文件。`)) return;
  share.history = [];
  share.rows = share.rows.filter((row) => !(row.status === "completed" && row.shareLink));
  share.selected = [];
  share.completed = share.rows.filter((row) => row.status === "completed" || row.status === "failed").length;
  await saveWorkspaceNow();
  showNotice("已清除全部分享历史");
}

function formatBytes(size) {
  if (!size) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${(size / (1024 ** index)).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

onMounted(async () => {
  unsubscribe = bridge.onBaiduProgress(handleProgress);
  unsubscribeDirectoryProgress = bridge.onBaiduDirectoryProgress?.((progress) => {
    if (!share.loading || progress?.purpose !== "share-scan" || progress?.requestId !== share.scanRequestId) return;
    share.scannedDirectories = Number(progress.scannedDirectories || 0);
    share.queuedDirectories = Number(progress.queuedDirectories || 0);
    share.foundItems = Number(progress.foundItems || 0);
    const incoming = (Array.isArray(progress.items) ? progress.items : []).filter((item) => (
      share.scope === "both"
      || (share.scope === "level-folders" && item.isDir)
      || (share.scope === "folders" && item.isDir)
      || (share.scope === "files" && !item.isDir)
    ));
    if (incoming.length) {
      const existingIds = new Set(share.files.map((item) => item.fsId));
      share.files.push(...incoming.filter((item) => !existingIds.has(item.fsId)));
    }
  });
  try {
    await loadAccounts({ verify: true });
    await restoreWorkspace();
  } catch {
    account.verified = false;
    /* Start with an empty workspace if saved history is unavailable. */
  } finally { workspaceRestored = true; }
});

onBeforeUnmount(() => {
  saveWorkspaceNow();
  cancelShareDirectoryRead();
  bridge.cancelBaiduDirectory?.({ purpose: "folder-picker" }).catch(() => {});
  unsubscribe?.();
  unsubscribeDirectoryProgress?.();
  clearTimeout(noticeTimer);
  clearTimeout(workspaceSaveTimer);
});
</script>

<template>
  <div class="netdisk-page">
    <section class="account-card">
      <div class="account-copy">
        <span class="batch-kicker">BAIDU NETDISK</span>
        <h2>百度网盘批量处理</h2>
        <p>批量转存分享链接，或把指定目录中的文件批量生成新分享链接。</p>
      </div>
      <div class="account-state" :class="{ verified: account.verified }">
        <i></i>
        <div><strong>{{ account.verified ? "账号状态正常" : account.hasCookie ? "登录信息需要更新" : "尚未配置账号" }}</strong><span>{{ account.verified ? `${selectedAccount?.name || "当前账号"} · 用户标识 ${account.uk}` : "Cookie 使用系统加密保存在本机" }}</span></div>
      </div>
      <div class="account-switcher">
        <select v-model="account.selectedAccountId" :disabled="account.busy || transfer.running || share.running" @change="switchAccount">
          <option v-for="item in account.accounts" :key="item.id" :value="item.id">{{ item.name }}{{ item.hasCookie ? "" : "（未登录）" }}</option>
        </select>
        <button class="outline-button" :disabled="account.busy || transfer.running || share.running" @click="account.adding = !account.adding">{{ account.adding ? "收起" : "新增账号" }}</button>
        <button v-if="selectedAccount && selectedAccount.id !== 'default'" class="outline-button danger" :disabled="account.busy || transfer.running || share.running" @click="deleteCurrentAccount">删除</button>
      </div>
      <div class="account-actions">
        <button class="primary-action" :disabled="account.busy" @click="loginBaiduAccount">{{ account.busy ? "等待登录…" : "登录网盘" }}</button>
        <button class="outline-button" :disabled="account.busy" @click="account.manualOpen = true">手动设置</button>
      </div>
      <div v-if="account.adding" class="account-create-row">
        <input v-model.trim="account.newAccountName" maxlength="30" :disabled="account.busy" placeholder="输入账号名称，例如：工作号、备用号" @keydown.enter="createAccount" />
        <button class="primary-action" :disabled="account.busy || !account.newAccountName.trim()" @click="createAccount">创建</button>
      </div>
      <p class="cookie-help">推荐使用“登录网盘”自动获取当前账号登录状态；也可通过“手动设置”粘贴 Cookie。不同账号的 Cookie 和工作区会分别保存在本机。</p>
    </section>

    <div class="batch-tabs">
      <button :class="{ active: activeTab === 'transfer' }" @click="activeTab = 'transfer'"><strong>批量转存</strong><span>分享链接 → 我的网盘</span></button>
      <button :class="{ active: activeTab === 'share' }" @click="activeTab = 'share'"><strong>批量分享</strong><span>我的网盘 → 新分享链接</span></button>
    </div>

    <section v-if="activeTab === 'transfer'" class="batch-workspace stacked-workspace transfer-workspace" :class="{ 'has-results': transfer.showResults && transfer.rows.length }">
      <div class="batch-settings transfer-config-card">
        <div class="setting-heading transfer-heading">
          <div><span>批量转存设置</span><small>粘贴分享链接并选择保存位置</small></div>
          <div class="transfer-heading-actions">
            <b :class="{ exceeded: transferLimitExceeded }">{{ transferLines.length }} / {{ MAX_TRANSFER_LINKS }} 条</b>
            <button v-if="transfer.rows.length && !transfer.showResults" class="history-result-button" @click="transfer.showResults = true">查看上次结果</button>
          </div>
        </div>
        <div class="transfer-config-grid">
          <label class="batch-field link-field"><span class="transfer-link-heading"><span>分享链接（每行一条，单次最多1000条）<small v-if="transfer.importFileName">已绑定用户名称 · {{ transfer.importFileName }}</small></span><button type="button" :disabled="transfer.running || transfer.importing" @click.prevent="importTransferExcel">{{ transfer.importing ? "正在导入…" : "导入名称+链接 Excel" }}</button></span><textarea v-model="transfer.raw" :class="{ invalid: transferLimitExceeded }" :disabled="transfer.running" placeholder="支持直接粘贴链接，或导入A列名称、B列网盘链接的Excel" @input="handleTransferLinksInput"></textarea><span v-if="transferLimitExceeded" class="link-limit-error"><span>已超出 {{ transferLines.length - MAX_TRANSFER_LINKS }} 条，预计需要 {{ transferBatchCount }} 个批次。</span><button type="button" :disabled="transfer.running" @click.prevent="splitTransferBatch">保留前1000条并复制剩余链接</button></span></label>
          <div class="transfer-options">
            <label class="batch-field"><span>保存到目录</span><input v-model.trim="transfer.destination" :disabled="transfer.running" placeholder="留空保存到根目录" @input="rememberTransferDestination" /></label>
            <div class="transfer-option-row">
              <label class="check-field"><input v-model="transfer.separateFolders" type="checkbox" :disabled="transfer.running" /><span><strong>每条链接单独建文件夹</strong><small>按 0001、0002 创建子目录</small></span></label>
              <label class="batch-field concurrency-select"><span>转存方式</span><select v-model.number="transfer.concurrency" disabled><option :value="1">逐条串行</option></select></label>
            </div>
            <label class="check-field auto-share-toggle"><input v-model="transfer.autoShare" type="checkbox" :disabled="transfer.running" /><span><strong>转存成功后自动分享</strong><small>每条原链接生成一条新的分享链接</small></span></label>
            <div v-if="transfer.autoShare" class="auto-share-settings">
              <label class="batch-field"><span>有效期</span><select v-model.number="transfer.sharePeriod" :disabled="transfer.running"><option :value="1">1 天</option><option :value="7">7 天</option><option :value="30">30 天</option><option :value="0">永久</option></select></label>
              <label class="check-field random-code-check"><input v-model="transfer.randomSharePassword" type="checkbox" :disabled="transfer.running" /><span><strong>随机提取码</strong></span></label>
              <label v-if="!transfer.randomSharePassword" class="batch-field"><span>固定提取码</span><input v-model.trim="transfer.sharePassword" maxlength="4" :disabled="transfer.running" /></label>
            </div>
            <button v-if="!transfer.running" class="run-button" :disabled="transferLimitExceeded" @click="startTransfer">{{ transfer.autoShare ? "开始转存并分享" : "开始批量转存" }}<span>{{ transferLines.length ? ` · ${transferLines.length} 条` : "" }}</span></button>
            <div v-else class="running-actions"><button class="pause-button" @click="togglePause('transfer')">{{ transfer.paused ? "继续处理" : "暂停处理" }}</button><button class="stop-button" @click="stopTask('transfer')">停止</button></div>
          </div>
        </div>
      </div>

      <div v-if="transfer.showResults && transfer.rows.length" class="result-panel transfer-result-panel">
        <div class="result-heading"><div><span class="batch-kicker">TRANSFER QUEUE</span><h3>转存进度</h3></div><div class="result-heading-actions"><span v-if="transfer.running" class="working-dot">{{ transfer.paused ? "已暂停" : "正在处理" }}</span><button v-if="failedTransferRows.length" class="retry-result-button" :disabled="transfer.running" @click="retryFailedTransfers">重试转存失败项（{{ failedTransferRows.length }}）</button><button v-if="failedTransferShareRows.length" class="retry-result-button share-retry" :disabled="transfer.running" @click="retryFailedTransferShares">重试分享失败项（{{ failedTransferShareRows.length }}）</button><button v-if="failedTransferRows.length" class="small-button" :disabled="transfer.running" @click="copyFailedTransferLinks">复制失败链接</button><button class="send-format-button" :disabled="!transferExportRows.length || transfer.running" @click="sendResultsToFormat(transferExportRows, 'transfer')">发送到格式转换{{ transferExportRows.length ? `（${transferExportRows.length}）` : "" }}</button><button class="export-result-button" :disabled="!transferExportRows.length || transfer.exporting" @click="exportTransferResults">{{ transfer.exporting ? "导出中…" : `导出结果${transferExportRows.length ? `（${transferExportRows.length}）` : ''}` }}</button><button v-if="!transfer.running" class="collapse-result-button" @click="transfer.showResults = false">收起结果</button></div></div>
        <div class="metric-row"><div><span>全部</span><strong>{{ transferStats.total }}</strong></div><div><span>待处理</span><strong>{{ transferStats.pending }}</strong></div><div class="success"><span>成功</span><strong>{{ transferStats.success }}</strong></div><div class="failed"><span>失败</span><strong>{{ transferStats.failed }}</strong></div></div>
        <div class="progress-line"><i :style="{ width: `${transferStats.total ? transfer.completed / transferStats.total * 100 : 0}%` }"></i></div>
        <div class="batch-table-wrap">
          <table class="batch-table transfer-result-table"><thead><tr><th>序号</th><th>用户名称 / 原分享链接</th><th>网盘原内容</th><th>保存目录</th><th>新分享链接</th><th>状态</th></tr></thead><tbody>
            <tr v-for="(row, index) in transfer.rows" :key="index" :class="row.status"><td>{{ index + 1 }}</td><td><strong v-if="row.customName" class="custom-resource-name">{{ row.customName }}</strong><span class="source-link">{{ row.source }}</span></td><td><small v-if="row.customName && row.names?.length" class="original-resource-name">网盘原名：{{ row.names.join("、") }}</small><span v-else>{{ row.names?.join("、") || (row.status === "running" ? "正在读取…" : "—") }}</span><small v-if="row.error" class="row-error">{{ row.error }}</small></td><td>{{ row.destination || "—" }}</td><td><span v-if="row.shareLink" class="generated-link" title="点击复制" @click="copyValue(row.shareLink)">{{ row.shareLink }}</span><small v-else-if="row.shareError" class="row-error">转存成功，分享失败：{{ row.shareError }}</small><span v-else>{{ transfer.autoShare && row.status === "running" ? "等待分享…" : "—" }}</span></td><td><span class="state-pill" :class="row.status">{{ { pending: "待处理", running: "处理中", completed: row.shareError ? "转存成功" : "成功", failed: "失败" }[row.status] }}</span></td></tr>
          </tbody></table>
        </div>
      </div>
    </section>

    <section v-else class="batch-workspace stacked-workspace share-workspace">
      <div class="batch-settings share-config-card">
        <div class="setting-heading share-heading">
          <div><span>批量分享设置</span><small>读取网盘目录，勾选需要生成新链接的文件或文件夹</small></div>
          <div class="share-heading-actions"><button :disabled="share.historyBusy || share.running" @click="importShareHistory">导入历史</button><button :disabled="share.historyBusy || (!share.history.length && !shareStats.success)" @click="exportShareHistory">导出历史</button><button :disabled="!currentSharedCount || share.running" @click="clearCurrentShareHistory">清除当前标记</button><button class="danger" :disabled="(!share.history.length && !shareStats.success) || share.running" @click="clearAllShareHistory">清除全部历史</button><b :class="{ exceeded: shareLimitExceeded }">{{ share.selected.length }} / {{ MAX_SHARE_ITEMS }} 项已选{{ share.selected.length ? ` · ${shareBatchCount} 批` : "" }}</b></div>
        </div>
        <div class="share-config-grid">
          <div class="share-source-panel">
            <label class="batch-field directory-field"><span>网盘来源目录</span><button class="folder-picker-trigger" :disabled="share.running" @click="openFolderPicker"><span class="folder-icon">▰</span><span class="folder-value">{{ share.folder || "/" }}</span><b>选择目录</b></button></label>
            <div class="scope-field"><span>读取范围</span><div class="scope-options">
              <label :class="{ active: share.scope === 'current' }"><input v-model="share.scope" type="radio" value="current" :disabled="share.running" @change="handleShareScopeChange" /><strong>当前目录</strong><small>目录本身</small></label>
              <label :class="{ active: share.scope === 'level-folders' }"><input v-model="share.scope" type="radio" value="level-folders" :disabled="share.running" @change="handleShareScopeChange" /><strong>一级目录(快)</strong><small>不递归</small></label>
              <label :class="{ active: share.scope === 'folders' }"><input v-model="share.scope" type="radio" value="folders" :disabled="share.running" @change="handleShareScopeChange" /><strong>递归子目录(较慢)</strong><small>仅文件夹</small></label>
              <label :class="{ active: share.scope === 'files' }"><input v-model="share.scope" type="radio" value="files" :disabled="share.running" @change="handleShareScopeChange" /><strong>递归子文件(很慢)</strong><small>仅文件</small></label>
              <label :class="{ active: share.scope === 'both' }"><input v-model="share.scope" type="radio" value="both" :disabled="share.running" @change="handleShareScopeChange" /><strong>文件和目录(无敌慢)</strong><small>全部层级</small></label>
            </div></div>
            <button class="load-scope-button" :disabled="share.loading || share.running" @click="loadShareDirectory">{{ share.loading ? `正在读取 · 已扫描 ${share.scannedDirectories} 个目录` : "读取所选范围" }}</button>
            <div v-if="share.loading" class="directory-scan-progress">
              <span><i></i>正在并发读取网盘目录</span>
              <small>已发现 {{ share.foundItems }} 项<span v-if="share.queuedDirectories"> · 待扫描 {{ share.queuedDirectories }} 个目录</span></small>
            </div>
          </div>
          <div class="share-options-panel">
            <div class="share-option-row">
              <label class="batch-field"><span>链接有效期</span><select v-model.number="share.period" :disabled="share.running"><option :value="1">1 天</option><option :value="7">7 天</option><option :value="30">30 天</option><option :value="0">永久</option></select></label>
              <label class="batch-field concurrency-field"><span>同时处理</span><select v-model.number="share.concurrency" :disabled="share.running"><option v-for="n in 10" :key="n" :value="n">{{ n }} 条{{ n === 5 ? "（推荐）" : "" }}</option></select></label>
            </div>
            <div class="share-password-row">
              <label class="check-field password-check"><input v-model="share.randomPassword" type="checkbox" :disabled="share.running" /><span><strong>随机提取码</strong><small>每条链接生成不同提取码</small></span></label>
              <label v-if="!share.randomPassword" class="batch-field password-field"><span>固定提取码</span><input v-model.trim="share.password" maxlength="4" placeholder="4 位字符" :disabled="share.running" /></label>
            </div>
            <div v-if="shareLimitExceeded" class="share-limit-error"><span>已超出任务上限 {{ share.selected.length - MAX_SHARE_ITEMS }} 项，单次任务最多 {{ MAX_SHARE_ITEMS }} 项。</span><button type="button" @click="keepAllowedShareItems">仅保留前5000项</button></div>
            <button v-if="!share.running" class="run-button" :disabled="share.loading || !share.selected.length || shareLimitExceeded" @click="startShare">生成分享链接<span>{{ share.loading ? " · 请等待目录读取完成" : share.selected.length ? ` · ${share.selected.length} 项` : " · 请先选择内容" }}</span></button>
            <div v-else class="running-actions"><button class="pause-button" @click="togglePause('share')">{{ share.paused ? "继续" : "暂停" }}</button><button class="stop-button" @click="stopTask('share')">停止</button></div>
          </div>
        </div>
      </div>

      <div class="result-panel">
        <div class="result-heading share-result-heading"><div><span class="batch-kicker">SHARE WORKBENCH</span><h3>选择网盘内容</h3></div><div class="heading-actions"><div class="type-filter"><button :class="{ active: share.typeFilter === 'all' }" @click="share.typeFilter = 'all'">全部</button><button :class="{ active: share.typeFilter === 'folder' }" @click="share.typeFilter = 'folder'">文件夹</button><button :class="{ active: share.typeFilter === 'file' }" @click="share.typeFilter = 'file'">文件</button></div><button class="small-button select-all-button" :disabled="!unsharedShareFiles.length || share.running" @click="toggleAllShareContent">{{ allShareContentSelected ? "取消本批选择" : `选择未分享（${unsharedShareFiles.length}）` }}</button><button class="small-button" :disabled="!visibleShareIds.length || share.running" @click="toggleAllFiles">{{ allFilesSelected ? "取消当前筛选" : "选择当前未分享" }}</button><button v-if="failedShareRows.length" class="retry-result-button share-retry" :disabled="share.running" @click="retryFailedShares">重试失败项（{{ failedShareRows.length }}）</button><button class="small-button" :disabled="!shareStats.success" @click="copyShareResults">复制结果</button><button class="send-format-button" :disabled="!shareExportRows.length || share.running" @click="sendResultsToFormat(shareExportRows, 'share')">发送到格式转换{{ shareExportRows.length ? `（${shareExportRows.length}）` : "" }}</button><button class="export-result-button" :disabled="!shareExportRows.length || share.exporting" @click="exportShareResults">{{ share.exporting ? "导出中…" : `导出结果${shareExportRows.length ? `（${shareExportRows.length}）` : ""}` }}</button></div></div>
        <div class="metric-row share-metric-row"><div><span>目录内容</span><strong>{{ share.files.length }}</strong></div><div><span>已分享</span><strong>{{ currentSharedCount }}</strong></div><div><span>未分享</span><strong>{{ unsharedShareFiles.length }}</strong></div><div><span>已选择</span><strong>{{ share.selected.length }}</strong></div><div class="failed"><span>失败</span><strong>{{ shareStats.failed }}</strong></div></div>
        <div class="progress-line"><i :style="{ width: `${shareStats.total ? share.completed / shareStats.total * 100 : 0}%` }"></i></div>
        <div class="batch-table-wrap">
          <table class="batch-table share-table"><thead><tr><th><input type="checkbox" title="选择本批未分享内容" :checked="allShareContentSelected" :disabled="!unsharedShareFiles.length || share.running" @change="toggleAllShareContent" /></th><th>文件或文件夹</th><th>类型</th><th>大小</th><th>分享结果</th><th>状态</th></tr></thead><tbody>
            <tr v-for="file in pagedShareFiles" :key="file.fsId"><td><input v-model="share.selected" type="checkbox" :value="file.fsId" :disabled="share.running || sharedShareIds.has(String(file.fsId))" /></td><td><div class="file-tree-name" :style="{ paddingLeft: `${Math.min(file.depth || 0, 8) * 14}px` }"><span>{{ file.isDir ? "▸" : "·" }}</span><strong>{{ file.name }}</strong></div><small v-if="file.relativePath && file.relativePath !== file.name" class="relative-path">{{ file.relativePath }}</small></td><td>{{ file.isDir ? "文件夹" : "文件" }}</td><td>{{ file.isDir ? "—" : formatBytes(file.size) }}</td><td><span v-if="shareRowsByFsId.get(String(file.fsId))?.shareLink" class="generated-link" @click="copyValue(shareRowsByFsId.get(String(file.fsId)).shareLink)">{{ shareRowsByFsId.get(String(file.fsId)).shareLink }}</span><small v-else-if="shareRowsByFsId.get(String(file.fsId))?.error" class="row-error">{{ shareRowsByFsId.get(String(file.fsId)).error }}</small><span v-else>—</span></td><td><span v-if="shareRowsByFsId.get(String(file.fsId))" class="state-pill" :class="shareRowsByFsId.get(String(file.fsId)).status">{{ { pending: "待处理", running: "处理中", completed: "已分享", failed: "失败" }[shareRowsByFsId.get(String(file.fsId)).status] }}</span><span v-else class="state-pill neutral">未分享</span></td></tr>
            <tr v-if="!visibleShareFiles.length"><td colspan="6"><div class="batch-empty">{{ share.files.length ? "当前筛选下没有内容" : "填写网盘目录并点击“读取目录”，即可选择任意层级的文件夹或文件" }}</div></td></tr>
          </tbody></table>
        </div>
        <div v-if="sharePageCount > 1" class="share-pagination"><span>第 {{ (sharePage - 1) * SHARE_PAGE_SIZE + 1 }}–{{ Math.min(sharePage * SHARE_PAGE_SIZE, visibleShareFiles.length) }} 项，共 {{ visibleShareFiles.length }} 项</span><div><button :disabled="sharePage <= 1" @click="sharePage -= 1">上一页</button><b>{{ sharePage }} / {{ sharePageCount }}</b><button :disabled="sharePage >= sharePageCount" @click="sharePage += 1">下一页</button></div></div>
      </div>
    </section>

    <div v-if="folderPicker.open" class="picker-backdrop" @click.self="folderPicker.open = false">
      <div class="folder-picker-dialog">
        <div class="picker-heading"><div><span class="batch-kicker">BAIDU NETDISK</span><h3>选择网盘目录</h3></div><button @click="folderPicker.open = false">×</button></div>
        <div class="picker-path"><button :disabled="folderPicker.path === '/' || folderPicker.loading" @click="goPickerParent">← 上一级</button><span>{{ folderPicker.path }}</span></div>
        <div class="picker-list">
          <button v-for="item in folderPicker.items" :key="item.fsId" :disabled="folderPicker.loading" @click="enterPickerFolder(item)"><span>▰</span><strong>{{ item.name }}</strong><i>›</i></button>
          <div v-if="folderPicker.loading" class="picker-empty">正在读取目录…</div>
          <div v-else-if="!folderPicker.items.length" class="picker-empty">当前目录下没有子文件夹</div>
        </div>
        <div class="picker-footer"><div><small>当前选择</small><strong>{{ folderPicker.path }}</strong></div><button class="outline-button" @click="folderPicker.open = false">取消</button><button class="primary-action" @click="choosePickerFolder">选择此目录</button></div>
      </div>
    </div>

    <div v-if="account.manualOpen" class="picker-backdrop" @click.self="account.manualOpen = false">
      <div class="manual-account-dialog">
        <div class="picker-heading"><div><span class="batch-kicker">MANUAL SETTINGS</span><h3>手动设置百度网盘</h3></div><button @click="account.manualOpen = false">×</button></div>
        <div class="manual-account-body">
          <label><span>百度网盘完整 Cookie</span><textarea v-model="account.cookie" placeholder="请粘贴从百度网盘获取的完整 Cookie" :disabled="account.busy" @keydown.ctrl.enter="saveAndVerifyAccount"></textarea></label>
          <p>Cookie 仅用于请求百度网盘接口，将通过 Windows 加密后保存在当前电脑，不会上传到其他服务器。</p>
        </div>
        <div class="manual-account-footer"><button v-if="account.hasCookie" class="clear-account-button" :disabled="account.busy" @click="clearAccount">清除已保存信息</button><span></span><button class="outline-button" :disabled="account.busy" @click="account.manualOpen = false">取消</button><button class="primary-action" :disabled="account.busy || !account.cookie.trim()" @click="saveAndVerifyAccount">{{ account.busy ? "正在验证…" : "保存并验证" }}</button></div>
      </div>
    </div>

    <transition name="batch-toast"><div v-if="notice.text" class="batch-notice" :class="notice.type">{{ notice.text }}</div></transition>
  </div>
</template>

<style scoped>
.netdisk-page{display:grid;gap:18px}.account-card,.batch-workspace{background:#fff;border:1px solid #e1e8f1;border-radius:16px;box-shadow:0 8px 24px rgba(22,44,72,.05)}.account-card{padding:22px 24px 18px;display:grid;grid-template-columns:minmax(260px,1fr) auto;gap:13px 24px;align-items:center}.batch-kicker{color:#7b8ba3;font-size:10px;font-weight:800;letter-spacing:.14em}.account-copy h2{font-size:22px;margin:5px 0 6px}.account-copy p{margin:0;color:#718096;font-size:12px}.account-state{display:flex;align-items:center;gap:10px;min-width:210px;padding:10px 13px;border-radius:10px;background:#fff7ed;color:#9a5b16}.account-state.verified{background:#ecfdf5;color:#087a55}.account-state i{width:9px;height:9px;border-radius:50%;background:#f59e0b;box-shadow:0 0 0 4px rgba(245,158,11,.12)}.account-state.verified i{background:#10b981;box-shadow:0 0 0 4px rgba(16,185,129,.12)}.account-state strong,.account-state span{display:block}.account-state strong{font-size:12px}.account-state span{opacity:.72;font-size:9px;margin-top:3px}.account-input{grid-column:1/-1;display:flex;gap:9px}.account-input input{flex:1;height:40px;border:1px solid #dce5ef;border-radius:9px;padding:0 12px;outline:none}.account-input input:focus,.batch-field input:focus,.batch-field textarea:focus,.batch-field select:focus{border-color:#4f86e8;box-shadow:0 0 0 3px rgba(79,134,232,.1)}button{font:inherit;cursor:pointer}.primary-action,.outline-button{height:40px;padding:0 16px;border-radius:9px;font-size:11px;font-weight:700}.primary-action{color:#fff;border:1px solid #2563eb;background:#2563eb}.outline-button{color:#31577f;border:1px solid #d7e1ec;background:#fff}.text-button{border:0;color:#8b97a8;background:transparent;font-size:10px}.cookie-help{grid-column:1/-1;margin:-4px 0 0;color:#8a96a8;font-size:10px}.batch-tabs{display:flex;width:max-content;padding:4px;border:1px solid #dde6f0;border-radius:11px;background:#eaf0f7}.batch-tabs button{min-width:190px;border:0;border-radius:8px;color:#75849a;background:transparent;padding:9px 18px;text-align:left}.batch-tabs button.active{color:#194f9a;background:#fff;box-shadow:0 3px 10px rgba(29,70,115,.12)}.batch-tabs strong,.batch-tabs span{display:block}.batch-tabs strong{font-size:12px}.batch-tabs span{font-size:9px;margin-top:3px;opacity:.72}.batch-workspace{min-height:540px;display:grid;grid-template-columns:300px minmax(0,1fr);overflow:hidden}.batch-settings{padding:20px;border-right:1px solid #e5ebf3;background:#fbfcfe}.setting-heading,.result-heading{display:flex;align-items:center;justify-content:space-between}.setting-heading{margin-bottom:16px}.setting-heading span{font-size:14px;font-weight:800}.setting-heading b{color:#2563eb;font-size:10px}.batch-field{display:grid;gap:7px;margin-bottom:14px}.batch-field>span{color:#46556b;font-size:10px;font-weight:700}.batch-field input,.batch-field textarea,.batch-field select{width:100%;border:1px solid #dce4ee;border-radius:9px;background:#fff;padding:0 10px;outline:none;font-size:11px}.batch-field input,.batch-field select{height:38px}.batch-field textarea{height:180px;padding:10px;resize:vertical;line-height:1.65}.batch-field.compact{grid-template-columns:90px 1fr;align-items:center}.batch-field.compact span{font-size:11px}.check-field{display:flex;gap:9px;align-items:flex-start;margin:3px 0 15px;color:#47576d}.check-field input{margin-top:2px;accent-color:#2563eb}.check-field strong,.check-field small{display:block}.check-field strong{font-size:11px}.check-field small{color:#8a96a8;font-size:9px;margin-top:3px}.run-summary{display:flex;align-items:baseline;gap:6px;padding:12px 0;color:#78869a;font-size:10px}.run-summary strong{color:#1d5dc4;font-size:23px}.run-summary em{font-style:normal}.run-button{width:100%;height:42px;border:0;border-radius:9px;color:#fff;background:linear-gradient(180deg,#3478e8,#2462ca);font-size:12px;font-weight:800;box-shadow:0 7px 16px rgba(37,99,235,.2)}.run-button:disabled{opacity:.45}.running-actions{display:grid;grid-template-columns:1fr 80px;gap:8px}.running-actions button{height:40px;border-radius:9px;font-size:11px}.pause-button{color:#fff;border:0;background:#2563eb}.stop-button{color:#b43d3d;border:1px solid #efc8c8;background:#fff}.result-panel{min-width:0;display:flex;flex-direction:column}.result-heading{height:74px;padding:0 20px;border-bottom:1px solid #e5ebf3}.result-heading h3{font-size:15px;margin:4px 0 0}.working-dot{color:#b27012;background:#fff5df;border-radius:99px;padding:5px 9px;font-size:9px}.metric-row{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid #e5ebf3}.metric-row div{padding:12px 18px;border-right:1px solid #e8edf4}.metric-row div:last-child{border-right:0}.metric-row span,.metric-row strong{display:block}.metric-row span{color:#7e8ba0;font-size:9px}.metric-row strong{font-size:18px;margin-top:4px}.metric-row .success strong{color:#079669}.metric-row .failed strong{color:#d34848}.progress-line{height:3px;background:#eef2f7}.progress-line i{display:block;height:100%;background:#3478e8;transition:width .25s}.batch-table-wrap{flex:1;min-height:0;max-height:470px;overflow:auto}.batch-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10px}.batch-table th{position:sticky;top:0;z-index:1;height:38px;color:#6e7d92;background:#f7f9fc;text-align:left;font-size:9px}.batch-table th,.batch-table td{padding:9px 12px;border-bottom:1px solid #e8edf4;vertical-align:middle}.batch-table th:nth-child(1){width:55px}.batch-table th:nth-child(2){width:30%}.batch-table th:nth-child(4){width:16%}.batch-table th:last-child{width:78px}.batch-table tr.running{background:#f1f7ff}.source-link,.generated-link{display:block;color:#2670d8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.generated-link{cursor:pointer}.row-error{display:block;color:#d34848;margin-top:4px;line-height:1.4}.state-pill{display:inline-block;border-radius:99px;padding:4px 8px;color:#64748b;background:#eef2f7;font-size:9px}.state-pill.running{color:#2064c3;background:#e8f1ff}.state-pill.completed{color:#087a55;background:#e7f8f1}.state-pill.failed{color:#c83d3d;background:#fdecec}.state-pill.neutral{color:#7c8798;background:#f0f3f7}.batch-empty{padding:90px 20px;text-align:center;color:#9aa5b5}.inline-field{display:flex}.inline-field input{border-radius:9px 0 0 9px}.inline-field button{width:72px;border:1px solid #2d6dd7;border-radius:0 9px 9px 0;color:#fff;background:#2d6dd7;font-size:9px}.heading-actions{display:flex;gap:7px}.small-button{height:30px;border:1px solid #d8e2ed;border-radius:7px;color:#596a80;background:#fff;padding:0 10px;font-size:9px}.small-button.primary{color:#fff;border-color:#2d6dd7;background:#2d6dd7}.share-table th:nth-child(1){width:42px}.share-table th:nth-child(2){width:25%}.share-table th:nth-child(3){width:70px}.share-table th:nth-child(4){width:75px}.share-table th:nth-child(5){width:auto}.batch-notice{position:fixed;right:28px;bottom:25px;z-index:40;max-width:430px;padding:12px 16px;border-radius:9px;color:#fff;background:#198b67;box-shadow:0 10px 30px rgba(20,40,70,.2);font-size:11px}.batch-notice.error{background:#cc4545}.batch-notice.warning{background:#b7791f}.batch-toast-enter-active,.batch-toast-leave-active{transition:.2s}.batch-toast-enter-from,.batch-toast-leave-to{opacity:0;transform:translateY(8px)}@media(max-width:1180px){.account-card{grid-template-columns:1fr}.account-state{grid-row:2}.account-input,.cookie-help{grid-column:1}.batch-workspace{grid-template-columns:270px minmax(0,1fr)}}
.stacked-workspace{display:flex;flex-direction:column;min-height:430px}.top-settings{display:grid;align-items:end;gap:12px 14px;padding:16px 18px;border-right:0;border-bottom:1px solid #e5ebf3}.top-settings .setting-heading{grid-column:1/-1;margin:0}.top-settings .batch-field{margin:0}.top-settings .check-field{margin:0;min-height:38px;align-items:center}.top-settings .check-field input{margin-top:0}.transfer-top-settings{grid-template-columns:minmax(280px,2fr) minmax(140px,1fr) 175px 120px 145px}.transfer-top-settings .link-field textarea{height:76px;min-height:76px;resize:vertical}.top-run-area{align-self:end}.top-run-area .run-button{height:38px}.top-run-area .running-actions{grid-template-columns:1fr 58px}.share-top-settings{grid-template-columns:minmax(235px,1.5fr) 165px 100px 135px 105px 145px}.share-top-settings .directory-field{grid-column:auto}.share-top-settings .inline-field button{width:78px}.share-top-settings .password-field{min-width:95px}.result-panel{min-height:310px}.stacked-workspace .result-heading{height:58px}.stacked-workspace .metric-row div{padding:8px 16px}.stacked-workspace .metric-row strong{font-size:15px;margin-top:2px}.stacked-workspace .batch-table-wrap{max-height:420px}.stacked-workspace .batch-empty{padding:70px 20px}.heading-actions{align-items:center;flex-wrap:wrap}.type-filter{display:flex;padding:2px;border-radius:7px;background:#edf2f8}.type-filter button{height:26px;padding:0 9px;border:0;border-radius:5px;color:#75849a;background:transparent;font-size:9px}.type-filter button.active{color:#2563eb;background:#fff;box-shadow:0 2px 6px rgba(22,54,90,.1)}.file-tree-name{display:flex;align-items:center;gap:6px;min-width:0}.file-tree-name span{color:#5d83bb}.file-tree-name strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.relative-path{display:block;margin:3px 0 0 20px;color:#9aa5b5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.share-table th:nth-child(2){width:30%}
@media(max-width:1250px){.transfer-top-settings,.share-top-settings{grid-template-columns:minmax(280px,2fr) minmax(150px,1fr) minmax(150px,1fr)}.top-run-area{min-width:150px}.share-top-settings .setting-heading,.transfer-top-settings .setting-heading{grid-column:1/-1}}
.transfer-workspace{min-height:0;overflow:hidden}.transfer-config-card{padding:20px 22px;border:0;background:#fff}.transfer-heading{margin:0 0 15px}.transfer-heading>div:first-child span,.transfer-heading>div:first-child small{display:block}.transfer-heading>div:first-child span{font-size:15px}.transfer-heading>div:first-child small{margin-top:4px;color:#8a96a8;font-size:9px;font-weight:400}.transfer-heading-actions{display:flex;align-items:center;gap:9px}.transfer-heading-actions b{padding:5px 9px;border-radius:99px;color:#2563eb;background:#edf4ff;font-size:9px}.history-result-button,.collapse-result-button{height:28px;padding:0 10px;border:1px solid #d9e3ee;border-radius:7px;color:#52677f;background:#fff;font-size:9px}.transfer-config-grid{display:grid;grid-template-columns:minmax(380px,1.55fr) minmax(285px,.9fr);gap:20px}.transfer-config-grid .batch-field{margin:0}.transfer-config-grid .link-field textarea{height:132px;min-height:132px;resize:vertical}.transfer-options{display:flex;flex-direction:column;gap:12px;padding:13px 14px;border:1px solid #e4eaf2;border-radius:11px;background:#f8fafc}.transfer-option-row{display:grid;grid-template-columns:minmax(0,1fr) 132px;gap:12px;align-items:end}.transfer-option-row .check-field{margin:0;min-height:38px;align-items:center}.transfer-option-row .check-field input{margin-top:0}.concurrency-select{margin:0}.transfer-options .run-button{height:42px;margin-top:auto}.transfer-options .run-button span{font-weight:500;opacity:.82}.transfer-workspace.has-results .transfer-config-card{border-bottom:1px solid #e5ebf3}.transfer-result-panel{min-height:300px}.result-heading-actions{display:flex;align-items:center;gap:8px}.collapse-result-button:hover,.history-result-button:hover{color:#2563eb;border-color:#a9c5ef}.transfer-result-panel .batch-table-wrap{min-height:190px}.transfer-result-panel .batch-empty{padding:55px 20px}
@media(max-width:1180px){.transfer-config-grid{grid-template-columns:1fr}.transfer-config-grid .link-field textarea{height:110px;min-height:110px}.transfer-option-row{grid-template-columns:minmax(0,1fr) 150px}}
.auto-share-toggle{margin:0;min-height:36px;align-items:center;padding:7px 9px;border-radius:8px;background:#eef5ff;color:#315d96}.auto-share-toggle input{margin-top:0}.auto-share-settings{display:grid;grid-template-columns:92px minmax(110px,1fr) 110px;gap:10px;align-items:end;padding:10px;border:1px solid #dbe8f8;border-radius:9px;background:#fff}.auto-share-settings .batch-field{margin:0}.auto-share-settings .batch-field input,.auto-share-settings .batch-field select{height:34px}.random-code-check{margin:0;min-height:34px;align-items:center}.random-code-check input{margin-top:0}.transfer-result-table th:nth-child(1){width:50px}.transfer-result-table th:nth-child(2){width:23%}.transfer-result-table th:nth-child(3){width:20%}.transfer-result-table th:nth-child(4){width:14%}.transfer-result-table th:nth-child(5){width:25%}.transfer-result-table th:last-child{width:82px}
.export-result-button{height:28px;padding:0 11px;border:1px solid #2563eb;border-radius:7px;color:#fff;background:#2563eb;font-size:9px}.export-result-button:hover{background:#1d56c4}.export-result-button:disabled{opacity:.45;cursor:not-allowed}
.retry-result-button{height:28px;padding:0 11px;border:1px solid #d79a2e;border-radius:7px;color:#9a6100;background:#fff8e8;font-size:9px;font-weight:700}.retry-result-button:hover{border-color:#bd7a13;background:#fff2d2}.retry-result-button.share-retry{border-color:#68a6df;color:#17619f;background:#eef7ff}.retry-result-button.share-retry:hover{border-color:#3985c8;background:#e2f1ff}.retry-result-button:disabled{opacity:.45;cursor:not-allowed}
.transfer-link-heading{display:flex!important;align-items:center;justify-content:space-between;gap:12px}.transfer-link-heading>span{display:grid;gap:3px}.transfer-link-heading small{color:#2872cf;font-size:8px;font-weight:600}.transfer-link-heading button{height:28px;padding:0 10px;border:1px solid #b9d0f1;border-radius:7px;color:#1f5fbf;background:#eef5ff;font-size:9px;font-weight:700;cursor:pointer}.transfer-link-heading button:hover{border-color:#72a3e9;background:#e5f0ff}.transfer-link-heading button:disabled{opacity:.5;cursor:not-allowed}.custom-resource-name{display:block;margin-bottom:4px;color:#203752;font-size:10px}.original-resource-name{display:block;margin-top:4px;color:#8a98aa;font-size:8px;line-height:1.4}
.send-format-button{height:28px;padding:0 11px;border:1px solid #123d70;border-radius:7px;color:#fff;background:#123d70;font-size:9px;font-weight:700;box-shadow:0 3px 8px rgba(18,61,112,.14)}.send-format-button:hover{background:#0d315c}.send-format-button:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
.transfer-config-grid{align-items:stretch}.transfer-config-grid .link-field{grid-template-rows:auto minmax(210px,1fr);align-content:stretch}.transfer-config-grid .link-field textarea{width:100%;height:100%;min-height:210px;padding:13px 14px;border-radius:11px;background:#fbfcfe;line-height:1.75;resize:vertical;box-shadow:inset 0 1px 2px rgba(24,48,76,.025)}.transfer-config-grid .link-field textarea:hover{border-color:#c3d3e6;background:#fff}.transfer-config-grid .link-field textarea:focus{background:#fff}.transfer-config-grid .link-field>span{display:flex;align-items:center;min-height:18px}.transfer-options{height:100%}
@media(max-width:1180px){.transfer-config-grid .link-field{grid-template-rows:auto minmax(150px,1fr)}.transfer-config-grid .link-field textarea{height:100%;min-height:150px}}
.share-workspace{min-height:0}.share-config-card{padding:20px 22px;border:0;border-bottom:1px solid #e5ebf3;background:#fff}.share-heading{margin:0 0 15px}.share-heading>div:first-child span,.share-heading>div:first-child small{display:block}.share-heading>div:first-child span{font-size:15px}.share-heading>div:first-child small{margin-top:4px;color:#8a96a8;font-size:9px;font-weight:400}.share-heading-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap}.share-heading-actions>b{padding:5px 9px;border-radius:99px;color:#2563eb;background:#edf4ff;font-size:9px}.share-heading-actions button{height:27px;padding:0 9px;border:1px solid #d4dfeb;border-radius:7px;color:#53677e;background:#fff;font-size:9px}.share-heading-actions button:hover{border-color:#8eb3e7;color:#2463b8}.share-heading-actions button.danger{border-color:#efcccc;color:#b94444}.share-heading-actions button:disabled{opacity:.42;cursor:not-allowed}.share-config-grid{display:grid;grid-template-columns:minmax(390px,1.45fr) minmax(310px,.85fr);gap:20px;align-items:stretch}.share-source-panel,.share-options-panel{border:1px solid #e3eaf2;border-radius:11px}.share-source-panel{display:flex;flex-direction:column;justify-content:center;gap:13px;padding:17px 18px;background:#fbfcfe}.share-source-panel .batch-field,.share-source-panel .check-field,.share-options-panel .batch-field,.share-options-panel .check-field{margin:0}.share-source-panel .inline-field input{height:42px;padding-left:13px;background:#fff}.share-source-panel .inline-field button{width:92px;font-size:10px;font-weight:700}.recursive-toggle{min-height:42px;align-items:center;padding:9px 11px;border-radius:9px;color:#315d96;background:#eef5ff}.recursive-toggle input{margin-top:0}.share-options-panel{display:flex;flex-direction:column;gap:11px;padding:13px 14px;background:#f8fafc}.share-option-row{display:grid;grid-template-columns:1fr 1.25fr;gap:10px}.share-options-panel .batch-field input,.share-options-panel .batch-field select{height:35px}.share-password-row{display:grid;grid-template-columns:minmax(0,1fr) 110px;gap:10px;align-items:end;min-height:43px;padding:8px 10px;border:1px solid #e1e8f1;border-radius:9px;background:#fff}.share-password-row .password-check{align-items:center}.share-password-row .password-check input{margin-top:0}.share-password-row .password-field input{height:34px}.share-options-panel .run-button{height:42px;margin-top:auto}.share-options-panel .run-button span{font-weight:500;opacity:.82}.share-result-heading{height:62px}.share-result-heading h3{font-size:14px}.share-table tbody tr:has(input:checked){background:#f2f7ff}.share-table input[type="checkbox"]{width:14px;height:14px;accent-color:#2563eb}.share-table td:first-child,.share-table th:first-child{text-align:center}.share-workspace .batch-table-wrap{max-height:440px;min-height:220px}.share-workspace .batch-empty{padding:68px 20px}
.share-pagination{display:flex;align-items:center;justify-content:space-between;min-height:42px;padding:7px 14px;border-top:1px solid #e5ebf2;color:#77869a;background:#fbfcfe;font-size:9px}.share-pagination>div{display:flex;align-items:center;gap:9px}.share-pagination button{height:28px;padding:0 10px;border:1px solid #d7e1ec;border-radius:7px;color:#52677f;background:#fff;font-size:9px}.share-pagination button:disabled{opacity:.4}.share-pagination b{color:#344a64;font-size:9px}
.share-metric-row{grid-template-columns:repeat(5,minmax(0,1fr))}
.folder-picker-trigger{display:flex;align-items:center;width:100%;height:42px;padding:0 10px;border:1px solid #dce4ee;border-radius:9px;color:#53657c;background:#fff;text-align:left}.folder-picker-trigger:hover{border-color:#93b7ec}.folder-picker-trigger:disabled{opacity:.55}.folder-icon{margin-right:8px;color:#e3a52b;font-size:14px}.folder-value{min-width:0;flex:1;overflow:hidden;color:#263b55;font-size:11px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}.folder-picker-trigger b{color:#2563eb;font-size:10px}.scope-field{display:grid;gap:7px}.scope-field>span{color:#46556b;font-size:10px;font-weight:700}.scope-options{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px}.scope-options label{position:relative;display:grid;gap:2px;min-height:52px;padding:8px 9px;border:1px solid #e1e8f1;border-radius:9px;color:#55677d;background:#fff;cursor:pointer}.scope-options label:hover{border-color:#b8cce7}.scope-options label.active{border-color:#78a8ef;color:#1f5bb5;background:#edf5ff;box-shadow:0 0 0 2px rgba(37,99,235,.06)}.scope-options input{position:absolute;opacity:0;pointer-events:none}.scope-options strong{font-size:10px}.scope-options small{color:#8b99aa;font-size:8px}.load-scope-button{height:36px;border:1px solid #c9dbf3;border-radius:8px;color:#215daF;background:#f1f6fd;font-size:10px;font-weight:700}.load-scope-button:hover{border-color:#7ca8e6;background:#e9f2ff}.load-scope-button:disabled{opacity:.55}.picker-backdrop{position:fixed;inset:0;z-index:80;display:grid;place-items:center;padding:24px;background:rgba(15,32,53,.38);backdrop-filter:blur(2px)}.folder-picker-dialog{width:min(620px,calc(100vw - 48px));overflow:hidden;border:1px solid #dce5ef;border-radius:15px;background:#fff;box-shadow:0 24px 70px rgba(12,31,53,.24)}.picker-heading,.picker-footer,.picker-path{display:flex;align-items:center}.picker-heading{justify-content:space-between;padding:18px 20px 14px}.picker-heading h3{margin:3px 0 0;font-size:16px}.picker-heading>button{width:30px;height:30px;border:0;border-radius:7px;color:#718198;background:#f2f5f9;font-size:19px}.picker-path{gap:10px;padding:10px 14px;border-top:1px solid #edf1f5;border-bottom:1px solid #e5ebf2;background:#f8fafc}.picker-path button{height:30px;padding:0 10px;border:1px solid #d6e0eb;border-radius:7px;color:#50647c;background:#fff;font-size:9px}.picker-path button:disabled{opacity:.45}.picker-path span{min-width:0;overflow:hidden;color:#344a64;font-size:10px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}.picker-list{min-height:245px;max-height:360px;padding:8px;overflow:auto}.picker-list>button{display:grid;grid-template-columns:24px minmax(0,1fr) 20px;align-items:center;width:100%;height:42px;padding:0 10px;border:0;border-radius:8px;color:#34485f;background:#fff;text-align:left}.picker-list>button:hover{background:#edf5ff}.picker-list>button span{color:#e3a52b}.picker-list>button strong{overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.picker-list>button i{color:#8ca0b7;font-size:18px;font-style:normal;text-align:right}.picker-empty{display:grid;min-height:245px;place-items:center;color:#96a3b3;font-size:10px}.picker-footer{gap:9px;padding:13px 16px;border-top:1px solid #e5ebf2;background:#fbfcfe}.picker-footer>div{display:grid;min-width:0;flex:1;gap:3px}.picker-footer small{color:#8997a8;font-size:8px}.picker-footer strong{overflow:hidden;color:#334a64;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.picker-footer .outline-button,.picker-footer .primary-action{height:36px}
.select-all-button{color:#1f5fbf;border-color:#b9d0f1;background:#eef5ff}.select-all-button:hover{border-color:#72a3e9;background:#e5f0ff}.share-table thead input[type="checkbox"]{cursor:pointer}.share-table thead input[type="checkbox"]:disabled{cursor:not-allowed}
.directory-scan-progress{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:-5px;color:#42658f;font-size:9px}.directory-scan-progress span{display:flex;align-items:center;gap:6px;font-weight:600}.directory-scan-progress i{width:7px;height:7px;border:2px solid #a8c7ef;border-top-color:#2563eb;border-radius:50%;animation:directory-scan-spin .8s linear infinite}.directory-scan-progress small{color:#8392a5;font-size:9px}@keyframes directory-scan-spin{to{transform:rotate(360deg)}}
.account-card{grid-template-columns:minmax(320px,1fr) minmax(260px,auto) minmax(250px,auto);align-items:start}.account-switcher,.account-actions{display:flex;align-items:center;justify-content:flex-end;gap:9px;min-width:0}.account-switcher{flex-wrap:wrap}.account-switcher select{height:40px;min-width:185px;max-width:260px;border:1px solid #d7e1ec;border-radius:9px;color:#31577f;background:#fff;padding:0 10px;font-size:11px;font-weight:700}.account-switcher button,.account-actions button,.primary-action,.outline-button{white-space:nowrap;word-break:keep-all;flex-shrink:0}.account-actions .primary-action,.account-actions .outline-button{min-width:98px}.account-switcher .danger{color:#b94444;border-color:#efcccc}.account-create-row{grid-column:1/-1;display:grid;grid-template-columns:minmax(260px,1fr) auto;gap:9px}.account-create-row input{height:38px;border:1px solid #dce4ee;border-radius:9px;padding:0 12px;outline:none;font-size:11px}.cookie-help{grid-column:1/-1}.manual-account-dialog{width:min(610px,calc(100vw - 48px));overflow:hidden;border:1px solid #dce5ef;border-radius:15px;background:#fff;box-shadow:0 24px 70px rgba(12,31,53,.24)}.manual-account-body{padding:8px 20px 20px}.manual-account-body label,.manual-account-body label>span{display:block}.manual-account-body label>span{margin-bottom:8px;color:#43546a;font-size:10px;font-weight:700}.manual-account-body textarea{width:100%;height:150px;padding:12px 13px;border:1px solid #d9e3ed;border-radius:10px;color:#32465e;background:#fbfcfe;outline:none;resize:vertical;font:10px/1.65 Consolas,"Microsoft YaHei",sans-serif}.manual-account-body textarea:focus{border-color:#4f86e8;background:#fff;box-shadow:0 0 0 3px rgba(79,134,232,.1)}.manual-account-body p{margin:9px 0 0;color:#8996a7;font-size:9px;line-height:1.6}.manual-account-footer{display:grid;grid-template-columns:auto 1fr auto auto;align-items:center;gap:9px;padding:13px 16px;border-top:1px solid #e5ebf2;background:#fbfcfe}.manual-account-footer .outline-button,.manual-account-footer .primary-action{height:36px}.clear-account-button{height:34px;padding:0 10px;border:1px solid #efcccc;border-radius:8px;color:#b94444;background:#fff;font-size:9px}.clear-account-button:hover{background:#fff5f5}
@media(max-width:1320px){.account-card{grid-template-columns:1fr minmax(250px,auto)}.account-state{justify-self:start}.account-switcher,.account-actions{justify-content:flex-start}.account-actions{grid-column:2}.cookie-help{grid-column:1/-1}}@media(max-width:1180px){.account-card{grid-template-columns:1fr}.account-state,.account-switcher,.account-actions{grid-column:1;justify-self:start}.account-switcher,.account-actions{justify-content:flex-start}.share-config-grid{grid-template-columns:1fr}.share-source-panel{min-height:130px}.share-option-row{grid-template-columns:1fr 1fr}.share-result-heading{height:auto;min-height:62px;padding-top:10px;padding-bottom:10px;gap:10px}.share-result-heading .heading-actions{justify-content:flex-end}}
.transfer-heading-actions b.exceeded{color:#c83d3d;background:#fdecec}.transfer-config-grid .link-field textarea.invalid{border-color:#dc5c65;background:#fff7f7;box-shadow:0 0 0 3px rgba(200,61,61,.08)}.link-limit-error{display:flex;align-items:center;justify-content:space-between;gap:12px;color:#c83d3d;font-size:9px;font-weight:600}.link-limit-error button{flex:0 0 auto;height:27px;padding:0 9px;border:1px solid #dc5c65;border-radius:7px;color:#b8323a;background:#fff;font-size:9px;font-weight:700;cursor:pointer}.link-limit-error button:hover{background:#fff0f1}.link-limit-error button:disabled{opacity:.5;cursor:not-allowed}
.share-heading-actions>b.exceeded{color:#c83d3d;background:#fdecec}.share-limit-error{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 9px;border:1px solid #efc8cc;border-radius:8px;color:#b8323a;background:#fff4f5;font-size:9px;font-weight:600}.share-limit-error button{flex:0 0 auto;height:27px;padding:0 9px;border:1px solid #dc5c65;border-radius:7px;color:#b8323a;background:#fff;font-size:9px;font-weight:700}.share-limit-error button:hover{background:#ffe9eb}
.share-heading-actions{min-width:0}.share-heading-actions>b,.share-heading-actions button,.result-heading-actions button,.transfer-heading-actions b,.transfer-heading-actions button{white-space:nowrap;word-break:keep-all;flex-shrink:0}.account-state{max-width:100%;min-width:0}.account-state>div{min-width:0}.account-state span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.account-switcher .outline-button{min-width:64px;padding:0 13px}.account-actions{flex-wrap:nowrap}.account-actions .primary-action,.account-actions .outline-button{min-width:112px}.account-card{grid-template-columns:minmax(300px,1fr) minmax(430px,auto) minmax(245px,auto);gap:13px 18px}.account-switcher{justify-self:end}.account-actions{justify-self:end}@media(max-width:1500px){.account-card{grid-template-columns:minmax(300px,1fr) minmax(360px,auto)}.account-actions{grid-column:2}.account-state,.account-switcher{justify-self:start}.account-actions{justify-self:start}.account-switcher select{min-width:190px;max-width:245px}}@media(max-width:1180px){.account-card{grid-template-columns:1fr}.account-state,.account-switcher,.account-actions{grid-column:1;justify-self:stretch}.account-switcher,.account-actions{justify-content:flex-start}.account-switcher select{flex:1 1 220px;max-width:none}.account-actions{flex-wrap:wrap}.account-actions .primary-action,.account-actions .outline-button{flex:0 0 auto}.account-create-row{grid-template-columns:1fr}}
</style>
