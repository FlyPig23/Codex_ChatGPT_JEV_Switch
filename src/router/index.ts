import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EntryType, Fetch, Questions } from "@typesafe-ai/sdk";
import { readLastEndpoint } from "../config/endpoint.js";
import {
  isConsentAskedToday,
  isStaleAskedToday,
  localDay,
  markConsentAsked,
  markIntroShown,
  markStaleAsked,
  readRouterPrefs,
  type RouterPrefs,
  type RouterPrefsWrite,
} from "../config/router-prefs.js";
import { saveExecutionOutput } from "../execution/output.js";
import { appendExecutionRecord } from "../execution/records.js";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";
import { mergeSession, readSession, writeSession, type TaskCheckpoint } from "../session/state.js";
import { Workspace } from "../workspace/manager.js";
import { heuristicFailureKind, needsUserRegex } from "./heuristics.js";
import { askJev, jevCallOptions, probeJev, readBreaker } from "./jev.js";
import { appendDecision, appendLabel, cleanSignals, mintLogId, safeModelId } from "./log.js";
import { buildDebugInit, buildReviewInit, GENERIC_NEXT, renderNext, renderSay } from "./messages.js";
import { assertOutbound, sanitizeForThirdParty, stripCode } from "./outbound.js";
import { decideFailure, decideIntake, decideReply, decideReviewGate, explainThresholds, MAX_LOCAL_FOLLOWUPS } from "./policy.js";
import {
  FAILURE_QUESTION_IDS,
  INTAKE_QUESTION_IDS,
  QUESTION_SET_VERSION,
  failureProbs,
  failureQuestions,
  intakeProbs,
  intakeQuestions,
  parseFailureAnswers,
  parseIntakeAnswers,
  parseReplyAnswers,
  replyProbs,
  replyQuestionIds,
  replyQuestions,
} from "./questions.js";
import { consentStatus, hasValidConsent, keyStatus, readRouterSecrets, resolveApiKey, type ConsentStatus, type KeyStatus, type ResolvedKey } from "./secrets.js";
import {
  activeCheckpointView,
  captureBaseline,
  classifyPaths,
  commandKey,
  detectExplicitRoute,
  detectNoEgress,
  errorSignature,
  extractErrorLines,
  analyzeFollowups,
  isWarmChat,
  isWorkspaceBusy,
  probeConnection,
  sizeBucket,
  taskChanges,
  type ConnectionDeps,
  type TaskChanges,
} from "./signals.js";
import {
  cutUtf8,
  markFailureAsked,
  mintTaskId,
  newTaskState,
  readTaskState,
  recordFailure,
  resetFailure,
  taskStateExists,
  TASK_GOAL_MAX_BYTES,
  writeTaskState,
} from "./state.js";
import {
  TASK_ID_RE,
  type ActiveCheckpointView,
  type Connection,
  type DecisionLogLine,
  type DecisionPoint,
  type FailureAnswers,
  type FailureContext,
  type FailureInput,
  type IntakeAnswers,
  type IntakeContext,
  type IntakeInput,
  type JevErrorClass,
  type Pin,
  type PolicyResult,
  type ReasonCode,
  type ReplyAnswers,
  type ReplyInput,
  type ReviewContext,
  type ReviewInput,
  type Route,
  type RouteExplain,
  type RouteOutput,
  type RouterTaskState,
  type SayParams,
  type SignalValue,
  type Source,
} from "./types.js";

/**
 * IO orchestration for `c2c route <point>`. Every run* returns a RouteOutput
 * and never throws: invalid input and internal errors come back as ok:false
 * with a generic `next`. The disabled path makes no network call and no write.
 */

/** Checkout root: two levels up from src/router (tsx) or dist/router (build). */
export const CHECKOUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function defaultC2cCommand(): string {
  const bin = path.join(CHECKOUT_ROOT, "bin", "c2c.js");
  return bin.includes('"') ? `node ${JSON.stringify(bin)}` : `node "${bin}"`;
}

export const REQUEST_MAX_CHARS = 1500;
/** What intake reads (the CLI's --request cap). Detectors see all of it; only ≤ REQUEST_MAX_CHARS is sent, after redaction. */
export const REQUEST_INPUT_MAX_CHARS = 16_000;
export const DEFAULT_MAX_ITERATIONS = 12;
export const CHANGED_FILES_CAP = 200;

export interface RouterDeps {
  fetch?: Fetch;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  c2cCommand?: string;
  /** Injected connection probe dependencies (tests). */
  connection?: ConnectionDeps;
}

export interface Enablement {
  enabled: boolean;
  reason?: ReasonCode;
  jevAvailable: boolean;
  jevUnavailable?: JevErrorClass;
}

interface ResolvedEnablement {
  enablement: Enablement;
  prefs: RouterPrefs;
  key: ResolvedKey | null;
}

/** §3.1, cheapest first. Reads only: no writes, no network. */
function resolveEnablement(ws: Pick<Workspace, "id">, env: NodeJS.ProcessEnv, now: number = Date.now()): ResolvedEnablement {
  const prefs = readRouterPrefs();
  const off = (reason: ReasonCode): ResolvedEnablement => ({
    enablement: { enabled: false, reason, jevAvailable: false },
    prefs,
    key: null,
  });
  if (prefs.mode !== "auto") return off("disabled_mode_off");
  if (!hasValidConsent(readRouterSecrets())) return off("disabled_no_consent");
  if (prefs.disabledWorkspaces.includes(ws.id)) return off("disabled_workspace");
  if (readLastEndpoint(ws.id) === null) return off("not_setup");
  const key = resolveApiKey(env);
  let jevUnavailable: JevErrorClass | undefined;
  if (env.CODEX_SANDBOX_NETWORK_DISABLED === "1") jevUnavailable = "network_blocked";
  else if (!key) jevUnavailable = "no_key";
  else if (readBreaker({ fingerprint: key.fingerprint, now }).open) jevUnavailable = "breaker_open";
  const enablement: Enablement = { enabled: true, jevAvailable: jevUnavailable === undefined };
  if (jevUnavailable) enablement.jevUnavailable = jevUnavailable;
  return { enablement, prefs, key };
}

export function routerEnablement(ws: Pick<Workspace, "id">, env: NodeJS.ProcessEnv = process.env): Enablement {
  try {
    return resolveEnablement(ws, env).enablement;
  } catch {
    return { enabled: false, reason: "disabled_mode_off", jevAvailable: false };
  }
}

// ---------------------------------------------------------------- shared context

interface RunContext {
  ws: Workspace;
  env: NodeJS.ProcessEnv;
  now: Date;
  today: string;
  prefs: RouterPrefs;
  key: ResolvedKey | null;
  en: Enablement;
  c2c: string;
  warnings: string[];
  deps: RouterDeps;
}

