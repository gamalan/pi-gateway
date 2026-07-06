/**
 * Path utilities — resolve the pi-gateway package root and share
 * config file locations so every module reads the same files.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

// ── Runtime config paths (user's home directory) ─────────────────

/** Single source of truth: ~/.pi/gateway/config.json */
export const GATEWAY_CONFIG_DIR = join(homedir(), ".pi", "gateway");
export const GATEWAY_CONFIG_FILE = join(GATEWAY_CONFIG_DIR, "config.json");

// ── Package root resolution ──────────────────────────────────────

/**
 * Walk up from the calling module's location until we find a
 * package.json or config/ directory, then return that directory.
 *
 * Call with `import.meta.url` from the file that needs the root.
 */
export function getPackageRoot(importMetaUrl: string): string {
	let dir = dirname(fileURLToPath(importMetaUrl));

	for (let i = 0; i < 6; i++) {
		if (
			existsSync(join(dir, "package.json")) ||
			existsSync(join(dir, "config"))
		) {
			return dir;
		}
		dir = dirname(dir);
	}

	// Last-resort fallback
	return dirname(fileURLToPath(importMetaUrl));
}
