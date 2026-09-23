#!/usr/bin/env node
/**
 * jm-forensics.js — 京ME 桌面端本地取证：消息原文 + 卡片图像 + 卡片元信息
 *
 * 不调任何 API、不需要认证——纯读京ME桌面端落在本地磁盘的日志与缓存。
 * 前提：京ME桌面端曾在本机运行过（产生过日志/缓存即可，不要求当前在线）。
 *
 * 原理（2026-09-23 打通，详见项目 README）：
 *   1. 消息原文  %LOCALAPPDATA%/JoyMe/<pin>/IM/main.log*  每行 JSON，含会话 lastMsg 消息体
 *   2. 卡片图像  %LOCALAPPDATA%/JoyMe/User Data/ee+<pin>/Cache/Cache_Data/data_1
 *                卡片里的图是京东云 OSS 签名 URL，渲染后留在 Chromium 缓存里，
 *                grep s3.cn-north-1.jdcloud-oss 拿完整 URL（签名 ~30 天有效）
 *   3. 卡片元信息 IM 日志里 jdme_messagecard_appid，cardData.content = 4字符前缀 + base64(JSON)
 *
 * 用法:
 *   node jm-forensics.js --im-log [关键词] [--all]     提取消息原文（近4个日志文件/全部）
 *   node jm-forensics.js --im-log --json               原始 JSON 输出（供程序处理）
 *   node jm-forensics.js --card-images                 从缓存提取全部卡片图 URL（含文件名/报表ID）
 *   node jm-forensics.js --card-images --report <ID>   只看某报表 ID 的图
 *   node jm-forensics.js --card-images --download <目录> [--report <ID>]
 *                                                       下载 PNG 到目录（--download 默认 ./）
 *   node jm-forensics.js --card-meta [关键词]           解码卡片元信息（报表ID/窗口/标题）
 *
 * pin 自动发现：取 %LOCALAPPDATA%/JoyMe/ 下第一个非默认目录名。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const LA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const JOYME = path.join(LA, "JoyMe");

function findPin() {
  try {
    const dirs = fs.readdirSync(JOYME).filter((d) =>
      fs.existsSync(path.join(JOYME, d, "IM", "main.log")) && !["default", "User Data", "TraceDock", "updateLogs"].includes(d)
    );
    if (!dirs.length) throw new Error("no IM log dir");
    return dirs[0];
  } catch {
    console.error(`未找到京ME IM 日志目录（${JOYME}\\<pin>\\IM\\main.log）——京ME桌面端在本机运行过吗？`);
    process.exit(1);
  }
}

// ===== 1. 消息原文 =====

function extractImLog({ keyword, all, json }) {
  const pin = findPin();
  const dir = path.join(JOYME, pin, "IM");
  let files = fs.readdirSync(dir).filter((f) => /^main\.log/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.f);
  if (!all) files = files.slice(0, 4);

  // 消息对象: "content":"...","id":NNN,"isRichText":...,"sender":{...,"pin":"..."},"state":N,"timestamp":NNN
  const pat = /"content":"((?:[^"\\]|\\.){5,1200})","id":(\d+),"isRichText":\w+,"sender":\{"app":"[a-z.]+","isDigitalEmployee":(?:true|false),"markStar":(?:true|false),"pin":"([a-z0-9._-]*)","teamId":"[^"]*"\},"state":\d+,"timestamp":(\d+)/g;

  const seen = new Map();
  for (const f of files) {
    let s;
    try { s = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    for (const m of s.matchAll(pat)) {
      const mid = Number(m[2]);
      if (!seen.has(mid)) seen.set(mid, { ts: Number(m[4]), pin: m[3], content: m[1].replace(/\\n/g, " ") });
    }
  }
  const rows = [...seen.values()].sort((a, b) => a.ts - b.ts)
    .filter((r) => !keyword || r.content.toLowerCase().includes(keyword.toLowerCase()) || r.pin.toLowerCase() === keyword.toLowerCase());

  if (json) { console.log(JSON.stringify(rows)); return; }
  console.log(`# 京ME IM 日志消息提取 | pin=${pin} | 文件数 ${files.length} | 消息 ${rows.length} 条 | ${new Date().toISOString()}`);
  for (const r of rows) {
    const dt = new Date(r.ts + 8 * 3600e3); // 显示北京时间
    const p = dt.toISOString().slice(5, 16).replace("T", " ");
    console.log(`${p} | ${r.pin.padEnd(22)} | ${r.content.slice(0, 260)}`);
  }
}

// ===== 2. 卡片图像 URL =====

function cacheFile(pin) {
  const c = path.join(JOYME, "User Data", `ee+${pin}`, "Cache", "Cache_Data", "data_1");
  if (!fs.existsSync(c)) {
    console.error(`渲染缓存不存在: ${c}——打开过京ME的卡片消息后再试`);
    process.exit(1);
  }
  return c;
}

function extractCardUrls({ report, download }) {
  const pin = findPin();
  const buf = fs.readFileSync(cacheFile(pin)).toString("latin1");
  const urls = [...new Set([...buf.matchAll(/https:\/\/s3\.cn-north-1\.jdcloud-oss\.com[!-~]{5,300}/g)].map((m) => m[0]))];
  const byName = {};
  for (const u of urls) {
    const m = u.match(/screen-([A-Za-z0-9_]+-\d+)\.png/);
    if (m) byName[m[1]] = u;
  }
  const names = Object.keys(byName)
    .filter((n) => !report || n.startsWith(report + "-"))
    .sort();

  if (!download) {
    console.log(`# 卡片图像 URL | pin=${pin} | 缓存 URL ${urls.length} 条，screen 截图 ${Object.keys(byName).length} 张`);
    for (const n of names) console.log(`${n}  ${byName[n].slice(0, 120)}...`);
    return;
  }
  downloadUrls(byName, names, download);
}

async function downloadUrls(byName, names, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const n of names) {
    const dest = path.join(destDir, `${n}.png`);
    try {
      const res = await fetch(byName[n]);
      if (!res.ok) { console.error(`✗ ${n} HTTP ${res.status}`); continue; }
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      console.log(`✓ ${dest}`);
    } catch (e) { console.error(`✗ ${n} ${e.message}`); }
  }
}

// ===== 3. 卡片元信息 =====

function extractCardMeta(keyword) {
  const pin = findPin();
  const dir = path.join(JOYME, pin, "IM");
  const files = fs.readdirSync(dir).filter((f) => /^main\.log/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime).map((x) => x.f).slice(0, 8);
  // 卡片正文在日志里形如 ...jdme_messagecard_botid":"..."},"content":"qg6g<base64>"...
  // 格式：4字符前缀 + base64(半压缩JSON)。压缩段的字节非 UTF-8，
  // 按 utf-8 容错解码丢弃非法字节后，ASCII 字段(resourceId/contentInfo/title)仍可正则提取。
  const cards = [];
  for (const f of files) {
    let s;
    try { s = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    const lines = s.split("\n");
    for (const line of lines) {
      if (!line.includes("jdme_messagecard_appid")) continue;
      for (const m of line.matchAll(/"content":"([A-Za-z0-9+/=]{50,})"/g)) {
        try {
          const raw = Buffer.from(m[1].slice(4), "base64");
          const t = raw.toString("utf8"); // invalid bytes → U+FFFD replacement chars, regex still works
          const rid = t.match(/"resourceId":(\d{7,9})/);
          if (!rid) continue;
          const info = t.match(/tentInfo":"([A-Za-z]+day, [A-Za-z]+ \d+, \d{4})/);
          const title = t.match(/"text":"([^"]{5,120})"/);
          const xval = t.match(/xValue":"([^"]{4,40})"/);
          cards.push({
            resourceId: rid?.[1], window: xval?.[1] || null,
            contentInfo: info?.[1] || null, title: title?.[1] || null,
          });
        } catch { /* skip undecodable */ }
      }
    }
  }
  // 抽取到的卡片直接输出（字段已在解码时正则提取）
  const dedup = [];
  const keys = new Set();
  for (const o of cards) {
    const k = `${o.resourceId}|${o.contentInfo}|${o.title}`;
    if (keys.has(k)) continue;
    keys.add(k);
    if (keyword && !(`${o.resourceId} ${o.title || ""} ${o.contentInfo || ""}`.toLowerCase().includes(keyword.toLowerCase()))) continue;
    dedup.push(o);
  }
  console.log(`# 卡片元信息 | pin=${pin} | 解码 ${cards.length} 条，去重 ${dedup.length} 条`);
  dedup.forEach((o, i) => console.log(`${i + 1}. report=${o.resourceId} | 窗口=${o.contentInfo || "?"} | xValue=${o.window || "?"} | ${o.title || ""}`));
}

// ===== main =====

const [, , cmd, ...rest] = process.argv;
const getOpt = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : null;
};

if (cmd === "--im-log") {
  const kw = rest.find((a, i) => i > 0 || !a.startsWith("--")) || null;
  const first = rest[0];
  const keyword = first && !first.startsWith("--") ? first : null;
  extractImLog({ keyword, all: rest.includes("--all"), json: rest.includes("--json") });
} else if (cmd === "--card-images") {
  extractCardUrls({ report: getOpt("--report"), download: getOpt("--download") });
} else if (cmd === "--card-meta") {
  extractCardMeta(rest.find((a) => !a.startsWith("--")));
} else {
  console.error(`用法:
  node jm-forensics.js --im-log [关键词] [--all] [--json]   消息原文（近4个日志/全部）
  node jm-forensics.js --card-images [--report <ID>] [--download <目录>]
  node jm-forensics.js --card-meta [关键词]                  卡片元信息`);
  process.exit(1);
}
