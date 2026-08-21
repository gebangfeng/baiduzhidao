const FIXED_API_BASE = "https://geekai.co/api/v1";
const API_KEY_GUIDE_URL = "https://geekai.co/user/api_keys?invite_code=uhALz3";
const USER_GUIDE_URL = "https://my.feishu.cn/wiki/OO0awsLKPiPbkskQhHHc4nfwnUg?from=from_copylink";
const DEFAULT_MODEL = "glm-4-flash";

function normalizeApiBaseUrl(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i.test(normalized)
    && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s]*)?$/i.test(normalized)) {
    throw new Error("API Base URL 必须是 HTTPS 地址（本机调试允许 localhost）");
  }
  return normalized;
}

function normalizeModel(model) {
  const value = String(model || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
    ? value
    : DEFAULT_MODEL;
}

module.exports = {
  FIXED_API_BASE,
  API_KEY_GUIDE_URL,
  USER_GUIDE_URL,
  DEFAULT_MODEL,
  normalizeModel,
  normalizeApiBaseUrl,
};
