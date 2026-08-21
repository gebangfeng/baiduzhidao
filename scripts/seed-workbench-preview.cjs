const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TaskDatabase } = require("../electron/database.cjs");

const previewDir = path.join(os.tmpdir(), "wangpan-qa-studio-capture");
const resolvedPreviewDir = path.resolve(previewDir);
if (resolvedPreviewDir !== path.resolve(os.tmpdir(), "wangpan-qa-studio-capture")) {
  throw new Error("预览数据目录校验失败");
}
fs.rmSync(resolvedPreviewDir, { recursive: true, force: true });

const database = new TaskDatabase(path.join(resolvedPreviewDir, "tasks.json"));
const taskId = "workbench-preview";
const now = new Date().toISOString();
const rows = Array.from({ length: 34 }, (_, index) => ({
  sourceRow: index + 2,
  name: `${index + 1}. 示例素材名称：课程资料与配套讲义第${index + 1}册.pdf`,
  link: `https://pan.baidu.com/s/example${index + 1}?pwd=a${String(index).padStart(3, "0").slice(-3)}`,
}));

database.createTask({
  id: taskId,
  fileName: "网盘素材批量导入示例.xlsx",
  sourcePath: "C:/示例/网盘素材批量导入示例.xlsx",
  sheetName: "Sheet1",
  mode: "ai",
  options: {
    mode: "ai",
    baseUrl: "https://geekai.co/api/v1",
    model: "doubao-seed-2.0-mini",
    concurrency: 15,
    maxAttempts: 3,
  },
  createdAt: now,
}, rows);

for (let index = 0; index < 25; index += 1) {
  database.markRowSuccess(index + 1, taskId, {
    title: `示例素材第${index + 1}册完整版百度网盘链接获取`,
    intro: "用于界面预览的示例简介。",
    answer: `<p><strong>点击链接获取完整素材：</strong><br/></p><p>${rows[index].link}<br/></p><p>用于界面预览的示例简介。</p>`,
  });
}
database.markRowFailed(26, taskId, "接口请求超时，将在重试后继续处理");
database.markRowFailed(27, taskId, "模型返回内容格式不完整");
database.setTaskStatus(taskId, "paused");
database.close();
