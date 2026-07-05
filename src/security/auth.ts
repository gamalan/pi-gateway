/**
 * Security Layer - Hermes-style allowlists and DM pairing
 *
 * Features:
 * - Per-platform user allowlists
 * - DM pairing flow with one-time codes
 * - Rate limiting
 * - Token authentication for gateway access
 */

import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "node:crypto";
import { logger } from "../logger.js";

export type Platform =
	| "discord"
	| "telegram"
	| "slack"
	| "whatsapp"
	| "signal"
	| "sms"
	| "email"
	| "matrix"
	| "web"
	| "websocket";

interface AllowlistEntry {
	platform: Platform;
	userId: string;
	addedAt: number;
	note?: string;
}

interface PairingCode {
	code: string;
	platform: Platform;
	userId: string;
	createdAt: number;
	expiresAt: number;
	used: boolean;
}

interface RateLimitEntry {
	identifier: string;
	count: number;
	windowStart: number;
}

const GATEWAY_DIR = join(homedir(), ".pi");
const SECURITY_DB = join(GATEWAY_DIR, "gateway-security.db");

let db: Database.Database | null = null;

/**
 * Initialize security database
 */
export function initSecurityStore(): Database.Database {
	if (db) return db;

	if (!existsSync(GATEWAY_DIR)) {
		mkdirSync(GATEWAY_DIR, { recursive: true });
	}

	db = new Database(SECURITY_DB);
	db.exec("PRAGMA journal_mode = WAL;");

	// Allowlist table
	db.exec(`
    CREATE TABLE IF NOT EXISTS allowlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      note TEXT
    )
  `);
	db.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_allowlist ON allowlist(platform, user_id)`,
	);

	// Pairing codes table
	db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_codes (
      code TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    )
  `);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_codes(expires_at)`,
	);

	// Rate limiting table
	db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      identifier TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 1,
      window_start INTEGER NOT NULL
    )
  `);

	logger.info("[Security] Database initialized");
	return db;
}

/**
 * Generate pairing code
 */
export function generatePairingCode(
	platform: Platform,
	userId: string,
): string {
	const database = initSecurityStore();

	// Generate 8-character alphanumeric code
	const code = randomBytes(6).toString("base64url").slice(0, 8).toUpperCase();
	const now = Date.now();
	const expiresAt = now + 60 * 60 * 1000; // 1 hour

	database
		.prepare(
			`
		INSERT INTO pairing_codes (code, platform, user_id, created_at, expires_at, used)
		VALUES (?, ?, ?, ?, ?, 0)
	`,
		)
		.run(code, platform, userId, now, expiresAt);

	logger.info(
		`[Security] Generated pairing code ${code} for ${platform}/${userId}`,
	);
	return code;
}

/**
 * Approve pairing code
 */
export function approvePairingCode(code: string): boolean {
	const database = initSecurityStore();

	const entry = database
		.prepare(`
		SELECT * FROM pairing_codes WHERE code = ? AND used = 0 AND expires_at > ?
	`)
		.get(code, Date.now()) as PairingCode | undefined;

	if (!entry) {
		logger.info(`[Security] Pairing code ${code} not found or expired`);
		return false;
	}

	// Add to allowlist
	database
		.prepare(
			`
		INSERT OR IGNORE INTO allowlist (platform, user_id, added_at)
		VALUES (?, ?, ?)
	`,
		)
		.run(entry.platform, entry.userId, Date.now());

	// Mark code as used
	database
		.prepare("UPDATE pairing_codes SET used = 1 WHERE code = ?")
		.run(code);

	logger.info(`[Security] Approved pairing: ${entry.platform}/${entry.userId}`);
	return true;
}

/**
 * List pending pairing codes
 */
export function listPendingPairingCodes(): Array<{
	code: string;
	platform: Platform;
	userId: string;
	createdAt: number;
	expiresIn: number;
}> {
	const database = initSecurityStore();
	const now = Date.now();

	const rows = database
		.prepare(`
		SELECT * FROM pairing_codes WHERE used = 0 AND expires_at > ?
		ORDER BY created_at ASC
	`)
		.all(now) as PairingCode[];

	return rows.map((row) => ({
		code: row.code,
		platform: row.platform,
		userId: row.userId,
		createdAt: row.createdAt,
		expiresIn: Math.max(0, row.expiresAt - now),
	}));
}

