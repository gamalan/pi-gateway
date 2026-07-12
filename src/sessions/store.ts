/**
 * Session Store - Hermes-style per-chat session management
 *
 * Features:
 * - Per-chat sessions with unique IDs
 * - Reset policies: daily (hour-based) and idle (minutes-based)
 * - Session persistence across restarts
 * - Background session isolation
 * - Resume-pending flag for session continuity across restarts
 * - Message history for context restoration
 */

import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
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
	// Session continuity fields
	resumePending: boolean;
	resumeReason?: "restart_timeout" | "shutdown_timeout" | "restart_interrupted";
	lastResumeMarkedAt?: number;
	suspended: boolean;
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
	resume_pending: number;
	resume_reason: string | null;
	last_resume_marked_at: number | null;
	suspended: number;
}

interface MessageRow {
	id: number;
	session_id: string;
	role: string; // "user" | "assistant" | "system"
	content: string;
	created_at: number;
}

export interface StoredMessage {
	id: number;
	sessionId: string;
	role: "user" | "assistant" | "system";
	content: string;
	createdAt: number;
}

const GATEWAY_DIR = join(homedir(), ".pi", "gateway");
const SESSIONS_DB = join(GATEWAY_DIR, "gateway-sessions.db");
const CLEAN_SHUTDOWN_MARKER = join(GATEWAY_DIR, ".clean_shutdown");

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
      resume_pending INTEGER NOT NULL DEFAULT 0,
      resume_reason TEXT,
      last_resume_marked_at INTEGER,
      suspended INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
    )
  `);

	// Message history table for context restoration
	db.exec(`
    CREATE TABLE IF NOT EXISTS message_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

	// Handle legacy databases that lack the new columns (migration)
	migrateLegacySchema(db);

	// Indexes for fast lookups
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_sessions_platform_channel ON sessions(platform, channel_id)",
	);
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)",
	);
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity)",
	);
	try {
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_sessions_resume ON sessions(resume_pending) WHERE resume_pending = 1",
		);
	} catch {
		// Index creation may fail if migration hasn't added the column yet (race-safe)
	}
	try {
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_message_history_session ON message_history(session_id, created_at)",
		);
	} catch {
		// May already exist
	}

	logger.info("[SessionStore] Database initialized");
	return db;
}

/**
 * Migrate legacy databases that were created before schema v1.
 * Adds missing columns idempotently.
 */