function openContext(root: string, deps: RouterDeps): { ctx: RunContext } | { error: string } {
  let ws: Workspace;
  try {
    ws = new Workspace(root);
  } catch {
    return { error: "workspace_not_found" };
  }
  const env = deps.env ?? process.env;
  const now = deps.now?.() ?? new Date();
  const resolved = resolveEnablement(ws, env, now.getTime());
  return {
    ctx: {
      ws,
      env,
      now,
      today: localDay(now),
      prefs: resolved.prefs,
      key: resolved.key,
      en: resolved.enablement,
      c2c: deps.c2cCommand ?? defaultC2cCommand(),
      warnings: [],
      deps,
    },
  };
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "unknown";
}

function warn(ctx: RunContext, warning: string | undefined): void {
  if (warning && !ctx.warnings.includes(warning)) ctx.warnings.push(warning);
}

/** router.json writes are best effort; their warnings (never input text) go to explain.warnings. */
function prefsWrite(ctx: RunContext, write: () => RouterPrefsWrite): void {
  try {
    const result = write();
    if (result.warning) for (const w of result.warning.split("; ")) warn(ctx, w);
  } catch (error) {
    warn(ctx, `router_prefs_write_failed:${errorCode(error)}`);
  }
}

function emptyExplain(ctx: RunContext | null, point: DecisionPoint): RouteExplain {
  return {
    signals: {},
    answers: {},
    thresholds: ctx ? explainThresholds(point, ctx.prefs.bias) : {},
    model: null,
    latencyMs: 0,
    usage: null,
    jevError: null,
    warnings: ctx ? [...ctx.warnings] : [],
    qsv: QUESTION_SET_VERSION,
  };
}

export function errorOutput(
  point: DecisionPoint,
  error: string,
  opts: { taskId?: string | null; explain?: boolean } = {}
): RouteOutput {
  const out: RouteOutput = {
    ok: false,
    enabled: false,
    point,
    route: "disabled",
    reason: error === "internal_error" ? "internal_error" : "invalid_input",
    source: "rule",
    taskId: typeof opts.taskId === "string" && TASK_ID_RE.test(opts.taskId) ? opts.taskId : null,
    say: null,
    next: GENERIC_NEXT,
    controlMessage: null,
    logId: null,
    error,
  };
  if (opts.explain) out.explain = emptyExplain(null, point);
  return out;
}

export function disabledOutput(
  point: DecisionPoint,
  reason: ReasonCode,
  opts: { root?: string; c2c?: string; explain?: boolean } = {}
): RouteOutput {
  const out: RouteOutput = {
    ok: true,
    enabled: false,
    point,
    route: "disabled",
    reason,
    source: "rule",
    taskId: null,
    say: null,
    next: renderNext("disabled", reason, { taskId: null, root: opts.root || ".", c2c: opts.c2c ?? defaultC2cCommand() }),
    controlMessage: null,
    logId: null,
  };
  if (opts.explain) out.explain = emptyExplain(null, point);
  return out;
}

// ---------------------------------------------------------------- Jev consultation

interface JevResult<A> {
  answers: A | null;
  probs: Record<string, number | number[]>;
  model: string | null;
  latencyMs: number;
  usage: { input_tokens: number; output_tokens: number } | null;
  jevError: JevErrorClass | null;
}

function noJev<A>(error: JevErrorClass | null): JevResult<A> {
  return { answers: null, probs: {}, model: null, latencyMs: 0, usage: null, jevError: error };
}

async function consult<A>(
  ctx: RunContext,
  point: "intake" | "failure" | "reply",
  state: EntryType,
  questions: Questions,
  parse: (answers: unknown) => A,
  probsOf: (answers: A) => Record<string, number | number[]>
): Promise<JevResult<A>> {
  const outcome = await askJev(state, questions, jevCallOptions(point, ctx.prefs.model), {
    fetch: ctx.deps.fetch,
    env: ctx.env,
    key: ctx.key,
  });
  if (!outcome.ok) {
    return { ...noJev<A>(outcome.error), latencyMs: Math.round(outcome.latencyMs) };
  }
  const base = {
    model: safeModelId(outcome.model),
    latencyMs: Math.round(outcome.latencyMs),
    usage: { input_tokens: outcome.usage.input_tokens, output_tokens: outcome.usage.output_tokens },
  };
  try {
    const answers = parse(outcome.answers);
    return { ...base, answers, probs: probsOf(answers), jevError: null };
  } catch {
    // InvalidAnswersError (or any parse failure) → heuristic
    return { ...base, answers: null, probs: {}, jevError: "invalid_response" };
  }
}

// ---------------------------------------------------------------- outbound payloads (§7.2)

type Payload = { ok: true; state: EntryType; redactions: number } | { ok: false };

function checked(point: "intake" | "failure" | "reply", state: Record<string, unknown>, redactions: number): Payload {
  try {
    return { ok: true, state: assertOutbound(point, state), redactions };
  } catch {
    return { ok: false };
  }
}

function intakePayload(request: string, requestEn: string | undefined, key: ResolvedKey | null): Payload {
  const apiKey = key?.key;
  const r = sanitizeForThirdParty(request, "request", { apiKey });
  if (!r.allowed || r.text.trim() === "") return { ok: false };
  const state: Record<string, unknown> = { request: r.text };
  let redactions = r.redactions;
  if (requestEn !== undefined && requestEn.trim() !== "") {
    const e = sanitizeForThirdParty(requestEn, "request_en", { apiKey });
    if (!e.allowed) return { ok: false };
    if (e.text.trim() !== "") state.request_en = e.text;
    redactions += e.redactions;
  }
  return checked("intake", state, redactions);
}

/** No `goal`: neither failure question reads it, and it would be one more copy of the request sent. */
function failurePayload(command: string, errorLines: string[], key: ResolvedKey | null): Payload {
  const apiKey = key?.key;
  const c = sanitizeForThirdParty(command, "command", { apiKey });
  const e = sanitizeForThirdParty(errorLines.join("\n"), "error_lines", { apiKey });
  if (!c.allowed || !e.allowed) return { ok: false };
  return checked("failure", { command: c.text, error_lines: e.text }, c.redactions + e.redactions);
}

function replyPayload(items: string[], key: ResolvedKey | null): Payload {
  const followups: string[] = [];
  let redactions = 0;
  for (const item of items) {
    const s = sanitizeForThirdParty(item, "followup", { apiKey: key?.key });
    if (!s.allowed) return { ok: false };
    followups.push(s.text);
    redactions += s.redactions;
  }
  return checked("reply", { followups }, redactions);
}

// ---------------------------------------------------------------- helpers

function sliceChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function flatten(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cs}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Local-only goal (controlMessage GOAL): code stripped, secrets redacted, ≤ 400 bytes. */
function localGoal(request: string): string {
  const s = sanitizeExecutionOutput(stripCode(request));
  if (!s.allowed) return "";
  return cutUtf8(flatten(s.text.replace(/\n?…\[truncated\]/g, "")), TASK_GOAL_MAX_BYTES);
}

