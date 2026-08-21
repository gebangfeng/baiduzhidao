const assert = require("node:assert/strict");
const { normalizeGeneratedTitle, repairGeneratedTitle, isGeneratedTitleValid, cacheKey } = require("../electron/content-engine.cjs");

const game = "手机游戏苏丹的游戏安装包.zip";
const natural = "《苏丹的游戏》手机版在哪里下载？";
const repaired = repairGeneratedTitle(natural, game);
assert.equal(repaired, "《苏丹的游戏》手机版在哪里通过网盘下载？");
assert.equal(isGeneratedTitleValid(repaired, game), true);
assert.equal(normalizeGeneratedTitle(natural, game, "ai"), repaired);

const unrelated = normalizeGeneratedTitle("哪里可以获取其他游戏网盘链接？", game, "ai");
assert.notEqual(unrelated, "哪里可以获取其他游戏网盘链接？");
assert.equal(isGeneratedTitleValid(unrelated, game), true);

const fallbacks = ["甲资源.zip", "乙资源.zip", "丙资源.zip", "丁资源.zip"]
  .map((name) => normalizeGeneratedTitle("", name, "ai"));
assert.ok(new Set(fallbacks).size > 1, "兜底标题应使用多种句式");

assert.match(cacheKey("测试", { mode: "ai" }), /^[a-f0-9]{64}$/);
console.log("Title engine tests passed");
