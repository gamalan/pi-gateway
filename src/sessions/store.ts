/**
 * Session Store - Hermes-style per-chat session management
 *
 * Features:
 * - Per-chat sessions with unique IDs
 * - Reset policies: daily (hour-based) and idle (minutes-based)
 * - Session persistence across restarts
 * - Background session isolation
 */

import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import { logger } from "../logger.js";

export type ResetPolicy = "daily" | "idle" | "both";

export interface SessionConfig {
	id: string;
	platform: string;
	channelId: string;
	userId: string;
	resetPolicy: ResetPolicy;
	dailyHour: number; // Hour (0-23) for daily reset
	idleMinutes: number; // Minutes for idle reset
	lastActivity: number; // Timestamp of last activity
	createdAt: number;
	isBackground: boolean;
	parentSessionId?: string; // For background task tracking
}

interface SessionRow {
	id: string;
	platform: string;
	channel_id: string;
	user_id: string;
	reset_policy: string;
	daily_hour: number;
	idle_minutes: number;
	last_activity: number;
	created_at: number;
	is_background: number;
	parent_session_id: string | null;
}

const GATEWAY_DIR = join(homedir(), ".pi");
const SESSIONS_DB = join(GATEWAY_DIR, "gateway-sessions.db");

let db: Database.Database | null = null;

/**
 * Initialize session database
 */
export function initSessionStore(): Database.Database {
	if (db) return db;

	if (!existsSync(GATEWAY_DIR)) {
		mkdirSync(GATEWAY_DIR, { recursive: true });
	}

	db = new Database(SESSIONS_DB);
	db.exec("PRAGMA journal_mode = WAL;");

	// Sessions table
	db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reset_policy TEXT NOT NULL DEFAULT 'idle',
      daily_hour INTEGER NOT NULL DEFAULT 4,
      idle_minutes INTEGER NOT NULL DEFAULT 1440,
      last_activity INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      is_background INTEGER NOT NULL DEFAULT 0,
      parent_session_id TEXT,
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
    )
  `);

	// Indexes for fast lookups
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_sessions_platform_channel ON sessions(platform, channel_id)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity)`,
	);

	logger.info("[SessionStore] Database initialized");
	return db;
}

/**
 * Generate unique session ID
 */
