const ExcelJS = require("exceljs");
const path = require("node:path");

function cellText(cell) {
  const value = cell?.value;
  if (value == null) return "";
  if (typeof value === "object") {
    if (value.text) return String(value.text).trim();
    if (value.hyperlink) return String(value.hyperlink).trim();
    if (value.richText) return value.richText.map((item) => item.text).join("").trim();
    if (value.result != null) return String(value.result).trim();
  }
  return String(value).trim();
}

function findHeaderRow(worksheet) {
  const scanLimit = Math.min(20, worksheet.rowCount);
  for (let rowNumber = 1; rowNumber <= scanLimit; rowNumber += 1) {
    const first = cellText(worksheet.getRow(rowNumber).getCell(1));
    const second = cellText(worksheet.getRow(rowNumber).getCell(2));
    if (/名称|资源|标题|内容/.test(first) && /链接|地址|访问/.test(second)) return rowNumber;
    if (/^https?:\/\//i.test(second)) return Math.max(0, rowNumber - 1);
  }
  return 1;
}

const NETDISK_PROVIDERS = [
  { id: "baidu", name: "百度网盘", hostname: "pan.baidu.com", path: /^\/s\/[A-Za-z0-9_-]+\/?$/ },
  { id: "quark", name: "夸克网盘", hostname: "pan.quark.cn", path: /^\/s\/[A-Za-z0-9_-]+\/?$/ },
  { id: "xunlei", name: "迅雷云盘", hostname: "pan.xunlei.com", path: /^\/s\/[A-Za-z0-9_-]+\/?$/ },
];

function validateNetdiskLink(rawValue) {
  const text = String(rawValue ?? "").replace(/\s+/g, " ").trim();
  const match = text.match(/https:\/\/(?:pan\.baidu\.com|pan\.quark\.cn|pan\.xunlei\.com)\/[^\s<>"']+/i);
  if (!match) {
    return { valid: false, reason: "第二列不是受支持的百度、夸克或迅雷网盘 HTTPS 分享链接" };
  }
  const candidate = match[0].replace(/[，。；;,]+$/g, "");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { valid: false, reason: "网盘链接格式无法解析" };
  }
  const provider = NETDISK_PROVIDERS.find((item) => item.hostname === parsed.hostname.toLowerCase());
  if (parsed.protocol !== "https:" || !provider) {
    return { valid: false, reason: "链接必须使用受支持网盘的官方 HTTPS 域名" };
  }
  const isSharePath = provider.path.test(parsed.pathname)
    || (provider.id === "baidu" && parsed.pathname === "/share/init" && Boolean(parsed.searchParams.get("surl")));
  if (!isSharePath) {
    return { valid: false, reason: `不是受支持的${provider.name}分享链接路径` };
  }
  const queryCode = parsed.searchParams.get("pwd");
  const textCode = text.match(/(?:提取码|密码)\s*[:：]?\s*([A-Za-z0-9]{4})/i)?.[1];
  const code = queryCode || textCode;
  if (provider.id === "baidu" && !/^[A-Za-z0-9]{4}$/.test(code || "")) {
    return { valid: false, reason: "链接缺少4位提取码（pwd参数或“提取码：xxxx”）" };
  }
  return { valid: true, url: candidate, code: code || "", provider: provider.id, providerName: provider.name };
}

const validateBaiduLink = validateNetdiskLink;

async function readSourceWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Excel中没有可读取的工作表");

  const headerRow = findHeaderRow(worksheet);
  let currentName = "";
  const rows = [];
  const issues = [];
  let inputRows = 0;

  for (let rowNumber = headerRow + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const rawName = cellText(row.getCell(1));
    const link = cellText(row.getCell(2));
    if (!rawName && !link) continue;
    inputRows += 1;
    if (rawName) currentName = rawName;
    if (!currentName) {
      issues.push({ row: rowNumber, type: "missing-name", message: "名称为空且无法从合并区域补全" });
      continue;
    }
    if (!link) {
      issues.push({ row: rowNumber, type: "missing-link", message: "链接为空" });
      continue;
    }
    const linkCheck = validateNetdiskLink(link);
    if (!linkCheck.valid) {
      issues.push({ row: rowNumber, type: "invalid-link", message: linkCheck.reason });
      continue;
    }
    rows.push({ sourceRow: rowNumber, name: currentName, link });
  }

  if (!inputRows) throw new Error("未读取到数据，请确认第一张工作表包含名称列和链接列");
  return {
    fileName: path.basename(filePath),
    sheetName: worksheet.name,
    headerRow,
    total: rows.length,
    inputRows,
    invalidRows: issues.length,
    isValid: issues.length === 0 && rows.length === inputRows,
    issues,
    rows,
    preview: rows.slice(0, 8),
  };
}

async function readShareHistoryWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Excel中没有可读取的工作表");
  const firstHeader = cellText(worksheet.getRow(1).getCell(1)).toLowerCase();
  if (!/fs[_\s-]?id|文件id|网盘id/.test(firstHeader)) throw new Error("不是有效的分享历史备份文件");
  const byFsId = new Map();
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const fsId = cellText(row.getCell(1));
    const shareLink = cellText(row.getCell(5));
    if (!fsId && !shareLink) continue;
    if (!/^\d+$/.test(fsId) || !/^https:\/\/pan\.baidu\.com\//i.test(shareLink)) continue;
    byFsId.set(fsId, {
      fsId,
      name: cellText(row.getCell(2)).slice(0, 500),
      path: cellText(row.getCell(3)).slice(0, 1500),
      isDir: /文件夹|目录|folder/i.test(cellText(row.getCell(4))),
      shareLink: shareLink.slice(0, 3000),
      password: cellText(row.getCell(6)).slice(0, 20),
      sharedAt: cellText(row.getCell(7)).slice(0, 80),
    });
  }
  if (!byFsId.size) throw new Error("备份文件中没有有效的分享历史记录");
  return { fileName: path.basename(filePath), total: byFsId.size, rows: [...byFsId.values()] };
}

