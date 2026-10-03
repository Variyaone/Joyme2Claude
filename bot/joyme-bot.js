#!/usr/bin/env node
/**
 * joyme-bot.js — joyclaw 机器人双向通道（Windows 原生复刻，脱离 WSL/openclaw）
 *
 * 复刻 openclaw jd-jmechat 扩展的 Desk 协议：
 *   1. 认证：joyme-direct.js 同链（encrypt → HiOffice 8988 → getWebToken → me_token）
 *   2. 连接：socket.io-client → wss://<your-ws-host>（WebSocket 网关）
 *   3. 握手：query 带 token `1##<me_token>##<team_id>####zh_CN`，connect 后发 desk_user
 *   4. 发送：emit("message", { channelId, eventName: "desk_agent_msg_res", message: { content, type: "text" } })
 *   5. 接收：on("message") 中 eventName === "desk_agent_msg_req"：
 *      - message.imMsg 为 JSON 字符串，eventType === "chat_message" 时 event.body 即消息体
 *        （text 类型带 content/sender；image/file/audio/video 带 url/name）
 *      - 收到后回发 desk_agent_msg_receive + 原 imMsg（回执，防服务端重复推送）
 *
 * 用法:
 *   node joyme-bot.js "<内容>"            发送一条机器人消息（同步等 ack 后退出）
 *   node joyme-bot.js --test             发送测试消息
 *   node joyme-bot.js --listen           常驻监听：收消息打印 + 追加到 inbox.jsonl
 *   node joyme-bot.js --listen --exec "cmd {}"  收到消息时执行命令（{} 会被替换为 JSON 转义后的消息文本）
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
const DESK_WS_PATH = process.env.JOYME_WS_PATH || "/collabwsgateway/joyspace"; // 实测：必须此 path，/generic 会 timeout
const DESK_APP_ID = process.env.JOYME_WS_APPID || "joydesk"; // 实测：必须 joydesk，其他值认证不过
// deviceId：设备选择器中的身份。默认可读固定名（joyme2claude-<hostname>），
// 与 joyclaw（machineGuid）、沙盒等其他 agent 设备一眼区分；可用环境变量覆盖。
const DEVICE_ID = process.env.JOYME_BOT_DEVICE_ID || `joyme2claude-${require("os").hostname()}`;
const HERE = __dirname;

function die(msg) { console.error(msg); process.exit(1); }

function getMeToken() {
  const r = spawnSync(process.execPath, [`${HERE}/../bin/joyme.js`, "--get-token"], {
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
    clawVersion: "joyme2claude",  // 设备选择器显示的"版本"标识，用于与 joyclaw 等其他 agent 区分
    os: "Windows", version: process.version, cpu,
    hostname: process.env.JOYME_BOT_HOSTNAME || `joyme2claude@${os.hostname()}`,  // 设备选择器按 hostname 显示，前缀标识便于区分
    ip: Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal)?.address || "127.0.0.1",
    runtime: "local",
  };
}

async function main() {
  const args = process.argv.slice(2);
  const listen = args.includes("--listen");
  const replyMode = args.includes("--reply");
  let execCmd = null;
  const execIdx = args.indexOf("--exec");
  if (execIdx >= 0 && args[execIdx + 1]) execCmd = args[execIdx + 1];

  let text = args.find((a, i) => !a.startsWith("--") && i !== (execIdx >= 0 ? execIdx + 1 : -99));
  if (args.includes("--test")) text = `🤖 joyclaw 通道测试（Windows 原生）：${new Date().toLocaleString("zh-CN")}`;
  if (!text && !listen) die(`用法: node joyme-bot.js "<内容>" | --listen [--reply] [--exec "cmd {}"]`);

  const token = getMeToken();
  const channelId = `session-${Date.now()}-${require("crypto").randomBytes(4).toString("hex")}`;
  const tokenValue = `1##${token}##${process.env.JOYME_TEAM_ID || ""}####zh_CN`;

  const socket = io(DESK_WS_BASE, {
    path: DESK_WS_PATH,
    transports: ["websocket"],
    query: {
      appId: DESK_APP_ID,
      channelId,
      token: tokenValue,
      EIO: "4",
      transport: "websocket",
    },
    extraHeaders: { Origin: process.env.JOYME_ORIGIN || "https://joyme.jd.com" },
    forceNew: true,
    reconnection: !!listen,   // 监听模式常驻重连；发送模式一次性
    reconnectionDelay: 10_000,
    timeout: 15000,
  });

  // ---- 接收：desk_agent_msg_req → 解析 imMsg → 回执 ----
  socket.on("message", (data) => {
    try {
      const { eventName, message, channelID } = data || {};
      if (eventName !== "desk_agent_msg_req" || !message) return;
      const messageObj = typeof message === "string" ? JSON.parse(message) : message;

      // 回执：告诉服务端已收到（防重复推送）。imMsg 帧按 joyclaw 原样回带 deviceId+imMsg
      if (messageObj.imMsg) {
        socket.emit("message", {
          channelId: channelID || channelId,
          eventName: "desk_agent_msg_receive",
          message: { deviceId: DEVICE_ID, imMsg: messageObj.imMsg },
        });
      }

      // 解析 IM 消息体
      let parsed = null;
      if (messageObj.imMsg) {
        try {
          const im = JSON.parse(messageObj.imMsg);
          if (im.eventType === "chat_message" && im.event?.body) {
            const { type, ...body } = im.event.body;
            parsed = {
              kind: type || "text",
              from: body.fromUserName || body.senderName || body.from || "",
              fromPin: body.fromUserPin || body.sender || "",
              text: type === "text" ? (body.content || "") : "",
              url: body.url || "",
              name: body.name || "",
              sessionId: body.sessionId || body.conversationId || "",
              raw: im.event.body,
            };
          }
        } catch { /* imMsg 非 JSON，忽略 */ }
      }
      // 纯文本帧（无 imMsg）
      if (!parsed && messageObj.content) {
        parsed = { kind: "text", from: channelID || "desk-server", fromPin: "", text: String(messageObj.content), url: "", name: "", sessionId: "", raw: messageObj };
      }
      if (!parsed) return;

      const ts = new Date().toISOString();
      const line = { ts, ...parsed };
      console.log(`\n[${ts}] <${parsed.from || "unknown"}${parsed.fromPin ? `(${parsed.fromPin})` : ""}> ${parsed.kind === "text" ? parsed.text : `[${parsed.kind}] ${parsed.name} ${parsed.url}`}`);

      // 落盘 inbox
      const inbox = `${HERE}/inbox.jsonl`;
      try { require("fs").appendFileSync(inbox, JSON.stringify(line) + "\n"); } catch { /* 只读环境忽略 */ }

      // --reply：自动回执（证明双向闭环）
      if (replyMode) {
        const ack = `✅ joyme2claude(${DEVICE_ID}) 已收到: ${parsed.kind === "text" ? parsed.text : `[${parsed.kind}] ${parsed.name || parsed.url}`}`;
        socket.emit("message", {
          channelId: channelID || channelId,
          eventName: "desk_agent_msg_res",
          message: { content: ack.replace(/"/g, "“"), type: "text" },
        });
      }

      // 触发外部命令
      if (execCmd) {
        const { spawn } = require("child_process");
        const cmdline = execCmd.replace("{}", JSON.stringify(parsed.text || parsed.name || ""));
        const child = spawn(cmdline, { shell: true, detached: true, stdio: "ignore" });
        child.unref();
      }
    } catch (e) {
      console.error("[listen] 处理消息出错:", e.message);
    }
  });

  socket.on("connect", () => {
    console.log(`[bot] 已连接 Desk 网关（channelId: ${channelId.slice(0, 24)}...）`);
    // desk_user 握手（服务端确认前端连接）
    socket.emit("message", {
      channelId,
      eventName: "desk_user",
      message: { deviceInfo: getDeviceInfo() },
    }, (resp) => console.log("[desk_user] ack:", resp ?? "(none)"));

    if (listen) return; // 常驻监听模式：不发送、不退出

    setTimeout(() => {
      socket.emit("message", {
        channelId,
        eventName: "desk_agent_msg_res",
        message: { content: text.replace(/"/g, "“"), type: "text" },
      }, (resp) => console.log("[send] ack:", resp ?? "(none)"));
      setTimeout(() => { console.log("[send] done (no-ack exit)"); socket.disconnect(); process.exit(0); }, 4000);
    }, 1000);
  });

  if (!listen) {
    const timeout = setTimeout(() => { socket.disconnect(); die("连接 WebSocket 网关超时"); }, 25000);
    socket.on("connect_error", (err) => { clearTimeout(timeout); socket.disconnect(); die(`connect_error: ${err.message}`); });
  } else {
    console.log("[bot] 监听模式：等待 desk_agent_msg_req 消息（Ctrl+C 退出）");
  }
  socket.on("error", (err) => console.error("[socket error]", err.message || err));
}

main().catch((e) => die(e.stack || String(e)));
