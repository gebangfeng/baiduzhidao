const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const pkg = require("../package.json");

const installer = process.argv[2];
const publicUrl = process.argv[3];
if (!installer || !publicUrl) {
  console.error("用法: node scripts/generate-update-manifest.cjs <安装包路径> <HTTPS下载地址>");
  process.exit(1);
}
if (!fs.existsSync(installer)) throw new Error(`找不到安装包: ${installer}`);
const sha256 = createHash("sha256").update(fs.readFileSync(installer)).digest("hex");
const platform = path.extname(installer).toLowerCase() === ".dmg" ? "mac" : "windows";
const manifest = { version: pkg.version, notes: "", platforms: { [platform]: { url: publicUrl, sha256 } } };
const output = path.join(path.dirname(installer), "latest.json");
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`更新清单已生成: ${output}`);
