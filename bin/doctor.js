#!/usr/bin/env node
// 配置自举 / 体检脚本（零依赖 Node ≥ 18）：从公网京Me 网页版 + 本地桌面端自动推导 .env.local
//
// 原理：京Me 各 H5 应用的 index.html 都注入了 window.__MF_ENV，其中包含网关地址等运行时配置。
// 这些页面托管在公网 CDN，无需登录即可获取。标识符类值（appid 等）在配置模板中给出常见取值，
// 桥接握手实测通过即视为有效。
//
// 用法:
//   node doctor.js                 # 体检 + 自动生成 .env.local（缺失项）
//   node doctor.js --check         # 只体检现有 .env.local，不写文件
//   node doctor.js --force         # 覆盖重写 .env.local（保留注释）
//
// 步骤:
//   1. 检查本地桌面端进程与 8988 桥
//   2. 拉取公网 me.jd.com 入口页，解析 __MF_ENV
//   3. 对各网关 host 做可达性探测
//   4. 生成/补全 .env.local（只填缺失项；已有真值不动）
//   5. 尝试一次完整认证握手（桌面端在线时）验证配置可用

// 自动加载同仓库的 .env.local
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
const { execFileSync } = require("child_process");

const ENV_PATH = path.join(__dirname, "..", ".env.local");

// ---- 已知公网入口（不属于机密：均为公网可达域名）----
const ME_WEB_ENTRY = "https://me.jd.com";

// ---- 配置模板：值来源与说明 ----
// "auto"    = 从 __MF_ENV 自动推导
// "probe:"  = 多个候选值，按序探测哪个能通
// 字面量     = 桌面端桥接协议的固定常量（对同一企业部署全局一致）
const TEMPLATE = {
  JOYME_API_BASE: { src: "auto", desc: "Color 主网关", mfKey: "COLOR_GATEWAY_HOST" },
  JOYME_APPNAME: { src: "auto", desc: "网关应用名", mfKey: "APPNAME" },
  JOYME_HIO_URL: { src: "const", desc: "本地桌面端桥", value: "http://127.0.0.1:8988/hioffice" },
  JOYME_HIO_FROM: { src: "const", desc: "桥接来源标识", value: "hio_plugin_joydesk" },
  JOYME_SSO_HOST: { src: "const", desc: "SSO 换票主机", value: "autherp.jd.com" },
  JOYME_SSO_NAME: { src: "const", desc: "SSO 服务名", value: "joydesk" },
  JOYME_SSO_APP_KEY: { src: "probe", desc: "SSO app key", candidates: [] }, // 由桌面端部署决定，握手失败时人工填
  JOYME_SSO_COOKIE: { src: "probe", desc: "SSO cookie 名", candidates: ["sso.jd.com", "ssoToken", "token"] },
  JOYME_JOYSPACE_BASE: { src: "const", desc: "文档 API", value: "https://apijoyspace.jd.com" },
  JOYME_FILE_BASE: { src: "const", desc: "文件上传", value: "https://file-ee.jd.com" },
  JOYME_TENANT: { src: "const", desc: "租户编码", value: "CN.JD.GROUP" },
  JOYME_DEVICE: { src: "const", desc: "设备标识", value: "joyme2claude" },
  JOYME_APPID: { src: "probe", desc: "主网关 appid（握手实测）", candidates: [] },
  JOYME_TEAM_ID: { src: "probe", desc: "团队 ID（消息用）", candidates: [] },
  JOYME_BIZ_FLAG: { src: "probe", desc: "消息 business flag", candidates: [] },
};

