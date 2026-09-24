/**
 * Shared contract for the smart router (`c2c route …`).
 *
 * The router decides when Codex should bring in ChatGPT (web, via MCP) and when
 * work should switch back to Codex alone. Code owns the workflow and policy;
 * TypeSafe Jev only answers narrow typed questions. See docs/routing.md.
 *
 * Every string that leaves the router through a trusted channel (`next`, `say`,
 * the decision log) is built from the enums below — never from input text.
 */

export type DecisionPoint = "intake" | "failure" | "review_gate" | "reply";
export const DECISION_POINTS: readonly DecisionPoint[] = ["intake", "failure", "review_gate", "reply"];

export type RouterMode = "off" | "auto";
export const ROUTER_MODES: readonly RouterMode[] = ["off", "auto"];

export type RouterBias = "economy" | "balanced" | "speed";
export const ROUTER_BIASES: readonly RouterBias[] = ["economy", "balanced", "speed"];

export type Connection = "ready" | "ready_after_restart" | "needs_repair" | "needs_project" | "not_setup";
export const CONNECTIONS: readonly Connection[] = [
  "ready",
  "ready_after_restart",
  "needs_repair",
  "needs_project",
  "not_setup",
];

export type Route =
  | "disabled"
  | "codex_solo"
  | "codex_then_review"
  | "chatgpt_plan"
  | "ask_user"
  | "active_task"
  | "keep_fixing"
  | "escalate_chatgpt"
  | "close_local"
  | "send_review"
  | "fix_first"
  | "continue_loop"
  | "apply_followups_local"
  | "apply_followups_then_review";
export const ROUTES: readonly Route[] = [
  "disabled",
  "codex_solo",
  "codex_then_review",
  "chatgpt_plan",
  "ask_user",
  "active_task",
  "keep_fixing",
  "escalate_chatgpt",
  "close_local",
  "send_review",
  "fix_first",
  "continue_loop",
  "apply_followups_local",
  "apply_followups_then_review",
];

/** Routes a user may pin a task to. */
export type Pin = "chatgpt" | "codex";

export type Source = "jev" | "heuristic" | "override" | "rule";
export const SOURCES: readonly Source[] = ["jev", "heuristic", "override", "rule"];

export type ReasonCode =
  // enablement
  | "disabled_mode_off"
  | "disabled_no_consent"
  | "disabled_workspace"
  | "not_setup"
  // intake
  | "explicit_chatgpt"
  | "explicit_codex"
  | "no_egress"
  | "active_task_stale"
  | "workspace_busy"
  | "not_coding"
  | "goal_unclear"
  | "plan_offload"
  | "review_band"
  | "risk_floor"
  | "low_offload"
  | "connection_consent"
  | "connection_unavailable"
  | "heuristic_default"
  // failure
  | "first_failure"
  | "below_cap"
  | "needs_user"
  | "env_or_flaky_cap"
  | "stuck_in_loop"
  | "stuck_escalate_debug"
  | "stuck_ask_user"
  | "reconnect_consent"
  // review gate
  | "in_loop"
  | "tests_failed"
  | "nothing_to_review"
  | "committed"
  | "user_asked"
  | "escalation_unavailable"
  | "intended_review"
  | "high_risk_paths"
  | "large_diff"
  | "small_safe"
  // reply
  | "followups_minor"
  | "followups_substantive"
  | "followups_risky"
  | "followups_too_many"
  | "followups_none"
  // pin / misc
  | "pinned"
  | "invalid_input"
  | "internal_error";
export const REASON_CODES: readonly ReasonCode[] = [
  "disabled_mode_off",
  "disabled_no_consent",
  "disabled_workspace",
  "not_setup",
  "explicit_chatgpt",
  "explicit_codex",
  "no_egress",
  "active_task_stale",
  "workspace_busy",
  "not_coding",
  "goal_unclear",
  "plan_offload",
  "review_band",
  "risk_floor",
  "low_offload",
  "connection_consent",
  "connection_unavailable",
  "heuristic_default",
  "first_failure",
  "below_cap",
  "needs_user",
  "env_or_flaky_cap",
  "stuck_in_loop",
  "stuck_escalate_debug",
  "stuck_ask_user",
  "reconnect_consent",
  "in_loop",
  "tests_failed",
  "nothing_to_review",
  "committed",
  "user_asked",
  "escalation_unavailable",
  "intended_review",
  "high_risk_paths",
  "large_diff",
  "small_safe",
  "followups_minor",
  "followups_substantive",
  "followups_risky",
  "followups_too_many",
  "followups_none",
  "pinned",
  "invalid_input",
  "internal_error",
];