/**
 * Revoke user access
 */
export function revokeUserAccess(platform: Platform, userId: string): boolean {
	const database = initSecurityStore();
	const result = database
		.prepare("DELETE FROM allowlist WHERE platform = ? AND user_id = ?")
		.run(platform, userId);
	return result.changes > 0;
}

/**
 * Check if user is allowed
 */
export function isUserAllowed(platform: Platform, userId: string): boolean {
	const database = initSecurityStore();

	// Check global allow all first
	const config = getSecurityConfig();
	if (config.allowAll) return true;

	// Check config-based allowedUids (cross-platform wildcard or platform-specific)
	if (config.allowedUids) {
		const platformUids = config.allowedUids[platform];
		if (platformUids?.includes(userId)) return true;
		const wildcardUids = config.allowedUids["*"];
		if (wildcardUids?.includes(userId)) return true;
	}

	// Check specific allowlist
	const entry = database
		.prepare(`
		SELECT 1 FROM allowlist WHERE platform = ? AND user_id = ?
	`)
		.get(platform, userId);

	return !!entry;
}

/**
 * Add user to allowlist
 */
export function addToAllowlist(
	platform: Platform,
	userId: string,
	note?: string,
): void {
	const database = initSecurityStore();
	database
		.prepare(
			`
		INSERT OR REPLACE INTO allowlist (platform, user_id, added_at, note)
		VALUES (?, ?, ?, ?)
	`,
		)
		.run(platform, userId, Date.now(), note ?? null);
}

/**
 * List allowlisted users
 */
export function listAllowlistedUsers(platform?: Platform): AllowlistEntry[] {
	const database = initSecurityStore();

	const query = platform
		? "SELECT * FROM allowlist WHERE platform = ? ORDER BY added_at DESC"
		: "SELECT * FROM allowlist ORDER BY platform, added_at DESC";

	const rows = platform
		? (database.prepare(query).all(platform) as AllowlistEntry[])
		: (database.prepare(query).all() as AllowlistEntry[]);

	return rows;
}

/**
 * Rate limiting
 */
export function checkRateLimit(
	identifier: string,
	maxRequests: number = 60,
	windowMs: number = 60000,
): boolean {
	const database = initSecurityStore();
	const now = Date.now();

	const entry = database
		.prepare(`
		SELECT * FROM rate_limits WHERE identifier = ?
	`)
		.get(identifier) as RateLimitEntry | undefined;

	if (!entry || now - entry.windowStart > windowMs) {
		// New window
		database
			.prepare(
				`
			INSERT OR REPLACE INTO rate_limits (identifier, count, window_start)
			VALUES (?, 1, ?)
		`,
			)
			.run(identifier, now);
		return true;
	}

	if (entry.count >= maxRequests) {
		logger.warn(`[Security] Rate limit exceeded for ${identifier}`);
		return false;
	}

	// Increment counter
	database
		.prepare(
			`
		UPDATE rate_limits SET count = count + 1 WHERE identifier = ?
	`,
		)
		.run(identifier);

	return true;
}

/**
 * Clean up expired pairing codes
 */
export function cleanupExpiredCodes(): number {
	const database = initSecurityStore();
	const result = database
		.prepare("DELETE FROM pairing_codes WHERE expires_at < ?")
		.run(Date.now());
	return result.changes;
}

// Security configuration
interface SecurityConfig {
	allowAll: boolean;
	requirePairing: boolean;
	allowedUids: Record<string, string[]>;
	rateLimit: {
		maxRequests: number;
		windowMs: number;
	};
}

const CONFIG_FILE = join(GATEWAY_DIR, "gateway-security.json");

function getSecurityConfig(): SecurityConfig {
	try {
		if (existsSync(CONFIG_FILE)) {
			const content = readFileSync(CONFIG_FILE, "utf-8");
			return JSON.parse(content);
		}
	} catch {
		// Ignore
	}
	return {
		allowAll: false,
		requirePairing: false,
		allowedUids: {},
		rateLimit: { maxRequests: 60, windowMs: 60000 },
	};
}

export function setSecurityConfig(config: Partial<SecurityConfig>): void {
	const current = getSecurityConfig();
	const updated = { ...current, ...config };
	writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), "utf-8");
}