function roundProbs(probs: Record<string, number | number[]>): Record<string, number | number[]> {
  const r = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4;
  return Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, Array.isArray(v) ? v.map(r) : r(v)]));
}

function withSignals(...parts: Array<Record<string, SignalValue | undefined>>): Record<string, SignalValue> {
  const out: Record<string, SignalValue> = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) if (value !== undefined) out[key] = value;
  }
  return out;
}

interface LoadedTask {
  state: RouterTaskState;
  /** The workspace checkpoint, when it belongs to this task. */
  own: TaskCheckpoint | null;
  active: ActiveCheckpointView | null;
}

function loadTask(ctx: RunContext, taskId: string): LoadedTask {
  let own: TaskCheckpoint | null = null;
  try {
    const checkpoint = readSession(ctx.ws.id)?.checkpoint;
    own = checkpoint && checkpoint.taskId === taskId ? checkpoint : null;
  } catch {
    own = null;
  }
  let state = readTaskState(ctx.ws.id, taskId);
  if (!state) {
    warn(ctx, "task_state_missing");
    state = newTaskState(taskId, ctx.now, {
      routedBy: own?.routedBy === "router" ? "router" : "user",
      intakeRoute: own ? "chatgpt_plan" : "codex_solo",
      engaged: own !== null,
      goal: own?.originalGoal ? cutUtf8(flatten(own.originalGoal), TASK_GOAL_MAX_BYTES) : "",
    });
  }
  return { state, own, active: activeCheckpointView(ctx.ws, ctx.now) };
}

/**
 * ChatGPT is engaged when the task state says so or the workspace checkpoint belongs to this task.
 * A codex pin wins over both: the user took the task back.
 */
function isEngaged(task: LoadedTask): boolean {
  if (task.state.pin === "codex") return false;
  return task.state.engaged || task.own !== null;
}

/**
 * The review gate's "already in the loop": only a live checkpoint of this task counts (the sticky
 * `engaged` flag outlives a finished loop and is set before any INIT is sent). While DONE
 * follow-ups are applied locally (closeLocal), only a user request sends them back into the loop.
 */
function reviewEngaged(task: LoadedTask, userAskedReview: boolean): boolean {
  if (task.state.pin === "codex" || task.own === null) return false;
  return task.own.closeLocal === true ? userAskedReview : true;
}

/** Codex is executing a ChatGPT PLAN for this task (a failure there goes back as EXECUTED). */
function inChatgptLoop(task: LoadedTask): boolean {
  if (task.state.pin === "codex" || task.own === null) return false;
  return task.own.protocolState === "PLAN_RECEIVED" || task.own.protocolState === "EXECUTING";
}

/** A codex_then_review intake's one out-switch is still reserved for its review. */
function reviewReserved(task: LoadedTask): boolean {
  return task.state.intakeRoute === "codex_then_review" && !isEngaged(task) && !task.state.engaged && task.state.outSwitches <= 1;
}

function goalFor(task: LoadedTask): string {
  return task.state.goal || (task.own?.originalGoal ? flatten(task.own.originalGoal) : "");
}

function shareablePaths(changes: TaskChanges): string[] {
  const sensitive = new Set(changes.sensitivePaths);
  return changes.paths.filter((p) => !sensitive.has(p)).slice(0, CHANGED_FILES_CAP);
}

function probe(ctx: RunContext): Promise<Connection> {
  return probeConnection(ctx.ws, { timeoutMs: 1000, deps: { ...ctx.deps.connection, env: ctx.env } });
}

function applyDelta(state: RouterTaskState, delta: Partial<RouterTaskState> | undefined): void {
  if (!delta) return;
  for (const [key, value] of Object.entries(delta)) {
    if (value !== undefined) (state as unknown as Record<string, unknown>)[key] = value;
  }
}

function saveState(ctx: RunContext, state: RouterTaskState): void {
  const result = writeTaskState(ctx.ws.id, state, ctx.now);
  if (!result.ok) warn(ctx, result.warning);
}

function logDecision<A>(
  ctx: RunContext,
  point: DecisionPoint,
  taskId: string | null,
  result: Pick<PolicyResult, "route" | "reason" | "source">,
  signals: Record<string, SignalValue>,
  jev: JevResult<A> | null,
  connection: Connection | null
): string | null {
  const logId = mintLogId();
  const line: DecisionLogLine = {
    v: 1,
    kind: "decision",
    ts: ctx.now.toISOString(),
    logId,
    taskId,
    point,
    route: result.route,
    reason: result.reason,
    source: result.source,
    bias: ctx.prefs.bias,
    connection,
    qsv: QUESTION_SET_VERSION,
    model: jev?.model ?? null,
    latencyMs: Math.max(0, Math.min(600_000, Math.round(jev?.latencyMs ?? 0))),
    usage: jev?.usage ? { in: jev.usage.input_tokens, out: jev.usage.output_tokens } : null,
    jevError: jev?.jevError ?? null,
    probs: roundProbs(jev?.probs ?? {}),
    signals: cleanSignals(signals),
  };
  const written = appendDecision(ctx.ws.id, line);
  if (!written.ok) {
    warn(ctx, written.warning);
    return null;
  }
  return logId;
}

function label(ctx: RunContext, logId: string | null, value: "override" | "escalated_after_solo"): void {
  if (!logId) return;
  const result = appendLabel(ctx.ws.id, logId, value, ctx.now);
  if (!result.ok) warn(ctx, result.warning);
}

function sayFor(ctx: RunContext, point: DecisionPoint, route: Route, reason: ReasonCode, params: SayParams): string | null {
  const plain = renderSay(route, reason, params, { withIntro: false, point });
  if (plain === null || ctx.prefs.introShownAt) return plain;
  prefsWrite(ctx, () => markIntroShown(ctx.now));
  return renderSay(route, reason, params, { withIntro: true, point });
}

interface BuildParams<A> {
  point: DecisionPoint;
  route: Route;
  reason: ReasonCode;
  source: Source;
  taskId: string | null;
  sayParams?: SayParams;
  controlMessage?: string | null;
  logId: string | null;
  signals: Record<string, SignalValue>;
  jev: JevResult<A> | null;
  explain?: boolean;
  n1?: number;
  activeTaskId?: string;
  explicitUser?: boolean;
  activeCheckpoint?: ActiveCheckpointView | null;
}

