import {
  FAILURE_KINDS,
  SIZE_BUCKETS,
  type Connection,
  type DecisionPoint,
  type FailureAnswers,
  type FailureContext,
  type FailureKind,
  type IntakeAnswers,
  type IntakeContext,
  type IntakeRoute,
  type PathCategory,
  type PolicyResult,
  type ReasonCode,
  type ReplyAnswers,
  type ReplyContext,
  type ReviewContext,
  type Route,
  type RouterBias,
  type RouterTaskState,
  type SayParams,
  type SignalValue,
  type SizeBucket,
  type Source,
} from "./types.js";
import { firstCategoryLabelZh } from "./messages.js";

export interface Thresholds {
  tPlan: Readonly<Record<RouterBias, number>>;
  warmAdj: number;
  band: Readonly<Record<RouterBias, number | null>>;
  riskFloor: number;
  capBase: Readonly<Record<RouterBias, number>>;
  reviewSize: Readonly<Record<RouterBias, SizeBucket | null>>;
  followupTheta: Readonly<Record<RouterBias, number>>;
  goalUnclear: number;
  light: number;
  mech: number;
  kindConfidence: number;
  needsUser: number;
}

export const THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  tPlan: Object.freeze({ economy: 0.4, balanced: 0.55, speed: 0.75 }),
  warmAdj: 0.05,
  band: Object.freeze({ economy: null, balanced: 0.15, speed: null }),
  riskFloor: 0.6,
  capBase: Object.freeze({ economy: 2, balanced: 3, speed: 4 }),
  reviewSize: Object.freeze({ economy: "xlarge", balanced: "large", speed: null }),
  followupTheta: Object.freeze({ economy: 0.35, balanced: 0.25, speed: 0.4 }),
  goalUnclear: 0.3,
  light: 0.6,
  mech: 0.6,
  kindConfidence: 0.4,
  needsUser: 0.6,
});

/** planOffload = 0.45·P_scope4 + 0.35·needs_design + 0.20·P_hard (§4.1). */
export const PLAN_OFFLOAD_WEIGHTS = Object.freeze({ scope4: 0.45, needsDesign: 0.35, hard: 0.2 });
/**
 * economy / balanced: a request that is mainly a design question with an open approach goes to
 * ChatGPT for a plan whatever its scope (planning is exactly what ChatGPT web is for).
 */
export const DESIGN_SHORTCUT = Object.freeze({ design: 0.5, needsDesign: 0.6 });
const DESIGN_SHORTCUT_BIASES: ReadonlySet<RouterBias> = new Set<RouterBias>(["economy", "balanced"]);
/**
 * When the argmax failure kind is not confident, the probability mass of kinds that share a
 * policy branch (env/flaky: never escalate; compile/missing: cap + 1) still decides the branch.
 */
export const FAILURE_BRANCH_MASS = 0.5;
const ENV_KINDS: readonly FailureKind[] = ["environment_or_tooling", "timeout_or_flaky"];
const BUILD_KINDS: readonly FailureKind[] = ["compile_or_type_error", "missing_module_or_dependency"];
/** uncertainIntake = both task_kind and scope confidences below this. */
export const UNCERTAIN_CONFIDENCE = 0.35;
/** needsUserRegex raises needsUser to at least this. */
export const NEEDS_USER_REGEX_FLOOR = 0.7;
/** More follow-up items than this always go back to ChatGPT. */
export const MAX_LOCAL_FOLLOWUPS = 8;
export const MIN_FAILURE_CAP = 2;

export const HIGH_RISK_PATH_CATEGORIES: readonly PathCategory[] = [
  "auth_security",
  "payments",
  "data_migration",
  "ci_pipeline",
  "agent_config",
  "install_scripts",
];