export type TaskKind =
  | "question_or_explanation"
  | "run_command_or_ops"
  | "targeted_change"
  | "mechanical_bulk_change"
  | "new_feature"
  | "debug_unknown_cause"
  | "refactor_or_restructure"
  | "design_or_architecture"
  | "review_existing_changes";
export const TASK_KINDS: readonly TaskKind[] = [
  "question_or_explanation",
  "run_command_or_ops",
  "targeted_change",
  "mechanical_bulk_change",
  "new_feature",
  "debug_unknown_cause",
  "refactor_or_restructure",
  "design_or_architecture",
  "review_existing_changes",
];

export type FailureKind =
  | "compile_or_type_error"
  | "missing_module_or_dependency"
  | "assertion_mismatch"
  | "runtime_exception"
  | "environment_or_tooling"
  | "timeout_or_flaky"
  | "other";
export const FAILURE_KINDS: readonly FailureKind[] = [
  "compile_or_type_error",
  "missing_module_or_dependency",
  "assertion_mismatch",
  "runtime_exception",
  "environment_or_tooling",
  "timeout_or_flaky",
  "other",
];

export type PathCategory =
  | "auth_security"
  | "payments"
  | "data_migration"
  | "ci_pipeline"
  | "agent_config"
  | "install_scripts"
  | "deps_manifest"
  | "infra"
  | "config"
  | "tests"
  | "docs"
  | "other";
export const PATH_CATEGORIES: readonly PathCategory[] = [
  "auth_security",
  "payments",
  "data_migration",
  "ci_pipeline",
  "agent_config",
  "install_scripts",
  "deps_manifest",
  "infra",
  "config",
  "tests",
  "docs",
  "other",
];

export type SizeBucket = "tiny" | "small" | "medium" | "large" | "xlarge";
export const SIZE_BUCKETS: readonly SizeBucket[] = ["tiny", "small", "medium", "large", "xlarge"];

export type TestsStatus = "passed" | "failed" | "not_run";
export const TESTS_STATUSES: readonly TestsStatus[] = ["passed", "failed", "not_run"];

export type IntakeRoute = "codex_solo" | "codex_then_review" | "chatgpt_plan";

export type JevErrorClass =
  | "no_key"
  | "breaker_open"
  | "network_blocked"
  | "timeout"
  | "rate_limited"
  | "auth"
  | "server"
  | "bad_request"
  | "invalid_response"
  | "outbound_rejected";
export const JEV_ERROR_CLASSES: readonly JevErrorClass[] = [
  "no_key",
  "breaker_open",
  "network_blocked",
  "timeout",
  "rate_limited",
  "auth",
  "server",
  "bad_request",
  "invalid_response",
  "outbound_rejected",
];

/** Question ids used in Jev requests (and as keys in the numbers-only decision log). */
export type QuestionId =
  | "task_kind"
  | "scope"
  | "needs_design"
  | "goal_is_clear"
  | "touches_auth_security"
  | "touches_stored_data"
  | "touches_concurrency"
  | "changes_public_interface"
  | "failure_kind"
  | "needs_user"
  | `followup_${number}_size`;

export const TASK_ID_RE = /^c2c_[0-9a-f]{4}$/;
export const LOG_ID_RE = /^r_[0-9a-f]{8}$/;

// ---------------------------------------------------------------- per-task router state

export interface FailureCounter {
  commandKey: string;
  consecutive: number;
  sameSignatureStreak: number;
  lastSignature: string;
  /** `consecutive` when the router last asked the user about this command (stuck_ask_user / env_or_flaky_cap). */
  askedAt?: number;
}

