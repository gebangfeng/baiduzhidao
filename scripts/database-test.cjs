const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TaskDatabase } = require("../electron/database.cjs");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wangpan-sqlite-test-"));
const legacyPath = path.join(tempDir, "tasks.json");
const sqlitePath = path.join(tempDir, "tasks.sqlite");

try {
  fs.writeFileSync(legacyPath, JSON.stringify({
    settings: { generation: { mode: "rules" } },
    tasks: [{ id: "legacy", fileName: "old.xlsx", sourcePath: "old.xlsx", sheetName: "Sheet1", status: "paused", mode: "rules", total: 1, completed: 0, failed: 0, outputPath: null, resumeOnLaunch: false, options: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    rows: [{ id: 7, taskId: "legacy", sourceRow: 2, name: "旧数据", link: "https://pan.baidu.com/s/old?pwd=abcd", title: null, intro: null, answer: null, status: "pending", attempts: 0, error: null, updatedAt: "2026-01-01T00:00:00.000Z" }],
    cache: {}, nextRowId: 8,
  }));
  let db = new TaskDatabase(sqlitePath, { legacyJsonPath: legacyPath });
  assert.equal(db.getTask("legacy").total, 1);
  assert.equal(db.getRow("legacy", 7).name, "旧数据");
  assert.deepEqual(db.getSetting("generation"), { mode: "rules" });
  assert.equal(fs.existsSync(`${legacyPath}.migrated`), true);
  const now = new Date().toISOString();
  db.createTask({ id: "new", fileName: "new.xlsx", sourcePath: "new.xlsx", sheetName: "Sheet1", mode: "rules", options: {}, createdAt: now }, [{ sourceRow: 2, name: "新数据", link: "https://pan.baidu.com/s/new?pwd=abcd" }]);
  const row = db.getTaskRows("new").items[0];
  db.markRowRunning(row.id);
  db.markRowFailed(row.id, "new", "测试失败");
  assert.equal(db.getTask("new").failed, 1);
  db.resetFailed("new");
  assert.equal(db.getTaskRows("new").counts.pending, 1);
  db.close();
  db = new TaskDatabase(sqlitePath, { legacyJsonPath: legacyPath });
  assert.equal(db.getTaskRows("legacy").total, 1);
  assert.equal(db.getTaskRows("new").total, 1);
  db.close();
  console.log("Database test passed: JSON migration and SQLite persistence.");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
