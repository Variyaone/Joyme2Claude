#!/usr/bin/env node
/**
 * mail-full.js — JoyMail 邮件全家桶（读 + 写 + 批量管理），零依赖 Node
 *
 * 复刻自 openclaw joyclaw 的 mail skill（SOAP/EWS），
 * 认证链与 joyme.js 一致：me_token → joymail RSA login → mail token → SOAP/EWS。
 *
 * 用法（写操作前先向用户确认！）:
 *   node mail-full.js folders [--parent msgfolderroot|inbox|...]        列文件夹
 *   node mail-full.js create-folder <名称> [--parent <folderId>]        建文件夹
 *   node mail-full.js search --folder inbox [--unread] [--limit 20]
 *                            [--sender x@y] [--subject 关键词] [--after D] [--before D]
 *   node mail-full.js detail --item-id <id>                             邮件全文
 *   node mail-full.js lookup-recipient --condition <姓名/ERP>          查收件人
 *   node mail-full.js send --to a@x,b@y [--cc ...] [--bcc ...] --subject S --body B
 *                        [--attachments p1,p2] [--html] [--importance High]
 *   node mail-full.js reply --item-id <id> --body B [--all] [--quote] [--attachments ...]
 *   node mail-full.js forward --item-id <id> --to a@x [--body B] [--attachments ...]
 *   node mail-full.js batch-mark-read --item-ids id1,id2
 *   node mail-full.js batch-mark-unread --item-ids id1,id2
 *   node mail-full.js batch-add-category --item-ids id1,id2 --category 标签
 *   node mail-full.js batch-move --item-ids id1,id2 --target-folder-id <fid>
 *   node mail-full.js batch-delete --item-ids id1,id2 [--hard]          默认进已删除
 *   node mail-full.js flag --item-ids id1,id2 / unflag / batch-flag / batch-unflag
 *
 * 环境变量: ME_TOKEN 可选（缺省自动现取，依赖京ME桌面端在运行）
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");



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
    console.error(`缺少环境变量 ${name}（本仓库不含内部接口地址，请自行设置后重试，README 有清单）`);
    process.exit(2);
  }
  return value;
}
const BASE = process.env.JOYME_API_BASE || "https://<your-gateway>";
const MAIL_ENDPOINT = process.env.JOYME_MAIL_ENDPOINT || "https://<your-mail-endpoint>";
const ERP_QUERY_URL = process.env.JOYME_ERP_QUERY_URL || "https://<your-erp-query>";
const APPID = requireEnv("JOYME_APPID", process.env.JOYME_APPID);
const DEVICE = process.env.JOYME_DEVICE || "joyme2claude";
const TENANT = process.env.JOYME_TENANT || "your-tenant";

// ===== me_token（与 joyme.js 同链）=====

async function rfetch(url, opts = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fetch(new Request(url, opts)); }
    catch (e) { lastErr = e; if (i < retries) await new Promise((r) => setTimeout(r, 500 * (i + 1))); }
  }
  throw lastErr;
}

async function postJson(url, body) {
  const res = await rfetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

async function getMeToken() {
  const env = process.env.ME_TOKEN;
  if (env) return env;
  const content = JSON.stringify({ method: "query", param: "appToken", timestamp: String(Math.floor(Date.now() / 1000)), from: process.env.JOYME_HIO_FROM || "hio_plugin", to: "HiOfficeClient" });
  const enc = await postJson(`${BASE}/?functionId=desk.agent.auth.encrypt&appid=${APPID}`, { appid: APPID, body: { content, jdmeAppId: "ee" }, functionId: "desk.agent.auth.encrypt" });
  if (enc.code !== 0 || !enc.data?.aesKey) throw new Error(`encrypt failed: ${JSON.stringify(enc).slice(0, 200)}`);
  const hio = await rfetch(`${process.env.JOYME_HIO_URL || "http://127.0.0.1:8988/hioffice"}?from=${process.env.JOYME_HIO_FROM || "hio_plugin"}`, { method: "POST", headers: { "X-AES-Key": enc.data.aesKey, "Content-Type": "application/json" }, body: enc.data.content });
  if (!hio.ok) throw new Error(`HiOffice HTTP ${hio.status} — 京ME桌面端没在运行？`);
  const xAesKey = hio.headers.get("x-aes-key");
  const hioBody = await hio.text();
  if (!xAesKey) throw new Error(`HiOffice missing X-AES-Key`);
  const gw = await postJson(`${BASE}/?functionId=desk.agent.auth.getWebToken&appid=${APPID}`, { appid: APPID, body: { token: hioBody, tenantCode: TENANT, deviceUuid: DEVICE, aesKey: xAesKey, jdmeAppId: "ee" }, functionId: "desk.agent.auth.getWebToken" });
  const token = gw.data?.accessToken;
  if (gw.code !== 0 || !token) throw new Error(`getWebToken failed`);
  return token;
}

async function getSsoToken(meToken) {
  const form = new URLSearchParams({ appid: APPID, clientVersion: "1.0.0", body: JSON.stringify({ tenantCode: TENANT, appKey: process.env.JOYME_SSO_APP_KEY || "", jdmeAppId: "ee" }), client: "web", functionId: "eopen.getCode", loginType: "15" });
  const res = await rfetch(`${BASE}/?functionId=eopen.getCode&appid=${APPID}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `me_token=${meToken}`, "x-team-id": process.env.JOYME_TEAM_ID || "", "x-device-type": "web", logintype: "15", "x-app-version": "1.0.0", "x-client": "WEB" }, body: form.toString() });
  const r1 = await res.json();
  if (r1.code !== 0 || !r1.data?.code) throw new Error(`eopen.getCode failed`);
  const res2 = await rfetch(`https://${process.env.JOYME_SSO_HOST || requireEnv("JOYME_SSO_HOST", process.env.JOYME_SSO_HOST)}/sso/tp?name=${process.env.JOYME_SSO_NAME || "im"}&token=${encodeURIComponent(r1.data.code)}&returnUrl=${encodeURIComponent(`${BASE}?lang=zh_CN`)}`, { redirect: "manual" });
  const ssoCookieName = process.env.JOYME_SSO_COOKIE || "sso";
  const m = (res2.headers.get("set-cookie") || "").match(new RegExp(`${ssoCookieName.replace(/\./g, "\\.")}=([^;]+)`));
  if (!m) throw new Error("SSO exchange failed");
  return m[1];
}

// ===== joymail RSA 登录 → mail token =====

async function gatewayForm(functionId, meToken, payload) {
  const form = new URLSearchParams({ appid: process.env.JOYME_MAIL_APPID || requireEnv("JOYME_MAIL_APPID", process.env.JOYME_MAIL_APPID), lang: "zh_CN", body: JSON.stringify(payload || {}), functionId, loginType: "15", cthr: "1", t: String(Date.now()), uuid: crypto.randomUUID().replaceAll("-", "").slice(0, 20) });
  const res = await rfetch(`${BASE}/api?functionId=${functionId}&appid=${process.env.JOYME_MAIL_APPID}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: `me_token=${meToken};`, functionid: functionId, logintype: "15", referer: BASE }, body: form.toString() });
  return res.json();
}

let cachedMailToken = null;
async function getMailToken() {
  if (cachedMailToken) return cachedMailToken;
  const meToken = await getMeToken();
  const pk = await gatewayForm(process.env.JOYME_MAIL_FN_PUBKEY || "mail.auth.publickey", meToken, {});
  const pkData = pk?.data?.Data || pk?.Data || {};
  if (!pkData.pin || !pkData.publicKeyPem) throw new Error(`mail publickey failed: ${JSON.stringify(pk).slice(0, 200)}`);
  let pem = pkData.publicKeyPem.trim();
  if (!pem.startsWith("-----")) pem = `-----BEGIN PUBLIC KEY-----\n${pem}\n-----END PUBLIC KEY-----`;
  const plaintext = JSON.stringify({ p: pkData.pin, t: String(Date.now()), c: crypto.randomUUID().replaceAll("-", ""), s: process.env.JOYME_MAIL_SOURCE || "Client" });
  const encrypted = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(plaintext)).toString("base64");
  const login = await gatewayForm(process.env.JOYME_MAIL_FN_LOGIN || "mail.auth.login", meToken, { data: encodeURIComponent(encrypted) });
  const token = login?.data?.Data?.Token || login?.Data?.Token;
  if (!token) throw new Error(`mail login failed: ${JSON.stringify(login).slice(0, 200)}`);
  cachedMailToken = token;
  return token;
}

// ===== SOAP/EWS =====

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function wrapSoap(body) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<soap:Header><t:RequestServerVersion Version="Exchange2016" /></soap:Header>' +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`;
}

async function soap(xmlBody) {
  const token = await getMailToken();
  const res = await rfetch(MAIL_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/xml, application/xml, application/json", auth: token, Authorization: `Bearer ${token}` }, body: xmlBody });
  if (!res.ok) throw new Error(`mail SOAP HTTP ${res.status}`);
  const raw = await res.text();
  // 网关返回 JSON 包裹的 XML：{"IsSuccess":true,"Data":"<?xml..."}
  try { const j = JSON.parse(raw); if (j && typeof j.Data === "string") return j.Data; } catch { /* 已是纯 XML */ }
  return raw;
}

