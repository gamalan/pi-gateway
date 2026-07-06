/**
 * Background Task Manager - Hermes-style background session handling
 *
 * Features:
 * - Isolated sessions for background tasks
 * - Result delivery to parent session
 * - Progress notifications
 * - Timeout handling
 */

import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createBackgroundSession } from "../sessions/store.js";
import { randomBytes } from "node:crypto";
import { logger } from "../logger.js";

export type BackgroundStatus =
	| "running"
	| "completed"
	| "failed"
	| "timeout"
	| "delivered";

export interface BackgroundTask {
	id: string;
	sessionId: string;
	parentSessionId: string;
	command: string;
	status: BackgroundStatus;
	progress: number;
	progressMessage?: string;
	result?: unknown;
	error?: string;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	deliveredAt?: number;
}

interface TaskRow {
	id: string;
	session_id: string;
	parent_session_id: string;
	command: string;
	status: string;
	progress: number;
	progress_message: string | null;
	result: string | null;
	error: string | null;
	created_at: number;
	started_at: number | null;
	completed_at: number | null;
	delivered_at: number | null;
}

const GATEWAY_DIR = join(homedir(), ".pi", "gateway");
const TASKS_DB = join(GATEWAY_DIR, "gateway-background-tasks.db");

let db: Database.Database | null = null;
const runningProcesses: Map<string, ChildProcess> = new Map();
const progressCallbacks: Map<string, (task: BackgroundTask) => void> =
	new Map();

/**
 * Initialize background tasks database
 */
export function initBackgroundTasks(): Database.Database {
	if (db) return db;

	if (!existsSync(GATEWAY_DIR)) {
		mkdirSync(GATEWAY_DIR, { recursive: true });
	}

	db = new Database(TASKS_DB);
	db.exec("PRAGMA journal_mode = WAL;");

	// Tasks table
	db.exec(`
    CREATE TABLE IF NOT EXISTS background_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_session_id TEXT NOT NULL,
      command TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      progress INTEGER NOT NULL DEFAULT 0,
      progress_message TEXT,
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      delivered_at INTEGER
    )
  `);

	// Indexes
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON background_tasks(parent_session_id)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_tasks_status ON background_tasks(status)`,
	);

	logger.info("[BackgroundTasks] Database initialized");
	return db;
}

/**
 * Start a background task
 */
export function startBackgroundTask(
	parentSessionId: string,
	command: string,
	onProgress?: (task: BackgroundTask) => void,
): BackgroundTask {
	const database = initBackgroundTasks();

	const id = `bg-${Date.now()}-${randomBytes(4).toString("hex")}`;
	const now = Date.now();

	// Create background session
	const session = createBackgroundSession(
		"background",
		id,
		"system",
		parentSessionId,
	);

	// Create task record
	const task: BackgroundTask = {
		id,
		sessionId: session.id,
		parentSessionId,
		command,
		status: "running",
		progress: 0,
		createdAt: now,
	};

	database
		.prepare(`
    INSERT INTO background_tasks 
    (id, session_id, parent_session_id, command, status, progress, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
		.run(id, session.id, parentSessionId, command, "running", 0, now);

	// Register progress callback
	if (onProgress) {
		progressCallbacks.set(id, onProgress);
	}

	// Start the actual process
	const proc = spawn("pi", ["--mode", "json", "--print", command], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env },
	});

	runningProcesses.set(id, proc);

	let stdout = "";
	let stderr = "";

	proc.stdout?.on("data", (data: Buffer) => {
		stdout += data.toString();

		// Parse progress updates
		try {
			const lines = stdout.split("\n").filter(Boolean);
			for (const line of lines) {
				const parsed = JSON.parse(line);
				if (parsed.progress !== undefined) {
					updateTaskProgress(id, parsed.progress, parsed.message);
				}
			}
		} catch {
			// Not JSON yet
		}
	});

	proc.stderr?.on("data", (data: Buffer) => {
		stderr += data.toString();
	});

	proc.on("close", (code) => {
		runningProcesses.delete(id);

		if (code === 0) {
			try {
				const result = stdout.trim() ? JSON.parse(stdout) : { success: true };
				completeTask(id, result);
			} catch {
				completeTask(id, { success: true, output: stdout });
			}
		} else {
			failTask(id, stderr || `Process exited with code ${code}`);
		}
	});

	proc.on("error", (err) => {
		runningProcesses.delete(id);
		failTask(id, err.message);
	});

	logger.info(`[BackgroundTasks] Started task ${id.slice(0, 12)}...`);
	return task;
}

/**
 * Update task progress
 */
