# Joyme2Claude

[中文](#中文) | [English](#english)

---

<a name="english"></a>

Give Claude (or any CLI agent) direct access to a JD-style enterprise IM ("JingMe"-like desktop client) — messages, mail, todos, calendar, meeting minutes, docs, contacts, file/image upload, and AI image generation — through small, dependency-free Node.js scripts that talk to the same endpoints the official desktop client uses.

**This repository is for educational and research purposes only.** See [Disclaimer](#disclaimer).

## Why I built this

I used to do everything through the AI assistant built into the enterprise IM desktop client. It works, but I kept hitting the same walls:

- **It can't really work with my files.** I'd ask it to analyze a spreadsheet or a report draft, and it would need me to upload or paste content into the chat. It has no concept of my project directory. Meanwhile, Claude Code / Codex-style CLI agents live *in* the repo — they read the actual files, run the actual scripts, and fix their own mistakes.
- **Every conversation starts from zero.** The assistant has no persistent project context. My local agent has the whole git history, CLAUDE.md, and memory of what we did last week.
- **Output quality is capped by the hosted model.** I wanted frontier models on the hard parts and cheap fast ones on the boring parts — that's only possible if the agent runs on my machine.
- **The official assistant is a closed pipeline.** When it fails (and it does — timeouts, truncated replies, "please rephrase"), there's nothing to debug. Here, every script is 200 lines of readable Node.js I can step through with `console.log` when something breaks — which is exactly how this repo got built.

So the question became: what if the agent I trust for real engineering work could *also* send my messages, triage my inbox, file my todos, book my calendar, generate the weekly report images, and draft the slides — natively, from the same terminal where it writes code? That's this repo: **the enterprise-IM capabilities become plain CLI tools, and the intelligence layer is whichever agent you run locally.**

The security model also fits how I want to work: no third-party server ever touches my credentials. The scripts reuse the login session of the already-running desktop client through its local bridge — nothing is stored, proxied, or uploaded anywhere by this code. What leaves the machine is exactly the same API traffic the official client itself makes.

## What it can do

| Category | Capability | Tool |
|---|---|---|
| Messaging | Send text / image messages to a person or a group | `joyme.js --send`, `--send-image` |
| Messaging | Server-side AI summary of recent chats | `joyme.js --msg-summary` |
| Messaging | Read raw chat history from the desktop client's local logs (~7 days) | `jm-forensics.js --im-log` |
| Messaging | Extract bot-pushed report-card screenshots (signed OSS URLs) + metadata | `jm-forensics.js --card-images`, `--card-meta` |
| Mail | Search inbox / sent / custom folders, read a message, look up recipients | `mail-full.js search / detail / lookup-recipient` |
| Mail | **Send / reply / forward, with attachments** | `mail-full.js send / reply / forward` |
| Mail | Batch mark read/unread, flag, categorize, move, delete, folder management | `mail-full.js batch-*`, `folders`, `create-folder` |
| Todos | Search / create todos | `joyme.js meetingAgent.color.taskCommonSearch`, `--create-task` |
| OA | **Process todos by category, quick-approve, my applies, process detail, approve/reject** | `oa.js` |
| Calendar | Search / create appointments | `joyme.js joyday.appointment.*`, `--create-appointment` |
| Minutes | Search meeting minutes, get transcripts (ASR), details | `joyme.js minutes.*` |
| Docs | Full-text search and read JoySpace documents | `joyme.js --joyspace` |
| Docs | **Create docs / AI tables, Office URL import, aitable record CRUD** | `joyme.js --ai` |
| Contacts | Search employees / groups | `joyme.js jdme.search.search` |
| Files | Upload images (direct) and large files (chunked, resumable >10MB) | `joyme.js --upload-image`, `--upload-file` |
| Files | Send an image in a chat (auto-upload + send) | `joyme.js --send-image` |
| AI | Text-to-image and image-to-image generation | `image-gen.js` |
| AI | Text-to-video generation (async submit → poll → download, resumable) | `video-gen.js` |
| Push | Optional bot push channel | `bot/joyme-bot.js` |

> Group-admin operations (`--create-group`, `--group-members`, `--group-announcement`) are included but gated by server-side permission checks — they may return "no permission" depending on your account. `--later-list` (snoozed messages) works.

## How it works

The desktop client exposes a local bridge (port 8988). Every script run performs a fresh, stateless auth handshake through that bridge — no passwords, no API keys, no stored credentials in this repo:

```
Color gateway encrypt → local HiOffice bridge → me_token → (mail: RSA login → JWT) → API call
```

The only prerequisite is that the desktop client is running on the machine.

## Quick start

This repository contains **no real internal addresses or keys** — every gateway endpoint, app identifier and key is read from environment variables at runtime. Put them in a `.env.local` file next to `bin/` (git-ignored; the scripts auto-load it on startup, so no shell sourcing needed), then:

```bash
N=node   # any Node.js ≥ 18 (uses built-in fetch/FormData)

# Who am I
$N bin/joyme.js login.getUserProfile '{}'

# Send a message / an image
$N bin/joyme.js --send <pin> "hello"
$N bin/joyme.js --send-image <pin> chart.png

# Mail: search, read, send with attachment
$N bin/mail-full.js search --folder inbox --unread --limit 20
$N bin/mail-full.js detail --item-id <id>
$N bin/mail-full.js send --to a@x.com --subject "Report" --body "See attached" --attachments report.xlsx

# Todos & calendar — NOTE the exact request formats (see Gotchas below)
$N bin/joyme.js meetingAgent.color.taskCommonSearch '{"createTime":{"start":"2026-08-24 00:00:00","end":"2026-09-24 23:59:59"},"pageSize":20}'
$N bin/joyme.js --create-task '{"title":"Review PR","endTime":"2026-09-30"}'

# OA process center (read-only safe; approve/reject are write ops — confirm first)
$N bin/oa.js categories
$N bin/oa.js my-applies --start 2026-09-01
$N bin/oa.js detail --piid <processInstanceId>

# Employee search — full param shape, not just a keyword
$N bin/joyme.js jdme.search.search '{"keyword":"<name>","from":"joywork","ext":"","includeIndexSet":["*"],"origin":["CONTACT"],"includeSaaS":true,"start":0,"size":10}'

# Create a JoySpace doc / AI table, read & write aitable records
$N bin/joyme.js --ai '{"action":"create_doc_routing","team_id":"root","folder_id":"root","title":"Report","content":"# hi"}'
$N bin/joyme.js --ai '{"action":"create_doc_routing","team_id":"root","folder_id":"root","title":"Tracker","page_type":21}'
$N bin/joyme.js --ai '{"action":"aitable.createRecords","page_id":"<id>","sheet_id":"1","records":[{"fields":{"名称":"row1"}}]}'

# AI image generation
$N bin/image-gen.js "a bar chart of weekly fulfilment rates"

# AI video generation (async, polls until done, then prints the video URL)
$N bin/video-gen.js --prompt "misty forest lake at dawn" --duration 5 --mode 720p
$N bin/video-gen.js --resume bin/video-tasks/video-task-<id>.json   # resume an interrupted wait
```

More usage details (including all flags) are in the header comment of each script.

## Environment variables

**First run on a new machine: `node bin/doctor.js`** — it bootstraps most of the config automatically:

1. Checks the desktop client's local bridge (`127.0.0.1:8988`)
2. Fetches the public web entry (`https://me.jd.com`, no login needed) and parses the `window.__MF_ENV` injection — gateway hosts, app names and other runtime constants live there, served from a public CDN
3. Probes each gateway host for reachability
4. Writes `.env.local`, **merging with — never dropping — existing values**
5. Attempts a full auth handshake (`login.getUserProfile`) to verify the config end-to-end

Use `--check` to audit an existing config without writing, `--force` to regenerate from scratch. A few deployment-specific identifiers (gateway appid, SSO app key) cannot always be auto-derived — doctor marks those with `请人工填写` comments. For those, open the web version in a browser, F12 → Network, trigger the relevant action once, and read the values from the request (same technique the desktop client uses).

All network endpoints and identifiers are runtime configuration — the repo ships only placeholders. The scripts auto-load `.env.local` next to `bin/` (git-ignored).

| Variable | Purpose |
|---|---|
| `JOYME_API_BASE` | main API gateway origin |
| `JOYME_JOYSPACE_BASE` | docs API origin |
| `JOYME_FILE_BASE` | file upload host |
| `JOYME_MAIL_ENDPOINT` | mail SOAP/EWS proxy endpoint |
| `JOYME_ERP_QUERY_URL` | employee lookup API |
| `JOYME_SSO_HOST` / `JOYME_SSO_NAME` / `JOYME_SSO_COOKIE` | SSO exchange host, service name, cookie name |
| `JOYME_HIO_URL` / `JOYME_HIO_FROM` | local desktop bridge URL and app code |
| `JOYME_APPID` / `JOYME_APPNAME` / `JOYME_TENANT` / `JOYME_TEAM_ID` | gateway app identifiers |
| `JOYME_SSO_APP_KEY` | SSO app key |
| `JOYME_APP_TODO` / `JOYME_APP_CAL` / `JOYME_APP_MINUTES` | routing appids for todo / calendar / minutes APIs |
| `JOYME_MAIL_APPID` / `JOYME_MAIL_FN_PUBKEY` / `JOYME_MAIL_FN_LOGIN` / `JOYME_MAIL_SOURCE` | mail auth app id & function names |
| `JOYME_BIZ_FLAG` / `JOYME_MSG_SUMMARY_URL` | message business flag; chat-summary service URL |
| `JOYME_IMAGEGEN_URL` | AI image generation endpoint |
| `JOYME_VIDEO_GW` / `JOYME_VIDEO_APPCODE` | AI video gateway origin and app code (header auth) |
| `ME_TOKEN` | optional: reuse an existing token instead of the bridge handshake |

## Repository layout

```
bin/joyme.js         core CLI: messaging, todos, calendar, minutes, docs, contacts, upload (zero deps)
bin/mail-full.js     full-featured mail client: read + write + batch management (zero deps)
bin/oa.js            OA process center: todo categories, quick-approve, my applies, detail, approve/reject (zero deps)
bin/image-gen.js     AIGC image generation (text→image, image→image, download)
bin/video-gen.js     AIGC video generation (text→video, async submit/poll, resumable, zero deps)
bin/jm-forensics.js  local forensics: raw IM logs, card screenshot URLs, card metadata (zero deps)
bot/joyme-bot.js     optional bot push channel (socket.io, needs npm install)
```

## Gotchas

- **Write operations need confirmation.** Always confirm with the user before sending messages/mail, creating todos or appointments. For recipients, search first and let the user pick when there are multiple matches.
- Calendar timestamps are **Shanghai-timezone milliseconds**.
- The mail EWS gateway is occasionally flaky (`ews soap timeout`) — just retry.
- **Mail reply uses a fallback path.** The gateway consistently rejects EWS smart-reply (`ReplyToItem`) with HTTP 500 while `ForwardItem` works, so on failure `mail-full.js reply` automatically degrades to a normal send: `RE:` subject, back to the original sender, with the quoted original text. Same deliverability, just not a threaded smart-reply.
- **Todo search params are range objects, not timestamps**: `taskCommonSearch` takes `{"createTime":{"start":"YYYY-MM-DD HH:mm:ss","end":"..."},"pageSize":20}` — passing epoch millis returns a fastjson parse error.
- **Employee search needs the full param shape**: `jdme.search.search` with only `{"keyword":...}` fails with "搜索类型不能空"; pass `{"keyword":...,"from":"joywork","origin":["CONTACT"],"includeIndexSet":["*"],"includeSaaS":true,"start":0,"size":10}`.
- Card content blobs in IM logs are a semi-compressed format; the scripts lenient-decode them and regex out the ASCII fields rather than fully decompressing.
- Chat logs roll over (~7 days); older files are scanned automatically.

## Disclaimer

This project is a personal technical study of desktop-client-to-API communication patterns. It is published **for learning and research purposes only**:

- **No** company proprietary code, internal API documentation, credentials, tokens, or secrets are included. Everything here is original, from-scratch Node.js.
- **No** actual internal API endpoint addresses, app keys, or identifiers are present in this repository — check `bin/` to verify; anything sensitive is read from the environment at runtime or replaced with placeholders.
- The scripts only work on a machine where the user has already legitimately logged into the official desktop client, and act strictly as that user.
- Misuse (scraping confidential data, spamming, evading corporate policy) is prohibited. The author is not responsible for any consequences of use. If you are the operator of any related service and object to this repository, please open an issue and it will be handled promptly.

---

<a name="中文"></a>

# 中文版

让 Claude（或任何 CLI 智能体）直接使用京Me 类企业 IM 桌面端的全部能力——消息、邮件、待办、日程、会议纪要、文档、员工搜索、文件/图片上传、AI 画图——通过几个零依赖的 Node.js 小脚本，走桌面端官方客户端同样的接口。

**本仓库仅供学习研究用途。** 见[免责声明](#免责声明)。

## 为什么做这个

以前我的企业 IM 操作全靠桌面端自带的 AI 助手。能用，但总有几堵翻不过去的墙：

- **它没法真正处理我的文件。** 让它分析个表格、看个报告草稿，都得先上传或粘贴到对话框里——它对我的项目目录没有概念。而 Claude Code / Codex 这类本地 CLI 智能体本来就活在仓库里：读的是真实文件，跑的是真实脚本，错了自己改。
- **每次对话都从零开始。** 助手没有持久的工程上下文；本地智能体有完整的 git 历史、CLAUDE.md、上周一起干过什么的记忆。
- **能力上限被托管的模型锁死。** 我想难题用最强的模型、杂活用便宜快的模型——只有智能体跑在我本机上才做得到。
- **官方助手是条封闭管道。** 它出错的时候（超时、回复截断、“请换个说法再试”）你什么都排查不了。这里每个脚本就是两百行可读的 Node.js，哪里不对 `console.log` 打进去就能看——这个仓库本身就是这么调试出来的。

所以问题变成了：如果我最信任干活的那套智能体，**还能顺手**发消息、清收件箱、记待办、订日程、生成周报配图、起草幻灯片——就在它写代码的同一个终端里——会怎样？这就是本仓库：**把企业 IM 的能力变成普通 CLI 工具，智力层由你在本地跑哪个智能体决定。**

安全模型也合我的工作方式：没有任何第三方服务器碰我的凭证。脚本通过本地桥接复用正在运行的桌面端的登录态——本仓库的代码不存储、不中转、不上传任何东西；离开这台机器的流量，和官方客户端自己发的 API 请求一模一样。

## 能做什么

| 分类 | 能力 | 工具 |
|---|---|---|
| 消息 | 给个人/群发文字、发图片 | `joyme.js --send`、`--send-image` |
| 消息 | 近期聊天记录的服务端 AI 摘要 | `joyme.js --msg-summary` |
| 消息 | 从桌面端本地日志读聊天记录原文（约7天） | `jm-forensics.js --im-log` |
| 消息 | 提取机器人推送的报表卡片截图（OSS 签名直链）+ 元信息 | `jm-forensics.js --card-images`、`--card-meta` |
| 邮件 | 搜收件箱/已发送/自定义文件夹、读正文、查收件人 | `mail-full.js search / detail / lookup-recipient` |
| 邮件 | **发信/回复/转发，支持附件** | `mail-full.js send / reply / forward` |
| 邮件 | 批量已读/未读、旗标、分类、移动、删除、文件夹管理 | `mail-full.js batch-*`、`folders`、`create-folder` |
| 待办 | 搜待办、建待办 | `joyme.js meetingAgent.color.taskCommonSearch`、`--create-task` |
| OA | **待办分类、快捷审批、我发起的流程、流程详情、通过/驳回** | `oa.js` |
| 日程 | 搜日程、建日程 | `joyme.js joyday.appointment.*`、`--create-appointment` |
| 纪要 | 搜会议纪要、取转写(ASR)、详情 | `joyme.js minutes.*` |
| 文档 | JoySpace 文档全文搜索与读取 | `joyme.js --joyspace` |
| 文档 | **建文档/建AI表格、Office 导入、AI表格记录增删改查** | `joyme.js --ai` |
| 联系人 | 搜员工/群 | `joyme.js jdme.search.search` |
| 文件 | 图片直传、大文件分片断点续传（>10MB 自动分片） | `joyme.js --upload-image`、`--upload-file` |
| 文件 | 聊天里发图（自动上传+发送） | `joyme.js --send-image` |
| AI | 文生图、图生图 | `image-gen.js` |
| AI | 文生视频（异步提交→轮询→下载，支持断点恢复） | `video-gen.js` |
| 推送 | 可选的机器人推送通道 | `bot/joyme-bot.js` |

> 群管理类操作（`--create-group`、`--group-members`、`--group-announcement`）已实现，但受服务端权限校验限制，部分账号会返回"无权限"。`--later-list`（稍后处理列表）可用。

## 工作原理

桌面端在本机暴露一个桥接端口（8988）。每次运行脚本都通过它做一次全新的、无状态的认证握手——仓库里不含任何密码、API key、存储的凭证：

```
Color 网关加密 → 本地 HiOffice 桥 → me_token →（邮件：RSA 登录 → JWT）→ 调接口
```

唯一前提是桌面端在本机运行中。

## 快速开始

本仓库**不含任何真实内部地址或密钥**——所有网关地址、应用标识、密钥均运行时从环境变量读取。把它们写进 `bin/` 旁边的 `.env.local`（已被 git 忽略；脚本启动时自动加载，无需 source），然后：

```bash
N=node   # 任意 Node.js ≥ 18（用内置 fetch/FormData）

# 我是谁
$N bin/joyme.js login.getUserProfile '{}'

# 发消息 / 发图
$N bin/joyme.js --send <pin> "你好"
$N bin/joyme.js --send-image <pin> chart.png

# 邮件：搜索、读、带附件发信
$N bin/mail-full.js search --folder inbox --unread --limit 20
$N bin/mail-full.js detail --item-id <id>
$N bin/mail-full.js send --to a@x.com --subject "周报" --body "见附件" --attachments 周报.xlsx

# 待办与日程——注意请求格式（见「注意事项」）
$N bin/joyme.js meetingAgent.color.taskCommonSearch '{"createTime":{"start":"2026-08-24 00:00:00","end":"2026-09-24 23:59:59"},"pageSize":20}'
$N bin/joyme.js --create-task '{"title":"审PR","endTime":"2026-09-30"}'

# OA 流程中心（读操作安全；approve/reject 是写操作，先确认）
$N bin/oa.js categories
$N bin/oa.js my-applies --start 2026-09-01
$N bin/oa.js detail --piid <流程实例ID>

# 员工搜索——要传完整参数，不是只传关键词
$N bin/joyme.js jdme.search.search '{"keyword":"<姓名>","from":"joywork","ext":"","includeIndexSet":["*"],"origin":["CONTACT"],"includeSaaS":true,"start":0,"size":10}'

# 建 JoySpace 文档 / AI 表格，读写 AI 表格记录
$N bin/joyme.js --ai '{"action":"create_doc_routing","team_id":"root","folder_id":"root","title":"周报","content":"# hi"}'
$N bin/joyme.js --ai '{"action":"create_doc_routing","team_id":"root","folder_id":"root","title":"追踪表","page_type":21}'
$N bin/joyme.js --ai '{"action":"aitable.createRecords","page_id":"<id>","sheet_id":"1","records":[{"fields":{"名称":"行1"}}]}'

# AI 画图
$N bin/image-gen.js "周履约率柱状图"

# AI 视频生成（异步，轮询到完成后打印视频 URL）
$N bin/video-gen.js --prompt "清晨的森林湖泊，薄雾缭绕" --duration 5 --mode 720p
$N bin/video-gen.js --resume bin/video-tasks/video-task-<id>.json   # 恢复中断的等待
```

更多用法（含全部参数）见各脚本文件头注释。

## 环境变量

**新机器第一次运行：`node bin/doctor.js`** ——大部分配置自动自举：

1. 检查桌面端本地桥（`127.0.0.1:8988`）
2. 拉公网网页版入口（`https://me.jd.com`，无需登录），解析 `window.__MF_ENV` 注入——网关地址、应用名等运行时常量都在里面，公网 CDN 直接可取
3. 探测各网关 host 可达性
4. 写入 `.env.local`（**合并现有值，绝不丢失已有配置**）
5. 做一次完整认证握手（`login.getUserProfile`）端到端验证

`--check` 只体检不写文件，`--force` 从零重生成。少数部署相关标识符（网关 appid、SSO app key）不一定能自动推导——doctor 会在文件里用注释标注。这些值可以用浏览器打开网页版、F12 → Network、触发一次对应操作、从请求里读出来（和桌面端用的是同一批值）。

所有网络地址与标识符都是运行时配置——仓库里只有占位符。脚本自动加载 `bin/` 旁边的 `.env.local`（已被 git 忽略）。

| 变量 | 用途 |
|---|---|
| `JOYME_API_BASE` | 主 API 网关地址 |
| `JOYME_JOYSPACE_BASE` | 文档 API 地址 |
| `JOYME_FILE_BASE` | 文件上传主机 |
| `JOYME_MAIL_ENDPOINT` | 邮件 SOAP/EWS 代理端点 |
| `JOYME_ERP_QUERY_URL` | 员工查询 API |
| `JOYME_SSO_HOST` / `JOYME_SSO_NAME` / `JOYME_SSO_COOKIE` | SSO 换票主机、服务名、cookie 名 |
| `JOYME_HIO_URL` / `JOYME_HIO_FROM` | 本地桌面端桥接地址与 app code |
| `JOYME_APPID` / `JOYME_APPNAME` / `JOYME_TENANT` / `JOYME_TEAM_ID` | 网关应用标识 |
| `JOYME_SSO_APP_KEY` | SSO app key |
| `JOYME_APP_TODO` / `JOYME_APP_CAL` / `JOYME_APP_MINUTES` | 待办/日程/纪要 API 的路由 appid |
| `JOYME_MAIL_APPID` / `JOYME_MAIL_FN_PUBKEY` / `JOYME_MAIL_FN_LOGIN` / `JOYME_MAIL_SOURCE` | 邮件认证 app id 与接口名 |
| `JOYME_BIZ_FLAG` / `JOYME_MSG_SUMMARY_URL` | 消息 business flag；聊天摘要服务地址 |
| `JOYME_IMAGEGEN_URL` | AI 画图接口地址 |
| `JOYME_VIDEO_GW` / `JOYME_VIDEO_APPCODE` | AI 视频网关地址与 app code（header 鉴权） |
| `ME_TOKEN` | 可选：复用已有 token，跳过桥接握手 |

## 目录结构

```
bin/joyme.js         核心 CLI：消息、待办、日程、纪要、文档、联系人、上传（零依赖）
bin/mail-full.js     邮件全家桶：读 + 写 + 批量管理（零依赖）
bin/oa.js            OA 流程中心：待办分类、快捷审批、我发起的、详情、通过/驳回（零依赖）
bin/image-gen.js     AIGC 画图（文生图、图生图、下载）
bin/video-gen.js     AIGC 视频（文生视频、异步提交/轮询、断点恢复，零依赖）
bin/jm-forensics.js  本地取证：IM 日志原文、卡片截图 URL、卡片元信息（零依赖）
bot/joyme-bot.js     可选机器人推送通道（socket.io，需 npm install）
```

## 注意事项

- **写操作先确认。** 发消息/邮件、建待办/日程前务必向用户确认；收件人先搜索，多条匹配让用户选。
- 日程时间戳是**上海时区毫秒**。
- 邮件 EWS 网关偶发超时（`ews soap timeout`），重试即可。
- **邮件回复走降级路径。** 网关对 EWS 智能回复（`ReplyToItem`）稳定返回 500，而 `ForwardItem` 正常；因此 `mail-full.js reply` 失败时自动降级为普通发送：`RE:` 主题 + 发回原发件人 + 附原文引用。送达效果相同，只是不是线程化智能回复。
- **待办搜索参数是时间范围对象，不是时间戳**：`taskCommonSearch` 要传 `{"createTime":{"start":"YYYY-MM-DD HH:mm:ss","end":"..."},"pageSize":20}`，传毫秒时间戳会报 fastjson 解析错误。
- **员工搜索要传完整参数**：`jdme.search.search` 只传 `{"keyword":...}` 会报"搜索类型不能空"；要传 `{"keyword":...,"from":"joywork","origin":["CONTACT"],"includeIndexSet":["*"],"includeSaaS":true,"start":0,"size":10}`。
- IM 日志里的卡片正文是半压缩格式，脚本用容错解码+正则提取 ASCII 字段，不做完整解压。
- 聊天日志约 7 天滚动，旧文件会自动扫描。

## 免责声明

本项目是对"桌面客户端 ↔ 服务端 API"通信方式的技术研究，**仅供学习交流使用**：

- 仓库内**不含**任何公司专有代码、内部 API 文档、凭证、token 或机密内容；所有代码均为从零编写的原创 Node.js。
- 仓库内**不含**任何真实内部接口地址、app key 或标识符——可自行检查 `bin/` 目录核实；敏感值均在运行时从环境读取或以占位符代替。
- 脚本只在用户已合法登录官方桌面端的机器上可用，且始终以该用户本人的身份执行操作。
- 禁止用于爬取机密数据、群发骚扰、绕过公司策略等用途。使用产生的任何后果与作者无关。若您是相关服务运营方且对本仓库有异议，请提 issue，将及时处理。
