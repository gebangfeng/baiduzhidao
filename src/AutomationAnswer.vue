<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";

const props = defineProps({ globalSettings: { type: Object, default: () => ({}) } });
const emit = defineEmits(["open-settings"]);
const bridge = window.wangpanAPI;
const accounts = ref([]);
const selectedAccountId = ref("");
const maxConcurrent = ref(3);
const logs = ref([]);
const message = reactive({ text: "", type: "success" });
const busy = ref(false);
const adding = ref(false);
const newAccountName = ref("");
const deleteConfirmOpen = ref(false);
const pendingDeleteAccount = ref(null);
let unsubscribeLog;
let unsubscribeState;
let messageTimer;

const selectedAccount = computed(() => accounts.value.find((item) => item.id === selectedAccountId.value) || null);
const runningCount = computed(() => accounts.value.filter((item) => item.running).length);

function notify(text, type = "success") {
  clearTimeout(messageTimer);
  message.text = text;
  message.type = type;
  messageTimer = setTimeout(() => { message.text = ""; }, 4500);
}

async function loadAccounts() {
  const result = await bridge.listAutomationAccounts();
  accounts.value = result.accounts || [];
  maxConcurrent.value = result.maxConcurrentAccounts || 3;
  if (!accounts.value.some((item) => item.id === selectedAccountId.value)) {
    selectedAccountId.value = result.selectedAccountId || accounts.value[0]?.id || "";
  }
}

function appendLog(entry) {
  logs.value.push({ ...entry, id: `${Date.now()}-${Math.random()}` });
  if (logs.value.length > 500) logs.value.splice(0, logs.value.length - 500);
}

function handleState(state) {
  const account = accounts.value.find((item) => item.id === state.accountId);
  if (account) {
    account.running = Boolean(state.running);
    account.statusMessage = state.message || "";
    if (Number.isInteger(state.processedCount)) account.processedCount = state.processedCount;
  }
  notify(`${account?.name || "账号"}：${state.message || "状态已更新"}`);
}

async function startSelected() {
  const account = selectedAccount.value;
  if (!account || busy.value) return;
  if (!props.globalSettings.hasApiKey) {
    notify("请先在全局设置中配置API密钥", "error");
    emit("open-settings");
    return;
  }
  busy.value = true;
  try {
    await bridge.startAutomation({
      accountId: account.id,
      accountName: account.name,
      submissionLimit: Number(account.submissionLimit),
      startPage: Number(account.startPage),
    });
    account.running = true;
    account.statusMessage = "正在启动浏览器";
    notify(`“${account.name}”已启动，首次使用请在打开的浏览器中登录百度`);
  } catch (error) { notify(error.message || String(error), "error"); }
  finally { busy.value = false; }
}

async function stopSelected() {
  const account = selectedAccount.value;
  if (!account || busy.value) return;
  busy.value = true;
  try {
    await bridge.stopAutomation(account.id);
    notify(`正在停止“${account.name}”`);
  } catch (error) { notify(error.message || String(error), "error"); }
  finally { busy.value = false; }
}

async function stopAll() {
  if (!runningCount.value || busy.value) return;
  busy.value = true;
  try { await bridge.stopAllAutomations(); notify("已向全部运行账号发送停止指令"); }
  catch (error) { notify(error.message || String(error), "error"); }
  finally { busy.value = false; }
}

async function createAccount() {
  if (!newAccountName.value.trim() || busy.value) return;
  busy.value = true;
  try {
    const account = await bridge.createAutomationAccount(newAccountName.value);
    accounts.value.push(account);
    selectedAccountId.value = account.id;
    newAccountName.value = "";
    adding.value = false;
    notify(`已创建“${account.name}”`);
  } catch (error) { notify(error.message || String(error), "error"); }
  finally { busy.value = false; }
}

async function deleteSelected() {
  const account = selectedAccount.value;
  if (!account || account.id === "default" || busy.value) return;
  pendingDeleteAccount.value = { id: account.id, name: account.name };
  deleteConfirmOpen.value = true;
}

function closeDeleteConfirm() {
  if (busy.value) return;
  deleteConfirmOpen.value = false;
  pendingDeleteAccount.value = null;
}

