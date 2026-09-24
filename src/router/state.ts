import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { TASK_ID_RE, type FailureCounter, type RouterTaskState } from "./types.js";

/** Per-task router state: `<stateDir>/routing/<workspaceId>/tasks/<taskId>.json` (0600, best effort). */

export const TASK_STATE_MAX_AGE_DAYS = 14;
export const MAX_FAILURE_COUNTERS = 10;
export const TASK_GOAL_MAX_BYTES = 400;

const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BASELINE_ENTRIES = 400;
const MAX_TEXT = 512;
const DAY_MS = 24 * 60 * 60 * 1000;

export function routingDir(): string {
  return path.join(getStateDir(), "routing");
}

export function taskStateDir(workspaceId: string): string {
  return path.join(routingDir(), workspaceId, "tasks");
}

export function taskStateFile(workspaceId: string, taskId: string): string {
  return path.join(taskStateDir(workspaceId), `${taskId}.json`);
}

function validIds(workspaceId: string, taskId: string): boolean {
  return WORKSPACE_ID_RE.test(workspaceId) && TASK_ID_RE.test(taskId);
}

/** `c2c_` + 4 random hex; `taken` lets the caller avoid ids already in use. */
export function mintTaskId(taken: (id: string) => boolean = () => false): string {
  let id = "";
  for (let attempt = 0; attempt < 32; attempt++) {
    id = `c2c_${randomBytes(2).toString("hex")}`;
    if (!taken(id)) return id;
  }
  return id;
}

export function taskStateExists(workspaceId: string, taskId: string): boolean {
  if (!validIds(workspaceId, taskId)) return false;
  try {
    return fs.existsSync(taskStateFile(workspaceId, taskId));
  } catch {
    return false;
  }
}

/** Cut to at most `maxBytes` of UTF-8 without splitting a character. */
export function cutUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

const failureCounterSchema = z.object({
  commandKey: z.string().min(1).max(MAX_TEXT),
  consecutive: z.number().int().min(0).max(1_000_000),
  sameSignatureStreak: z.number().int().min(0).max(1_000_000),
  lastSignature: z.string().max(128),
  askedAt: z.number().int().min(0).max(1_000_000).optional(),
});

const baselineSchema = z.object({
  head: z.string().max(128).nullable(),
  entries: z.record(z.string().max(4096), z.string().max(256)),
  truncated: z.boolean(),
});

const taskStateSchema = z.object({
  v: z.literal(1),
  taskId: z.string().regex(TASK_ID_RE),
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
  routedBy: z.enum(["user", "router"]),
  intakeRoute: z.enum(["codex_solo", "codex_then_review", "chatgpt_plan"]),
  intendedReview: z.boolean(),
  goal: z.string().max(4 * TASK_GOAL_MAX_BYTES),
  pin: z.enum(["chatgpt", "codex"]).nullable(),
  engaged: z.boolean(),
  outSwitches: z.number().int().min(0).max(1000),
  noEgress: z.boolean(),
  uncertainIntake: z.boolean(),
  mechanical: z.boolean(),
  baseline: baselineSchema.nullable(),
  failures: z.array(failureCounterSchema).max(100),
  intakeLogId: z.string().regex(/^r_[0-9a-f]{8}$/).nullable(),
  consentAskedFor: z.enum(["none", "plan", "review"]),
});

/** A fresh state for `taskId`; `patch` overrides the defaults. */
export function newTaskState(taskId: string, now: Date = new Date(), patch: Partial<RouterTaskState> = {}): RouterTaskState {
  const ts = now.toISOString();
  return {
    v: 1,
    taskId,
    createdAt: ts,
    updatedAt: ts,
    routedBy: "router",
    intakeRoute: "codex_solo",
    intendedReview: false,
    goal: "",
    pin: null,
    engaged: false,
    outSwitches: 0,
    noEgress: false,
    uncertainIntake: false,
    mechanical: false,
    baseline: null,
    failures: [],
    intakeLogId: null,
    consentAskedFor: "none",
    ...patch,
  };
}

