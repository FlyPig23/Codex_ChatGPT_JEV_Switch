import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { POLICY_SIGNAL_IDS } from "./policy.js";
import {
  CONNECTIONS,
  DECISION_POINTS,
  FAILURE_KINDS,
  JEV_ERROR_CLASSES,
  LOG_ID_RE,
  PATH_CATEGORIES,
  REASON_CODES,
  ROUTER_BIASES,
  ROUTES,
  SIZE_BUCKETS,
  SOURCES,
  TASK_ID_RE,
  TESTS_STATUSES,
  type DecisionLogLine,
  type FeedbackLogLine,
  type IntakeRoute,
  type LabelLogLine,
  type Route,
  type RouterLogLine,
  type RouterStats,
  type Source,
} from "./types.js";

/**
 * Numbers-only decision log at `<stateDir>/routing/<workspaceId>.jsonl` (0600).
 * Every line passes a strict zod schema whose strings come only from enums
 * and id regexes, so no request, output or follow-up text can be written.
 */

export const DECISION_LOG_MAX_LINES = 2000;
/** Extra lines tolerated before the file is rewritten down to the cap. */
const ROTATE_SLACK = 100;
const ROTATE_CHECK_BYTES = 64 * 1024;
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const LOG_MODEL_RE = /^jev-[a-z0-9.-]{1,32}$/;
export const UNKNOWN_MODEL = "jev-unknown";
const QSV_RE = /^\d{4}-\d{2}-\d{2}\.\d{1,3}$/;
const QUESTION_ID_RE =
  /^(task_kind|scope|needs_design|goal_is_clear|touches_auth_security|touches_stored_data|touches_concurrency|changes_public_interface|failure_kind|needs_user|followup_(?:[0-9]|1[01])_size)$/;

/** Signal ids the orchestrator adds on top of POLICY_SIGNAL_IDS. */
export const EXTRA_SIGNAL_IDS = [
  "explicit",
  "threadChat",
  "activeStale",
  "jevAvailable",
  "redactions",
  "errorLines",
  "sensitiveFiles",
  "exitCode",
] as const;

const SIGNAL_IDS: ReadonlySet<string> = new Set<string>([...POLICY_SIGNAL_IDS, ...EXTRA_SIGNAL_IDS]);

/** Every string a signal may hold. */
const SIGNAL_ENUM_VALUES: ReadonlySet<string> = new Set<string>([
  ...ROUTER_BIASES,
  ...CONNECTIONS,
  ...ROUTES,
  ...FAILURE_KINDS,
  ...SIZE_BUCKETS,
  ...TESTS_STATUSES,
  ...PATH_CATEGORIES,
  "none",
  "chatgpt",
  "codex",
  "open",
  "flag",
  "phrase",
]);

const prob = z.number().finite().min(0).max(1);
const count = z.number().int().min(0).max(10_000_000);
const isoTs = z.string().datetime();
const logId = z.string().regex(LOG_ID_RE);

const signalValue = z.union([
  z.number().finite(),
  z.boolean(),
  z.string().refine((value) => SIGNAL_ENUM_VALUES.has(value), { message: "not an enum value" }),
  z.array(z.enum(PATH_CATEGORIES as [string, ...string[]])).max(PATH_CATEGORIES.length),
]);

/** Keep only known signal ids with enum / number / boolean values, so one odd signal never costs the whole line. */
export function cleanSignals(signals: Record<string, unknown>): Record<string, number | boolean | string | string[]> {
  const out: Record<string, number | boolean | string | string[]> = {};
  for (const [key, value] of Object.entries(signals)) {
    if (!SIGNAL_IDS.has(key)) continue;
    const parsed = signalValue.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

export const decisionLogLineSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("decision"),
    ts: isoTs,
    logId,
    taskId: z.string().regex(TASK_ID_RE).nullable(),
    point: z.enum(DECISION_POINTS as [string, ...string[]]),
    route: z.enum(ROUTES as [string, ...string[]]),
    reason: z.enum(REASON_CODES as [string, ...string[]]),
    source: z.enum(SOURCES as [string, ...string[]]),
    bias: z.enum(ROUTER_BIASES as [string, ...string[]]),
    connection: z.enum(CONNECTIONS as [string, ...string[]]).nullable(),
    qsv: z.string().regex(QSV_RE),
    model: z.string().regex(LOG_MODEL_RE).nullable(),
    latencyMs: z.number().int().min(0).max(600_000),
    usage: z.object({ in: count, out: count }).strict().nullable(),
    jevError: z.enum(JEV_ERROR_CLASSES as [string, ...string[]]).nullable(),
    probs: z
      .record(z.string().regex(QUESTION_ID_RE), z.union([prob, z.array(prob).max(12)]))
      .refine((value) => Object.keys(value).length <= 24, { message: "too many probs" }),
    signals: z
      .record(
        z.string().refine((key) => SIGNAL_IDS.has(key), { message: "unknown signal id" }),
        signalValue
      )
      .refine((value) => Object.keys(value).length <= 64, { message: "too many signals" }),
  })
  .strict();

