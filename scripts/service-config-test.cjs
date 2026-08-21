const assert = require("node:assert/strict");
const { FIXED_API_BASE, normalizeApiBaseUrl } = require("../electron/service-config.cjs");

assert.equal(normalizeApiBaseUrl("https://example.com/v1/"), "https://example.com/v1");
assert.equal(normalizeApiBaseUrl("http://localhost:8080/v1/"), "http://localhost:8080/v1");
assert.equal(normalizeApiBaseUrl(FIXED_API_BASE), FIXED_API_BASE);
assert.throws(() => normalizeApiBaseUrl("http://example.com/v1"), /HTTPS/);
assert.throws(() => normalizeApiBaseUrl("javascript:alert(1)"), /HTTPS/);
console.log("Service config test passed.");