/** Null when missing, unreadable, or not a valid state for this task. */
export function readTaskState(workspaceId: string, taskId: string): RouterTaskState | null {
  if (!validIds(workspaceId, taskId)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(taskStateFile(workspaceId, taskId), "utf8"));
  } catch {
    return null;
  }
  const parsed = taskStateSchema.safeParse(raw);
  if (!parsed.success || parsed.data.taskId !== taskId) return null;
  const s = parsed.data;
  return {
    ...s,
    goal: cutUtf8(s.goal, TASK_GOAL_MAX_BYTES),
    failures: s.failures.slice(-MAX_FAILURE_COUNTERS),
  };
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "unknown";
}

function normalizeForWrite(s: RouterTaskState, now: Date): RouterTaskState | null {
  const baseline = s.baseline
    ? {
        head: s.baseline.head,
        entries: Object.fromEntries(Object.entries(s.baseline.entries).slice(0, MAX_BASELINE_ENTRIES)),
        truncated: s.baseline.truncated || Object.keys(s.baseline.entries).length > MAX_BASELINE_ENTRIES,
      }
    : null;
  const candidate: RouterTaskState = {
    ...s,
    v: 1,
    updatedAt: now.toISOString(),
    goal: cutUtf8(typeof s.goal === "string" ? s.goal : "", TASK_GOAL_MAX_BYTES),
    baseline,
    failures: (s.failures ?? []).slice(-MAX_FAILURE_COUNTERS),
  };
  const parsed = taskStateSchema.safeParse(candidate);
  return parsed.success ? (parsed.data as RouterTaskState) : null;
}

/** Atomic 0600 write; never throws. A failure (EPERM/EACCES/EROFS/…) comes back as a warning. */
export function writeTaskState(
  workspaceId: string,
  s: RouterTaskState,
  now: Date = new Date()
): { ok: boolean; warning?: string } {
  if (!validIds(workspaceId, s.taskId)) return { ok: false, warning: "task_state_invalid_id" };
  const data = normalizeForWrite(s, now);
  if (!data) return { ok: false, warning: "task_state_invalid" };
  const file = taskStateFile(workspaceId, s.taskId);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // best effort on platforms without chmod semantics
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    return { ok: false, warning: `task_state_write_failed:${errorCode(error)}` };
  }
  gcTaskStates(workspaceId, TASK_STATE_MAX_AGE_DAYS, now, s.taskId);
  return { ok: true };
}

/** Remove task states (and stray temp files) not modified for `maxAgeDays`. Best effort. */
export function gcTaskStates(
  workspaceId: string,
  maxAgeDays: number = TASK_STATE_MAX_AGE_DAYS,
  now: Date = new Date(),
  keepTaskId?: string
): void {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return;
  const dir = taskStateDir(workspaceId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = now.getTime() - Math.max(0, maxAgeDays) * DAY_MS;
  for (const name of names) {
    if (!/^c2c_[0-9a-f]{4}\.json(\.[\w.]+\.tmp)?$/.test(name)) continue;
    if (keepTaskId && name === `${keepTaskId}.json`) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

/** Count one more failure of `key`; the entry moves to the end (most recent) and the list keeps ≤ 10. */
export function recordFailure(
  failures: readonly FailureCounter[],
  key: string,
  signature: string
): { failures: FailureCounter[]; counter: FailureCounter } {
  const previous = failures.find((f) => f.commandKey === key);
  const counter: FailureCounter = previous
    ? {
        commandKey: key,
        consecutive: previous.consecutive + 1,
        sameSignatureStreak: previous.lastSignature === signature ? previous.sameSignatureStreak + 1 : 1,
        lastSignature: signature,
        ...(previous.askedAt !== undefined ? { askedAt: previous.askedAt } : {}),
      }
    : { commandKey: key, consecutive: 1, sameSignatureStreak: 1, lastSignature: signature };
  const rest = failures.filter((f) => f.commandKey !== key);
  return { failures: [...rest, counter].slice(-MAX_FAILURE_COUNTERS), counter };
}

export function resetFailure(failures: readonly FailureCounter[], key: string): FailureCounter[] {
  return failures.filter((f) => f.commandKey !== key);
}

/**
 * Remember that the router just asked the user about `key` (at its current count). The count and
 * streak stay, so a later `pin chatgpt` still escalates at once; only the same question waits for
 * another full cap of failures.
 */
export function markFailureAsked(failures: readonly FailureCounter[], key: string): FailureCounter[] {
  return failures.map((f) => (f.commandKey === key ? { ...f, askedAt: f.consecutive } : f));
}