export const labelLogLineSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("label"),
    ts: isoTs,
    logId,
    label: z.enum(["override", "escalated_after_solo"]),
  })
  .strict();

export const feedbackLogLineSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("feedback"),
    ts: isoTs,
    logId,
    verdict: z.enum(["right", "wrong"]),
    expected: z.enum(ROUTES as [string, ...string[]]).optional(),
  })
  .strict();

export const routerLogLineSchema = z.discriminatedUnion("kind", [
  decisionLogLineSchema,
  labelLogLineSchema,
  feedbackLogLineSchema,
]);

export function decisionLogFile(workspaceId: string): string {
  return path.join(getStateDir(), "routing", `${workspaceId}.jsonl`);
}

export function mintLogId(): string {
  return `r_${randomBytes(4).toString("hex")}`;
}

/** A model id safe for the log and `--explain`: anything unexpected becomes "jev-unknown". */
export function safeModelId(model: string | null | undefined): string | null {
  if (model === null || model === undefined) return null;
  return LOG_MODEL_RE.test(model) ? model : UNKNOWN_MODEL;
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "unknown";
}

function countNewlines(buf: Buffer): number {
  let n = 0;
  let at = buf.indexOf(0x0a);
  while (at !== -1) {
    n++;
    at = buf.indexOf(0x0a, at + 1);
  }
  return n;
}

function rotate(file: string): void {
  try {
    if (fs.statSync(file).size < ROTATE_CHECK_BYTES) return;
    const buf = fs.readFileSync(file);
    if (countNewlines(buf) <= DECISION_LOG_MAX_LINES + ROTATE_SLACK) return;
    const lines = buf.toString("utf8").split("\n").filter((line) => line !== "");
    const kept = lines.slice(-DECISION_LOG_MAX_LINES).join("\n") + "\n";
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, kept, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // rotation is best effort
  }
}

function appendLine(workspaceId: string, line: unknown): { ok: boolean; warning?: string } {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return { ok: false, warning: "decision_log_invalid_workspace" };
  const parsed = routerLogLineSchema.safeParse(line);
  if (!parsed.success) return { ok: false, warning: "decision_log_rejected" };
  const file = decisionLogFile(workspaceId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(parsed.data) + "\n", { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // best effort
    }
  } catch (error) {
    return { ok: false, warning: `decision_log_write_failed:${errorCode(error)}` };
  }
  rotate(file);
  return { ok: true };
}

/** Validated with the strict schema, then appended. Never throws. */
export function appendDecision(workspaceId: string, line: DecisionLogLine): { ok: boolean; warning?: string } {
  if (line.kind !== "decision") return { ok: false, warning: "decision_log_rejected" };
  return appendLine(workspaceId, line);
}

export type LabelInput = "override" | "escalated_after_solo" | { verdict: "right" | "wrong"; expected?: Route };

/** An implicit label, or explicit feedback, against a logged decision. Never throws. */
export function appendLabel(
  workspaceId: string,
  id: string,
  label: LabelInput,
  now: Date = new Date()
): { ok: boolean; warning?: string } {
  const ts = now.toISOString();
  if (typeof label === "string") {
    const line: LabelLogLine = { v: 1, kind: "label", ts, logId: id, label };
    return appendLine(workspaceId, line);
  }
  const line: FeedbackLogLine = { v: 1, kind: "feedback", ts, logId: id, verdict: label.verdict };
  if (label.expected !== undefined) line.expected = label.expected;
  return appendLine(workspaceId, line);
}

/** Every valid line, oldest first. Corrupt or foreign lines are skipped. */
export function readLogLines(workspaceId: string): RouterLogLine[] {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return [];
  let text: string;
  try {
    text = fs.readFileSync(decisionLogFile(workspaceId), "utf8");
  } catch {
    return [];
  }
  const out: RouterLogLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const parsed = routerLogLineSchema.safeParse(JSON.parse(raw));
      if (parsed.success) out.push(parsed.data as RouterLogLine);
    } catch {
      // skip corrupt lines
    }
  }
  return out;
}

