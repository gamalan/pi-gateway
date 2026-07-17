# pi-gateway

Multi-platform chat bridge for pi — connect your AI agent to Telegram, Discord, Slack, and more. Real-time streaming, per-chat sessions, background tasks, and role-based access control.

> Fork of [0xKobold/pi-gateway](https://github.com/0xKobold/pi-gateway) with config-based UID allowlisting.

## Features

- **Multi-platform adapters** — Discord, Telegram, Slack, Twitch, WhatsApp, WebSocket
- **Real-time streaming** — responses appear token-by-token via live message editing
- **Per-chat sessions** — isolated conversations with configurable reset policies (daily / idle)
- **Background tasks** — spawn async work from chats, results delivered when ready
- **Allowlist security** — DB-based and config-file pre-approved UIDs, admin roles, tool access policies
- **Detached daemon mode** — `/gateway start -d` or `pi-gateway start -d` keeps the gateway alive after pi closes
- **HTTP + WebSocket API** — connect external clients, send prompts, receive streaming responses
- **pi-native** — runs as a pi extension with `/gateway` slash commands and registered tools

## Installation

Install from npm (recommended):

```bash
pi install npm:@gamalan/pi-gateway
```

Or clone and build manually:

```bash
git clone https://github.com/gamalan/pi-gateway.git
cd pi-gateway
npm install && npm run build
pi install .
```

Requires pi coding agent (`@earendil-works/pi-coding-agent >= 0.80.3`) and `@sinclair/typebox >= 0.32.0`.

## Quick Start

```bash
# Start the gateway
/gateway start

# Check status
/gateway status

# Stop
/gateway stop
```

The gateway starts on `http://localhost:3847` by default. See `/gateway config` for current settings. When detached mode is active, pi's footer shows `🟢 Gateway (daemon)` and automatically follows daemon start/stop changes.

## Configuration

Configuration lives at `~/.pi/gateway/config.json`:

```jsonc
{
  "port": 3847,
  "host": "localhost",
  "tokens": [],                    // Bearer tokens for API auth (empty = allow all)
  "corsOrigins": ["*"],
  "enableWebSocket": true,
  "enableHttp": true,
  "security": {
    "allowAll": true,              // false = enforce allowlist
    "requirePairing": false,
    "allowedUids": {},             // pre-approved users (see Security)
    "adminUids": {},              // users with full access (see Admin Users)
    "rateLimit": {
      "maxRequests": 60,
      "windowMs": 60000
    }
  },
  "sessions": {
    "resetPolicy": "idle",         // "daily" | "idle" | "both"
    "dailyHour": 4,                // hour (0-23) for daily reset
    "idleMinutes": 1440            // minutes before idle reset
  },
  "platforms": {
    "discord": {
      "enabled": true,
      "botToken": "your-token",
      "guildId": "optional-guild-id"
    },
    "twitch": {
      "enabled": true,
      "clientId": "your-client-id",
      "clientSecret": "your-secret",
      "channels": ["channel-name"]
    },
    "telegram": {
      "enabled": true,
      "token": "your-bot-token",
      "webhookUrl": "https://..."  // omit for long polling
    },
    "slack": {
      "enabled": true,
      "webhookUrl": "https://...",
      "botToken": "optional-bot-token"
    },
    "whatsapp": {
      "enabled": true,
      "sessionPath": "~/.pi/whatsapp-session",
      "printQr": true
    }
  }
}
```

When the gateway starts for the first time with no config file, it
automatically seeds `~/.pi/gateway/config.json` from the default
template shipped with the package.  You can also find it at
`node_modules/pi-gateway/config/config.default.json`.

### Telegram: webhook vs long polling

The gateway auto-detects the mode based on whether `webhookUrl` is set:

| `webhookUrl` | Mode | How it works |
|---|---|---|
| Set | **Webhook** | Telegram POSTs updates to `/webhook/telegram` on the gateway's HTTP server. Lowest latency, requires a public URL. |
| Omitted | **Long polling** | The gateway opens a persistent connection to Telegram's `getUpdates` endpoint (30s timeout). Telegram holds it open and returns immediately when a message arrives — near-real-time, no public URL needed. |

Both modes are real-time. Long polling is NOT interval-based — it keeps one connection alive at all times.

## Security

### Allowlist (DB)

Manage users at runtime via `/gateway` commands:

```bash
# List allowlisted users
/gateway allow

# Add a user
/gateway allow discord 123456789

# Revoke a user (via tool or directly)
```

### Config-file pre-approved UIDs

Skip pairing entirely by listing UIDs in the `security` block of `config.json`:

```jsonc
{
  "security": {
    "allowAll": false,
    "allowedUids": {
      "discord": ["123456789", "987654321"],
      "telegram": ["1234567890"],
      "*": ["cross-platform-admin"]
    },
    "adminUids": {
      "discord": ["123456789"],
      "*": ["cross-platform-admin-uid"]
    },
    "rateLimit": {
      "maxRequests": 60,
      "windowMs": 60000
    }
  }
}
```

- Platform-specific keys match that platform only
- The `"*"` wildcard matches any platform
- Users in this list are auto-allowed on first contact — no pairing code needed
- `adminUids` grants full unrestricted access (bypasses all tool policies)
- All security settings live in the main `config.json` — no separate security file

### Admin Users

Admin users have **full unrestricted access** — they bypass all tool policies and can use every tool pi offers (bash, write, edit, subagent, etc.).

Admins can be set at runtime or via config's `security.adminUids` block:

```jsonc
{
  "security": {
    "adminUids": {
      "discord": ["123456789"],
      "*": ["cross-platform-admin-uid"]
    }
  }
}
```

```bash
# List all admins (DB + config)
/gateway admin list

# Grant admin to a user on a specific platform
/gateway admin add discord 123456789

# Grant admin on ALL platforms
/gateway admin add * 123456789

# Revoke admin
/gateway admin remove discord 123456789
```

Admin users are listed in the status panel and their messages carry a "FULL ACCESS" guard.

### Tool Policy

By default, external users are **restricted to read-only tools** when their messages reach pi: they can search code, inspect files, and ask questions, but cannot write files, execute shell commands, spawn subagents, or modify system state.

The policy is enforced via a system directive prepended to every forwarded message. It is tunable per platform, per user, or globally.

**Default allowed tools:** `read`, `web_search`, `fetch_content`, `fffind`, `ffgrep`, `module_report`, `read_symbol`, code search tools, `lsp_diagnostics`, `lsp_navigation`, `image_generate`, `gateway_*`

**Default denied tools:** `bash`, `write`, `edit`, `subagent`, `todo`, `goal_complete`, `mcp`, `ast_grep_replace`, `agent_browser`, `wait`, `intercom`, `wiki_*`, `lens_diagnostics`

#### Managing Policies

```bash
# List all explicit policies
/gateway tool-policy list

# See the default baseline
/gateway tool-policy defaults

# Allow bash for a specific user
/gateway tool-policy set discord U123456 bash allow

# Deny write for all users on Discord
/gateway tool-policy set discord * write deny

# Allow everything for an admin user (glob)
/gateway tool-policy set * admin-uid * allow

# Remove a policy by ID
/gateway tool-policy remove 3

# Reset all custom policies to defaults
/gateway tool-policy reset
```

Policies can also be managed from within pi sessions via the `gateway_tool_policy` tool.

**Resolution order** (highest wins): user-specific > platform-specific > global. Ties break deny-first (secure by default). The `*` glob matches any tool name. Admin users always bypass all restrictions.

> **Note:** All security configuration (allowlist, admin UIDs, rate limits)
> lives in the `security` block of `~/.pi/gateway/config.json`. There is
> no separate security config file. On first run, the gateway
> auto-seeds a complete default config so you don't have to write one
> from scratch.

### Pairing Flow

When `requirePairing` is enabled and a user is not in the allowlist:

1. User sends a message → blocked, receives a pairing code
2. Admin approves with `/gateway pair <code>`
3. User is added to the DB allowlist

## Commands

| Command | Description |
|---------|-------------|
| `/gateway start [port]` | Start the gateway |
| `/gateway stop` | Stop the gateway |
| `/gateway restart` | Restart the gateway |
| `/gateway status` | Show running status, platforms, sessions |
| `/gateway pair [code]` | List pending codes or approve one |
| `/gateway allow [platform] [userId]` | List allowlist or add a user |
| `/gateway revoke <platform> <userId>` | Remove a user from the DB allowlist |
| `/gateway sessions` | List active chat sessions |
| `/gateway tasks` | List background tasks |
| `/gateway config` | Show current configuration |
| `/gateway admin list` | List admin users (DB + config) |
| `/gateway admin add <p\|*> <uid>` | Grant admin privileges |
| `/gateway admin remove <p\|*> <uid>` | Revoke admin |
| `/gateway admin list` | List admin users |
| `/gateway admin add <p\|*> <uid>` | Grant admin privileges |
| `/gateway admin remove <p\|*> <uid>` | Revoke admin |
| `/gateway tool-policy list` | List explicit tool policies |
| `/gateway tool-policy defaults` | Show default policy baseline |
| `/gateway tool-policy set <p> <u> <t> allow\|deny` | Add/update a tool policy |
| `/gateway tool-policy remove <id>` | Delete a policy |
| `/gateway tool-policy reset` | Clear all, back to defaults |

## HTTP API

Available when the gateway is running:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Gateway status (running, adapters, clients, sessions) |
| `/api/sessions` | GET | Active sessions |
| `/api/background` | GET | Background tasks |
| `/api/allowlist` | GET | Allowlisted users |
| `/api/pairing` | GET | Pending pairing codes |

Authenticate with `Authorization: Bearer <token>` if tokens are configured.

## WebSocket API

Connect to `ws://localhost:3847`. Messages are JSON:

```jsonc
// Send a prompt
{ "type": "prompt", "data": { "message": "Hello" } }

// Start a background task
{ "type": "background", "data": { "sessionId": "...", "command": "..." } }

// Ping
{ "type": "ping" }
```

Receive responses, background task updates, and agent events as server-pushed messages.

## Registered Tools

The extension registers these tools for use in pi sessions:

- **`gateway_status`** — Check if gateway is running and which adapters are active
- **`gateway_sessions`** — List active chat sessions
- **`gateway_background_tasks`** — List and manage background tasks
- **`gateway_pairing`** — Generate or approve pairing codes
- **`gateway_tool_policy`** — Manage tool access policies for external users

## Sessions

Each chat gets an isolated session with configurable reset policies:

- **daily** — Session resets at a specific hour each day (default: 4 AM)
- **idle** — Session resets after N minutes of inactivity
- **both** — Whichever triggers first

Sessions persist across gateway restarts in `~/.pi/gateway/gateway-sessions.db`.

## Background Tasks

Long-running work is spawned in isolated background sessions. Results are delivered back to the parent chat when complete. Managed via `/gateway tasks`.

## Architecture

```
┌─────────────┐     ┌─────────────────────────────┐
│  pi agent   │◄───►│        pi-gateway           │
│  (RPC)      │     │                             │
└─────────────┘     │  ┌─────────────────────┐    │
                    │  │ Platform Adapters    │    │
┌─────────────┐     │  │ Discord · Telegram   │    │
│ HTTP / WS   │────►│  │ Slack · Twitch       │    │
│ Clients     │     │  │ WhatsApp · WebSocket │    │
└─────────────┘     │  └─────────────────────┘    │
                    │                             │
                    │  ┌─────────────────────┐    │
                    │  │ Sessions Store      │    │
                    │  │ Background Manager  │    │
                    │  │ Security Layer      │    │
                    │  └─────────────────────┘    │
                    └─────────────────────────────┘
```

- **Platform adapters** translate incoming platform messages into a unified format
- **Sessions store** (`SQLite`) persists per-chat state with reset policies
- **Background manager** spawns async child processes, delivers results via chat
- **Security layer** checks allowlists, manages pairing codes, and enforces rate limits

## License

MIT
