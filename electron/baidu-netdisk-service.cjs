const BASE_URL = "https://pan.baidu.com";
const NETDISK_DEBUG = Boolean(process.env.VITE_DEV_SERVER_URL);

const ERROR_MESSAGES = {
  "-1": "链接失效、格式错误或缺少提取码",
  "-3": "分享参数无效，请重新读取文件信息后再试",
  "-4": "登录状态无效，请重新获取 Cookie",
  "-6": "Cookie 已失效，请重新获取",
  "-7": "目录名包含非法字符",
  "-8": "目录中已有同名文件或文件夹",
  "-9": "提取码错误",
  "-10": "网盘容量不足",
  "-12": "提取码错误",
  "-62": "链接访问次数过多，请稍后再试",
  0: "操作成功",
  2: "目标目录不存在",
  4: "目录中存在同名文件",
  12: "转存文件数超过限制",
  20: "网盘容量不足",
  105: "分享页面不存在",
  404: "操作无效",
};

const DEFAULT_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7,en-GB;q=0.6",
  Referer: BASE_URL,
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-site",
  "Upgrade-Insecure-Requests": "1",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
};

function errorMessage(errno, fallback = "百度网盘请求失败") {
  return ERROR_MESSAGES[String(errno)] || `${fallback}（错误代码 ${errno}）`;
}

function logBaiduResult(stage, result) {
  if (!NETDISK_DEBUG) return;
  const errno = result?.errno;
  const status = errno === 0 ? "ok" : `failed errno=${errno}`;
  console.log(`[网盘业务] ${stage} ${status}`);
}