export interface Baseline {
  head: string | null;
  /** rel path → `<mode>:<HEAD blob>:<content sha1>:<size>` (tracked) or `<content sha1>:<size>` (untracked); "sensitive:<mtimeMs>" for sensitive paths. */
  entries: Record<string, string>;
  truncated: boolean;
}

/** Stored at `<stateDir>/routing/<workspaceId>/tasks/<taskId>.json` (0600, best effort). */
export interface RouterTaskState {
  v: 1;
  taskId: string;
  createdAt: string;
  updatedAt: string;
  routedBy: "user" | "router";
  intakeRoute: IntakeRoute;
  /** Intake wanted a review but the connection was not ready. */
  intendedReview: boolean;
  /** User request, sanitized, ≤ 400 bytes UTF-8. Local only (used for controlMessage GOAL). */
  goal: string;
  pin: Pin | null;
  /** ChatGPT has been (or is being) brought into this task. */
  engaged: boolean;
  /** Automatic switches Codex → ChatGPT for this task (cap 1). */
  outSwitches: number;
  /** The request asked for confidentiality → no Jev, no automatic ChatGPT. */
  noEgress: boolean;
  uncertainIntake: boolean;
  mechanical: boolean;
  baseline: Baseline | null;
  /** At most 10 entries. */
  failures: FailureCounter[];
  intakeLogId: string | null;
  consentAskedFor: "none" | "plan" | "review";
}

// ---------------------------------------------------------------- policy inputs

/** Probabilities parsed from the intake Jev answers. */
export interface IntakeAnswers {
  taskKind: Record<TaskKind, number>;
  taskKindConfidence: number;
  /** P(level) for scope levels 0..5. */
  scope: [number, number, number, number, number, number];
  scopeConfidence: number;
  needsDesign: number;
  goalIsClear: number;
  risk: { auth: number; data: number; concurrency: number; publicInterface: number };
}

export interface IntakeContext {
  bias: RouterBias;
  connection: Connection;
  /** A ChatGPT chat is already open in this Codex thread and the connection is ready. */
  warm: boolean;
  workspaceBusy: boolean;
  consentAskedToday: boolean;
}

export interface FailureAnswers {
  kind: Record<FailureKind, number>;
  kindConfidence: number;
  needsUser: number;
}

export interface FailureContext {
  bias: RouterBias;
  inLoop: boolean;
  consecutive: number;
  sameSignatureStreak: number;
  uncertainIntake: boolean;
  needsUserRegex: boolean;
  heuristicKind: FailureKind;
  pin: Pin | null;
  noEgress: boolean;
  workspaceBusy: boolean;
  outSwitches: number;
  /** A codex_then_review intake still holds the task's one out-switch for its review (not spent yet). */
  reservedReview: boolean;
  /**
   * `consecutive` when the router last asked the user about this command (null / absent: never).
   * The same question comes back only after another full cap of failures.
   */
  askedAt?: number | null;
  connection: Connection;
  consentAskedToday: boolean;
}

export interface ReviewContext {
  bias: RouterBias;
  /** The task is in a live ChatGPT loop: it owns the workspace checkpoint (and is not pinned to codex). */
  engaged: boolean;
  /** ChatGPT has been brought into this task at some point (sticky; spends a codex_then_review reservation). */
  wasEngaged: boolean;
  tests: TestsStatus;
  isGitRepo: boolean;
  files: number;
  lines: number;
  bucket: SizeBucket;
  categories: PathCategory[];
  headMoved: boolean;
  userAskedReview: boolean;
  intakeRoute: IntakeRoute;
  intendedReview: boolean;
  mechanical: boolean;
  pin: Pin | null;
  noEgress: boolean;
  workspaceBusy: boolean;
  outSwitches: number;
  connection: Connection;
  consentAskedToday: boolean;
}

export interface ReplyAnswers {
  /** P(level ≥ 2) per follow-up item. */
  levelsGe2: number[];
}

export interface ReplyContext {
  bias: RouterBias;
  itemCount: number;
  riskItem: boolean;
  iteration: number;
  maxIterations: number;
}

