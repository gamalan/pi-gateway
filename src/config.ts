/**
 * Shared config loader for the gateway.
 * Reads the base config plus optional config.local.json overlay.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { logger } from "./logger.js";
import { GATEWAY_CONFIG_DIR, GATEWAY_CONFIG_FILE } from "./paths.js";

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeJson(base: unknown, overlay: unknown): unknown {
	if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay;

	const merged: JsonObject = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		merged[key] = mergeJson(merged[key], value);
	}
	return merged;
}

const GATEWAY_CONFIG_LOCAL_FILE = join(GATEWAY_CONFIG_DIR, "config.local.json");

function readJsonObject(filePath: string): JsonObject | undefined {
	if (!existsSync(filePath)) return undefined;

	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
		if (!isPlainObject(parsed)) {
			throw new Error("Config must be a JSON object");
		}
		return parsed;
	} catch (err) {
		logger.error(
			`[gateway] Failed to parse ${filePath} — ignoring. Error:`,
			err,
		);
		return undefined;
	}
}

export function readGatewayConfig(): JsonObject | undefined {
	const base = readJsonObject(GATEWAY_CONFIG_FILE);
	const local = readJsonObject(GATEWAY_CONFIG_LOCAL_FILE);

	if (!base && !local) return undefined;
	return mergeJson(base ?? {}, local ?? {}) as JsonObject;
}