function safeResponsePreview(value, maxLength = 2000) {
  const redacted = String(value || "")
    .replace(
      /("?(?:bdstoken|token|randsk|sekey|uk|share_uk|cookie|bduss|stoken)"?\s*[:=]\s*)"?[^",&\s<]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(BDUSS|STOKEN|BDCLND)=[^;\s"']+/gi, "$1=[REDACTED]");
  return redacted.length > maxLength
    ? `${redacted.slice(0, maxLength)}… [已截断，共 ${redacted.length} 字符]`
    : redacted;
}

function normalizeFolder(folder = "") {
  const value = String(folder).trim().replace(/^\/+|\/+$/g, "");
  if (/[<>|*?\\:]/.test(value)) throw new Error("目录名不能包含 < > | * ? \\ :");
  return value ? `/${value}` : "/";
}

function normalizeShareInput(raw) {
  let text = String(raw || "").trim();
  const urlMatch = text.match(/https?:\/\/pan\.baidu\.com\/[^\s，,]+/i);
  if (!urlMatch) throw new Error("未识别到百度网盘分享链接");
  let urlText = urlMatch[0].replace(/[。；;]+$/, "");
  let code = "";
  try {
    const parsed = new URL(urlText);
    code = parsed.searchParams.get("pwd") || "";
    parsed.searchParams.delete("pwd");
    urlText = parsed.toString().replace(/\?$/, "");
  } catch {
    throw new Error("分享链接格式不正确");
  }
  if (!code) {
    const codeMatch = text.match(/(?:提取码|密码)\s*[：:]?\s*([a-zA-Z0-9]{4})/i)
      || text.replace(urlMatch[0], " ").match(/(?:^|\s)([a-zA-Z0-9]{4})(?:\s|$)/);
    code = codeMatch?.[1] || "";
  }
  return { url: urlText, code: code.slice(0, 4) };
}

function shareKeyFromUrl(link) {
  const parsed = new URL(link);
  if (parsed.pathname.startsWith("/s/")) {
    return parsed.pathname.slice(3).replace(/^1/, "");
  }
  const surl = parsed.searchParams.get("surl");
  if (surl) return surl.replace(/^1/, "");
  throw new Error("无法识别分享链接标识");
}

function cookieWithBdclnd(cookie, value) {
  const items = String(cookie).split(";").map((item) => item.trim()).filter(Boolean);
  const kept = items.filter((item) => !/^BDCLND=/i.test(item));
  kept.push(`BDCLND=${value}`);
  return kept.join("; ");
}

async function request(url, { cookie, method = "GET", params, data, timeout = 20000, redirect = "follow", signal } = {}) {
  const target = new URL(url);
  if (params) {
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), timeout);
  const startedAt = Date.now();
  const requestLabel = `${target.origin}${target.pathname}`;
  if (NETDISK_DEBUG) console.log(`[网盘请求] ${method} ${requestLabel}`);
  try {
    const response = await fetch(target, {
      method,
      redirect,
      signal: controller.signal,
      headers: {
        ...DEFAULT_HEADERS,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" } : {}),
      },
      body: data ? new URLSearchParams(data) : undefined,
    });
    const text = await response.text();
    if (NETDISK_DEBUG) {
      console.log(`[网盘响应] ${method} ${requestLabel} HTTP ${response.status} ${Date.now() - startedAt}ms`);
      console.log(`[网盘响应内容] ${method} ${requestLabel}\n${safeResponsePreview(text)}`);
    }
    if (!response.ok) throw new Error(`百度网盘请求失败（HTTP ${response.status}）`);
    return { response, text };
  } catch (error) {
    const message = error.name === "AbortError"
      ? (signal?.aborted ? "目录读取已取消" : "百度网盘请求超时")
      : error.message;
    if (NETDISK_DEBUG) {
      console.error(`[网盘失败] ${method} ${requestLabel} ${Date.now() - startedAt}ms：${message}`);
    }
    if (error.name === "AbortError") throw new Error(message);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("目录读取已取消");
  error.code = "DIRECTORY_READ_CANCELLED";
  throw error;
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("目录读取已取消");
      error.code = "DIRECTORY_READ_CANCELLED";
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseJson(text) {
  try {
    // 百度的 fsid 是 uint64，可能超过 JavaScript 安全整数范围。解析前转成字符串，避免分享时 ID 尾数被改写。
    const safeText = String(text).replace(
      /("(?:fs_id|fsid|to_fs_id)"\s*:\s*)(\d{15,})(?=\s*[,}])/g,
      '$1"$2"',
    );
    return JSON.parse(safeText);
  } catch {
    throw new Error("百度网盘返回了无法识别的数据，请检查 Cookie 是否有效");
  }
}

async function getBdstoken(cookie) {
  const { text } = await request(`${BASE_URL}/api/gettemplatevariable`, {
    cookie,
    params: {
      clienttype: 0,
      app_id: 38824127,
      web: 1,
      fields: '["bdstoken","token","uk","isdocuser","servertime"]',
    },
  });
  const result = parseJson(text);
  if (result.errno !== 0 || !result.result?.bdstoken) throw new Error(errorMessage(result.errno, "未能获取登录凭证"));
  return { bdstoken: result.result.bdstoken, uk: result.result.uk };
}

async function listDirectory(cookie, bdstoken, folder = "", options = {}) {
  const dir = normalizeFolder(folder);
  const all = [];
  const maxPages = Math.max(1, Math.min(50, Math.ceil((Number(options.maxItems) || 5000) / 1000)));
  for (let page = 1; page <= maxPages; page += 1) {
    throwIfAborted(options.signal);
    let result;
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      const { text } = await request(`${BASE_URL}/api/list`, {
        cookie,
        signal: options.signal,
        params: { clienttype: 0, app_id: 250528, order: "time", desc: 1, showempty: 0, web: 1, page, num: 1000, dir, bdstoken },
      });
      result = parseJson(text);
      if (Number(result.errno) !== -62 || attempt === 3) break;
      await abortableDelay(600 * (2 ** attempt), options.signal);
    }
    if (result.errno !== 0) throw new Error(errorMessage(result.errno, `读取目录 ${dir} 失败`));
    const pageItems = result.list || [];
    all.push(...pageItems);
    if (pageItems.length < 1000) break;
  }
  return all.map((item) => ({
    fsId: item.fs_id,
    name: item.server_filename,
    isDir: item.isdir === 1,
    isEmpty: item.isdir === 1 && (Number(item.dir_empty) === 1 || Number(item.empty) === 1),
    size: Number(item.size || 0),
    path: item.path,
  }));
}