/** Every key a decide* function may put in `signals` (numbers, booleans, enum strings only). */
export const POLICY_SIGNAL_IDS = [
  "bias",
  "connection",
  "warm",
  "workspaceBusy",
  "consentAskedToday",
  "P_light",
  "P_mech",
  "P_hard",
  "P_scope4",
  "maxRisk",
  "planOffload",
  "tPlan",
  "desired",
  "designShortcut",
  "mechanical",
  "uncertainIntake",
  "consecutive",
  "sameSignatureStreak",
  "cap",
  "kind",
  "needsUser",
  "needsUserRegex",
  "stuck",
  "inLoop",
  "canEngage",
  "pin",
  "outSwitches",
  "reservedReview",
  "askedAt",
  "noEgress",
  "engaged",
  "wasEngaged",
  "tests",
  "isGitRepo",
  "files",
  "lines",
  "bucket",
  "categories",
  "highCategory",
  "headMoved",
  "userAskedReview",
  "intakeRoute",
  "intendedReview",
  "want",
  "itemCount",
  "tooMany",
  "riskItem",
  "maxLevelGe2",
  "iteration",
  "maxIterations",
  "atIterationLimit",
] as const;

type SignalId = (typeof POLICY_SIGNAL_IDS)[number];
type Signals = Partial<Record<SignalId, SignalValue>>;

const EPS = 1e-9;
const READY: ReadonlySet<Connection> = new Set<Connection>(["ready", "ready_after_restart"]);
const REPAIRABLE: ReadonlySet<Connection> = new Set<Connection>(["needs_repair", "needs_project"]);

