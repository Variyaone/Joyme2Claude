#!/usr/bin/env node
/**
 * joyme-bot.js — joyclaw 机器人推送通道（Windows 原生复刻，脱离 WSL/openclaw）
 *
 * 复刻 openclaw jd-jmechat 扩展的 Desk 协议：
 *   1. 认证：joyme-direct.js 同链（encrypt → HiOffice 8988 → getWebToken → me_token）
 *   2. 连接：socket.io-client → wss://<your-ws-host>（WebSocket 网关）
 *   3. 握手：query 带 token `1##<me_token>##<team_id>####zh_CN`，connect 后发 desk_user
 *   4. 发送：emit("message", { channelId, eventName: "desk_agent_msg_res", message: { content, type: "text" } })
 *
 * 用法:
 *   node joyme-bot.js "<内容>"            发送一条机器人消息（同步等 ack 后退出）
 *   node joyme-bot.js --test             发送测试消息
 *
 * 前提: 京ME 桌面端在运行。
 */
const { io } = require("socket.io-client");
const { spawnSync } = require("child_process");

function requireEnv(name, value) {
  if (!value || value.includes("<")) { console.error(`缺少环境变量 ${name}`); process.exit(2); }
  return value;
}
const DESK_WS_BASE = process.env.JOYME_WS_BASE || requireEnv("JOYME_WS_BASE", process.env.JOYME_WS_BASE);
const DESK_WS_PATH = "/collabwsgateway/generic";
const DEVICE_ID = process.env.JOYME_BOT_DEVICE_ID || requireEnv("JOYME_BOT_DEVICE_ID", process.env.JOYME_BOT_DEVICE_ID); // 机器人配对身份
const HERE = __dirname;

function die(msg) { console.error(msg); process.exit(1); }

function getMeToken() {
  const r = spawnSync(process.execPath, [`${HERE}/../joyme-direct.js`, "--get-token"], {
    encoding: "utf8", timeout: 60000,
  });
  if (r.status !== 0 || !r.stdout.trim()) {
    die(`get me_token failed: ${(r.stderr || r.stdout || "").slice(0, 300)}`);
  }
  return r.stdout.trim();
}

function getDeviceInfo() {
  const os = require("os");
  let cpu = os.arch();
  try {
    const res = require("child_process").spawnSync("wmic", ["cpu", "get", "name"], { encoding: "utf8", windowsHide: true });
    const line = res.stdout.split("\n")[1]?.trim();
    if (line) cpu = line;
  } catch { /* fallback arch */ }
  return {
    deviceId: DEVICE_ID,
    clawVersion: "2.5.6",
    os: "Windows_NT", version: process.version, cpu,
    hostname: os.hostname(),
    ip: Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal)?.address || "127.0.0.1",
    runtime: "local",
  };
}

async function main() {
  const args = process.argv.slice(2);
  let text = args.find((a) => !a.startsWith("--"));
  if (args.includes("--test")) text = `🤖 joyclaw 通道测试（Windows 原生）：${new Date().toLocaleString("zh-CN")}`;
  if (!text) die(`用法: node joyme-bot.js "<内容>"`);

  const token = getMeToken();
  const channelId = `session-${Date.now()}-${require("crypto").randomBytes(4).toString("hex")}`;
  const tokenValue = `1##${token}##${process.env.JOYME_TEAM_ID || ""}####zh_CN`;

  const socket = io(DESK_WS_BASE, {
    path: DESK_WS_PATH,
    transports: ["websocket"],
    query: {
      appId: process.env.JOYME_APPID || "im",
      channelId,
      token: tokenValue,
      EIO: "4",
      transport: "websocket",
    },
    extraHeaders: { Origin: process.env.JOYME_ORIGIN || "https://example.com" },
    forceNew: true,
    reconnection: false,
    timeout: 15000,
  });

  const timeout = setTimeout(() => { socket.disconnect(); die("连接 WebSocket 网关超时"); }, 25000);

  socket.on("connect", () => {
    clearTimeout(timeout);
    // desk_user 握手（服务端确认前端连接）
    socket.emit("message", {
      channelId,
      eventName: "desk_user",
      message: { deviceInfo: getDeviceInfo() },
    }, (resp) => console.log("[desk_user] ack:", resp ?? "(none)"));

    setTimeout(() => {
      // 服务端对 desk_agent_msg_res 不一定回 ack，等待落盘窗口后主动退出
      socket.emit("message", {
        channelId,
        eventName: "desk_agent_msg_res",
        message: { content: text.replace(/"/g, "“"), type: "text" },
      }, (resp) => console.log("[send] ack:", resp ?? "(none)"));
      setTimeout(() => { console.log("[send] done (no-ack exit)"); socket.disconnect(); process.exit(0); }, 4000);
    }, 1000);
  });

  socket.on("connect_error", (err) => { clearTimeout(timeout); socket.disconnect(); die(`connect_error: ${err.message}`); });
  socket.on("error", (err) => console.error("[socket error]", err.message || err));
}

main().catch((e) => die(e.stack || String(e)));
