const assert = require("node:assert/strict");
process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const { chromium } = require("playwright");
const { categories, getAnswerCategory } = require("../electron/automation-categories.cjs");
const {
  ANSWER_SELECTORS,
  getQuestionCards,
  waitForQuestionList,
  selectAnswerCategory,
  getActiveListPageNumber,
  getTotalListPages,
  ensureListPageNumber,
} = require("../electron/automation-answer-page.cjs");

function fixture(legacy, category) {
  const prefix = legacy ? "answer-section__" : "answer-section-";
  const pagerPrefix = legacy ? prefix + "pager-" : "pager-";
  return `<!doctype html><html><body>
    <div class="rank-section"><button class="is-active">${category.label}</button>
      <button class="pager-num is-active">99</button><input class="pager-jump-input" placeholder="99">
    </div>
    <section class="answer-section">
      <button id="other" class="${prefix}tab is-active">其他分类</button>
      <button id="emotion" class="${prefix}tab ${prefix}tab${legacy ? "--" : "-"}2"><span>${category.label}</span></button>
      <div id="loading" class="${prefix}loading" style="display:none">加载中...</div>
      <div class="${prefix}question" style="display:none"><p class="${prefix}question-title">隐藏的旧题目</p></div>
      <div id="cards"></div>
      <div class="${prefix}pager">
        <button id="current" class="${pagerPrefix}num is-active">1</button>
        <input id="jump" class="${pagerPrefix}jump-input" placeholder="3">
      </div>
    </section>
    <script>(() => {
      window.categoryClicks = 0;
      const cards = document.getElementById('cards');
      const loading = document.getElementById('loading');
      function render(page) {
        cards.innerHTML = '<div class="${prefix}question"><p class="${prefix}question-title">第' + page + '页问题</p><a class="${prefix}btn"><span>去答题</span></a></div>';
      }
      render(1);
      document.getElementById('emotion').onclick = function () {
        window.categoryClicks++;
        document.getElementById('other').classList.remove('is-active');
        this.classList.add('is-active');
        // Leave old cards visible during loading to detect premature readiness.
        loading.style.display = 'block';
        setTimeout(() => { render(1); loading.style.display = 'none'; }, 120);
      };
      document.getElementById('jump').onkeyup = function (event) {
        if (event.key !== 'Enter') return;
        const page = Number(this.value);
        this.value = '';
        loading.style.display = 'block';
        setTimeout(() => {
          render(page);
          document.getElementById('current').textContent = String(page);
          loading.style.display = 'none';
        }, 120);
      };
    })();</script></body></html>`;
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage();
    for (const legacy of [false, true]) {
      for (const category of categories) {
        await page.setContent(fixture(legacy, category));
        await selectAnswerCategory(page, category.id);
        assert.equal(await page.locator(ANSWER_SELECTORS.loading).count(), 0);
        assert.equal(await page.evaluate(() => window.categoryClicks), 1);
        assert.equal(await getQuestionCards(page).count(), 1, "ignore hidden stale cards");
        assert.equal(await getQuestionCards(page).first().locator(ANSWER_SELECTORS.title).textContent(), "第1页问题");
        assert.equal(await getQuestionCards(page).first().locator(ANSWER_SELECTORS.button, { hasText: /^\s*去答题\s*$/ }).count(), 1);
        assert.equal(await getActiveListPageNumber(page), 1, "ignore other sections' pagination");
        assert.equal(await getTotalListPages(page), 3);
        await ensureListPageNumber(page, 2);
        assert.equal(await getActiveListPageNumber(page), 2);
        assert.equal(await getQuestionCards(page).first().locator(ANSWER_SELECTORS.title).textContent(), "第2页问题");
        await selectAnswerCategory(page, category.id);
        assert.equal(await page.evaluate(() => window.categoryClicks), 1, "do not re-click the selected category");
        assert.equal(await getActiveListPageNumber(page), 2, "preserve the current page");
        await waitForQuestionList(page);
        console.log(`PASS ${legacy ? "legacy" : "current"} ${category.label}: category, list, title, button, pagination and return readiness`);
      }
    }
    assert.equal(getAnswerCategory().id, "emotion");
    await assert.rejects(selectAnswerCategory(page, "invalid"), /有效的答题分类/);
    await page.setContent('<section class="answer-section"></section>');
    await assert.rejects(waitForQuestionList(page, 100), /题目列表未加载/);
    console.log("PASS missing-list diagnostic");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
