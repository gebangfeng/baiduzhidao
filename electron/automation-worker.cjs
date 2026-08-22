const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const TARGET_URL =
  process.argv[2] || "https://zhidao.baidu.com/hd/21th_activity/";
const ANSWER_HISTORY_URL =
  "https://zhidao.baidu.com/ihome/homepage/myanwser";
const CREATOR_WORKBENCH_URL =
  "https://zhidao.baidu.com/b/batch/batch-upload";
const AUTOMATION_DATA_DIR = process.env.AUTOMATION_DATA_DIR?.trim();
const USER_DATA_DIR = AUTOMATION_DATA_DIR
  ? path.join(AUTOMATION_DATA_DIR, "browser-profile")
  : path.join(__dirname, ".browser-profile");
const PROGRESS_FILE = AUTOMATION_DATA_DIR
  ? path.join(AUTOMATION_DATA_DIR, "question-progress.json")
  : path.join(__dirname, ".question-progress.json");
const AI_LOCK_FILE =
  process.env.AI_LOCK_FILE?.trim() ||
  path.join(__dirname, ".ai-request.lock");
const AI_API_URL = `${String(process.env.AI_API_BASE || "https://geekai.co/api/v1").replace(/\/+$/, "")}/chat/completions`;
const AI_MODEL = process.env.AI_MODEL?.trim() || "gpt-5.6-sol";
const configuredSubmissionLimit = Number.parseInt(
  process.env.AI_SUBMISSION_LIMIT || "10",
  10,
);
const AI_SUBMISSION_LIMIT =
  Number.isInteger(configuredSubmissionLimit) &&
  configuredSubmissionLimit >= 1 &&
  configuredSubmissionLimit <= 100
    ? configuredSubmissionLimit
    : 10;
const configuredStartPage = Number.parseInt(
  process.env.START_PAGE || "1",
  10,
);
const START_PAGE =
  Number.isInteger(configuredStartPage) && configuredStartPage >= 1
    ? configuredStartPage
    : 1;
const AI_MAX_ATTEMPTS = 4;
const AI_RETRY_BASE_DELAY_MS = 3_000;
const AI_REQUEST_TIMEOUT_MS = 120_000;
const AI_LOCK_STALE_MS = 15 * 60_000;
const AI_LOCK_WAIT_TIMEOUT_MS = 20 * 60_000;
const RETRYABLE_AI_STATUS_CODES = new Set([
  408, 429, 500, 502, 503, 504,
]);
const DEFAULT_SYSTEM_PROMPT = `请生成百度知道优质回答，只输出自然连贯的回答正文。
内容依次用自然段完成以下表达：先开门见山给出核心观点；再以第一人称亲身经历举例，贴近普通人生活；接着分析现象背后的深层原因；然后提供可落地、能直接执行的办法；最后延伸感悟，引发情感共鸣。

规则：
禁止输出任何段落标题、板块名称、方括号标签、总结标签或序号，例如“结论”“真实细节”“问题本质”“实操建议”“观点升华”等字样都不能作为段落开头；
直接从回答内容开始，使用自然段衔接，不使用项目符号；
语气为热心分享经验的普通网友，拒绝生硬教科书式文字；
内容贴合情感生活类问答，逻辑通顺，具备共情力；
不要过度口语化，满足平台优质回答审核标准；
回答尽量简洁。`;
const SYSTEM_PROMPT = process.env.ANSWER_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT;
let activeContext;
let stopRequested = false;
let accountPageOpening = false;

function findBundledChromiumExecutable() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.resourcesPath ? path.join(process.resourcesPath, "playwright-browsers") : "",
  ].map((item) => String(item || "").trim()).filter((item) => item && item !== "0");

  const relativePath = process.platform === "darwin"
    ? path.join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")
    : process.platform === "win32"
      ? path.join("chrome-win", "chrome.exe")
      : path.join("chrome-linux", "chrome");

  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const chromiumDirectories = entries
      .filter((entry) => entry.isDirectory() && /^chromium-\d+/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const directory of chromiumDirectories) {
      const executablePath = path.join(root, directory, relativePath);
      if (fs.existsSync(executablePath)) return executablePath;
    }
  }

  return chromium.executablePath();
}

