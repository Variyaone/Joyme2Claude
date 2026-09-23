# joyme2claude

Let [Claude Code](https://claude.com/claude-code) use **all** of your JoyMe (京ME) capabilities — messages, chat history, todos, calendar, meeting minutes, docs, email, org search, and image generation — directly from a pure Windows environment. No WSL, no openclaw, no stored credentials.

```
Claude ──► bin/joyme.js ──► 京ME desktop (local auth) ──► JoyMe APIs
```

## How it works

The only prerequisite: **the 京ME desktop client is running and logged in on your Windows machine.** Everything else is bootstrapped per-run:

1. `desk.agent.auth.encrypt` (Color gateway) → encrypted payload
2. Local 京ME desktop HiOffice service (`127.0.0.1:8988`) → appToken
3. `desk.agent.auth.getWebToken` → `me_token` (~24h valid, never cached to disk)
4. JoySpace/JoyMail exchange further tokens on demand (SSO / RSA login)

No credentials are ever stored. If the desktop client is closed, every call fails fast with a clear error.

## Setup

Requires Node.js ≥ 18 (uses built-in `fetch`, `crypto`, `URLSearchParams`).

```bash
git clone https://github.com/Variyaone/joyme2claude.git
```

Optional — the bot push channel needs one dependency:

```bash
cd joyme2claude/bot && npm install
```

Then point Claude at it via your project's `CLAUDE.md`:

```markdown
N=node                       # or path to a local node.exe
$N bin/joyme.js <functionId> '<bodyJSON>'
```

## Usage — one CLI, all capabilities

```bash
N=node
J=bin/joyme.js

# ── Identity & org search ─────────────────────────────────────
$N $J login.getUserProfile '{}'                     # who am I
$N $J jdme.search.search '{"keyword":"a name","from":"joywork","includeIndexSet":["*"],"origin":["CONTACT"],"includeSaaS":true,"start":0,"size":50}'  # find people/groups

# ── Chat history / message summaries (read) ───────────────────
$N $J --msg-summary                               # smart summary of last 2 days
$N $J --msg-summary 7                             # last N days
$N $J --msg-summary --pin <pin>                   # conversation with one person
$N $J --msg-summary --group <gid>                 # one group's conversation

# ── Send messages (write) ────────────────────────────────────
$N $J --send <pin> '<content>'                    # DM a person (confirm first!)
$N $J --send-group <gid> '<content>'               # send to a group (confirm first!)

# ── Todos (joywork) ──────────────────────────────────────────
$N $J meetingAgent.color.taskCommonSearch '{"title":"","createTime":{"start":"2026-09-01 00:00:00","end":"2026-09-30 23:59:59"}}'
$N $J work.task.clientTaskSave.v2 '<see task body below>'

# ── Calendar (joyday) ────────────────────────────────────────
$N $J joyday.appointment.searchScheduleAssist '{"startTime":<ms>,"endTime":<ms>,"searchMode":"part"}'
$N $J joyday.appointment.addAppointmentClaw '<bodyJSON>'

# ── Meeting minutes ──────────────────────────────────────────
$N $J minutes.search '{"keyword":"","startTime":<ms>,"endTime":<ms>}'
$N $J minutes.detail '{"minutesId":"..."}'
$N $J minutes.asr '<bodyJSON>'                     # ASR transcript

# ── Docs (JoySpace) ──────────────────────────────────────────
$N $J --joyspace /v2/search/global '{"search":"keyword","classiFication":[1],"timeRange":2,"scene":"global","start":0,"length":20}'
$N $J --joyspace /v1/pages/markdown-content '<bodyJSON>'

# ── Email (EWS via joymail) ──────────────────────────────────
$N $J --mail [YYYY-MM-DD] [YYYY-MM-DD]            # list, default last 2 days
$N $J --mail-detail <itemId>                       # read one email's body

# ── Any other Color-gateway API ─────────────────────────────
$N $J <functionId> '<bodyJSON>'

# ── Image generation ─────────────────────────────────────────
$N bin/image-gen.js "<prompt>"                     # text→image, prints imageUrl
$N bin/image-gen.js --save "<prompt>" out/          # also downloads the PNG
$N bin/image-gen.js --edit "<imageURL>" "<prompt>"  # image→image

# ── Bot push channel (optional, needs bot/ npm install) ─────
$N bot/joyme-bot.js "<content>"                     # push via joyclaw bot session
```

## Rules for the AI agent

These conventions live in the code's home project and are recommended for any Claude (or other agent) using this toolset:

1. **Search before you send.** Before messaging a colleague, run `jdme.search.search` to confirm the recipient. If multiple matches come back, list them and let the human pick.
2. **Confirm before any write.** Sending messages, creating todos, creating calendar events — always show the intended action to the human first.
3. **Shanghai timezone.** Calendar timestamps are milliseconds computed in `Asia/Shanghai`.
4. **Read freely, write carefully.** All read paths (history, mail, docs, minutes, search) are safe to run autonomously; writes are always human-gated by the rules above.

## Gotchas

- `me_token` is fetched fresh every run (~2s overhead). Use `--get-token` / `--get-sso` if you want to cache it in a longer-lived process.
- Git Bash mangles `/v2/...` paths into `C:\...` — the `--joyspace` handler already repairs this, but be aware when scripting.
- Message send uses an AES-192-CBC encrypted IM channel (`imCommon.api`); the key is fetched dynamically per run.
- Email goes through joymail RSA login + EWS SOAP; responses are raw SOAP XML (the `--mail` list mode pretty-prints them for you).
- `--msg-summary` calls `im-agent.jd.com/summary/summaryMsgForSkill` — it can take up to 2 minutes for long ranges.
- Image generation hits an internal AIGC endpoint that requires the office network (no auth, but not reachable from home VPN in some cases).

## Repository layout

```
bin/joyme.js       all JoyMe capabilities, single-file CLI, zero dependencies
bin/image-gen.js   AIGC image generation (text→image, image→image, download)
bot/joyme-bot.js   optional bot push channel (socket.io, needs npm install)
```

## Security & privacy

- This repo contains **code only** — no tokens, no PINs, no message content, no company documents. Never commit runtime output that contains real chat/mail content.
- All authentication is derived at runtime from the locally running 京ME desktop session. Nothing to leak, nothing to rotate.
- Intended for use with your own company account within your organization's policies.

## License

MIT
