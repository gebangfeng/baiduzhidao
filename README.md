# 知道助手.

Windows 本地客户端，用于把“资源名称 + 百度网盘链接”的 Excel 批量转换成问答格式。

## 已实现

- 读取 `.xlsx` 前两列并补全合并单元格
- 每条链接单独生成一条问答
- 极速规则模式（无需 API）
- OpenAI 兼容的 AI 个性化模式
- API 密钥使用 Electron `safeStorage` 加密
- 纯 Node 本地任务库保存任务、进度、失败信息和内容缓存
- 暂停、继续、失败重试与异常恢复
- 标题长度、关键词和 HTML 结构校验
- 格式化 Excel 导出
- Electron 安全隔离、受限 IPC、导航和权限拦截

## 开发运行

```powershell
pnpm install
pnpm dev
```

## 检查

```powershell
pnpm check
```

## Windows 打包

安装版：

```powershell
pnpm pack:win
```

免安装版：

```powershell
pnpm pack:portable
```

生成文件位于 `release` 目录。

## 软件更新

更新清单固定使用 `https://bd.aiserve.top/latest.json`，无需用户配置。正式安装版启动后会自动检测；发现新版本后可下载，并重启静默安装。开发模式不会执行更新。

发布新版本时先修改 `package.json` 的版本号并打包，然后生成带 SHA-256 校验的清单：

```powershell
pnpm update:manifest -- "release/知道助手-2.0.3-Windows-x64.exe" "https://example.com/releases/知道助手-2.0.3-Windows-x64.exe"
```

将生成的 `latest.json` 和安装包上传到 HTTPS 文件服务器。清单也支持按平台提供 `windows`、`mac` 字段。

## API Base URL 特性开关

普通安装包固定使用内置 API Base URL，设置页不会显示地址输入框：

```bash
pnpm pack:win
```

需要允许用户配置 OpenAI 兼容接口地址时，使用专用打包命令：

```bash
pnpm pack:win:configurable-api
```

便携版对应 `pnpm pack:portable` 和 `pnpm pack:portable:configurable-api`。可配置版本的安装包或便携包文件名会带有“可配置API版”标记，并把 `configurableApiBase: true` 写入打包后应用的 `package.json`；普通版本即使本地 SQLite 中已有自定义地址，也仍强制使用内置地址。

## Excel 输入与输出

输入默认读取第一张工作表：

- 第一列：素材名称
- 第二列：百度网盘、夸克网盘或迅雷云盘分享链接

两列表头可以任意命名，不会因表头文字不同而阻止处理。

输出严格采用官方批量问答上传模板的三列格式：

- qid（非必填，自问自答创建的问题无此字段）
- 问题标题（必填）
- 回答内容（必填）

qid列保持为空，问题标题和回答内容分别写入对应必填列。
```
$env:LICENSE_SERVER_URL="https://bd-server.aiserve.top"
$env:LICENSE_PUBLIC_KEY_PATH="$PWD\.public-key.pem"
$env:LICENSE_PURCHASE_TEXT="联系微信客服：f2468558247,赞助19.9获得激活码"
$env:LICENSE_PURCHASE_URL="https://pay.ldxp.cn/shop/JCF8DUSZ"
pnpm pack:win:configurable-api



$env:CONFIGURABLE_API_BASE="1"
$env:LICENSE_SERVER_URL="https://bd-server.aiserve.top"
$env:LICENSE_PUBLIC_KEY_PATH="$PWD\.public-key.pem"
$env:LICENSE_PURCHASE_TEXT="联系微信客服：f2468558247,赞助19.9获得激活码"
$env:LICENSE_PURCHASE_URL="https://pay.ldxp.cn/shop/JCF8DUSZ"
pnpm dev
```