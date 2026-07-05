/**
 * pi-gateway - Hermes-style Messaging Gateway
 *
 * Architecture:
 * - Single background process
 * - Platform adapters (Discord, Telegram, etc.)
 * - Per-chat session management
 * - Background task support
 * - Security (allowlists, pairing)
 *
 * Usage:
 *   /gateway start [port]    - Start the gateway
 *   /gateway stop           - Stop the gateway
 *   /gateway status         - Show status
 *   /gateway pair <code>    - Approve pairing code
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes, createHmac } from "node:crypto";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
	initSessionStore,
	getOrCreateSession,
	listSessions,
	touchSession,
	type SessionConfig,
} from "./sessions/store.js";
import {
	initSecurityStore,
	isUserAllowed,
	approvePairingCode,
	generatePairingCode,
	listPendingPairingCodes,
	addToAllowlist,
	listAllowlistedUsers,
	type Platform,
} from "./security/auth.js";
import {
	initBackgroundTasks,
	startBackgroundTask,
	getPendingResultsForSession,
	markTaskDelivered,
	listTasks,
	type BackgroundTask,
} from "./background/manager.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { TwitchAdapter } from "./adapters/twitch.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import { SlackAdapter } from "./adapters/slack.js";
import { WhatsAppAdapter } from "./adapters/whatsapp.js";
import type {
	BaseAdapter,
	AdapterCallbacks,
	PlatformMessage,
} from "./adapters/base.js";

const KOBOLD_DIR = join(homedir(), ".0xkobold");
const CONFIG_DIR = join(KOBOLD_DIR, "gateway");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// Types
interface GatewayConfig {
	port: number;
	host: string;
	tokens: string[];
	corsOrigins: string[];
	enableWebSocket: boolean;
	enableHttp: boolean;
	security: {
		allowAll: boolean;
		requirePairing: boolean;
		allowedUids: Record<string, string[]>;
	};
	sessions: {
		resetPolicy: "daily" | "idle" | "both";
		dailyHour: number;
		idleMinutes: number;
	};
	platforms: {
		discord?: {
			enabled: boolean;
			botToken: string;
			guildId?: string;
		};
		twitch?: {
			enabled: boolean;
			clientId: string;
			clientSecret: string;
			channels?: string[];
		};
		telegram?: {
			enabled: boolean;
			token: string;
			mode?: "polling" | "webhook";
			webhookUrl?: string;
		};
		slack?: {
			enabled: boolean;
			webhookUrl?: string;
			botToken?: string;
		};
		whatsapp?: {
			enabled: boolean;
			sessionPath?: string;
			printQr?: boolean;
		};
	};
}

interface GatewayState {
	running: boolean;
	adapters: Map<string, BaseAdapter>;
	clients: Map<string, WebSocket>;
	sessions: Map<string, SessionConfig>;
}

const DEFAULT_CONFIG: GatewayConfig = {
	port: 3847,
	host: "localhost",
	tokens: [],
	corsOrigins: ["*"],
	enableWebSocket: true,
	enableHttp: true,
	security: {
		allowAll: true,
		requirePairing: false,
		allowedUids: {},
	},
	sessions: {
		resetPolicy: "idle",
		dailyHour: 4,
		idleMinutes: 1440,
	},
	platforms: {},
};

let config: GatewayConfig;
let state: GatewayState;
let server: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;
let globalCtx: ExtensionContext | null = null;
let rpcProcess: any = null;
let cronInterval: ReturnType<typeof setInterval> | null = null;

// Pending RPC requests
interface PendingRequest {
	id: string;
	resolve: (msg: unknown) => void;
	reject: (err: Error) => void;
}
const pendingRequests: PendingRequest[] = [];

// Load/save config
function loadConfig(): GatewayConfig {
	try {
		if (existsSync(CONFIG_FILE)) {
			return {
				...DEFAULT_CONFIG,
				...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")),
			};
		}
	} catch {
		/* ignore */
	}
	return { ...DEFAULT_CONFIG };
}

function saveConfig(): void {
	try {
		if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
	} catch {
		/* ignore */
	}
}

// Token auth
function verifyToken(token: string): boolean {
	if (config.tokens.length === 0) return true;
	return config.tokens.includes(token);
}

function authenticate(req: IncomingMessage): boolean {
	const auth = req.headers.authorization;
	if (!auth) return verifyToken("");
	if (auth.startsWith("Bearer ")) return verifyToken(auth.slice(7));
	return false;
}

