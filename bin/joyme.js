#!/usr/bin/env node
/**
 * joyme.js — 脱离 openclaw/joyclaw，Claude 直接调 JoyMe 公司接口
 *
 * 认证链（每次运行自动完成，无需存储凭证）:
 *   1. desk.agent.auth.encrypt (Color 网关) → 加密载荷
 *   2. 本地京ME桌面端 HiOffice (127.0.0.1:8988) → appToken
 *   3. desk.agent.auth.getWebToken → me_token（约24h有效，本脚本不缓存）
 *   4. joyday/joyspace 需要时再换 SSO token（eopen.getCode → SSO）
 *
 * 用法:
 *   node joyme.js <functionId> [bodyJSON]           调任意 Color 网关接口
 *   node joyme.js --get-token                        打印 me_token
 *   node joyme.js --get-sso                          打印 sso token (joyspace用)
 *   node joyme.js --send <pin> <内容>                发京ME消息给个人
 *   node joyme.js --send-group <gid> <内容>          发京ME消息到群
 *   node joyme.js --send-image <pin> <图片路径>       发图片消息（自动上传）
 *   node joyme.js --send-image --group <gid> <路径>   发图片到群
 *   node joyme.js --upload-image <图片路径>           仅上传取 URL，不发送
 *   node joyme.js --upload-file <文件路径>            大文件分片上传（>10MB 自动分片）
 *   node joyme.js --create-task '<JSON>'              建待办 {title,remark,startTime,endTime,owners[],remindStr}
 *   node joyme.js --create-appointment '<JSON>'      建日程 {subject,startDate,endDate,attendees[],location,description}
 *   node joyme.js --later-list                        稍后处理消息列表
 *   node joyme.js --create-group <组名> <pin,...>     建群（需群管理权限，见README）
 *   node joyme.js --group-members <gid>               群成员名单（同上）
 *   node joyme.js --group-announcement <gid> <内容>  群公告（同上）
 *   node joyme.js --mail [after] [before]             查邮件列表
 *   node joyme.js --mail-detail <itemId>              查邮件正文
 *   node joyme.js --msg-summary [天数|--pin <p>|--group <g>]  消息摘要
 *   node joyme.js --joyspace <path> [bodyJSON]       JoySpace 文档接口
 *
 * 常用 functionId:
 *   login.getUserProfile                                我的身份
 *   meetingAgent.color.taskCommonSearch                 搜待办
 *   work.task.clientTaskSave.v2                         建待办
 *   joyday.appointment.searchScheduleAssist             搜日程 (startTime/endTime 毫秒时间戳)
 *   joyday.appointment.addAppointmentClaw               建日程
 *   jdme.search.search                                  搜员工/群
 *   minutes.search / minutes.detail / minutes.asr       会议纪要
 *   joyspace 文档不走 functionId，用 --joyspace <path> <bodyJSON>（直连文档 API）
 *
 * 前提: 京ME 桌面端在运行（Windows 本机 8988 端口）
 *
 * 敏感值（内部网关地址/app key）不写入仓库，运行时从环境变量读取，
 * 见 README 的「环境变量」一节。缺省时脚本会提示需要设置哪些变量。
 */


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

// ===== 环境配置（本仓库不含任何真实内部地址/密钥）=====
function requireEnv(name, value) {
  if (!value || value.includes("<")) {
    console.error(`缺少环境变量 ${name}（本仓库不含内部接口地址，请在你的 shell 配置里设置后重试，README 有清单）`);
    process.exit(2);
  }
  return value;
}
const BASE = process.env.JOYME_API_BASE || "https://<your-gateway>";
const JOYSPACE = process.env.JOYME_JOYSPACE_BASE || "https://<your-docs-api>";
const APPID = requireEnv("JOYME_APPID", process.env.JOYME_APPID);
const DEVICE = process.env.JOYME_DEVICE || "joyme2claude";
const SSO_APP_KEY = process.env.JOYME_SSO_APP_KEY || "";
const TENANT = process.env.JOYME_TENANT || "your-tenant";
const TEAM_ID = process.env.JOYME_TEAM_ID || "";
const FILE_DOMAIN = process.env.JOYME_FILE_BASE || "https://<your-file-host>";
const MAIL_ENDPOINT = process.env.JOYME_MAIL_ENDPOINT || "https://<your-mail-endpoint>";

// fetch 包装：网络偶发 fetch failed 时重试
async function rfetch(url, opts = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fetch(new Request(url, opts)); }
    catch (e) { lastErr = e; if (i < retries) await new Promise(r => setTimeout(r, 500 * (i + 1))); }
  }
  throw lastErr;
}

