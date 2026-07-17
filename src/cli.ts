#!/usr/bin/env node
/**
 * pi-gateway CLI — standalone terminal commands for managing the gateway daemon.
 *
 * Usage:
 *   pi-gateway start         Start gateway as a detached daemon
 *   pi-gateway stop          Stop the running daemon
 *   pi-gateway status        Show daemon status
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	fetchGatewayHealth,
	normalizeGatewayHealthConfig,
	parseGatewayPid,
	removeGatewayPidFile,
	waitForGatewayHealth,
	type GatewayHealthConfig,
} from "./status.js";

const PID_FILE = join(homedir(), ".pi", "gateway", "gateway.pid");
const DAEMON_ENTRY = new URL("../dist/index.js", import.meta.url).pathname;

function isRunning(): { running: boolean; pid?: number } {
	if (!existsSync(PID_FILE)) return { running: false };

	let rawPid: string;
	try {
		rawPid = readFileSync(PID_FILE, "utf-8").trim();
	} catch {
		return { running: false };
	}
	const pid = parseGatewayPid(rawPid);
	if (pid === null) return { running: false };

	try {
		process.kill(pid, 0); // signal 0 checks existence
		return { running: true, pid };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") {
			return { running: true, pid };
		}
		removeGatewayPidFile(PID_FILE, pid);
		return { running: false };
	}
}

function loadHealthConfig(): GatewayHealthConfig {
	try {
		const parsed = JSON.parse(
			readFileSync(join(homedir(), ".pi", "gateway", "config.json"), "utf-8"),
		);
		return normalizeGatewayHealthConfig(parsed) ?? normalizeGatewayHealthConfig({})!;
	} catch {
		return normalizeGatewayHealthConfig({})!;
	}
}

async function getVerifiedHealth(pid: number) {
	return fetchGatewayHealth(loadHealthConfig(), pid);
}

const delay = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function printHelp(): void {
	console.log(`
pi-gateway — Hermes-style messaging gateway daemon

Usage:
  pi-gateway start         Start gateway as a detached daemon
  pi-gateway stop          Stop the running daemon
  pi-gateway status        Show daemon status and health
  pi-gateway --help        Show this help

The daemon runs independently of pi. Once started, it:
  - Listens for messages on configured platforms (Telegram, Discord, etc.)
  - Spawns its own pi --mode rpc for AI processing
  - Logs to ~/.pi/gateway/gateway.log

You can also use /gateway start -d inside pi's TUI for the same effect.
`);
}

const cmd = process.argv[2];

switch (cmd) {
	case "start": {
		const { running, pid } = isRunning();
		if (running && pid !== undefined) {
			const existingHealth = await waitForGatewayHealth(
				loadHealthConfig(),
				pid,
				1500,
			);
			if (existingHealth) {
				console.log(
					`Gateway daemon is already ${existingHealth.running ? "running" : "initializing"} (PID ${pid}).`,
				);
				process.exit(0);
			}
			console.error(
				`A live process owns the gateway PID file (PID ${pid}), but its daemon API is unavailable. Refusing to start another daemon.`,
			);
			process.exit(1);
		}

		console.log("Starting gateway daemon...");
		const child = spawn(process.execPath, [DAEMON_ENTRY, "--daemon"], {
			detached: true,
			stdio: "ignore",
			env: process.env,
		});
		child.unref();
		if (child.pid === undefined) {
			console.error("Failed to spawn gateway daemon.");
			process.exit(1);
		}

		const startedHealth = await waitForGatewayHealth(
			loadHealthConfig(),
			child.pid,
			5000,
		);
		if (!startedHealth) {
			console.error(
				`Gateway daemon spawn could not be verified (PID ${child.pid}). Check ~/.pi/gateway/gateway.log.`,
			);
			process.exit(1);
		}

		console.log(
			`✅ Gateway daemon ${startedHealth.running ? "started" : "is initializing"} (PID ${child.pid}).`,
		);
		console.log("   It will keep running after this terminal closes.");
		console.log("   Logs: ~/.pi/gateway/gateway.log");
		break;
	}

	case "stop": {
		const { running, pid } = isRunning();
		if (!running) {
			console.log("No gateway daemon is running.");
			process.exit(0);
		}

		const verifiedHealth = await waitForGatewayHealth(
			loadHealthConfig(),
			pid!,
			1500,
		);
		if (!verifiedHealth) {
			console.error(
				"Refusing to signal an unverified daemon PID. Check `pi-gateway status`.",
			);
			process.exit(1);
		}

		console.log(`Stopping gateway daemon (PID ${pid})...`);
		process.kill(pid!, "SIGTERM");

		let currentState = isRunning();
		for (let attempt = 0; attempt < 40; attempt++) {
			if (!currentState.running || currentState.pid !== pid) break;
			await delay(250);
			currentState = isRunning();
		}
		if (!currentState.running || currentState.pid !== pid) {
			console.log("✅ Gateway daemon stopped.");
			break;
		}

		const stillVerified = await getVerifiedHealth(pid!);
		if (!stillVerified) {
			console.error("Daemon is still alive but no longer verifiable; not force-killing.");
			process.exit(1);
		}

		console.log("Daemon didn't stop gracefully — forcing...");
		process.kill(pid!, "SIGKILL");
		await delay(200);
		const finalState = isRunning();
		if (finalState.running && finalState.pid === pid) {
			console.error("Failed to stop gateway daemon.");
			process.exit(1);
		}
		console.log("✅ Gateway daemon stopped.");
		break;
	}

	case "status": {
		const { running, pid } = isRunning();
		if (!running) {
			console.log("Gateway daemon: 🔴 Not running");
			process.exit(0);
		}

		const health = await getVerifiedHealth(pid!);
		console.log(
			health?.running
				? `Gateway daemon: 🟢 Verified (PID ${pid})`
				: health
					? `Gateway daemon: 🟡 Initializing (PID ${pid})`
					: `Gateway daemon: 🟡 Unavailable (PID ${pid})`,
		);
		console.log(`PID file: ${PID_FILE}`);

		const healthConfig = loadHealthConfig();
		console.log(`Mode: ${health ? "Detached" : "Detached unavailable"}`);
		console.log(`Port: ${healthConfig.port}`);
		if (health) {
			console.log(`Running: ${health.running ? "yes" : "initializing"}`);
			console.log(`Adapters: ${health.adapters.join(", ") || "none"}`);
			console.log(`Clients: ${health.clients}`);
			console.log(`Sessions: ${health.sessions}`);
			console.log(`Agent connected: ${health.agent ? "yes" : "no"}`);
		} else {
			console.log("Running: unverified");
		}

		console.log("Logs: ~/.pi/gateway/gateway.log");

		// Show last 10 log lines
		const logFile = join(homedir(), ".pi", "gateway", "gateway.log");
		try {
			const logContent = readFileSync(logFile, "utf-8");
			const lines = logContent.trim().split("\n");
			const last = lines.slice(-10);
			console.log(`\nLast ${last.length} log lines:`);
			for (const line of last) {
				console.log(`  ${line}`);
			}
		} catch {
			/* log file not available */
		}
		break;
	}

	default:
		printHelp();
		process.exit(cmd === "--help" || cmd === "-h" ? 0 : 1);
}
