const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wangpanAPI", {
  chooseExcel: () => ipcRenderer.invoke("dialog:choose-excel"),
  analyzeExcel: (filePath) => ipcRenderer.invoke("excel:analyze", filePath),
  createTask: (payload) => ipcRenderer.invoke("tasks:create", payload),
  createTaskFromNetdisk: (payload) => ipcRenderer.invoke("tasks:create-from-netdisk", payload),
  listTasks: () => ipcRenderer.invoke("tasks:list"),
  getTask: (taskId) => ipcRenderer.invoke("tasks:get", taskId),
  getTaskRows: (payload) => ipcRenderer.invoke("tasks:rows", payload),
  auditTask: (taskId) => ipcRenderer.invoke("tasks:audit", taskId),
  updateTaskRow: (payload) => ipcRenderer.invoke("tasks:update-row", payload),
  deleteTaskRows: (payload) => ipcRenderer.invoke("tasks:delete-rows", payload),
  deleteTask: (taskId) => ipcRenderer.invoke("tasks:delete", taskId),
  regenerateTaskRow: (payload) => ipcRenderer.invoke("tasks:regenerate-row", payload),
  regenerateTaskRows: (payload) => ipcRenderer.invoke("tasks:regenerate-rows", payload),
  copyText: (value) => ipcRenderer.invoke("app:copy-text", value),
  startTask: (payload) => ipcRenderer.invoke("tasks:start", payload),
  pauseTask: (taskId) => ipcRenderer.invoke("tasks:pause", taskId),
  retryTask: (payload) => ipcRenderer.invoke("tasks:retry", payload),
  exportTask: (taskId) => ipcRenderer.invoke("tasks:export", taskId),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  testApi: (settings) => ipcRenderer.invoke("settings:test-api", settings),
  getLicenseState: () => ipcRenderer.invoke("license:state"),
  activateLicense: (key) => ipcRenderer.invoke("license:activate", key),
  refreshLicense: () => ipcRenderer.invoke("license:refresh"),
  openLicensePurchase: () => ipcRenderer.invoke("license:purchase"),
  onLicenseState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("license:state", listener);
    return () => ipcRenderer.removeListener("license:state", listener);
  },
  openApiKeyGuide: () => ipcRenderer.invoke("settings:open-api-key-guide"),
  openModelLibrary: () => ipcRenderer.invoke("settings:open-model-library"),
  syncCloudRules: (input) => ipcRenderer.invoke("rules:sync", input),
  openUserGuide: () => ipcRenderer.invoke("app:open-user-guide"),
  getUpdateState: () => ipcRenderer.invoke("update:state"),
  checkForUpdates: (manifestUrl) => ipcRenderer.invoke("update:check", manifestUrl),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("update:state", listener);
    return () => ipcRenderer.removeListener("update:state", listener);
  },
  openBaiduHome: () => ipcRenderer.invoke("netdisk:open-home"),
  loginBaiduAccount: (input) => ipcRenderer.invoke("netdisk:login", input),
  listBaiduAccounts: () => ipcRenderer.invoke("netdisk:accounts"),
  createBaiduAccount: (name) => ipcRenderer.invoke("netdisk:account-create", name),
  deleteBaiduAccount: (accountId) => ipcRenderer.invoke("netdisk:account-delete", accountId),
  selectBaiduAccount: (accountId) => ipcRenderer.invoke("netdisk:account-select", accountId),
  getBaiduAccount: () => ipcRenderer.invoke("netdisk:account-get"),
  saveBaiduAccount: (input) => ipcRenderer.invoke("netdisk:account-save", input),
  testBaiduAccount: (input) => ipcRenderer.invoke("netdisk:account-test", input),
  listBaiduDirectory: (input) => ipcRenderer.invoke("netdisk:list-directory", input),
  cancelBaiduDirectory: (input) => ipcRenderer.invoke("netdisk:list-directory-cancel", input),
  getBaiduWorkspace: (input) => ipcRenderer.invoke("netdisk:workspace-get", input),
  saveBaiduWorkspace: (input) => ipcRenderer.invoke("netdisk:workspace-save", input),
  runBaiduTransfer: (input) => ipcRenderer.invoke("netdisk:transfer-run", input),
  retryBaiduTransferShares: (input) => ipcRenderer.invoke("netdisk:transfer-share-retry", input),
  runBaiduShare: (input) => ipcRenderer.invoke("netdisk:share-run", input),
  controlBaiduTask: (input) => ipcRenderer.invoke("netdisk:control", input),
  exportBaiduTransferResults: (input) => ipcRenderer.invoke("netdisk:export-transfer-results", input),
  exportBaiduShareResults: (input) => ipcRenderer.invoke("netdisk:export-share-results", input),
  exportBaiduShareHistory: (input) => ipcRenderer.invoke("netdisk:export-share-history", input),
  importBaiduShareHistory: () => ipcRenderer.invoke("netdisk:import-share-history"),
  listAutomationAccounts: () => ipcRenderer.invoke("automation:accounts"),
  createAutomationAccount: (name) => ipcRenderer.invoke("automation:account-create", name),
  deleteAutomationAccount: (payload) => ipcRenderer.invoke("automation:account-delete", payload),
  startAutomation: (payload) => ipcRenderer.invoke("automation:start", payload),
  stopAutomation: (accountId) => ipcRenderer.invoke("automation:stop", accountId),
  stopAllAutomations: () => ipcRenderer.invoke("automation:stop-all"),
  openAutomationPage: (payload) => ipcRenderer.invoke("automation:open-page", payload),
  clearAutomationProgress: (accountId) => ipcRenderer.invoke("automation:progress-clear", accountId),
  openAutomationData: (accountId) => ipcRenderer.invoke("automation:data-open", accountId),
  onAutomationLog: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("automation:log", listener);
    return () => ipcRenderer.removeListener("automation:log", listener);
  },
  onAutomationState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("automation:state", listener);
    return () => ipcRenderer.removeListener("automation:state", listener);
  },
  onBaiduProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("netdisk:progress", listener);
    return () => ipcRenderer.removeListener("netdisk:progress", listener);
  },
  onBaiduDirectoryProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("netdisk:directory-progress", listener);
    return () => ipcRenderer.removeListener("netdisk:directory-progress", listener);
  },
  onCloudRulesUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("rules:updated", listener);
    return () => ipcRenderer.removeListener("rules:updated", listener);
  },
  onTaskProgress: (callback) => {
    const listener = (_event, task) => callback(task);
    ipcRenderer.on("tasks:progress", listener);
    return () => ipcRenderer.removeListener("tasks:progress", listener);
  },
});
