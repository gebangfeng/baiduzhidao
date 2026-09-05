const { defaultCategory, getAnswerCategory } = require("./automation-categories.cjs");

// The activity page uses hyphenated class names; retain the older BEM names.
const ANSWER_SELECTORS = Object.freeze({
  section: ".answer-section",
  question: ".answer-section-question:visible, .answer-section__question:visible",
  title: ".answer-section-question-title, .answer-section__question-title",
  button: ".answer-section-btn, .answer-section__btn",
  activePage: ".answer-section-pager .pager-num.is-active, .answer-section__pager-num.is-active",
  jumpInput: ".answer-section-pager .pager-jump-input:visible, .answer-section__pager-jump-input:visible",
  loading: ".answer-section-loading:visible, .answer-section__loading:visible",
});

function getQuestionCards(page) {
  return page.locator(ANSWER_SELECTORS.question);
}

async function waitForQuestionList(page, timeout = 30_000) {
  try {
    await page.locator(ANSWER_SELECTORS.loading).first().waitFor({ state: "hidden", timeout });
    await getQuestionCards(page).first().waitFor({ state: "visible", timeout });
  } catch (error) {
    if (error.name !== "TimeoutError") throw error;
    throw new Error("题目列表未加载：请检查浏览器中的登录/验证提示或网络状态；若页面已有题目，可能是页面结构再次变化。", { cause: error });
  }
}

function isCategoryActive(element) {
  const tab = element.closest('[role="tab"], .answer-section-tab, .answer-section__tab, [class*="answer-section__tab--"]') || element;
  return [element, tab].some((node) =>
    node.classList.contains("is-active") ||
    node.getAttribute("aria-selected") === "true",
  );
}

async function selectAnswerCategory(page, categoryId = defaultCategory, ensureNotStopped = () => {}) {
  const { label } = getAnswerCategory(categoryId);
  const categoryTab = page.locator(ANSWER_SELECTORS.section).getByText(label, { exact: true }).first();
  await categoryTab.waitFor({
    state: "visible",
    timeout: 30_000,
  });

  const wasAlreadyActive = await categoryTab.evaluate(isCategoryActive);

  if (!wasAlreadyActive) {
    await categoryTab.click();
    const deadline = Date.now() + 30_000;
    while (!(await categoryTab.evaluate(isCategoryActive))) {
      ensureNotStopped();
      if (Date.now() >= deadline) {
        throw new Error(`点击${label}后未检测到该分类的选中状态，请检查浏览器中的登录状态、验证提示或页面是否改版。`);
      }
      await page.waitForTimeout(200);
    }
  }

  await waitForQuestionList(page);
  console.log(`已选择${label}。`);
}

async function getActiveListPageNumber(page) {
  const activePageText = await page
    .locator(ANSWER_SELECTORS.activePage).first()
    .textContent();
  return Number.parseInt(activePageText || "", 10);
}

async function getTotalListPages(page) {
  const jumpInput = page.locator(ANSWER_SELECTORS.jumpInput).first();
  const placeholder = (await jumpInput.getAttribute("placeholder")) || "";
  const matchedNumber = placeholder.match(/\d+/);
  return matchedNumber ? Number.parseInt(matchedNumber[0], 10) : null;
}

async function ensureListPageNumber(page, expectedPageNumber) {
  const activePageNumber = await getActiveListPageNumber(page);
  if (activePageNumber === expectedPageNumber) return;

  const jumpInput = page.locator(ANSWER_SELECTORS.jumpInput).first();
  await jumpInput.fill(String(expectedPageNumber));
  await jumpInput.press("Enter");
  await jumpInput.blur().catch(() => {});

  await page.waitForFunction(
    ({ pageNumber, selector }) => {
      const activePage = Array.from(document.querySelectorAll(selector))
        .find((element) => element.getClientRects().length > 0);
      return activePage?.textContent?.trim() === String(pageNumber);
    },
    { pageNumber: expectedPageNumber, selector: ANSWER_SELECTORS.activePage },
    { timeout: 30_000 },
  );
  await waitForQuestionList(page);
  console.log(`已恢复到当前分类第 ${expectedPageNumber} 页。`);
}

module.exports = {
  ANSWER_SELECTORS,
  getQuestionCards,
  waitForQuestionList,
  isCategoryActive,
  selectAnswerCategory,
  getActiveListPageNumber,
  getTotalListPages,
  ensureListPageNumber,
};