export function generateSessionId(): string {
	return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Get or create session for a platform/channel
 */
export function getOrCreateSession(
	platform: string,
	channelId: string,
	userId: string,
	config?: Partial<SessionConfig>,
): SessionConfig {
	const database = initSessionStore();

	// Try to find existing active session
	const existing = database
		.prepare(`
    SELECT * FROM sessions 
    WHERE platform = ? AND channel_id = ? AND is_background = 0
    ORDER BY last_activity DESC
    LIMIT 1
  `)
		.get(platform, channelId) as SessionRow | undefined;

	if (existing) {
		// Check if session needs reset
		if (shouldResetSession(existing)) {
			// Delete old session, create fresh one
			database.prepare("DELETE FROM sessions WHERE id = ?").run(existing.id);
		} else {
			// Update last activity and return
			database
				.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?")
				.run(Date.now(), existing.id);
			return rowToSession(existing);
		}
	}

	// Create new session
	const id = generateSessionId();
	const now = Date.now();

	const session: SessionConfig = {
		id,
		platform,
		channelId,
		userId,
		resetPolicy: config?.resetPolicy ?? "idle",
		dailyHour: config?.dailyHour ?? 4,
		idleMinutes: config?.idleMinutes ?? 1440,
		lastActivity: now,
		createdAt: now,
		isBackground: false,
		...config,
	};

	database
		.prepare(`
    INSERT INTO sessions (id, platform, channel_id, user_id, reset_policy, daily_hour, idle_minutes, last_activity, created_at, is_background, parent_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
		.run(
			session.id,
			session.platform,
			session.channelId,
			session.userId,
			session.resetPolicy,
			session.dailyHour,
			session.idleMinutes,
			session.lastActivity,
			session.createdAt,
			session.isBackground ? 1 : 0,
			session.parentSessionId ?? null,
		);

	logger.info(
		`[SessionStore] Created session ${id.slice(0, 12)}... for ${platform}/${channelId}`,
	);
	return session;
}

/**
 * Create a background session (isolated from parent)
 */
export function createBackgroundSession(
	platform: string,
	channelId: string,
	userId: string,
	parentSessionId?: string,
): SessionConfig {
	const database = initSessionStore();

	const id = generateSessionId();
	const now = Date.now();

	const session: SessionConfig = {
		id,
		platform,
		channelId,
		userId,
		resetPolicy: "idle",
		dailyHour: 4,
		idleMinutes: 1440,
		lastActivity: now,
		createdAt: now,
		isBackground: true,
		parentSessionId,
	};

	database
		.prepare(`
    INSERT INTO sessions (id, platform, channel_id, user_id, reset_policy, daily_hour, idle_minutes, last_activity, created_at, is_background, parent_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
		.run(
			session.id,
			session.platform,
			session.channelId,
			session.userId,
			session.resetPolicy,
			session.dailyHour,
			session.idleMinutes,
			session.lastActivity,
			session.createdAt,
			1, // is_background
			session.parentSessionId ?? null,
		);

	logger.info(
		`[SessionStore] Created background session ${id.slice(0, 12)}...`,
	);
	return session;
}

/**
 * Check if session should be reset
 */
function shouldResetSession(row: SessionRow): boolean {
	const now = Date.now();

	// Check idle timeout
	const idleMs = row.idle_minutes * 60 * 1000;
	if (now - row.last_activity > idleMs) {
		logger.info(
			`[SessionStore] Session ${row.id.slice(0, 8)} reset: idle timeout`,
		);
		return true;
	}

	// Check daily reset
	if (row.reset_policy === "daily" || row.reset_policy === "both") {
		const lastActivity = new Date(row.last_activity);
		const nowDate = new Date(now);

		// Check if we crossed the daily reset hour since last activity
		if (
			lastActivity.getHours() < row.daily_hour &&
			nowDate.getHours() >= row.daily_hour
		) {
			logger.info(
				`[SessionStore] Session ${row.id.slice(0, 8)} reset: daily at ${row.daily_hour}:00`,
			);
			return true;
		}
	}

	return false;
}

/**
 * Update session last activity
 */
export function touchSession(sessionId: string): void {
	const database = initSessionStore();
	database
		.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?")
		.run(Date.now(), sessionId);
}

/**
 * Get session by ID
 */
export function getSession(sessionId: string): SessionConfig | null {
	const database = initSessionStore();
	const row = database
		.prepare("SELECT * FROM sessions WHERE id = ?")
		.get(sessionId) as SessionRow | undefined;
	return row ? rowToSession(row) : null;
}

/**
 * Delete session
 */
export function deleteSession(sessionId: string): void {
	const database = initSessionStore();
	database.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

/**
 * List sessions by platform
 */
export function listSessions(platform?: string): SessionConfig[] {
	const database = initSessionStore();
	const query = platform
		? "SELECT * FROM sessions WHERE platform = ? AND is_background = 0 ORDER BY last_activity DESC"
		: "SELECT * FROM sessions WHERE is_background = 0 ORDER BY last_activity DESC";

	const rows = platform
		? (database.prepare(query).all(platform) as SessionRow[])
		: (database.prepare(query).all() as SessionRow[]);

	return rows.map(rowToSession);
}

/**
 * Clean up stale sessions
 */
export function cleanupStaleSessions(): number {
	const database = initSessionStore();
	const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
	const result = database
		.prepare("DELETE FROM sessions WHERE last_activity < ?")
		.run(cutoff);
	return result.changes;
}

/**
 * Get background sessions for delivery
 */
export function getPendingBackgroundResults(): SessionConfig[] {
	const database = initSessionStore();
	// Background sessions that exist but parent still needs delivery
	const rows = database
		.prepare(`
    SELECT s.* FROM sessions s
    WHERE s.is_background = 1
    ORDER BY s.created_at ASC
  `)
		.all() as SessionRow[];

	return rows.map(rowToSession);
}

// Helper to convert DB row to SessionConfig
function rowToSession(row: SessionRow): SessionConfig {
	return {
		id: row.id,
		platform: row.platform,
		channelId: row.channel_id,
		userId: row.user_id,
		resetPolicy: row.reset_policy as ResetPolicy,
		dailyHour: row.daily_hour,
		idleMinutes: row.idle_minutes,
		lastActivity: row.last_activity,
		createdAt: row.created_at,
		isBackground: row.is_background === 1,
		parentSessionId: row.parent_session_id ?? undefined,
	};
}
