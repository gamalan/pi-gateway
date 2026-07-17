import {
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";

export type DetachedGatewayState =
	| "stopped"
	| "healthy"
	| "initializing"
	| "unavailable";

export interface GatewayStatusState {
	inlineRunning: boolean;
	detachedState: DetachedGatewayState;
	adapterCount: number;
}

export interface GatewayHealth {
	running: boolean;
	mode: "daemon";
	pid: number;
	adapters: string[];
	clients: number;
	sessions: number;
	agent: boolean;
}

export interface GatewayHealthConfig {
	host: string;
	port: number;
	tokens: string[];
}

const DEFAULT_HEALTH_CONFIG: GatewayHealthConfig = {
	host: "localhost",
	port: 3847,
	tokens: [],
};

export interface ResolveGatewayStatusOptions {
	inlineRunning: boolean;
	adapterCount: number;
	daemonProcessRunning: boolean;
	getDaemonHealth: () => Promise<GatewayHealth | null>;
}

export interface GatewayStatusReportOptions {
	inlineRunning: boolean;
	inlineAdapters: number;
	inlineClients: number;
	inlineSessions: number;
	inlineAgentConnected: boolean;
	daemonProcessRunning: boolean;
	daemonHealth: GatewayHealth | null;
}

export interface GatewayStatusReport {
	status: string;
	running: boolean;
	mode:
		| "Inline"
		| "Detached"
		| "Detached initializing"
		| "Detached unavailable"
		| "Stopped";
	adapters: number | null;
	clients: number | null;
	sessions: number | null;
	agentConnected: boolean | null;
}

/** Format the persistent footer status for inline and detached gateway modes. */
export function formatGatewayStatus({
	inlineRunning,
	detachedState,
	adapterCount,
}: GatewayStatusState): string {
	if (inlineRunning) {
		return adapterCount > 0
			? `🟢 Gateway (${adapterCount} platform${adapterCount !== 1 ? "s" : ""})`
			: "🟡 Gateway (waiting)";
	}

	if (detachedState === "healthy") return "🟢 Gateway (daemon)";
	if (detachedState === "initializing") return "🟡 Gateway (daemon starting)";
	if (detachedState === "unavailable") {
		return "🟡 Gateway (daemon unavailable)";
	}
	return "🔴 Gateway";
}

export async function resolveGatewayStatus({
	inlineRunning,
	adapterCount,
	daemonProcessRunning,
	getDaemonHealth,
}: ResolveGatewayStatusOptions): Promise<string> {
	if (inlineRunning || !daemonProcessRunning) {
		return formatGatewayStatus({
			inlineRunning,
			detachedState: "stopped",
			adapterCount,
		});
	}

	const health = await getDaemonHealth();
	return formatGatewayStatus({
		inlineRunning: false,
		detachedState: health
			? health.running
				? "healthy"
				: "initializing"
			: "unavailable",
		adapterCount: 0,
	});
}

export function createGatewayStatusReport({
	inlineRunning,
	inlineAdapters,
	inlineClients,
	inlineSessions,
	inlineAgentConnected,
	daemonProcessRunning,
	daemonHealth,
}: GatewayStatusReportOptions): GatewayStatusReport {
	if (inlineRunning) {
		return {
			status: "Running (Inline)",
			running: true,
			mode: "Inline",
			adapters: inlineAdapters,
			clients: inlineClients,
			sessions: inlineSessions,
			agentConnected: inlineAgentConnected,
		};
	}

	if (daemonProcessRunning && daemonHealth) {
		return {
			status: daemonHealth.running
				? "Running (Detached)"
				: "Initializing (Detached)",
			running: daemonHealth.running,
			mode: daemonHealth.running ? "Detached" : "Detached initializing",
			adapters: daemonHealth.adapters.length,
			clients: daemonHealth.clients,
			sessions: daemonHealth.sessions,
			agentConnected: daemonHealth.agent,
		};
	}

	if (daemonProcessRunning) {
		return {
			status: "Unavailable (detached process detected)",
			running: false,
			mode: "Detached unavailable",
			adapters: null,
			clients: null,
			sessions: null,
			agentConnected: null,
		};
	}

	return {
		status: "Stopped",
		running: false,
		mode: "Stopped",
		adapters: 0,
		clients: 0,
		sessions: 0,
		agentConnected: false,
	};
}

export function parseGatewayPid(rawPid: string): number | null {
	if (!/^[1-9]\d*$/.test(rawPid)) return null;
	const pid = Number(rawPid);
	return Number.isSafeInteger(pid) ? pid : null;
}

export function writeGatewayPidFile(pidFile: string, pid: number): void {
	if (parseGatewayPid(String(pid)) !== pid) {
		throw new Error(`Invalid gateway PID: ${pid}`);
	}
	mkdirSync(dirname(pidFile), { recursive: true });
	writeFileSync(pidFile, String(pid), { flag: "wx" });
}

export function removeGatewayPidFile(pidFile: string, expectedPid: number): boolean {
	try {
		const currentPid = parseGatewayPid(readFileSync(pidFile, "utf-8").trim());
		if (currentPid !== expectedPid) return false;
		unlinkSync(pidFile);
		return true;
	} catch {
		return false;
	}
}

export function normalizeGatewayHost(host: unknown): string | null {
	if (typeof host !== "string" || host === "" || host.trim() !== host) return null;
	const unwrapped =
		host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (isIP(unwrapped) !== 0) return unwrapped;
	if (unwrapped.length > 253) return null;
	const labels = unwrapped.split(".");
	if (
		labels.some(
			(label) =>
				!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
		)
	) {
		return null;
	}
	return unwrapped;
}

export function normalizeGatewayHealthConfig(
	value: unknown,
): GatewayHealthConfig | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = {
		...DEFAULT_HEALTH_CONFIG,
		...(value as Partial<GatewayHealthConfig>),
	};
	const host = normalizeGatewayHost(candidate.host);
	if (
		host === null ||
		!Number.isInteger(candidate.port) ||
		candidate.port < 1 ||
		candidate.port > 65535 ||
		!Array.isArray(candidate.tokens) ||
		!candidate.tokens.every((token) => typeof token === "string")
	) {
		return null;
	}
	return { ...candidate, host };
}

