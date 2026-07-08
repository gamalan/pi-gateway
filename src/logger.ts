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
	const d = new Date();
	const pad = (n: number, len = 2) => String(n).padStart(len, "0");
	const yyyy = d.getFullYear();
	const MM = pad(d.getMonth() + 1);
	const dd = pad(d.getDate());
	const HH = pad(d.getHours());
	const mm = pad(d.getMinutes());
	const ss = pad(d.getSeconds());
	const ms = pad(d.getMilliseconds(), 3);
	return `${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}.${ms}`;
}

function serializeArg(a: unknown): string {
	if (typeof a === "string") return a;
	if (a instanceof Error) return a.stack || a.message;
	try {
		return JSON.stringify(a);
	} catch {
		return String(a);
	}
}

function writeLog(level: string, ...args: unknown[]): void {
	ensureLogDir();
	const message = args.map(serializeArg).join(" ");
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