const rx = (xml, re) => (xml.match(re) || [])[1] || "";
const text = (xml, tag) => rx(xml, new RegExp(`<t:${tag}>([\\s\\S]*?)</t:${tag}>`));
const respCode = (xml) => rx(xml, /ResponseCode>([^<]+)</);

// folders
async function listFolders({ parent = "msgfolderroot", traversal = "Deep" } = {}) {
  const body = `<m:FindFolder Traversal="${esc(traversal)}"><m:FolderShape><t:BaseShape>Default</t:BaseShape><t:AdditionalProperties>` +
    '<t:FieldURI FieldURI="folder:DisplayName" /><t:FieldURI FieldURI="folder:ChildFolderCount" /><t:FieldURI FieldURI="folder:UnreadCount" /><t:FieldURI FieldURI="folder:TotalCount" /><t:FieldURI FieldURI="folder:FolderClass" />' +
    `</t:AdditionalProperties></m:FolderShape><m:IndexedPageFolderView MaxEntriesReturned="200" Offset="0" BasePoint="Beginning" />` +
    `<m:ParentFolderIds><t:DistinguishedFolderId Id="${esc(parent)}" /></m:ParentFolderIds></m:FindFolder>`;
  const raw = await soap(wrapSoap(body));
  const xml = raw; // soap() 已解包 JSON 外层
  // folder 节点形如 <t:Folder>…</t:Folder>
  const folders = [...xml.matchAll(/<t:Folder>([\s\S]*?)<\/t:Folder>/g)].map((m) => {
    const c = m[1];
    const g = (tag) => (c.match(new RegExp(`<t:${tag}>([\\s\\S]*?)</t:${tag}>`)) || [])[1] || "";
    const idm = c.match(/<t:FolderId Id="([^"]+)"/);
    return { id: idm ? idm[1] : "", name: g("DisplayName"), unread: g("UnreadCount"), total: g("TotalCount"), cls: g("FolderClass") };
  }).filter((f) => f.name);
  folders.forEach((f) => console.log(`${f.name}  unread=${f.unread} total=${f.total}  id=${f.id}`));
}