// WebSocket helpers
function sendWs(ws: WebSocket, msg: object): void {
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(msg));
	}
}

function broadcastClients(event: string, data: unknown): void {
	for (const ws of state.clients.values()) {
		sendWs(ws, { type: event, data });
	}
}

function broadcastPlatform(
	platform: string,
	event: string,
	data: unknown,
): void {
	for (const [clientId, ws] of state.clients) {
		// Get client's session to check platform
		const session = Array.from(state.sessions.values()).find(
			(s) => s.userId === clientId,
		);
		if (session?.platform === platform) {
			sendWs(ws, { type: event, data });
		}
	}
}

// RPC to pi agent
function createRpcProcess(): any {
	const { spawn } = require("node:child_process");

	const proc = spawn("pi", ["--mode", "rpc", "--json"], {
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			OLLAMA_HOST: process.env.OLLAMA_HOST || "localhost:11434",
		},
	});

	proc.stdout?.on("data", (data: Buffer) => {
		const lines = data.toString().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const msg = JSON.parse(line);

				if (msg.id) {
					const idx = pendingRequests.findIndex((r) => r.id === msg.id);
					if (idx !== -1) {
						const req = pendingRequests.splice(idx, 1)[0];
						req.resolve(msg);
					}
				}

				// Broadcast events
				if (msg.type === "response") {
					broadcastClients("response", msg);
				} else {
					broadcastClients("event", msg);
				}
			} catch {
				/* not JSON */
			}
		}
	});

	proc.stderr?.on("data", (data: Buffer) => {
		console.error("[gateway] pi stderr:", data.toString());
	});

	proc.on("exit", (code: number) => {
		console.log("[gateway] pi process exited");
		rpcProcess = null;
		broadcastClients("agent_disconnected", { code });
	});

	return proc;
}

async function sendRpc(
	command: string,
	data: Record<string, unknown> = {},
): Promise<unknown> {
	if (!rpcProcess) throw new Error("pi agent not running");

	const id = randomBytes(8).toString("hex");
	const payload = { id, type: command, ...data };

	return new Promise((resolve, reject) => {
		pendingRequests.push({ id, resolve, reject });

		try {
			rpcProcess.stdin.write(JSON.stringify(payload) + "\n");
		} catch (err) {
			const idx = pendingRequests.findIndex((r) => r.id === id);
			if (idx !== -1) pendingRequests.splice(idx, 1);
			reject(err);
		}

		setTimeout(() => {
			const idx = pendingRequests.findIndex((r) => r.id === id);
			if (idx !== -1) {
				pendingRequests.splice(idx, 1);
				reject(new Error("Request timeout"));
			}
		}, 30000);
	});
}

// Platform adapter callbacks
const adapterCallbacks: AdapterCallbacks = {
	onMessage: async (message: PlatformMessage) => {
		// Get or create session for this chat
		const session = getOrCreateSession(
			message.platform,
			message.channelId,
			message.userId,
			{
				resetPolicy: config.sessions.resetPolicy,
				dailyHour: config.sessions.dailyHour,
				idleMinutes: config.sessions.idleMinutes,
			},
		);

		// Check allowlist
		if (!isUserAllowed(message.platform as Platform, message.userId)) {
			console.log(`[gateway] User ${message.userId} not in allowlist`);
			// Could send a DM here about pairing flow
			return;
		}

		// Store session reference
		state.sessions.set(`${message.platform}:${message.channelId}`, session);

		// Send to pi agent
		if (rpcProcess) {
			await sendRpc("prompt", {
				message: message.content,
				sessionId: session.id,
			});
		}
	},
	onDisconnect: () => {
		console.log("[gateway] Platform adapter disconnected");
		updateStatus();
	},
};

