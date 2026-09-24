#!/usr/bin/env node
// 视频生成（文生视频，异步两步式：提交 → 轮询），零依赖 Node ≥ 18
// 网关地址/app code 不写入仓库，运行时从环境变量读取（自动加载同仓库 .env.local）
//
// 用法:
//   node video-gen.js --prompt "清晨的森林湖泊，薄雾缭绕"
//   node video-gen.js --prompt "..." --duration 10 --mode 1080p --aspect-ratio 9:16 --no-audio
//   node video-gen.js --resume <任务快照.json>            恢复中断任务继续轮询
//   node video-gen.js --task-id <id>                       只查询已有任务
//   node video-gen.js --save [输出.mp4]                    成功后下载视频
//
// 参数:
//   --prompt <文本>          必填（除非 --resume/--task-id），≤3500 字符
//   --duration <4-15>        秒数，整数字符串，默认 5
//   --mode <分辨率>          480p/720p/1080p/4k，默认 720p
//   --aspect-ratio <比例>    16:9/9:16/4:3/1:1/3:4/21:9，默认 16:9
//   --no-audio               不生成音频（默认生成）
//   --return-last-frame      返回尾帧图
//   --key <幂等键>           自定义幂等键（默认自动生成；同键+同参数重试返回同一任务）
//   --save [路径]            成功后下载视频文件
//   --resume <json>          从任务快照恢复轮询
//   --task-id <id>           查询指定任务
//   --timeout <秒>           轮询总超时，默认 600（10 分钟）

// 自动加载同仓库的 .env.local（真实地址只存本机，不进 git）
(function loadEnvLocal() {
  const fs = require("fs"), path = require("path");
  for (const p of [path.join(__dirname, "..", ".env.local"), path.join(__dirname, ".env.local")]) {
    try {
      const txt = fs.readFileSync(p, "utf8");
      for (const line of txt.split("\n")) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"\r\n]*)"?\s*$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
      }
      return;
    } catch { /* try next */ }
  }
})();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function requireEnv(name, value) {
  if (!value || value.includes("<")) {
    console.error(`缺少环境变量 ${name}（本仓库不含内部网关地址，请在 .env.local 设置后重试，README 有清单）`);
    process.exit(2);
  }
  return value;
}
const GW = requireEnv("JOYME_VIDEO_GW", process.env.JOYME_VIDEO_GW);
const APP_CODE = process.env.JOYME_VIDEO_APPCODE || "hermes";

const TASKS_DIR = path.join(__dirname, "video-tasks");
try { fs.mkdirSync(TASKS_DIR, { recursive: true }); } catch {}

async function rfetch(url, opts = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fetch(new Request(url, opts)); }
    catch (e) { lastErr = e; if (i < retries) await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
  throw lastErr;
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--no-audio" || t === "--return-last-frame") { a[t.slice(2)] = true; continue; }
    if (t.startsWith("--")) {
      const k = t.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { a[k] = next; i++; }
      else a[k] = true;
    } else a._.push(t);
  }
  return a;
}

