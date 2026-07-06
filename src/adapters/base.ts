/**
 * Platform Adapter Base - Interface for Hermes-style platform adapters
 */

export interface PlatformMessage {
	id: string;
	platform: string;
	channelId: string;
	userId: string;
	content: string;
	timestamp: number;
	metadata?: Record<string, unknown>;
}

export interface PlatformConfig {
	enabled: boolean;
	platform: string;
	token?: string;
	botToken?: string;
	webhookSecret?: string;
}

export interface AdapterCallbacks {
	onMessage: (message: PlatformMessage) => Promise<void>;
	onTyping?: (userId: string, isTyping: boolean) => void;
	onDisconnect?: () => void;
}

export interface PlatformAdapter {
	readonly platform: string;
	readonly config: PlatformConfig;

	/**
	 * Initialize the adapter
	 */
	initialize(): Promise<void>;

	/**
	 * Start listening for messages
	 */
	start(callbacks: AdapterCallbacks): Promise<void>;

	/**
	 * Stop listening
	 */
	stop(): Promise<void>;

	/**
	 * Send a message to a channel
	 */
	sendMessage(channelId: string, content: string): Promise<string>; // Returns message ID

	/**
	 * Edit an existing message
	 */
	editMessage(
		channelId: string,
		messageId: string,
		content: string,
	): Promise<void>;

	/**
	 * Delete a message
	 */
	deleteMessage(channelId: string, messageId: string): Promise<void>;

	/**
	 * Set typing indicator
	 */
	setTyping(channelId: string, isTyping: boolean): Promise<void>;

	/**
	 * Get adapter health status
	 */
	getStatus(): Promise<{ connected: boolean; latency?: number }>;
}

/**
 * Abstract base class for adapters
 */
export abstract class BaseAdapter implements PlatformAdapter {
	abstract readonly platform: string;
	abstract config: PlatformConfig;
	protected callbacks: AdapterCallbacks | null = null;
	protected running = false;

	async initialize(): Promise<void> {
		// Override in subclass
	}

	async start(callbacks: AdapterCallbacks): Promise<void> {
		this.callbacks = callbacks;
		this.running = true;
	}

	async stop(): Promise<void> {
		this.running = false;
		this.callbacks = null;
	}

	abstract sendMessage(channelId: string, content: string): Promise<string>;
	abstract editMessage(
		channelId: string,
		messageId: string,
		content: string,
	): Promise<void>;
	abstract deleteMessage(channelId: string, messageId: string): Promise<void>;
	abstract setTyping(channelId: string, isTyping: boolean): Promise<void>;
	abstract getStatus(): Promise<{ connected: boolean; latency?: number }>;

	protected emitMessage(message: PlatformMessage): Promise<void> {
		if (this.callbacks?.onMessage) {
			return this.callbacks.onMessage(message).catch((err) => {
				// Log but don't crash the adapter loop
				console.error(`[${this.platform}] Error in onMessage callback:`, err);
			}) as Promise<void>;
		}
		return Promise.resolve();
	}

	protected generateMessageId(): string {
		return `${this.platform}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}
}