async function postJson(url, body) {
  const res = await rfetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getMeToken() {
  const content = JSON.stringify({
    method: "query", param: "appToken",
    timestamp: String(Math.floor(Date.now() / 1000)),
    from: process.env.JOYME_HIO_FROM || "hio_plugin", to: "HiOfficeClient",
  });
  const enc = await postJson(`${BASE}/?functionId=desk.agent.auth.encrypt&appid=${APPID}`,
    { appid: APPID, body: { content, jdmeAppId: "ee" }, functionId: "desk.agent.auth.encrypt" });
  if (enc.code !== 0 || !enc.data?.aesKey) throw new Error(`encrypt failed: ${JSON.stringify(enc).slice(0, 300)}`);

  const hio = await rfetch(`${process.env.JOYME_HIO_URL || "http://127.0.0.1:8988/hioffice"}?from=${process.env.JOYME_HIO_FROM || "hio_plugin"}`, {
    method: "POST",
    headers: { "X-AES-Key": enc.data.aesKey, "Content-Type": "application/json" },
    body: enc.data.content,
  });
  if (!hio.ok) throw new Error(`HiOffice HTTP ${hio.status} — 京ME桌面端没在运行？`);
  const xAesKey = hio.headers.get("x-aes-key");
  const hioBody = await hio.text();
  if (!xAesKey) throw new Error(`HiOffice missing X-AES-Key: ${hioBody.slice(0, 200)}`);

  const gw = await postJson(`${BASE}/?functionId=desk.agent.auth.getWebToken&appid=${APPID}`,
    { appid: APPID, body: { token: hioBody, tenantCode: TENANT, deviceUuid: DEVICE, aesKey: xAesKey, jdmeAppId: "ee" }, functionId: "desk.agent.auth.getWebToken" });
  const token = gw.data?.accessToken;
  if (gw.code !== 0 || !token) throw new Error(`getWebToken failed: ${JSON.stringify(gw).slice(0, 300)}`);
  return token;
}

async function colorForm(functionId, token, body) {
  let appid = APPID;
  const ROUTES = [
    [/^(meetingAgent\.color|work\.task)/, process.env.JOYME_APP_TODO],
    [/^joyday\./, process.env.JOYME_APP_CAL],
    [/^(minutes|clevernote)\./, process.env.JOYME_APP_MINUTES],
  ];
  for (const [re, v] of ROUTES) if (re.test(functionId)) appid = v || appid;
  const needsWeb = appid !== "JOYDAY_WEB" && appid !== "JoyMinutes";
  const form = new URLSearchParams({
    appid, lang: "zh_CN", clientVersion: "1.0.0",
    body: JSON.stringify(appid === "JoyWork" ? body : { ...body, jdmeAppId: "ee" }),
    client: "web", functionId, loginType: "15",
  });
  const res = await rfetch(`${BASE}/?functionId=${functionId}&appid=${appid}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `me_token=${token}`,
      "x-team-id": TEAM_ID, "x-tenant-code": TENANT,
      "x-device-type": "web", logintype: "15",
      ...(needsWeb ? { "x-app-version": "1.0.0", "x-client": "WEB" } : {}),
    },
    body: form.toString(),
  });
  return res.text();
}

async function getSsoToken(meToken) {
  const form = new URLSearchParams({
    appid: APPID, clientVersion: "1.0.0",
    body: JSON.stringify({ tenantCode: TENANT, appKey: SSO_APP_KEY, jdmeAppId: "ee" }),
    client: "web", functionId: "eopen.getCode", loginType: "15",
  });
  const res = await rfetch(`${BASE}/?functionId=eopen.getCode&appid=${APPID}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `me_token=${meToken}`, "x-team-id": TEAM_ID,
      "x-device-type": "web", logintype: "15", "x-app-version": "1.0.0", "x-client": "WEB",
    },
    body: form.toString(),
  });
  const r1 = await res.json();
  if (r1.code !== 0 || !r1.data?.code) throw new Error(`eopen.getCode failed: ${JSON.stringify(r1).slice(0, 200)}`);
  const res2 = await rfetch(
    `https://${process.env.JOYME_SSO_HOST || requireEnv("JOYME_SSO_HOST", process.env.JOYME_SSO_HOST)}/sso/tp?name=${process.env.JOYME_SSO_NAME || "im"}&token=${encodeURIComponent(r1.data.code)}&returnUrl=${encodeURIComponent(`${JOYSPACE}?lang=zh_CN`)}`,
    { redirect: "manual" },
  );
  const ssoCookieName = process.env.JOYME_SSO_COOKIE || "sso";
  const m = (res2.headers.get("set-cookie") || "").match(new RegExp(`${ssoCookieName.replace(/\./g, "\\.")}=([^;]+)`));
  if (!m) throw new Error("SSO exchange failed: no SSO cookie");
  return m[1];
}

