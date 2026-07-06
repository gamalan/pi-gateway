/**
 * Telegram Adapter - Hermes-style Telegram platform adapter
 *
 * Features:
 * - Polling and webhook modes
 * - DM and group chat support
 * - Inline queries
 * - Callback buttons
 */

import {
	BaseAdapter,
	type PlatformMessage,
	type PlatformConfig,
} from "./base.js";
import { logger } from "../logger.js";

interface TelegramConfig extends PlatformConfig {
	platform: "telegram";
	token: string;
	/** Public URL Telegram sends updates to (e.g. https://example.com/webhook/telegram).
	 *  When set, webhook mode is used. When omitted, long polling is used. */
	webhookUrl?: string;
	webhookSecret?: string;
	allowedChats?: string[]; // Whitelist chat IDs
	requireUsername?: boolean; // Require user to have a username
}

export type { TelegramConfig };

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
	callback_query?: {
		id: string;
		from: { id: number; username?: string; first_name?: string };
		message?: TelegramMessage;
		data: string;
	};
}

interface TelegramMessage {
	message_id: number;
	from?: { id: number; username?: string; first_name?: string };
	chat: { id: number; type: string; title?: string };
	text?: string;
	caption?: string;
	date: number;
	entities?: Array<{ type: string; offset: number; length: number }>;
}

export class TelegramAdapter extends BaseAdapter {
	readonly platform = "telegram" as const;
	config: TelegramConfig;

	private offset = 0;
	private pollingActive = false;
	private connected = false;

	constructor(config: TelegramConfig) {
		super();
		this.config = {
			enabled: true,
			platform: "telegram",
			...config,
		};
	}

	async initialize(): Promise<void> {
		// Test bot token
		const response = await this.apiRequest("/getMe");
		const data = (await response.json()) as {
			ok: boolean;
			result?: { id: number; username: string; first_name: string };
		};

		if (!response.ok || !data.ok) {
			throw new Error(`Telegram auth failed: ${response.status}`);
		}

		logger.info(`[Telegram] Bot initialized: @${data.result?.username}`);

		// Set webhook if URL configured; otherwise long polling is used
		if (this.config.webhookUrl) {
			await this.apiRequest("/setWebhook", {
				method: "POST",
				body: JSON.stringify({
					url: this.config.webhookUrl,
					...(this.config.webhookSecret
						? { secret_token: this.config.webhookSecret }
						: {}),
				}),
			});
			logger.info(`[Telegram] Webhook set → ${this.config.webhookUrl}`);
		} else {
			logger.info("[Telegram] No webhookUrl — will use long polling");
		}
	}

	private async apiRequest(
		endpoint: string,
		options: RequestInit = {},
	): Promise<Response> {
		const url = `https://api.telegram.org/bot${this.config.token}${endpoint}`;
		return fetch(url, {
			...options,
			signal: AbortSignal.timeout(35_000), // slightly above Telegram's 30s long-poll
			headers: {
				"Content-Type": "application/json",
				"Connection": "close", // prevent stale undici connections
				...options.headers,
			},
		});
	}

	async start(callbacks): Promise<void> {
		await super.start(callbacks);

		if (!this.config.webhookUrl) {
			// Long polling — keep a persistent connection and receive messages near-real-time
			this.startLongPolling();
		}
		// Webhook mode: gateway's HTTP server calls handleWebhookUpdate() on each POST
	}

	/**
	 * Long polling via getUpdates.
	 *
	 * Telegram holds the connection open (up to `timeout` seconds) and
	 * returns immediately when a message arrives. This is NOT interval-
	 * based polling — it is near-real-time, similar to a persistent
	 * connection. Used as a fallback when no webhookUrl is configured.
	 */
	private startLongPolling(): void {
		this.connected = true;
		this.pollingActive = true;
		this.longPoll();
	}

	private async longPoll(): Promise<void> {
		let backoff = 1000; // start at 1s, max ~30s
		while (this.pollingActive) {
			try {
				const response = await this.apiRequest("/getUpdates", {
					method: "POST",
					body: JSON.stringify({
						offset: this.offset,
						timeout: 30, // Telegram long-poll timeout (seconds)
					}),
				});

				// Reset backoff on successful connection
				backoff = 1000;

				if (!response.ok) {
					logger.error(`[Telegram] Poll HTTP ${response.status}`);
					await this.sleep(5000);
					continue;
				}

				const data = (await response.json()) as {
					ok: boolean;
					result?: TelegramUpdate[];
				};

				if (data.ok && data.result && data.result.length > 0) {
					for (const update of data.result) {
						await this.handleUpdate(update);
						this.offset = update.update_id + 1;
					}
				}
			} catch (err) {
				// Transient network errors are expected on long-lived connections
				logger.warn(
					`[Telegram] Poll retry in ${Math.round(backoff / 1000)}s — ${(err as Error).message || err}`,
				);
				await this.sleep(backoff);
				backoff = Math.min(backoff * 2, 30_000);
			}
		}
	}

