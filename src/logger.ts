/**
 * Gateway Logger - writes all logs to a file instead of console
 *
 * All gateway log output goes to ~/.pi/gateway/gateway.log so that
 * console.log/console.error do not escape pi's TUI and break the layout.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const GATEWAY_DIR = join(homedir(), ".pi", "gateway");
const LOG_FILE = join(GATEWAY_DIR, "gateway.log");

function ensureLogDir(): void {
	if (!existsSync(GATEWAY_DIR)) {
		mkdirSync(GATEWAY_DIR, { recursive: true });
	}
}

function formatTimestamp(): string {
	return new Date().toISOString();
}

function writeLog(level: string, ...args: unknown[]): void {
	ensureLogDir();
	const message = args
		.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
		.join(" ");
	const line = `[${formatTimestamp()}] [${level}] ${message}\n`;
	try {
		appendFileSync(LOG_FILE, line, "utf-8");
	} catch {
		// Fail silently — we must not break the TUI
	}
}

export const logger = {
	info: (...args: unknown[]) => writeLog("INFO", ...args),
	warn: (...args: unknown[]) => writeLog("WARN", ...args),
	error: (...args: unknown[]) => writeLog("ERROR", ...args),
	debug: (...args: unknown[]) => writeLog("DEBUG", ...args),
};