async function joyspaceCall(path, bodyJson) {
  const token = await getMeToken();
  const sso = await getSsoToken(token);
  const res = await rfetch(`${JOYSPACE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `${process.env.JOYME_SSO_COOKIE || "sso"}=${sso}`, "x-team-id": TEAM_ID },
    body: bodyJson,
  });
  return res.text();
}

// ===== 京ME 消息（AES-192-CBC 加密链路）=====

const IV = Buffer.from("0102030405060708", "utf8");
let cachedImKey = null;

async function getImEncryptKey(token) {
  if (cachedImKey) return cachedImKey;
  const me = JSON.parse(await colorForm("login.getUserProfile", token, {}));
  const from = {
    app: me.content.teamUserInfo.ddAppId,
    pin: me.content.teamUserInfo.account,
    clientType: "gw",
  };
  const form = new URLSearchParams({
    appid: APPID, appName: process.env.JOYME_APPNAME || "IM", loginType: "15",
    body: JSON.stringify({
      mode: "specify", clientVer: "7.20.27", from,
      id: "joycode-" + Date.now(), clientTime: Date.now(),
      key: "timline:client:skill:encrypt:key", jdmeAppId: "ee",
    }),
  });
  const res = await rfetch(`${BASE}/?functionId=imCommon.api&appid=${APPID}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `me_token=${token}`, "x-team-id": TEAM_ID,
      "x-im-app": "ee", "x-im-clientType": "gw", "x-im-funcVer": "1.2.8",
      "x-im-uri": "/gateway/my/getConfig", "x-im-uuid": "joycode-" + Math.random().toString(36).slice(2),
      loginType: "15",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0",
    },
    body: form.toString(),
  });
  const j = await res.json();
  const key = j?.data?.data?.[0]?.value;
  if (j?.code !== 200 || !key) throw new Error(`getImEncryptKey failed: ${JSON.stringify(j).slice(0, 300)}`);
  cachedImKey = Buffer.from(key, "hex");
  return cachedImKey;
}

function aesEncrypt(keyBuffer, input) {
  const crypto = require("crypto");
  const cipher = crypto.createCipheriv("aes-192-cbc", keyBuffer, IV);
  let enc = cipher.update(input, "utf8", "hex");
  enc += cipher.final("hex");
  return enc.toUpperCase();
}

async function getFromUser(token) {
  const me = JSON.parse(await colorForm("login.getUserProfile", token, {}));
  return {
    app: me.content.teamUserInfo.ddAppId,
    pin: me.content.teamUserInfo.account,
    clientType: "gw",
  };
}

async function sendImMessage(token, { to, gid, content }) {
  const keyBuffer = await getImEncryptKey(token);
  const from = await getFromUser(token);
  const target = to || { app: "ee", pin: to }; // to: {app, pin}
  const payload = {
    from,
    ...(gid ? { gid } : { to }),
    id: "joycode-" + Date.now(),
    type: "chat_message",
    timestamp: Date.now(),
    ver: "4.3",
    body: {
      type: "text", atUsers: [], expire: 0, content,
      requestData: { sessionId: createSessionId(from, gid ? null : to) },
      businessFlag: process.env.JOYME_BIZ_FLAG || "external",
    },
  };
  const uri = gid ? "/gateway/group/chatMessage" : "/gateway/unimessage/chat";
  const form = new URLSearchParams({
    appid: APPID, appName: process.env.JOYME_APPNAME || "IM", loginType: "15",
    body: JSON.stringify({ request: aesEncrypt(keyBuffer, JSON.stringify(payload)) }),
  });
  const res = await rfetch(`${BASE}/?functionId=imCommon.api&appid=${APPID}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `me_token=${token}`, "x-team-id": TEAM_ID,
      "x-im-app": from.app, "x-im-clientType": "pc", "x-im-funcVer": "1.2.8",
      "x-im-uri": uri, "x-im-uuid": "joycode-" + Math.random().toString(36).slice(2),
      loginType: "15",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0",
    },
    body: form.toString(),
  });
  return res.text();
}

function createSessionId(from, to) {
  const fromStr = `${from?.pin?.toLowerCase()}:${from?.app?.toLowerCase()}`;
  const toStr = `${to?.pin?.toLowerCase()}:${to?.app?.toLowerCase()}`;
  return fromStr > toStr ? `${toStr}:${fromStr}` : `${fromStr}:${toStr}`;
}

// ===== IM 网关直调（群操作/群成员/稍后处理列表，明文 JSON，无需 AES）=====

async function imGateway(token, uri, data) {
  const crypto = require("crypto");
  const form = new URLSearchParams({
    appid: APPID, appName: process.env.JOYME_APPNAME || "IM", loginType: "15",
    body: JSON.stringify(data),
  });
  const res = await rfetch(`${BASE}/?functionId=imCommon.api&appid=${APPID}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `me_token=${token}`, "x-team-id": TEAM_ID,
      "x-im-app": "ee", "x-im-clientType": "gw", "x-im-funcVer": "1.2.8",
      "x-im-uri": uri, "x-im-uuid": crypto.randomUUID().replaceAll("-", "").slice(0, 20),
      loginType: "15",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0",
    },
    body: form.toString(),
  });
  return res.json();
}