// Initialize platform adapters
async function initializeAdapters(): Promise<void> {
	// Discord
	if (config.platforms.discord?.enabled && config.platforms.discord.botToken) {
		try {
			const discord = new DiscordAdapter({
				enabled: true,
				platform: "discord",
				botToken: config.platforms.discord.botToken,
				guildId: config.platforms.discord.guildId,
			});
			await discord.initialize();
			await discord.start(adapterCallbacks);
			state.adapters.set("discord", discord);
			console.log("[gateway] Discord adapter started");
		} catch (err) {
			console.error("[gateway] Failed to start Discord adapter:", err);
		}
	}

	// Twitch
	if (
		config.platforms.twitch?.enabled &&
		config.platforms.twitch.clientId &&
		config.platforms.twitch.clientSecret
	) {
		try {
			const twitch = new TwitchAdapter({
				enabled: true,
				platform: "twitch",
				clientId: config.platforms.twitch.clientId,
				clientSecret: config.platforms.twitch.clientSecret,
				channels: config.platforms.twitch.channels,
			});
			await twitch.initialize();
			await twitch.start(adapterCallbacks);
			state.adapters.set("twitch", twitch);
			console.log("[gateway] Twitch adapter started");
		} catch (err) {
			console.error("[gateway] Failed to start Twitch adapter:", err);
		}
	}

	// Telegram
	if (config.platforms.telegram?.enabled && config.platforms.telegram.token) {
		try {
			const telegram = new TelegramAdapter({
				enabled: true,
				platform: "telegram",
				token: config.platforms.telegram.token,
				mode: config.platforms.telegram.mode,
				webhookUrl: config.platforms.telegram.webhookUrl,
			});
			await telegram.initialize();
			await telegram.start(adapterCallbacks);
			state.adapters.set("telegram", telegram);
			console.log("[gateway] Telegram adapter started");
		} catch (err) {
			console.error("[gateway] Failed to start Telegram adapter:", err);
		}
	}

	// Slack
	if (
		config.platforms.slack?.enabled &&
		(config.platforms.slack.webhookUrl || config.platforms.slack.botToken)
	) {
		try {
			const slack = new SlackAdapter({
				enabled: true,
				platform: "slack",
				webhookUrl: config.platforms.slack.webhookUrl,
				botToken: config.platforms.slack.botToken,
			});
			await slack.initialize();
			await slack.start(adapterCallbacks);
			state.adapters.set("slack", slack);
			console.log("[gateway] Slack adapter started");
		} catch (err) {
			console.error("[gateway] Failed to start Slack adapter:", err);
		}
	}

	// WhatsApp
	if (config.platforms.whatsapp?.enabled) {
		try {
			const whatsapp = new WhatsAppAdapter({
				enabled: true,
				platform: "whatsapp",
				sessionPath: config.platforms.whatsapp.sessionPath,
				printQr: config.platforms.whatsapp.printQr,
			});
			await whatsapp.initialize();
			await whatsapp.start(adapterCallbacks);
			state.adapters.set("whatsapp", whatsapp);
			console.log("[gateway] WhatsApp adapter started");
		} catch (err) {
			console.error("[gateway] Failed to start WhatsApp adapter:", err);
		}
	}
}

// Cron job for background tasks and session cleanup
function startCron(): void {
	cronInterval = setInterval(async () => {
		// Check for pending background results
		for (const session of state.sessions.values()) {
			const pending = getPendingResultsForSession(session.id);
			for (const task of pending) {
				// Deliver result to user via their platform
				const adapter = state.adapters.get(session.platform);
				if (adapter) {
					const resultText =
						task.status === "completed"
							? `✅ Background task completed:\n\`\`\`\n${JSON.stringify(task.result, null, 2)}\n\`\`\``
							: `❌ Background task failed:\n\`\`\`\n${task.error}\n\`\`\``;

					await adapter.sendMessage(session.channelId, resultText);
					markTaskDelivered(task.id);
				}
			}
		}

		// Touch active sessions
		for (const session of state.sessions.values()) {
			touchSession(session.id);
		}
	}, 60000); // Every 60 seconds (Hermes-style)
}

function stopCron(): void {
	if (cronInterval) {
		clearInterval(cronInterval);
		cronInterval = null;
	}
}

// HTTP handlers
async function handleHttpRequest(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	res.setHeader(
		"Access-Control-Allow-Origin",
		config.corsOrigins.join(",") || "*",
	);
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	if (!authenticate(req)) {
		res.writeHead(401);
		res.end(JSON.stringify({ error: "Unauthorized" }));
		return;
	}

	const url = new URL(req.url || "/", `http://${req.headers.host}`);

	// API endpoints
	if (url.pathname === "/api/status" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				running: state.running,
				adapters: Array.from(state.adapters.keys()),
				clients: state.clients.size,
				sessions: state.sessions.size,
				agent: rpcProcess !== null,
			}),
		);
		return;
	}

	if (url.pathname === "/api/sessions" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(listSessions()));
		return;
	}

	if (url.pathname === "/api/background" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(listTasks()));
		return;
	}

	if (url.pathname === "/api/allowlist" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(listAllowlistedUsers()));
		return;
	}

	if (url.pathname === "/api/pairing" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(listPendingPairingCodes()));
		return;
	}

	res.writeHead(404);
	res.end(JSON.stringify({ error: "Not found" }));
}

