/**
 * Slack Adapter - Hermes-style Slack platform adapter
 * 
 * Features:
 * - Incoming webhooks (outbound only)
 * - Web API (with bot token)
 * - Slash command support
 * - Block Kit support
 */

import { BaseAdapter, type PlatformMessage, type PlatformConfig } from "./base.js";
import { logger } from "../logger.js";

export interface SlackConfig extends PlatformConfig {
  platform: "slack";
  webhookUrl?: string;
  botToken?: string;
  signingSecret?: string;
  teamId?: string;
  defaultChannel?: string;
}

interface SlackMessage {
  type: string;
  channel?: string;
  user?: string;
  username?: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

export class SlackAdapter extends BaseAdapter {
  readonly platform = "slack" as const;
  config: SlackConfig;
  
  private connected = false;

  constructor(config: SlackConfig) {
    super();
    this.config = {
      enabled: true,
      platform: "slack",
      ...config,
    };
  }

  async initialize(): Promise<void> {
    if (this.config.botToken) {
      // Test bot token
      const response = await this.apiRequest("auth.test", { method: "POST" });
      const data = await response.json() as { ok: boolean; team_id?: string };
      
      if (!data.ok) {
        throw new Error(`Slack auth failed: ${data}`);
      }
      
      logger.info(`[Slack] Bot initialized for team: ${data.team_id}`);
    } else if (this.config.webhookUrl) {
      logger.info("[Slack] Using webhook mode (outbound only)");
    } else {
      throw new Error("Slack requires either botToken or webhookUrl");
    }
  }

  private async apiRequest(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const url = `https://slack.com/api/${endpoint}`;
    return fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.config.botToken}`,
        ...options.headers,
      },
    });
  }

  async start(callbacks): Promise<void> {
    await super.start(callbacks);
    this.connected = true;
    
    if (!this.config.botToken && !this.config.webhookUrl) {
      logger.warn("[Slack] No credentials configured - adapter is outbound-only");
    }
  }

  async stop(): Promise<void> {
    this.connected = false;
    await super.stop();
  }

  async sendMessage(channelId: string, content: string): Promise<string> {
    // Try webhook first if available
    if (this.config.webhookUrl) {
      const payload = {
        text: content,
        ...(channelId && channelId.startsWith("#") ? { channel: channelId } : {}),
      };

      const response = await fetch(this.config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Slack webhook failed: ${response.status}`);
      }

      return `webhook-${Date.now()}`;
    }

    // Use Web API if we have a bot token
    if (this.config.botToken) {
      const response = await this.apiRequest("chat.postMessage", {
        method: "POST",
        body: JSON.stringify({
          channel: channelId,
          text: content,
        }),
      });

      const data = await response.json() as { ok: boolean; ts?: string; error?: string };

      if (!data.ok) {
        throw new Error(`Slack API error: ${data.error}`);
      }

      return data.ts || String(Date.now());
    }

    throw new Error("No Slack credentials configured");
  }

  async postMessage(channelId: string, content: string, blocks?: any[]): Promise<string> {
    if (!this.config.botToken) {
      throw new Error("Bot token required for rich messages");
    }

    const body: Record<string, any> = {
      channel: channelId,
      text: content,
    };

    if (blocks) {
      body.blocks = blocks;
    }

    const response = await this.apiRequest("chat.postMessage", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const data = await response.json() as { ok: boolean; ts?: string; error?: string };

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }

    return data.ts || String(Date.now());
  }

  async replyToThread(channelId: string, threadTs: string, content: string): Promise<string> {
    if (!this.config.botToken) {
      throw new Error("Bot token required for threaded replies");
    }

    const response = await this.apiRequest("chat.postMessage", {
      method: "POST",
      body: JSON.stringify({
        channel: channelId,
        text: content,
        thread_ts: threadTs,
      }),
    });

    const data = await response.json() as { ok: boolean; ts?: string; error?: string };

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }

    return data.ts || String(Date.now());
  }

  async editMessage(channelId: string, messageTs: string, content: string): Promise<void> {
    if (!this.config.botToken) {
      throw new Error("Bot token required for editing");
    }

    await this.apiRequest("chat.update", {
      method: "POST",
      body: JSON.stringify({
        channel: channelId,
        ts: messageTs,
        text: content,
      }),
    });
  }

  async deleteMessage(channelId: string, messageTs: string): Promise<void> {
    if (!this.config.botToken) {
      throw new Error("Bot token required for deletion");
    }

    await this.apiRequest("chat.delete", {
      method: "POST",
      body: JSON.stringify({
        channel: channelId,
        ts: messageTs,
      }),
    });
  }

  async setTyping(channelId: string, isTyping: boolean): Promise<void> {
    if (!this.config.botToken) return;

    await this.apiRequest("chat.postEphemeral", {
      method: "POST",
      body: JSON.stringify({
        channel: channelId,
        text: isTyping ? "_typing_" : "",
      }),
    });
  }

  async getChannelInfo(channelId: string): Promise<{
    id: string;
    name: string;
    numMembers: number;
    topic: string;
  } | null> {
    if (!this.config.botToken) {
      throw new Error("Bot token required");
    }

    const response = await this.apiRequest("conversations.info", {
      method: "POST",
      body: JSON.stringify({ channel: channelId }),
    });

    const data = await response.json() as { 
      ok: boolean; 
      channel?: { 
        id: string; 
        name: string; 
        num_members: number; 
        topic?: { value: string };
      };
    };

    if (!data.ok || !data.channel) {
      return null;
    }

    return {
      id: data.channel.id,
      name: data.channel.name,
      numMembers: data.channel.num_members,
      topic: data.channel.topic?.value || "",
    };
  }

  async listChannels(): Promise<Array<{ id: string; name: string }>> {
    if (!this.config.botToken) {
      throw new Error("Bot token required");
    }

    const response = await this.apiRequest("conversations.list", {
      method: "POST",
      body: JSON.stringify({ types: "public_channel,private_channel" }),
    });

    const data = await response.json() as { 
      ok: boolean; 
      channels?: Array<{ id: string; name: string }>;
    };

    if (!data.ok) {
      return [];
    }

    return (data.channels || []).map(c => ({ id: c.id, name: c.name }));
  }

  async getStatus(): Promise<{ connected: boolean; latency?: number }> {
    return { 
      connected: this.connected,
      ...(this.config.botToken ? { mode: "api" } : { mode: "webhook" })
    };
  }

  // Handle incoming events (for WebSocket or Socket Mode)
  async handleIncomingEvent(event: any): Promise<void> {
    if (event.type === "message" && !event.subtype) {
      const message: PlatformMessage = {
        id: this.generateMessageId(),
        platform: "slack",
        channelId: event.channel,
        userId: event.user,
        content: event.text,
        timestamp: parseFloat(event.ts) * 1000,
        metadata: {
          team: event.team,
          threadTs: event.thread_ts,
          username: event.username,
        },
      };

      this.emitMessage(message);
    }
  }
}
