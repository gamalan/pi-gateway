#!/usr/bin/env node
/**
 * pi-gateway CLI — standalone terminal commands for managing the gateway daemon.
 *
 * Usage:
 *   pi-gateway start         Start gateway as a detached daemon
 *   pi-gateway stop          Stop the running daemon
 *   pi-gateway status        Show daemon status
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PID_FILE = join(homedir(), ".pi", "gateway", "gateway.pid");
const DAEMON_ENTRY = new URL("../dist/index.js", import.meta.url).pathname;

function isRunning(): { running: boolean; pid?: number } {
	if (!existsSync(PID_FILE)) return { running: false };
	try {
		const raw = readFileSync(PID_FILE, "utf-8").trim();
		const pid = parseInt(raw);
		if (!pid) return { running: false };
		process.kill(pid, 0); // signal 0 checks existence
		return { running: true, pid };
	} catch {
		try {
			unlinkSync(PID_FILE);
		} catch {
			/* stale */
		}
		return { running: false };
	}
}

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
		if (running) {
			console.log(`Gateway daemon is already running (PID ${pid}).`);
			process.exit(0);
		}

		console.log("Starting gateway daemon...");

		const child = spawn(process.execPath, [DAEMON_ENTRY, "--daemon"], {
			detached: true,
			stdio: "ignore",
			env: process.env,
		});
		child.unref();

		console.log(`✅ Gateway daemon started (PID ${child.pid}).`);
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

		console.log(`Stopping gateway daemon (PID ${pid})...`);
		process.kill(pid!, "SIGTERM");

		// Wait a moment for graceful shutdown
		setTimeout(() => {
			const { running: stillRunning } = isRunning();
			if (stillRunning) {
				console.log("Daemon didn't stop gracefully — forcing...");
				try {
					process.kill(pid!, "SIGKILL");
				} catch {
					/* already dead */
				}
				try {
					unlinkSync(PID_FILE);
				} catch {
					/* ignore */
				}
			}
			console.log("✅ Gateway daemon stopped.");
		}, 2000);
		break;
	}

	case "status": {
		const { running, pid } = isRunning();
		if (!running) {
			console.log("Gateway daemon: 🔴 Not running");
			process.exit(0);
		}

		console.log(`Gateway daemon: 🟢 Running (PID ${pid})`);
		console.log(`PID file: ${PID_FILE}`);

		// Try to fetch status from the HTTP API
		try {
			const configRaw = readFileSync(
				join(homedir(), ".pi", "gateway", "config.json"),
				"utf-8",
			);
			const config = JSON.parse(configRaw);
			const port = config.port || 3847;

			try {
				const resp = execSync(`curl -s http://localhost:${port}/api/status`, {
					timeout: 3000,
				});
				const status = JSON.parse(resp.toString());
				console.log(`Port: ${port}`);
				console.log(`Running: ${status.running ? "yes" : "no"}`);
				console.log(
					`Adapters: ${(status.adapters || []).join(", ") || "none"}`,
				);
				console.log(`Agent connected: ${status.agent ? "yes" : "no"}`);
			} catch {
				console.log(`Port: ${port} (API unreachable — may still be starting)`);
			}
		} catch {
			console.log("Config file not found.");
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
