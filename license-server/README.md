# 本地授权服务

授权服务是独立的 Node.js 应用，不依赖 Electron。支持 Node.js 20 及以上，SQLite 由服务自身的 `better-sqlite3` 依赖提供。首次启动会在 `data/` 自动生成 Ed25519 密钥和数据库。

```powershell
cd license-server
npm install
$env:LICENSE_ADMIN_TOKEN="请换成长随机字符串"
npm start
```

启动后在浏览器打开 `http://127.0.0.1:8787/admin`，输入启动服务时设置的 `LICENSE_ADMIN_TOKEN`。后台支持：

- 创建授权码并设置到期日期、设备上限
- 查看授权状态和当前设备占用
- 禁用或重新启用授权
- 查看设备最近在线时间并解绑设备

授权码明文只在创建成功时显示一次；数据库仅保存哈希和首尾提示，请立即复制并妥善记录。

默认只监听 `127.0.0.1`。需要让局域网或反向代理访问时，显式监听所有网卡：

```powershell
$env:HOST="0.0.0.0"
$env:PORT="8787"
$env:LICENSE_ADMIN_TOKEN="请换成长随机字符串"
npm start
```

此时其他电脑应通过服务器的实际 IP 访问，例如 `http://192.168.1.20:8787/admin`，不能使用 `0.0.0.0` 作为浏览器地址。还需要在系统防火墙或云服务器安全组中放行相应端口。

Docker 镜像已默认监听 `0.0.0.0`：

```bash
docker build -t wangpan-license-server .
docker run -d --name wangpan-license-server \
  -p 8787:8787 \
  -e LICENSE_ADMIN_TOKEN="替换为长随机字符串" \
  -v license-data:/data \
  wangpan-license-server
```

公网部署建议不要直接暴露 8787 端口，而是由 Caddy、Nginx 或云平台反向代理到 `127.0.0.1:8787` 并提供 HTTPS。客户端正式包的 `LICENSE_SERVER_URL` 应填写公网 HTTPS 地址。

创建一个一年有效、最多绑定一台设备的授权码：

```powershell
$headers = @{ Authorization = "Bearer $env:LICENSE_ADMIN_TOKEN" }
$body = @{ product = "configurable-api"; maxDevices = 1; expiresAt = "2027-12-31T23:59:59.000Z" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/v1/admin/licenses -Headers $headers -ContentType application/json -Body $body
```

开发版客户端：

```powershell
$env:CONFIGURABLE_API_BASE="1"
$env:LICENSE_SERVER_URL="http://127.0.0.1:8787"
$env:LICENSE_PUBLIC_KEY_PATH="$PWD/license-server/data/public-key.pem"
pnpm dev
```

正式打包前，把授权服务部署到 HTTPS 地址，然后设置同样的 `LICENSE_SERVER_URL` 和 `LICENSE_PUBLIC_KEY_PATH`，运行 `pnpm pack:win:configurable-api`。`data/private-key.pem` 绝对不能复制到客户端、提交到 Git 或公开。

客户端激活页的购买入口可通过以下变量配置：

```powershell
$env:LICENSE_PURCHASE_TEXT="联系微信客服：your-wechat"
$env:LICENSE_PURCHASE_URL="https://example.com/buy"
```

`LICENSE_PURCHASE_URL` 必须是 HTTPS。若不配置链接，点击购买提示时会直接显示 `LICENSE_PURCHASE_TEXT`。
