// Leveled logger gated by KIRO_LOG env var.
//
// Levels: error (always on) / warn (default) / info / debug.
// Set KIRO_LOG=debug|info|warn|error to change the threshold.
//
// Destination: console by default. If KIRO_LOG_FILE is set, all output is
// redirected exclusively to that file (appended, one JSON line per record)
// so CLI stdout/stderr stays clean during capture sessions.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function currentLevel(): LogLevel {
  const raw = (globalThis.process?.env?.KIRO_LOG ?? "").toLowerCase();
  if (raw === "error" || raw === "warn" || raw === "info" || raw === "debug") return raw;
  return "warn";
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel()];
}

function currentFilePath(): string | null {
  const raw = globalThis.process?.env?.KIRO_LOG_FILE;
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

// Track which directories we've already ensured exist so we don't stat on every
// log line. Cleared implicitly on process exit.
const ensuredDirs = new Set<string>();

function writeToFile(filePath: string, line: string): void {
  try {
    const dir = dirname(filePath);
    if (!ensuredDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      ensuredDirs.add(dir);
    }
    appendFileSync(filePath, line + "\n");
  } catch (err) {
    // Fall back to stderr so the failure isn't silent, but only once per
    // process to avoid log-loop amplification.
    if (!fileFallbackWarned) {
      fileFallbackWarned = true;
      console.error(`[pi-kiro] ERROR failed to write KIRO_LOG_FILE=${filePath}:`, err);
    }
  }
}

let fileFallbackWarned = false;

function emit(level: LogLevel, message: string, data?: unknown): void {
  if (!enabled(level)) return;

  const filePath = currentFilePath();
  if (filePath) {
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: message,
    };
    if (data !== undefined) record.data = data;
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // Data has circular refs or non-serializable values; stringify best-effort.
      line = JSON.stringify({ ...record, data: String(data) });
    }
    writeToFile(filePath, line);
    return;
  }

  const prefix = `[pi-kiro] ${level.toUpperCase()}`;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (data === undefined) {
    sink(`${prefix} ${message}`);
  } else {
    sink(`${prefix} ${message}`, data);
  }
}

export const log = {
  error: (msg: string, data?: unknown) => emit("error", msg, data),
  warn: (msg: string, data?: unknown) => emit("warn", msg, data),
  info: (msg: string, data?: unknown) => emit("info", msg, data),
  debug: (msg: string, data?: unknown) => emit("debug", msg, data),
  /** True when the current threshold includes `debug`. Use to avoid
   *  expensive serialization of payloads we won't log. */
  isDebug: () => enabled("debug"),
};

// ---- Debug utilities ----------------------------------------------------

/**
 * Produce a short, printable preview of a raw stream chunk for debug logs.
 * Kiro's response is AWS Event Stream binary with JSON payloads; most bytes
 * are framing noise. We keep the output bounded and escape non-printable
 * chars so the log file stays greppable.
 */
const CHUNK_PREVIEW_LIMIT = 2048;
export function previewChunk(s: string): string {
  let out = "";
  const limit = Math.min(s.length, CHUNK_PREVIEW_LIMIT);
  for (let i = 0; i < limit; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else out += s[i];
  }
  if (s.length > CHUNK_PREVIEW_LIMIT) out += `…(+${s.length - CHUNK_PREVIEW_LIMIT} chars)`;
  return out;
}