export interface SayParams {
  n?: number;
  categoryZh?: string;
  goal40?: string;
}

export type SignalValue = number | boolean | string | string[];

export interface PolicyResult {
  route: Route;
  reason: ReasonCode;
  source: Source;
  /** Numbers / booleans / enum strings only. */
  signals: Record<string, SignalValue>;
  sayParams?: SayParams;
  stateDelta?: Partial<RouterTaskState>;
}

// ---------------------------------------------------------------- CLI output

export interface ActiveCheckpointView {
  taskId: string;
  protocolState: string;
  waitingFor: string;
  ageHours: number;
  routedBy: "user" | "router";
  stale: boolean;
  goal40: string;
}

export interface RouteExplain {
  signals: Record<string, SignalValue>;
  answers: Record<string, number | number[]>;
  thresholds: Record<string, number>;
  model: string | null;
  latencyMs: number;
  usage: { input_tokens: number; output_tokens: number } | null;
  jevError: JevErrorClass | null;
  warnings: string[];
  qsv: string;
}

/** JSON printed by `c2c route <point> --json`. Always exit code 0. */
export interface RouteOutput {
  /** false only for invalid usage / internal error. */
  ok: boolean;
  enabled: boolean;
  point: DecisionPoint;
  route: Route;
  reason: ReasonCode;
  source: Source;
  /** ^c2c_[0-9a-f]{4}$ */
  taskId: string | null;
  /** Chinese, ≤ 160 chars, template-built. */
  say: string | null;
  /** English instruction for Codex, template-built. */
  next: string;
  /** ≤ 1000 bytes; only REVIEW / DEBUG INIT. */
  controlMessage: string | null;
  /** "r_" + 8 hex */
  logId: string | null;
  activeCheckpoint?: ActiveCheckpointView | null;
  error?: string;
  explain?: RouteExplain;
}

// ---------------------------------------------------------------- run inputs (validated by the CLI layer)

export interface IntakeInput {
  root: string;
  request: string;
  requestEn?: string;
  explicit?: "chatgpt";
  threadChat?: "open" | "none";
  explain?: boolean;
  dryRun?: boolean;
}

export interface FailureInput {
  root: string;
  taskId: string;
  command: string;
  /** Raw output (already read from --output-file through guardLocalInput, or --output). */
  output: string;
  exitCode?: number;
  explain?: boolean;
  dryRun?: boolean;
}

export interface ReviewInput {
  root: string;
  taskId: string;
  tests: TestsStatus;
  testsSummary?: string;
  command?: string;
  output?: string;
  exitCode?: number;
  userAskedReview?: boolean;
  explain?: boolean;
}

export interface ReplyInput {
  root: string;
  taskId: string;
  iteration: number;
  followupsText: string;
  explain?: boolean;
  dryRun?: boolean;
}

// ---------------------------------------------------------------- decision log

export interface DecisionLogLine {
  v: 1;
  kind: "decision";
  ts: string;
  logId: string;
  taskId: string | null;
  point: DecisionPoint;
  route: Route;
  reason: ReasonCode;
  source: Source;
  bias: RouterBias;
  connection: Connection | null;
  qsv: string;
  model: string | null;
  latencyMs: number;
  usage: { in: number; out: number } | null;
  jevError: JevErrorClass | null;
  probs: Record<string, number | number[]>;
  signals: Record<string, number | boolean | string | string[]>;
}

export interface LabelLogLine {
  v: 1;
  kind: "label";
  ts: string;
  logId: string;
  label: "override" | "escalated_after_solo";
}

export interface FeedbackLogLine {
  v: 1;
  kind: "feedback";
  ts: string;
  logId: string;
  verdict: "right" | "wrong";
  expected?: Route;
}

export type RouterLogLine = DecisionLogLine | LabelLogLine | FeedbackLogLine;

export interface RouterStats {
  tasks: number;
  byIntakeRoute: Record<IntakeRoute, number>;
  reviewsSent: number;
  debugEscalations: number;
  followupsLocal: number;
  corrections: number;
  sources: Record<Source, number>;
  jevErrors: number;
  latencyP50: number | null;
  latencyP95: number | null;
}
