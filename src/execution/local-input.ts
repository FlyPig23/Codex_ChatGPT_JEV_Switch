import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import type { Workspace } from "../workspace/manager.js";

export type LocalInputRejection = "not_found" | "symlink" | "not_regular_file" | "sensitive" | "protected_location";

export type LocalInputResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; reason: LocalInputRejection };

export interface LocalInputOptions {
  mode: "head" | "tail";
  maxBytes: number;
  /** Override the home directory used for the protected-location check (tests). */
  homeDir?: string;
}

/** Home-relative directories that hold credentials; never read from them. */
const PROTECTED_HOME_DIRS: readonly string[][] = [
  [".ssh"],
  [".aws"],
  [".gnupg"],
  [".config", "gcloud"],
  [".docker"],
  [".config", "gh"],
  [".kube"],
  [".cloudflared"],
  [".codex"],
];

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const normCase = (p: string): string => (CASE_INSENSITIVE ? p.toLowerCase() : p);

function keysDir(): string {
  const override = process.env.C2C_KEYS_DIR;
  if (override && override.trim() !== "") return path.resolve(override);
  return `${getStateDir()}-keys`;
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function isWithin(candidate: string, base: string): boolean {
  const c = normCase(candidate);
  const b = normCase(base.replace(/[\\/]+$/, ""));
  return c === b || c.startsWith(b + path.sep);
}

function protectedBases(homeDir: string): string[] {
  const bases = [...PROTECTED_HOME_DIRS.map((parts) => path.join(homeDir, ...parts)), getStateDir(), keysDir()];
  return bases.flatMap((base) => [path.resolve(base), realOrResolved(base)]);
}

function sensitive(ws: Pick<Workspace, "root" | "ignoreRules">, abs: string, real: string): boolean {
  const check = (rel: string): boolean => {
    try {
      return ws.ignoreRules.isSensitive(rel);
    } catch {
      return true;
    }
  };
  if (check(path.basename(abs)) || check(path.basename(real))) return true;
  for (const candidate of [abs, real]) {
    if (!isWithin(candidate, ws.root)) continue;
    const rel = path.relative(ws.root, candidate).split(path.sep).join("/");
    if (rel && !rel.startsWith("..") && check(rel)) return true;
  }
  return false;
}

/** Drop a multi-byte sequence cut off at the end (head) or its orphaned tail bytes at the start (tail). */
function trimPartialUtf8(buf: Buffer, cutEnd: boolean, cutStart: boolean): Buffer {
  let start = 0;
  let end = buf.length;
  if (cutStart) {
    while (start < Math.min(3, end) && (buf[start] & 0xc0) === 0x80) start++;
  }
  if (cutEnd) {
    for (let i = end - 1; i >= Math.max(start, end - 4); i--) {
      const byte = buf[i];
      if ((byte & 0xc0) === 0x80) continue;
      const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (end - i < need) end = i;
      break;
    }
  }
  return buf.subarray(start, end);
}

/**
 * Read a local file Codex names on the command line (command output, follow-ups) without
 * letting that path reach secrets: no symlinks, no non-regular files, nothing matching the
 * sensitive-file policy, nothing under credential directories or C2C's own state and key dirs.
 * Relative paths resolve against the current directory.
 */
export function guardLocalInput(
  ws: Pick<Workspace, "root" | "ignoreRules">,
  filePath: string,
  opts: LocalInputOptions
): LocalInputResult {
  if (typeof filePath !== "string" || filePath.trim() === "" || filePath.includes("\0")) {
    return { ok: false, reason: "not_found" };
  }
  const abs = path.resolve(filePath);
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(abs);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (lstat.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!lstat.isFile()) return { ok: false, reason: "not_regular_file" };

  let real: string;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (sensitive(ws, abs, real)) return { ok: false, reason: "sensitive" };
  const home = realOrResolved(opts.homeDir ?? os.homedir());
  if (protectedBases(home).some((base) => isWithin(real, base) || isWithin(abs, base))) {
    return { ok: false, reason: "protected_location" };
  }

  const maxBytes = Math.max(0, Math.floor(Number.isFinite(opts.maxBytes) ? opts.maxBytes : 0));
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(abs, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ELOOP" ? "symlink" : "not_found" };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: "not_regular_file" };
    if (process.platform !== "win32" && (stat.dev !== lstat.dev || stat.ino !== lstat.ino)) {
      return { ok: false, reason: "not_found" };
    }
    const size = stat.size;
    const length = Math.min(size, maxBytes);
    const position = opts.mode === "tail" ? size - length : 0;
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, position + read);
      if (n === 0) break;
      read += n;
    }
    const truncated = size > length;
    const chunk = trimPartialUtf8(
      buf.subarray(0, read),
      truncated && opts.mode === "head",
      truncated && opts.mode === "tail"
    );
    return { ok: true, text: chunk.toString("utf8"), truncated };
  } finally {
    fs.closeSync(fd);
  }
}
