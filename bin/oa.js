#!/usr/bin/env node
// OA 流程中心 CLI：待办分类、快捷审批、流程查询/详情/已办、审批通过/驳回（零依赖 Node ≥ 18）
// 协议（源自我方对桌面端 skill 的逆向研究，仅供学习）：
//   POST https://api.m.jd.com/?functionId=<id>&appid=JoySky&loginType=7&t=<ms>
//   Header: functionid / logintype:7 / Content-Type:application/json
//   Cookie: sso.jd.com=<SSO token>; _pst=<pin>（token 由 joyme.js --get-sso 获取）
// 网关地址不写入仓库，运行时读环境变量（自动加载同仓库 .env.local）
//
// 用法:
//   node oa.js categories                      待办流程分类（含数量、可否快捷审批）
//   node oa.js quick-approve --keys K1,K2       一键快捷审批（写操作，先确认！）
//   node oa.js my-applies [--start 2026-09-01] [--end 2026-09-30] [--page 1] [--limit 20]
//                                              我发起的流程列表（默认近30天）
//   node oa.js detail --piid <流程实例ID> [--page 1] [--limit 10]
//                                              流程详情/审批轨迹
//   node oa.js approved [--start ...] [--end ...] [--page 1] [--limit 20]
//                                              已审批列表（默认近7天）
//   node oa.js approve --id <任务ID> [--comment 同意]        审批通过（写操作）
//   node oa.js reject  --id <任务ID> --comment <原因>        审批驳回（写操作，comment 必填）
//   node oa.js batch-approve --ids ID1,ID2 [--comment 同意]  批量通过（写操作）
//
// 注：approve/reject 的 id 是"任务记录ID"（待办列表里的 taskRecordId），不是流程实例ID。

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

const { execFileSync } = require("child_process");
const path = require("path");

const API_BASE = "https://api.m.jd.com/"; // 公网 JD API 网关域名，非机密
const PIN = process.env.JOYME_PIN || process.env.USERNAME || "";

// SSO token：优先环境变量，否则通过 joyme.js 桥接握手获取（需桌面端在线）
function getSsoToken() {
  if (process.env.SSO_TOKEN) return process.env.SSO_TOKEN;
  return execFileSync(process.execPath, [path.join(__dirname, "joyme.js"), "--get-sso"], {
    encoding: "utf8",
  }).trim();
}

