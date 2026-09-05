const { defaultCategory, categories } = require("./automation-categories.json");

function getAnswerCategory(id = defaultCategory) {
  const category = categories.find((item) => item.id === id);
  if (!category) throw new Error("请选择有效的答题分类");
  return category;
}

module.exports = { defaultCategory, categories, getAnswerCategory };
