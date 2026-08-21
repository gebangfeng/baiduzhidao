const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const packageJson = require(path.join(rootDir, "package.json"));
const productName = packageJson.build?.productName || packageJson.name;
const version = packageJson.version;
const arch = process.argv[2] || process.arch;
const releaseDir = path.join(rootDir, "release");
const appPath = path.join(releaseDir, `mac-${arch}`, `${productName}.app`);
const dmgPath = path.join(releaseDir, `${productName}-${version}-macOS-${arch}.dmg`);
const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), `${packageJson.name}-dmg-`));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

try {
  if (process.platform !== "darwin") {
    throw new Error("macOS dmg 只能在 macOS 上生成。");
  }
  if (!fs.existsSync(appPath)) {
    throw new Error(`找不到已打包的应用：${appPath}`);
  }

  fs.cpSync(appPath, path.join(stageDir, `${productName}.app`), {
    recursive: true,
    dereference: false,
  });
  fs.symlinkSync("/Applications", path.join(stageDir, "应用程序"));
  fs.mkdirSync(releaseDir, { recursive: true });

  run("hdiutil", [
    "create",
    "-volname",
    productName,
    "-srcfolder",
    stageDir,
    "-ov",
    "-format",
    "UDZO",
    dmgPath,
  ]);

  console.log(`macOS dmg 已生成：${dmgPath}`);
} finally {
  fs.rmSync(stageDir, { recursive: true, force: true });
}