// ===== 京ME 文件上传（图片直传 + 大文件分片断点续传）=====


async function uploadImageFile(token, filePath) {
  const from = await getFromUser(token);
  const fs = require("fs");
  const path = require("path");
  const buf = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  const ext = path.extname(name).toLowerCase().replace(".", "");
  const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" }[ext] || "application/octet-stream";
  const fd = new FormData();
  fd.append("upload", new Blob([buf], { type: mime }), name);
  for (const [k, v] of Object.entries({ clientType: "pc", appId: from.app, pin: from.pin }))
    fd.append(k, v);
  const res = await rfetch(`${FILE_DOMAIN}/file/uploadImg.action`, { method: "POST", headers: { Accept: "image/*" }, body: fd });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`uploadImg failed: ${JSON.stringify(j).slice(0, 200)}`);
  return j; // { code, path, height, width, md5, size, ... }
}

async function chunkUploadFile(token, filePath, { chunkSize = 10 * 1024 * 1024 } = {}) {
  const crypto = require("crypto");
  const fs = require("fs");
  const path = require("path");
  const from = await getFromUser(token);
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const fileType = path.extname(filePath).toLowerCase().replace(".", "") || "bin";
  const totalParts = Math.ceil(fileSize / chunkSize);
  const key = crypto.randomUUID().toUpperCase();
  const cfg = { clientType: "pc", appId: from.app, pin: from.pin };

  // 1. init 断点续传
  const initQ = new URLSearchParams({ ...cfg, key, fileName, totalSize: String(fileSize), totalPartNumber: String(totalParts), lang: "zh_CN" });
  const init = await (await rfetch(`${FILE_DOMAIN}/file/initUploadMultiFile.action?${initQ}`, { method: "POST", headers: { "Content-Type": "application/json;charset=utf-8" } })).json();
  if (init.code !== 1) throw new Error(`initUpload failed: ${JSON.stringify(init).slice(0, 200)}`);
  if (init.state === 1) return { ...init, fileName, fileSize, fileType }; // 降级签名直传

  // 2. 逐片上传
  const fd = fs.openSync(filePath, "r");
  const parts = [];
  try {
    for (let seq = 1; seq <= totalParts; seq++) {
      const start = (seq - 1) * chunkSize;
      const len = Math.min(chunkSize, fileSize - start);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const q = new URLSearchParams({ name: "upload", fileName, ...cfg, key, uploadId: init.uploadId, seq: String(seq), lang: "zh_CN" });
      const mfd = new FormData();
      mfd.append("upload", new Blob([new Uint8Array(buf)], { type: "application/octet-stream" }));
      const up = await (await rfetch(`${FILE_DOMAIN}/file/uploadMultiFile.action?${q}`, { method: "POST", body: mfd })).json();
      if (up.code !== 1 || !up.partNumber || !up.eTag) throw new Error(`chunk ${seq} failed: ${JSON.stringify(up).slice(0, 200)}`);
      parts.push({ partNumber: up.partNumber, eTag: up.eTag });
    }
  } finally { fs.closeSync(fd); }

  // 3. 合并
  const cq = new URLSearchParams({ ...cfg, key, fileName, totalSize: String(fileSize), fileType, lang: "zh_CN" });
  const done = await (await rfetch(`${FILE_DOMAIN}/file/completeMultiFile.action?${cq}`, {
    method: "POST", headers: { "Content-Type": "application/json;charset=utf-8" },
    body: JSON.stringify({ uploadId: init.uploadId, uploadPartList: parts.sort((a, b) => a.partNumber - b.partNumber) }),
  })).json();
  if (done.code !== 1) throw new Error(`completeUpload failed: ${JSON.stringify(done).slice(0, 200)}`);
  return { ...done, fileName, fileSize, fileType };
}

