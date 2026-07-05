/**
 * WebSocket Adapter - For web clients and other WebSocket-based platforms
 */

import { BaseAdapter, type PlatformMessage, type PlatformConfig } from "./base.js";
import { logger } from "../logger.js";

export interface WebSocketConfig extends PlatformConfig {
  platform: "websocket";
  clientId: string;
}

export class WebSocketAdapter extends BaseAdapter {
  readonly platform = "websocket" as const;
  config: WebSocketConfig;
  private client: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  constructor(config: WebSocketConfig) {
    super();
    this.config = config;
  }

  async initialize(): Promise<void> {
    logger.info(`[WebSocket] Adapter initialized for client ${this.config.clientId}`);
  }

  async start(callbacks): Promise<void> {
    await super.start(callbacks);
    // For server-side: this would be handled by the main gateway
    // This adapter is more for client-side connections
  }

  async connect(url: string, token?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      this.client = new WebSocket(url, { headers });

      this.client.onopen = () => {
        logger.info(`[WebSocket] Connected to ${url}`);
        this.reconnectAttempts = 0;
        resolve();
      };

      this.client.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === "message") {
            const message: PlatformMessage = {
              id: this.generateMessageId(),
              platform: this.platform,
              channelId: this.config.clientId,
              userId: this.config.clientId,
              content: data.content,
              timestamp: Date.now(),
              metadata: data.metadata,
            };
            this.emitMessage(message);
          }
        } catch (err) {
          logger.error("[WebSocket] Failed to parse message:", err);
        }
      };

      this.client.onclose = () => {
        logger.info("[WebSocket] Connection closed");
        this.callbacks?.onDisconnect?.();
        this.attemptReconnect(url, token);
      };

      this.client.onerror = (err) => {
        logger.error("[WebSocket] Error:", err);
        reject(err);
      };
    });
  }

  private attemptReconnect(url: string, token?: string): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      logger.info(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      setTimeout(() => this.connect(url, token), delay);
    }
  }

  async sendMessage(channelId: string, content: string): Promise<string> {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    const id = this.generateMessageId();
    this.client.send(JSON.stringify({
      type: "message",
      id,
      content,
      channelId,
    }));

    return id;
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    this.client.send(JSON.stringify({
      type: "edit",
      id: messageId,
      content,
      channelId,
    }));
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    this.client.send(JSON.stringify({
      type: "delete",
      id: messageId,
      channelId,
    }));
  }

  async setTyping(channelId: string, isTyping: boolean): Promise<void> {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) return;

    this.client.send(JSON.stringify({
      type: "typing",
      channelId,
      isTyping,
    }));
  }

  async getStatus(): Promise<{ connected: boolean; latency?: number }> {
    return {
      connected: this.client?.readyState === WebSocket.OPEN,
    };
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    await super.stop();
  }
}
