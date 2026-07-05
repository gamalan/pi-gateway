/**
 * Twitch Adapter - Hermes-style Twitch platform adapter
 * 
 * Features:
 * - Helix API integration
 * - EventSub WebSocket for real-time events
 * - Stream notifications (live/offline)
 * - Chat settings and moderation
 */

import { BaseAdapter, type PlatformMessage, type PlatformConfig } from "./base.js";
import { logger } from "../logger.js";

export interface TwitchConfig extends PlatformConfig {
  platform: "twitch";
  clientId: string;
  clientSecret: string;
  channels?: string[];  // Channels to monitor
  events?: string[];   // Event types to subscribe
}

interface TwitchToken {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface TwitchStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_name: string;
  title: string;
  viewer_count: number;
  started_at: string;
}

export class TwitchAdapter extends BaseAdapter {
  readonly platform = "twitch" as const;
  config: TwitchConfig;
  
  private token: TwitchToken | null = null;
  private tokenExpiry = 0;
  private eventsubWs: WebSocket | null = null;
  private eventsubSessionId: string | null = null;
  private subscribedChannels: Set<string> = new Set();
  private streamStatus: Map<string, boolean> = new Map();

  constructor(config: TwitchConfig) {
    super();
    this.config = {
      enabled: true,
      platform: "twitch",
      channels: [],
      events: ["stream.online", "stream.offline"],
      ...config,
    };
    
    // Initialize monitored channels
    if (this.config.channels) {
      this.config.channels.forEach(c => this.subscribedChannels.add(c.toLowerCase()));
    }
  }

  async initialize(): Promise<void> {
    await this.authenticate();
    logger.info(`[Twitch] Adapter initialized for ${this.subscribedChannels.size} channels`);
  }