async function rfetch(url, opts = {}, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fetch(new Request(url, { ...opts, signal: AbortSignal.timeout(10000) })); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// 1. 桥探测
function checkBridge() {
  const ok = { bridge: false, desktop: false };
  try {
    execFileSync("tasklist", ["/FI", "IMAGENAME eq JDITDesk.exe"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    // tasklist 在部分环境不可用/被策略拦——不作为硬依赖
  } catch { /* ignore */ }
  return fetch("http://127.0.0.1:8988/hioffice?from=hio_plugin_joydesk", { method: "POST", signal: AbortSignal.timeout(3000) })
    .then(r => ({ bridge: r.status > 0, desktop: r.status > 0 }))
    .catch(() => ok);
}

// 2. 解析公网 __MF_ENV
async function fetchMfEnv() {
  const html = await (await rfetch(ME_WEB_ENTRY)).text();
  const m = html.match(/window\.__MF_ENV\s*=\s*(\{[^}]+\})/);
  if (!m) throw new Error("me.jd.com 入口页未找到 __MF_ENV 注入");
  // 值里的转义处理：非严格 JSON，手动解析顶层字符串键值
  const env = {};
  for (const kv of m[1].matchAll(/"([A-Z_0-9]+)"\s*:\s*"([^"]*)"/g)) env[kv[1]] = kv[2];
  return env;
}

// 3. 可达性探测
async function probeHost(url) {
  try { const r = await rfetch(url, { method: "GET" }, 0); return r.status > 0; }
  catch { return false; }
}

function readExistingEnv() {
  const map = {};
  try {
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"\r\n]*)"?\s*$/);
      if (m) map[m[1]] = { raw: line, value: m[2] };
    }
  } catch { /* no file */ }
  return map;
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const force = args.includes("--force");

  console.log("== joyme2claude doctor ==\n");

  // 桌面端与桥
  const br = await checkBridge();
  console.log(`[1] 桌面端桥 127.0.0.1:8988: ${br.bridge ? "✓ 在线" : "✗ 不通（京Me 桌面端没在运行？）"}`);

  // 公网配置
  let mfEnv = null;
  try {
    mfEnv = await fetchMfEnv();
    console.log(`[2] 公网入口 ${ME_WEB_ENTRY}: ✓ 拿到 __MF_ENV（${Object.keys(mfEnv).length} 项）`);
  } catch (e) {
    console.log(`[2] 公网入口: ✗ ${e.message}`);
  }

  // 网关可达性
  const gw = mfEnv?.COLOR_GATEWAY_HOST || "https://api.m.jd.com";
  const gwOk = await probeHost(gw);
  console.log(`[3] 主网关 ${gw}: ${gwOk ? "✓ 可达" : "✗ 不可达（需内网/VPN？）"}`);

  // 生成配置
  const existing = readExistingEnv();
  const isReal = (k) => existing[k] && !existing[k].value.includes("<") && existing[k].value.length > 2;

  if (checkOnly) {
    console.log("\n== 现有 .env.local 体检 ==");
    let real = 0, missing = [];
    for (const [k, spec] of Object.entries(TEMPLATE)) {
      if (isReal(k)) { real++; console.log(`  ✓ ${k}`); }
      else if (spec.src !== "probe" || spec.candidates.length) { missing.push(k); console.log(`  ✗ ${k}（${spec.desc}）`); }
    }
    console.log(`\n${real} 项已配置，${missing.length} 项待补。运行 node doctor.js 自动补全可推导项。`);
    return;
  }

  // 写 .env.local（合并：未在 TEMPLATE 里的现有键原样保留，不丢任何已有配置）
  const existingLines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8").split("\n") : [];
  const kept = existingLines.filter(l => {
    const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !m || !TEMPLATE[m[1]]; // 保留：注释、空行、TEMPLATE 外的键
  });
  const header = [`# joyme2claude 运行时配置（本文件不进 git）`];
  const lines = force ? header : [...header, "# --- 以下原有配置已保留 ---", ...kept, "# --- doctor 推导/检查的配置 ---"];
  let auto = 0, manual = 0;
  for (const [k, spec] of Object.entries(TEMPLATE)) {
    let v;
    if (!force && isReal(k)) { v = existing[k].value; auto++; } // 已有真值
    else if (spec.src === "auto") {
      v = mfEnv?.[spec.mfKey] || "";
      if (!v) { lines.push(`# ${k}（${spec.desc}）— __MF_ENV 未包含，请人工填写`); manual++; continue; }
      auto++;
    } else if (spec.src === "const") {
      v = spec.value; auto++;
    } else { // probe
      const hit = spec.candidates.find(c => c);
      if (!hit) { lines.push(`# ${k}（${spec.desc}）— 无法自动推导，请人工填写（参考 README「配置发现」一节）`); manual++; continue; }
      v = hit; auto++;
    }
    lines.push(`export ${k}="${v}"`);
  }
  fs.writeFileSync(ENV_PATH, lines.filter(Boolean).join("\n") + "\n");
  console.log(`\n[4] .env.local 已${force ? "重写" : "更新"}: 已有真值+自动推导 ${auto} 项，需人工 ${manual} 项 → ${ENV_PATH}`);

  // 握手验证
  if (br.bridge && isReal("JOYME_APPID")) {
    console.log("\n[5] 尝试认证握手（login.getUserProfile）...");
    try {
      const out = execFileSync(process.execPath, [path.join(__dirname, "joyme.js"), "login.getUserProfile", "{}"], { encoding: "utf8" });
      const m = out.match(/"name"\s*:\s*"([^"]+)"/);
      console.log(m ? `  ✓ 握手成功，身份: ${m[1]}` : `  ✓ 握手成功: ${out.slice(0, 100)}`);
    } catch (e) {
      console.log(`  ✗ 握手失败: ${String(e.message).slice(0, 150)}`);
      console.log("    → 检查 JOYME_APPID / JOYME_TENANT 是否为你的部署取值（README「配置发现」）");
    }
  } else {
    console.log("\n[5] 跳过握手验证（桥不在线或 JOYME_APPID 未配置）");
  }

  console.log("\n下一步: 运行各脚本自检，或先人工补全上面标注「请人工填写」的项。");
}

main().catch(e => { console.error(e.message); process.exit(1); });