function build<A>(ctx: RunContext, p: BuildParams<A>): RouteOutput {
  const next = renderNext(p.route, p.reason, {
    taskId: p.taskId,
    root: ctx.ws.root,
    c2c: ctx.c2c,
    n1: p.n1,
    activeTaskId: p.activeTaskId,
    explicitUser: p.explicitUser,
    point: p.point,
  });
  const say = sayFor(ctx, p.point, p.route, p.reason, p.sayParams ?? {});
  const out: RouteOutput = {
    ok: true,
    enabled: true,
    point: p.point,
    route: p.route,
    reason: p.reason,
    source: p.source,
    taskId: p.taskId,
    say,
    next,
    controlMessage: p.controlMessage ?? null,
    logId: p.logId,
  };
  if (p.activeCheckpoint !== undefined) out.activeCheckpoint = p.activeCheckpoint;
  if (p.explain) {
    out.explain = {
      signals: p.signals,
      answers: roundProbs(p.jev?.probs ?? {}),
      thresholds: explainThresholds(p.point, ctx.prefs.bias),
      model: p.jev?.model ?? null,
      latencyMs: Math.round(p.jev?.latencyMs ?? 0),
      usage: p.jev?.usage ?? null,
      jevError: p.jev?.jevError ?? null,
      warnings: [...ctx.warnings],
      qsv: QUESTION_SET_VERSION,
    };
  }
  return out;
}

function rule(route: Route, reason: ReasonCode, source: Source, stateDelta?: Partial<RouterTaskState>): PolicyResult {
  return stateDelta ? { route, reason, source, signals: {}, stateDelta } : { route, reason, source, signals: {} };
}

function validMaxIterations(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 1000 ? value : DEFAULT_MAX_ITERATIONS;
}

// ---------------------------------------------------------------- intake (§4.1)

interface IntakePlan {
  request: string;
  explicit: "chatgpt" | "codex" | null;
  explicitFlag: boolean;
  noEgress: boolean;
  active: ActiveCheckpointView | null;
  staleAskable: boolean;
}

function planIntake(ctx: RunContext, input: IntakeInput): IntakePlan {
  // The explicit / confidentiality detectors and the redaction pass see the whole message; the
  // 1500-char cap applies to what is sent, after redaction (sanitizeForThirdParty).
  const request = sliceChars(input.request, REQUEST_INPUT_MAX_CHARS);
  const explicitFlag = input.explicit === "chatgpt";
  const explicit = explicitFlag ? "chatgpt" : detectExplicitRoute(request);
  const active = activeCheckpointView(ctx.ws, ctx.now);
  // A stale checkpoint, or a fresh one the router started (its REVIEW / DEBUG / follow-ups would be
  // orphaned after a restart or in a new thread), is surfaced once per task per day.
  const staleAskable =
    active !== null &&
    (active.stale || active.routedBy === "router") &&
    TASK_ID_RE.test(active.taskId) &&
    !isStaleAskedToday(ctx.prefs, ctx.ws.id, ctx.today, active.taskId);
  return { request, explicit, explicitFlag, noEgress: detectNoEgress(request), active, staleAskable };
}

export async function runIntake(input: IntakeInput, deps: RouterDeps = {}): Promise<RouteOutput> {
  const point: DecisionPoint = "intake";
  try {
    const opened = openContext(input.root, deps);
    if ("error" in opened) return errorOutput(point, opened.error, { explain: input.explain });
    const ctx = opened.ctx;
    if (!ctx.en.enabled) {
      return disabledOutput(point, ctx.en.reason ?? "disabled_mode_off", { root: ctx.ws.root, c2c: ctx.c2c, explain: input.explain });
    }
    if (typeof input.request !== "string" || input.request.trim() === "") {
      return errorOutput(point, "missing --request", { explain: input.explain });
    }
    const plan = planIntake(ctx, input);
    const connection = await probe(ctx);
    // The main skill's explicit intake on resume: keep the checkpoint's task, never mint a second one.
    const reuseId = plan.explicitFlag && plan.active !== null && TASK_ID_RE.test(plan.active.taskId) ? plan.active.taskId : null;
    const taskId = reuseId ?? mintTaskId((id) => id === plan.active?.taskId || taskStateExists(ctx.ws.id, id));
    const reused = reuseId ? readTaskState(ctx.ws.id, reuseId) : null;
    let state: RouterTaskState;
    if (reuseId) {
      state = reused ?? loadTask(ctx, reuseId).state;
      ctx.warnings = ctx.warnings.filter((w) => w !== "task_state_missing");
      if (plan.noEgress) state.noEgress = true;
    } else {
      state = newTaskState(taskId, ctx.now, {
        goal: localGoal(sliceChars(plan.request, REQUEST_MAX_CHARS)),
        baseline: captureBaseline(ctx.ws),
        noEgress: plan.noEgress,
      });
    }
    const workspaceBusy = isWorkspaceBusy(plan.active, taskId);
    const warm = isWarmChat(ctx.ws, input.threadChat, connection);
    const consentAskedToday = isConsentAskedToday(ctx.prefs, ctx.ws.id, ctx.today);
    const bias = ctx.prefs.bias;

    let result: PolicyResult;
    let jev: JevResult<IntakeAnswers> | null = null;
    let redactions: number | undefined;
    let activeTaskId: string | undefined;
    let sayParams: SayParams = {};
    if (plan.explicit === "codex") {
      result = rule("codex_solo", "explicit_codex", "override", { pin: "codex", intakeRoute: "codex_solo", routedBy: "user" });
    } else if (plan.explicit === "chatgpt") {
      result = rule(
        "chatgpt_plan",
        "explicit_chatgpt",
        "override",
        reuseId
          ? // the user's explicit words bring ChatGPT back even if this task was pinned to codex earlier
            state.pin === "codex"
            ? { engaged: true, pin: null }
            : { engaged: true }
          : plan.explicitFlag
            ? { routedBy: "user", intakeRoute: "chatgpt_plan", engaged: true }
            : { routedBy: "router", pin: "chatgpt", intakeRoute: "chatgpt_plan", engaged: true }
      );
    } else if (plan.staleAskable && plan.active) {
      result = rule("active_task", "active_task_stale", "rule");
      activeTaskId = plan.active.taskId;
      sayParams = { goal40: plan.active.goal40 };
      const staleTaskId = plan.active.taskId;
      prefsWrite(ctx, () => markStaleAsked(ctx.ws.id, ctx.today, staleTaskId));
    } else if (plan.noEgress) {
      result = rule("codex_solo", "no_egress", "rule", { intakeRoute: "codex_solo" });
    } else {
      const intakeCtx: IntakeContext = { bias, connection, warm, workspaceBusy, consentAskedToday };
      if (ctx.en.jevAvailable) {
        const payload = intakePayload(plan.request, input.requestEn, ctx.key);
        if (payload.ok) {
          redactions = payload.redactions;
          jev = await consult(
            ctx,
            "intake",
            payload.state,
            intakeQuestions({ withGloss: "request_en" in (payload.state as Record<string, unknown>) }),
            parseIntakeAnswers,
            intakeProbs
          );
        } else {
          jev = noJev("outbound_rejected");
        }
      } else {
        jev = noJev(ctx.en.jevUnavailable ?? null);
      }
      result = decideIntake(intakeCtx, jev.answers);
    }

    applyDelta(state, result.stateDelta);
    if (result.reason === "connection_consent") prefsWrite(ctx, () => markConsentAsked(ctx.ws.id, ctx.today));
    const signals = withSignals(
      {
        bias,
        connection,
        warm,
        workspaceBusy,
        consentAskedToday,
        explicit: plan.explicit ? (plan.explicitFlag ? "flag" : plan.explicit) : "none",
        noEgress: plan.noEgress,
        threadChat: input.threadChat ?? "none",
        activeStale: plan.active?.stale ?? false,
        jevAvailable: ctx.en.jevAvailable,
        redactions,
      },
      result.signals
    );
    const logId = logDecision(ctx, point, taskId, result, signals, jev, connection);
    // a resumed task keeps its original intake decision for later labels
    if (!reused) state.intakeLogId = logId;
    saveState(ctx, state);
    return build(ctx, {
      point,
      route: result.route,
      reason: result.reason,
      source: result.source,
      taskId,
      sayParams: { ...result.sayParams, ...sayParams },
      logId,
      signals,
      jev,
      explain: input.explain,
      activeTaskId,
      explicitUser: plan.explicitFlag,
      activeCheckpoint: plan.active,
    });
  } catch {
    return errorOutput(point, "internal_error", { explain: input.explain });
  }
}