// WebSocket handler
function handleWebSocket(ws: WebSocket, req: IncomingMessage): void {
	if (!authenticate(req)) {
		ws.close(1008, "Unauthorized");
		return;
	}

	const clientId = randomBytes(8).toString("hex");
	state.clients.set(clientId, ws);

	console.log(`[gateway] WebSocket client connected: ${clientId}`);

	sendWs(ws, { type: "connected", data: { clientId } });

	ws.on("message", async (data) => {
		try {
			const msg = JSON.parse(data.toString());

			switch (msg.type) {
				case "prompt": {
					const result = await sendRpc("prompt", {
						message: msg.data?.message || "",
					});
					sendWs(ws, { type: "response", id: msg.id, data: result });
					break;
				}
				case "background": {
					const task = startBackgroundTask(
						msg.data?.sessionId || "default",
						msg.data?.command || "",
					);
					sendWs(ws, { type: "background_started", data: task });
					break;
				}
				case "ping": {
					sendWs(ws, { type: "pong", data: { time: Date.now() } });
					break;
				}
			}
		} catch (err) {
			sendWs(ws, { type: "error", data: { error: String(err) } });
		}
	});

	ws.on("close", () => {
		state.clients.delete(clientId);
		console.log(`[gateway] WebSocket client disconnected: ${clientId}`);
	});
}

// Status update
function updateStatus(): void {
	if (!globalCtx) return;

	const adapterCount = state.adapters.size;
	const clientCount = state.clients.size;

	const statusText = state.running
		? adapterCount > 0
			? `🟢 Gateway (${adapterCount} platform${adapterCount !== 1 ? "s" : ""})`
			: `🟡 Gateway (waiting)`
		: "🔴 Gateway";

	globalCtx.ui.setStatus("gateway", statusText);
}