/** The last `limit` decisions, oldest first. */
export function readDecisions(workspaceId: string, limit = 20): DecisionLogLine[] {
  const n = Math.max(1, Math.min(DECISION_LOG_MAX_LINES, Math.floor(Number.isFinite(limit) ? limit : 20)));
  return readLogLines(workspaceId)
    .filter((line): line is DecisionLogLine => line.kind === "decision")
    .slice(-n);
}

export function findDecision(workspaceId: string, id: string): DecisionLogLine | null {
  if (!LOG_ID_RE.test(id)) return null;
  const hit = readLogLines(workspaceId).filter(
    (line): line is DecisionLogLine => line.kind === "decision" && line.logId === id
  );
  return hit[hit.length - 1] ?? null;
}

export function lastDecision(workspaceId: string): DecisionLogLine | null {
  return readDecisions(workspaceId, 1)[0] ?? null;
}

// ---------------------------------------------------------------- stats

const INTAKE_ROUTES: readonly IntakeRoute[] = ["codex_solo", "codex_then_review", "chatgpt_plan"];

function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

/**
 * Summary of the last `lastTasks` tasks (by first decision). Each task lands in
 * exactly one bucket, in this order: planned by ChatGPT (intake chatgpt_plan),
 * reviewed (reached send_review), escalated while stuck (stuck_escalate_debug),
 * otherwise finished by Codex alone.
 */
export function computeStats(workspaceId: string, lastTasks = 20): RouterStats {
  const lines = readLogLines(workspaceId);
  const decisions = lines.filter((line): line is DecisionLogLine => line.kind === "decision");
  const firstSeen = new Map<string, number>();
  decisions.forEach((d, i) => {
    if (d.taskId && !firstSeen.has(d.taskId)) firstSeen.set(d.taskId, i);
  });
  const window = new Set(
    [...firstSeen.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(-Math.max(1, Math.floor(lastTasks)))
      .map(([taskId]) => taskId)
  );
  const inWindow = decisions.filter((d) => d.taskId !== null && window.has(d.taskId));
  const windowLogIds = new Set(inWindow.map((d) => d.logId));

  const byIntakeRoute: Record<IntakeRoute, number> = { codex_solo: 0, codex_then_review: 0, chatgpt_plan: 0 };
  let reviewsSent = 0;
  let debugEscalations = 0;
  for (const taskId of window) {
    const own = inWindow.filter((d) => d.taskId === taskId);
    const intake = own.filter((d) => d.point === "intake" && (INTAKE_ROUTES as readonly string[]).includes(d.route));
    const intakeRoute = intake.length > 0 ? (intake[intake.length - 1].route as IntakeRoute) : null;
    if (intakeRoute) byIntakeRoute[intakeRoute] += 1;
    if (intakeRoute === "chatgpt_plan") continue;
    if (own.some((d) => d.point === "review_gate" && d.route === "send_review")) reviewsSent += 1;
    else if (own.some((d) => d.point === "failure" && d.reason === "stuck_escalate_debug")) debugEscalations += 1;
  }

  const sources: Record<Source, number> = { jev: 0, heuristic: 0, override: 0, rule: 0 };
  for (const d of inWindow) sources[d.source] += 1;
  const latencies = inWindow
    .filter((d) => d.model !== null)
    .map((d) => d.latencyMs)
    .sort((a, b) => a - b);
  const corrections = lines.filter(
    (line) =>
      windowLogIds.has(line.logId) &&
      ((line.kind === "feedback" && line.verdict === "wrong") || (line.kind === "label" && line.label === "override"))
  ).length;

  return {
    tasks: window.size,
    byIntakeRoute,
    reviewsSent,
    debugEscalations,
    followupsLocal: inWindow.filter((d) => d.point === "reply" && d.route === "apply_followups_local").length,
    corrections,
    sources,
    jevErrors: inWindow.filter((d) => d.jevError !== null).length,
    latencyP50: percentile(latencies, 0.5),
    latencyP95: percentile(latencies, 0.95),
  };
}

/** 「最近 20 个任务：14 个我直接完成，4 个先请 ChatGPT 规划，1 个请 ChatGPT 复核，1 次卡住后求助；你纠正过 2 次。」 */
export function formatStatsZh(s: RouterStats): string {
  if (s.tasks === 0) return "最近还没有智能切换的记录。";
  const planned = s.byIntakeRoute.chatgpt_plan;
  const solo = Math.max(0, s.tasks - planned - s.reviewsSent - s.debugEscalations);
  return `最近 ${s.tasks} 个任务：${solo} 个我直接完成，${planned} 个先请 ChatGPT 规划，${s.reviewsSent} 个请 ChatGPT 复核，${s.debugEscalations} 次卡住后求助；你纠正过 ${s.corrections} 次。`;
}
