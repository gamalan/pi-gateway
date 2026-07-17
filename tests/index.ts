import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildGatewayHealthUrl,
	createGatewayStatusReport,
	fetchGatewayHealth,
	formatGatewayStatus,
	normalizeGatewayHealthConfig,
	normalizeGatewayHost,
	parseGatewayPid,
	removeGatewayPidFile,
	resolveGatewayStatus,
	writeGatewayPidFile,
	type GatewayHealth,
} from "../src/status.js";

const healthyDaemon: GatewayHealth = {
	running: true,
	mode: "daemon",
	pid: 4242,
	adapters: ["telegram"],
	clients: 2,
	sessions: 3,
	agent: true,
};

assert.equal(
	formatGatewayStatus({
		inlineRunning: false,
		detachedState: "stopped",
		adapterCount: 0,
	}),
	"🔴 Gateway",
);
assert.equal(
	formatGatewayStatus({
		inlineRunning: false,
		detachedState: "healthy",
		adapterCount: 0,
	}),
	"🟢 Gateway (daemon)",
);
assert.equal(
	formatGatewayStatus({
		inlineRunning: false,
		detachedState: "initializing",
		adapterCount: 0,
	}),
	"🟡 Gateway (daemon starting)",
);
assert.equal(
	formatGatewayStatus({
		inlineRunning: false,
		detachedState: "unavailable",
		adapterCount: 0,
	}),
	"🟡 Gateway (daemon unavailable)",
);
assert.equal(
	formatGatewayStatus({
		inlineRunning: true,
		detachedState: "healthy",
		adapterCount: 0,
	}),
	"🟡 Gateway (waiting)",
);
assert.equal(
	formatGatewayStatus({
		inlineRunning: true,
		detachedState: "healthy",
		adapterCount: 1,
	}),
	"🟢 Gateway (1 platform)",
);
assert.equal(
	formatGatewayStatus({
		inlineRunning: true,
		detachedState: "healthy",
		adapterCount: 2,
	}),
	"🟢 Gateway (2 platforms)",
);

let healthProbeCount = 0;
const resolve = (
	inlineRunning: boolean,
	daemonProcessRunning: boolean,
	health: GatewayHealth | null,
) =>
	resolveGatewayStatus({
		inlineRunning,
		adapterCount: 0,
		daemonProcessRunning,
		getDaemonHealth: async () => {
			healthProbeCount++;
			return health;
		},
	});

assert.equal(await resolve(false, false, null), "🔴 Gateway");
assert.equal(healthProbeCount, 0, "stopped daemon should not be probed");
assert.equal(await resolve(true, true, healthyDaemon), "🟡 Gateway (waiting)");
assert.equal(healthProbeCount, 0, "inline mode should not probe detached health");
assert.equal(await resolve(false, true, healthyDaemon), "🟢 Gateway (daemon)");
assert.equal(
	await resolve(false, true, { ...healthyDaemon, running: false }),
	"🟡 Gateway (daemon starting)",
);
assert.equal(await resolve(false, true, null), "🟡 Gateway (daemon unavailable)");

assert.equal(buildGatewayHealthUrl("0.0.0.0", 3847), "http://127.0.0.1:3847/api/status");
assert.equal(buildGatewayHealthUrl("::", 3847), "http://[::1]:3847/api/status");
assert.equal(buildGatewayHealthUrl("::1", 3847), "http://[::1]:3847/api/status");
assert.equal(parseGatewayPid("42"), 42);
assert.equal(parseGatewayPid("123junk"), null);
assert.equal(parseGatewayPid("-1"), null);
assert.equal(parseGatewayPid("0"), null);
assert.equal(parseGatewayPid("1.5"), null);
assert.equal(parseGatewayPid(String(Number.MAX_SAFE_INTEGER + 1)), null);
assert.deepEqual(normalizeGatewayHealthConfig({}), {
	host: "localhost",
	port: 3847,
	tokens: [],
});
assert.deepEqual(normalizeGatewayHealthConfig({ port: 5000 }), {
	host: "localhost",
	port: 5000,
	tokens: [],
});
assert.equal(normalizeGatewayHealthConfig({ port: 70000 }), null);
assert.equal(normalizeGatewayHost("localhost"), "localhost");
assert.equal(normalizeGatewayHost("127.0.0.1"), "127.0.0.1");
assert.equal(normalizeGatewayHost("::1"), "::1");
for (const hostileHost of [
	"http://127.0.0.1",
	"user@example.com",
	"example.com/path",
	"example.com?query",
	" example.com",
	"example.com ",
]) {
	assert.equal(normalizeGatewayHost(hostileHost), null);
}