export default function (pi: ExtensionAPI) {
	config = loadConfig();
	state = {
		running: false,
		adapters: new Map(),
		clients: new Map(),
		sessions: new Map(),
	};

	// Initialize stores
	initSessionStore();
	initSecurityStore();
	initBackgroundTasks();

	// Register commands
	pi.registerCommand("gateway", {
		description: "Manage Hermes-style messaging gateway",
		getArgumentCompletions: (prefix: string) => {
			const cmds = [
				"start",
				"stop",
				"status",
				"restart",
				"pair",
				"allow",
				"sessions",
				"tasks",
				"config",
			];
			return cmds
				.filter((c) => c.startsWith(prefix))
				.map((c) => ({ value: c, label: c }));
		},
		handler: async (args, ctx) => {
			const parts = args.split(/\s+/).filter(Boolean);
			const subcmd = parts[0]?.toLowerCase();

			switch (subcmd) {
				case "start": {
					if (state.running) {
						ctx.ui.notify("Gateway already running", "info");
						return;
					}

					const port = parseInt(parts[1]) || config.port;

					// Start HTTP server
					server = createServer(handleHttpRequest);

					if (config.enableWebSocket) {
						wss = new WebSocketServer({ server });
						wss.on("connection", handleWebSocket);
					}

					server.listen(port, config.host, () => {
						console.log(
							`[gateway] HTTP server started on ${config.host}:${port}`,
						);
					});

					// Start pi agent
					rpcProcess = createRpcProcess();

					// Initialize platform adapters
					await initializeAdapters();

					// Start cron
					startCron();

					state.running = true;
					updateStatus();

					ctx.ui.notify(
						`✅ Gateway started on http://${config.host}:${port}\n\n` +
							`Platforms: ${state.adapters.size > 0 ? Array.from(state.adapters.keys()).join(", ") : "none"}\n` +
							`Sessions: Idle reset every ${config.sessions.idleMinutes} min`,
						"info",
					);
					return;
				}

				case "stop": {
					if (!state.running) {
						ctx.ui.notify("Gateway not running", "info");
						return;
					}

					// Stop adapters
					for (const adapter of state.adapters.values()) {
						await adapter.stop();
					}
					state.adapters.clear();

					// Stop cron
					stopCron();

					// Close WebSocket clients
					for (const ws of state.clients.values()) {
						ws.close(1000, "Server shutting down");
					}
					state.clients.clear();

					// Stop HTTP server
					server?.close();
					server = null;
					wss = null;

					// Kill pi process
					if (rpcProcess) {
						rpcProcess.kill();
						rpcProcess = null;
					}

					state.running = false;
					updateStatus();

					ctx.ui.notify("Gateway stopped", "info");
					return;
				}

				case "status": {
					const lines: string[] = [];
					lines.push(`Status: ${state.running ? "🟢 Running" : "🔴 Stopped"}`);
					lines.push(`Port: ${config.port}`);
					lines.push(`Adapters: ${state.adapters.size}`);
					lines.push(`Clients: ${state.clients.size}`);
					lines.push(`Sessions: ${state.sessions.size}`);
					lines.push(
						`Agent: ${rpcProcess ? "✅ Connected" : "❌ Disconnected"}`,
					);
					lines.push("");
					lines.push(`Session Reset: ${config.sessions.resetPolicy}`);
					lines.push(`  - Daily at ${config.sessions.dailyHour}:00`);
					lines.push(`  - Idle after ${config.sessions.idleMinutes} min`);
					lines.push("");
					lines.push(
						`Security: ${config.security.allowAll ? "Allow all" : "Allowlist only"}${Object.values(config.security.allowedUids ?? {}).reduce((sum, uids) => sum + uids.length, 0) > 0 ? ` (+${Object.values(config.security.allowedUids ?? {}).reduce((sum, uids) => sum + uids.length, 0)} config UIDs)` : ""}`,
					);

					ctx.ui.setWidget("gateway-status", lines, {
						placement: "belowEditor",
					});
					setTimeout(
						() => ctx.ui.setWidget("gateway-status", undefined),
						15000,
					);
					return;
				}

				case "pair": {
					const code = parts[1]?.toUpperCase();
					if (!code) {
						const pending = listPendingPairingCodes();
						ctx.ui.notify(
							"Pending pairing codes:\n" +
								(pending.length > 0
									? pending
											.map(
												(p) =>
													`${p.code} - ${p.platform} (${Math.round(p.expiresIn / 60000)}min)`,
											)
											.join("\n")
									: "None"),
							"info",
						);
						return;
					}

					if (approvePairingCode(code)) {
						ctx.ui.notify("Pairing code approved", "info");
					} else {
						ctx.ui.notify(`❌ Invalid or expired pairing code`, "error");
					}
					return;
				}

				case "allow": {
					const platform = parts[1] as Platform;
					const userId = parts[2];
					if (!platform || !userId) {
						const list = listAllowlistedUsers();
						const configUids = config.security.allowedUids ?? {};
						const configLines: string[] = [];
						for (const [plat, uids] of Object.entries(configUids)) {
							for (const uid of uids) {
								configLines.push(`${plat}:${uid} (config)`);
							}
						}
						ctx.ui.notify(
							"Allowlisted users:\n" +
								(list.length > 0 || configLines.length > 0
									? [
											...list.map((u) => `${u.platform}:${u.userId}`),
											...configLines,
										].join("\n")
									: "None"),
							"info",
						);
						return;
					}

					addToAllowlist(platform, userId);
					ctx.ui.notify(`Added ${userId} to allowlist`, "info");
					return;
				}

				case "sessions": {
					const sessions = listSessions();
					ctx.ui.notify(
						"Active sessions:\n" +
							sessions
								.slice(0, 10)
								.map(
									(s) =>
										`${s.platform}:${s.channelId} (${s.id.slice(0, 8)}...)`,
								)
								.join("\n"),
						"info",
					);
					return;
				}

				case "tasks": {
					const tasks = listTasks();
					ctx.ui.notify(
						"Background tasks:\n" +
							tasks
								.slice(0, 10)
								.map(
									(t) =>
										`${t.id.slice(0, 12)}... - ${t.status} (${t.progress}%)`,
								)
								.join("\n"),
						"info",
					);
					return;
				}

				case "config": {
					const configUidCount2 = Object.values(
						config.security.allowedUids ?? {},
					).reduce((sum, uids) => sum + uids.length, 0);
					ctx.ui.notify(
						`Gateway Config:\n\n` +
							`Port: ${config.port}\n` +
							`Sessions: ${config.sessions.resetPolicy}\n` +
							`Security: ${config.security.allowAll ? "Allow all" : "Allowlist"}` +
							` (${configUidCount2} config UIDs)\n` +
							`Discord: ${config.platforms.discord?.enabled ? "Enabled" : "Disabled"}`,
						"info",
					);
					return;
				}

				default: {
					ctx.ui.notify(
						"pi Gateway Commands:\n\n" +
							"  /gateway start [port]  - Start gateway\n" +
							"  /gateway stop         - Stop gateway\n" +
							"  /gateway restart      - Restart gateway\n" +
							"  /gateway status       - Show status\n" +
							"  /gateway pair <code>  - Approve pairing\n" +
							"  /gateway allow <p> <u>- Add user to allowlist\n" +
							"  /gateway sessions     - List sessions\n" +
							"  /gateway tasks        - List background tasks\n" +
							"  /gateway config       - Show config\n\n" +
							"Hermes-style features:\n" +
							"  - Per-chat sessions with reset policies\n" +
							"  - Platform adapters (Discord, etc.)\n" +
							"  - Background task support\n" +
							"  - Allowlist security (DB + config UIDs)",
						"info",
					);
				}
			}
		},
	});

	// Register tools
	pi.registerTool({
		name: "gateway_status",
		label: "Gateway Status",
		description: "Check Hermes-style gateway status",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			return {
				content: [
					{
						type: "text",
						text:
							`Gateway: ${state.running ? "Running" : "Stopped"}\n` +
							`Adapters: ${state.adapters.size}\n` +
							`Clients: ${state.clients.size}\n` +
							`Sessions: ${state.sessions.size}\n` +
							`Agent: ${rpcProcess ? "Connected" : "Disconnected"}`,
					},
				],
				details: {
					running: state.running,
					adapters: state.adapters.size,
					clients: state.clients.size,
					sessions: state.sessions.size,
				},
			};
		},
	});

	pi.registerTool({
		name: "gateway_sessions",
		label: "Gateway Sessions",
		description: "List active gateway sessions",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const sessions = listSessions();
			return {
				content: [
					{
						type: "text",
						text:
							`Active sessions: ${sessions.length}\n` +
							JSON.stringify(
								sessions.map((s) => ({
									id: s.id.slice(0, 12),
									platform: s.platform,
									channel: s.channelId,
									lastActivity: new Date(s.lastActivity).toISOString(),
								})),
								null,
								2,
							),
					},
				],
				details: { count: sessions.length },
			};
		},
	});

	pi.registerTool({
		name: "gateway_background_tasks",
		label: "Background Tasks",
		description: "List and manage background tasks",
		parameters: Type.Object({
			status: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const tasks = listTasks(params.status as any);
			return {
				content: [
					{
						type: "text",
						text:
							`Background tasks: ${tasks.length}\n` +
							JSON.stringify(
								tasks.map((t) => ({
									id: t.id.slice(0, 12),
									status: t.status,
									progress: t.progress,
									command: t.command.slice(0, 50),
								})),
								null,
								2,
							),
					},
				],
				details: { count: tasks.length },
			};
		},
	});

	pi.registerTool({
		name: "gateway_pairing",
		label: "Gateway Pairing",
		description: "Generate or approve pairing codes",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("generate"),
				Type.Literal("list"),
				Type.Literal("approve"),
			]),
			platform: Type.Optional(Type.String()),
			userId: Type.Optional(Type.String()),
			code: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { action, platform, userId, code } = params;
			switch (action) {
				case "generate": {
					if (!platform || !userId) {
						return {
							content: [{ type: "text", text: "platform and userId required" }],
							details: { error: true },
						};
					}
					const pairingCode = generatePairingCode(platform as Platform, userId);
					return {
						content: [
							{
								type: "text",
								text: `Pairing code: ${pairingCode}\n\nShare this code with the user to approve access.`,
							},
						],
						details: { code: pairingCode },
					};
				}
				case "approve": {
					if (!code) {
						return {
							content: [{ type: "text", text: "code required" }],
							details: { error: true },
						};
					}
					const success = approvePairingCode(code);
					return {
						content: [
							{
								type: "text",
								text: success ? "✅ Code approved" : "❌ Invalid/expired",
							},
						],
						details: { success },
					};
				}
				case "list": {
					const pending = listPendingPairingCodes();
					return {
						content: [
							{
								type: "text",
								text:
									`Pending codes: ${pending.length}\n` +
									JSON.stringify(pending, null, 2),
							},
						],
						details: { count: pending.length },
					};
				}
			}
		},
	});

	// Notify on session start
	pi.on("session_start", async (_event, ctx) => {
		globalCtx = ctx;
		updateStatus();
	});

	console.log("[pi-gateway] Hermes-style gateway extension loaded");
}