// ---------------------------------------------------------------- failure (§4.2)

function recordIteration0(ctx: RunContext, task: LoadedTask, input: FailureInput): void {
  let outputId: number | undefined;
  let outputAvailable = false;
  try {
    const meta = saveExecutionOutput(ctx.ws.id, {
      command: input.command,
      raw: input.output,
      exitCode: input.exitCode ?? null,
      taskId: task.state.taskId,
      iteration: 0,
    });
    outputId = meta.id;
    outputAvailable = meta.allowed;
  } catch (error) {
    warn(ctx, `execution_output_write_failed:${errorCode(error)}`);
  }
  try {
    appendExecutionRecord(ctx.ws.id, {
      taskId: task.state.taskId,
      iteration: 0,
      changedFiles: shareablePaths(taskChanges(ctx.ws, task.state.baseline)),
      tests: null,
      exitStatus: "failed",
      timestamp: ctx.now.toISOString(),
      notes: "Codex local attempts before escalation",
      ...(outputId !== undefined ? { outputId } : {}),
      outputAvailable,
    });
  } catch (error) {
    warn(ctx, `execution_record_write_failed:${errorCode(error)}`);
  }
}

export async function runFailure(input: FailureInput, deps: RouterDeps = {}): Promise<RouteOutput> {
  const point: DecisionPoint = "failure";
  try {
    if (typeof input.taskId !== "string" || !TASK_ID_RE.test(input.taskId)) {
      return errorOutput(point, "invalid --task", { explain: input.explain });
    }
    const opened = openContext(input.root, deps);
    if ("error" in opened) return errorOutput(point, opened.error, { taskId: input.taskId, explain: input.explain });
    const ctx = opened.ctx;
    if (!ctx.en.enabled) {
      return disabledOutput(point, ctx.en.reason ?? "disabled_mode_off", { root: ctx.ws.root, c2c: ctx.c2c, explain: input.explain });
    }
    const taskId = input.taskId;
    const task = loadTask(ctx, taskId);
    const { state } = task;
    const key = commandKey(input.command ?? "");
    const lines = extractErrorLines(typeof input.output === "string" ? input.output : "");
    const { failures, counter } = recordFailure(state.failures, key, errorSignature(lines));
    state.failures = failures;
    const regex = needsUserRegex(lines);
    const workspaceBusy = isWorkspaceBusy(task.active, taskId);
    // the checkpoint decides, not the sticky engaged flag (the main workflow may have written it on consent)
    const inLoop = inChatgptLoop(task);
    const consentAskedToday = isConsentAskedToday(ctx.prefs, ctx.ws.id, ctx.today);

    let connection: Connection | null = null;
    let jev: JevResult<FailureAnswers> | null = null;
    let redactions: number | undefined;
    let skippedByRule = false;
    if (counter.consecutive >= 2) {
      connection = await probe(ctx);
      if (!ctx.en.jevAvailable) {
        jev = noJev(ctx.en.jevUnavailable ?? null);
      } else if (state.noEgress || regex) {
        // no egress for this task, or the needs-user floor already decides
        skippedByRule = true;
      } else {
        const payload = failurePayload(input.command ?? "", lines, ctx.key);
        if (payload.ok) {
          redactions = payload.redactions;
          jev = await consult(ctx, "failure", payload.state, failureQuestions(), parseFailureAnswers, failureProbs);
        } else {
          jev = noJev("outbound_rejected");
        }
      }
    }

    const failureCtx: FailureContext = {
      bias: ctx.prefs.bias,
      inLoop,
      consecutive: counter.consecutive,
      sameSignatureStreak: counter.sameSignatureStreak,
      uncertainIntake: state.uncertainIntake,
      needsUserRegex: regex,
      heuristicKind: heuristicFailureKind(lines),
      pin: state.pin,
      noEgress: state.noEgress,
      workspaceBusy,
      outSwitches: state.outSwitches,
      reservedReview: reviewReserved(task),
      askedAt: counter.askedAt ?? null,
      connection: connection ?? "not_setup",
      consentAskedToday,
    };
    const result = decideFailure(failureCtx, jev?.answers ?? null);
    if (skippedByRule && result.source === "heuristic") result.source = "rule";
    applyDelta(state, result.stateDelta);

    let controlMessage: string | null = null;
    if (result.route === "escalate_chatgpt") {
      // a new attempt cycle starts once ChatGPT has the problem
      state.failures = resetFailure(state.failures, key);
    } else if (result.reason === "stuck_ask_user" || result.reason === "env_or_flaky_cap") {
      // after "keep going" the same question waits for another full cap of failures; the count and
      // streak stay, so "bring in ChatGPT" (pin chatgpt) escalates on the next failure
      state.failures = markFailureAsked(state.failures, key);
    }
    if (result.reason === "stuck_escalate_debug" || result.reason === "reconnect_consent") {
      recordIteration0(ctx, task, input);
    }
    if (result.reason === "stuck_escalate_debug") {
      controlMessage = buildDebugInit({ taskId, goal: goalFor(task) });
      if (state.intakeRoute === "codex_solo") label(ctx, state.intakeLogId, "escalated_after_solo");
    }
    if (result.reason === "reconnect_consent") prefsWrite(ctx, () => markConsentAsked(ctx.ws.id, ctx.today));

    const signals = withSignals(result.signals, {
      jevAvailable: ctx.en.jevAvailable,
      errorLines: lines.length,
      exitCode: typeof input.exitCode === "number" ? input.exitCode : undefined,
      redactions,
    });
    const logId = logDecision(ctx, point, taskId, result, signals, jev, connection);
    saveState(ctx, state);
    return build(ctx, {
      point,
      route: result.route,
      reason: result.reason,
      source: result.source,
      taskId,
      sayParams: result.sayParams,
      controlMessage,
      logId,
      signals,
      jev,
      explain: input.explain,
    });
  } catch {
    return errorOutput(point, "internal_error", { taskId: input.taskId, explain: input.explain });
  }
}