let requestedUrl = "";
let requestedInit: RequestInit | undefined;
const authenticatedFetch = (async (url: string | URL | Request, init?: RequestInit) => {
	requestedUrl = String(url);
	requestedInit = init;
	return new Response(JSON.stringify(healthyDaemon), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}) as typeof fetch;
const fetchedHealth = await fetchGatewayHealth(
	{ host: "0.0.0.0", port: 3847, tokens: ["example-token"] },
	4242,
	authenticatedFetch,
);
assert.deepEqual(fetchedHealth, healthyDaemon);
assert.equal(requestedUrl, "http://127.0.0.1:3847/api/status");
assert.deepEqual(requestedInit?.headers, {
	Authorization: "Bearer example-token",
});
assert.ok(requestedInit?.signal, "health request should have a timeout signal");
assert.equal(
	await fetchGatewayHealth(
		{ host: "0.0.0.0", port: 3847, tokens: ["example-token"] },
		9999,
		authenticatedFetch,
	),
	null,
	"health PID must match the PID file",
);

const falseHealthFetch = (async () =>
	new Response(JSON.stringify({ ...healthyDaemon, running: false }), {
		status: 200,
	})) as typeof fetch;
assert.equal(
	(await fetchGatewayHealth(
		{ host: "localhost", port: 3847, tokens: [] },
		4242,
		falseHealthFetch,
	))?.running,
	false,
);
const unauthorizedFetch = (async () => new Response("Unauthorized", { status: 401 })) as typeof fetch;
assert.equal(
	await fetchGatewayHealth(
		{ host: "localhost", port: 3847, tokens: [] },
		4242,
		unauthorizedFetch,
	),
	null,
);
const malformedFetch = (async () =>
	new Response(
		JSON.stringify({
			...healthyDaemon,
			clients: "two",
			sessions: -7,
		}),
		{ status: 200 },
	)) as typeof fetch;
assert.equal(
	await fetchGatewayHealth(
		{ host: "localhost", port: 3847, tokens: [] },
		4242,
		malformedFetch,
	),
	null,
);

const unavailableReport = createGatewayStatusReport({
	inlineRunning: false,
	inlineAdapters: 0,
	inlineClients: 0,
	inlineSessions: 0,
	inlineAgentConnected: false,
	daemonProcessRunning: true,
	daemonHealth: null,
});
assert.equal(unavailableReport.status, "Unavailable (detached process detected)");
assert.equal(unavailableReport.running, false);
assert.equal(unavailableReport.adapters, null);

const healthyReport = createGatewayStatusReport({
	inlineRunning: false,
	inlineAdapters: 0,
	inlineClients: 0,
	inlineSessions: 0,
	inlineAgentConnected: false,
	daemonProcessRunning: true,
	daemonHealth: healthyDaemon,
});
assert.equal(healthyReport.status, "Running (Detached)");
assert.equal(healthyReport.running, true);
assert.equal(healthyReport.adapters, 1);
assert.equal(healthyReport.agentConnected, true);

const originalHome = process.env.HOME;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const testHome = await mkdtemp(join(tmpdir(), "pi-gateway-status-"));
const gatewayDir = join(testHome, ".pi", "gateway");
let intervalCleared = false;
let statusIntervalCallback: (() => Promise<void>) | null = null;
let requestedAuthorization: string | undefined;
let waitForHealthResponse: Promise<void> | null = null;
const healthServer = createServer(async (request, response) => {
	requestedAuthorization = request.headers.authorization;
	if (waitForHealthResponse) await waitForHealthResponse;
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify({ ...healthyDaemon, pid: process.pid }));
});

