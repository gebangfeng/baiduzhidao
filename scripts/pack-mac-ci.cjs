const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const packageJson = require(path.join(rootDir, "package.json"));
const arch = process.argv[2] || process.arch;
const configPath = path.join(os.tmpdir(), `electron-builder-mac-${arch}-${Date.now()}.json`);

const baseConfig = packageJson.build || {};
const files = Array.isArray(baseConfig.files) ? [...baseConfig.files] : [];
const extraResources = Array.isArray(baseConfig.extraResources)
  ? [...baseConfig.extraResources]
  : [];

const config = {
  ...baseConfig,
  files: [
    ...files,
    "!node_modules/playwright-core/.local-browsers/**/*",
  ],
  extraResources: [
    ...extraResources,
    {
      from: "node_modules/playwright-core/.local-browsers",
      to: "playwright-browsers",
    },
  ],
  mac: {
    ...(baseConfig.mac || {}),
    target: [
      {
        target: "dir",
        arch: [arch],
      },
    ],
  },
};

try {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const result = spawnSync(
    path.join(rootDir, "node_modules", ".bin", "electron-builder"),
    ["--config", configPath, "--publish", "never"],
    {
      cwd: rootDir,
      stdio: "inherit",
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
        ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/",
      },
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(configPath, { force: true });
}
