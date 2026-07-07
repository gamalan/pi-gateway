# Interactive UI Bridge — Implementation Plan

## Goal

When pi extensions call `ctx.ui.select()`, `ctx.ui.confirm()`, `ctx.ui.input()`, or `ctx.ui.notify()`, the gateway must forward those prompts to the user's chat platform (Telegram, Discord, etc.) and route the user's response back to pi.

Currently, these become `extension_ui_request` JSON events on pi's stdout, which the gateway silently ignores.

---

## 1. Protocol Reference (pi RPC mode)

Pi emits `extension_ui_request` events on stdout when an extension calls a UI method:

```jsonc
// select
{ "type": "extension_ui_request", "id": "uuid-1", "method": "select",
  "title": "Pick a model", "options": ["Claude", "GPT", "Gemini"], "timeout": 30000 }

// confirm
{ "type": "extension_ui_request", "id": "uuid-2", "method": "confirm",
  "title": "Dangerous command", "message": "Allow rm -rf /?", "timeout": 10000 }

// input
{ "type": "extension_ui_request", "id": "uuid-3", "method": "input",
  "title": "Enter filename", "placeholder": "e.g. config.ts" }

// editor
{ "type": "extension_ui_request", "id": "uuid-4", "method": "editor",
  "title": "Edit commit message", "prefill": "fix: something" }

// notify (fire-and-forget — no response needed)
{ "type": "extension_ui_request", "id": "uuid-5", "method": "notify",
  "message": "Search completed", "notifyType": "info" }
```

The gateway must send back an `extension_ui_response` on pi's **stdin** for dialog methods:

```jsonc
// select / input / editor response
{ "type": "extension_ui_response", "id": "uuid-1", "value": "Claude" }

// confirm response
{ "type": "extension_ui_response", "id": "uuid-2", "confirmed": true }

// cancellation (any dialog)
{ "type": "extension_ui_response", "id": "uuid-3", "cancelled": true }
```