// ---------------------------------------------------------------- review gate (§4.3)

function recordIteration1(ctx: RunContext, task: LoadedTask, input: ReviewInput, changes: TaskChanges): void {
  let outputId: number | undefined;
  let outputAvailable: boolean | undefined;
  if (input.command && typeof input.output === "string") {
    try {
      const meta = saveExecutionOutput(ctx.ws.id, {
        command: input.command,
        raw: input.output,
        exitCode: input.exitCode ?? null,
        taskId: task.state.taskId,
        iteration: 1,
      });
      outputId = meta.id;
      outputAvailable = meta.allowed;
    } catch (error) {
      warn(ctx, `execution_output_write_failed:${errorCode(error)}`);
    }
  }
  try {
    appendExecutionRecord(ctx.ws.id, {
      taskId: task.state.taskId,
      iteration: 1,
      changedFiles: shareablePaths(changes),
      tests: input.testsSummary ? input.testsSummary.slice(0, 80) : input.tests,
      exitStatus: "ok",
      timestamp: ctx.now.toISOString(),
      ...(outputId !== undefined ? { outputId } : {}),
      ...(outputAvailable !== undefined ? { outputAvailable } : {}),
    });
  } catch (error) {
    warn(ctx, `execution_record_write_failed:${errorCode(error)}`);
  }
}

function writeReviewCheckpoint(ctx: RunContext, task: LoadedTask, userAsked: boolean): void {
  try {
    const goal = goalFor(task);
    const saved = mergeSession(readSession(ctx.ws.id), {
      taskId: task.state.taskId,
      iteration: 1,
      lastState: "EXECUTED",
      checkpoint: {
        taskId: task.state.taskId,
        iteration: 1,
        protocolState: "EXECUTED_LOCAL",
        waitingFor: "none",
        initMode: "REVIEW",
        routedBy: userAsked ? "user" : "router",
        // a new REVIEW round is never a local follow-up phase
        closeLocal: false,
        originalGoal: goal || undefined,
        nextExpectedStep: "send REVIEW INIT",
      },
    });
    writeSession(ctx.ws.id, saved);
  } catch (error) {
    warn(ctx, `checkpoint_write_failed:${errorCode(error)}`);
  }
}

export async function runReviewGate(input: ReviewInput, deps: RouterDeps = {}): Promise<RouteOutput> {
  const point: DecisionPoint = "review_gate";
  try {
    if (typeof input.taskId !== "string" || !TASK_ID_RE.test(input.taskId)) {
      return errorOutput(point, "invalid --task", { explain: input.explain });
    }
    const opened = openContext(input.root, deps);
    if ("error" in opened) return errorOutput(point, opened.error, { taskId: input.taskId, explain: input.explain });
    const ctx = opened.ctx;
    if (!ctx.en.enabled) {
      return disabledOutput(point, ctx.en.reason ?? "disabled_mode_off", { root: ctx.ws.root, c2c: ctx.c2c, explain: input.explain });
    }
    const taskId = input.taskId;
    const task = loadTask(ctx, taskId);
    const { state } = task;
    const changes = taskChanges(ctx.ws, state.baseline);
    const categories = classifyPaths(changes.paths);
    const workspaceBusy = isWorkspaceBusy(task.active, taskId);
    const connection = await probe(ctx);
    const userAskedReview = input.userAskedReview === true;
    if (input.tests === "passed") state.failures = [];

    const reviewCtx: ReviewContext = {
      bias: ctx.prefs.bias,
      engaged: reviewEngaged(task, userAskedReview),
      wasEngaged: state.engaged,
      tests: input.tests,
      isGitRepo: changes.isGitRepo,
      files: changes.files,
      lines: changes.lines,
      bucket: sizeBucket(changes.files, changes.lines),
      categories,
      headMoved: changes.headMoved,
      userAskedReview,
      intakeRoute: state.intakeRoute,
      intendedReview: state.intendedReview,
      mechanical: state.mechanical,
      pin: state.pin,
      noEgress: state.noEgress,
      workspaceBusy,
      outSwitches: state.outSwitches,
      connection,
      consentAskedToday: isConsentAskedToday(ctx.prefs, ctx.ws.id, ctx.today),
    };
    const result = decideReviewGate(reviewCtx);
    applyDelta(state, result.stateDelta);

    let controlMessage: string | null = null;
    let sayParams: SayParams = result.sayParams ?? {};
    if (result.route === "active_task" && task.active) sayParams = { ...sayParams, goal40: task.active.goal40 };
    if (result.route === "send_review") {
      recordIteration1(ctx, task, input, changes);
      writeReviewCheckpoint(ctx, task, userAskedReview);
      controlMessage = buildReviewInit({ taskId, goal: goalFor(task) });
      if (state.intakeRoute === "codex_solo") label(ctx, state.intakeLogId, "escalated_after_solo");
    }
    if (result.reason === "reconnect_consent") prefsWrite(ctx, () => markConsentAsked(ctx.ws.id, ctx.today));

    const signals = withSignals(result.signals, {
      jevAvailable: ctx.en.jevAvailable,
      sensitiveFiles: changes.sensitivePaths.length,
    });
    const logId = logDecision(ctx, point, taskId, result, signals, null, connection);
    saveState(ctx, state);
    return build(ctx, {
      point,
      route: result.route,
      reason: result.reason,
      source: result.source,
      taskId,
      sayParams,
      controlMessage,
      logId,
      signals,
      jev: null,
      explain: input.explain,
    });
  } catch {
    return errorOutput(point, "internal_error", { taskId: input.taskId, explain: input.explain });
  }
}

// ---------------------------------------------------------------- reply (§4.4)

