const { createHash } = require("node:crypto");
const { createWriteStream } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const { spawn } = require("node:child_process");

function compareVersions(left, right) {
  const parts = (value) => String(value || "0").replace(/^v/i, "").split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function validateHttpsUrl(value, label) {
  let parsed;
  try { parsed = new URL(String(value || "").trim()); } catch { throw new Error(`${label}格式不正确`); }
  if (parsed.protocol !== "https:") throw new Error(`${label}必须使用 HTTPS`);
  return parsed.toString();
}

class UpdateService {
  constructor({ app, getManifestUrl, notify }) {
    this.app = app;
    this.getManifestUrl = getManifestUrl;
    this.notify = notify;
    this.state = { status: "idle", currentVersion: app.getVersion(), availableVersion: "", percent: 0, notes: "", error: "" };
    this.release = null;
    this.installerPath = "";
  }

  emit(patch = {}) {
    this.state = { ...this.state, ...patch };
    this.notify("update:state", this.getState());
    return this.getState();
  }

  getState() {
    return { ...this.state, configured: Boolean(this.getManifestUrl()) };
  }

  async check(manifestUrlOverride = "") {
    if (!this.app.isPackaged) return this.emit({ status: "development", error: "开发模式不执行自动更新" });
    const manifestUrl = validateHttpsUrl(manifestUrlOverride || this.getManifestUrl(), "更新清单地址");
    this.emit({ status: "checking", error: "", percent: 0 });
    try {
      const response = await fetch(manifestUrl, { headers: { Accept: "application/json", "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`);
      const manifest = await response.json();
      const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux";
      const asset = manifest?.platforms?.[platform] || manifest;
      const version = String(manifest?.version || asset?.version || "").trim();
      if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error("更新清单中的版本号无效");
      if (compareVersions(version, this.app.getVersion()) <= 0) {
        this.release = null;
        return this.emit({ status: "up-to-date", availableVersion: version, notes: String(manifest?.notes || ""), error: "" });
      }
      this.release = {
        version,
        url: validateHttpsUrl(asset?.url, "安装包地址"),
        sha256: String(asset?.sha256 || "").trim().toLowerCase(),
        notes: String(manifest?.notes || asset?.notes || "").slice(0, 4000),
      };
      if (!/^[a-f0-9]{64}$/.test(this.release.sha256)) throw new Error("更新清单缺少有效的 SHA-256 校验值");
      return this.emit({ status: "available", availableVersion: version, notes: this.release.notes, error: "" });
    } catch (error) {
      return this.emit({ status: "error", error: error.message || String(error) });
    }
  }

  async download() {
    if (!this.release) throw new Error("请先检查更新");
    this.emit({ status: "downloading", percent: 0, error: "" });
    const response = await fetch(this.release.url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`下载安装包失败（HTTP ${response.status}）`);
    const extension = process.platform === "win32" ? ".exe" : process.platform === "darwin" ? ".dmg" : ".AppImage";
    const directory = path.join(this.app.getPath("userData"), "updates");
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, `update-${this.release.version}${extension}`);
    const temporary = `${target}.download`;
    const total = Number(response.headers.get("content-length")) || 0;
    let received = 0;
    const hash = createHash("sha256");
    const source = Readable.fromWeb(response.body);
    source.on("data", (chunk) => {
      received += chunk.length;
      hash.update(chunk);
      this.emit({ status: "downloading", percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0 });
    });
    try {
      await pipeline(source, createWriteStream(temporary));
      if (hash.digest("hex") !== this.release.sha256) throw new Error("安装包校验失败，已取消更新");
      await fs.rm(target, { force: true });
      await fs.rename(temporary, target);
      this.installerPath = target;
      return this.emit({ status: "downloaded", percent: 100 });
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      this.emit({ status: "error", error: error.message || String(error) });
      throw error;
    }
  }

  install() {
    if (!this.installerPath) throw new Error("更新安装包尚未下载完成");
    const args = process.platform === "win32" ? ["/S"] : [];
    spawn(this.installerPath, args, { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => this.app.quit(), 300);
    return { ok: true };
  }
}

module.exports = { UpdateService, compareVersions };
