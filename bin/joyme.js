#!/usr/bin/env node
/**
 * joyme-direct.js — 脱离 openclaw/joyclaw，Claude 直接调 JoyMe 公司接口
 *
 * 认证链（每次运行自动完成，无需存储凭证）:
 *   1. desk.agent.auth.encrypt (Color 网关) → 加密载荷
 *   2. 本地京ME桌面端 HiOffice (127.0.0.1:8988) → appToken
 *   3. desk.agent.auth.getWebToken → me_token（约24h有效，本脚本不缓存）
 *   4. joyday/joyspace 需要时再换 SSO token（eopen.getCode → autherp.jd.com）
 *
 * 用法:
 *   node joyme-direct.js <functionId> [bodyJSON]     调任意 Color 网关接口
 *   node joyme-direct.js --get-token                 打印 me_token
 *   node joyme-direct.js --get-sso                   打印 sso token (joyspace用)
 *   node joyme-direct.js --send <pin> <内容>          发京ME消息给个人
 *   node joyme-direct.js --send-group <gid> <内容>    发京ME消息到群
 *   node joyme-direct.js --joyspace <path> [bodyJSON]  JoySpace 文档接口
 *
 * 常用 functionId:
 *   login.getUserProfile                                我的身份
 *   meetingAgent.color.taskCommonSearch                 搜待办
 *   work.task.clientTaskSave.v2                         建待办
 *   joyday.appointment.searchScheduleAssist             搜日程 (startTime/endTime 毫秒时间戳)
 *   joyday.appointment.addAppointmentClaw               建日程
 *   jdme.search.search                                  搜员工/群
 *   minutes.search / minutes.detail / minutes.asr       会议纪要
 *   joyspace 文档不走 functionId，用 --joyspace <path> <bodyJSON>（直连 apijoyspace.jd.com）
 *
 * 前提: 京ME 桌面端在运行（Windows 本机 8988 端口）
 */
const BASE = "https://api.m.jd.com";
const JOYSPACE = "https://apijoyspace.jd.com";
const APPID = "JDME_DESKTOP";
const DEVICE = "joycode-claude-win";
const SSO_APP_KEY = "sL5qtKu71X8H25ysaaHB";

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
    from: "hio_plugin_joydesk", to: "HiOfficeClient",
  });
  const enc = await postJson(`${BASE}/?functionId=desk.agent.auth.encrypt&appid=${APPID}`,
    { appid: APPID, body: { content, jdmeAppId: "ee" }, functionId: "desk.agent.auth.encrypt" });
  if (enc.code !== 0 || !enc.data?.aesKey) throw new Error(`encrypt failed: ${JSON.stringify(enc).slice(0, 300)}`);

  const hio = await rfetch("http://127.0.0.1:8988/hioffice?from=hio_plugin_joydesk", {
    method: "POST",
    headers: { "X-AES-Key": enc.data.aesKey, "Content-Type": "application/json" },
    body: enc.data.content,
  });
  if (!hio.ok) throw new Error(`HiOffice HTTP ${hio.status} — 京ME桌面端没在运行？`);
  const xAesKey = hio.headers.get("x-aes-key");
  const hioBody = await hio.text();
  if (!xAesKey) throw new Error(`HiOffice missing X-AES-Key: ${hioBody.slice(0, 200)}`);

  const gw = await postJson(`${BASE}/?functionId=desk.agent.auth.getWebToken&appid=${APPID}`,
    { appid: APPID, body: { token: hioBody, tenantCode: "CN.JD.GROUP", deviceUuid: DEVICE, aesKey: xAesKey, jdmeAppId: "ee" }, functionId: "desk.agent.auth.getWebToken" });
  const token = gw.data?.accessToken;
  if (gw.code !== 0 || !token) throw new Error(`getWebToken failed: ${JSON.stringify(gw).slice(0, 300)}`);
  return token;
}

async function colorForm(functionId, token, body) {
  let appid = APPID;
  if (/^(meetingAgent\.color|work\.task)/.test(functionId)) appid = "JoyWork";
  else if (/^joyday\./.test(functionId)) appid = "JOYDAY_WEB";
  else if (/^(minutes|clevernote)\./.test(functionId)) appid = "JoyMinutes";
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
      "x-team-id": "00046419", "x-tenant-code": "CN.JD.GROUP",
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
    body: JSON.stringify({ tenantCode: "CN.JD.GROUP", appKey: SSO_APP_KEY, jdmeAppId: "ee" }),
    client: "web", functionId: "eopen.getCode", loginType: "15",
  });
  const res = await rfetch(`${BASE}/?functionId=eopen.getCode&appid=${APPID}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `me_token=${meToken}`, "x-team-id": "00046419",
      "x-device-type": "web", logintype: "15", "x-app-version": "1.0.0", "x-client": "WEB",
    },
    body: form.toString(),
  });
  const r1 = await res.json();
  if (r1.code !== 0 || !r1.data?.code) throw new Error(`eopen.getCode failed: ${JSON.stringify(r1).slice(0, 200)}`);
  const res2 = await rfetch(
    `https://autherp.jd.com/sso/tp?name=joydesk&token=${encodeURIComponent(r1.data.code)}&returnUrl=${encodeURIComponent("https://joyspace.jd.com?lang=zh_CN")}`,
    { redirect: "manual" },
  );
  const m = (res2.headers.get("set-cookie") || "").match(/sso\.jd\.com=([^;]+)/);
  if (!m) throw new Error("SSO exchange failed: no sso.jd.com cookie");
  return m[1];
}

async function joyspaceCall(path, bodyJson) {
  const token = await getMeToken();
  const sso = await getSsoToken(token);
  const res = await rfetch(`${JOYSPACE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `sso.jd.com=${sso}`, "x-team-id": "00046419" },
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
    appid: "JDME_DESKTOP", appName: "JDME", loginType: "15",
    body: JSON.stringify({
      mode: "specify", clientVer: "7.20.27", from,
      id: "joycode-" + Date.now(), clientTime: Date.now(),
      key: "timline:client:skill:encrypt:key", jdmeAppId: "ee",
    }),
  });
  const res = await rfetch(`${BASE}/?functionId=imCommon.api&appid=JDME_DESKTOP`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `me_token=${token}`, "x-team-id": "00046419",
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
      businessFlag: "joyClaw",
    },
  };
  const uri = gid ? "/gateway/group/chatMessage" : "/gateway/unimessage/chat";
  const form = new URLSearchParams({
    appid: "JDME_DESKTOP", appName: "JDME", loginType: "15",
    body: JSON.stringify({ request: aesEncrypt(keyBuffer, JSON.stringify(payload)) }),
  });
  const res = await rfetch(`${BASE}/?functionId=imCommon.api&appid=JDME_DESKTOP`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `me_token=${token}`, "x-team-id": "00046419",
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

// ===== JoyMail 邮件（me_token → RSA登录 → mail token → SOAP/EWS）=====

const MAIL_ENDPOINT = "http://mail-skill.jd.com/mail/api/clawmail/mailpost";
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
  const plaintext = JSON.stringify({ p: pkData.pin, t: String(Date.now()), c: crypto.randomUUID().replaceAll("-", ""), s: "JoyMail_Mac" });
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

// ===== 京ME 收消息摘要（im-agent.jd.com，复刻 joychat message_summary action）=====

async function messageSummary(meToken, { startTime, endTime, pin, groupId, unread } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Cookie: `me_token=${meToken}`, "x-team-id": "00046419",
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
  const res = await rfetch("https://im-agent.jd.com/summary/summaryMsgForSkill", {
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