  private async authenticate(): Promise<void> {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "client_credentials",
    });

    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Twitch auth failed: ${response.status}`);
    }

    this.token = await response.json() as TwitchToken;
    this.tokenExpiry = Date.now() + (this.token!.expires_in * 1000);
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry - 60000) {
      return this.token.access_token;
    }
    await this.authenticate();
    return this.token!.access_token;
  }

  private getHeaders(): Record<string, string> {
    if (!this.token) throw new Error("Not authenticated");
    return {
      "Client-ID": this.config.clientId,
      "Authorization": `Bearer ${this.token.access_token}`,
    };
  }

  async start(callbacks): Promise<void> {
    await super.start(callbacks);
    
    // Connect to EventSub WebSocket
    await this.connectEventSub();
  }

  private async connectEventSub(): Promise<void> {
    this.eventsubWs = new WebSocket("wss://eventsub.wss.twitch.tv/ws");

    this.eventsubWs.onopen = () => {
      logger.info("[Twitch] EventSub WebSocket connected");
    };

    this.eventsubWs.onmessage = async (event) => {
      await this.handleEventSubMessage(event.data);
    };

    this.eventsubWs.onclose = () => {
      logger.info("[Twitch] EventSub WebSocket closed");
      this.callbacks?.onDisconnect?.();
      // Reconnect after 5 seconds
      setTimeout(() => this.connectEventSub(), 5000);
    };

    this.eventsubWs.onerror = (error) => {
      logger.error("[Twitch] EventSub error:", error);
    };
  }

  private async handleEventSubMessage(data: string): Promise<void> {
    try {
      const msg = JSON.parse(data);
      const type = msg.metadata?.message_type;

      switch (type) {
        case "session_welcome": {
          this.eventsubSessionId = msg.payload.session.id;
          logger.info(`[Twitch] EventSub session: ${this.eventsubSessionId}`);
          // Subscribe to events for each channel
          for (const channel of this.subscribedChannels) {
            await this.subscribeToChannel(channel);
          }
          break;
        }

        case "notification": {
          const eventType = msg.payload?.subscription?.type;
          const eventData = msg.payload?.event || {};
          
          if (eventType === "stream.online" || eventType === "stream.offline") {
            const broadcaster = eventData.broadcaster_user_login as string;
            const wasLive = this.streamStatus.get(broadcaster) || false;
            const isLive = eventType === "stream.online";

            this.streamStatus.set(broadcaster, isLive);

            // Emit message to gateway
            const message: PlatformMessage = {
              id: this.generateMessageId(),
              platform: "twitch",
              channelId: broadcaster,
              userId: broadcaster, // Twitch events don't have a "from" user
              content: isLive
                ? `🎮 ${broadcaster} is now LIVE!`
                : `📴 ${broadcaster} went offline`,
              timestamp: Date.now(),
              metadata: { eventType, wasLive, isLive, stream: eventData },
            };

            this.emitMessage(message);
          }
          break;
        }

        case "session_keepalive":
          // Heartbeat - no action needed
          break;
      }
    } catch (err) {
      logger.error("[Twitch] EventSub parse error:", err);
    }
  }

  private async subscribeToChannel(channel: string): Promise<void> {
    // Get broadcaster ID first
    const userResponse = await fetch(
      `https://api.twitch.tv/helix/users?login=${channel}`,
      { headers: this.getHeaders() }
    );
    const userData = await userResponse.json() as { data: Array<{ id: string; login: string }> };
    const broadcaster = userData.data[0];

    if (!broadcaster) {
      logger.warn(`[Twitch] Channel not found: ${channel}`);
      return;
    }

    // Note: Subscription creation requires webhook transport
    // For WebSocket, events are received if the user has a subscription
    logger.info(`[Twitch] Monitoring channel: ${channel} (${broadcaster.id})`);
  }

  async stop(): Promise<void> {
    if (this.eventsubWs) {
      this.eventsubWs.close();
      this.eventsubWs = null;
    }
    this.eventsubSessionId = null;
    await super.stop();
  }

  async sendMessage(channelId: string, content: string): Promise<string> {
    // Twitch doesn't support chat via API (requires IRC or EventSub Chat)
    // For now, this is a no-op - chat messages must come through EventSub Chat
    logger.warn("[Twitch] sendMessage not supported - use IRC for chat");
    return this.generateMessageId();
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    // Not supported via Helix API
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    // Not supported via Helix API
  }

  async setTyping(channelId: string, isTyping: boolean): Promise<void> {
    // Not supported via Helix API
  }

  async getStatus(): Promise<{ connected: boolean; latency?: number }> {
    return {
      connected: this.eventsubWs?.readyState === WebSocket.OPEN && this.eventsubSessionId !== null,
    };
  }

  // ============ API Methods (for tools) ============

  async getStream(broadcaster: string): Promise<TwitchStream | null> {
    const response = await fetch(
      `https://api.twitch.tv/helix/streams?user_login=${broadcaster}`,
      { headers: this.getHeaders() }
    );
    const data = await response.json() as { data: TwitchStream[] };
    return data.data[0] || null;
  }

  async getUser(login: string): Promise<{ id: string; login: string; display_name: string } | null> {
    const response = await fetch(
      `https://api.twitch.tv/helix/users?login=${login}`,
      { headers: this.getHeaders() }
    );
    const data = await response.json() as { data: Array<{ id: string; login: string; display_name: string }> };
    return data.data[0] || null;
  }

  async createClip(broadcaster: string): Promise<{ url: string; title: string }> {
    // Get broadcaster ID first
    const user = await this.getUser(broadcaster);
    if (!user) throw new Error(`Channel not found: ${broadcaster}`);

    const response = await fetch(
      `https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}`,
      { 
        method: "POST",
        headers: this.getHeaders() 
      }
    );
    const data = await response.json() as { data: Array<{ edit_url: string; title: string }> };
    return { url: data.data[0]?.edit_url || "", title: data.data[0]?.title || "" };
  }

  async getChatSettings(broadcasterId: string): Promise<{
    slow: number;
    follower_delay: number;
    subscriber: boolean;
    emote_mode: boolean;
  }> {
    const response = await fetch(
      `https://api.twitch.tv/helix/chat/settings?broadcaster_id=${broadcasterId}`,
      { headers: this.getHeaders() }
    );
    const data = await response.json() as { data: Array<{
      slow: number;
      follower_delay: number;
      subscriber: boolean;
      emote_mode: boolean;
    }> };
    return data.data[0] || { slow: 0, follower_delay: -1, subscriber: false, emote_mode: false };
  }

  async getModerators(broadcasterId: string): Promise<string[]> {
    const response = await fetch(
      `https://api.twitch.tv/helix/moderation/moderators?broadcaster_id=${broadcasterId}`,
      { headers: this.getHeaders() }
    );
    const data = await response.json() as { data: Array<{ login: string }> };
    return data.data.map(m => m.login);
  }

  getMonitoredChannels(): string[] {
    return Array.from(this.subscribedChannels);
  }

  isChannelLive(channel: string): boolean {
    return this.streamStatus.get(channel.toLowerCase()) || false;
  }
}
