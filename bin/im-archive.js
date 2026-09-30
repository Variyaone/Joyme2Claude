#!/usr/bin/env node
/**
 * im-archive.js — 京ME 聊天记录全历史检索（采集 + 查询 + 邮件直读，单文件零依赖）
 *
 * 原理（2026-09-30 打通）：京ME 桌面端 IM 没有独立的历史库文件（已穷尽排查
 * profile 存储/加密db/进程内存），历史在服务端+客户端内存——但桌面端 IM/main.log
 * 全量记录三类事件，只要解析它们，"app 能看到的就都能查到"：
 *   1. message/subscriptions/imChatNotify        新收消息（原文+会话+时间戳）
 *   2. message/reducers/appendMessages（loadMore）用户滚动翻历史时 SDK 拉回的消息
 *      数组逐字写日志 → 正常使用会话时历史自动落盘（这是回查历史的关键通道）
 *   3. Pc_Event_Im_MsgReceive                     埋点（发送人/群/@）
 *
 * 日志滚转只有 ~1.5 天，所以要增量采集进自己的 store（JSONL，按月分文件，追加式）。
 * 邮件则是本地 SQLite（mail.db）全历史原文，直接只读副本查询。
 *
 * 用法:
 *   node im-archive.js collect [--full]          增量采集（跳过未变化的日志文件；--full 重扫）
 *   node im-archive.js search <关键词> [--days N] [--session X] [--from X] [--json]
 *   node im-archive.js stats                     store 覆盖统计（按月/按天/找缺口）
 *   node im-archive.js mail <关键词>             搜邮件全历史（mail.db 直读）
 *
 * 选项:
 *   --store <目录>     store 位置（默认 %LOCALAPPDATA%/joyme2claude/im-store，
 *                      或环境变量 IM_STORE_DIR）。数据不进本仓库。
 *
 * 前提：京ME桌面端曾在本机运行过。pin 自动发现（同 jm-forensics.js）。
 * 需 Node ≥ 22.5（mail 子命令用内置 node:sqlite）。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const LA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const JOYME = path.join(LA, "JoyMe");
const DEFAULT_STORE = path.join(LA, "joyme2claude", "im-store");

// ---------- 参数 ----------
const args = process.argv.slice(2);
const cmd = args[0];
const getOpt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const STORE_DIR = getOpt("--store") || process.env.IM_STORE_DIR || DEFAULT_STORE;
const flags = {};
for (const a of args.slice(1)) if (a.startsWith("--")) flags[a] = true;
let query = null;
{
  // 跳过所有 '--opt value' 对，剩下的第一个位置参数才是关键词
  const optValues = new Set();
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) { if (args[i + 1] && !args[i + 1].startsWith("--") && !["collect","search","stats","mail"].includes(args[i+1])) optValues.add(args[i + 1]); i++; }
  }
  for (const a of args.slice(1)) {
    if (a.startsWith("--") || optValues.has(a)) continue;
    query = a; break;
  }
}
const days = getOpt("--days") ? Number(getOpt("--days")) : null;
const from = (getOpt("--from") || "").toLowerCase();
const session = getOpt("--session") || "";

// ---------- 公共 ----------
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
function loadJSON(f, def) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } }
function saveJSON(f, o) { fs.writeFileSync(f, JSON.stringify(o, null, 2)); }

// 日志里事件名后紧跟 payload（"...imChatNotify",{...} / '{"messages"...}）：
// 平衡括号解析（字符串内括号/转义安全）。anchor 是行内锚点串，openOff 是
// anchor 内 payload 起始字符 '{'/'[' 相对 anchor 起点的偏移；若 anchor 内
// 不含 '{'/'['，则 payload 从 anchor 之后第一个 '{'/'[' 开始。
function parsePayload(line, anchor) {
  const p = line.indexOf(anchor);
  if (p < 0) return null;
  const rel = anchor.search(/[{[]/);
  let start = rel >= 0 ? p + rel : -1;
  if (start < 0) {
    const seg = line.slice(p + anchor.length);
    const m = seg.search(/[{[]/);
    if (m < 0) return null;
    start = p + anchor.length + m;
  }
  const seg0 = line.slice(start);
  const seg = seg0[0] === ":" ? seg0.slice(1) : seg0;
  const open = seg[0];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let k = 0; k < seg.length && k < 2000000; k++) {
    const c = seg[k];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { try { return JSON.parse(seg.slice(0, k + 1)); } catch { return null; } } }
  }
  return null;
}

// ---------- 采集 ----------
function collect() {
  const pin = findPin();
  const dir = path.join(JOYME, pin, "IM");
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const stateFile = path.join(STORE_DIR, "im-collect-state.json");
  const state = loadJSON(stateFile, { done: {}, seen: [] });
  const seen = new Set(state.seen || []);
  const now = new Date();
  const storeFile = path.join(STORE_DIR, "im-" + now.toISOString().slice(0, 7) + ".jsonl");
  const sink = [];

  const files = fs.readdirSync(dir).filter((f) => /^main\.log(\.\d+)?$/.test(f));
  for (const fn of files) {
    const fp = path.join(dir, fn);
    const st = fs.statSync(fp);
    const sig = fn + ":" + st.size + ":" + Math.floor(st.mtimeMs);
    if (!flags["--full"] && state.done[fn] && state.done[fn].sig === sig) continue;
    const text = fs.readFileSync(fp, "utf8");
    let n = 0;

    // 1) imChatNotify: ["message/subscriptions/imChatNotify",{...,"sessionId":..,"content":..,"name":..,"timestamp":..}]
    let idx = 0;
    while ((idx = text.indexOf("message/subscriptions/imChatNotify", idx)) >= 0) {
      const obj = parsePayload(text.slice(Math.max(0, idx - 2), idx + 4000), 'imChatNotify",');
      idx += 34;
      if (!obj || obj.sessionId === undefined || !obj.content) continue;
      const dedup = obj.sessionId + "|" + obj.timestamp + "|" + obj.content.slice(0, 40);
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      sink.push({ ch: "new", ts: obj.timestamp, session: obj.name || obj.sessionId, sessionId: obj.sessionId, text: String(obj.content).slice(0, 4000) });
      n++;
    }

    // 2) loadMore 批次: ["message/reducers/appendMessages <- ...",{"messages":[{body:{content},sender:{pin},timestamp,uuid}..]}]
    idx = 0;
    while ((idx = text.indexOf("message/reducers/appendMessages <-", idx)) >= 0) {
      const lineStart = text.lastIndexOf("\n", idx) + 1;
      const lineEnd = text.indexOf("\n", idx);
      const line = text.slice(lineStart, lineEnd > 0 ? lineEnd : undefined);
      idx = lineEnd > 0 ? lineEnd : idx + 35;
      const obj = parsePayload(line, '{"messages"');
      const msgs = Array.isArray(obj) ? obj : (obj && obj.messages) || [];
      for (const msg of msgs) {
        if (!msg) continue;
        const bodyText = (msg.body && msg.body.content) || msg.content || "";
        const ts = msg.timestamp || 0;
        if (!bodyText || !ts) continue;
        const dedup = (msg.uuid || msg.id || "nu") + "|" + ts;
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        sink.push({ ch: "loadmore", ts, sender: (msg.sender && msg.sender.pin) || "", sessionId: msg.sessionId, text: String(bodyText).slice(0, 4000) });
        n++;
      }
    }

    // 3) MsgReceive 埋点（含 Msguuid/SenderPin/ChatType）
    idx = 0;
    while ((idx = text.indexOf("Pc_Event_Im_MsgReceive", idx)) >= 0) {
      const seg = text.slice(idx, idx + 2500);
      idx += 22;
      const key = '"params":"';
      const pIdx = seg.indexOf(key);
      if (pIdx < 0) continue;
      let str = seg.slice(pIdx + key.length), out = "", j = 0;
      while (j < str.length) {
        if (str[j] === "\\") { out += str[j] + (str[j + 1] || ""); j += 2; continue; }
        if (str[j] === '"') break;
        out += str[j]; j++;
      }
      let p; try { p = JSON.parse('"' + out + '"'); } catch { continue; }
      const dedup = "rcv|" + p.Msguuid;
      if (!p.Msguuid || seen.has(dedup)) continue;
      seen.add(dedup);
      sink.push({ ch: "recv", ts: p.ClickTime || p.SendTime || "", chat: p.ChatType, from: p.SenderPin, gid: p.Gid, text: p.Content || "" });
      n++;
    }

    console.error(`${fn}: +${n}`);
    if (fn !== "main.log") state.done[fn] = { sig, at: now.toISOString() };
  }

  if (sink.length) fs.appendFileSync(storeFile, sink.map((e) => JSON.stringify(e)).join("\n") + "\n");
  console.error(`total +${sink.length} -> ${storeFile}`);
  state.seen = [...seen].slice(-50000);
  saveJSON(stateFile, state);
}

// ---------- 查询 ----------
function tsOf(o) {
  if (typeof o.ts === "number") return o.ts;
  const p = Date.parse(o.ts);
  return isNaN(p) ? 0 : p;
}
function search() {
  const files = fs.readdirSync(STORE_DIR).filter((f) => /^im-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  const cutoff = days ? Date.now() - days * 86400e3 : 0;
  const rows = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(STORE_DIR, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const ts = tsOf(o);
      if (cutoff && ts < cutoff) continue;
      if (from && !((o.sender || "").toLowerCase().includes(from) || String(o.text || "").toLowerCase().includes(from))) continue;
      if (session && !((o.session || "") + (o.sessionId || "")).includes(session)) continue;
      if (query && !String(o.text || "").toLowerCase().includes(query.toLowerCase())) continue;
      rows.push({ ts, ...o });
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  if (flags["--json"]) { console.log(JSON.stringify(rows)); return; }
  for (const o of rows) {
    const d = new Date(o.ts);
    const t = isNaN(d) ? String(o.ts).replace(/T.*$/, "") : new Date(d + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 16);
    const who = o.sender || o.session || (o.from ? String(o.from) : "?");
    const sess = (o.session || o.sessionId ? "[" + (o.session || o.sessionId) + "] " : "");
    console.log(`${t} | ${String(who).padEnd(22).slice(0, 22)} | ${sess}${String(o.text || "").replace(/\s+/g, " ").slice(0, 120)}`);
  }
  console.log(`--- ${rows.length} 条命中 (store: ${STORE_DIR})`);
}

function stats() {
  const files = fs.readdirSync(STORE_DIR).filter((f) => /^im-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  console.log(`store: ${STORE_DIR}`);
  for (const f of files) {
    const objs = fs.readFileSync(path.join(STORE_DIR, f), "utf8").trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const tss = objs.map(tsOf).filter((t) => t > 1e12).sort((a, b) => a - b);
    const byCh = {}; objs.forEach((o) => byCh[o.ch] = (byCh[o.ch] || 0) + 1);
    console.log(`${f}: ${objs.length} 条 [${Object.entries(byCh).map((x) => x.join(":")).join(" ")}]`);
    if (tss.length) {
      console.log(`  时间范围: ${new Date(tss[0]).toISOString().slice(0, 10)} ~ ${new Date(tss[tss.length - 1]).toISOString().slice(0, 10)}`);
      const daysMap = {};
      tss.forEach((t) => { const d = new Date(t).toISOString().slice(0, 10); daysMap[d] = (daysMap[d] || 0) + 1; });
      console.log("  按天: " + Object.entries(daysMap).sort().map((x) => x[0].slice(5) + "(" + x[1] + ")").join(" "));
    }
  }
  if (!files.length) console.log("(空 store——先跑 collect)");
}

// ---------- 邮件直读 ----------
function findMailDb() {
  const pin = findPin();
  const root = path.join(JOYME, "User Data", `ee+${pin}`, "JoyMailDB");
  const out = [];
  (function walk(d) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "mail.db") out.push(p);
    }
  })(root);
  return out[0] || null;
}
function mailSearch() {
  let sq;
  try { sq = require("node:sqlite"); } catch { console.error("需要 Node ≥ 22.5（内置 node:sqlite）"); process.exit(1); }
  const dbPath = findMailDb();
  if (!dbPath) { console.error("未找到 mail.db（JoyMailDB）——京ME邮件账号在本机登录过吗？"); process.exit(1); }
  const tmp = path.join(os.tmpdir(), "joyme2claude-mail-query.db");
  fs.copyFileSync(dbPath, tmp);
  for (const ext of ["-wal", "-shm"]) try { fs.copyFileSync(dbPath + ext, tmp + ext); } catch {}
  const db = new sq.DatabaseSync(tmp, { readOnly: true });
  const like = "%" + (query || "") + "%";
  const rows = db.prepare(
    `SELECT DateTimeSentStr, FromName, Subject, PreviewText, MailBodyText FROM t_sessions
     WHERE MailBodyText LIKE ? OR Subject LIKE ? OR FromName LIKE ?
     ORDER BY DateTimeSent DESC LIMIT 200`
  ).all(like, like, like);
  for (const r of rows) {
    const body = String(r.MailBodyText || r.PreviewText || "").replace(/\s+/g, " ").slice(0, 150);
    console.log(`${r.DateTimeSentStr} | ${String(r.FromName).slice(0, 25)} | ${String(r.Subject).slice(0, 55)}\n    ${body}`);
  }
  console.log(`--- ${rows.length} 封邮件命中 (${dbPath})`);
}

// ---------- main ----------
if (cmd === "collect") collect();
else if (cmd === "search") { if (!query && !from && !session) { console.error("用法: node im-archive.js search <关键词> [--days N] [--session X] [--from X] [--json]"); process.exit(1); } search(); }
else if (cmd === "stats") stats();
else if (cmd === "mail") { if (!query) { console.error("用法: node im-archive.js mail <关键词>"); process.exit(1); } mailSearch(); }
else {
  console.error(`用法:
  node im-archive.js collect [--full] [--store <目录>]   增量采集京ME IM 日志（--full 重扫全部）
  node im-archive.js search <关键词> [--days N] [--session X] [--from X] [--json]
  node im-archive.js stats                                 store 覆盖统计
  node im-archive.js mail <关键词>                          搜邮件全历史（mail.db 直读）
默认 store: ${DEFAULT_STORE}（可用 --store 或环境变量 IM_STORE_DIR 覆盖）`);
  process.exit(1);
}