// 发图片消息：先 uploadImg 拿 OSS path，再按 image 类型发
async function sendImImage(token, { to, gid, imagePath }) {
  const up = await uploadImageFile(token, imagePath);
  const keyBuffer = await getImEncryptKey(token);
  const from = await getFromUser(token);
  const payload = {
    from,
    ...(gid ? { gid } : { to }),
    id: "joycode-" + Date.now(),
    type: "chat_message",
    timestamp: Date.now(),
    ver: "4.3",
    body: {
      type: "image", atUsers: [], expire: 0,
      content: JSON.stringify({ url: up.path, width: up.width || 800, height: up.height || 600 }),
      requestData: { sessionId: createSessionId(from, gid ? null : to) },
      businessFlag: process.env.JOYME_BIZ_FLAG || "external",
    },
  };
  const uri = gid ? "/gateway/group/chatMessage" : "/gateway/unimessage/chat";
  const form = new URLSearchParams({
    appid: APPID, appName: process.env.JOYME_APPNAME || "IM", loginType: "15",
    body: JSON.stringify({ request: aesEncrypt(keyBuffer, JSON.stringify(payload)) }),
  });
  const res = await rfetch(`${BASE}/?functionId=imCommon.api&appid=${APPID}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `me_token=${token}`, "x-team-id": TEAM_ID,
      "x-im-app": from.app, "x-im-clientType": "pc", "x-im-funcVer": "1.2.8",
      "x-im-uri": uri, "x-im-uuid": "joycode-" + Math.random().toString(36).slice(2),
      loginType: "15",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0",
    },
    body: form.toString(),
  });
  return { sendResult: await res.text(), upload: up };
}

// ===== ME_AI 通道（me.ai.* functionId：JoySpace 创建文档 / AI表格 CRUD）=====
// 协议：POST {BASE}/api?functionId=me.ai.joyspace&appid=ME_AI，form 编码，Cookie 带 me_token
// 常用 action：
//   创建文档  {action:"create_doc_routing", team_id:"root", folder_id:"root", title, content, [page_type]}
//             page_type: 13=普通文档 18=sheet 21=AI表格；响应 data.pageId/link
//   Office导入 {action:"joyspace.create_office_import_task", url, file_name, file_size, title, page_type, team_id, folder_id}
//              → 返回 taskId，用 {action:"joyspace.query_office_import_task", task_id} 轮询
//   AI表格   {action:"aitable.getSchema", page_id, sheet_id}                                    读表结构/字段
//             {action:"aitable.listRecordsByPage", page_id, sheet_id, page_num, page_size, [page_token, filter, view_id]}
//             {action:"aitable.createRecords", page_id, sheet_id, records:[{fields:{}}]}          单次≤50条
//             {action:"aitable.updateRecords", page_id, sheet_id, records:[{id, fields}]}
//             {action:"aitable.deleteRecords", page_id, sheet_id, record_ids:[]}
//             {action:"aitable.getRecordById", page_id, sheet_id, record_id}
//             filter 结构: {mode:"AND/OR", criteria:[{field, operator, values:[]}]}
//             operator: Equals/NotEqu/Greater/GreaterEqu/Less/LessEqu/BeginWith/EndWith/Contains/NotContains/Intersected/Empty/NotEmpty
//             注：getRecordById 返回的 record.fields 是 JSON 字符串，需二次 parse
async function meAiCall(bodyObj) {
  const token = await getMeToken();
  const functionId = "me.ai.joyspace";
  const form = new URLSearchParams({
    appid: "ME_AI", body: JSON.stringify(bodyObj || {}),
    functionId, loginType: "15", client: "web",
  });
  const res = await rfetch(`${BASE}/api?functionId=${functionId}&appid=ME_AI`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `me_token=${token}`,
      logintype: "15",
    },
    body: form.toString(),
  });
  return res.text();
}

// ===== JoyMail 邮件（me_token → RSA登录 → mail token → SOAP/EWS）=====


let cachedMailToken = null;

async function gatewayForm(functionId, meToken, payload) {
  const form = new URLSearchParams({
    appid: "joymail", lang: "zh_CN",
    body: JSON.stringify(payload || {}),
    functionId, loginType: "15", cthr: "1",
    t: String(Date.now()), uuid: crypto.randomUUID().replaceAll("-", "").slice(0, 20),
  });
  const res = await rfetch(`${BASE}/api?functionId=${functionId}&appid=joymail`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      cookie: `me_token=${meToken};`,
      functionid: functionId, logintype: "15", referer: BASE,
    },
    body: form.toString(),
  });
  return res.json();
}

async function getMailToken(meToken) {
  if (cachedMailToken) return cachedMailToken;
  const crypto = require("crypto");
  // step1: public key
  const pk = await gatewayForm("joymail.authentication.publickey", meToken, {});
  const pkData = pk?.data?.Data || pk?.Data || {};
  if (!pkData.pin || !pkData.publicKeyPem) throw new Error(`mail publickey failed: ${JSON.stringify(pk).slice(0, 200)}`);
  // step2: RSA encrypt
  let pem = pkData.publicKeyPem.trim();
  if (!pem.startsWith("-----")) pem = `-----BEGIN PUBLIC KEY-----\n${pem}\n-----END PUBLIC KEY-----`;
  const plaintext = JSON.stringify({ p: pkData.pin, t: String(Date.now()), c: crypto.randomUUID().replaceAll("-", ""), s: process.env.JOYME_MAIL_SOURCE || "Client" });
  const encrypted = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(plaintext)).toString("base64");
  // step3: login
  const login = await gatewayForm("joymail.authentication.login", meToken, { data: encodeURIComponent(encrypted) });
  const token = login?.data?.Data?.Token || login?.Data?.Token;
  if (!token) throw new Error(`mail login failed: ${JSON.stringify(login).slice(0, 200)}`);
  cachedMailToken = token;
  return token;
}

async function soapMail(xmlBody, mailToken) {
  const res = await rfetch(MAIL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/xml, application/xml, application/json",
      auth: mailToken,
      Authorization: `Bearer ${mailToken}`,
    },
    body: xmlBody,
  });
  if (!res.ok) throw new Error(`mail SOAP HTTP ${res.status}`);
  return res.text();
}

function wrapSoap(body) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" ' +
    'xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" ' +
    'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<soap:Header><t:RequestServerVersion Version="Exchange2016" /></soap:Header>' +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`;
}

const FIND_ITEM_SHAPE = "<m:ItemShape><t:BaseShape>Default</t:BaseShape><t:AdditionalProperties>" +
  '<t:FieldURI FieldURI="item:Subject" /><t:FieldURI FieldURI="item:DateTimeReceived" />' +
  '<t:FieldURI FieldURI="item:DateTimeSent" /><t:FieldURI FieldURI="item:HasAttachments" />' +
  '<t:FieldURI FieldURI="item:Importance" /><t:FieldURI FieldURI="message:IsRead" />' +
  '<t:FieldURI FieldURI="message:From" /><t:FieldURI FieldURI="message:ToRecipients" />' +
  '<t:FieldURI FieldURI="message:CcRecipients" />' +
  "</t:AdditionalProperties></m:ItemShape>";

function timeRestrictionXml(after, before) {
  // after/before: "YYYY-MM-DD" 或 "YYYY-MM-DD HH:MM:SS"（本地时区）
  const toUtc = (str, endOfDay) => {
    const hasTime = str.includes(":");
    const d = new Date(str.replace(" ", "T") + (hasTime ? "" : "T00:00:00"));
    if (!hasTime && endOfDay) d.setDate(d.getDate() + 1), d.setMilliseconds(-1);
    return d.toISOString().replace(/\.\d{3}Z$/, "Z");
  };
  const conds = [];
  if (after) conds.push(`<t:IsGreaterThanOrEqualTo><t:FieldURI FieldURI="item:DateTimeReceived" /><t:FieldURIOrConstant><t:Constant Value="${toUtc(after, false)}" /></t:FieldURIOrConstant></t:IsGreaterThanOrEqualTo>`);
  if (before) conds.push(`<t:IsLessThanOrEqualTo><t:FieldURI FieldURI="item:DateTimeReceived" /><t:FieldURIOrConstant><t:Constant Value="${toUtc(before, true)}" /></t:FieldURIOrConstant></t:IsLessThanOrEqualTo>`);
  if (!conds.length) return "";
  return conds.length === 1 ? `<m:Restriction>${conds[0]}</m:Restriction>` : `<m:Restriction><t:And>${conds.join("")}</t:And></m:Restriction>`;
}

async function searchMail(meToken, { folder = "inbox", after, before, maxEntries = 50, offset = 0 }) {
  const token = await getMailToken(meToken);
  const body = `<m:FindItem Traversal="Shallow">${FIND_ITEM_SHAPE}` +
    `<m:IndexedPageItemView MaxEntriesReturned="${maxEntries}" Offset="${offset}" BasePoint="Beginning" />` +
    timeRestrictionXml(after, before) +
    `<m:ParentFolderIds><t:DistinguishedFolderId Id="${folder}" /></m:ParentFolderIds></m:FindItem>`;
  return soapMail(wrapSoap(body), token);
}

async function mailDetail(meToken, itemId) {
  const token = await getMailToken(meToken);
  const body = "<m:GetItem><m:ItemShape><t:BaseShape>Default</t:BaseShape><t:BodyType>Text</t:BodyType>" +
    '<t:AdditionalProperties><t:FieldURI FieldURI="item:TextBody" /><t:FieldURI FieldURI="item:Body" />' +
    '<t:FieldURI FieldURI="item:Preview" /><t:FieldURI FieldURI="message:From" />' +
    '<t:FieldURI FieldURI="message:ToRecipients" /><t:FieldURI FieldURI="message:CcRecipients" />' +
    "</t:AdditionalProperties></m:ItemShape>" +
    `<m:ItemIds><t:ItemId Id="${itemId.replace(/"/g, "&quot;")}" /></m:ItemIds></m:GetItem>`;
  return soapMail(wrapSoap(body), token);
}

// ===== 京ME 收消息摘要（消息摘要服务 message_summary action）=====

async function messageSummary(meToken, { startTime, endTime, pin, groupId, unread } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Cookie: `me_token=${meToken}`, "x-team-id": TEAM_ID,
    "x-im-app": "ee", "x-im-id": crypto.randomUUID(),
    "x-im-clientType": "gw", "x-im-funcVer": "1.2.8",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  };
  const payload = {};
  if (startTime) payload.startTime = startTime;
  if (endTime) payload.endTime = endTime;
  if (pin) payload.toPin = pin;
  if (groupId) payload.sessionId = groupId;
  if (unread) payload.unread = unread;
  const res = await rfetch(`${process.env.JOYME_MSG_SUMMARY_URL || requireEnv("JOYME_MSG_SUMMARY_URL", process.env.JOYME_MSG_SUMMARY_URL)}`, {
    method: "POST", headers, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`summaryMsgForSkill HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const [, , cmd, bodyArg, arg4] = process.argv;
  if (!cmd) {
    console.error(Object.readFileSync ? "" : "用法见文件头注释");
    process.exit(1);
  }
  if (cmd === "--ai") {
    // ME_AI 通道：joyme.js --ai '{"action":"create_doc_routing",...}'（action 清单见 meAiCall 注释）
    const out = await meAiCall(JSON.parse(bodyArg || "{}"));
    console.log(out); return;
  }
  if (cmd === "--joyspace") {
    // Git Bash 会把 /v2/... 转成 Windows 路径，还原 API path
    let p = bodyArg;
    const m = p.match(/([A-Z]:\\[^"']*)$/i) || p.match(/\/v\d+\/.*$/);
    if (/^[A-Z]:[\\\/]/i.test(p) || p.includes("/Git/")) {
      const idx = p.search(/\/v\d+\//);
      if (idx >= 0) p = p.slice(idx);
    }
    const out = await joyspaceCall(p, arg4 || "{}");
    console.log(out); return;
  }
  const token = await getMeToken();
  if (cmd === "--get-token") { console.log(token); return; }
  if (cmd === "--get-sso") { console.log(await getSsoToken(token)); return; }

  if (cmd === "--send") {
    // 用法: --send <pin> <消息内容>   或   --send-group <gid> <消息内容>
    const text = arg4;
    if (!text) { console.error("用法: --send <pin> <内容> / --send-group <gid> <内容>"); process.exit(1); }
    const token = await getMeToken();
    const out = await sendImMessage(token, { to: { app: "ee", pin: bodyArg }, content: text });
    console.log(out); return;
  }
  if (cmd === "--send-group") {
    const text = arg4;
    if (!text) { console.error("用法: --send-group <gid> <内容>"); process.exit(1); }
    const token = await getMeToken();
    const out = await sendImMessage(token, { gid: bodyArg, content: text });
    console.log(out); return;
  }

  if (cmd === "--send-image") {
    // 用法: --send-image <pin> <本地图片路径>   /   --send-image --group <gid> <路径>
    const isGroup = bodyArg === "--group";
    const gid = isGroup ? arg4 : null;
    const imagePath = isGroup ? process.argv[5] : arg4;
    if (!imagePath) { console.error("用法: --send-image <pin> <图片路径> / --send-image --group <gid> <路径>"); process.exit(1); }
    const token = await getMeToken();
    const out = await sendImImage(token, isGroup ? { gid, imagePath } : { to: { app: "ee", pin: bodyArg }, imagePath });
    console.log(`✓ 图片已发送: ${out.upload.path} (${out.upload.width}x${out.upload.height}, ${(out.upload.size / 1024).toFixed(1)}KB)`);
    return;
  }

  if (cmd === "--upload-image") {
    // 用法: --upload-image <本地图片路径>   仅上传取 URL，不发送
    const token = await getMeToken();
    const up = await uploadImageFile(token, bodyArg);
    console.log(JSON.stringify(up, null, 2));
    return;
  }

  if (cmd === "--upload-file") {
    // 用法: --upload-file <本地文件路径>   分片上传（>10MB 自动分片）
    const token = await getMeToken();
    const up = await chunkUploadFile(token, bodyArg);
    console.log(JSON.stringify(up, null, 2));
    return;
  }

  if (cmd === "--create-group") {
    // 用法: --create-group <组名> <pin1,pin2,...>
    const members = (arg4 || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!members.length) { console.error("用法: --create-group <组名> <pin1,pin2,...>"); process.exit(1); }
    const token = await getMeToken();
    const out = await imGateway(token, "/gateway/group/createGroup", { groupName: bodyArg, groupMembers: members });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === "--group-members") {
    // 用法: --group-members <gid>
    const token = await getMeToken();
    const out = await imGateway(token, "/gateway/group/groupSkillRosterGet", { gid: bodyArg, ver: 0 });
    const items = out?.data?.data?.items || [];
    if (!items.length) console.log(JSON.stringify(out, null, 2).slice(0, 500));
    else items.forEach((it) => console.log(`${it.user?.pin || "?"}  ${it.user?.name || ""}  ${it.roleType || ""}`));
    return;
  }

  if (cmd === "--group-announcement") {
    // 用法: --group-announcement <gid> <公告内容>
    const token = await getMeToken();
    const out = await imGateway(token, "/gateway/group/updateGroupNotice", { groupId: bodyArg, notice: arg4 });
    console.log(JSON.stringify(out, null, 2).slice(0, 500));
    return;
  }

  if (cmd === "--later-list") {
    // 稍后处理列表
    const token = await getMeToken();
    const out = await imGateway(token, "/gateway/tag/getLaterList", { labelId: "1010" });
    console.log(JSON.stringify(out, null, 2).slice(0, 2000));
    return;
  }

  if (cmd === "--create-task") {
    // 用法: --create-task '<JSON>'  标题/备注/起止时间戳/执行人(需先 search 确认)
    const token = await getMeToken();
    const p = JSON.parse(bodyArg);
    const data = { title: p.title };
    if (p.remark) data.remark = p.remark;
    if (p.parentTaskId) { data.parentTaskId = p.parentTaskId; data.isChild = true; data.taskListType = 7; }
    if (p.owners) data.owners = p.owners;
    if (p.startTime) data.startTime = p.startTime;
    if (p.endTime) data.endTime = p.endTime;
    if (p.remindStr) data.remindStr = p.remindStr;
    const out = await colorForm("work.task.clientTaskSave.v2", token, data);
    console.log(out);
    return;
  }

  if (cmd === "--create-appointment") {
    // 用法: --create-appointment '<JSON>'  subject/startDate/endDate/attendees[]/location/description/needVideoMeeting/reminderMinutesStr
    const token = await getMeToken();
    const p = JSON.parse(bodyArg);
    const out = await colorForm("joyday.appointment.addAppointmentClaw", token, {
      subject: p.subject, startDate: p.startDate, endDate: p.endDate,
      attendees: p.attendees || [], needVideoMeeting: p.needVideoMeeting !== false,
      reminderMinutesStr: p.reminderMinutesStr || "-5",
      ...(p.location ? { location: p.location } : {}),
      ...(p.description ? { description: p.description } : {}),
    });
    console.log(out);
    return;
  }

  if (cmd === "--mail") {
    // 用法: --mail [afterDate] [beforeDate]     如 --mail 2026-09-09（查这一天）
    const token = await getMeToken();
    const after = bodyArg || new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 10);
    const before = arg4 || "";
    const out = await searchMail(token, { after, before });
    const j = JSON.parse(out);
    const xml = j.Data || "";
    console.error(`查邮件: after=${after} before=${before || "(不限)"}`);
    // 解析 XML 为简洁列表
    const items = [...xml.matchAll(/<t:Message>([\s\S]*?)<\/t:Message>/g)].map(m => {
      const c = m[1];
      const g = (tag) => (c.match(new RegExp(`<t:${tag}>([\\s\\S]*?)</t:${tag}>`)) || [])[1] || "";
      const gAttr = (tag, attr) => (c.match(new RegExp(`<t:${tag}[^>]* ${attr}="([^"]+)"`)) || [])[1] || "";
      const fromName = (c.match(/<t:From><t:Mailbox><t:Name>([\s\S]*?)<\/t:Name>/) || [])[1] || "";
      return {
        id: gAttr("ItemId", "Id"),
        subject: g("Subject"),
        from: fromName,
        received: g("DateTimeReceived"),
        isRead: g("IsRead") === "true",
      };
    });
    if (!items.length) { console.log(xml.slice(0, 500)); return; }
    items.forEach(m => console.log(`[${m.received.slice(0, 16).replace("T", " ")}][${m.isRead ? "已读" : "未读"}][${m.from}] ${m.subject}\n  id: ${m.id}`));
    return;
  }
  if (cmd === "--mail-detail") {
    const token = await getMeToken();
    console.log(await mailDetail(token, bodyArg)); return;
  }

  if (cmd === "--msg-summary") {
    // 用法: --msg-summary [天数]          近N天消息摘要（默认2）
    //      --msg-summary --pin <pin>      与某人的会话摘要
    //      --msg-summary --group <gid>    某群的会话摘要
    const token = await getMeToken();
    const opts = {};
    if (bodyArg === "--pin" || bodyArg === "--group") opts[bodyArg === "--pin" ? "pin" : "groupId"] = arg4;
    else if (bodyArg) {
      const days = parseInt(bodyArg) || 2;
      const now = Date.now();
      opts.startTime = new Date(now - days * 86400000).toISOString().slice(0, 19);
      opts.endTime = new Date(now).toISOString().slice(0, 19);
    }
    const out = await messageSummary(token, opts);
    if (out.code !== 1) { console.log(JSON.stringify(out, null, 2)); return; }
    console.log(out.data?.summary || JSON.stringify(out));
    return;
  }

  const body = bodyArg ? JSON.parse(bodyArg) : {};
  const text = await colorForm(cmd, token, body);
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
  catch { console.log(text); }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