export function updateTaskProgress(
	taskId: string,
	progress: number,
	message?: string,
): void {
	const database = initBackgroundTasks();

	database
		.prepare(`
    UPDATE background_tasks SET progress = ?, progress_message = ?
    WHERE id = ?
  `)
		.run(progress, message ?? null, taskId);

	// Notify via callback
	const callback = progressCallbacks.get(taskId);
	if (callback) {
		const task = getTask(taskId);
		if (task) callback(task);
	}
}

/**
 * Complete a task successfully
 */
export function completeTask(taskId: string, result: unknown): void {
	const database = initBackgroundTasks();
	const now = Date.now();

	database
		.prepare(`
    UPDATE background_tasks 
    SET status = 'completed', progress = 100, result = ?, completed_at = ?
    WHERE id = ?
  `)
		.run(JSON.stringify(result), now, taskId);

	logger.info(`[BackgroundTasks] Task ${taskId.slice(0, 12)}... completed`);
}

/**
 * Fail a task
 */
export function failTask(taskId: string, error: string): void {
	const database = initBackgroundTasks();
	const now = Date.now();

	database
		.prepare(`
    UPDATE background_tasks 
    SET status = 'failed', error = ?, completed_at = ?
    WHERE id = ?
  `)
		.run(error, now, taskId);

	logger.info(
		`[BackgroundTasks] Task ${taskId.slice(0, 12)}... failed: ${error}`,
	);
}

/**
 * Mark task as delivered to user
 */
export function markTaskDelivered(taskId: string): void {
	const database = initBackgroundTasks();
	database
		.prepare(`
    UPDATE background_tasks SET status = 'delivered', delivered_at = ?
    WHERE id = ?
  `)
		.run(Date.now(), taskId);
}

/**
 * Get task by ID
 */
export function getTask(taskId: string): BackgroundTask | null {
	const database = initBackgroundTasks();
	const row = database
		.prepare("SELECT * FROM background_tasks WHERE id = ?")
		.get(taskId) as TaskRow | undefined;
	return row ? rowToTask(row) : null;
}

/**
 * Get pending results for parent session
 */
export function getPendingResultsForSession(
	parentSessionId: string,
): BackgroundTask[] {
	const database = initBackgroundTasks();

	const rows = database
		.prepare(`
    SELECT * FROM background_tasks 
    WHERE parent_session_id = ? AND status IN ('completed', 'failed')
    AND delivered_at IS NULL
    ORDER BY created_at ASC
  `)
		.all(parentSessionId) as TaskRow[];

	return rows.map(rowToTask);
}

/**
 * List all tasks
 */
export function listTasks(status?: BackgroundStatus): BackgroundTask[] {
	const database = initBackgroundTasks();

	const query = status
		? "SELECT * FROM background_tasks WHERE status = ? ORDER BY created_at DESC"
		: "SELECT * FROM background_tasks ORDER BY created_at DESC";

	const rows = status
		? (database.prepare(query).all(status) as TaskRow[])
		: (database.prepare(query).all() as TaskRow[]);

	return rows.map(rowToTask);
}

/**
 * Cancel a running task
 */
export function cancelTask(taskId: string): boolean {
	const proc = runningProcesses.get(taskId);
	if (proc) {
		proc.kill("SIGTERM");
		runningProcesses.delete(taskId);

		const database = initBackgroundTasks();
		database
			.prepare(`
      UPDATE background_tasks SET status = 'failed', error = ?, completed_at = ?
      WHERE id = ?
    `)
			.run("Cancelled by user", Date.now(), taskId);

		return true;
	}
	return false;
}

/**
 * Clean up old tasks
 */
export function cleanupOldTasks(
	maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
): number {
	const database = initBackgroundTasks();
	const cutoff = Date.now() - maxAgeMs;
	const result = database
		.prepare("DELETE FROM background_tasks WHERE created_at < ?")
		.run(cutoff);
	return result.changes;
}

// Helper to convert DB row to BackgroundTask
function rowToTask(row: TaskRow): BackgroundTask {
	return {
		id: row.id,
		sessionId: row.session_id,
		parentSessionId: row.parent_session_id,
		command: row.command,
		status: row.status as BackgroundStatus,
		progress: row.progress,
		progressMessage: row.progress_message ?? undefined,
		result: (() => {
			try {
				return row.result ? JSON.parse(row.result) : undefined;
			} catch {
				return undefined;
			}
		})(),
		error: row.error ?? undefined,
		createdAt: row.created_at,
		startedAt: row.started_at ?? undefined,
		completedAt: row.completed_at ?? undefined,
		deliveredAt: row.delivered_at ?? undefined,
	};
}