function migrateLegacySchema(database: Database.Database): void {
	const cols = database
		.prepare("PRAGMA table_info(sessions)")
		.all() as Array<{ name: string }>;
	const colNames = cols.map((c) => c.name);

	const missingColumns: Array<{ name: string; def: string }> = [];
	if (!colNames.includes("resume_pending")) {
		missingColumns.push({
			name: "resume_pending",
			def: "resume_pending INTEGER NOT NULL DEFAULT 0",
		});
	}
	if (!colNames.includes("resume_reason")) {
		missingColumns.push({
			name: "resume_reason",
			def: "resume_reason TEXT",
		});
	}
	if (!colNames.includes("last_resume_marked_at")) {
		missingColumns.push({
			name: "last_resume_marked_at",
			def: "last_resume_marked_at INTEGER",
		});
	}
	if (!colNames.includes("suspended")) {
		missingColumns.push({
			name: "suspended",
			def: "suspended INTEGER NOT NULL DEFAULT 0",
		});
	}

	for (const col of missingColumns) {
		try {
			database.exec(`ALTER TABLE sessions ADD COLUMN ${col.def}`);
			logger.info(`[SessionStore] Added missing column: ${col.name}`);
		} catch (e) {
			// Column already exists — ignore
		}
	}
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

	// Try to find existing active session (not suspended)
	const existing = database
		.prepare(`
    SELECT * FROM sessions 
    WHERE platform = ? AND channel_id = ? AND is_background = 0
    ORDER BY last_activity DESC
    LIMIT 1
  `)
		.get(platform, channelId) as SessionRow | undefined;

	if (existing) {
		// If suspended, force new session
		if (existing.suspended) {
			database.prepare("DELETE FROM sessions WHERE id = ?").run(existing.id);
			database
				.prepare("DELETE FROM message_history WHERE session_id = ?")
				.run(existing.id);
		} else {
			// Check if session needs reset
			if (shouldResetSession(existing)) {
				database
					.prepare("DELETE FROM sessions WHERE id = ?")
					.run(existing.id);
				database
					.prepare("DELETE FROM message_history WHERE session_id = ?")
					.run(existing.id);
			} else {
				// Update last activity and return
				database
					.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?")
					.run(Date.now(), existing.id);
				return rowToSession(existing);
			}
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
		resumePending: false,
		suspended: false,
		...config,
	};

	database
		.prepare(`
    INSERT INTO sessions (id, platform, channel_id, user_id, reset_policy, daily_hour, idle_minutes, last_activity, created_at, is_background, parent_session_id, resume_pending, resume_reason, last_resume_marked_at, suspended)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
			session.resumePending ? 1 : 0,
			null,
			null,
			session.suspended ? 1 : 0,
		);

	logger.info(
		`[SessionStore] Created session ${id.slice(0, 12)}... for ${platform}/${channelId}`,
	);
	return session;
}

// ── Session Continuity: Resume Pending ──

/**
 * Mark a session as needing resume (call during shutdown/restart).
 */
export function markResumePending(
	platform: string,
	channelId: string,
	reason: "restart_timeout" | "shutdown_timeout" | "restart_interrupted",
): boolean {
	const database = initSessionStore();
	const row = database
		.prepare(
			"SELECT id, suspended FROM sessions WHERE platform = ? AND channel_id = ? AND is_background = 0 ORDER BY last_activity DESC LIMIT 1",
		)
		.get(platform, channelId) as { id: string; suspended: number } | undefined;

	if (!row || row.suspended) return false;

	database
		.prepare(
			"UPDATE sessions SET resume_pending = 1, resume_reason = ?, last_resume_marked_at = ? WHERE id = ?",
		)
		.run(reason, Date.now(), row.id);
	return true;
}

/**
 * Clear the resume_pending flag after successful agent reply.
 */
export function clearResumePending(sessionId: string): boolean {
	const database = initSessionStore();
	const result = database
		.prepare(
			"UPDATE sessions SET resume_pending = 0, resume_reason = NULL WHERE id = ?",
		)
		.run(sessionId);
	return result.changes > 0;
}

/**
 * Get all sessions that are marked as resume_pending (within freshness window).
 */
export function getResumePendingSessions(
	maxAgeSeconds: number = 3600,
): SessionConfig[] {
	const database = initSessionStore();
	const cutoff = Date.now() - maxAgeSeconds * 1000;

	const rows = database
		.prepare(
			`SELECT * FROM sessions 
       WHERE resume_pending = 1 
         AND suspended = 0 
         AND is_background = 0
         AND (last_resume_marked_at > ? OR 
              (last_resume_marked_at IS NULL AND last_activity > ?))
       ORDER BY last_activity DESC`,
		)
		.all(cutoff, cutoff) as SessionRow[];

	return rows.map(rowToSession);
}

/**
 * Mark recently active sessions as resume_pending (crash recovery).
 * Returns count of sessions marked.
 */
export function suspendRecentlyActive(maxAgeSeconds: number = 120): number {
	const database = initSessionStore();
	const cutoff = Date.now() - maxAgeSeconds * 1000;

	const rows = database
		.prepare(
			"SELECT id FROM sessions WHERE last_activity > ? AND is_background = 0 AND suspended = 0",
		)
		.all(cutoff) as { id: string }[];

	const now = Date.now();
	let count = 0;
	for (const row of rows) {
		database
			.prepare(
				"UPDATE sessions SET resume_pending = 1, resume_reason = 'restart_interrupted', last_resume_marked_at = ? WHERE id = ?",
			)
			.run(now, row.id);
		count++;
	}
	return count;
}

/**
 * Suspend a session (manual /stop command).
 */
export function suspendSession(sessionId: string): boolean {
	const database = initSessionStore();
	const result = database
		.prepare(
			"UPDATE sessions SET suspended = 1, resume_pending = 0 WHERE id = ?",
		)
		.run(sessionId);
	return result.changes > 0;
}

/**
 * Check if the previous shutdown was clean (marker file exists).
 */
export function wasCleanShutdown(): boolean {
	return existsSync(CLEAN_SHUTDOWN_MARKER);
}

/**
 * Write clean shutdown marker (called after successful graceful shutdown).
 */
export function markCleanShutdown(): void {
	try {
		writeFileSync(CLEAN_SHUTDOWN_MARKER, Date.now().toString());
	} catch {
		// Non-fatal
	}
}

/**
 * Remove clean shutdown marker (called at startup after processing).
 */
export function clearCleanShutdownMarker(): void {
	try {
		if (existsSync(CLEAN_SHUTDOWN_MARKER)) {
			unlinkSync(CLEAN_SHUTDOWN_MARKER);
		}
	} catch {
		// Non-fatal
	}
}

// ── Message History ──

const MAX_HISTORY_MESSAGES = 20; // Keep last 20 messages per session

/**
 * Save a message to the history store.
 */
export function saveMessage(
	sessionId: string,
	role: "user" | "assistant" | "system",
	content: string,
): void {
	const database = initSessionStore();
	const now = Date.now();

	database
		.prepare(
			"INSERT INTO message_history (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
		)
		.run(sessionId, role, content, now);

	// Prune old messages beyond the limit
	database
		.prepare(
			`DELETE FROM message_history WHERE session_id = ? AND id NOT IN (
        SELECT id FROM message_history WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
      )`,
		)
		.run(sessionId, sessionId, MAX_HISTORY_MESSAGES);
}

/**
 * Get recent message history for a session.
 */
export function getRecentMessages(
	sessionId: string,
	limit: number = 10,
): StoredMessage[] {
	const database = initSessionStore();
	const rows = database
		.prepare(
			"SELECT * FROM message_history WHERE session_id = ? ORDER BY created_at ASC LIMIT ?",
		)
		.all(sessionId, limit) as MessageRow[];

	return rows.map((r) => ({
		id: r.id,
		sessionId: r.session_id,
		role: r.role as "user" | "assistant" | "system",
		content: r.content,
		createdAt: r.created_at,
	}));
}

/**
 * Get recent messages formatted as a text summary for context injection.
 */
export function getRecentMessagesSummary(
	sessionId: string,
	limit: number = 5,
): string | null {
	const messages = getRecentMessages(sessionId, limit);
	if (messages.length === 0) return null;

	return messages
		.map((m) => {
			const prefix = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
			return `[${prefix}]: ${m.content.slice(0, 500)}`;
		})
		.join("\n");
}

// ── Create background session & helpers ──

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
		resumePending: false,
		suspended: false,
	};

	database
		.prepare(`
    INSERT INTO sessions (id, platform, channel_id, user_id, reset_policy, daily_hour, idle_minutes, last_activity, created_at, is_background, parent_session_id, resume_pending, resume_reason, last_resume_marked_at, suspended)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
			0,
			null,
			null,
			0,
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
	database
		.prepare("DELETE FROM message_history WHERE session_id = ?")
		.run(sessionId);
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
 * Clean up stale sessions (7 days)
 */
export function cleanupStaleSessions(): number {
	const database = initSessionStore();
	const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
	const result = database
		.prepare("DELETE FROM sessions WHERE last_activity < ?")
		.run(cutoff);
	database
		.prepare(
			"DELETE FROM message_history WHERE session_id NOT IN (SELECT id FROM sessions)",
		)
		.run();
	return result.changes;
}

/**
 * Get background sessions for delivery
 */
export function getPendingBackgroundResults(): SessionConfig[] {
	const database = initSessionStore();
	const rows = database
		.prepare(
			"SELECT s.* FROM sessions s WHERE s.is_background = 1 ORDER BY s.created_at ASC",
		)
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
		resumePending: row.resume_pending === 1,
		resumeReason: (row.resume_reason as SessionConfig["resumeReason"]) ?? undefined,
		lastResumeMarkedAt: row.last_resume_marked_at ?? undefined,
		suspended: row.suspended === 1,
	};
}
