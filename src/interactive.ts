/**
 * Interactive UI Bridge — bridges pi extension_ui_request events
 * to platform-native interactive prompts (inline keyboards, etc.)
 *
 * Protocol (from pi RPC docs):
 *   Pi emits extension_ui_request on stdout when extensions call
 *   ctx.ui.select(), ctx.ui.confirm(), ctx.ui.input(), etc.
 *   The gateway displays these to the user and sends
 *   extension_ui_response back on pi's stdin.
 */

import type { BaseAdapter } from "./adapters/base.js";
import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface InteractiveUiRequest {
	type: "extension_ui_request";
	id: string;
	method: "select" | "confirm" | "input" | "editor" | "notify";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	notifyType?: "info" | "warning" | "error";
	timeout?: number;
}

/** Platform-agnostic description of an interactive prompt. */
export interface InteractivePrompt {
	requestId: string;
	method: InteractiveUiRequest["method"];
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	notifyType?: "info" | "warning" | "error";
}

/** User's response to an interactive prompt. */
export interface InteractiveResponse {
	requestId: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
}

export interface ActiveChannel {
	platform: string;
	channelId: string;
}

// ── State ───────────────────────────────────────────────────────────────────

interface PendingUiRequest {
	requestId: string;
	platform: string;
	channelId: string;
	messageId: string;
	adapter: BaseAdapter;
}

const pendingUiRequests = new Map<string, PendingUiRequest>();

/** The channel that triggered the current prompt being processed by pi. */
let activeChannel: ActiveChannel | null = null;

/** Callback to write to pi's stdin. Set by index.ts */
let writeToStdin: ((line: string) => void) | null = null;

// ── Public API ──────────────────────────────────────────────────────────────

export function setStdinWriter(fn: (line: string) => void): void {
	writeToStdin = fn;
}

export function setActiveChannel(ch: ActiveChannel | null): void {
	activeChannel = ch;
}

export function getActiveChannel(): ActiveChannel | null {
	return activeChannel;
}

/**
 * Handle an extension_ui_request event from pi's stdout.
 * Called from the RPC stdout handler in index.ts.
 */
export async function handleExtensionUiRequest(
	msg: InteractiveUiRequest,
	adapter: BaseAdapter,
): Promise<void> {
	if (!activeChannel) {
		logger.warn("[interactive] No active channel — cannot route UI request");
		return;
	}

	const prompt: InteractivePrompt = {
		requestId: msg.id,
		method: msg.method,
		title: msg.title,
		message: msg.message,
		options: msg.options,
		placeholder: msg.placeholder,
		prefill: msg.prefill,
		notifyType: msg.notifyType,
	};

	if (msg.method === "notify") {
		// Fire-and-forget — don't track for response
		try {
			await adapter.sendInteractive(activeChannel.channelId, prompt);
		} catch (err) {
			logger.error("[interactive] Failed to send notify:", err);
		}
		return;
	}

	// Dialog method — send and track for response
	try {
		const result = await adapter.sendInteractive(
			activeChannel.channelId,
			prompt,
		);
		pendingUiRequests.set(msg.id, {
			requestId: msg.id,
			platform: activeChannel.platform,
			channelId: activeChannel.channelId,
			messageId: result.messageId,
			adapter,
		});
		logger.info(
			`[interactive] Sent ${msg.method} prompt ${msg.id.slice(0, 8)}… to ${activeChannel.platform}/${activeChannel.channelId}`,
		);
	} catch (err) {
		logger.error("[interactive] Failed to send interactive prompt:", err);
		// Auto-cancel so pi doesn't hang
		sendUiResponse(msg.id, { requestId: msg.id, cancelled: true });
	}
}

/**
 * Handle a user's response to an interactive prompt.
 * Called by adapters when the user clicks a button or replies.
 *
 * If requestId is empty, looks up the most recent pending request
 * for the active channel (used for ForceReply responses on Telegram).
 */
export function handleInteractiveResponse(response: InteractiveResponse): void {
	let pending = response.requestId
		? pendingUiRequests.get(response.requestId)
		: undefined;

	// Fallback for ForceReply: if no requestId, find the most recent
	// pending request for the current active channel.
	if (!pending && activeChannel) {
		for (const [, p] of pendingUiRequests) {
			if (
				p.platform === activeChannel.platform &&
				p.channelId === activeChannel.channelId
			) {
				pending = p;
				response.requestId = p.requestId;
				break;
			}
		}
	}

	if (!pending) {
		logger.warn(
			`[interactive] No pending request for id ${(response.requestId || "(empty)").slice(0, 8)}…`,
		);
		return;
	}

	logger.info(
		`[interactive] Response for ${response.requestId.slice(0, 8)}…: ${response.value ?? (response.confirmed ? "confirmed" : "?")}${response.cancelled ? " (cancelled)" : ""}`,
	);

	pendingUiRequests.delete(response.requestId);
	sendUiResponse(response.requestId, response);
}

/**
 * Clean up all pending interactive prompts.
 * Called on agent_end or when the active channel changes.
 */
export function cleanupPendingUiRequests(): void {
	for (const [id, pending] of pendingUiRequests) {
		logger.info(`[interactive] Cleaning up pending request ${id.slice(0, 8)}…`);
		// Try to remove interactive elements from the message
		pending.adapter
			.cleanupInteractive?.(pending.channelId, pending.messageId)
			.catch(() => {});
	}
	pendingUiRequests.clear();
}

// ── Internal ────────────────────────────────────────────────────────────────

function sendUiResponse(
	requestId: string,
	response: InteractiveResponse,
): void {
	const payload: Record<string, unknown> = {
		type: "extension_ui_response",
		id: requestId,
	};

	if (response.cancelled) {
		payload.cancelled = true;
	} else if (response.confirmed !== undefined) {
		payload.confirmed = response.confirmed;
	} else {
		payload.value = response.value ?? "";
	}

	const line = JSON.stringify(payload) + "\n";
	if (writeToStdin) {
		writeToStdin(line);
	} else {
		logger.error("[interactive] No stdin writer — cannot send UI response");
	}
}