export async function runReply(input: ReplyInput, deps: RouterDeps = {}): Promise<RouteOutput> {
  const point: DecisionPoint = "reply";
  try {
    if (typeof input.taskId !== "string" || !TASK_ID_RE.test(input.taskId)) {
      return errorOutput(point, "invalid --task", { explain: input.explain });
    }
    if (!Number.isSafeInteger(input.iteration) || input.iteration < 0) {
      return errorOutput(point, "invalid --iteration", { taskId: input.taskId, explain: input.explain });
    }
    const opened = openContext(input.root, deps);
    if ("error" in opened) return errorOutput(point, opened.error, { taskId: input.taskId, explain: input.explain });
    const ctx = opened.ctx;
    if (!ctx.en.enabled) {
      return disabledOutput(point, ctx.en.reason ?? "disabled_mode_off", { root: ctx.ws.root, c2c: ctx.c2c, explain: input.explain });
    }
    const taskId = input.taskId;
    const task = loadTask(ctx, taskId);
    // the floor reads the whole raw section: Codex applies all of it, not just the parsed ≤ 300-char items
    const { items, riskItem } = analyzeFollowups(typeof input.followupsText === "string" ? input.followupsText : "");
    const tooMany = items.length > MAX_LOCAL_FOLLOWUPS;

    let jev: JevResult<ReplyAnswers> | null = null;
    let redactions: number | undefined;
    let skippedByRule = false;
    if (items.length === 0 || tooMany || riskItem || task.state.noEgress) {
      skippedByRule = ctx.en.jevAvailable;
      if (!ctx.en.jevAvailable) jev = noJev(ctx.en.jevUnavailable ?? null);
    } else if (!ctx.en.jevAvailable) {
      jev = noJev(ctx.en.jevUnavailable ?? null);
    } else {
      const payload = replyPayload(items, ctx.key);
      if (payload.ok) {
        redactions = payload.redactions;
        const n = items.length;
        jev = await consult(
          ctx,
          "reply",
          payload.state,
          replyQuestions(n),
          (answers) => parseReplyAnswers(answers, n),
          replyProbs
        );
      } else {
        jev = noJev("outbound_rejected");
      }
    }

    const result = decideReply(
      {
        bias: ctx.prefs.bias,
        itemCount: items.length,
        riskItem,
        iteration: input.iteration,
        maxIterations: validMaxIterations(ctx.ws.projectConfig.maxIterations),
      },
      jev?.answers ?? null
    );
    if (skippedByRule && result.source === "heuristic") result.source = "rule";
    const signals = withSignals(result.signals, { jevAvailable: ctx.en.jevAvailable, redactions });
    const logId = logDecision(ctx, point, taskId, result, signals, jev, null);
    return build(ctx, {
      point,
      route: result.route,
      reason: result.reason,
      source: result.source,
      taskId,
      sayParams: result.sayParams,
      logId,
      signals,
      jev,
      explain: input.explain,
      n1: input.iteration + 1,
    });
  } catch {
    return errorOutput(point, "internal_error", { taskId: input.taskId, explain: input.explain });
  }
}

// ---------------------------------------------------------------- --dry-run (sends nothing, writes nothing)

export interface DryRunOutput {
  point: "intake" | "failure" | "reply";
  ok: boolean;
  enabled: boolean;
  wouldSend: boolean;
  state: unknown;
  questionIds: string[];
  model: string;
  qsv: string;
  error?: string;
}

export async function dryRun(
  point: "intake" | "failure" | "reply",
  input: unknown,
  deps: RouterDeps = {}
): Promise<DryRunOutput> {
  const base = { point, ok: true, enabled: false, wouldSend: false, state: null as unknown, questionIds: [] as string[], qsv: QUESTION_SET_VERSION };
  try {
    const root = (input as { root?: unknown } | null)?.root;
    if (typeof root !== "string") return { ...base, ok: false, model: readRouterPrefs().model, error: "invalid_input" };
    const opened = openContext(root, deps);
    if ("error" in opened) return { ...base, ok: false, model: readRouterPrefs().model, error: opened.error };
    const ctx = opened.ctx;
    const model = ctx.prefs.model;
    if (!ctx.en.enabled) return { ...base, model };
    const jevOk = ctx.en.jevAvailable;

    if (point === "intake") {
      const i = input as IntakeInput;
      if (typeof i.request !== "string" || i.request.trim() === "") return { ...base, ok: false, enabled: true, model, error: "missing --request" };
      const plan = planIntake(ctx, i);
      const payload = intakePayload(plan.request, i.requestEn, ctx.key);
      const gated = plan.explicit !== null || plan.staleAskable || plan.noEgress;
      return {
        ...base,
        enabled: true,
        model,
        wouldSend: jevOk && !gated && payload.ok,
        state: payload.ok ? payload.state : null,
        questionIds: [...INTAKE_QUESTION_IDS],
      };
    }

    const taskId = (input as { taskId?: unknown }).taskId;
    if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) return { ...base, ok: false, enabled: true, model, error: "invalid --task" };
    const task = loadTask(ctx, taskId);
    const { state } = task;

    if (point === "failure") {
      const f = input as FailureInput;
      const lines = extractErrorLines(typeof f.output === "string" ? f.output : "");
      const { counter } = recordFailure(state.failures, commandKey(f.command ?? ""), errorSignature(lines));
      const payload = failurePayload(f.command ?? "", lines, ctx.key);
      const gated = counter.consecutive < 2 || state.noEgress || needsUserRegex(lines);
      return {
        ...base,
        enabled: true,
        model,
        wouldSend: jevOk && !gated && payload.ok,
        state: payload.ok ? payload.state : null,
        questionIds: [...FAILURE_QUESTION_IDS],
      };
    }

    const r = input as ReplyInput;
    const { items, riskItem } = analyzeFollowups(typeof r.followupsText === "string" ? r.followupsText : "");
    const payload = items.length > 0 ? replyPayload(items, ctx.key) : ({ ok: false } as Payload);
    const gated = items.length === 0 || items.length > MAX_LOCAL_FOLLOWUPS || riskItem || state.noEgress;
    return {
      ...base,
      enabled: true,
      model,
      wouldSend: jevOk && !gated && payload.ok,
      state: payload.ok ? payload.state : null,
      questionIds: items.length > 0 ? replyQuestionIds(Math.min(items.length, 12)) : [],
    };
  } catch {
    return { ...base, ok: false, model: "jev-unknown", error: "internal_error" };
  }
}

// ---------------------------------------------------------------- pin (§4.5)

export type PinRoute = Pin | "none";

export interface PinInput {
  root: string;
  taskId: string;
  route: PinRoute;
}

export interface PinOutput extends Omit<RouteOutput, "point" | "activeCheckpoint" | "explain"> {
  point: "pin";
  pin: Pin | null;
  checkpointCleared: boolean;
  warnings?: string[];
}

function isPreSendReview(checkpoint: TaskCheckpoint | null): boolean {
  return checkpoint !== null && checkpoint.protocolState === "EXECUTED_LOCAL" && checkpoint.initMode === "REVIEW";
}