async function exportShareHistoryWorkbook(rows, filePath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "知道助手";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("分享历史");
  worksheet.columns = [
    { header: "fs_id", key: "fsId", width: 24 },
    { header: "资源名称", key: "name", width: 36 },
    { header: "网盘路径", key: "path", width: 48 },
    { header: "类型", key: "type", width: 12 },
    { header: "分享链接", key: "shareLink", width: 52 },
    { header: "提取码", key: "password", width: 12 },
    { header: "分享时间", key: "sharedAt", width: 24 },
  ];
  for (const row of rows) {
    worksheet.addRow({
      fsId: String(row.fsId || ""), name: String(row.name || ""), path: String(row.path || ""),
      type: row.isDir ? "文件夹" : "文件", shareLink: String(row.shareLink || ""),
      password: String(row.password || ""), sharedAt: String(row.sharedAt || ""),
    });
  }
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = { from: "A1", to: "G1" };
  const header = worksheet.getRow(1);
  header.height = 24;
  header.font = { name: "微软雅黑", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
  header.alignment = { horizontal: "center", vertical: "middle" };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F6FD6" } };
  for (let index = 2; index <= worksheet.rowCount; index += 1) {
    const row = worksheet.getRow(index);
    row.font = { name: "微软雅黑", size: 10 };
    row.alignment = { vertical: "middle" };
    row.getCell(1).numFmt = "@";
    row.getCell(5).numFmt = "@";
    row.getCell(6).numFmt = "@";
  }
  await workbook.xlsx.writeFile(filePath);
  return { filePath, count: rows.length };
}

function styleOutputSheet(worksheet, rowCount) {
  worksheet.columns = [
    { key: "qid", width: 8 },
    { key: "title", width: 45 },
    { key: "primaryCategory", width: 12 },
    { key: "secondaryCategory", width: 12 },
    { key: "publishedAt", width: 16 },
    { key: "answer", width: 80 },
  ];

  const header = worksheet.getRow(1);
  header.font = { name: "宋体", size: 11, bold: true, color: { argb: "FF000000" } };
  header.alignment = { horizontal: "center", vertical: "middle" };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" }, bgColor: { argb: "FFD9E1F2" } };

  for (let index = 2; index <= rowCount + 1; index += 1) {
    const row = worksheet.getRow(index);
    row.font = { name: "宋体", size: 11, color: { argb: "FF000000" } };
  }
}

async function exportResultWorkbook(rows, outputPath) {
  if (!rows.length) throw new Error("没有已完成的数据可导出");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "知道助手";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.addRow([
    "qid",
    "问题标题",
    "一级分类",
    "二级分类",
    "问题发布时间",
    "回答内容",
  ]);
  for (const item of rows) {
    worksheet.addRow([null, item.title, null, null, null, item.answer]);
  }
  styleOutputSheet(worksheet, rows.length);
  await workbook.xlsx.writeFile(outputPath);
  return { outputPath, count: rows.length };
}

async function exportTransferShareWorkbook(rows, outputPath) {
  const validRows = (rows || []).filter((item) => item?.name && item?.link);
  if (!validRows.length) throw new Error("没有已成功生成分享链接的结果可导出");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "知道助手";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("转存分享结果");
  worksheet.addRow(["资源名称", "分享链接"]);
  for (const item of validRows) worksheet.addRow([String(item.name), String(item.link)]);
  worksheet.columns = [{ width: 42 }, { width: 72 }];
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = { from: "A1", to: "B1" };
  const header = worksheet.getRow(1);
  header.height = 28;
  header.font = { name: "Microsoft YaHei", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  header.alignment = { horizontal: "center", vertical: "middle" };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
  for (let index = 2; index <= validRows.length + 1; index += 1) {
    const row = worksheet.getRow(index);
    row.height = 24;
    row.font = { name: "Microsoft YaHei", size: 10, color: { argb: "FF172033" } };
    row.alignment = { vertical: "middle", wrapText: true };
    row.getCell(2).font = { name: "Microsoft YaHei", size: 10, color: { argb: "FF2563EB" } };
    row.eachCell((cell) => {
      cell.border = { bottom: { style: "thin", color: { argb: "FFE5EAF1" } } };
    });
  }
  await workbook.xlsx.writeFile(outputPath);
  return { outputPath, count: validRows.length };
}

module.exports = {
  readSourceWorkbook,
  readShareHistoryWorkbook,
  exportResultWorkbook,
  exportTransferShareWorkbook,
  exportShareHistoryWorkbook,
  cellText,
  validateBaiduLink,
  validateNetdiskLink,
};