try {
	await new Promise<void>((resolve) => healthServer.listen(0, "localhost", resolve));
	const address = healthServer.address();
	assert.ok(address && typeof address !== "string");
	const testPidFile = join(gatewayDir, "gateway.pid");
	writeGatewayPidFile(testPidFile, process.pid);
	assert.throws(() => writeGatewayPidFile(testPidFile, process.pid));
	assert.equal(removeGatewayPidFile(testPidFile, process.pid + 1), false);
	await writeFile(
		join(gatewayDir, "config.json"),
		JSON.stringify({
			host: "localhost",
			port: address.port,
			tokens: ["example-token"],
		}),
	);
	process.env.HOME = testHome;

	const intervalToken = { unref() {} };
	globalThis.setInterval = ((
		handler: () => Promise<void>,
		timeout: number,
	) => {
		assert.equal(typeof handler, "function");
		assert.equal(timeout, 2000);
		statusIntervalCallback = handler;
		return intervalToken;
	}) as typeof setInterval;
	globalThis.clearInterval = ((token: unknown) => {
		assert.equal(token, intervalToken);
		intervalCleared = true;
	}) as typeof clearInterval;

	const { default: registerGateway } = await import("../src/index.ts?status-integration");
	type ToolDefinition = {
		name: string;
		execute: (
			toolCallId: string,
			params: object,
			signal: AbortSignal | undefined,
			onUpdate: undefined,
			ctx: TestContext,
		) => Promise<{ content: Array<{ text: string }> }>;
	};
	type TestContext = { ui: { setStatus: (key: string, value: string) => void } };
	type SessionHandler = (event: object, ctx: TestContext) => Promise<void>;
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, SessionHandler>();
	registerGateway({
		registerCommand() {},
		registerTool(definition: ToolDefinition) {
			tools.set(definition.name, definition);
		},
		on(event: string, handler: SessionHandler) {
			handlers.set(event, handler);
		},
	} as ExtensionAPI);

	const footerStatuses: string[] = [];
	const ctx: TestContext = {
		ui: {
			setStatus(_key: string, value: string) {
				footerStatuses.push(value);
			},
		},
	};
	await handlers.get("session_start")?.({}, ctx);
	assert.equal(footerStatuses.at(-1), "🟢 Gateway (daemon)");
	assert.equal(requestedAuthorization, "Bearer example-token");

	const toolResult = await tools
		.get("gateway_status")
		.execute("test", {}, undefined, undefined, ctx);
	assert.match(toolResult.content[0].text, /Gateway: Running \(Detached\)/);
	assert.match(toolResult.content[0].text, /Agent: Connected/);

	const tickStatus = statusIntervalCallback;
	assert.ok(tickStatus);
	await writeFile(
		join(gatewayDir, "config.json"),
		JSON.stringify({
			host: "localhost",
			port: address.port,
			tokens: ["rotated-example-token"],
		}),
	);
	await tickStatus();
	assert.equal(requestedAuthorization, "Bearer rotated-example-token");

	await rm(join(gatewayDir, "gateway.pid"));
	await tickStatus();
	assert.equal(footerStatuses.at(-1), "🔴 Gateway");

	writeGatewayPidFile(join(gatewayDir, "gateway.pid"), process.pid);
	await tickStatus();
	assert.equal(footerStatuses.at(-1), "🟢 Gateway (daemon)");

	await handlers.get("session_shutdown")?.({}, ctx);
	assert.equal(intervalCleared, true, "session shutdown should clear status polling");

	statusIntervalCallback = null;
	let releaseHealthResponse: (() => void) | undefined;
	waitForHealthResponse = new Promise<void>((resolve) => {
		releaseHealthResponse = resolve;
	});
	const pendingSessionStart = handlers.get("session_start")?.({}, ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await handlers.get("session_shutdown")?.({}, ctx);
	releaseHealthResponse?.();
	await pendingSessionStart;
	assert.equal(
		statusIntervalCallback,
		null,
		"shutdown during the initial probe must not install a polling timer",
	);
} finally {
	globalThis.setInterval = originalSetInterval;
	globalThis.clearInterval = originalClearInterval;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	await new Promise<void>((resolve) => healthServer.close(() => resolve()));
	await rm(testHome, { recursive: true, force: true });
}

console.log("status tests passed");
