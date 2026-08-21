const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LicenseService, LicenseRequestError, machineFingerprint } = require("../electron/license-service.cjs");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "license-test-"));
  try {
    const pair = crypto.generateKeyPairSync("ed25519");
    const payload = Buffer.from(JSON.stringify({ licenseId: "test", product: "configurable-api", deviceId: machineFingerprint(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), offlineUntil: new Date(Date.now() + 7 * 86400000).toISOString() })).toString("base64url");
    const token = `${payload}.${crypto.sign(null, Buffer.from(payload), pair.privateKey).toString("base64url")}`;
    const credentialPath = path.join(dir, "license.json");
    const service = new LicenseService({ enabled: true, publicKey: pair.publicKey.export({ type: "spki", format: "pem" }), credentialPath });
    service.write({ token, lastCheckedAt: new Date(0).toISOString() });
    assert.equal(service.state().valid, true);

    service.request = async () => { throw new LicenseRequestError("offline"); };
    assert.equal((await service.refresh(true)).valid, true);
    assert.equal(fs.existsSync(credentialPath), true, "网络错误应保留离线凭证");

    service.request = async () => { throw new LicenseRequestError("disabled", { status: 403, code: "license_revoked_or_expired", definitive: true }); };
    await assert.rejects(() => service.refresh(true), /disabled/);
    assert.equal(fs.existsSync(credentialPath), false, "服务端明确拒绝应清除离线凭证");
    assert.equal(service.state().valid, false);
    console.log("License flow test passed: offline grace retained, revocation locked immediately.");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