async function confirmDeleteSelected() {
  const pending = pendingDeleteAccount.value;
  if (!pending || busy.value) return;
  const account = accounts.value.find((item) => item.id === pending.id);
  if (!account || account.id === "default") {
    closeDeleteConfirm();
    return;
  }
  if (account.running) {
    closeDeleteConfirm();
    notify("请先停止该账号的答题任务，再执行删除", "error");
    return;
  }
  busy.value = true;
  try {
    const result = await bridge.deleteAutomationAccount({ accountId: account.id, deleteData: true });
    accounts.value = result.accounts;
    selectedAccountId.value = result.selectedAccountId;
    notify(`已删除“${account.name}”及其本地数据`);
  } catch (error) { notify(error.message || String(error), "error"); }
  finally {
    busy.value = false;
    deleteConfirmOpen.value = false;
    pendingDeleteAccount.value = null;
  }
}

async function openPage(type) {
  const account = selectedAccount.value;
  if (!account) return;
  try {
    await bridge.openAutomationPage({ accountId: account.id, type });
    notify(type === "workbench" ? "已打开答主工作台" : "已打开答题记录");
  } catch (error) { notify(error.message || String(error), "error"); }
}

async function clearProgress() {
  const account = selectedAccount.value;
  if (!account || account.running) return;
  if (!window.confirm(`确定清空“${account.name}”的已处理题目记录吗？清空后可能再次回答以前处理过的题目。`)) return;
  try {
    await bridge.clearAutomationProgress(account.id);
    account.processedCount = 0;
    notify("答题进度已清空");
  } catch (error) { notify(error.message || String(error), "error"); }
}

async function openData() {
  const account = selectedAccount.value;
  if (!account) return;
  try { await bridge.openAutomationData(account.id); }
  catch (error) { notify(error.message || String(error), "error"); }
}

onMounted(async () => {
  unsubscribeLog = bridge.onAutomationLog(appendLog);
  unsubscribeState = bridge.onAutomationState(handleState);
  try { await loadAccounts(); }
  catch (error) { notify(`自动答题初始化失败：${error.message || error}`, "error"); }
});

onBeforeUnmount(() => {
  unsubscribeLog?.();
  unsubscribeState?.();
  clearTimeout(messageTimer);
});
</script>

