const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const target = process.argv[2] === "portable" ? "portable" : "nsis";
const serverUrl = String(process.env.LICENSE_SERVER_URL || "").trim().replace(/\/+$/, "");
const purchaseText = String(process.env.LICENSE_PURCHASE_TEXT || "请联系软件提供方购买授权").trim();
const purchaseUrl = String(process.env.LICENSE_PURCHASE_URL || "").trim();
const publicKeyInput = String(process.env.LICENSE_PUBLIC_KEY_PATH || "").trim();
if (!/^https:\/\//i.test(serverUrl) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(serverUrl)) {
  throw new Error("请设置 LICENSE_SERVER_URL（正式包必须为 HTTPS）");
}
if (!publicKeyInput) throw new Error("缺少 LICENSE_PUBLIC_KEY_PATH，请设置授权服务公钥文件路径");
const publicKeyPath = path.resolve(publicKeyInput);
if (!fs.existsSync(publicKeyPath)) throw new Error(`LICENSE_PUBLIC_KEY_PATH 文件不存在：${publicKeyPath}`);
if (purchaseUrl && !/^https:\/\//i.test(purchaseUrl)) throw new Error("LICENSE_PURCHASE_URL 必须是 HTTPS 地址或留空");
const publicKey = fs.readFileSync(publicKeyPath, "utf8");
const builderCli = require.resolve("electron-builder/out/cli/cli.js");
const args = [builderCli, "--win", target,
  "--config.win.artifactName=${productName}-${version}-可配置API版-Windows-${arch}.${ext}",
  "--config.extraMetadata.configurableApiBase=true",
  `--config.extraMetadata.licenseServerUrl=${serverUrl}`,
  `--config.extraMetadata.licensePublicKeyBase64=${Buffer.from(publicKey).toString("base64")}`,
  `--config.extraMetadata.licensePurchaseText=${purchaseText}`,
  `--config.extraMetadata.licensePurchaseUrl=${purchaseUrl}`,
];
console.log(`正在构建可配置接口版本：${target}`);
console.log(`授权服务：${serverUrl}`);
console.log(`授权公钥：${publicKeyPath}`);
const result = spawnSync(process.execPath, args, { stdio: "inherit", shell: false });
if (result.error) {
  console.error(`无法启动 electron-builder：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