async function createFolder(name, parentId) {
  const parentXml = parentId ? `<t:FolderId Id="${esc(parentId)}" />` : '<t:DistinguishedFolderId Id="msgfolderroot" />';
  const body = `<m:CreateFolder><m:ParentFolderId>${parentXml}</m:ParentFolderId><m:Folders><t:Folder><t:DisplayName>${esc(name)}</t:DisplayName><t:FolderClass>IPF.Note</t:FolderClass></t:Folder></m:Folders></m:CreateFolder>`;
  const xml = await soap(wrapSoap(body));
  console.log(respCode(xml) === "NoError" ? `已创建文件夹「${name}」` : `创建失败: ${respCode(xml)}`);
}

// search
async function searchMail({ folder = "inbox", unread, sender, subject, after, before, limit = 20 }) {
  const conds = [];
  const toUtc = (str, eod) => {
    const d = new Date(str.replace(" ", "T") + (str.includes(":") ? "" : "T00:00:00"));
    if (eod && !str.includes(":")) { d.setDate(d.getDate() + 1); d.setMilliseconds(-1); }
    return d.toISOString().replace(/\.\d+Z$/, "Z");
  };
  if (after) conds.push(`<t:IsGreaterThanOrEqualTo><t:FieldURI FieldURI="item:DateTimeReceived" /><t:FieldURIOrConstant><t:Constant Value="${toUtc(after, false)}" /></t:FieldURIOrConstant></t:IsGreaterThanOrEqualTo>`);
  if (before) conds.push(`<t:IsLessThanOrEqualTo><t:FieldURI FieldURI="item:DateTimeReceived" /><t:FieldURIOrConstant><t:Constant Value="${toUtc(before, true)}" /></t:FieldURIOrConstant></t:IsLessThanOrEqualTo>`);
  if (sender) conds.push(`<t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase"><t:FieldURI FieldURI="message:From" /><t:Constant Value="${esc(sender)}" /></t:Contains>`);
  if (subject) conds.push(`<t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase"><t:FieldURI FieldURI="item:Subject" /><t:Constant Value="${esc(subject)}" /></t:Contains>`);
  const restriction = conds.length ? `<m:Restriction>${conds.length === 1 ? conds[0] : `<t:And>${conds.join("")}</t:And>`}${unread ? "" : ""}</m:Restriction>` : "";
  const unreadRestr = unread ? `<m:Restriction><t:IsEqualTo><t:FieldURI FieldURI="message:IsRead" /><t:FieldURIOrConstant><t:Constant Value="false" /></t:FieldURIOrConstant></t:IsEqualTo></m:Restriction>` : "";
  const body = `<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>Default</t:BaseShape><t:AdditionalProperties>` +
    '<t:FieldURI FieldURI="item:Subject" /><t:FieldURI FieldURI="item:DateTimeReceived" /><t:FieldURI FieldURI="message:IsRead" /><t:FieldURI FieldURI="message:From" />' +
    `</t:AdditionalProperties></m:ItemShape><m:IndexedPageItemView MaxEntriesReturned="${limit}" Offset="0" BasePoint="Beginning" />` +
    (unreadRestr || restriction) +
    `<m:ParentFolderIds><t:DistinguishedFolderId Id="${esc(folder)}" /></m:ParentFolderIds></m:FindItem>`;
  const xml = await soap(wrapSoap(body));
  const soapXml = xml;
  const items = [...soapXml.matchAll(/<t:Message>([\s\S]*?)<\/t:Message>/g)].map((m) => {
    const c = m[1];
    const g = (tag) => (c.match(new RegExp(`<t:${tag}>([\\s\\S]*?)</t:${tag}>`)) || [])[1] || "";
    return { id: (c.match(/<t:ItemId Id="([^"]+)"/) || [])[1] || "", subject: g("Subject"), from: (c.match(/<t:From><t:Mailbox><t:Name>([\s\S]*?)<\/t:Name>/) || [])[1] || "", received: g("DateTimeReceived"), isRead: g("IsRead") === "true" };
  });
  if (!items.length) { console.log(`(无匹配邮件 folder=${folder})`); return; }
  items.forEach((m) => console.log(`[${m.received.slice(0, 16).replace("T", " ")}][${m.isRead ? "已读" : "未读"}][${m.from}] ${m.subject}\n  id: ${m.id}`));
}

// detail (with change_key for reply/forward/batch ops)
async function getDetail(itemId) {
  const body = "<m:GetItem><m:ItemShape><t:BaseShape>Default</t:BaseShape><t:BodyType>Text</t:BodyType><t:AdditionalProperties>" +
    '<t:FieldURI FieldURI="item:TextBody" /><t:FieldURI FieldURI="item:Categories" /><t:FieldURI FieldURI="item:Preview" />' +
    '<t:FieldURI FieldURI="message:From" /><t:FieldURI FieldURI="message:ToRecipients" /><t:FieldURI FieldURI="message:CcRecipients" />' +
    `</t:AdditionalProperties></m:ItemShape><m:ItemIds><t:ItemId Id="${esc(itemId)}" /></m:ItemIds></m:GetItem>`;
  const xml = await soap(wrapSoap(body)); // soap() 已解包 JSON 外层
  const ck = (xml.match(/<t:ItemId Id="[^"]+" ChangeKey="([^"]+)"/) || [])[1] || "";
  return { xml, changeKey: ck };
}

async function detailCmd(itemId) {
  const { xml } = await getDetail(itemId);
  console.log(xml.replace(/></g, ">\n<"));
}

// recipient lookup (HR service)
async function lookupRecipient(condition) {
  const meToken = await getMeToken();
  const sso = await getSsoToken(meToken);
  const res = await rfetch(ERP_QUERY_URL, { method: "POST", headers: { "Content-Type": "application/json", accept: "application/json", cookie: `${process.env.JOYME_SSO_COOKIE || "sso"}=${sso}` }, body: JSON.stringify({ condition, pageNo: 1, pageSize: 10 }) });
  const j = await res.json();
  const users = j?.data?.userList || j?.data?.list || [];
  if (users.length) users.forEach((u) => console.log(`${u.erp || u.pin || ""}  ${u.realName || u.name || ""}  ${u.department || ""}  ${u.email || ""}`));
  else console.log(JSON.stringify(j, null, 2));
}

// send / reply / forward
function mailboxBlock(emails) {
  return emails.filter(Boolean).map((e) => `<t:Mailbox><t:EmailAddress>${esc(e)}</t:EmailAddress></t:Mailbox>`).join("");
}

function attachmentsXml(paths) {
  return paths.map((p) => {
    const buf = fs.readFileSync(p);
    const name = path.basename(p);
    return `<t:FileAttachment><t:Name>${esc(name)}</t:Name><t:Content>${buf.toString("base64")}</t:Content></t:FileAttachment>`;
  }).join("");
}

async function createAttachment(itemId, changeKey, attXml) {
  const body = `<m:CreateAttachment><m:ParentItemId Id="${esc(itemId)}" ChangeKey="${esc(changeKey)}" /><m:Attachments>${attXml}</m:Attachments></m:CreateAttachment>`;
  const xml = await soap(wrapSoap(body));
  const m = xml.match(/<t:AttachmentId Id="([^"]+)" RootItemId="([^"]+)" RootItemChangeKey="([^"]+)"/);
  return { ok: respCode(xml) === "NoError", itemId: m?.[2] || itemId, changeKey: m?.[3] || changeKey };
}

async function sendSavedItem(itemId, changeKey) {
  const body = `<m:SendItem SaveItemToFolder="true"><m:ItemIds><t:ItemId Id="${esc(itemId)}" ChangeKey="${esc(changeKey)}" /></m:ItemIds></m:SendItem>`;
  const xml = await soap(wrapSoap(body));
  return respCode(xml) === "NoError";
}

async function sendNew({ to, cc, bcc, subject, body, html, importance, attachments }) {
  const disposition = attachments.length ? "SaveOnly" : "SendAndSaveCopy";
  const bodyType = html ? "HTML" : "Text";
  const bodyXml = `<m:CreateItem MessageDisposition="${disposition}"><m:Items><t:Message>` +
    `<t:Subject>${esc(subject)}</t:Subject><t:Body BodyType="${bodyType}">${esc(body)}</t:Body>` +
    `<t:Importance>${esc(importance || "Normal")}</t:Importance>` +
    `<t:ToRecipients>${mailboxBlock(to.split(","))}</t:ToRecipients>` +
    `<t:CcRecipients>${mailboxBlock((cc || "").split(","))}</t:CcRecipients>` +
    `<t:BccRecipients>${mailboxBlock((bcc || "").split(","))}</t:BccRecipients>` +
    `</t:Message></m:Items></m:CreateItem>`;
  let xml = await soap(wrapSoap(bodyXml));
  if (!attachments.length) {
    console.log(respCode(xml) === "NoError" ? `✓ 已发送: ${subject}` : `发送失败: ${respCode(xml)}`);
    return;
  }
  // draft → attach → send
  const draftId = (xml.match(/<t:ItemId Id="([^"]+)" ChangeKey="([^"]+)"/) || [])[1];
  const draftCk = (xml.match(/<t:ItemId Id="[^"]+" ChangeKey="([^"]+)"/) || [])[1];
  const att = await createAttachment(draftId, draftCk, attachmentsXml(attachments));
  const sent = await sendSavedItem(att.itemId, att.changeKey);
  console.log(sent ? `✓ 已发送(含${attachments.length}附件): ${subject}` : "发送失败（附件阶段）");
}

async function replyMail({ itemId, body, all, quote, attachments }) {
  const { xml: detailXml } = await getDetail(itemId);
  const ck = (detailXml.match(/<t:ItemId Id="[^"]+" ChangeKey="([^"]+)"/) || [])[1];
  const subject = text(detailXml, "Subject");
  const disposition = attachments.length ? "SaveOnly" : "SendAndSaveCopy";
  const tag = all ? "ReplyAllToItem" : "ReplyToItem";
  const bodyXml = `<m:CreateItem MessageDisposition="${disposition}"><m:Items><t:${tag}>` +
    `<t:ReferenceItemId Id="${esc(itemId)}" ChangeKey="${esc(ck)}" />` +
    `<t:NewBodyContent BodyType="Text">${esc(body)}</t:NewBodyContent>` +
    `</t:${tag}></t:Items></m:CreateItem>`;
  let xml = await soap(wrapSoap(bodyXml));
  if (respCode(xml) !== "NoError" && !attachments.length) {
    // 智能回复(ReplyToItem)被网关 500 时，降级为普通回复：RE: 主题 + 发回原发件人（附原文引用）
    const to = (detailXml.match(/<t:From><t:Mailbox>[\s\S]*?<t:EmailAddress>([^<]+)<\/t:EmailAddress>/) || [])[1] || "";
    if (!to) { console.log(`回复失败: ${respCode(xml) || "网关错误"}`); return; }
    const quoted = [
      ``, `----- 原始邮件 -----`,
      `主题: ${subject}`, `发件人: ${(detailXml.match(/<t:From><t:Mailbox>[\s\S]*?<t:Name>([^<]+)<\/t:Name>/) || [])[1] || ""} <${to}>`,
      ``, ((detailXml.match(/<t:TextBody>([\s\S]*?)<\/t:TextBody>/) || [])[1] || "").slice(0, 2000),
    ].join("\n");
    await sendNew({ to, subject: /^(re|回复)[:：]/i.test(subject) ? subject : `RE: ${subject}`, body: body + (quote === false ? "" : quoted), attachments });
    console.log(`✓ 已回复(降级普通发送): ${subject} → ${to}`);
    return;
  }
  if (!attachments.length) {
    console.log(respCode(xml) === "NoError" ? `✓ 已回复: ${subject}${all ? "（全部）" : ""}` : `回复失败: ${respCode(xml)}`);
    return;
  }
  const draftId = (xml.match(/<t:ItemId Id="([^"]+)" ChangeKey=/) || [])[1];
  const draftCk = (xml.match(/<t:ItemId Id="[^"]+" ChangeKey="([^"]+)"/) || [])[1];
  const att = await createAttachment(draftId, draftCk, attachmentsXml(attachments));
  const sent = await sendSavedItem(att.itemId, att.changeKey);
  console.log(sent ? `✓ 已回复(含附件): ${subject}` : "回复失败（附件阶段）");
}

async function forwardMail({ itemId, to, body, attachments }) {
  const { xml: detailXml } = await getDetail(itemId);
  const ck = (detailXml.match(/<t:ItemId Id="[^"]+" ChangeKey="([^"]+)"/) || [])[1];
  const subject = text(detailXml, "Subject");
  const disposition = attachments.length ? "SaveOnly" : "SendAndSaveCopy";
  const bodyXml = `<m:CreateItem MessageDisposition="${disposition}"><m:Items><t:ForwardItem>` +
    `<t:ReferenceItemId Id="${esc(itemId)}" ChangeKey="${esc(ck)}" />` +
    `<t:NewBodyContent BodyType="Text">${esc(body || "")}</t:NewBodyContent>` +
    `<t:ToRecipients>${mailboxBlock(to.split(","))}</t:ToRecipients>` +
    `</t:ForwardItem></m:Items></m:CreateItem>`;
  let xml = await soap(wrapSoap(bodyXml));
  if (!attachments.length) {
    console.log(respCode(xml) === "NoError" ? `✓ 已转发: ${subject} → ${to}` : `转发失败: ${respCode(xml)}`);
    return;
  }
  const draftId = (xml.match(/<t:ItemId Id="([^"]+)" ChangeKey=/) || [])[1];
  const draftCk = (xml.match(/<t:ItemId Id="[^"]+" ChangeKey="([^"]+)"/) || [])[1];
  const att = await createAttachment(draftId, draftCk, attachmentsXml(attachments));
  const sent = await sendSavedItem(att.itemId, att.changeKey);
  console.log(sent ? `✓ 已转发(含附件): ${subject} → ${to}` : "转发失败（附件阶段）");
}

// batch update ops
async function loadChangeKey(itemId) {
  const { xml } = await getDetail(itemId);
  return (xml.match(/<t:ItemId Id="[^"]+" ChangeKey="([^"]+)"/) || [])[1] || "";
}

async function batchUpdate(itemIds, fieldXml, actionLabel) {
  const changes = [];
  for (const id of itemIds) {
    const ck = await loadChangeKey(id);
    if (!ck) { console.error(`✗ ${id} 无 changeKey，跳过`); continue; }
    changes.push(`<t:ItemChange><t:ItemId Id="${esc(id)}" ChangeKey="${esc(ck)}" /><t:Updates>${fieldXml}</t:Updates></t:ItemChange>`);
  }
  const body = `<m:UpdateItem ConflictResolution="AutoResolve" MessageDisposition="SaveOnly"><m:ItemChanges>${changes.join("")}</m:ItemChanges></m:UpdateItem>`;
  const xml = await soap(wrapSoap(body));
  console.log(respCode(xml) === "NoError" ? `✓ ${actionLabel} ${changes.length} 封` : `失败: ${respCode(xml)}`);
}

async function batchMove(itemIds, targetFolderId) {
  const itemXml = itemIds.map((id) => `<t:ItemId Id="${esc(id)}" />`).join("");
  const body = `<m:MoveItem><m:ToFolderId><t:FolderId Id="${esc(targetFolderId)}" /></m:ToFolderId><m:ItemIds>${itemXml}</m:ItemIds></m:MoveItem>`;
  const xml = await soap(wrapSoap(body));
  console.log(respCode(xml) === "NoError" ? `✓ 已移动 ${itemIds.length} 封` : `失败: ${respCode(xml)}`);
}

async function batchDelete(itemIds, hard) {
  const type = hard ? "HardDelete" : "MoveToDeletedItems";
  const itemXml = itemIds.map((id) => `<t:ItemId Id="${esc(id)}" />`).join("");
  const body = `<m:DeleteItem DeleteType="${type}" SendMeetingCancellations="SendToNone" AffectedTaskOccurrences="AllOccurrences" SuppressReadReceipts="true"><m:ItemIds>${itemXml}</m:ItemIds></m:DeleteItem>`;
  const xml = await soap(wrapSoap(body));
  console.log(respCode(xml) === "NoError" ? `✓ 已${hard ? "彻底删除" : "移入已删除"} ${itemIds.length} 封` : `失败: ${respCode(xml)}`);
}

// ===== main =====

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(name);
const splitIds = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
const splitPaths = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);

(async () => {
  if (cmd === "folders") await listFolders({ parent: opt("--parent", "msgfolderroot") });
  else if (cmd === "create-folder") await createFolder(argv[1], opt("--parent"));
  else if (cmd === "search") await searchMail({
    folder: opt("--folder", "inbox"), unread: flag("--unread"), sender: opt("--sender"), subject: opt("--subject"),
    after: opt("--after"), before: opt("--before"), limit: Number(opt("--limit", 20)),
  });
  else if (cmd === "detail") await detailCmd(opt("--item-id"));
  else if (cmd === "lookup-recipient") await lookupRecipient(opt("--condition"));
  else if (cmd === "send") await sendNew({
    to: opt("--to"), cc: opt("--cc"), bcc: opt("--bcc"), subject: opt("--subject"), body: opt("--body"),
    html: flag("--html"), importance: opt("--importance"), attachments: splitPaths(opt("--attachments")),
  });
  else if (cmd === "reply") await replyMail({
    itemId: opt("--item-id"), body: opt("--body"), all: flag("--all"), quote: flag("--quote"),
    attachments: splitPaths(opt("--attachments")),
  });
  else if (cmd === "forward") await forwardMail({
    itemId: opt("--item-id"), to: opt("--to"), body: opt("--body"), attachments: splitPaths(opt("--attachments")),
  });
  else if (cmd === "batch-mark-read") await batchUpdate(splitIds(opt("--item-ids")), '<t:SetItemField><t:FieldURI FieldURI="message:IsRead" /><t:Message><t:IsRead>true</t:IsRead></t:Message></t:SetItemField>', "已标记已读");
  else if (cmd === "batch-mark-unread") await batchUpdate(splitIds(opt("--item-ids")), '<t:SetItemField><t:FieldURI FieldURI="message:IsRead" /><t:Message><t:IsRead>false</t:IsRead></t:Message></t:SetItemField>', "已标记未读");
  else if (cmd === "batch-add-category") await batchUpdate(splitIds(opt("--item-ids")), `<t:SetItemField><t:FieldURI FieldURI="item:Categories" /><t:Message><t:Categories><t:String>${esc(opt("--category"))}</t:String></t:Categories></t:Message></t:SetItemField>`, "已打标签");
  else if (cmd === "batch-move") await batchMove(splitIds(opt("--item-ids")), opt("--target-folder-id"));
  else if (cmd === "batch-delete") await batchDelete(splitIds(opt("--item-ids")), flag("--hard"));
  else if (cmd === "flag" || cmd === "batch-flag") await batchUpdate(splitIds(opt("--item-ids")), '<t:SetItemField><t:FieldURI FieldURI="item:Flag" /><t:Message><t:Flag><t:FlagStatus>Flagged</t:FlagStatus></t:Flag></t:Message></t:SetItemField>', "已旗标");
  else if (cmd === "unflag" || cmd === "batch-unflag") await batchUpdate(splitIds(opt("--item-ids")), '<t:SetItemField><t:FieldURI FieldURI="item:Flag" /><t:Message><t:Flag><t:FlagStatus>NotFlagged</t:FlagStatus></t:Flag></t:Message></t:SetItemField>', "已取消旗标");
  else {
    console.error("用法见文件头注释");
    process.exit(1);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