	private async handleUpdate(update: any): Promise<void> {
		// Handle messages
		if (update.message || update.edited_message) {
			const msg = update.message || update.edited_message;

			// Check if chat is allowed
			if (
				this.config.allowedChats &&
				!this.config.allowedChats.includes(String(msg.chat.id))
			) {
				return;
			}

			// Check if username is required
			if (this.config.requireUsername && !msg.from?.username) {
				// Could send "Please set a username" message here
				return;
			}

			const content = msg.text || msg.caption || "";

			// Skip empty messages
			if (!content) return;

			const message: PlatformMessage = {
				id: this.generateMessageId(),
				platform: "telegram",
				channelId: String(msg.chat.id),
				userId: String(msg.from?.id || 0),
				content,
				timestamp: msg.date * 1000,
				metadata: {
					username: msg.from?.username,
					firstName: msg.from?.first_name,
					chatType: msg.chat.type,
					chatTitle: msg.chat.title,
					isEdited: !!update.edited_message,
				},
			};

			await this.emitMessage(message);
		}

		// Handle callback queries (button presses)
		if (update.callback_query) {
			const query = update.callback_query;

			const message: PlatformMessage = {
				id: this.generateMessageId(),
				platform: "telegram",
				channelId: String(query.message?.chat.id || query.from.id),
				userId: String(query.from.id),
				content: `Callback: ${query.data}`,
				timestamp: query.message?.date ? query.message.date * 1000 : Date.now(),
				metadata: {
					callbackId: query.id,
					callbackData: query.data,
					username: query.from.username,
				},
			};

			await this.emitMessage(message);

			// Answer callback to remove loading state
			await this.apiRequest("/answerCallbackQuery", {
				method: "POST",
				body: JSON.stringify({ callback_query_id: query.id }),
			});
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async stop(): Promise<void> {
		this.connected = false;
		this.pollingActive = false;
		await super.stop();
	}

	async sendMessage(channelId: string, content: string): Promise<string> {
		const response = await this.apiRequest("/sendMessage", {
			method: "POST",
			body: JSON.stringify({
				chat_id: channelId,
				text: content,
				parse_mode: "HTML",
			}),
		});

		const data = (await response.json()) as {
			ok: boolean;
			result?: { message_id: number };
		};

		if (!data.ok) {
			throw new Error(`Failed to send message: ${data}`);
		}

		return String(data.result?.message_id || 0);
	}

	async sendPhoto(
		channelId: string,
		photoUrl: string,
		caption?: string,
	): Promise<string> {
		const response = await this.apiRequest("/sendPhoto", {
			method: "POST",
			body: JSON.stringify({
				chat_id: channelId,
				photo: photoUrl,
				caption,
				parse_mode: "HTML",
			}),
		});

		const data = (await response.json()) as {
			ok: boolean;
			result?: { message_id: number };
		};

		if (!data.ok) {
			throw new Error(`Failed to send photo: ${data}`);
		}

		return String(data.result?.message_id || 0);
	}

	async sendButtons(
		channelId: string,
		text: string,
		buttons: Array<Array<{ text: string; data: string }>>,
	): Promise<string> {
		const replyMarkup = {
			inline_keyboard: buttons.map((row) =>
				row.map((btn) => ({ text: btn.text, callback_data: btn.data })),
			),
		};

		const response = await this.apiRequest("/sendMessage", {
			method: "POST",
			body: JSON.stringify({
				chat_id: channelId,
				text,
				parse_mode: "HTML",
				reply_markup: replyMarkup,
			}),
		});

		const data = (await response.json()) as {
			ok: boolean;
			result?: { message_id: number };
		};

		if (!data.ok) {
			throw new Error(`Failed to send buttons: ${data}`);
		}

		return String(data.result?.message_id || 0);
	}

	async editMessage(
		channelId: string,
		messageId: string,
		content: string,
	): Promise<void> {
		await this.apiRequest("/editMessageText", {
			method: "POST",
			body: JSON.stringify({
				chat_id: channelId,
				message_id: parseInt(messageId),
				text: content,
				parse_mode: "HTML",
			}),
		});
	}

	async deleteMessage(channelId: string, messageId: string): Promise<void> {
		await this.apiRequest("/deleteMessage", {
			method: "POST",
			body: JSON.stringify({
				chat_id: channelId,
				message_id: parseInt(messageId),
			}),
		});
	}

	async setTyping(channelId: string, isTyping: boolean): Promise<void> {
		const action = isTyping ? "typing" : "cancel";
		await this.apiRequest("/sendChatAction", {
			method: "POST",
			body: JSON.stringify({
				chat_id: channelId,
				action,
			}),
		});
	}

	async getStatus(): Promise<{ connected: boolean; latency?: number }> {
		return { connected: this.connected };
	}

	async getMe(): Promise<{ id: number; username: string; first_name: string }> {
		const response = await this.apiRequest("/getMe");
		const data = (await response.json()) as {
			ok: boolean;
			result: { id: number; username: string; first_name: string };
		};
		return data.result;
	}

	// Handle webhook update (called from HTTP handler)
	async handleWebhookUpdate(update: any): Promise<void> {
		if (this.config.webhookSecret) {
			// Verify secret here
		}
		await this.handleUpdate(update);
	}
}
