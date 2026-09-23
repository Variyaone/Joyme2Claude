# Joyme2Claude

[中文](#中文) | [English](#english)

---

<a name="english"></a>

Give Claude (or any CLI agent) direct access to a JD-style enterprise IM ("JingMe"-like desktop client) — messages, mail, todos, calendar, meeting minutes, docs, contacts, file/image upload, and AI image generation — through small, dependency-free Node.js scripts that talk to the same endpoints the official desktop client uses.

**This repository is for educational and research purposes only.** See [Disclaimer](#disclaimer).

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
| Calendar | Search / create appointments | `joyme.js joyday.appointment.*`, `--create-appointment` |
| Minutes | Search meeting minutes, get transcripts (ASR), details | `joyme.js minutes.*` |
| Docs | Full-text search and read JoySpace documents | `joyme.js --joyspace` |
| Contacts | Search employees / groups | `joyme.js jdme.search.search` |
| Files | Upload images (direct) and large files (chunked, resumable >10MB) | `joyme.js --upload-image`, `--upload-file` |
| Files | Send an image in a chat (auto-upload + send) | `joyme.js --send-image` |
| AI | Text-to-image and image-to-image generation | `image-gen.js` |
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

# Employee search — full param shape, not just a keyword
$N bin/joyme.js jdme.search.search '{"keyword":"<name>","from":"joywork","ext":"","includeIndexSet":["*"],"origin":["CONTACT"],"includeSaaS":true,"start":0,"size":10}'

# AI image generation
$N bin/image-gen.js "a bar chart of weekly fulfilment rates"
```

More usage details (including all flags) are in the header comment of each script.

## Environment variables

All network endpoints and identifiers are runtime configuration — the repo ships only placeholders. Put them in a `.env.local` next to `bin/` (git-ignored): every script auto-loads it at startup, so a plain `node bin/joyme.js ...` just works. Values can also come from your shell environment, which takes precedence.

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
| `ME_TOKEN` | optional: reuse an existing token instead of the bridge handshake |

## Repository layout

```
bin/joyme.js         core CLI: messaging, todos, calendar, minutes, docs, contacts, upload (zero deps)
bin/mail-full.js     full-featured mail client: read + write + batch management (zero deps)
bin/image-gen.js     AIGC image generation (text→image, image→image, download)
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
| 日程 | 搜日程、建日程 | `joyme.js joyday.appointment.*`、`--create-appointment` |
| 纪要 | 搜会议纪要、取转写(ASR)、详情 | `joyme.js minutes.*` |
| 文档 | JoySpace 文档全文搜索与读取 | `joyme.js --joyspace` |
| 联系人 | 搜员工/群 | `joyme.js jdme.search.search` |
| 文件 | 图片直传、大文件分片断点续传（>10MB 自动分片） | `joyme.js --upload-image`、`--upload-file` |
| 文件 | 聊天里发图（自动上传+发送） | `joyme.js --send-image` |
| AI | 文生图、图生图 | `image-gen.js` |
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

# 员工搜索——要传完整参数，不是只传关键词
$N bin/joyme.js jdme.search.search '{"keyword":"<姓名>","from":"joywork","ext":"","includeIndexSet":["*"],"origin":["CONTACT"],"includeSaaS":true,"start":0,"size":10}'

# AI 画图
$N bin/image-gen.js "周履约率柱状图"
```

更多用法（含全部参数）见各脚本文件头注释。

## 环境变量

所有网络地址与标识符都是运行时配置——仓库里只有占位符。写进 `bin/` 旁边的 `.env.local`（已被 git 忽略）：每个脚本启动时自动加载，直接 `node bin/joyme.js ...` 即可。也可以放在 shell 环境里（优先级更高）。

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
| `ME_TOKEN` | 可选：复用已有 token，跳过桥接握手 |

## 目录结构

```
bin/joyme.js         核心 CLI：消息、待办、日程、纪要、文档、联系人、上传（零依赖）
bin/mail-full.js     邮件全家桶：读 + 写 + 批量管理（零依赖）
bin/image-gen.js     AIGC 画图（文生图、图生图、下载）
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
