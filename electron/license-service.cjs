const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");

const DAY = 24 * 60 * 60 * 1000;

class LicenseRequestError extends Error {
  constructor(message, { status = 0, code = "network_error", definitive = false } = {}) {
    super(message);
    this.name = "LicenseRequestError";
    this.status = status;
    this.code = code;
    this.definitive = definitive;
  }
}

function base64url(input) { return Buffer.from(input).toString("base64url"); }
function machineFingerprint() {
  const raw = [os.hostname(), os.platform(), os.arch(), os.cpus()?.[0]?.model || "unknown"].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex");
}
function publicKeyFromConfig(metadata) {
  if (process.env.LICENSE_PUBLIC_KEY_PATH) return fs.readFileSync(process.env.LICENSE_PUBLIC_KEY_PATH, "utf8");
  if (process.env.LICENSE_PUBLIC_KEY) return process.env.LICENSE_PUBLIC_KEY;
  if (metadata.licensePublicKeyBase64) return Buffer.from(metadata.licensePublicKeyBase64, "base64").toString("utf8");
  return metadata.licensePublicKey || "";
}

class LicenseService {
  constructor({ enabled, serverUrl, publicKey, credentialPath, product = "configurable-api" }) {
    this.enabled = Boolean(enabled);
    this.serverUrl = String(serverUrl || "").replace(/\/+$/, "");
    this.publicKey = publicKey;
    this.credentialPath = credentialPath;
    this.product = product;
    this.deviceId = machineFingerprint();
  }
  read() { try { return JSON.parse(fs.readFileSync(this.credentialPath, "utf8")); } catch { return null; } }
  write(value) { fs.writeFileSync(this.credentialPath, JSON.stringify(value), { mode: 0o600 }); }
  clear() { try { fs.rmSync(this.credentialPath, { force: true }); } catch {} }
  verify(token) {
    try {
      const [payloadPart, signaturePart] = String(token || "").split(".");
      if (!payloadPart || !signaturePart || !this.publicKey) return null;
      const ok = crypto.verify(null, Buffer.from(payloadPart), this.publicKey, Buffer.from(signaturePart, "base64url"));
      if (!ok) return null;
      const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
      if (payload.product !== this.product || payload.deviceId !== this.deviceId) return null;
      return payload;
    } catch { return null; }
  }
  state() {
    if (!this.enabled) return { required: false, valid: true };
    const saved = this.read(), payload = this.verify(saved?.token), now = Date.now();
    if (!payload) return { required: true, valid: false, reason: "not_activated", deviceId: this.deviceId };
    const expiresAt = Date.parse(payload.expiresAt), offlineUntil = Date.parse(payload.offlineUntil);
    const valid = expiresAt > now && offlineUntil > now;
    return { required: true, valid, reason: valid ? null : "expired", licenseId: payload.licenseId, expiresAt: payload.expiresAt, offlineUntil: payload.offlineUntil, lastCheckedAt: saved.lastCheckedAt, deviceId: this.deviceId };
  }
  assertValid() { const state=this.state(); if(!state.valid)throw new Error(state.reason === "not_activated" ? "请先激活可配置接口授权" : "授权已过期或超过7天未联网验证"); return state; }
  async request(pathname, body) {
    if (!this.serverUrl) throw new LicenseRequestError("授权服务地址未配置");
    let response;
    try { response = await fetch(`${this.serverUrl}${pathname}`, { method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(15000) }); }
    catch (error) { throw new LicenseRequestError(`无法连接授权服务：${error.message}`); }
    const data = await response.json().catch(()=>({}));
    if (!response.ok) {
      const definitive = response.status >= 400 && response.status < 500;
      throw new LicenseRequestError(data.error || `授权服务请求失败：HTTP ${response.status}`, { status: response.status, code: data.error, definitive });
    }
    return data;
  }
  async activate(licenseKey) {
    const data=await this.request("/v1/licenses/activate",{licenseKey:String(licenseKey||"").trim(),deviceId:this.deviceId,product:this.product});
    if(!this.verify(data.token))throw new Error("授权凭证签名无效"); this.write({token:data.token,lastCheckedAt:new Date().toISOString()}); return this.state();
  }
  async refresh(force=false) {
    const saved=this.read(), payload=this.verify(saved?.token); if(!payload)return this.state();
    if(!force && Date.now()-Date.parse(saved.lastCheckedAt||0)<DAY)return this.state();
    try { const data=await this.request("/v1/licenses/validate",{token:saved.token,deviceId:this.deviceId,product:this.product}); if(!this.verify(data.token)){this.clear();throw new LicenseRequestError("授权服务返回的凭证签名无效",{code:"invalid_signature",definitive:true});}this.write({token:data.token,lastCheckedAt:new Date().toISOString()}); }
    catch(error){ if(error.definitive)this.clear(); if(error.definitive||!this.state().valid)throw error; }
    return this.state();
  }
}

module.exports={ LicenseService, LicenseRequestError, publicKeyFromConfig, machineFingerprint, base64url };