async function oaCall(functionId, body = {}, method = "POST") {
  const sso = getSsoToken();
  const params = new URLSearchParams({
    functionId, appid: "JoySky", loginType: "7", t: String(Date.now()),
  });
  const headers = {
    Accept: "*/*",
    "Content-Type": "application/json",
    functionid: functionId,
    logintype: "7",
    "x-client": "WEB",
    "x-language": "zh_CN",
    Referer: "http://oa.jd.com/",
    Cookie: `sso.jd.com=${sso}; _pst=${PIN}`,
  };
  if (PIN) headers["x-pin"] = PIN;
  const res = await fetch(`${API_BASE}?${params}`, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify({ jdmeAppId: "ee", reqSource: "pc", ...body }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status} 非 JSON 响应: ${text.slice(0, 200)}`); }
  const code = j.code ?? j.errorCode;
  if (code !== undefined && String(code) !== "0") {
    throw new Error(`接口失败 code=${code} message=${j.message || j.msg || ""}`);
  }
  return j;
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { a[t.slice(2)] = next; i++; }
      else a[t.slice(2)] = true;
    } else a._.push(t);
  }
  return a;
}

function fmtDate(d) { return d.toISOString().slice(0, 10); }

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];

  if (cmd === "categories" || !cmd) {
    // 待办流程分类（GET，无 body）
    const sso = getSsoToken();
    const fn = "skills.process.quickApprovingHeader";
    const params = new URLSearchParams({ functionId: fn, appid: "JoySky", loginType: "7", t: String(Date.now()) });
    const res = await fetch(`${API_BASE}?${params}`, {
      method: "GET",
      headers: {
        Accept: "*/*", functionid: fn, logintype: "7", "x-client": "WEB", "x-language": "zh_CN",
        Referer: "http://oa.jd.com/", Cookie: `sso.jd.com=${sso}; _pst=${PIN}`,
      },
      signal: AbortSignal.timeout(30000),
    });
    const j = await res.json();
    if (String(j.code ?? 0) !== "0") throw new Error(`查询失败: ${j.message || j.msg}`);
    const cats = j.data || [];
    console.log(`待办流程分类 ${cats.length} 个，待办共 ${cats.reduce((s, c) => s + (c.count || 0), 0)} 条`);
    for (const c of cats) {
      console.log(`  ${c.processDefinitionName} | key=${c.processDefinitionKey} | 待办${c.count} | 快捷${c.supportQuickCount ?? "?"}/普通${c.notSupportQuickCount ?? "?"} | 一键=${c.isQuickApprove ? "可" : "否"}`);
    }
    return;
  }

  if (cmd === "quick-approve") {
    if (!a.keys) { console.error("用法: quick-approve --keys KEY1,KEY2"); process.exit(1); }
    const j = await oaCall("joysky.process.quickBatchApprove", { processDefinitionKeys: a.keys.split(",") });
    console.log(JSON.stringify(j.data ?? j, null, 2));
    return;
  }

  if (cmd === "my-applies") {
    const end = a.end || fmtDate(new Date());
    const start = a.start || fmtDate(new Date(Date.now() - 30 * 864e5));
    const j = await oaCall("skills.definition.apply.list", {
      queryStartDate: start, queryEndDate: end, pageNo: +(a.page || 1), limit: +(a.limit || 20),
    });
    const rows = Array.isArray(j.data) ? j.data : (j.data?.result || j.data?.list || []);
    console.log(`我发起的流程（${start}~${end}）共 ${rows.length} 条`);
    for (const r of rows) {
      console.log(`  ${r.processName || r.processInstanceName} | 状态${r.statusCode}(${r.status}) | 跟进码=${r.reqFollowCode || "-"} | ${r.reqTime || ""}`);
    }
    return;
  }

  if (cmd === "detail") {
    if (!a.piid) { console.error("用法: detail --piid <流程实例ID>"); process.exit(1); }
    const j = await oaCall("skills.process.detail", {
      processInstanceId: a.piid, pageNo: +(a.page || 1), pageSize: +(a.limit || 10),
    });
    console.log(JSON.stringify(j.data ?? j, null, 2));
    return;
  }

  if (cmd === "approved") {
    const end = a.end || fmtDate(new Date());
    const start = a.start || fmtDate(new Date(Date.now() - 7 * 864e5));
    const j = await oaCall("skills.definition.approved.list", {
      endTimeStart: start, endTimeEnd: end, pageNo: +(a.page || 1), pageSize: +(a.limit || 20),
    });
    const rows = Array.isArray(j.data) ? j.data : (j.data?.result || []);
    console.log(`已审批（${start}~${end}）共 ${rows.length} 条`);
    for (const r of rows) {
      console.log(`  ${r.processDefinitionName || r.processInstanceName} | 发起人=${r.realName || r.ownerName || ""} | 跟进码=${r.followCode || "-"} | ${r.startTime || ""} | 实例=${r.processInstanceId}`);
    }
    return;
  }

  if (cmd === "approve" || cmd === "reject" || cmd === "batch-approve") {
    if (cmd === "approve" && !a.id) { console.error("用法: approve --id <任务ID> [--comment 同意]"); process.exit(1); }
    if (cmd === "reject" && (!a.id || !a.comment)) { console.error("用法: reject --id <任务ID> --comment <驳回原因>"); process.exit(1); }
    if (cmd === "batch-approve" && !a.ids) { console.error("用法: batch-approve --ids ID1,ID2 [--comment 同意]"); process.exit(1); }
    let fn, body;
    if (cmd === "batch-approve") {
      fn = "skills.process.batchApprove";
      body = { ids: a.ids.split(","), submitType: "approve", comment: a.comment || "同意" };
    } else {
      fn = "skills.process.approve";
      body = cmd === "approve"
        ? { id: a.id, submitType: "approve", comment: a.comment || "同意" }
        : { id: a.id, submitType: "reject", comment: a.comment };
    }
    const j = await oaCall(fn, body);
    console.log(JSON.stringify(j.data ?? j, null, 2));
    return;
  }

  console.error("未知命令。可用: categories | quick-approve | my-applies | detail | approved | approve | reject | batch-approve");
  process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