async function openAccountPage(url, label) {
  if (!activeContext) {
    console.error(`打开${label}失败：浏览器尚未启动完成。`);
    return;
  }
  if (accountPageOpening) {
    console.log(`正在打开其他账号工具页面，请稍候。`);
    return;
  }
  accountPageOpening = true;
  let page;
  try {
    page = await activeContext.newPage();
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

async function safePageTitle(page) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    ensureNotStopped();
    try {
      return await page.title();
    } catch (error) {
      const navigationInterrupted =
        /Execution context was destroyed|navigation/i.test(error.message || "");
      if (!navigationInterrupted || attempt === 3) {
        throw error;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(500).catch(() => {});
    }
  }
  return "";
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
      stopRequested = true;
      console.log("收到停止指令，正在关闭浏览器。");
      void activeContext?.close().catch(() => {});
    }
  });
}

function ensureNotStopped() {
  if (stopRequested) {
    const stopError = new Error("任务已由用户停止。");
    stopError.name = "AutomationStoppedError";
    throw stopError;
  }
}

async function enterAnswerAreaAfterLogin(context, page) {
  const answerArea = page.getByText("答题区", { exact: true }).first();
  const loginDeadline = Date.now() + 15 * 60_000;
  let loginPromptShown = false;
  let lastRefreshTime = 0;

  while (Date.now() < loginDeadline) {
    ensureNotStopped();
    if (page.isClosed()) {
      const closedError = new Error("浏览器窗口已关闭。");
      closedError.name = "AutomationStoppedError";
      throw closedError;
    }

    if (!loginPromptShown) {
      console.log(
        "首次使用请在 Chromium 中完成百度登录，程序会自动等待，最长 15 分钟。",
      );
      loginPromptShown = true;
    }

    const cookies = await context.cookies().catch(() => []);
    const isLoggedIn = cookies.some(
      (cookie) =>
        cookie.name === "BDUSS" || cookie.name === "BDUSS_BFESS",
    );

    if (
      isLoggedIn &&
      (await answerArea.isVisible().catch(() => false))
    ) {
      try {
        await answerArea.click({
          timeout: 10_000,
          noWaitAfter: true,
        });
        await page.waitForTimeout(1_000);

        if (!page.url().includes("passport.baidu.com")) {
          console.log("已检测到登录状态并选择答题区。");
          return;
        }
        console.log("页面仍在登录流程中，继续等待登录完成。");
      } catch (error) {
        if (page.isClosed()) {
          const closedError = new Error("浏览器窗口已关闭。");
          closedError.name = "AutomationStoppedError";
          throw closedError;
        }
        console.log("答题区尚未稳定显示，继续等待登录完成。");
      }
    }

    if (isLoggedIn && Date.now() - lastRefreshTime >= 10_000) {
      console.log("已检测到百度登录状态，正在刷新活动页面。");
      lastRefreshTime = Date.now();
      if (page.url().startsWith(TARGET_URL)) {
        await page
          .reload({ waitUntil: "domcontentloaded", timeout: 60_000 })
          .catch(() => {});
      } else {
        await page
          .goto(TARGET_URL, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          })
          .catch(() => {});
      }
    }

    try {
      await page.waitForTimeout(2_000);
    } catch {
      const closedError = new Error("浏览器窗口已关闭。");
      closedError.name = "AutomationStoppedError";
      throw closedError;
    }
  }

  throw new Error("等待百度登录超时，请重新启动任务后再试。");
}

function loadProcessedQuestionTitles() {
  try {
    const savedTitles = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    return new Set(Array.isArray(savedTitles) ? savedTitles : []);
  } catch {
    return new Set();
  }
}

