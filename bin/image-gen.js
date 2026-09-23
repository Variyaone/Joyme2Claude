#!/usr/bin/env node
// AIGC 图像生成（文生图/图生图），零依赖
// 用法:
//   node image-gen.js "<prompt>"                        # 文生图
//   node image-gen.js --edit "<原图URL>" "<编辑提示词>"   # 图生图
//   node image-gen.js --save "<prompt>" [输出路径]       # 文生图并下载 PNG 到本地
// 返回 JSON（含 imageUrl）；--save 同时下载文件

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

const API_URL = process.env.JOYME_IMAGEGEN_URL || "http://<your-imagegen-api>";
const fs = require("fs");
const path = require("path");

function usage() {
  console.error(`用法:
  node image-gen.js "<prompt>"                       文生图，打印 imageUrl
  node image-gen.js --edit "<原图URL>" "<编辑提示词>"  图生图
  node image-gen.js --save "<prompt>" [输出路径]      文生图并下载 PNG`);
  process.exit(1);
}

async function callApi(messages) {
  const payload = {
    sessionId: crypto.randomUUID(),
    messages,
  };
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const json = await resp.json();
  if (json.code !== 200 || !json.data || !json.data.imageUrl) {
    throw new Error(`接口返回异常: ${JSON.stringify(json)}`);
  }
  return json;
}

async function download(url, dest) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

(async () => {
  const args = process.argv.slice(2);
  let mode = "text2img", prompt = "", imageUrl = "", savePath = "";

  if (args[0] === "--edit") {
    if (args.length < 3) usage();
    imageUrl = args[1];
    prompt = args[2];
    if (args[3] === "--save") savePath = args[4] || "";
    mode = "img2img";
  } else if (args[0] === "--save") {
    if (args.length < 2) usage();
    prompt = args[1];
    savePath = args[2] || "";
  } else if (args.length === 1) {
    prompt = args[0];
  } else {
    usage();
  }

  const messages = mode === "img2img"
    ? [
        { role: "assistant", image_url: imageUrl, content: "fig" },
        { role: "user", content: prompt },
      ]
    : [{ role: "user", content: prompt }];

  try {
    const json = await callApi(messages);
    if (savePath) {
      if (!savePath.match(/\.png$|\.jpe?g$/i)) {
        const ext = (json.data.imageUrl.match(/\.(\w+)\?/) || [, "png"])[1];
        savePath = path.join(savePath, `poster-${Date.now()}.${ext}`);
      }
      await download(json.data.imageUrl, savePath);
      console.log(`已保存: ${savePath}`);
    }
    console.log(`mode: ${json.data.mode}`);
    console.log(`imageUrl: ${json.data.imageUrl}`);
  } catch (e) {
    console.error(`错误: ${e.message}`);
    process.exit(1);
  }
})();
