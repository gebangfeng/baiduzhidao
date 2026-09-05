const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { AutomationAnswerService } = require("../electron/automation-service.cjs");
const { categories } = require("../electron/automation-categories.cjs");

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "automation-category-test-"));
  let saved = { version: 1, selectedAccountId: "default", accounts: [
    { id: "default", name: "默认账号", submissionLimit: 10, startPage: 1 },
  ] };
  const options = {
    app: { getPath: () => directory, isPackaged: false },
    database: {
      getSetting: () => structuredClone(saved),
      setSetting: (_key, value) => { saved = structuredClone(value); },
    },
    getApiKey: async () => "test-api-key",
    getSettings: () => ({ baseUrl: "https://example.com/v1" }),
    notify: () => {},
  };
  try {
    const service = new AutomationAnswerService(options);
    assert.equal(service.listAccounts().accounts[0].category, "emotion", "old accounts retain the emotion default");
    const other = service.createAccount("第二账号");
    assert.equal(other.category, "emotion");
    let captured;
    service.forkWorker = (file, account, env) => {
      captured = { file, account, env };
      return new EventEmitter();
    };
    service.waitForSpawn = async () => {};
    for (const category of categories) {
      await service.start({ accountId: "default", submissionLimit: 5, startPage: 2, category: category.id });
      assert.equal(captured.file, "automation-worker.cjs");
      assert.equal(captured.env.ANSWER_CATEGORY, category.id);
      assert.equal(captured.env.START_PAGE, "2");
      assert.equal(new AutomationAnswerService(options).listAccounts().accounts[0].category, category.id);
      assert.equal(service.getAccount(other.id).category, "emotion", "account settings are independent");
      service.automationProcesses.clear();
    }
    service.updateAccount({ accountId: "default", submissionLimit: 5, startPage: 1 });
    assert.equal(service.getAccount("default").category, "general", "omitted category preserves saved choice");
    await assert.rejects(service.start({ accountId: "default", submissionLimit: 5, startPage: 1, category: "invalid" }), /有效的答题分类/);
    assert.equal(service.getAccount("default").category, "general", "invalid category is not saved");
    console.log("PASS category defaults, persistence, account isolation, validation and worker launch configuration");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