**Fire-and-forget methods** (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`) do not expect a response.

**Timeouts:** Dialog methods may include a `timeout` field (in ms). Pi auto-resolves with a default value when the timeout expires — the gateway does NOT need to track timeouts itself. It should, however, clean up the interactive message (e.g., remove buttons) when the timeout fires.

---

## 2. Platform Mapping

### 2.1 Telegram

| Method | Mechanism | Notes |
|--------|-----------|-------|
| `select` | Inline keyboard buttons | Callback data: `ui:<requestId>:<optionIndex>` |
| `confirm` | Inline keyboard [Yes] [No] | Callback data: `ui:<requestId>:1` / `ui:<requestId>:0` |
| `input` | `ForceReply` (forces reply-to-message) | User's next text message to the chat is captured |
| `editor` | Plain text + ForceReply | "Reply with your text:" |
| `notify` | Plain text message | No buttons, just the message |

Telegram already handles `callback_query` in `handleUpdate`. When a callback fires with `ui:*` prefix, it must be routed to the interactive bridge instead of creating a normal chat message.

### 2.2 Generic Fallback (all platforms)

| Method | Format |
|--------|--------|
| `select` | `**{title}**\n1. {option1}\n2. {option2}\nReply with number` |
| `confirm` | `**{title}**\n\n_{message}_\nReply yes/no` |
| `input` | `**{title}**\nReply with your input` |
| `editor` | `**{title}**\nReply with your text` |
| `notify` | `ℹ️ {message}` (or `⚠️` for warning, `❌` for error) |

Generic fallback works via normal text replies. The gateway watches for the user's next message in that channel and tries to interpret it as a response to the pending prompt.

---

## 3. Architecture

### 3.1 New File: `src/interactive.ts`

A self-contained module that manages the lifecycle of extension UI requests:

```
extension_ui_request (stdout)
       │
       ▼
┌──────────────────────┐
│   interactive.ts     │
│                      │
│  pendingRequests     │  Map<requestId, { platform, channelId,
│                      │     method, timeoutHandle? }>
│                      │
│  handleRequest()     │  Receives extension_ui_request event.
│                      │  Calls adapter.sendInteractive().
│                      │  Stores pending if dialog method.
│                      │
│  handleResponse()    │  Receives user's response.
│                      │  Looks up pending request.
│                      │  Writes extension_ui_response to pi stdin.
│                      │  Cleans up interactive message.
│                      │
│  cleanup()           │  Called when agent_end arrives —
│                      │  clears all pending for this prompt.
└──────────────────────┘
       │
       ▼
extension_ui_response (stdin to pi)
```

### 3.2 Changes to `src/adapters/base.ts`

Add to the `PlatformAdapter` interface:

```ts
/** Send an interactive prompt. Returns a message ID for cleanup. */
sendInteractive(
  channelId: string,
  prompt: InteractivePrompt,
): Promise<{ messageId: string }>;

/** Called by adapter when user responds to an interactive prompt.
 *  The adapter decodes platform-specific payload into a standard shape. */
onInteractiveResponse?: (response: InteractiveResponse) => void;
```

New types:

```ts
interface InteractivePrompt {
  requestId: string;
  method: "select" | "confirm" | "input" | "editor" | "notify";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
}

interface InteractiveResponse {
  requestId: string;
  value?: string;      // for select / input / editor
  confirmed?: boolean; // for confirm
  cancelled?: boolean; // user dismissed
}
```

### 3.3 Changes to `src/adapters/telegram.ts`

**`sendInteractive()` implementation:**

```ts
async sendInteractive(channelId: string, prompt: InteractivePrompt) {
  switch (prompt.method) {
    case "select": {
      // Inline keyboard: one button per option
      const buttons = prompt.options!.map((opt, i) => [{
        text: opt,
        data: `ui:${prompt.requestId}:${i}`,
      }]);
      return this.sendButtons(channelId, `**${prompt.title}**`, buttons);
    }
    case "confirm": {
      const buttons = [[
        { text: "✅ Yes", data: `ui:${prompt.requestId}:1` },
        { text: "❌ No",  data: `ui:${prompt.requestId}:0` },
      ]];
      const text = prompt.message
        ? `**${prompt.title}**\n\n_${prompt.message}_`
        : `**${prompt.title}**`;
      return this.sendButtons(channelId, text, buttons);
    }
    case "input":
    case "editor": {
      // ForceReply: user MUST reply to this message
      const text = prompt.method === "editor" && prompt.prefill
        ? `**${prompt.title}**\n\n\`\`\`\n${prompt.prefill}\n\`\`\`\n\nReply with your changes:`
        : `**${prompt.title}**${prompt.placeholder ? ` (${prompt.placeholder})` : ""}\n\nReply with your input:`;
      return this.sendForceReply(channelId, text, prompt.requestId);
    }
    case "notify": {
      const prefix = { info: "ℹ️", warning: "⚠️", error: "❌" }[prompt.notifyType || "info"];
      return this.sendMessage(channelId, `${prefix} ${prompt.message}`);
    }
  }
}
```

**Callback query routing (in `handleUpdate`):**

When a callback_query has `data` starting with `ui:`, parse it and call `onInteractiveResponse` instead of emitting a normal chat message:

```ts
if (update.callback_query) {
  const data = query.data;
  if (data.startsWith("ui:")) {
    const [, requestId, rawValue] = data.split(":");
    const value = rawValue; // option index or "1"/"0" for confirm
    this.onInteractiveResponse?.({
      requestId,
      value: prompt.method === "confirm" ? undefined : value,
      confirmed: prompt.method === "confirm" ? value === "1" : undefined,
    });
    // Answer callback to dismiss loading
    await this.answerCallback(query.id);
    return;
  }
  // ... existing callback handling
}
```

**ForceReply routing (in `handleUpdate` for messages):**

When a message has `reply_to_message` with text containing a `ui:<id>` marker, route it to `onInteractiveResponse`:

```ts
if (msg.reply_to_message?.text?.includes("ui:")) {
  const match = msg.reply_to_message.text.match(/ui:([a-f0-9-]+)/);
  if (match) {
    this.onInteractiveResponse?.({
      requestId: match[1],
      value: msg.text,
    });
    return;
  }
}
```

**New helper: `sendForceReply()`:**

```ts
async sendForceReply(channelId: string, text: string, requestId: string) {
  const response = await this.apiRequest("/sendMessage", {
    method: "POST",
    body: JSON.stringify({
      chat_id: channelId,
      text: `${text}\n\n_ui:${requestId}_`,
      parse_mode: "HTML",  // ForceReply doesn't need parse_mode for italic
      reply_markup: { force_reply: true },
    }),
  });
  const data = await response.json();
  return { messageId: String(data.result.message_id) };
}
```

Actually, `force_reply` is incompatible with `parse_mode`, so use plain text with a hidden marker.

### 3.4 Changes to `src/index.ts`

**In the stdout handler (`createRpcProcess`):**

Add after the existing `agent_end` / `message_update` handling:

```ts
// Handle extension UI requests
if (msg.type === "extension_ui_request") {
  handleExtensionUiRequest(msg).catch((err) => {
    logger.error("[gateway] Failed to handle extension UI request:", err);
  });
}
```

**`handleExtensionUiRequest()` function:**

```ts
async function handleExtensionUiRequest(msg: InteractiveUiRequest) {
  // Find which channel this prompt belongs to
  // We need to know which session triggered the current prompt
  const activeSession = getActiveSessionForCurrentPrompt();
  if (!activeSession) return;

  const adapter = state.adapters.get(activeSession.platform);
  if (!adapter) return;

  const prompt: InteractivePrompt = {
    requestId: msg.id,
    method: msg.method,
    title: msg.title,
    message: (msg as any).message,
    options: (msg as any).options,
    placeholder: (msg as any).placeholder,
    prefill: (msg as any).prefill,
    notifyType: (msg as any).notifyType,
  };

  if (prompt.method === "notify") {
    // Fire-and-forget — don't track
    await adapter.sendInteractive(activeSession.channelId, prompt);
    return;
  }

  // Dialog method — store pending and send
  const result = await adapter.sendInteractive(activeSession.channelId, prompt);
  pendingUiRequests.set(msg.id, {
    requestId: msg.id,
    platform: activeSession.platform,
    channelId: activeSession.channelId,
    messageId: result.messageId,
  });
}
```

**Routing user responses to pi's stdin:**

```ts
// In interactive.ts or index.ts
function sendUiResponse(requestId: string, response: InteractiveResponse) {
  const payload = {
    type: "extension_ui_response",
    id: requestId,
    ...(response.cancelled
      ? { cancelled: true }
      : response.confirmed !== undefined
        ? { confirmed: response.confirmed }
        : { value: response.value }),
  };

  if (rpcProcess?.stdin?.writable) {
    rpcProcess.stdin.write(JSON.stringify(payload) + "\n");
  }
}
```

**Cleanup on agent_end:**

When `agent_end` arrives, clear all pending UI requests (answer any lingering callbacks, clear ForceReply state).

### 3.5 Associating UI Requests with a Channel

The tricky part: when an `extension_ui_request` arrives on stdout, we need to know which chat channel it belongs to. Currently, the gateway doesn't track which channel triggered the current prompt.

**Solution:** Add a `activeChannel` tracker in the state:

```ts
// In state:
let activeChannel: { platform: string; channelId: string } | null = null;
```

Set it in `onMessage` before calling `sendPromptRpc`, clear it when `agent_end` arrives (or when the timeout/rejection fires).

### 3.6 Generic Fallback

All platforms that don't override `sendInteractive` get the generic text-based fallback. The fallback sends a plain text message with instructions. The adapter's `onMessage` callback (via the existing `AdapterCallbacks`) handles the user's text reply — it checks if there's a pending interactive prompt for that channel and routes the text as a response.

---

## 4. File Changes Summary

| File | Change | Scope |
|------|--------|-------|
| `src/interactive.ts` | **NEW** | Pending request store, `handleRequest()`, `handleResponse()`, `sendUiResponse()` |
| `src/adapters/base.ts` | MODIFY | Add `sendInteractive()`, `InteractivePrompt`, `InteractiveResponse` types |
| `src/adapters/telegram.ts` | MODIFY | Implement `sendInteractive()`, route `ui:*` callbacks, add `sendForceReply()` |
| `src/index.ts` | MODIFY | Handle `extension_ui_request` in stdout handler, track `activeChannel`, cleanup |

---

## 5. Edge Cases & Error Handling

| Scenario | Handling |
|----------|----------|
| User ignores prompt | Pi's built-in timeout auto-resolves. Gateway cleans up buttons/markers on `agent_end`. |
| User sends unrelated text while prompt is active | Only text that is a direct reply (Telegram `reply_to_message`) is treated as a response. Regular text goes to pi as a normal message. |
| Multiple concurrent UI requests in same channel | Each has a unique `requestId`. Responses are correlated by ID. Older prompts' buttons are disabled when a new prompt arrives. |
| Adapter disconnects while prompt pending | Cleanup on adapter disconnect — send `cancelled: true` for all pending requests on that platform. |
| `input`/`editor` without ForceReply support | Fall back to text-based generic prompt. |

---

## 6. Testing Plan

1. Start gateway with `pi-ask-user` or `@juicesharp/rpiv-ask-user-question` extension installed
2. Send a prompt that triggers a `ctx.ui.select()` / `ctx.ui.confirm()`
3. Verify inline keyboard appears in Telegram
4. Click a button — verify pi receives the response and continues
5. Test timeout: wait for auto-resolution
6. Test `ctx.ui.input()` with ForceReply
7. Test generic fallback on platforms without interactive support

---

## 7. Version Target

`1.5.0` — new feature with adapter interface changes.
