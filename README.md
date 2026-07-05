# pi-gateway

Hermes-style messaging gateway for pi — a multi-platform agent with per-chat sessions, background task support, and allowlist security.

> Fork of [0xKobold/pi-gateway](https://github.com/0xKobold/pi-gateway) with config-based UID allowlisting.

## Features

- **Multi-platform adapters** — Discord, Telegram, Slack, Twitch, WhatsApp, WebSocket
- **Per-chat sessions** — isolated conversations with configurable reset policies (daily / idle)
- **Background tasks** — spawn async work from chats, results delivered when ready
- **Allowlist security** — DB-based and config-file pre-approved UIDs, optional DM pairing flow
- **HTTP + WebSocket API** — connect external clients, send prompts, receive streaming responses
- **pi-native** — runs as a pi extension with `/gateway` slash commands and registered tools

## Installation

Pi supports installing extensions directly from GitHub:

```bash
pi install github:gamalan/pi-gateway
```

Or clone and build manually:

```bash
git clone https://github.com/gamalan/pi-gateway.git
cd pi-gateway
bun install && bun run build
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

The gateway starts on `http://localhost:3847` by default. See `/gateway config` for current settings.

## Configuration

Configuration lives at `~/.0xkobold/gateway/config.json`:

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
    "allowedUids": {}              // pre-approved users (see Security)
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
      "mode": "polling",           // or "webhook"
      "webhookUrl": "https://..."
    },
    "slack": {
      "enabled": true,
      "webhookUrl": "https://...",
      "botToken": "optional-bot-token"
    },
    "whatsapp": {
      "enabled": true,
      "sessionPath": "~/.0xkobold/whatsapp-session",
      "printQr": true
    }
  }
}
```

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

Skip pairing entirely by listing UIDs in `~/.0xkobold/gateway-security.json`:

```jsonc
{
  "allowAll": false,
  "allowedUids": {
    "discord": ["123456789", "987654321"],
    "telegram": ["1234567890"],
    "*": ["cross-platform-admin"]
  },
  "rateLimit": {
    "maxRequests": 60,
    "windowMs": 60000
  }
}
```

- Platform-specific keys match that platform only
- The `"*"` wildcard matches any platform
- Users in this list are auto-allowed on first contact — no pairing code needed

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
| `/gateway sessions` | List active chat sessions |
| `/gateway tasks` | List background tasks |
| `/gateway config` | Show current configuration |

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

## Sessions

Each chat gets an isolated session with configurable reset policies:

- **daily** — Session resets at a specific hour each day (default: 4 AM)
- **idle** — Session resets after N minutes of inactivity
- **both** — Whichever triggers first

Sessions persist across gateway restarts in `~/.0xkobold/gateway-sessions.db`.

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