<template>
  <div class="automation-page">
    <section class="automation-summary">
      <div><span>AUTOMATION</span><h2>百度知道自动答题</h2><p>自动读取情感类问题，调用当前全局AI模型生成回答，并在可见浏览器中提交。</p></div>
      <div class="summary-metrics"><div><strong>{{ accounts.length }}</strong><span>账号</span></div><div><strong>{{ runningCount }}/{{ maxConcurrent }}</strong><span>运行中</span></div><div><strong>{{ selectedAccount?.processedCount || 0 }}</strong><span>已处理</span></div></div>
    </section>
    <section v-if="selectedAccount" class="automation-panel tools-panel">
      <div><strong>账号工具</strong><span>使用“{{ selectedAccount.name }}”的独立浏览器登录状态</span></div>
      <button @click="openPage('history')">查询答题记录</button><button @click="openPage('workbench')">打开答主工作台</button><button @click="openData">打开本地数据</button><button :disabled="selectedAccount.running" @click="clearProgress">清空答题进度</button>
    </section>

    <div class="automation-grid">
      <section class="automation-panel account-panel">
        <div class="panel-title">
          <div><span>ACCOUNT</span><h3>账号与运行设置</h3></div>
          <div class="automation-notice-slot">
            <div v-if="message.text" class="automation-notice" :class="message.type" :title="message.text">{{ message.text }}</div>
          </div>
          <div class="account-title-actions">
            <button v-if="selectedAccount?.id !== 'default'" class="delete-account" :disabled="selectedAccount?.running || busy" @click="deleteSelected">删除账号</button>
            <button @click="adding = !adding">新增账号</button>
          </div>
        </div>
        <div v-if="adding" class="add-account-row"><input v-model.trim="newAccountName" maxlength="30" placeholder="例如：工作账号2" @keyup.enter="createAccount"/><button :disabled="busy || !newAccountName" @click="createAccount">创建</button><button @click="adding = false">取消</button></div>
        <label class="automation-field"><span>当前百度账号</span><select v-model="selectedAccountId" :disabled="busy"><option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.name }}{{ account.running ? " · 运行中" : "" }}</option></select></label>
        <template v-if="selectedAccount">
          <label class="automation-field"><span>账号名称</span><input v-model.trim="selectedAccount.name" maxlength="30" :disabled="selectedAccount.running || busy" /></label>
          <div class="number-fields">
            <label class="automation-field"><span>每轮回答数量</span><input v-model.number="selectedAccount.submissionLimit" type="number" min="1" max="100" :disabled="selectedAccount.running || busy" /></label>
            <label class="automation-field"><span>起始页码</span><input v-model.number="selectedAccount.startPage" type="number" min="1" :disabled="selectedAccount.running || busy" /></label>
          </div>
          <div class="prompt-risk-notice"><span>!</span><div><strong>建议配置自己的答题提示词</strong><small>长期使用相同提示词容易造成回答同质化，可能增加账号处罚或封禁风险。</small></div><button @click="$emit('open-settings', 'prompt')">快捷设置提示词</button></div>
          <div class="api-status" :class="{ ready: globalSettings.hasApiKey }"><i></i><div><strong>{{ globalSettings.hasApiKey ? "答题接口已配置" : "AI接口未配置" }}</strong><span>答题专用模型：{{ globalSettings.answerModel || "gpt-5.6-sol" }}</span></div><button @click="$emit('open-settings', 'model')">{{ globalSettings.hasApiKey ? "模型与提示词" : "去设置" }}</button></div>
          <button v-if="!selectedAccount.running" class="start-automation" :disabled="busy" @click="startSelected">启动自动答题</button>
          <button v-else class="stop-automation" :disabled="busy" @click="stopSelected">停止当前账号</button>
          <div class="account-state"><span :class="{ running: selectedAccount.running }"></span>{{ selectedAccount.statusMessage || (selectedAccount.running ? "任务运行中" : "等待开始") }}</div>
        </template>
      </section>

      <section class="automation-panel log-panel">
        <div class="panel-title"><div><span>LIVE LOG</span><h3>运行日志</h3></div><div class="log-actions"><button :disabled="!runningCount || busy" @click="stopAll">停止全部</button><button @click="logs = []">清空日志</button></div></div>
        <div class="automation-log"><p v-if="!logs.length">任务启动后，登录提示、当前题目、AI生成和提交状态会显示在这里。</p><div v-for="entry in logs" :key="entry.id" :class="entry.level"><time>{{ new Date(entry.at || Date.now()).toLocaleTimeString('zh-CN', { hour12: false }) }}</time><strong>[{{ entry.accountName }}]</strong><span>{{ entry.text }}</span></div></div>
      </section>
    </div>


    <Teleport to="body">
      <div v-if="deleteConfirmOpen" class="detail-backdrop" @click.self="closeDeleteConfirm">
        <section class="confirm-dialog">
          <div class="confirm-icon">!</div>
          <h2>删除这个账号？</h2>
          <p>将删除“{{ pendingDeleteAccount?.name }}”的账号配置，同时清除该账号保存在本机的浏览器登录资料和答题进度。此操作无法撤销。</p>
          <div class="confirm-actions">
            <button class="secondary-button" :disabled="busy" @click="closeDeleteConfirm">取消</button>
            <button class="danger-button" :disabled="busy" @click="confirmDeleteSelected">{{ busy ? "正在删除…" : "确认删除" }}</button>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.automation-page{display:flex;flex-direction:column;gap:16px}.automation-summary,.automation-panel{border:1px solid #e0e8f2;border-radius:16px;background:#fff;box-shadow:0 8px 24px rgba(21,46,78,.05)}.automation-summary{display:flex;justify-content:space-between;align-items:center;padding:22px 24px}.automation-summary>div:first-child>span,.panel-title span{color:#7790ad;font-size:9px;font-weight:800;letter-spacing:.14em}.automation-summary h2{margin:5px 0 6px;color:#102946;font-size:22px}.automation-summary p{margin:0;color:#718096;font-size:11px}.summary-metrics{display:flex;gap:8px}.summary-metrics div{min-width:88px;padding:11px 16px;border-radius:11px;text-align:center;background:#f3f7fc}.summary-metrics strong,.summary-metrics span{display:block}.summary-metrics strong{color:#175dcc;font-size:20px}.summary-metrics span{margin-top:3px;color:#8290a3;font-size:9px}.automation-notice{padding:10px 14px;border-radius:10px;color:#176c4c;background:#eaf9f2;font-size:11px}.automation-notice.error{color:#b4232f;background:#fff0f1}.automation-grid{display:grid;grid-template-columns:minmax(310px,.82fr) minmax(480px,1.5fr);gap:16px}.automation-panel{padding:19px 20px}.panel-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:15px}.panel-title h3{margin:4px 0 0;color:#17314f;font-size:15px}.panel-title button,.tools-panel button,.add-account-row button{height:30px;padding:0 10px;border:1px solid #d8e3ef;border-radius:7px;color:#45617f;background:#fff;font-size:9px}.add-account-row{display:grid;grid-template-columns:1fr auto auto;gap:7px;margin-bottom:12px}.add-account-row input,.automation-field input,.automation-field select{width:100%;height:38px;padding:0 11px;border:1px solid #d8e2ed;border-radius:8px;color:#183450;background:#fff;outline:0}.automation-field{display:block;margin-bottom:12px}.automation-field>span{display:block;margin-bottom:6px;color:#52677f;font-size:10px;font-weight:700}.number-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}.api-status{display:flex;align-items:center;gap:9px;margin:4px 0 12px;padding:10px;border-radius:9px;color:#9b5e1c;background:#fff7e9}.api-status.ready{color:#287356;background:#eef9f4}.api-status i{width:8px;height:8px;border-radius:50%;background:currentColor}.api-status div{min-width:0;flex:1}.api-status strong,.api-status span{display:block}.api-status strong{font-size:10px}.api-status span{margin-top:3px;font-size:9px;opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.api-status button{border:0;color:inherit;background:transparent;font-size:9px}.start-automation,.stop-automation{width:100%;height:42px;border:0;border-radius:9px;color:#fff;background:#2563df;font-size:11px;font-weight:800;box-shadow:0 7px 15px rgba(37,99,223,.2)}.stop-automation{background:#c83f4c}.account-state{display:flex;align-items:center;gap:7px;margin-top:10px;color:#7a899b;font-size:9px}.account-state span{width:7px;height:7px;border-radius:50%;background:#aab6c4}.account-state span.running{background:#20b47a;box-shadow:0 0 0 4px #e5f8f0}.log-panel{min-width:0}.log-actions{display:flex;gap:7px}.automation-log{height:326px;padding:12px;border-radius:10px;overflow:auto;color:#cbd7e5;background:#102942;font:10px/1.65 Consolas,"Microsoft YaHei",sans-serif}.automation-log>p{color:#7890a9}.automation-log>div{display:grid;grid-template-columns:62px auto 1fr;gap:7px;padding:3px 0}.automation-log time{color:#6f89a2}.automation-log strong{color:#72aaff}.automation-log .error span{color:#ff9da6}.tools-panel{display:flex;align-items:center;gap:8px}.tools-panel>div{min-width:210px;margin-right:auto}.tools-panel strong,.tools-panel span{display:block}.tools-panel strong{color:#183450;font-size:12px}.tools-panel span{margin-top:4px;color:#8491a2;font-size:9px}.tools-panel .delete-account{color:#c73a46;border-color:#efc6ca}.automation-panel button:disabled,.start-automation:disabled,.stop-automation:disabled{opacity:.45;cursor:not-allowed}@media(max-width:1180px){.automation-grid{grid-template-columns:1fr}.tools-panel{flex-wrap:wrap}.tools-panel>div{width:100%;margin-bottom:5px}}
.automation-notice-slot {
  min-width: 0;
  height: 30px;
  flex: 1;
  margin-left: auto;
}

.automation-notice {
  height: 30px;
  padding: 0 9px;
  overflow: hidden;
  font-size: 9px;
  line-height: 30px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.account-panel .panel-title {
  gap: 8px;
}

.prompt-risk-notice { display: grid; grid-template-columns: 27px minmax(0,1fr) auto; align-items: center; gap: 9px; margin: 2px 0 10px; padding: 10px; border: 1px solid #f2d4aa; border-radius: 9px; color: #895315; background: #fff8ec; }
.prompt-risk-notice > span { width: 27px; height: 27px; display: grid; place-items: center; border-radius: 50%; color: #fff; background: #e39a31; font-size: 13px; font-weight: 800; }
.prompt-risk-notice strong,.prompt-risk-notice small { display: block; }.prompt-risk-notice strong { font-size: 10px; }.prompt-risk-notice small { margin-top: 3px; color: #9a713d; font-size: 8px; line-height: 1.45; }
.prompt-risk-notice button { min-height: 30px; border: 1px solid #e3bc80; border-radius: 7px; color: #885210; background: #fff; padding: 0 9px; white-space: nowrap; font-size: 9px; font-weight: 700; }
.prompt-risk-notice button:hover { background: #fff2da; }

.account-title-actions {
  display: flex;
  flex: none;
  gap: 6px;
}

.account-title-actions .delete-account {
  color: #c73a46;
  border-color: #efc6ca;
  background: #fff8f8;
}
</style>
