const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { readSourceWorkbook, exportResultWorkbook, exportTransferShareWorkbook, validateBaiduLink, validateNetdiskLink } = require("../electron/excel-service.cjs");
const {
  rulesContent,
  normalizeIntro,
  normalizeTitle,
  normalizeGeneratedTitle,
  answerHtml,
  charLength,
} = require("../electron/content-engine.cjs");
const { TaskDatabase } = require("../electron/database.cjs");
const { TaskRunner } = require("../electron/task-runner.cjs");
const { extractTransferTargets } = require("../electron/baidu-netdisk-service.cjs");
const {
  FIXED_API_BASE,
  API_KEY_GUIDE_URL,
  USER_GUIDE_URL,
  DEFAULT_MODEL,
  normalizeModel,
} = require("../electron/service-config.cjs");

(async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wangpan-qa-smoke-"));
  try {
    assert.equal(FIXED_API_BASE, "https://geekai.co/api/v1");
    assert.equal(API_KEY_GUIDE_URL, "https://geekai.co/user/api_keys?invite_code=uhALz3");
    assert.equal(USER_GUIDE_URL, "https://my.feishu.cn/wiki/OO0awsLKPiPbkskQhHHc4nfwnUg?from=from_copylink");
    assert.equal(DEFAULT_MODEL, "glm-4-flash");
    assert.equal(normalizeModel(""), DEFAULT_MODEL);
    assert.equal(normalizeModel("doubao-seed-2.0-mini"), "doubao-seed-2.0-mini");
    assert.equal(normalizeModel("provider/custom-model-v1"), "provider/custom-model-v1");
    assert.equal(normalizeModel("invalid model name"), DEFAULT_MODEL);
    assert.equal(normalizeModel("glm-5.2"), "glm-5.2");
    const transferTargets = extractTransferTargets({
      extra: { list: [{
        from: "/食物水果拼豆图纸",
        from_fs_id: "1043907219865730",
        to: "/测试1/食物水果拼豆图纸",
        to_fs_id: "797727681713471",
      }] },
      info: [{ fsid: "1043907219865730", path: "/食物水果拼豆图纸" }],
    });
    assert.deepEqual(transferTargets.savedFsIds, ["797727681713471"]);
    assert.deepEqual(transferTargets.savedPaths, ["/测试1/食物水果拼豆图纸"]);
    assert.deepEqual(transferTargets.names, ["食物水果拼豆图纸"]);
    const repairedBookIntro = normalizeIntro("过短简介", "修罗武神 小说.txt");
    const repairedMediaIntro = normalizeIntro("过短简介", "示例电视剧全集.mp4");
    const repairedStudyIntro = normalizeIntro("过短简介", "六年级数学复习资料.pdf");
    for (const intro of [repairedBookIntro, repairedMediaIntro, repairedStudyIntro]) {
      assert.ok(charLength(intro) >= 180 && charLength(intro) <= 220);
    }
    const stableTitleA = normalizeTitle("AI随机生成的第一种标题", "【01】 红色基因主题学习资料.pdf");
    const stableTitleB = normalizeTitle("完全不同的咨询方式", "【01】 红色基因主题学习资料.pdf");
    assert.equal(stableTitleA, stableTitleB);
    assert.equal(stableTitleA, "求红色基因主题学习资料完整网盘链接获取");
    assert.ok(charLength(stableTitleA) >= 5 && charLength(stableTitleA) <= 49);
    assert.equal(
      normalizeGeneratedTitle("红色基因主题学习资料的百度网盘链接在哪里获取", "【01】 红色基因主题学习资料.pdf", "ai"),
      "红色基因主题学习资料的百度网盘链接在哪里获取",
    );
    assert.equal(
      normalizeGeneratedTitle("这份学习资料的网盘链接在哪里获取", "【01】 红色基因主题学习资料.pdf", "ai"),
      stableTitleA,
    );
    assert.equal(normalizeGeneratedTitle("任意AI标题", "【01】 红色基因主题学习资料.pdf", "fixed"), stableTitleA);

    const sourcePath = path.join(tempDir, "source.xlsx");
    const sourceBook = new ExcelJS.Workbook();
    const sourceSheet = sourceBook.addWorksheet("资源");
    sourceSheet.addRow(["任意表头一", "任意表头二"]);
    sourceSheet.addRow(["六年级下册北师大版数学教材巧解.pdf", "https://pan.baidu.com/s/example1?pwd=abcd"]);
    sourceSheet.addRow(["", "https://pan.baidu.com/s/example2?pwd=abcd"]);
    sourceSheet.mergeCells("A2:A3");
    await sourceBook.xlsx.writeFile(sourcePath);

    const parsed = await readSourceWorkbook(sourcePath);
    assert.equal(parsed.isValid, true);
    assert.equal(parsed.headerRow, 1);
    assert.equal(parsed.total, 2);
    assert.equal(parsed.rows[0].name, parsed.rows[1].name);
    assert.equal(parsed.rows[1].sourceRow, 3);
    assert.equal(validateBaiduLink("https://example.com/file?pwd=abcd").valid, false);
    assert.equal(validateBaiduLink("https://pan.baidu.com/s/example-without-code").valid, false);
    assert.equal(validateBaiduLink("链接：https://pan.baidu.com/s/example 提取码：a1b2").valid, true);
    assert.equal(validateNetdiskLink("https://pan.quark.cn/s/example").provider, "quark");
    assert.equal(validateNetdiskLink("https://pan.xunlei.com/s/example?pwd=a1b2").provider, "xunlei");
    assert.equal(validateNetdiskLink("https://pan.quark.cn/list#/example").valid, false);

    const invalidPath = path.join(tempDir, "invalid.xlsx");
    const invalidBook = new ExcelJS.Workbook();
    const invalidSheet = invalidBook.addWorksheet("错误数据");
    invalidSheet.addRow(["资源名称", "资源链接"]);
    invalidSheet.addRow(["测试资料.pdf", "https://example.com/not-baidu"]);
    await invalidBook.xlsx.writeFile(invalidPath);
    const invalidParsed = await readSourceWorkbook(invalidPath);
    assert.equal(invalidParsed.isValid, false);
    assert.equal(invalidParsed.total, 0);
    assert.equal(invalidParsed.issues[0].type, "invalid-link");

    const legacyPath = path.join(tempDir, "tasks.json");
    const database = new TaskDatabase(path.join(tempDir, "tasks.sqlite"), { legacyJsonPath: legacyPath });
    const task = database.createTask({
      id: "smoke-task",
      fileName: "source.xlsx",
      sourcePath,
      sheetName: parsed.sheetName,
      mode: "rules",
      options: { mode: "rules", concurrency: 2, maxAttempts: 2 },
      createdAt: new Date().toISOString(),
    }, parsed.rows);
    assert.equal(task.total, 2);
    database.markRowRunning(1);
    const runningRows = database.getTaskRows(task.id, { status: "running" });
    assert.equal(runningRows.total, 1);
    assert.equal(runningRows.items[0].sourceRow, 2);
    database.recoverInterruptedTasks();
    const runner = new TaskRunner(database, async () => "", () => {});
    await runner.start(task.id);
    const finished = database.getTask(task.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.completed, 2);
    assert.equal(finished.failed, 0);
    assert.equal(finished.currentItems.length, 0);
    assert.equal(finished.recentItems.length, 2);
    assert.equal(finished.recentItems[0].status, "completed");
    const pagedRows = database.getTaskRows(task.id, {
      page: 1,
      pageSize: 20,
      status: "completed",
      query: "六年级",
    });
    assert.equal(pagedRows.total, 2);
    assert.equal(pagedRows.items.length, 2);
    assert.equal(pagedRows.counts.completed, 2);
    assert.match(String(pagedRows.items[0].answer), /<p>/);
    assert.equal(database.getTaskRows(task.id, { query: "不存在的素材" }).total, 0);

    const initialAudit = database.getTaskAudit(task.id);
    assert.equal(initialAudit.canExport, true);
    assert.equal(initialAudit.incomplete, 0);
    assert.equal(initialAudit.invalidHtml, 0);
    const firstCompletedRow = database.getTaskRows(task.id, { status: "completed" }).items[0];
    const edited = database.updateRowContent(task.id, firstCompletedRow.id, {
      title: "六年级数学资料完整网盘链接获取",
      answer: firstCompletedRow.answer,
    });
    assert.equal(edited.title, "六年级数学资料完整网盘链接获取");
    assert.throws(() => database.updateRowContent(task.id, edited.id, {
      title: "太短",
      answer: edited.answer,
    }), /5～49/);
    const regenerated = await runner.regenerateRow(task.id, edited.id);
    assert.equal(regenerated.status, "completed");
    assert.ok(regenerated.title);
    const batchIds = database.getTaskRows(task.id, { status: "completed" }).items.map((row) => row.id);
    const batchRegenerated = await runner.regenerateRows(task.id, batchIds);
    assert.equal(batchRegenerated.processed, 2);
    assert.equal(batchRegenerated.task.completed, 2);
    database.updateTaskOptions(task.id, {
      mode: "rules",
      model: "provider/new-task-model",
      concurrency: 25,
      maxAttempts: 4,
    });
    const taskWithNewOptions = database.getTask(task.id);
    assert.equal(taskWithNewOptions.options.model, "provider/new-task-model");
    assert.equal(taskWithNewOptions.options.concurrency, 25);
    assert.equal(taskWithNewOptions.options.maxAttempts, 4);
    assert.equal(runner.taskSettings(taskWithNewOptions).model, "provider/new-task-model");
    assert.equal(runner.taskSettings(taskWithNewOptions).concurrency, 25);

    const resumeTask = database.createTask({
      id: "resume-task",
      fileName: "resume.xlsx",
      sourcePath,
      sheetName: parsed.sheetName,
      mode: "rules",
      options: { mode: "rules", concurrency: 1, maxAttempts: 2 },
      createdAt: new Date(Date.now() + 1000).toISOString(),
    }, parsed.rows.slice(0, 1));
    database.markRowRunning(database.getTaskRows(resumeTask.id).items[0].id);
    database.setTaskStatus(resumeTask.id, "running", { resumeOnLaunch: true });
    const resumable = database.recoverInterruptedTasks();
    assert.deepEqual(resumable, [resumeTask.id]);
    assert.equal(database.getTask(resumeTask.id).status, "paused");
    assert.equal(database.getTaskRows(resumeTask.id).counts.pending, 1);
    const resumeRowId = database.getTaskRows(resumeTask.id).items[0].id;
    const deleteResult = database.deleteRows(resumeTask.id, [resumeRowId]);
    assert.equal(deleteResult.deleted, 1);
    assert.equal(deleteResult.task.total, 0);
    assert.equal(database.getTaskAudit(resumeTask.id).total, 0);

    const completed = parsed.rows.map((row) => {
      const content = rulesContent(row.name);
      assert.ok(charLength(content.title) >= 5 && charLength(content.title) <= 49);
      assert.ok(content.title.includes("网盘链接获取"));
      return {
        ...row,
        ...content,
        answer: answerHtml(row.link, content.intro),
      };
    });

    const outputPath = path.join(tempDir, "output.xlsx");
    await exportResultWorkbook(completed, outputPath);
    const outputBook = new ExcelJS.Workbook();
    await outputBook.xlsx.readFile(outputPath);
    const outputSheet = outputBook.worksheets[0];
    assert.equal(outputSheet.rowCount, 3);
    assert.equal(outputSheet.name, "Sheet1");
    assert.equal(outputSheet.columnCount, 6);
    assert.deepEqual(outputSheet.getRow(1).values.slice(1), ["qid", "问题标题", "一级分类", "二级分类", "问题发布时间", "回答内容"]);
    assert.equal(outputSheet.getCell("A1").font.name, "宋体");
    assert.equal(outputSheet.getCell("A1").font.bold, true);
    assert.equal(outputSheet.getCell("F1").fill.fgColor.argb, "FFD9E1F2");
    assert.equal(outputSheet.getCell("A2").value, null);
    assert.equal(outputSheet.getCell("C2").value, null);
    assert.equal(outputSheet.getCell("D2").value, null);
    assert.equal(outputSheet.getCell("E2").value, null);
    assert.match(String(outputSheet.getCell("F3").value), /example2/);
    const transferOutputPath = path.join(tempDir, "transfer-results.xlsx");
    await exportTransferShareWorkbook([
      { name: "食物水果拼豆图纸", link: "https://pan.baidu.com/s/example?pwd=abcd" },
    ], transferOutputPath);
    const transferBook = new ExcelJS.Workbook();
    await transferBook.xlsx.readFile(transferOutputPath);
    const transferSheet = transferBook.worksheets[0];
    assert.equal(transferSheet.columnCount, 2);
    assert.equal(transferSheet.getCell("A1").value, "资源名称");
    assert.equal(transferSheet.getCell("B1").value, "分享链接");
    assert.equal(transferSheet.getCell("A2").value, "食物水果拼豆图纸");
    assert.equal(transferSheet.getCell("B2").value, "https://pan.baidu.com/s/example?pwd=abcd");
    database.close();
    const reopened = new TaskDatabase(path.join(tempDir, "tasks.sqlite"), { legacyJsonPath: legacyPath });
    assert.equal(reopened.getTask(task.id).completed, 2);
    assert.equal(reopened.getTaskRows(task.id).total, 2);
    reopened.close();
    console.log("Smoke test passed: merged-cell fill, row split, content generation, validation and export.");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