/** Inclusive threshold test that ignores float noise (0.35 + 0.2 counts as ≥ 0.55). */
function ge(value: number, threshold: number): boolean {
  return value >= threshold - EPS;
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function p(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function signals(s: Signals): Record<string, SignalValue> {
  const out: Record<string, SignalValue> = {};
  for (const [key, value] of Object.entries(s)) {
    if (value === undefined) continue;
    out[key] = typeof value === "number" ? round(value) : value;
  }
  return out;
}

function result(
  route: Route,
  reason: ReasonCode,
  source: Source,
  sig: Record<string, SignalValue>,
  extra: { sayParams?: SayParams; stateDelta?: Partial<RouterTaskState> } = {}
): PolicyResult {
  const out: PolicyResult = { route, reason, source, signals: sig };
  if (extra.sayParams && Object.keys(extra.sayParams).length > 0) out.sayParams = extra.sayParams;
  if (extra.stateDelta && Object.keys(extra.stateDelta).length > 0) out.stateDelta = extra.stateDelta;
  return out;
}

function consentAllowed(connection: Connection, bias: RouterBias, consentAskedToday: boolean): boolean {
  return REPAIRABLE.has(connection) && bias !== "speed" && !consentAskedToday;
}

// ---------------------------------------------------------------- intake (§4.1 steps 1–7)

/**
 * Explicit phrases, noEgress and the stale-checkpoint exit are handled by the orchestrator
 * before this runs. `answers === null` is the heuristic path: it never escalates.
 */
export function decideIntake(ctx: IntakeContext, answers: IntakeAnswers | null): PolicyResult {
  const base: Signals = {
    bias: ctx.bias,
    connection: ctx.connection,
    warm: ctx.warm,
    workspaceBusy: ctx.workspaceBusy,
    consentAskedToday: ctx.consentAskedToday,
  };
  if (!answers) {
    return result("codex_solo", "heuristic_default", "heuristic", signals(base), {
      stateDelta: { intakeRoute: "codex_solo" },
    });
  }

  const kind = answers.taskKind;
  const pLight = p(kind.question_or_explanation) + p(kind.run_command_or_ops);
  const pMech = p(kind.mechanical_bulk_change);
  const pHard = p(kind.design_or_architecture) + p(kind.debug_unknown_cause) + p(kind.refactor_or_restructure);
  const pScope4 = p(answers.scope[4]) + p(answers.scope[5]);
  const maxRisk = Math.max(
    p(answers.risk.auth),
    p(answers.risk.data),
    p(answers.risk.concurrency),
    p(answers.risk.publicInterface)
  );
  const mechanical = ge(pMech, THRESHOLDS.mech);
  const planOffload = mechanical
    ? 0
    : PLAN_OFFLOAD_WEIGHTS.scope4 * pScope4 +
      PLAN_OFFLOAD_WEIGHTS.needsDesign * p(answers.needsDesign) +
      PLAN_OFFLOAD_WEIGHTS.hard * pHard;
  const uncertainIntake =
    !ge(p(answers.taskKindConfidence), UNCERTAIN_CONFIDENCE) && !ge(p(answers.scopeConfidence), UNCERTAIN_CONFIDENCE);
  const tPlan = THRESHOLDS.tPlan[ctx.bias] - (ctx.warm ? THRESHOLDS.warmAdj : 0);
  const band = THRESHOLDS.band[ctx.bias];

  const designShortcut =
    !mechanical &&
    DESIGN_SHORTCUT_BIASES.has(ctx.bias) &&
    ge(p(kind.design_or_architecture), DESIGN_SHORTCUT.design) &&
    ge(p(answers.needsDesign), DESIGN_SHORTCUT.needsDesign);

  let desired: IntakeRoute = "codex_solo";
  let desiredReason: ReasonCode = "low_offload";
  if (ge(planOffload, tPlan) || designShortcut) {
    desired = "chatgpt_plan";
    desiredReason = "plan_offload";
  } else if (ge(maxRisk, THRESHOLDS.riskFloor)) {
    desired = "codex_then_review";
    desiredReason = "risk_floor";
  } else if (band !== null && ge(planOffload, tPlan - band)) {
    desired = "codex_then_review";
    desiredReason = "review_band";
  }

  const sig = signals({
    ...base,
    P_light: pLight,
    P_mech: pMech,
    P_hard: pHard,
    P_scope4: pScope4,
    maxRisk,
    planOffload,
    tPlan,
    desired,
    designShortcut,
    mechanical,
    uncertainIntake,
  });
  const learned: Partial<RouterTaskState> = { mechanical, uncertainIntake };
  const out = (route: Route, reason: ReasonCode, delta: Partial<RouterTaskState> = {}) =>
    result(route, reason, "jev", sig, { stateDelta: { ...learned, ...delta } });

  if (ge(pLight, THRESHOLDS.light)) return out("codex_solo", "not_coding", { intakeRoute: "codex_solo" });
  if (desired === "codex_solo") return out("codex_solo", "low_offload", { intakeRoute: "codex_solo" });
  if (!ge(p(answers.goalIsClear), THRESHOLDS.goalUnclear)) return out("ask_user", "goal_unclear");
  if (ctx.workspaceBusy) return out("codex_solo", "workspace_busy", { intakeRoute: "codex_solo" });
  if (READY.has(ctx.connection)) {
    return out(desired, desiredReason, {
      intakeRoute: desired,
      outSwitches: 1,
      engaged: desired === "chatgpt_plan",
    });
  }
  if (desired === "chatgpt_plan" && consentAllowed(ctx.connection, ctx.bias, ctx.consentAskedToday)) {
    return out("ask_user", "connection_consent", { consentAskedFor: "plan" });
  }
  // desired is chatgpt_plan or codex_then_review here (codex_solo returned above): both want at
  // least a review of the result once the connection is back
  return out("codex_solo", "connection_unavailable", {
    intakeRoute: "codex_solo",
    intendedReview: true,
  });
}

// ---------------------------------------------------------------- failure (§4.2)

function argmaxKind(probs: Record<FailureKind, number>): FailureKind {
  let best: FailureKind = "other";
  let bestP = -1;
  for (const kind of FAILURE_KINDS) {
    const value = p(probs[kind]);
    if (value > bestP) {
      best = kind;
      bestP = value;
    }
  }
  return best;
}

function branchMass(probs: Record<FailureKind, number>, kinds: readonly FailureKind[]): number {
  return kinds.reduce((sum, kind) => sum + p(probs[kind]), 0);
}

function pickWithin(probs: Record<FailureKind, number>, kinds: readonly FailureKind[]): FailureKind {
  return kinds.reduce((best, kind) => (p(probs[kind]) > p(probs[best]) ? kind : best), kinds[0]);
}

/** Confident argmax as before; otherwise the branch (env/flaky or compile/missing) whose mass ≥ 0.5, else "other". */
export function resolveFailureKind(a: FailureAnswers): FailureKind {
  if (ge(p(a.kindConfidence), THRESHOLDS.kindConfidence)) return argmaxKind(a.kind);
  const env = branchMass(a.kind, ENV_KINDS);
  const build = branchMass(a.kind, BUILD_KINDS);
  if (ge(env, FAILURE_BRANCH_MASS) && env >= build) return pickWithin(a.kind, ENV_KINDS);
  if (ge(build, FAILURE_BRANCH_MASS)) return pickWithin(a.kind, BUILD_KINDS);
  return "other";
}

export function failureCap(bias: RouterBias, uncertainIntake: boolean, kind: FailureKind): number {
  const cap = Math.max(MIN_FAILURE_CAP, THRESHOLDS.capBase[bias] - (uncertainIntake ? 1 : 0));
  return kind === "compile_or_type_error" || kind === "missing_module_or_dependency" ? cap + 1 : cap;
}

/**
 * `answers === null` is the heuristic path: kind from `ctx.heuristicKind`, needsUser from the
 * regex only. Escalation still happens on code-counted repeats. Jev can only raise needsUser.
 */
export function decideFailure(ctx: FailureContext, answers: FailureAnswers | null): PolicyResult {
  const sayParams: SayParams = { n: ctx.consecutive };
  const counts: Signals = {
    bias: ctx.bias,
    consecutive: ctx.consecutive,
    sameSignatureStreak: ctx.sameSignatureStreak,
    inLoop: ctx.inLoop,
  };
  if (ctx.consecutive <= 1) {
    return result("keep_fixing", "first_failure", "rule", signals(counts), { sayParams });
  }

  const modeSource: Source = answers ? "jev" : "heuristic";
  const regexFloor = ctx.needsUserRegex ? NEEDS_USER_REGEX_FLOOR : 0;
  const jevNeedsUser = answers ? p(answers.needsUser) : 0;
  const needsUser = Math.max(jevNeedsUser, regexFloor);
  const kind: FailureKind = answers ? resolveFailureKind(answers) : ctx.heuristicKind;
  const cap = failureCap(ctx.bias, ctx.uncertainIntake, kind);
  const stuck = ctx.sameSignatureStreak >= cap || ctx.consecutive >= cap + 2;
  const engageable = !ctx.noEgress && !ctx.workspaceBusy;
  // a codex_then_review intake's reserved (unspent) review switch may be spent on a DEBUG escalation instead
  const reserved = ctx.reservedReview === true;
  const underCap = ctx.outSwitches < 1 || reserved;
  const canEngageUnpinned = engageable && underCap;
  const canEngage = ctx.pin !== "codex" && engageable && (underCap || ctx.pin === "chatgpt");
  const pinSource: Source = canEngage !== canEngageUnpinned ? "override" : modeSource;
  // once the user was asked (stuck_ask_user / env_or_flaky_cap), the same question waits for another full cap
  const askedAt = typeof ctx.askedAt === "number" ? ctx.askedAt : null;
  const askAgain = askedAt === null || ctx.consecutive - askedAt >= cap;

  const sig = signals({
    ...counts,
    cap,
    kind,
    needsUser,
    needsUserRegex: ctx.needsUserRegex,
    stuck,
    canEngage,
    pin: ctx.pin ?? "none",
    outSwitches: ctx.outSwitches,
    reservedReview: reserved,
    askedAt: askedAt ?? undefined,
    noEgress: ctx.noEgress,
    workspaceBusy: ctx.workspaceBusy,
    uncertainIntake: ctx.uncertainIntake,
    connection: ctx.connection,
    consentAskedToday: ctx.consentAskedToday,
  });
  const out = (route: Route, reason: ReasonCode, source: Source, stateDelta?: Partial<RouterTaskState>) =>
    result(route, reason, source, sig, { sayParams, stateDelta });

  if (ge(needsUser, THRESHOLDS.needsUser)) {
    const floorOnly = answers !== null && !ge(jevNeedsUser, THRESHOLDS.needsUser);
    return out("ask_user", "needs_user", floorOnly ? "rule" : modeSource);
  }
  if (kind === "environment_or_tooling" || kind === "timeout_or_flaky") {
    return ctx.consecutive >= cap + 1 && askAgain
      ? out("ask_user", "env_or_flaky_cap", modeSource)
      : out("keep_fixing", "below_cap", modeSource);
  }
  if (!stuck) return out("keep_fixing", "below_cap", modeSource);
  if (ctx.inLoop) return out("escalate_chatgpt", "stuck_in_loop", modeSource);
  if (canEngage && READY.has(ctx.connection)) {
    return out("escalate_chatgpt", "stuck_escalate_debug", pinSource, {
      outSwitches: reserved ? Math.max(1, ctx.outSwitches) : ctx.outSwitches + 1,
      engaged: true,
    });
  }
  if (canEngage && consentAllowed(ctx.connection, ctx.bias, ctx.consentAskedToday)) {
    return out("ask_user", "reconnect_consent", pinSource);
  }
  if (ctx.consecutive >= cap + 2 && askAgain) return out("ask_user", "stuck_ask_user", pinSource);
  return out("keep_fixing", "below_cap", pinSource);
}

// ---------------------------------------------------------------- review gate (§4.3 steps 0–9, deterministic)

function bucketAtLeast(bucket: SizeBucket, min: SizeBucket | null): boolean {
  return min !== null && SIZE_BUCKETS.indexOf(bucket) >= SIZE_BUCKETS.indexOf(min);
}

export function decideReviewGate(ctx: ReviewContext): PolicyResult {
  const highCategory = ctx.categories.find((c) => HIGH_RISK_PATH_CATEGORIES.includes(c)) ?? null;
  const categoryZh = highCategory ? firstCategoryLabelZh([highCategory]) : undefined;
  const sayParams: SayParams = categoryZh ? { categoryZh } : {};

  // A codex_then_review intake reserves the task's one out-switch for this review (until ChatGPT is brought in).
  const reservedReview =
    ctx.intakeRoute === "codex_then_review" && !ctx.engaged && ctx.wasEngaged !== true && ctx.outSwitches <= 1;
  const capReached = ctx.outSwitches >= 1 && !reservedReview;
  const blockedUnpinned = ctx.noEgress || ctx.workspaceBusy || capReached;
  const blocked = ctx.pin === "codex" || ctx.noEgress || ctx.workspaceBusy || (capReached && ctx.pin !== "chatgpt");
  const intended = ctx.intakeRoute === "codex_then_review" || ctx.intendedReview;
  const largeDiff = !ctx.mechanical && bucketAtLeast(ctx.bucket, THRESHOLDS.reviewSize[ctx.bias]);
  const wantUnpinned = intended || highCategory !== null || largeDiff;
  const want = wantUnpinned || ctx.pin === "chatgpt";

  const sig = signals({
    bias: ctx.bias,
    engaged: ctx.engaged,
    wasEngaged: ctx.wasEngaged === true,
    tests: ctx.tests,
    isGitRepo: ctx.isGitRepo,
    files: ctx.files,
    lines: ctx.lines,
    bucket: ctx.bucket,
    categories: [...new Set(ctx.categories)],
    highCategory: highCategory ?? "none",
    headMoved: ctx.headMoved,
    userAskedReview: ctx.userAskedReview,
    intakeRoute: ctx.intakeRoute,
    intendedReview: ctx.intendedReview,
    mechanical: ctx.mechanical,
    pin: ctx.pin ?? "none",
    noEgress: ctx.noEgress,
    workspaceBusy: ctx.workspaceBusy,
    outSwitches: ctx.outSwitches,
    connection: ctx.connection,
    consentAskedToday: ctx.consentAskedToday,
    want,
  });
  const out = (route: Route, reason: ReasonCode, source: Source, stateDelta?: Partial<RouterTaskState>) =>
    result(route, reason, source, sig, { sayParams, stateDelta });

  if (ctx.engaged) return out("continue_loop", "in_loop", "rule");
  if (ctx.tests === "failed") return out("fix_first", "tests_failed", "rule");
  if (!ctx.isGitRepo || ctx.files === 0) {
    return out("close_local", ctx.isGitRepo && ctx.headMoved ? "committed" : "nothing_to_review", "rule");
  }
  if (ctx.userAskedReview) {
    // one ChatGPT task per workspace: never replace another task's live checkpoint without the user
    return ctx.workspaceBusy
      ? out("active_task", "workspace_busy", "rule")
      : out("send_review", "user_asked", "override", { engaged: true });
  }

  const pinDecided = blocked !== blockedUnpinned || (want && !wantUnpinned);
  const source: Source = pinDecided ? "override" : "rule";
  if (blocked) return out("close_local", "escalation_unavailable", source);
  if (!want) return out("close_local", "small_safe", source);
  if (READY.has(ctx.connection)) {
    const reason: ReasonCode =
      intended || !wantUnpinned ? "intended_review" : highCategory ? "high_risk_paths" : "large_diff";
    return out("send_review", reason, source, {
      engaged: true,
      outSwitches: reservedReview ? Math.max(1, ctx.outSwitches) : ctx.outSwitches + 1,
    });
  }
  if (consentAllowed(ctx.connection, ctx.bias, ctx.consentAskedToday)) {
    return out("ask_user", "reconnect_consent", source, { consentAskedFor: "review" });
  }
  return out("close_local", "escalation_unavailable", source);
}

// ---------------------------------------------------------------- reply (§4.4)

/**
 * Local apply never counts as a ChatGPT round, so `iteration + 1 > maxIterations` changes
 * nothing here (reported as `atIterationLimit`). `answers === null` runs steps 1, 2 and 4.
 */
export function decideReply(ctx: ReplyContext, answers: ReplyAnswers | null): PolicyResult {
  const tooMany = ctx.itemCount > MAX_LOCAL_FOLLOWUPS;
  const theta = THRESHOLDS.followupTheta[ctx.bias];
  // An unreadable or missing level counts as substantive: fail toward another review.
  const levels = answers
    ? Array.from({ length: Math.max(ctx.itemCount, answers.levelsGe2.length) }, (_, i) => {
        const v = answers.levelsGe2[i];
        return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
      })
    : [];
  const maxLevelGe2 = levels.length > 0 ? Math.max(...levels) : 0;
  const sig = signals({
    bias: ctx.bias,
    itemCount: ctx.itemCount,
    tooMany,
    riskItem: ctx.riskItem,
    maxLevelGe2: answers ? maxLevelGe2 : undefined,
    iteration: ctx.iteration,
    maxIterations: ctx.maxIterations,
    atIterationLimit: ctx.iteration + 1 > ctx.maxIterations,
  });
  const heuristic = answers === null;
  const src = (source: Source): Source => (heuristic ? "heuristic" : source);

  if (tooMany) return result("apply_followups_then_review", "followups_too_many", src("rule"), sig);
  if (ctx.riskItem) return result("apply_followups_then_review", "followups_risky", src("rule"), sig);
  // "FOLLOWUPS: none" (or an empty list): a plain DONE, nothing to apply
  if (ctx.itemCount === 0) return result("close_local", "followups_none", "rule", sig);
  if (!heuristic && levels.some((v) => ge(v, theta))) {
    return result("apply_followups_then_review", "followups_substantive", "jev", sig);
  }
  return result("apply_followups_local", "followups_minor", src("jev"), sig);
}

// ---------------------------------------------------------------- --explain

export function explainThresholds(point: DecisionPoint, bias: RouterBias): Record<string, number> {
  switch (point) {
    case "intake": {
      const band = THRESHOLDS.band[bias];
      return {
        tPlan: THRESHOLDS.tPlan[bias],
        warmAdj: THRESHOLDS.warmAdj,
        ...(band === null ? {} : { band }),
        riskFloor: THRESHOLDS.riskFloor,
        goalUnclear: THRESHOLDS.goalUnclear,
        light: THRESHOLDS.light,
        mech: THRESHOLDS.mech,
        uncertainConfidence: UNCERTAIN_CONFIDENCE,
        ...(DESIGN_SHORTCUT_BIASES.has(bias)
          ? { designShortcutDesign: DESIGN_SHORTCUT.design, designShortcutNeedsDesign: DESIGN_SHORTCUT.needsDesign }
          : {}),
      };
    }
    case "failure":
      return {
        capBase: THRESHOLDS.capBase[bias],
        minCap: MIN_FAILURE_CAP,
        kindConfidence: THRESHOLDS.kindConfidence,
        branchMass: FAILURE_BRANCH_MASS,
        needsUser: THRESHOLDS.needsUser,
        needsUserRegexFloor: NEEDS_USER_REGEX_FLOOR,
      };
    case "review_gate": {
      const size = THRESHOLDS.reviewSize[bias];
      return size === null ? {} : { reviewSizeBucket: SIZE_BUCKETS.indexOf(size) };
    }
    case "reply":
      return { followupTheta: THRESHOLDS.followupTheta[bias], maxLocalFollowups: MAX_LOCAL_FOLLOWUPS };
  }
}
