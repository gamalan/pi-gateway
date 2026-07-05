/**
 * WhatsApp Adapter - Hermes-style WhatsApp platform adapter
 * 
 * Features:
 * - WhatsApp Web protocol via Baileys
 * - QR code authentication
 * - Contact and group management
 * - Media messaging
 */

import { BaseAdapter, type PlatformMessage, type PlatformConfig } from "./base.js";
import { logger } from "../logger.js";

export interface WhatsAppConfig extends PlatformConfig {
  platform: "whatsapp";
  sessionPath?: string;
  printQr?: boolean;  // Print QR to console
  maxMessageLength?: number;
}

interface WhatsAppContact {
  id: string;
  name?: string;
  isGroup: boolean;
}

export class WhatsAppAdapter extends BaseAdapter {
  readonly platform = "whatsapp" as const;
  config: WhatsAppConfig;
  
  private sock: any = null;
  private connected = false;
  private qrCode: string | null = null;

  constructor(config: WhatsAppConfig) {
    super();
    this.config = {
      enabled: true,
      platform: "whatsapp",
      sessionPath: "./whatsapp-session",
      printQr: true,
      maxMessageLength: 4096,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    try {
      const baileys = await import("@whiskeysockets/baileys");
      
      const { state, saveCreds } = await baileys.useMultiFileAuthState(this.config.sessionPath || "./whatsapp-session");
      
      this.sock = baileys.makeWASocket({
        auth: state,
        printQRInTerminal: this.config.printQr,
        defaultQueryTimeoutMs: 60 * 1000,
      });

      // Handle QR code
      this.sock.ev.on("qr", (qr: string) => {
        this.qrCode = qr;
        logger.info("[WhatsApp] QR Code received - scan with WhatsApp app");
        logger.info(qr);
      });

      // Handle connection update
      this.sock.ev.on("connection.update", ({ qr, connection }: any) => {
        if (qr) {
          this.qrCode = qr;
        }
        if (connection === "open") {
          this.connected = true;
          this.qrCode = null;
          logger.info("[WhatsApp] Connected!");
        }
        if (connection === "close") {
          this.connected = false;
          logger.info("[WhatsApp] Disconnected");
        }
      });

      // Handle credentials update
      this.sock.ev.on("creds.update", saveCreds);

      // Handle messages
      this.sock.ev.on("messages.upsert", ({ messages }: any) => {
        this.handleMessages(messages);
      });

      logger.info("[WhatsApp] Initializing...");
    } catch (err) {
      logger.error("[WhatsApp] Failed to initialize:", err);
      throw err;
    }
  }

  private handleMessages(messages: any[]): void {
    for (const msg of messages) {
      // Skip messages sent by us
      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      const isGroup = jid?.endsWith("@g.us");
      
      // Get message content
      const content = 
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        "";

      if (!content) continue;

      const message: PlatformMessage = {
        id: msg.key.id || this.generateMessageId(),
        platform: "whatsapp",
        channelId: jid,
        userId: msg.key.participant || jid,
        content,
        timestamp: msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now(),
        metadata: {
          isGroup,
          messageType: msg.message ? Object.keys(msg.message)[0] : "unknown",
          pushName: msg.pushName,
        },
      };

      this.emitMessage(message);
    }
  }

  async start(callbacks): Promise<void> {
    await super.start(callbacks);
    
    // Wait for connection
    let attempts = 0;
    while (!this.connected && attempts < 30) {
      await this.sleep(1000);
      attempts++;
    }

    if (!this.connected) {
      logger.warn("[WhatsApp] Not yet connected - waiting for QR scan");
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async stop(): Promise<void> {
    if (this.sock) {
      await this.sock.logout();
      this.sock = null;
    }
    this.connected = false;
    await super.stop();
  }

  async sendMessage(channelId: string, content: string): Promise<string> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    // Truncate if too long
    const text = content.length > (this.config.maxMessageLength || 4096)
      ? content.slice(0, this.config.maxMessageLength - 3) + "..."
      : content;

    try {
      const result = await this.sock.sendMessage(channelId, { text });
      return result?.key?.id || this.generateMessageId();
    } catch (err) {
      logger.error("[WhatsApp] Send error:", err);
      throw err;
    }
  }

  async sendImage(channelId: string, imageUrl: string, caption?: string): Promise<string> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    try {
      const result = await this.sock.sendMessage(channelId, {
        image: { url: imageUrl },
        caption,
      });
      return result?.key?.id || this.generateMessageId();
    } catch (err) {
      logger.error("[WhatsApp] Send image error:", err);
      throw err;
    }
  }

  async sendReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    try {
      await this.sock.sendMessage(channelId, {
        react: { text: emoji, key: { remoteJid: channelId, id: messageId } },
      });
    } catch (err) {
      logger.error("[WhatsApp] Reaction error:", err);
    }
  }

  async reply(channelId: string, content: string, messageId: string): Promise<string> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    try {
      const result = await this.sock.sendMessage(channelId, {
        text: content,
        contextInfo: {
          stanzaId: messageId,
          remoteJid: channelId,
        },
      });
      return result?.key?.id || this.generateMessageId();
    } catch (err) {
      logger.error("[WhatsApp] Reply error:", err);
      throw err;
    }
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    try {
      await this.sock.relayMessage(channelId, {
        protocolMessage: {
          type: 6, // MESSAGE_EDIT
          key: { remoteJid: channelId, id: messageId },
          editedMessage: { conversation: [{ text: content }] },
        },
      }, {});
    } catch (err) {
      logger.error("[WhatsApp] Edit error:", err);
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    try {
      await this.sock.sendMessage(channelId, {
        delete: { remoteJid: channelId, id: messageId },
      });
    } catch (err) {
      logger.error("[WhatsApp] Delete error:", err);
    }
  }

  async setTyping(channelId: string, isTyping: boolean): Promise<void> {
    if (!this.sock || !this.connected) return;

    try {
      await this.sock.sendPresenceUpdate(isTyping ? "composing" : "available", channelId);
    } catch (err) {
      // Ignore presence errors
    }
  }

  async getStatus(): Promise<{ connected: boolean; latency?: number }> {
    return { connected: this.connected };
  }

  async getContacts(): Promise<WhatsAppContact[]> {
    if (!this.sock?.store?.contacts) {
      return [];
    }

    return Object.entries(this.sock.store.contacts).map(([id, contact]: [string, any]) => ({
      id,
      name: contact?.name || contact?.notify || id.split("@")[0],
      isGroup: id.endsWith("@g.us"),
    }));
  }

  async getContact(jid: string): Promise<WhatsAppContact | null> {
    const contacts = await this.getContacts();
    return contacts.find(c => c.id === jid) || null;
  }

  getQrCode(): string | null {
    return this.qrCode;
  }
}