export async function runPin(input: PinInput, deps: RouterDeps = {}): Promise<PinOutput> {
  const fail = (error: string, taskId: string | null = null): PinOutput => ({
    ...errorOutput("intake", error, { taskId }),
    point: "pin",
    pin: null,
    checkpointCleared: false,
  });
  try {
    if (typeof input.taskId !== "string" || !TASK_ID_RE.test(input.taskId)) return fail("invalid --task");
    if (input.route !== "chatgpt" && input.route !== "codex" && input.route !== "none") return fail("invalid --route", input.taskId);
    const opened = openContext(input.root, deps);
    if ("error" in opened) return fail(opened.error, input.taskId);
    const ctx = opened.ctx;
    if (!ctx.en.enabled) {
      return {
        ...disabledOutput("intake", ctx.en.reason ?? "disabled_mode_off", { root: ctx.ws.root, c2c: ctx.c2c }),
        point: "pin",
        pin: null,
        checkpointCleared: false,
      };
    }
    const taskId = input.taskId;
    const existed = readTaskState(ctx.ws.id, taskId) !== null;
    const task = loadTask(ctx, taskId);
    // pinning before intake (or after a lost state file) simply starts the state
    ctx.warnings = ctx.warnings.filter((w) => w !== "task_state_missing");
    const { state } = task;
    let checkpointCleared = false;
    let route: Route;

    if (input.route === "codex") {
      state.pin = "codex";
      state.engaged = false;
      if (isPreSendReview(task.own)) {
        try {
          writeSession(ctx.ws.id, mergeSession(readSession(ctx.ws.id), { clearCheckpoint: true }));
          checkpointCleared = true;
        } catch (error) {
          warn(ctx, `checkpoint_write_failed:${errorCode(error)}`);
        }
      }
      if (existed && state.intakeRoute !== "codex_solo") label(ctx, state.intakeLogId, "override");
      route = "codex_solo";
    } else if (input.route === "chatgpt") {
      // no `engaged` here: the INIT / review checkpoint (or a send_review / DEBUG escalation) engages ChatGPT
      state.pin = "chatgpt";
      if (existed && state.intakeRoute === "codex_solo") label(ctx, state.intakeLogId, "override");
      route = "chatgpt_plan";
    } else {
      state.pin = null;
      route = task.own !== null ? "continue_loop" : "codex_solo";
    }
    saveState(ctx, state);
    const out: PinOutput = {
      ok: true,
      enabled: true,
      point: "pin",
      route,
      reason: "pinned",
      source: "override",
      taskId,
      pin: state.pin,
      say: null,
      next: renderNext(route, "pinned", { taskId, root: ctx.ws.root, c2c: ctx.c2c }),
      controlMessage: null,
      logId: null,
      checkpointCleared,
    };
    if (ctx.warnings.length > 0) out.warnings = [...ctx.warnings];
    return out;
  } catch {
    return fail("internal_error", input.taskId);
  }
}

// ---------------------------------------------------------------- message (§4.5)

export interface MessageOutput {
  ok: boolean;
  taskId: string | null;
  mode: "REVIEW" | "DEBUG";
  controlMessage: string | null;
  error?: string;
}

/** Regenerates the REVIEW / DEBUG INIT on resume. Local reads only; works whether or not routing is enabled. */
export function buildControlMessage(root: string, taskId: string, kind: "review-init" | "debug-init"): MessageOutput {
  const mode = kind === "review-init" ? "REVIEW" : "DEBUG";
  if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) {
    return { ok: false, taskId: null, mode, controlMessage: null, error: "invalid --task" };
  }
  try {
    let ws: Workspace;
    try {
      ws = new Workspace(root);
    } catch {
      return { ok: false, taskId, mode, controlMessage: null, error: "workspace_not_found" };
    }
    const state = readTaskState(ws.id, taskId);
    let checkpointGoal = "";
    try {
      const checkpoint = readSession(ws.id)?.checkpoint;
      if (checkpoint?.taskId === taskId && checkpoint.originalGoal) checkpointGoal = flatten(checkpoint.originalGoal);
    } catch {
      checkpointGoal = "";
    }
    const goal = state?.goal || checkpointGoal;
    const controlMessage = mode === "REVIEW" ? buildReviewInit({ taskId, goal }) : buildDebugInit({ taskId, goal });
    return { ok: true, taskId, mode, controlMessage };
  } catch {
    return { ok: false, taskId, mode, controlMessage: null, error: "internal_error" };
  }
}

// ---------------------------------------------------------------- status (§4.5)

export type JevStatus =
  | "not_checked"
  | "reachable"
  | "network_blocked"
  | "auth_failed"
  | "rate_limited"
  | "no_key"
  | "unavailable";

export interface StatusOutput {
  ok: boolean;
  enabled: boolean;
  mode: RouterPrefs["mode"];
  bias: RouterPrefs["bias"];
  model: string;
  consent: ConsentStatus;
  key: KeyStatus;
  breaker: { open: boolean; until: string | null; reason: JevErrorClass | null };
  jev: JevStatus;
  jevError?: JevErrorClass;
  workspace?: { setup: boolean; disabled: boolean; connection: Connection };
  error?: string;
}

function jevStatusFor(error: JevErrorClass, breakerReason: JevErrorClass | null): JevStatus {
  switch (error) {
    case "no_key":
      return "no_key";
    case "network_blocked":
    case "timeout":
      return "network_blocked";
    case "auth":
      return "auth_failed";
    case "rate_limited":
      return "rate_limited";
    case "breaker_open":
      return breakerReason === "auth" ? "auth_failed" : breakerReason === "rate_limited" ? "rate_limited" : "unavailable";
    default:
      return "unavailable";
  }
}

export async function routerStatus(opts: { root?: string; probe?: boolean }, deps: RouterDeps = {}): Promise<StatusOutput> {
  const env = deps.env ?? process.env;
  const prefs = readRouterPrefs();
  const consent = consentStatus();
  const key = keyStatus(env);
  const resolved = resolveApiKey(env);
  const breakerView = readBreaker(resolved ? { fingerprint: resolved.fingerprint } : {});
  const out: StatusOutput = {
    ok: true,
    enabled: prefs.mode === "auto" && consent.accepted,
    mode: prefs.mode,
    bias: prefs.bias,
    model: prefs.model,
    consent,
    key,
    breaker: { open: breakerView.open, until: breakerView.until, reason: breakerView.reason },
    jev: "not_checked",
  };
  if (env.CODEX_SANDBOX_NETWORK_DISABLED === "1") out.jev = "network_blocked";
  else if (!resolved) out.jev = "no_key";
  if (opts.probe) {
    const outcome = await probeJev({ model: prefs.model }, { fetch: deps.fetch, env });
    if (outcome.ok) {
      out.jev = "reachable";
    } else {
      out.jev = jevStatusFor(outcome.error, readBreaker(resolved ? { fingerprint: resolved.fingerprint } : {}).reason);
      out.jevError = outcome.error;
    }
  }
  if (opts.root !== undefined) {
    let ws: Workspace;
    try {
      ws = new Workspace(opts.root);
    } catch {
      return { ...out, ok: false, error: "workspace_not_found" };
    }
    const en = resolveEnablement(ws, env);
    out.enabled = en.enablement.enabled;
    out.workspace = {
      setup: readLastEndpoint(ws.id) !== null,
      disabled: prefs.disabledWorkspaces.includes(ws.id),
      connection: await probeConnection(ws, { timeoutMs: 1000, deps: { ...deps.connection, env } }),
    };
  }
  return out;
}