export function buildGatewayHealthUrl(host: string, port: number): string {
	const reachableHost =
		host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
	const urlHost =
		reachableHost.includes(":") && !reachableHost.startsWith("[")
			? `[${reachableHost}]`
			: reachableHost;
	return `http://${urlHost}:${port}/api/status`;
}

export async function waitForGatewayHealth(
	config: GatewayHealthConfig,
	expectedPid: number,
	timeoutMs = 3000,
	pollIntervalMs = 100,
): Promise<GatewayHealth | null> {
	const deadline = Date.now() + timeoutMs;
	do {
		const health = await fetchGatewayHealth(config, expectedPid);
		if (health) return health;
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	} while (Date.now() < deadline);
	return null;
}

export async function fetchGatewayHealth(
	config: GatewayHealthConfig,
	expectedPid: number,
	fetchStatus: typeof fetch = fetch,
): Promise<GatewayHealth | null> {
	try {
		const response = await fetchStatus(
			buildGatewayHealthUrl(config.host, config.port),
			{
				headers:
					config.tokens.length > 0
						? { Authorization: `Bearer ${config.tokens[0]}` }
						: undefined,
				signal: AbortSignal.timeout(1000),
			},
		);
		if (!response.ok) return null;

		const health = (await response.json()) as Partial<GatewayHealth>;
		if (
			typeof health.running !== "boolean" ||
			health.mode !== "daemon" ||
			health.pid !== expectedPid ||
			parseGatewayPid(String(health.pid)) !== expectedPid ||
			!Array.isArray(health.adapters) ||
			!health.adapters.every((adapter) => typeof adapter === "string") ||
			typeof health.clients !== "number" ||
			!Number.isInteger(health.clients) ||
			health.clients < 0 ||
			typeof health.sessions !== "number" ||
			!Number.isInteger(health.sessions) ||
			health.sessions < 0 ||
			typeof health.agent !== "boolean"
		) {
			return null;
		}
		return {
			running: health.running,
			mode: "daemon",
			pid: expectedPid,
			adapters: health.adapters,
			clients: health.clients,
			sessions: health.sessions,
			agent: health.agent,
		};
	} catch {
		return null;
	}
}