function saveProcessedQuestionTitles(processedQuestionTitles) {
  fs.writeFileSync(
    PROGRESS_FILE,
    `${JSON.stringify([...processedQuestionTitles], null, 2)}\n`,
    "utf8",
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function acquireAiRequestLock() {
  fs.mkdirSync(path.dirname(AI_LOCK_FILE), { recursive: true });
  const lockToken =
    `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + AI_LOCK_WAIT_TIMEOUT_MS;
  let waitingMessageShown = false;

  while (Date.now() < deadline) {
    ensureNotStopped();

    try {
      const lockHandle = fs.openSync(AI_LOCK_FILE, "wx");
      fs.writeFileSync(
        lockHandle,
        JSON.stringify({
          token: lockToken,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
        "utf8",
      );
      fs.closeSync(lockHandle);

      return () => {
        try {
          const lockData = JSON.parse(
            fs.readFileSync(AI_LOCK_FILE, "utf8"),
          );
          if (lockData.token === lockToken) {
            fs.unlinkSync(AI_LOCK_FILE);
          }
        } catch {
          // 锁文件可能已被清理，无需影响任务结束。
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      try {
        const lockData = JSON.parse(
          fs.readFileSync(AI_LOCK_FILE, "utf8"),
        );
        const lockStats = fs.statSync(AI_LOCK_FILE);
        const lockOwnerIsAlive = isProcessAlive(
          Number(lockData.pid),
        );
        if (
          !lockOwnerIsAlive ||
          Date.now() - lockStats.mtimeMs > AI_LOCK_STALE_MS
        ) {
          fs.unlinkSync(AI_LOCK_FILE);
          console.log("已清理失效的 AI 请求锁，继续执行。");
          continue;
        }
      } catch (lockReadError) {
        if (lockReadError.code === "ENOENT") continue;
        try {
          const lockStats = fs.statSync(AI_LOCK_FILE);
          if (Date.now() - lockStats.mtimeMs > AI_LOCK_STALE_MS) {
            fs.unlinkSync(AI_LOCK_FILE);
            console.log("已清理损坏的 AI 请求锁，继续执行。");
            continue;
          }
        } catch {
          continue;
        }
        await wait(200);
        continue;
      }

      if (!waitingMessageShown) {
        console.log(
          "其他账号正在生成回答，当前账号已进入队列等待。",
        );
        waitingMessageShown = true;
      }
      await wait(1_000);
    }
  }

  throw new Error("等待 AI 请求队列超时，请稍后重新运行。");
}

async function generateAnswer(questionTitle) {
  ensureNotStopped();
  const apiKey = process.env.GEEKAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "缺少 GEEKAI_API_KEY 环境变量，请配置新的 API 密钥后再运行。",
    );
  }

  const releaseAiRequestLock = await acquireAiRequestLock();
  try {
    console.log(`正在调用 AI 生成回答：${questionTitle}`);
    let lastError;

    for (let attempt = 1; attempt <= AI_MAX_ATTEMPTS; attempt += 1) {
      ensureNotStopped();
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        AI_REQUEST_TIMEOUT_MS,
      );

      try {
        console.log(`AI 请求第 ${attempt}/${AI_MAX_ATTEMPTS} 次。`);
        const response = await fetch(AI_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: AI_MODEL,
            messages: [
              {
                role: "system",
                content: SYSTEM_PROMPT,
              },
              {
                role: "user",
                content: `请回答下面这个百度知道问题，只输出回答正文：\n\n${questionTitle}`,
              },
            ],
          }),
          signal: controller.signal,
        });

        const responseText = await response.text();
        if (!response.ok) {
          const requestError = new Error(
            `AI 接口请求失败（${response.status}）：${responseText.slice(0, 300)}`,
          );
          requestError.retryable = RETRYABLE_AI_STATUS_CODES.has(
            response.status,
          );
          throw requestError;
        }

        let responseData;
        try {
          responseData = JSON.parse(responseText);
        } catch {
          const responseError = new Error(
            "AI 接口返回的内容不是有效 JSON。",
          );
          responseError.retryable = true;
          throw responseError;
        }

        const rawAnswer = responseData.choices?.[0]?.message?.content?.trim();
        const answer = removeAnswerSectionLabels(rawAnswer);
        if (!answer) {
          const emptyAnswerError = new Error(
            "AI 接口没有返回可用的回答正文。",
          );
          emptyAnswerError.retryable = true;
          throw emptyAnswerError;
        }
        if (answer.length > 2_000) {
          throw new Error(
            `AI 回答超过 2000 字限制，当前长度为 ${answer.length}。`,
          );
        }

        console.log(`AI 回答生成完成，共 ${answer.length} 个字符。`);
        return answer;
      } catch (error) {
        const isNetworkOrTimeoutError =
          error.name === "AbortError" || error instanceof TypeError;
        const shouldRetry = error.retryable || isNetworkOrTimeoutError;
        lastError = error;

        if (!shouldRetry || attempt >= AI_MAX_ATTEMPTS) {
          throw error;
        }

        const retryDelay =
          AI_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        console.log(
          `AI 请求失败，${retryDelay / 1_000} 秒后重试：${error.message}`,
        );
        await wait(retryDelay);
        ensureNotStopped();
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError;
  } finally {
    releaseAiRequestLock();
  }
}

function removeAnswerSectionLabels(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(
      /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?[【\[][^】\]\n]{1,24}[】\]]\s*[：:、\-—]?\s*/gm,
      "",
    )
    .replace(
      /^\s*(?:#{1,6}\s*)?(?:结论|真实细节|问题本质|实操建议|观点升华|总结|分析|建议)\s*[：:、\-—]+\s*/gm,
      "",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function selectEmotionCategory(page) {
  const emotionCategory = page.getByText("情感类", { exact: true }).first();
  await emotionCategory.waitFor({
    state: "visible",
    timeout: 30_000,
  });

  const titlesBeforeClick = await page
    .locator(".answer-section__question-title")
    .allTextContents();
  const wasAlreadyActive = await emotionCategory.evaluate((element) =>
    element.classList.contains("is-active"),
  );

  await emotionCategory.click();
  await page.locator(".answer-section__tab--1.is-active").waitFor({
    state: "visible",
    timeout: 30_000,
  });

  if (!wasAlreadyActive && titlesBeforeClick.length > 0) {
    await page.waitForFunction(
      (previousTitles) => {
        const currentTitles = Array.from(
          document.querySelectorAll(".answer-section__question-title"),
        ).map((element) => element.textContent?.trim() || "");
        return JSON.stringify(currentTitles) !== JSON.stringify(previousTitles);
      },
      titlesBeforeClick,
      { timeout: 30_000 },
    );
  }

  await page.locator(".answer-section__question").first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
  console.log("已选择情感类。");
}

async function getActiveListPageNumber(page) {
  const activePageText = await page
    .locator(".answer-section__pager-num.is-active")
    .textContent();
  return Number.parseInt(activePageText || "", 10);
}

async function getTotalListPages(page) {
  const jumpInput = page.locator(".answer-section__pager-jump-input");
  const placeholder = (await jumpInput.getAttribute("placeholder")) || "";
  const matchedNumber = placeholder.match(/\d+/);
  return matchedNumber ? Number.parseInt(matchedNumber[0], 10) : null;
}

async function ensureListPageNumber(page, expectedPageNumber) {
  const activePageNumber = await getActiveListPageNumber(page);
  if (activePageNumber === expectedPageNumber) return;

  const jumpInput = page.locator(".answer-section__pager-jump-input");
  await jumpInput.fill(String(expectedPageNumber));
  await jumpInput.press("Enter");
  await jumpInput.blur().catch(() => {});

  await page.waitForFunction(
    (pageNumber) => {
      const activePage = document.querySelector(
        ".answer-section__pager-num.is-active",
      );
      return activePage?.textContent?.trim() === String(pageNumber);
    },
    expectedPageNumber,
    { timeout: 30_000 },
  );
  await page.locator(".answer-section__question").first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
  console.log(`已恢复到情感类第 ${expectedPageNumber} 页。`);
}

async function submitAnswer(questionPage, answerText) {
  const answerTrigger = questionPage.getByText("回答", { exact: true }).first();
  await answerTrigger.waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await answerTrigger.click();

  const editor = questionPage
    .locator('textarea:visible, [contenteditable="true"]:visible')
    .first();
  await editor.waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await editor.fill(answerText);
  console.log("已将 AI 回答填入输入框。");

  const submitButton = questionPage
    .getByRole("button", { name: "提交", exact: true })
    .first();
  await submitButton.waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await submitButton.click();
  console.log("已点击提交。");
}

function normalizeQuestionTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function verifyOpenedQuestion(questionPage, expectedQuestionTitle) {
  const expectedTitle = normalizeQuestionTitle(expectedQuestionTitle);
  const bodyText = normalizeQuestionTitle(
    await questionPage.locator("body").innerText(),
  );

  if (!expectedTitle || !bodyText.includes(expectedTitle)) {
    console.error(
      `题目页面与列表题目不一致，已跳过本题且不会生成或提交。列表题目：${expectedTitle}`,
    );
    return false;
  }

  console.log(`题目核对通过：${expectedTitle}`);
  return true;
}

async function returnToQuestionList(listPage, newlyOpenedPage, listUrl) {
  try {
    if (newlyOpenedPage) {
      await newlyOpenedPage.close().catch(() => {});
      await listPage.bringToFront();
    } else if (!listPage.isClosed()) {
      await listPage.goBack({
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    }

    await listPage.locator(".answer-section__question").first().waitFor({
      state: "visible",
      timeout: 15_000,
    });
    console.log("已返回答题列表。");
    return true;
  } catch (error) {
    console.error(`返回答题列表失败，正在重新载入列表：${error.message}`);
  }

  if (listPage.isClosed()) return false;
  try {
    await listPage.goto(listUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await listPage.locator(".answer-section__question").first().waitFor({
      state: "visible",
      timeout: 30_000,
    });
    console.log("答题列表已重新载入。");
    return true;
  } catch (error) {
    console.error(`重新载入答题列表失败：${error.message}`);
    return false;
  }
}

async function openNextAnswerableQuestion(
  listPage,
  visitedQuestionTitles,
) {
  const questionCards = listPage.locator(".answer-section__question");
  try {
    await questionCards.first().waitFor({
      state: "visible",
      timeout: 30_000,
    });
  } catch {
    console.log("当前页没有可回答的题目。");
    return null;
  }

  const cardCount = await questionCards.count();
  let firstAnswerableButton;
  let selectedQuestionTitle;

  for (let index = 0; index < cardCount; index += 1) {
    const card = questionCards.nth(index);
    if (!(await card.isVisible())) continue;

    const title = (
      (await card.locator(".answer-section__question-title").textContent()) || ""
    )
      .replace(/\s+/g, " ")
      .trim();
    const button = card.locator(".answer-section__btn", {
      hasText: /^\s*去答题\s*$/,
    });

    if (
      title &&
      !visitedQuestionTitles.has(title) &&
      (await button.isVisible()) &&
      (await button.isEnabled())
    ) {
      firstAnswerableButton = button;
      selectedQuestionTitle = title;
      break;
    }
  }

  if (!firstAnswerableButton) {
    console.log("当前页没有尚未处理的可回答题目。");
    return null;
  }

  console.log(`准备打开题目：${selectedQuestionTitle}`);

  const listUrl = listPage.url();

  const popupPromise = listPage
    .waitForEvent("popup", { timeout: 10_000 })
    .catch(() => null);
  await firstAnswerableButton.click();
  const newlyOpenedPage = await popupPromise;
  await listPage.waitForTimeout(2_000);

  const questionPage = newlyOpenedPage || listPage;

  await questionPage.waitForLoadState("domcontentloaded");
  console.log(`已打开第一道可答题目：${questionPage.url()}`);
  console.log(`答题列表地址已记录：${listUrl}`);

  const questionMatches = await verifyOpenedQuestion(
    questionPage,
    selectedQuestionTitle,
  );
  if (!questionMatches) {
    const listRecovered = await returnToQuestionList(
      listPage,
      newlyOpenedPage,
      listUrl,
    );
    return {
      questionTitle: selectedQuestionTitle,
      submitted: false,
      listRecovered,
    };
  }
  const answerText = await generateAnswer(selectedQuestionTitle);
  await submitAnswer(questionPage, answerText);

  console.log("在答题页面停留 2 秒。");
  await questionPage.waitForTimeout(2_000);

  const listRecovered = await returnToQuestionList(
    listPage,
    newlyOpenedPage,
    listUrl,
  );
  console.log("在答题列表停留 2 秒。");
  await listPage.waitForTimeout(2_000);

  return {
    questionTitle: selectedQuestionTitle,
    submitted: true,
    listRecovered,
  };
}

async function main() {
  if (AUTOMATION_DATA_DIR) {
    fs.mkdirSync(AUTOMATION_DATA_DIR, { recursive: true });
  }
  const useBundledChromium =
    process.env.USE_BUNDLED_CHROMIUM === "1";
  const launchOptions = {
    headless: false,
    viewport: null,
    timeout: 30_000,
  };
  if (useBundledChromium) {
    launchOptions.executablePath = findBundledChromiumExecutable();
    console.log(`Chromium 路径：${launchOptions.executablePath}`);
    if (!fs.existsSync(launchOptions.executablePath)) {
      throw new Error(`找不到应用自带的 Chromium：${launchOptions.executablePath}`);
    }
  } else {
    launchOptions.channel = "msedge";
  }

  console.log(
    useBundledChromium
      ? "正在启动应用自带的 Chromium 浏览器。"
      : "正在启动系统 Microsoft Edge 浏览器。",
  );
  const context = await chromium.launchPersistentContext(
    USER_DATA_DIR,
    launchOptions,
  );
  activeContext = context;
  console.log("Chromium 已启动，正在创建答题页面。");
  const page = context.pages()[0] || (await context.newPage());

  console.log(`正在打开：${TARGET_URL}`);
  await page.goto(TARGET_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const pageTitle = await safePageTitle(page).catch((error) => {
    console.log(`网页标题读取失败，继续等待登录页面稳定：${error.message}`);
    return "";
  });
  console.log(`网页已打开：${pageTitle || page.url()}`);

  await enterAnswerAreaAfterLogin(context, page);

  const processedQuestionTitles = loadProcessedQuestionTitles();
  let currentListPage = START_PAGE;
  let totalListPages;
  let submittedCount = 0;

  console.log(
    `已载入 ${processedQuestionTitles.size} 条本地题目处理记录。`,
  );

  while (true) {
    ensureNotStopped();
    await selectEmotionCategory(page);

    if (!totalListPages) {
      totalListPages = await getTotalListPages(page);
      if (!totalListPages) {
        throw new Error("无法从分页输入框读取总页数。");
      }
      console.log(`情感类共 ${totalListPages} 页。`);
      if (currentListPage > totalListPages) {
        throw new Error(
          `起始页码 ${currentListPage} 超出总页数 ${totalListPages}。`,
        );
      }
    }

    await ensureListPageNumber(page, currentListPage);

    const result = await openNextAnswerableQuestion(
      page,
      processedQuestionTitles,
    );

    if (result) {
      processedQuestionTitles.add(result.questionTitle);
      saveProcessedQuestionTitles(processedQuestionTitles);
      console.log(`累计已处理 ${processedQuestionTitles.size} 道题。`);

      if (result.listRecovered === false) {
        console.error("答题列表无法恢复，本轮任务已安全结束，请稍后重新启动。");
        break;
      }

      if (result.submitted) {
        submittedCount += 1;
      }
      if (submittedCount >= AI_SUBMISSION_LIMIT) {
        console.log(
          `本轮已提交 ${submittedCount} 条 AI 回答，任务完成。`,
        );
        break;
      }
      continue;
    }

    if (currentListPage >= totalListPages) {
      console.log("所有分页均已处理完毕。");
      break;
    }

    currentListPage += 1;
    console.log(`当前页已处理完，准备进入第 ${currentListPage} 页。`);
  }

  console.log(`登录状态将保存在：${USER_DATA_DIR}`);
  if (process.env.CLOSE_BROWSER_ON_COMPLETE === "1") {
    await context.close();
    console.log("浏览器已关闭。");
  } else {
    console.log("关闭浏览器窗口即可结束程序。");
    await context.waitForEvent("close", { timeout: 0 });
  }
}

main()
  .catch(async (error) => {
    const browserWasClosed =
      /Target page, context or browser has been closed|浏览器窗口已关闭/.test(
        error.message,
      );
    if (
      error.name === "AutomationStoppedError" ||
      stopRequested ||
      browserWasClosed
    ) {
      console.log("任务已停止。");
      return;
    }
    console.error("运行失败：", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (process.env.CLOSE_BROWSER_ON_COMPLETE === "1") {
      await activeContext?.close().catch(() => {});
    }
    activeContext = undefined;
    if (process.connected) process.disconnect();
  });