async function listDirectoryRecursive(cookie, bdstoken, folder = "", options = {}) {
  const root = normalizeFolder(folder);
  const recursive = Boolean(options.recursive);
  const maxDepth = Math.max(1, Math.min(20, Number(options.maxDepth) || 10));
  const maxItems = Math.max(100, Math.min(50000, Number(options.maxItems) || 20000));
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency) || 4));
  const queue = [{ path: root, depth: 0 }];
  const visited = new Set();
  const result = [];
  let cursor = 0;
  let active = 0;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const schedule = () => {
      if (settled) return;
      try { throwIfAborted(options.signal); } catch (error) { finish(error); return; }
      while (active < concurrency && cursor < queue.length && result.length < maxItems) {
        const current = queue[cursor];
        cursor += 1;
        if (visited.has(current.path)) continue;
        visited.add(current.path);
        active += 1;
        const discoveredItems = [];
        listDirectory(cookie, bdstoken, current.path, { signal: options.signal, maxItems: Math.max(1000, maxItems - result.length) })
          .then((children) => {
            for (const item of children) {
              if (result.length >= maxItems) break;
              const relativePath = root === "/"
                ? item.path.replace(/^\//, "")
                : item.path.replace(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\/?`), "");
              const discovered = { ...item, depth: current.depth, relativePath, parentPath: current.path };
              result.push(discovered);
              discoveredItems.push(discovered);
              if (recursive && item.isDir && !item.isEmpty && current.depth < maxDepth) {
                queue.push({ path: item.path, depth: current.depth + 1 });
              }
            }
          })
          .catch(finish)
          .finally(() => {
            active -= 1;
            options.onProgress?.({
              scannedDirectories: visited.size,
              queuedDirectories: Math.max(0, queue.length - cursor),
              foundItems: result.length,
              currentPaths: [current.path],
              items: discoveredItems,
            });
            if (settled) return;
            if (result.length >= maxItems || (active === 0 && cursor >= queue.length)) finish();
            else schedule();
          });
      }
      if (!settled && active === 0 && (cursor >= queue.length || result.length >= maxItems)) finish();
    };
    schedule();
  });
  return { items: result, truncated: result.length >= maxItems };
}

async function ensureDirectory(cookie, bdstoken, folder) {
  const path = normalizeFolder(folder);
  if (path === "/") return path;
  try {
    await listDirectory(cookie, bdstoken, folder);
    return path;
  } catch {
    const { text } = await request(`${BASE_URL}/api/create`, {
      cookie,
      method: "POST",
      params: { a: "commit", bdstoken },
      data: { path, isdir: 1, block_list: "[]" },
    });
    const result = parseJson(text);
    if (result.errno !== 0 && result.errno !== -8) throw new Error(errorMessage(result.errno, "创建目标目录失败"));
    return path;
  }
}

function parseSharePage(html) {
  const shareId = html.match(/"shareid":(\d+?),"/)?.[1];
  const shareUk = html.match(/"share_uk":"?(\d+?)"?,"/)?.[1];
  const fsIds = [...html.matchAll(/"fs_id":(\d+?),"/g)].map((match) => match[1]);
  const names = [...html.matchAll(/"server_filename":"(.+?)","/g)].map((match) => match[1]);
  if (!shareId || !shareUk || !fsIds.length) throw new Error(errorMessage(-1));
  return { shareId, shareUk, fsIds: [...new Set(fsIds)], names: [...new Set(names)] };
}

function extractTransferTargets(result, fallbackNames = []) {
  const entries = [
    ...(Array.isArray(result?.extra?.list) ? result.extra.list : []),
    ...(Array.isArray(result?.list) ? result.list : []),
  ];
  const fsIds = entries.map((entry) => {
    if (entry?.to_fs_id) return entry.to_fs_id;
    const target = entry?.target || entry;
    return target?.fsid || target?.fs_id || target?.to_fs_id || (typeof target === "number" ? target : "");
  }).filter(Boolean).map(String);
  const paths = entries.map((entry) => String(entry?.to || entry?.path || "")).filter(Boolean);
  const names = paths.map((value) => value.split("/").filter(Boolean).pop()).filter(Boolean);
  return {
    savedFsIds: [...new Set(fsIds)],
    savedPaths: [...new Set(paths)],
    names: names.length ? [...new Set(names)] : fallbackNames,
  };
}

async function transferOne(cookie, bdstoken, input, destination) {
  const parsed = normalizeShareInput(input);
  let requestCookie = cookie;
  if (parsed.code) {
    const { text } = await request(`${BASE_URL}/share/verify`, {
      cookie,
      method: "POST",
      params: {
        surl: shareKeyFromUrl(parsed.url), bdstoken, t: Date.now(), channel: "chunlei", web: 1, clienttype: 0,
      },
      data: { pwd: parsed.code, vcode: "", vcode_str: "" },
    });
    const verified = parseJson(text);
    logBaiduResult("share/verify", verified);
    if (verified.errno !== 0 || !verified.randsk) throw new Error(errorMessage(verified.errno, "提取码验证失败"));
    requestCookie = cookieWithBdclnd(cookie, verified.randsk);
  }
  const { text: html } = await request(parsed.url, { cookie: requestCookie, timeout: 25000 });
  const info = parseSharePage(html);
  const { text } = await request(`${BASE_URL}/share/transfer`, {
    cookie: requestCookie,
    method: "POST",
    timeout: 35000,
    redirect: "manual",
    params: { shareid: info.shareId, from: info.shareUk, bdstoken, channel: "chunlei", web: 1, clienttype: 0 },
    data: { fsidlist: `[${info.fsIds.join(",")}]`, path: normalizeFolder(destination) },
  });
  const result = parseJson(text);
  logBaiduResult("share/transfer", result);
  if (result.errno !== 0) throw new Error(errorMessage(result.errno, "转存失败"));
  const targets = extractTransferTargets(result, info.names);
  return {
    link: parsed.url,
    code: parsed.code,
    ...targets,
    destination: normalizeFolder(destination),
  };
}

function randomCode() {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

async function createShareForFsIds(cookie, bdstoken, fsIds, options = {}) {
  const ids = [...new Set((fsIds || []).map(String).filter((value) => /^\d+$/.test(value)))];
  if (!ids.length) throw new Error("没有找到本次转存的文件，无法自动分享");
  const password = options.randomPassword ? randomCode() : String(options.password || "1234");
  if (!/^[a-zA-Z0-9]{4}$/.test(password)) throw new Error("提取码必须为4位字母或数字");
  const period = [0, 1, 7, 30].includes(Number(options.period)) ? Number(options.period) : 7;
  const { text } = await request(`${BASE_URL}/share/set`, {
    cookie,
    method: "POST",
    params: { channel: "chunlei", bdstoken, clienttype: 0, app_id: 250528, web: 1 },
    data: {
      period, pwd: password, eflag_disable: "true", channel_list: "[]", schannel: 4, fid_list: `[${ids.join(",")}]`,
    },
  });
  const result = parseJson(text);
  if (result.errno !== 0 || !result.link) throw new Error(errorMessage(result.errno, "创建分享失败"));
  return { shareLink: `${result.link}?pwd=${password}`, password };
}

async function shareOne(cookie, bdstoken, item, options = {}) {
  return { ...item, ...(await createShareForFsIds(cookie, bdstoken, [item.fsId], options)) };
}

module.exports = {
  getBdstoken,
  listDirectory,
  listDirectoryRecursive,
  ensureDirectory,
  transferOne,
  createShareForFsIds,
  shareOne,
  normalizeFolder,
  extractTransferTargets,
};