async function submitTask(a) {
  const prompt = a.prompt || a._.join(" ");
  if (!prompt) { console.error("用法: node video-gen.js --prompt <提示词>（≤3500字符）"); process.exit(1); }
  if (prompt.length > 3500) { console.error("prompt 超过 3500 字符"); process.exit(1); }
  const body = { prompt };
  if (a.duration) {
    const d = parseInt(a.duration, 10);
    if (!(d >= 4 && d <= 15)) { console.error("duration 需为 4~15 的整数"); process.exit(1); }
    body.duration = String(d);
  }
  if (a.mode) body.mode = a.mode;                       // 480p/720p/1080p/4k
  if (a["aspect-ratio"]) body.aspectRatio = a["aspect-ratio"];
  if (a["no-audio"] === true) body.generateAudio = false;
  if (a["return-last-frame"] === true) body.returnLastFrame = true;

  const idemKey = a.key || ("joyme2claude-" + crypto.randomUUID());
  const res = await rfetch(`${GW}/api/v1/videos/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-app-code": APP_CODE,
      "Idempotency-Key": idemKey,
      "X-Request-Id": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`提交失败 HTTP ${res.status}: ${text.slice(0, 300)}`); }
  if (!res.ok || !j.taskId) {
    throw new Error(`提交失败 HTTP ${res.status} code=${j.code || ""} message=${j.message || text.slice(0, 200)}`);
  }
  console.error(`已提交 taskId=${j.taskId} (幂等键=${idemKey}, 状态=${j.status})`);
  return { taskId: j.taskId, idemKey, params: body };
}

async function queryTask(taskId) {
  const res = await rfetch(`${GW}/api/v1/videos/tasks/${encodeURIComponent(taskId)}`, {
    headers: { "x-app-code": APP_CODE }, // 提交与查询的 appCode 必须一致
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`查询失败 HTTP ${res.status}: ${text.slice(0, 300)}`); }
  if (!res.ok) {
    throw new Error(`查询失败 HTTP ${res.status} code=${j.code || ""} message=${j.message || ""}`);
  }
  return { j, retryAfter: parseInt(res.headers.get("retry-after") || "", 10) || 0 };
}

function normalizeStatus(j) {
  // 以归一化 status 为准；兼容大小写与别名
  const s = String(j.status || j.taskStatus || "").toUpperCase();
  if (["SUCCEEDED", "SUCCESS", "COMPLETED", "DONE"].includes(s)) return "SUCCEEDED";
  if (["FAILED", "ERROR", "FAIL"].includes(s)) return "FAILED";
  if (["PENDING", "PROCESSING", "RUNNING", "QUEUED", "SUBMITTED"].includes(s)) return s === "QUEUED" || s === "SUBMITTED" ? "PENDING" : s;
  return s || "UNKNOWN";
}

function extractVideos(j) {
  // 视频地址在 response.videos[].url（也可能带 watermarkUrl / frameUrl）
  return j.videos || j.data?.videos || j.result?.videos || [];
}

async function download(url, file) {
  const res = await rfetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf.length;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const timeoutMs = (parseInt(a.timeout || "600", 10)) * 1000;

  // 三种入口：--resume / --task-id / 新提交
  let task;
  let snapshotFile;
  if (a.resume) {
    const snap = JSON.parse(fs.readFileSync(a.resume, "utf8"));
    task = { taskId: snap.taskId, idemKey: snap.idemKey, params: snap.params };
    console.error(`从快照恢复: taskId=${task.taskId}`);
  } else if (a["task-id"]) {
    task = { taskId: a["task-id"] };
  } else {
    task = await submitTask(a);
    snapshotFile = path.join(TASKS_DIR, `video-task-${task.taskId}.json`);
    fs.writeFileSync(snapshotFile, JSON.stringify({ ...task, appCode: APP_CODE, gw: "[.env.local]" }, null, 2));
    console.error(`任务快照: ${snapshotFile}（中断后用 --resume 恢复）`);
  }

  // 轮询：每 5 秒一次，遵循 Retry-After，单次 30s 超时，总超时默认 10 分钟
  const start = Date.now();
  let interval = 5000;
  while (true) {
    const { j, retryAfter } = await queryTask(task.taskId);
    const st = normalizeStatus(j);
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (st === "SUCCEEDED") {
      const vids = extractVideos(j);
      const out = {
        taskId: task.taskId, status: "SUCCEEDED", elapsedSec: elapsed,
        videos: vids.map(v => ({ url: v.url, watermarkUrl: v.watermarkUrl, frameUrl: v.frameUrl })),
      };
      // --save / 快照存在则下载
      if (a.save) {
        const url = vids[0]?.url;
        if (!url) { console.error("成功但未解析到视频 URL，原始结果如下"); console.log(JSON.stringify(j, null, 2)); return; }
        const file = typeof a.save === "string" ? a.save : `video-${task.taskId}.mp4`;
        const size = await download(url, file);
        out.savedTo = file; out.savedBytes = size;
      }
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    if (st === "FAILED") {
      console.error(`生成失败: code=${j.code || j.errorCode || ""} message=${j.message || j.errorMsg || ""}`);
      console.log(JSON.stringify(j, null, 2));
      process.exit(1);
    }
    if (Date.now() - start > timeoutMs) {
      console.error(`等待超时（${timeoutMs / 1000}s），当前状态=${st}。可用 --resume "${snapshotFile || `bin/video-tasks/video-task-${task.taskId}.json`}" 恢复继续轮询`);
      process.exit(3);
    }
    if (retryAfter > 0) interval = Math.max(1000, retryAfter * 1000);
    console.error(`[${elapsed}s] ${st} ... ${j.percent || j.progress || ""}`);
    await new Promise(r => setTimeout(r, interval));
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
