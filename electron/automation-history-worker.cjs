const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const ANSWER_HISTORY_URL =
  "https://zhidao.baidu.com/ihome/homepage/myanwser";
const CREATOR_WORKBENCH_URL =
  "https://zhidao.baidu.com/b/batch/batch-upload";
const initialPageUrl =
  process.env.INITIAL_PAGE_URL?.trim() || ANSWER_HISTORY_URL;
const initialPageLabel =
  process.env.INITIAL_PAGE_LABEL?.trim() || "答题记录";
const automationDataDirectory = process.env.AUTOMATION_DATA_DIR?.trim();
const userDataDirectory = automationDataDirectory
  ? path.join(automationDataDirectory, "browser-profile")
  : "";

let context;
let resolveStopSignal;
let accountPageOpening = false;
const stopSignal = new Promise((resolve) => {
  resolveStopSignal = resolve;
});

async function openAccountPage(url, label) {
  if (!context) {
    console.error(`打开${label}失败：浏览器尚未启动完成。`);
    return;
  }
  if (accountPageOpening) {
    console.log("正在打开其他账号工具页面，请稍候。");
    return;
  }
  accountPageOpening = true;
  let page;
  try {
    page = await context.newPage();
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.bringToFront();
    console.log(`已打开当前账号的${label}。`);
  } catch (error) {
    console.error(`打开${label}失败：${error.message}`);
    await page?.close().catch(() => {});
  } finally {
    accountPageOpening = false;
  }
}

if (process.send) {
  process.on("message", (message) => {
    if (message?.type === "open-answer-history") {
      void openAccountPage(ANSWER_HISTORY_URL, "答题记录页面");
      return;
    }
    if (message?.type === "open-creator-workbench") {
      void openAccountPage(CREATOR_WORKBENCH_URL, "答主工作台");
      return;
    }
    if (message?.type === "stop") {
      void context?.close().catch(() => {});
      resolveStopSignal();
    }
  });
}

async function main() {
  if (!automationDataDirectory) {
    throw new Error("缺少账号数据目录。");
  }
  fs.mkdirSync(automationDataDirectory, { recursive: true });

  const executablePath = chromium.executablePath();
  console.log(`Chromium 路径：${executablePath}`);
  if (!fs.existsSync(executablePath)) {
    throw new Error(`找不到应用自带的 Chromium：${executablePath}`);
  }
  context = await chromium.launchPersistentContext(userDataDirectory, {
    headless: false,
    viewport: null,
    executablePath,
    timeout: 30_000,
  });
  const initialPage = context.pages()[0];
  if (initialPage) {
    await initialPage.goto(initialPageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    console.log(`已打开当前账号的${initialPageLabel}。`);
  } else {
    await openAccountPage(initialPageUrl, initialPageLabel);
  }

  await Promise.race([
    context.waitForEvent("close", { timeout: 0 }),
    stopSignal,
  ]);
}

main()
  .catch((error) => {
    console.error(`打开答题记录失败：${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (process.connected) process.disconnect();
  });
