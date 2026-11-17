const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const packageJson = require(path.join(rootDir, "package.json"));
const productName = packageJson.build?.productName || packageJson.name;
const arch = process.argv[2] || process.arch;
const releaseDir = path.join(rootDir, "release");
const appDirectoryName = arch === "x64" ? "mac" : `mac-${arch}`;
const appPath = path.join(releaseDir, appDirectoryName, `${productName}.app`);
const dmgPath = path.join(releaseDir, `zhidao-assistant-${packageJson.version}-macOS-${arch}.dmg`);

function run(command, args, { retryBusy = false } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync(command, args, { cwd: rootDir, encoding: "utf8" });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status === 0) return result.stdout;
    const detachTargetGone = command === "hdiutil" && args[0] === "detach" &&
      /no such file or directory|不存在|找不到/i.test(
        `${result.stdout || ""}\n${result.stderr || ""}`,
      );
    // A detach may return a timeout after DiskArbitration already removed the
    // mount. Treat a subsequent "no such file" response as successful.
    if (detachTargetGone) return result.stdout;
    const transientDetach = command === "hdiutil" && args[0] === "detach" &&
      /timeout|timed out|diskarbitration|未能卸载|无法卸载/i.test(
        `${result.stdout || ""}\n${result.stderr || ""}`,
      );
    const busy = result.status === 16 || /resource busy|资源忙|资源正忙|资源繁忙/i.test(result.stderr || "");
    if (retryBusy && (busy || transientDetach) && attempt < 4) {
      console.log(`磁盘镜像暂时被占用，${attempt} 秒后重试（${attempt}/3）。`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 1000);
      continue;
    }
    throw new Error(`${command} ${args[0]} 失败（${result.signal || result.status}）`);
  }
}

function isMounted(mountPath) {
  return fs.statSync(mountPath).dev !== fs.statSync(path.dirname(mountPath)).dev;
}

function main() {
  if (process.platform !== "darwin") throw new Error("macOS dmg 只能在 macOS 上生成。");
  if (!["arm64", "x64"].includes(arch)) throw new Error(`不支持的 macOS 架构：${arch}`);
  if (!fs.existsSync(appPath)) throw new Error(`找不到已打包的应用：${appPath}`);

  fs.mkdirSync(releaseDir, { recursive: true });
  // Keep image output on the same filesystem as the final artifact for atomic rename.
  const workDir = fs.mkdtempSync(path.join(releaseDir, ".dmg-build-"));
  const mountRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${packageJson.name}-dmg-`));
  const mountPath = path.join(mountRoot, "volume");
  const writableImage = path.join(workDir, "writable.dmg");
  const compressedImage = path.join(workDir, "compressed.dmg");
  fs.mkdirSync(mountPath);

  try {
    const appKiB = Number.parseInt(run("du", ["-sk", appPath]), 10);
    if (!Number.isFinite(appKiB) || appKiB <= 0) throw new Error("无法计算应用大小。");
    const sizeMiB = Math.ceil(appKiB / 1024 * 1.3) + 128;
    run("hdiutil", ["create", "-size", `${sizeMiB}m`, "-fs", "HFS+", "-volname", productName,
      "-type", "UDIF", "-nospotlight", "-ov", writableImage], { retryBusy: true });
    run("hdiutil", ["attach", writableImage, "-mountpoint", mountPath, "-nobrowse", "-noautoopen"], { retryBusy: true });
    run("ditto", [appPath, path.join(mountPath, `${productName}.app`)]);
    fs.symlinkSync("/Applications", path.join(mountPath, "应用程序"));
    try {
      run("hdiutil", ["detach", mountPath], { retryBusy: true });
    } catch (error) {
      // DiskArbitration can leave a cleanly closed image attached briefly.
      // A forced detach is safe here because all writes completed already.
      console.warn(`普通卸载超时，尝试强制卸载：${error.message}`);
      run("hdiutil", ["detach", "-force", mountPath], { retryBusy: true });
    }
    run("hdiutil", ["convert", writableImage, "-format", "UDZO", "-o", compressedImage, "-ov"], { retryBusy: true });
    run("hdiutil", ["verify", compressedImage]);
    fs.renameSync(compressedImage, dmgPath);
    console.log(`macOS dmg 已生成并校验：${dmgPath}`);
  } finally {
    // Never recursively remove a mounted volume, including a partially failed attach.
    let cleanupSafe = !isMounted(mountPath);
    if (!cleanupSafe) {
      try {
        run("hdiutil", ["detach", mountPath], { retryBusy: true });
        cleanupSafe = !isMounted(mountPath);
      } catch (error) {
        console.error(`临时镜像仍被占用，已保留文件：${workDir}\n挂载点：${mountPath}\n${error.message}`);
      }
    }
    if (cleanupSafe) {
      fs.rmSync(mountRoot, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
