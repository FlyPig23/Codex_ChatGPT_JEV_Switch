import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { EntryType, Fetch, Questions } from "@typesafe-ai/sdk";
import { readRouterPrefs } from "../config/router-prefs.js";
import { heuristicFailureKind, needsUserRegex } from "./heuristics.js";
import { askJev, DEFAULT_MODEL, jevCallOptions } from "./jev.js";
import { buildDebugInit, renderNext, renderSay } from "./messages.js";
import { sanitizeForThirdParty } from "./outbound.js";
import { decideFailure, decideIntake, decideReply, MAX_LOCAL_FOLLOWUPS } from "./policy.js";
import {
  QUESTION_SET_VERSION,
  failureQuestions,
  intakeQuestions,
  parseFailureAnswers,
  parseIntakeAnswers,
  parseReplyAnswers,
  replyQuestions,
} from "./questions.js";
import { resolveApiKey, type ResolvedKey } from "./secrets.js";
import { analyzeFollowups, detectExplicitRoute, detectNoEgress, extractErrorLines, parseFollowups } from "./signals.js";
import {
  FAILURE_KINDS,
  JEV_ERROR_CLASSES,
  ROUTER_BIASES,
  ROUTES,
  TASK_KINDS,
  type Connection,
  type DecisionPoint,
  type FailureAnswers,
  type FailureKind,
  type IntakeAnswers,
  type JevErrorClass,
  type PolicyResult,
  type ReasonCode,
  type ReplyAnswers,
  type Route,
  type RouterBias,
  type Source,
} from "./types.js";

/**
 * `c2c route eval` (plan §8.3).
 *
 * Offline (always runs): deterministic checks over the bundled fixtures — explicit /
 * no-egress regexes, heuristic failure kinds, first-failure and floor rules, heuristic
 * routes — plus a policy replay with ideal answers synthesized from the labels (one-hot
 * 0.9 with the rest spread evenly; Nouls 0.9 / 0.1). Both must be 100%.
 * `replay` re-applies the current policy to answers saved by `--live --save-answers`.
 * `live` asks Jev once per fixture through the real outbound pipeline and questions.
 *
 * Fixtures live in <checkout>/src/router/fixtures. tsc does not copy JSON into dist/, so the
 * directory is resolved two levels up from this file: src/router/ (tsx) and dist/router/
 * (built) both land on the checkout root.
 *
 * Tag conventions the deterministic checks read:
 * - intake: `explicit_chatgpt` / `explicit_codex` (detectExplicitRoute must return it, and
 *   null otherwise), `no_egress` (detectNoEgress must be true, and false otherwise).
 * - reply: `risky` (some item trips followupIsRisky), `too_many` (more than 8 items).
 * - any set: `injection` — a live route that differs from `expected` is an injection violation.
 * Adversarial fixtures carry `point`, a `canary` that must never reach `next` / `say`, and
 * the `clean` text without the injection (deterministic signals must not change).
 */

export type EvalPoint = "intake" | "failure" | "reply";
export const EVAL_POINTS: readonly EvalPoint[] = ["intake", "failure", "reply"];
export type EvalLang = "zh" | "en" | "mixed";
export type LangKey = "all" | EvalLang | "zhAny";
export type FixtureSetName = "intake" | "failure" | "reply" | "adversarial";

export const FIXTURE_MINIMUMS = Object.freeze({ intake: 60, failure: 25, reply: 20, adversarial: 10, intakeZhShare: 0.6 });

/** Documented release bar for recommending `mode auto` (not enforced). */
export const RELEASE_CRITERIA = Object.freeze({ agreement: 0.85, agreementZh: 0.8, intakeP95Ms: 1500 });

const EVAL_CONCURRENCY = 4;
const MAX_ISSUES = 100;
const MAX_SAVED_BYTES = 16 * 1024 * 1024;
const IDEAL_TOP = 0.9;
const EVAL_TASK_ID = "c2c_e0a1";
const EVAL_ACTIVE_TASK_ID = "c2c_e0a2";
const EVAL_ROOT = "/workspace/eval";
const EVAL_C2C = 'node "/checkout/bin/c2c.js"';
const DEFAULT_FAILURE_GOAL = "Make the failing command pass";
const FATAL_ERRORS: ReadonlySet<JevErrorClass> = new Set(["no_key", "network_blocked", "auth", "breaker_open"]);
const ESCALATING_INTAKE: ReadonlySet<Route> = new Set(["chatgpt_plan", "codex_then_review"]);

// ---------------------------------------------------------------- fixture schemas

function enumOf<T extends string>(values: readonly T[]) {
  return z.enum(values as unknown as [T, ...T[]]);
}

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);
const tagsSchema = z.array(z.string().regex(/^[a-z0-9_]{1,32}$/)).max(12);
const routeSchema = enumOf(ROUTES);
const biasRoutesSchema = z.object({ economy: routeSchema, balanced: routeSchema, speed: routeSchema }).strict();
const connectionSchema = z.enum(["ready", "ready_after_restart", "needs_repair", "needs_project"]);
const canarySchema = z.string().regex(/^CANARY-[0-9a-f]{6}$/);

const intakeFixtureShape = z
  .object({
    id: idSchema,
    lang: z.enum(["zh", "en", "mixed"]),
    request: z.string().min(1).max(1500),
    request_en: z.string().min(1).max(200).optional(),
    tags: tagsSchema,
    labels: z
      .object({
        task_kind: enumOf(TASK_KINDS),
        scope: z.number().int().min(0).max(5),
        needs_design: z.boolean(),
        goal_is_clear: z.boolean(),
        touches_auth_security: z.boolean(),
        touches_stored_data: z.boolean(),
        touches_concurrency: z.boolean(),
        changes_public_interface: z.boolean(),
      })
      .strict(),
    context: z
      .object({
        connection: connectionSchema,
        warm: z.boolean(),
        workspaceBusy: z.boolean(),
        consentAskedToday: z.boolean(),
      })
      .partial()
      .strict()
      .optional(),
    expected: biasRoutesSchema,
    heuristicExpected: routeSchema,
  })
  .strict();

const failureStepShape = z
  .object({
    attempt: z.number().int().min(1).max(20),
    sameSignature: z.boolean(),
    inLoop: z.boolean(),
    expected: biasRoutesSchema,
    heuristicExpected: biasRoutesSchema.optional(),
  })
  .strict();

const failureFixtureShape = z
  .object({
    id: idSchema,
    lang: z.enum(["zh", "en"]),
    command: z.string().min(1).max(300),
    output: z.string().min(1).max(16_000),
    goal: z.string().min(1).max(300).optional(),
    tags: tagsSchema,
    labels: z.object({ failure_kind: enumOf(FAILURE_KINDS), needs_user: z.boolean() }).strict(),
    heuristic: z.object({ kind: enumOf(FAILURE_KINDS), needsUserRegex: z.boolean() }).strict().optional(),
    context: z
      .object({
        connection: connectionSchema,
        uncertainIntake: z.boolean(),
        pin: z.enum(["chatgpt", "codex"]).nullable(),
        outSwitches: z.number().int().min(0).max(3),
        reservedReview: z.boolean(),
        noEgress: z.boolean(),
        workspaceBusy: z.boolean(),
        consentAskedToday: z.boolean(),
      })
      .partial()
      .strict()
      .optional(),
    sequence: z.array(failureStepShape).min(1).max(12),
  })
  .strict();

const replyFixtureShape = z
  .object({
    id: idSchema,
    lang: z.enum(["zh", "en", "mixed"]),
    followups: z.string().min(1).max(16_000),
    tags: tagsSchema,
    labels: z.object({ levels: z.array(z.number().int().min(0).max(3)).min(1).max(12) }).strict(),
    context: z
      .object({ iteration: z.number().int().min(0).max(100), maxIterations: z.number().int().min(1).max(100) })
      .partial()
      .strict()
      .optional(),
    expected: biasRoutesSchema,
    heuristicExpected: routeSchema,
  })
  .strict();

const adversarialExtra = { canary: canarySchema, clean: z.string().min(1).max(16_000) };

export const intakeFixtureSchema = intakeFixtureShape;
export const failureFixtureSchema = failureFixtureShape;
export const replyFixtureSchema = replyFixtureShape;
export const adversarialFixtureSchema = z.discriminatedUnion("point", [
  intakeFixtureShape.extend({ point: z.literal("intake"), ...adversarialExtra }),
  failureFixtureShape.extend({ point: z.literal("failure"), ...adversarialExtra }),
  replyFixtureShape.extend({ point: z.literal("reply"), ...adversarialExtra }),
]);

export type IntakeFixture = z.infer<typeof intakeFixtureShape>;
export type FailureFixture = z.infer<typeof failureFixtureShape>;
export type FailureStep = z.infer<typeof failureStepShape>;
export type ReplyFixture = z.infer<typeof replyFixtureShape>;
export type AdversarialFixture = z.infer<typeof adversarialFixtureSchema>;

export interface FixtureSet {
  dir: string;
  intake: IntakeFixture[];
  failure: FailureFixture[];
  reply: ReplyFixture[];
  adversarial: AdversarialFixture[];
  /** Schema, minimum-count, zh-share and cross-field problems. Empty when the set is valid. */
  errors: string[];
}

/** <checkout>/src/router/fixtures, from both src/router/eval.ts (tsx) and dist/router/eval.js (tsc). */
export function fixturesDir(): string {
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return path.join(checkout, "src", "router", "fixtures");
}

function readFixtureFile<T>(dir: string, name: string, schema: z.ZodType<T>, errors: string[]): T[] {
  const file = path.join(dir, `${name}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    errors.push(`${name}.json: unreadable or invalid JSON`);
    return [];
  }
  if (!Array.isArray(raw)) {
    errors.push(`${name}.json: expected a top-level array`);
    return [];
  }
  const out: T[] = [];
  raw.forEach((item, index) => {
    const parsed = schema.safeParse(item);
    if (parsed.success) {
      out.push(parsed.data);
      return;
    }
    const id = typeof (item as { id?: unknown })?.id === "string" ? (item as { id: string }).id : `#${index}`;
    for (const issue of parsed.error.issues.slice(0, 5)) {
      errors.push(`${name}.json ${id}: ${issue.path.join(".") || "(root)"} ${issue.code}`);
    }
  });
  return out;
}

export function loadFixtures(dir: string = fixturesDir()): FixtureSet {
  const errors: string[] = [];
  const set: FixtureSet = {
    dir,
    intake: readFixtureFile(dir, "intake", intakeFixtureShape, errors),
    failure: readFixtureFile(dir, "failure", failureFixtureShape, errors),
    reply: readFixtureFile(dir, "reply", replyFixtureShape, errors),
    adversarial: readFixtureFile(dir, "adversarial", adversarialFixtureSchema, errors),
    errors,
  };
  errors.push(...validateFixtureSet(set));
  return set;
}

export function intakeZhShare(fixtures: readonly IntakeFixture[]): number | null {
  if (fixtures.length === 0) return null;
  return round(fixtures.filter((f) => f.lang !== "en").length / fixtures.length);
}

function adversarialText(f: AdversarialFixture): string {
  return f.point === "intake" ? f.request : f.point === "failure" ? f.output : f.followups;
}

function validateSequence(where: string, sequence: readonly FailureStep[], errors: string[]): void {
  sequence.forEach((step, i) => {
    if (step.attempt !== i + 1) errors.push(`${where}: sequence attempts must be 1..n in order`);
    if (step.attempt === 1 && step.sameSignature) errors.push(`${where}: attempt 1 cannot repeat a signature`);
  });
}

function validateIntake(where: string, f: IntakeFixture, errors: string[]): void {
  if (f.context?.warm && (f.context.connection ?? "ready") !== "ready") {
    errors.push(`${where}: warm requires connection ready`);
  }
  if (f.tags.includes("explicit_chatgpt") && f.tags.includes("explicit_codex")) {
    errors.push(`${where}: both explicit tags`);
  }
}

/** Every `examples` string in a question set (choice / Noul criteria objects, score level arrays). */
export function promptExamples(questions: Questions): string[] {
  const out: string[] = [];
  for (const question of Object.values(questions)) {
    const criteria = (question as { criteria?: unknown }).criteria;
    const entries = Array.isArray(criteria) ? criteria : Object.values((criteria ?? {}) as Record<string, unknown>);
    for (const entry of entries) {
      const examples = (entry as { examples?: unknown } | null)?.examples;
      if (Array.isArray(examples)) for (const e of examples) if (typeof e === "string") out.push(e);
    }
  }
  return out;
}

/** Case, whitespace and punctuation do not hide a copied example. */
export function normalizeForOverlap(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/** A copy with a word or two changed ("the cart" for "the list") is still a copy. */
export const NEAR_COPY_COVERAGE = 0.8;
/** Shorter normalized examples ("run the tests") are only checked for exact containment. */
export const NEAR_COPY_MIN_CHARS = 8;

function bigramCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < text.length; i++) {
    const bigram = text.slice(i, i + 2);
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }
  return counts;
}

function bigramCoverage(have: Map<string, number>, example: string): number {
  const left = new Map(have);
  let total = 0;
  let hit = 0;
  for (let i = 0; i + 1 < example.length; i++) {
    const bigram = example.slice(i, i + 2);
    total++;
    const n = left.get(bigram) ?? 0;
    if (n > 0) {
      hit++;
      left.set(bigram, n - 1);
    }
  }
  return total === 0 ? 0 : hit / total;
}

/**
 * Share of the example's character bigrams found inside one window of the text about the
 * example's length (both normalized), so a long text does not match by collecting common
 * bigrams from all over.
 */
export function nearCopyScore(normalizedText: string, normalizedExample: string): number {
  if (normalizedExample.length < 2 || normalizedText.length < 2) return 0;
  // cheap bound first: the whole text never scores lower than any window of it
  if (bigramCoverage(bigramCounts(normalizedText), normalizedExample) < NEAR_COPY_COVERAGE) return 0;
  const width = Math.min(normalizedText.length, Math.ceil(normalizedExample.length * 1.25) + 2);
  let best = 0;
  for (let i = 0; i + width <= normalizedText.length; i++) {
    best = Math.max(best, bigramCoverage(bigramCounts(normalizedText.slice(i, i + width)), normalizedExample));
    if (best === 1) break;
  }
  return best;
}

/**
 * Held-out check: a fixture whose text contains an in-prompt example, or nearly copies one
 * (≥ 80 % of its bigrams within one window), measures recall of the prompt, not
 * generalization, so live agreement would be inflated. Failure outputs are exempt: canonical
 * error strings (ECONNRESET, EADDRINUSE…) legitimately appear in real tool output.
 */
function checkHeldOut(where: string, texts: readonly (string | undefined)[], examples: readonly string[], errors: string[]): void {
  for (const text of texts) {
    if (!text) continue;
    const normalized = normalizeForOverlap(text);
    const hit = examples.find((example) => normalized.includes(example));
    if (hit !== undefined) {
      errors.push(`${where}: contains the prompt example "${hit}"`);
      continue;
    }
    const near = examples.find(
      (example) => example.length >= NEAR_COPY_MIN_CHARS && nearCopyScore(normalized, example) >= NEAR_COPY_COVERAGE
    );
    if (near !== undefined) errors.push(`${where}: nearly copies the prompt example "${near}"`);
  }
}

function validateReply(where: string, text: string, levels: readonly number[], errors: string[]): void {
  const items = parseFollowups(text).length;
  if (items !== levels.length) errors.push(`${where}: parseFollowups found ${items} items, labels have ${levels.length}`);
}

export function validateFixtureSet(set: Omit<FixtureSet, "errors">): string[] {
  const errors: string[] = [];
  const minimum = (name: keyof typeof FIXTURE_MINIMUMS, count: number) => {
    if (count < FIXTURE_MINIMUMS[name]) errors.push(`${name}: ${count} fixtures, need at least ${FIXTURE_MINIMUMS[name]}`);
  };
  minimum("intake", set.intake.length);
  minimum("failure", set.failure.length);
  minimum("reply", set.reply.length);
  minimum("adversarial", set.adversarial.length);
  const share = intakeZhShare(set.intake);
  if (share === null || share < FIXTURE_MINIMUMS.intakeZhShare) {
    errors.push(`intake: zh/mixed share ${share ?? 0} is below ${FIXTURE_MINIMUMS.intakeZhShare}`);
  }

  const seen = new Set<string>();
  const all: Array<{ set: FixtureSetName; id: string }> = [
    ...set.intake.map((f) => ({ set: "intake" as const, id: f.id })),
    ...set.failure.map((f) => ({ set: "failure" as const, id: f.id })),
    ...set.reply.map((f) => ({ set: "reply" as const, id: f.id })),
    ...set.adversarial.map((f) => ({ set: "adversarial" as const, id: f.id })),
  ];
  for (const { set: name, id } of all) {
    if (seen.has(id)) errors.push(`${name} ${id}: duplicate id`);
    seen.add(id);
  }

  for (const f of set.intake) validateIntake(`intake ${f.id}`, f, errors);
  for (const f of set.failure) validateSequence(`failure ${f.id}`, f.sequence, errors);
  for (const f of set.reply) validateReply(`reply ${f.id}`, f.followups, f.labels.levels, errors);

  const intakeExamples = promptExamples(intakeQuestions({ withGloss: true })).map(normalizeForOverlap);
  const replyExamples = promptExamples(replyQuestions(1)).map(normalizeForOverlap);
  for (const f of set.intake) checkHeldOut(`intake ${f.id}`, [f.request, f.request_en], intakeExamples, errors);
  for (const f of set.reply) checkHeldOut(`reply ${f.id}`, [f.followups], replyExamples, errors);
  for (const f of set.adversarial) {
    if (f.point === "intake") checkHeldOut(`adversarial ${f.id}`, [f.request, f.request_en, f.clean], intakeExamples, errors);
    if (f.point === "reply") checkHeldOut(`adversarial ${f.id}`, [f.followups, f.clean], replyExamples, errors);
  }

  const points = new Set<EvalPoint>();
  for (const f of set.adversarial) {
    const where = `adversarial ${f.id}`;
    points.add(f.point);
    if (!f.tags.includes("injection")) errors.push(`${where}: missing tag injection`);
    const text = adversarialText(f);
    if (!text.includes(f.canary)) errors.push(`${where}: canary missing from the injected text`);
    if (f.clean.includes(f.canary)) errors.push(`${where}: canary present in clean text`);
    if (f.clean === text) errors.push(`${where}: clean text equals the injected text`);
    if (f.point === "intake") validateIntake(where, f, errors);
    if (f.point === "failure") {
      validateSequence(where, f.sequence, errors);
      if (f.goal?.includes(f.canary)) errors.push(`${where}: canary in goal`);
    }
    if (f.point === "reply") {
      validateReply(where, f.followups, f.labels.levels, errors);
      validateReply(`${where} (clean)`, f.clean, f.labels.levels, errors);
    }
  }
  for (const point of EVAL_POINTS) {
    if (set.adversarial.length > 0 && !points.has(point)) errors.push(`adversarial: no fixture for point ${point}`);
  }
  return errors;
}

// ---------------------------------------------------------------- ideal / pushed answers

type RawAnswer = Record<string, unknown>;
/** SDK-shaped answers keyed by question id (numbers and enum labels only). */
export type RawAnswers = Record<string, RawAnswer>;

function choiceAnswer(labels: readonly string[], chosen: string, top = IDEAL_TOP): RawAnswer {
  const rest = labels.length > 1 ? (1 - top) / (labels.length - 1) : 0;
  const probabilities: Record<string, number> = {};
  for (const label of labels) probabilities[label] = label === chosen ? top : rest;
  return { type: "choice", choice: chosen, confidence: top, probabilities };
}

function scoreAnswer(levels: number, chosen: number, top = IDEAL_TOP): RawAnswer {
  const rest = (1 - top) / (levels - 1);
  const probabilities: Record<string, number> = {};
  let expected = 0;
  for (let level = 0; level < levels; level++) {
    const p = level === chosen ? top : rest;
    probabilities[String(level)] = p;
    expected += level * p;
  }
  return { type: "score", score: round(expected), confidence: top, probabilities };
}

function noulAnswer(value: boolean | number): RawAnswer {
  return { type: "noul", noul: typeof value === "number" ? value : value ? IDEAL_TOP : 1 - IDEAL_TOP };
}

export function idealIntakeAnswers(labels: IntakeFixture["labels"]): RawAnswers {
  return {
    task_kind: choiceAnswer(TASK_KINDS, labels.task_kind),
    scope: scoreAnswer(6, labels.scope),
    needs_design: noulAnswer(labels.needs_design),
    goal_is_clear: noulAnswer(labels.goal_is_clear),
    touches_auth_security: noulAnswer(labels.touches_auth_security),
    touches_stored_data: noulAnswer(labels.touches_stored_data),
    touches_concurrency: noulAnswer(labels.touches_concurrency),
    changes_public_interface: noulAnswer(labels.changes_public_interface),
  };
}

export function idealFailureAnswers(labels: FailureFixture["labels"]): RawAnswers {
  return { failure_kind: choiceAnswer(FAILURE_KINDS, labels.failure_kind), needs_user: noulAnswer(labels.needs_user) };
}

export function idealReplyAnswers(levels: readonly number[]): RawAnswers {
  const out: RawAnswers = {};
  levels.forEach((level, i) => {
    out[`followup_${i}_size`] = scoreAnswer(4, level);
  });
  return out;
}

/** Ideal answers for a fixture of any point, keyed like the questions askJev sends. */
export function idealAnswers(point: EvalPoint, fixture: IntakeFixture | FailureFixture | ReplyFixture): RawAnswers {
  if (point === "intake") return idealIntakeAnswers((fixture as IntakeFixture).labels);
  if (point === "failure") return idealFailureAnswers((fixture as FailureFixture).labels);
  return idealReplyAnswers((fixture as ReplyFixture).labels.levels);
}

function pushIntake(toward: "chatgpt" | "solo"): IntakeAnswers {
  const up = toward === "chatgpt";
  return parseIntakeAnswers({
    task_kind: choiceAnswer(TASK_KINDS, up ? "design_or_architecture" : "question_or_explanation", 1),
    scope: scoreAnswer(6, up ? 5 : 0, 1),
    needs_design: noulAnswer(up ? 1 : 0),
    goal_is_clear: noulAnswer(up ? 1 : 0),
    touches_auth_security: noulAnswer(up ? 1 : 0),
    touches_stored_data: noulAnswer(up ? 1 : 0),
    touches_concurrency: noulAnswer(up ? 1 : 0),
    changes_public_interface: noulAnswer(up ? 1 : 0),
  });
}

/** Answers that argue against asking the user: assertion kind, needs_user 0. */
function pushAwayFromUser(): FailureAnswers {
  return parseFailureAnswers({ failure_kind: choiceAnswer(FAILURE_KINDS, "assertion_mismatch", 1), needs_user: noulAnswer(0) });
}

/** Every item cosmetic with certainty. */
function pushTowardLocal(itemCount: number): ReplyAnswers {
  const raw: RawAnswers = {};
  for (let i = 0; i < itemCount; i++) raw[`followup_${i}_size`] = scoreAnswer(4, 0, 1);
  return parseReplyAnswers(raw, itemCount);
}

// ---------------------------------------------------------------- policy simulation (same order as the orchestrator)

function earlyExit(route: Route, reason: ReasonCode, source: Source): PolicyResult {
  return { route, reason, source, signals: {} };
}

/** §4.1: explicit codex → explicit chatgpt → noEgress → decideIntake (answers null = heuristic). */
export function simulateIntake(
  f: Pick<IntakeFixture, "request" | "context">,
  bias: RouterBias,
  answers: IntakeAnswers | null
): PolicyResult {
  const explicit = detectExplicitRoute(f.request);
  if (explicit === "codex") return earlyExit("codex_solo", "explicit_codex", "override");
  if (explicit === "chatgpt") return earlyExit("chatgpt_plan", "explicit_chatgpt", "override");
  if (detectNoEgress(f.request)) return earlyExit("codex_solo", "no_egress", "rule");
  const c = f.context ?? {};
  return decideIntake(
    {
      bias,
      connection: c.connection ?? "ready",
      warm: c.warm ?? false,
      workspaceBusy: c.workspaceBusy ?? false,
      consentAskedToday: c.consentAskedToday ?? false,
    },
    answers
  );
}

export interface FailureSignals {
  errorLines: string[];
  heuristicKind: FailureKind;
  needsUserRegex: boolean;
}

export function failureSignals(output: string): FailureSignals {
  const errorLines = extractErrorLines(output);
  return { errorLines, heuristicKind: heuristicFailureKind(errorLines), needsUserRegex: needsUserRegex(errorLines) };
}

/**
 * One decideFailure per sequence step. The streak restarts when a step's signature differs;
 * outSwitches, the reserved review and the daily consent flag carry over the way the
 * orchestrator persists them. After a stuck_escalate_debug the task is in the ChatGPT loop, so
 * later steps run with inLoop = true (the fixture's `inLoop` says whether the loop was already
 * active); a codex pin is never in the loop. Like runFailure, an escalation resets the command's
 * counter, and a question to the user (stuck_ask_user, env_or_flaky_cap) is remembered so the
 * same question waits for another full cap of failures.
 */
export function simulateFailure(
  f: Pick<FailureFixture, "output" | "context" | "sequence">,
  bias: RouterBias,
  answers: FailureAnswers | null,
  signals: FailureSignals = failureSignals(f.output)
): PolicyResult[] {
  const c = f.context ?? {};
  let outSwitches = c.outSwitches ?? 0;
  let reservedReview = c.reservedReview ?? false;
  let consentAskedToday = c.consentAskedToday ?? false;
  let escalated = false;
  let streak = 0;
  // like runFailure: an escalate_chatgpt resets the command's counter, so a new attempt cycle starts
  let base = 0;
  let askedAt: number | null = null;
  return f.sequence.map((step) => {
    const consecutive = step.attempt - base;
    streak = consecutive === 1 || !step.sameSignature ? 1 : streak + 1;
    const result = decideFailure(
      {
        bias,
        inLoop: c.pin !== "codex" && (step.inLoop || escalated),
        consecutive,
        sameSignatureStreak: streak,
        uncertainIntake: c.uncertainIntake ?? false,
        needsUserRegex: signals.needsUserRegex,
        heuristicKind: signals.heuristicKind,
        pin: c.pin ?? null,
        noEgress: c.noEgress ?? false,
        workspaceBusy: c.workspaceBusy ?? false,
        outSwitches,
        reservedReview: reservedReview && !escalated,
        askedAt,
        connection: (c.connection ?? "ready") as Connection,
        consentAskedToday,
      },
      answers
    );
    if (typeof result.stateDelta?.outSwitches === "number") outSwitches = result.stateDelta.outSwitches;
    if (result.reason === "reconnect_consent") consentAskedToday = true;
    if (result.reason === "stuck_escalate_debug") {
      escalated = true;
      reservedReview = false;
    }
    if (result.route === "escalate_chatgpt") {
      base = step.attempt;
      askedAt = null;
    } else if (result.reason === "stuck_ask_user" || result.reason === "env_or_flaky_cap") {
      askedAt = consecutive;
    }
    return result;
  });
}

export interface ReplySignals {
  items: string[];
  riskItem: boolean;
  tooMany: boolean;
}

export function replySignals(text: string): ReplySignals {
  const { items, riskItem } = analyzeFollowups(text);
  return { items, riskItem, tooMany: items.length > MAX_LOCAL_FOLLOWUPS };
}

export function simulateReply(
  f: Pick<ReplyFixture, "followups" | "context">,
  bias: RouterBias,
  answers: ReplyAnswers | null,
  signals: ReplySignals = replySignals(f.followups)
): PolicyResult {
  return decideReply(
    {
      bias,
      itemCount: signals.items.length,
      riskItem: signals.riskItem,
      iteration: f.context?.iteration ?? 1,
      maxIterations: f.context?.maxIterations ?? 12,
    },
    answers
  );
}

function expectedExplicit(tags: readonly string[]): "chatgpt" | "codex" | null {
  if (tags.includes("explicit_chatgpt")) return "chatgpt";
  if (tags.includes("explicit_codex")) return "codex";
  return null;
}

// ---------------------------------------------------------------- outbound state (the live payload)

export type OutboundBuild = { state: EntryType; questions: Questions } | { skip: "private_key" | "empty" };

export function intakeOutbound(
  f: Pick<IntakeFixture, "request" | "request_en">,
  opts: { gloss?: boolean; apiKey?: string } = {}
): OutboundBuild {
  const request = sanitizeForThirdParty(f.request, "request", { apiKey: opts.apiKey });
  if (!request.allowed) return { skip: "private_key" };
  if (request.text.trim() === "") return { skip: "empty" };
  if (opts.gloss && f.request_en) {
    const gloss = sanitizeForThirdParty(f.request_en, "request_en", { apiKey: opts.apiKey });
    if (!gloss.allowed) return { skip: "private_key" };
    if (gloss.text.trim() !== "") {
      return { state: { request: request.text, request_en: gloss.text }, questions: intakeQuestions({ withGloss: true }) };
    }
  }
  return { state: { request: request.text }, questions: intakeQuestions() };
}

/** Same fields as the orchestrator's failure payload: `command` and `error_lines` (the goal is never sent). */
export function failureOutbound(f: Pick<FailureFixture, "command" | "output">, opts: { apiKey?: string } = {}): OutboundBuild {
  const command = sanitizeForThirdParty(f.command, "command", opts);
  const errorLines = sanitizeForThirdParty(extractErrorLines(f.output).join("\n"), "error_lines", opts);
  if (!command.allowed || !errorLines.allowed) return { skip: "private_key" };
  if (errorLines.text.trim() === "") return { skip: "empty" };
  return { state: { command: command.text, error_lines: errorLines.text }, questions: failureQuestions() };
}

export function replyOutbound(f: Pick<ReplyFixture, "followups">, opts: { apiKey?: string } = {}): OutboundBuild {
  const items = parseFollowups(f.followups);
  if (items.length === 0) return { skip: "empty" };
  const followups: string[] = [];
  for (const item of items) {
    const clean = sanitizeForThirdParty(item, "followup", opts);
    if (!clean.allowed) return { skip: "private_key" };
    followups.push(clean.text.trim() === "" ? "(empty)" : clean.text);
  }
  return { state: { followups }, questions: replyQuestions(followups.length) };
}

// ---------------------------------------------------------------- report types

export interface EvalIssue {
  check: string;
  set: FixtureSetName;
  fixture: string;
  bias?: RouterBias;
  step?: number;
  expected?: string;
  actual?: string;
}

export interface RateCount {
  total: number;
  passed: number;
  rate: number | null;
}

export interface Tally extends RateCount {
  issues: EvalIssue[];
}

export interface QuestionStats {
  kind: "choice" | "score" | "noul";
  n: number;
  /** choice: argmax; score: argmax level exact; noul: p ≥ 0.5. */
  accuracy: number | null;
  within1?: number | null;
  mae?: number | null;
  brier?: number | null;
}

export interface CalibrationBucket {
  lo: number;
  hi: number;
  n: number;
  accuracy: number | null;
  meanConfidence: number | null;
}

export interface LatencyStats {
  n: number;
  p50: number | null;
  p95: number | null;
}

export interface GlossReport {
  fixtures: number;
  plain: Record<RouterBias, RateCount>;
  gloss: Record<RouterBias, RateCount>;
  /** gloss − plain route agreement on the zh/mixed subset, in percentage points. */
  deltaPoints: Record<RouterBias, number | null>;
}

export type EvalSkip = "early_exit" | "private_key" | "empty" | "aborted";

/** One live Jev call (or a skipped one). Saved by --save-answers; never holds fixture text. */
export interface EvalAnswerRecord {
  set: FixtureSetName;
  point: EvalPoint;
  fixtureId: string;
  variant: "plain" | "gloss";
  ok: boolean;
  error?: JevErrorClass;
  skipped?: EvalSkip;
  latencyMs: number;
  usage?: { input_tokens: number; output_tokens: number };
  answers?: RawAnswers;
}

export interface LiveReport {
  source: "live" | "saved";
  planned: number;
  answered: number;
  skipped: Partial<Record<EvalSkip, number>>;
  errors: Partial<Record<JevErrorClass, number>>;
  aborted: JevErrorClass | null;
  usage: { input_tokens: number; output_tokens: number };
  latency: Record<"all" | EvalPoint, LatencyStats>;
  questions: Record<string, Partial<Record<LangKey, QuestionStats>>>;
  routeAgreement: Record<RouterBias, Partial<Record<LangKey, RateCount>>>;
  routeAgreementByPoint: Record<EvalPoint, Record<RouterBias, RateCount>>;
  calibration: Partial<Record<LangKey, CalibrationBucket[]>>;
  floorViolations: EvalIssue[];
  injectionViolations: EvalIssue[];
  mismatches: EvalIssue[];
  gloss: GlossReport | null;
  release: {
    bias: RouterBias;
    agreement: number | null;
    agreementZh: number | null;
    intakeP95Ms: number | null;
    violations: number;
    meets: boolean;
  };
  savedTo: string | null;
}

export interface EvalReport {
  v: 1;
  /** Offline checks all pass, fixtures valid, and (live/replay) zero floor or injection violations. */
  ok: boolean;
  mode: "offline" | "live" | "replay";
  variant: "gloss" | null;
  qsv: string;
  model: string | null;
  points: EvalPoint[];
  fixtures: {
    dir: string;
    intake: number;
    failure: number;
    reply: number;
    adversarial: number;
    intakeZhShare: number | null;
    errors: string[];
  };
  offline: {
    deterministic: Tally;
    idealReplay: Tally & { byBias: Record<RouterBias, RateCount> };
    canary: Tally;
  };
  live: LiveReport | null;
  warnings: string[];
}

export interface EvalOptions {
  live: boolean;
  variant?: "gloss";
  points?: DecisionPoint[];
  saveAnswers?: string;
  replay?: string;
}

export interface EvalDeps {
  fetch?: Fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** undefined → resolve from the secrets file (askJev's default); null → no key. */
  key?: ResolvedKey | null;
  /** Defaults to router.json `model`. */
  model?: string;
  concurrency?: number;
  fixturesDir?: string;
  c2cCommand?: string;
}

// ---------------------------------------------------------------- small helpers

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function rate(passed: number, total: number): number | null {
  return total === 0 ? null : round(passed / total);
}

class Counter {
  total = 0;
  passed = 0;
  issues: EvalIssue[] = [];

  check(ok: boolean, issue: () => EvalIssue): boolean {
    this.total += 1;
    if (ok) this.passed += 1;
    else if (this.issues.length < MAX_ISSUES) this.issues.push(issue());
    return ok;
  }

  toTally(): Tally {
    return { total: this.total, passed: this.passed, rate: rate(this.passed, this.total), issues: this.issues };
  }
}

function emptyRate(): RateCount {
  return { total: 0, passed: 0, rate: null };
}

function addRate(target: RateCount, ok: boolean): void {
  target.total += 1;
  if (ok) target.passed += 1;
  target.rate = rate(target.passed, target.total);
}

function biasRecord<T>(make: () => T): Record<RouterBias, T> {
  return { economy: make(), balanced: make(), speed: make() };
}

function langKeys(lang: EvalLang): LangKey[] {
  return lang === "en" ? ["all", "en"] : ["all", lang, "zhAny"];
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function latencyStats(values: number[]): LatencyStats {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

function argmax(probs: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
  return best;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Stable key for an outbound state (used by tests to map a request body back to its fixture). */
export function stateKey(state: unknown): string {
  return canonical(state);
}

function selectPoints(points: readonly DecisionPoint[] | undefined): EvalPoint[] {
  if (!points || points.length === 0) return [...EVAL_POINTS];
  return EVAL_POINTS.filter((point) => points.includes(point));
}

interface Channels {
  next: string;
  say: string | null;
  controlMessage: string | null;
}

/** What the CLI would print for `result` (the DEBUG INIT uses the task goal, never tool output). */
function renderChannels(point: EvalPoint, result: PolicyResult, c2c: string, n1: number, goal?: string): Channels {
  const next = renderNext(result.route, result.reason, {
    taskId: EVAL_TASK_ID,
    root: EVAL_ROOT,
    c2c,
    n1,
    activeTaskId: EVAL_ACTIVE_TASK_ID,
    point,
  });
  const say = renderSay(result.route, result.reason, result.sayParams ?? {}, { withIntro: false, point });
  const controlMessage =
    point === "failure" && result.reason === "stuck_escalate_debug"
      ? buildDebugInit({ taskId: EVAL_TASK_ID, goal: goal ?? DEFAULT_FAILURE_GOAL })
      : null;
  return { next, say, controlMessage };
}

// ---------------------------------------------------------------- offline checks

interface OfflineCounters {
  deterministic: Counter;
  ideal: Counter;
  idealByBias: Record<RouterBias, RateCount>;
  canary: Counter;
}

interface Rendered {
  point: EvalPoint;
  result: PolicyResult;
  bias: RouterBias;
  step?: number;
  n1: number;
}

function checkRendered(
  counters: OfflineCounters,
  set: FixtureSetName,
  id: string,
  rendered: readonly Rendered[],
  c2c: string,
  canary: string | undefined,
  goal: string | undefined
): void {
  for (const r of rendered) {
    let channels: Channels | null = null;
    try {
      channels = renderChannels(r.point, r.result, c2c, r.n1, goal);
    } catch {
      channels = null;
    }
    counters.deterministic.check(channels !== null, () => ({
      check: "render",
      set,
      fixture: id,
      bias: r.bias,
      step: r.step,
      actual: `${r.result.route}/${r.result.reason}`,
    }));
    if (canary === undefined) continue;
    const text = channels ? [channels.next, channels.say ?? "", channels.controlMessage ?? ""].join("\n") : "";
    counters.canary.check(channels !== null && !text.includes(canary), () => ({
      check: "canary",
      set,
      fixture: id,
      bias: r.bias,
      step: r.step,
      actual: `${r.result.route}/${r.result.reason}`,
    }));
  }
}

function offlineIntake(counters: OfflineCounters, set: FixtureSetName, f: IntakeFixture, c2c: string, canary?: string, clean?: string): void {
  const d = counters.deterministic;
  const explicitWant = expectedExplicit(f.tags);
  const explicit = detectExplicitRoute(f.request);
  const noEgress = detectNoEgress(f.request);
  d.check(explicit === explicitWant, () => ({ check: "explicit", set, fixture: f.id, expected: String(explicitWant), actual: String(explicit) }));
  d.check(noEgress === f.tags.includes("no_egress"), () => ({
    check: "no_egress",
    set,
    fixture: f.id,
    expected: String(f.tags.includes("no_egress")),
    actual: String(noEgress),
  }));
  if (clean !== undefined) {
    d.check(detectExplicitRoute(clean) === explicit && detectNoEgress(clean) === noEgress, () => ({
      check: "injection_signals",
      set,
      fixture: f.id,
    }));
  }

  const ideal = parseIntakeAnswers(idealIntakeAnswers(f.labels));
  const rendered: Rendered[] = [];
  for (const bias of ROUTER_BIASES) {
    const heuristic = simulateIntake(f, bias, null);
    d.check(heuristic.route === f.heuristicExpected, () => ({
      check: "heuristic_route",
      set,
      fixture: f.id,
      bias,
      expected: f.heuristicExpected,
      actual: heuristic.route,
    }));
    d.check(explicit === "chatgpt" || !ESCALATING_INTAKE.has(heuristic.route), () => ({
      check: "heuristic_never_escalates",
      set,
      fixture: f.id,
      bias,
      actual: heuristic.route,
    }));
    if (explicit === "chatgpt") {
      const pushed = simulateIntake(f, bias, pushIntake("solo")).route;
      d.check(pushed === "chatgpt_plan" && f.expected[bias] === "chatgpt_plan", () => ({
        check: "floor_explicit_chatgpt",
        set,
        fixture: f.id,
        bias,
        actual: pushed,
      }));
    } else if (explicit === "codex" || noEgress) {
      const pushed = simulateIntake(f, bias, pushIntake("chatgpt")).route;
      d.check(pushed === "codex_solo" && f.expected[bias] === "codex_solo", () => ({
        check: explicit === "codex" ? "floor_explicit_codex" : "floor_no_egress",
        set,
        fixture: f.id,
        bias,
        actual: pushed,
      }));
    }

    const result = simulateIntake(f, bias, ideal);
    const ok = counters.ideal.check(result.route === f.expected[bias], () => ({
      check: "ideal_route",
      set,
      fixture: f.id,
      bias,
      expected: f.expected[bias],
      actual: result.route,
    }));
    addRate(counters.idealByBias[bias], ok);
    rendered.push({ point: "intake", result, bias, n1: 1 }, { point: "intake", result: heuristic, bias, n1: 1 });
  }
  checkRendered(counters, set, f.id, rendered, c2c, canary, undefined);
}

function offlineFailure(counters: OfflineCounters, set: FixtureSetName, f: FailureFixture, c2c: string, canary?: string, clean?: string): void {
  const d = counters.deterministic;
  const signals = failureSignals(f.output);
  if (f.heuristic) {
    d.check(signals.heuristicKind === f.heuristic.kind, () => ({
      check: "heuristic_kind",
      set,
      fixture: f.id,
      expected: f.heuristic?.kind,
      actual: signals.heuristicKind,
    }));
    d.check(signals.needsUserRegex === f.heuristic.needsUserRegex, () => ({
      check: "needs_user_regex",
      set,
      fixture: f.id,
      expected: String(f.heuristic?.needsUserRegex),
      actual: String(signals.needsUserRegex),
    }));
  }
  const cleanSignals = clean === undefined ? null : failureSignals(clean);
  if (cleanSignals) {
    d.check(
      cleanSignals.heuristicKind === signals.heuristicKind && cleanSignals.needsUserRegex === signals.needsUserRegex,
      () => ({ check: "injection_signals", set, fixture: f.id, expected: cleanSignals.heuristicKind, actual: signals.heuristicKind })
    );
  }

  const ideal = parseFailureAnswers(idealFailureAnswers(f.labels));
  const pushed = pushAwayFromUser();
  const rendered: Rendered[] = [];
  for (const bias of ROUTER_BIASES) {
    const idealRoutes = simulateFailure(f, bias, ideal, signals);
    const heuristicRoutes = simulateFailure(f, bias, null, signals);
    const pushedRoutes = simulateFailure(f, bias, pushed, signals);
    const cleanHeuristic = cleanSignals ? simulateFailure(f, bias, null, cleanSignals) : null;
    f.sequence.forEach((step, i) => {
      const where = { set, fixture: f.id, bias, step: step.attempt };
      if (step.attempt === 1) {
        const all = [idealRoutes[i], heuristicRoutes[i], pushedRoutes[i]];
        d.check(
          all.every((r) => r.route === "keep_fixing" && r.reason === "first_failure") && step.expected[bias] === "keep_fixing",
          () => ({ check: "first_failure", ...where, actual: idealRoutes[i].route })
        );
      }
      if (step.heuristicExpected) {
        const want = step.heuristicExpected[bias];
        d.check(heuristicRoutes[i].route === want, () => ({
          check: "heuristic_route",
          ...where,
          expected: want,
          actual: heuristicRoutes[i].route,
        }));
      }
      if (signals.needsUserRegex && step.attempt >= 2) {
        d.check(
          [pushedRoutes[i], heuristicRoutes[i]].every((r) => r.route === "ask_user" && r.reason === "needs_user") &&
            step.expected[bias] === "ask_user",
          () => ({ check: "floor_needs_user", ...where, actual: pushedRoutes[i].route })
        );
      }
      if (cleanHeuristic) {
        d.check(cleanHeuristic[i].route === heuristicRoutes[i].route, () => ({
          check: "injection_heuristic_route",
          ...where,
          expected: cleanHeuristic[i].route,
          actual: heuristicRoutes[i].route,
        }));
      }
      const ok = counters.ideal.check(idealRoutes[i].route === step.expected[bias], () => ({
        check: "ideal_route",
        ...where,
        expected: step.expected[bias],
        actual: idealRoutes[i].route,
      }));
      addRate(counters.idealByBias[bias], ok);
      rendered.push(
        { point: "failure", result: idealRoutes[i], bias, step: step.attempt, n1: 1 },
        { point: "failure", result: heuristicRoutes[i], bias, step: step.attempt, n1: 1 }
      );
    });
  }
  checkRendered(counters, set, f.id, rendered, c2c, canary, f.goal);
}

function offlineReply(counters: OfflineCounters, set: FixtureSetName, f: ReplyFixture, c2c: string, canary?: string, clean?: string): void {
  const d = counters.deterministic;
  const signals = replySignals(f.followups);
  d.check(signals.riskItem === f.tags.includes("risky"), () => ({
    check: "risk_item",
    set,
    fixture: f.id,
    expected: String(f.tags.includes("risky")),
    actual: String(signals.riskItem),
  }));
  d.check(signals.tooMany === f.tags.includes("too_many"), () => ({
    check: "too_many",
    set,
    fixture: f.id,
    expected: String(f.tags.includes("too_many")),
    actual: String(signals.tooMany),
  }));
  const cleanSignals = clean === undefined ? null : replySignals(clean);
  if (cleanSignals) {
    d.check(cleanSignals.riskItem === signals.riskItem && cleanSignals.items.length === signals.items.length, () => ({
      check: "injection_signals",
      set,
      fixture: f.id,
    }));
  }
  if (signals.items.length !== f.labels.levels.length || signals.items.length === 0) return;

  const ideal = parseReplyAnswers(idealReplyAnswers(f.labels.levels), signals.items.length);
  const pushed = pushTowardLocal(signals.items.length);
  const n1 = (f.context?.iteration ?? 1) + 1;
  const rendered: Rendered[] = [];
  for (const bias of ROUTER_BIASES) {
    const heuristic = simulateReply(f, bias, null, signals);
    d.check(heuristic.route === f.heuristicExpected, () => ({
      check: "heuristic_route",
      set,
      fixture: f.id,
      bias,
      expected: f.heuristicExpected,
      actual: heuristic.route,
    }));
    if (cleanSignals) {
      const cleanRoute = simulateReply(f, bias, null, cleanSignals).route;
      d.check(cleanRoute === heuristic.route, () => ({
        check: "injection_heuristic_route",
        set,
        fixture: f.id,
        bias,
        expected: cleanRoute,
        actual: heuristic.route,
      }));
    }
    if (signals.riskItem || signals.tooMany) {
      const route = simulateReply(f, bias, pushed, signals).route;
      d.check(
        route === "apply_followups_then_review" &&
          heuristic.route === "apply_followups_then_review" &&
          f.expected[bias] === "apply_followups_then_review",
        () => ({ check: "floor_followups", set, fixture: f.id, bias, actual: route })
      );
    }
    const result = simulateReply(f, bias, ideal, signals);
    const ok = counters.ideal.check(result.route === f.expected[bias], () => ({
      check: "ideal_route",
      set,
      fixture: f.id,
      bias,
      expected: f.expected[bias],
      actual: result.route,
    }));
    addRate(counters.idealByBias[bias], ok);
    rendered.push({ point: "reply", result, bias, n1 }, { point: "reply", result: heuristic, bias, n1 });
  }
  checkRendered(counters, set, f.id, rendered, c2c, canary, undefined);
}

export function runOfflineChecks(fixtures: FixtureSet, points: readonly EvalPoint[], c2c: string = EVAL_C2C): EvalReport["offline"] {
  const counters: OfflineCounters = {
    deterministic: new Counter(),
    ideal: new Counter(),
    idealByBias: biasRecord(emptyRate),
    canary: new Counter(),
  };
  const guard = (set: FixtureSetName, id: string, run: () => void) => {
    try {
      run();
    } catch {
      counters.deterministic.check(false, () => ({ check: "internal_error", set, fixture: id }));
    }
  };
  if (points.includes("intake")) for (const f of fixtures.intake) guard("intake", f.id, () => offlineIntake(counters, "intake", f, c2c));
  if (points.includes("failure")) for (const f of fixtures.failure) guard("failure", f.id, () => offlineFailure(counters, "failure", f, c2c));
  if (points.includes("reply")) for (const f of fixtures.reply) guard("reply", f.id, () => offlineReply(counters, "reply", f, c2c));
  for (const f of fixtures.adversarial) {
    if (!points.includes(f.point)) continue;
    guard("adversarial", f.id, () => {
      if (f.point === "intake") offlineIntake(counters, "adversarial", f, c2c, f.canary, f.clean);
      else if (f.point === "failure") offlineFailure(counters, "adversarial", f, c2c, f.canary, f.clean);
      else offlineReply(counters, "adversarial", f, c2c, f.canary, f.clean);
    });
  }
  return {
    deterministic: counters.deterministic.toTally(),
    idealReplay: { ...counters.ideal.toTally(), byBias: counters.idealByBias },
    canary: counters.canary.toTally(),
  };
}

// ---------------------------------------------------------------- live calls

interface CallPlan {
  set: FixtureSetName;
  point: EvalPoint;
  fixtureId: string;
  variant: "plain" | "gloss";
  build: OutboundBuild | { skip: "early_exit" };
}

function planCalls(fixtures: FixtureSet, points: readonly EvalPoint[], gloss: boolean, apiKey?: string): CallPlan[] {
  const plans: CallPlan[] = [];
  const intake = (set: FixtureSetName, f: IntakeFixture) => {
    if (detectExplicitRoute(f.request) !== null || detectNoEgress(f.request)) {
      plans.push({ set, point: "intake", fixtureId: f.id, variant: "plain", build: { skip: "early_exit" } });
      return;
    }
    plans.push({ set, point: "intake", fixtureId: f.id, variant: "plain", build: intakeOutbound(f, { apiKey }) });
    if (gloss && f.lang !== "en" && f.request_en) {
      plans.push({ set, point: "intake", fixtureId: f.id, variant: "gloss", build: intakeOutbound(f, { gloss: true, apiKey }) });
    }
  };
  if (points.includes("intake")) for (const f of fixtures.intake) intake("intake", f);
  if (points.includes("failure")) {
    for (const f of fixtures.failure) {
      plans.push({ set: "failure", point: "failure", fixtureId: f.id, variant: "plain", build: failureOutbound(f, { apiKey }) });
    }
  }
  if (points.includes("reply")) {
    for (const f of fixtures.reply) {
      plans.push({ set: "reply", point: "reply", fixtureId: f.id, variant: "plain", build: replyOutbound(f, { apiKey }) });
    }
  }
  for (const f of fixtures.adversarial) {
    if (!points.includes(f.point)) continue;
    if (f.point === "intake") intake("adversarial", f);
    else if (f.point === "failure") {
      plans.push({ set: "adversarial", point: "failure", fixtureId: f.id, variant: "plain", build: failureOutbound(f, { apiKey }) });
    } else {
      plans.push({ set: "adversarial", point: "reply", fixtureId: f.id, variant: "plain", build: replyOutbound(f, { apiKey }) });
    }
  }
  return plans;
}

/** Numbers and enum labels only: drops `legend` and anything else the API adds. */
function stripAnswers(answers: unknown): RawAnswers {
  const out: RawAnswers = {};
  if (!answers || typeof answers !== "object") return out;
  for (const [id, value] of Object.entries(answers as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const kept: RawAnswer = {};
    for (const key of ["type", "choice", "confidence", "score", "noul"]) if (v[key] !== undefined) kept[key] = v[key];
    if (v.probabilities && typeof v.probabilities === "object") {
      const probs: Record<string, number> = {};
      for (const [label, p] of Object.entries(v.probabilities as Record<string, unknown>)) {
        if (typeof p === "number") probs[label] = p;
      }
      kept.probabilities = probs;
    }
    out[id] = kept;
  }
  return out;
}

async function runPool<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

async function runLiveCalls(
  plans: readonly CallPlan[],
  model: string,
  key: ResolvedKey | null,
  deps: EvalDeps
): Promise<{ records: EvalAnswerRecord[]; aborted: JevErrorClass | null }> {
  let aborted: JevErrorClass | null = null;
  const concurrency = Number.isInteger(deps.concurrency) && (deps.concurrency as number) > 0 ? (deps.concurrency as number) : EVAL_CONCURRENCY;
  const records = await runPool(plans, concurrency, async (plan): Promise<EvalAnswerRecord> => {
    const base = { set: plan.set, point: plan.point, fixtureId: plan.fixtureId, variant: plan.variant };
    if ("skip" in plan.build) return { ...base, ok: false, skipped: plan.build.skip, latencyMs: 0 };
    if (aborted) return { ...base, ok: false, skipped: "aborted", error: aborted, latencyMs: 0 };
    const outcome = await askJev(plan.build.state, plan.build.questions, jevCallOptions(plan.point, model), {
      fetch: deps.fetch,
      now: deps.now,
      key,
      env: deps.env,
      // eval never reads or trips the breaker real routing uses; FATAL_ERRORS stop the run instead
      breaker: false,
    });
    if (!outcome.ok) {
      if (FATAL_ERRORS.has(outcome.error) && !aborted) aborted = outcome.error;
      return { ...base, ok: false, error: outcome.error, latencyMs: outcome.latencyMs };
    }
    return {
      ...base,
      ok: true,
      latencyMs: outcome.latencyMs,
      usage: { input_tokens: outcome.usage.input_tokens, output_tokens: outcome.usage.output_tokens },
      answers: stripAnswers(outcome.answers),
    };
  });
  return { records, aborted };
}

// ---------------------------------------------------------------- saved answers (--save-answers / --replay)

const savedRecordSchema = z
  .object({
    set: z.enum(["intake", "failure", "reply", "adversarial"]),
    point: z.enum(["intake", "failure", "reply"]),
    fixtureId: idSchema,
    variant: z.enum(["plain", "gloss"]),
    ok: z.boolean(),
    error: enumOf(JEV_ERROR_CLASSES).optional(),
    skipped: z.enum(["early_exit", "private_key", "empty", "aborted"]).optional(),
    latencyMs: z.number().min(0).max(600_000),
    usage: z.object({ input_tokens: z.number().min(0), output_tokens: z.number().min(0) }).strict().optional(),
    answers: z.record(z.record(z.unknown())).optional(),
  })
  .strict();

export const savedAnswersSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("c2c-route-eval-answers"),
    qsv: z.string().max(64),
    model: z.string().max(64),
    createdAt: z.string().max(64),
    aborted: enumOf(JEV_ERROR_CLASSES).nullable(),
    records: z.array(savedRecordSchema).max(10_000),
  })
  .strict();

export type SavedAnswers = z.infer<typeof savedAnswersSchema>;

function writeSavedAnswers(file: string, data: SavedAnswers): boolean {
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function readSavedAnswers(file: string): SavedAnswers | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SAVED_BYTES) return null;
    const parsed = savedAnswersSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- scoring answers (live or saved)

class QuestionAcc {
  n = 0;
  correct = 0;
  within1 = 0;
  absErr = 0;
  brier = 0;

  constructor(readonly kind: QuestionStats["kind"]) {}

  toStats(): QuestionStats {
    const stats: QuestionStats = { kind: this.kind, n: this.n, accuracy: rate(this.correct, this.n) };
    if (this.kind === "score") {
      stats.within1 = rate(this.within1, this.n);
      stats.mae = this.n === 0 ? null : round(this.absErr / this.n);
    }
    if (this.kind === "noul") stats.brier = this.n === 0 ? null : round(this.brier / this.n);
    return stats;
  }
}

const CALIBRATION_EDGES = [0, 0.2, 0.4, 0.6, 0.8, 1];

class Scorer {
  private readonly questions = new Map<string, Map<LangKey, QuestionAcc>>();
  private readonly calibration = new Map<LangKey, Array<{ n: number; correct: number; conf: number }>>();
  readonly agreement = biasRecord<Partial<Record<LangKey, RateCount>>>(() => ({}));
  readonly byPoint: Record<EvalPoint, Record<RouterBias, RateCount>> = {
    intake: biasRecord(emptyRate),
    failure: biasRecord(emptyRate),
    reply: biasRecord(emptyRate),
  };
  readonly floorViolations: EvalIssue[] = [];
  readonly injectionViolations: EvalIssue[] = [];
  readonly mismatches: EvalIssue[] = [];

  private acc(id: string, lang: LangKey, kind: QuestionStats["kind"]): QuestionAcc {
    let byLang = this.questions.get(id);
    if (!byLang) this.questions.set(id, (byLang = new Map()));
    let acc = byLang.get(lang);
    if (!acc) byLang.set(lang, (acc = new QuestionAcc(kind)));
    return acc;
  }

  private calibrate(lang: EvalLang, confidence: number, correct: boolean): void {
    const index = Math.min(CALIBRATION_EDGES.length - 2, Math.max(0, Math.floor(confidence / 0.2)));
    for (const key of langKeys(lang)) {
      let buckets = this.calibration.get(key);
      if (!buckets) this.calibration.set(key, (buckets = CALIBRATION_EDGES.slice(1).map(() => ({ n: 0, correct: 0, conf: 0 }))));
      buckets[index].n += 1;
      buckets[index].conf += confidence;
      if (correct) buckets[index].correct += 1;
    }
  }

  choice(id: string, lang: EvalLang, probs: readonly number[], label: number, confidence: number): void {
    const correct = argmax(probs) === label;
    for (const key of langKeys(lang)) {
      const acc = this.acc(id, key, "choice");
      acc.n += 1;
      if (correct) acc.correct += 1;
    }
    this.calibrate(lang, confidence, correct);
  }

  score(id: string, lang: EvalLang, probs: readonly number[], label: number, confidence: number | null): void {
    const top = argmax(probs);
    const expected = probs.reduce((sum, p, level) => sum + p * level, 0);
    for (const key of langKeys(lang)) {
      const acc = this.acc(id, key, "score");
      acc.n += 1;
      if (top === label) acc.correct += 1;
      if (Math.abs(top - label) <= 1) acc.within1 += 1;
      acc.absErr += Math.abs(expected - label);
    }
    if (confidence !== null) this.calibrate(lang, confidence, top === label);
  }

  noul(id: string, lang: EvalLang, p: number, label: boolean): void {
    const correct = p >= 0.5 === label;
    for (const key of langKeys(lang)) {
      const acc = this.acc(id, key, "noul");
      acc.n += 1;
      if (correct) acc.correct += 1;
      acc.brier += (p - (label ? 1 : 0)) ** 2;
    }
    this.calibrate(lang, Math.max(p, 1 - p), correct);
  }

  route(point: EvalPoint, lang: EvalLang, issue: EvalIssue & { bias: RouterBias }, ok: boolean, injection: boolean): void {
    for (const key of langKeys(lang)) {
      const target = (this.agreement[issue.bias][key] ??= emptyRate());
      addRate(target, ok);
    }
    addRate(this.byPoint[point][issue.bias], ok);
    if (ok) return;
    if (this.mismatches.length < MAX_ISSUES) this.mismatches.push({ ...issue, check: "route" });
    if (injection && this.injectionViolations.length < MAX_ISSUES) this.injectionViolations.push({ ...issue, check: "injection" });
  }

  questionStats(): LiveReport["questions"] {
    const out: LiveReport["questions"] = {};
    for (const [id, byLang] of this.questions) {
      out[id] = {};
      for (const [lang, acc] of byLang) out[id][lang] = acc.toStats();
    }
    return out;
  }

  calibrationTable(): LiveReport["calibration"] {
    const out: LiveReport["calibration"] = {};
    for (const [lang, buckets] of this.calibration) {
      out[lang] = buckets.map((b, i) => ({
        lo: CALIBRATION_EDGES[i],
        hi: CALIBRATION_EDGES[i + 1],
        n: b.n,
        accuracy: rate(b.correct, b.n),
        meanConfidence: b.n === 0 ? null : round(b.conf / b.n),
      }));
    }
    return out;
  }
}

type AnyFixture =
  | { set: FixtureSetName; point: "intake"; fixture: IntakeFixture; canary?: string }
  | { set: FixtureSetName; point: "failure"; fixture: FailureFixture; canary?: string }
  | { set: FixtureSetName; point: "reply"; fixture: ReplyFixture; canary?: string };

function fixtureIndex(fixtures: FixtureSet): Map<string, AnyFixture> {
  const map = new Map<string, AnyFixture>();
  for (const f of fixtures.intake) map.set(`intake/${f.id}`, { set: "intake", point: "intake", fixture: f });
  for (const f of fixtures.failure) map.set(`failure/${f.id}`, { set: "failure", point: "failure", fixture: f });
  for (const f of fixtures.reply) map.set(`reply/${f.id}`, { set: "reply", point: "reply", fixture: f });
  for (const f of fixtures.adversarial) {
    const entry =
      f.point === "intake"
        ? ({ set: "adversarial", point: "intake", fixture: f, canary: f.canary } as const)
        : f.point === "failure"
          ? ({ set: "adversarial", point: "failure", fixture: f, canary: f.canary } as const)
          : ({ set: "adversarial", point: "reply", fixture: f, canary: f.canary } as const);
    map.set(`adversarial/${f.id}`, entry);
  }
  return map;
}

function rawScoreProbs(raw: RawAnswers, id: string, levels: number): { probs: number[]; confidence: number | null } {
  const entry = raw[id] ?? {};
  const table = (entry.probabilities ?? {}) as Record<string, unknown>;
  const probs = Array.from({ length: levels }, (_, level) => {
    const p = table[String(level)];
    return typeof p === "number" && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
  });
  const confidence = typeof entry.confidence === "number" && Number.isFinite(entry.confidence) ? entry.confidence : null;
  return { probs, confidence };
}

function canaryLeaked(point: EvalPoint, result: PolicyResult, c2c: string, n1: number, canary: string, goal?: string): boolean {
  try {
    const c = renderChannels(point, result, c2c, n1, goal);
    return [c.next, c.say ?? "", c.controlMessage ?? ""].some((text) => text.includes(canary));
  } catch {
    return false;
  }
}

interface ScoreInput {
  records: readonly EvalAnswerRecord[];
  fixtures: FixtureSet;
  source: "live" | "saved";
  aborted: JevErrorClass | null;
  c2c: string;
  warnings: string[];
}

function scoreRecords(input: ScoreInput): LiveReport {
  const { records, fixtures, c2c } = input;
  const index = fixtureIndex(fixtures);
  const scorer = new Scorer();
  const skipped: LiveReport["skipped"] = {};
  const errors: LiveReport["errors"] = {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  const latency: Record<"all" | EvalPoint, number[]> = { all: [], intake: [], failure: [], reply: [] };
  const glossRoutes = new Map<string, Record<RouterBias, boolean>>();
  const plainRoutes = new Map<string, Record<RouterBias, boolean>>();
  let answered = 0;
  let unknown = 0;

  const bump = (error: JevErrorClass) => {
    errors[error] = (errors[error] ?? 0) + 1;
  };

  for (const record of records) {
    if (record.skipped) {
      skipped[record.skipped] = (skipped[record.skipped] ?? 0) + 1;
      continue;
    }
    if (!record.ok || !record.answers) {
      bump(record.error ?? "invalid_response");
      continue;
    }
    const entry = index.get(`${record.set}/${record.fixtureId}`);
    if (!entry || entry.point !== record.point) {
      unknown += 1;
      continue;
    }
    const raw = record.answers;
    const lang = entry.fixture.lang as EvalLang;
    const injection = entry.fixture.tags.includes("injection");
    const agreeByBias = biasRecord(() => true);
    try {
      if (entry.point === "intake") {
        const f = entry.fixture;
        const a = parseIntakeAnswers(raw);
        if (record.variant === "plain") {
          scorer.choice("task_kind", lang, TASK_KINDS.map((k) => a.taskKind[k]), TASK_KINDS.indexOf(f.labels.task_kind), a.taskKindConfidence);
          scorer.score("scope", lang, a.scope, f.labels.scope, a.scopeConfidence);
          scorer.noul("needs_design", lang, a.needsDesign, f.labels.needs_design);
          scorer.noul("goal_is_clear", lang, a.goalIsClear, f.labels.goal_is_clear);
          scorer.noul("touches_auth_security", lang, a.risk.auth, f.labels.touches_auth_security);
          scorer.noul("touches_stored_data", lang, a.risk.data, f.labels.touches_stored_data);
          scorer.noul("touches_concurrency", lang, a.risk.concurrency, f.labels.touches_concurrency);
          scorer.noul("changes_public_interface", lang, a.risk.publicInterface, f.labels.changes_public_interface);
        }
        for (const bias of ROUTER_BIASES) {
          const result = simulateIntake(f, bias, a);
          const ok = result.route === f.expected[bias];
          agreeByBias[bias] = ok;
          if (record.variant === "plain") {
            scorer.route("intake", lang, { check: "route", set: entry.set, fixture: f.id, bias, expected: f.expected[bias], actual: result.route }, ok, injection);
            if (entry.canary && canaryLeaked("intake", result, c2c, 1, entry.canary)) {
              scorer.injectionViolations.push({ check: "canary", set: entry.set, fixture: f.id, bias });
            }
          }
        }
      } else if (entry.point === "failure") {
        const f = entry.fixture;
        const a = parseFailureAnswers(raw);
        scorer.choice("failure_kind", lang, FAILURE_KINDS.map((k) => a.kind[k]), FAILURE_KINDS.indexOf(f.labels.failure_kind), a.kindConfidence);
        scorer.noul("needs_user", lang, a.needsUser, f.labels.needs_user);
        const signals = failureSignals(f.output);
        for (const bias of ROUTER_BIASES) {
          const routes = simulateFailure(f, bias, a, signals);
          f.sequence.forEach((step, i) => {
            const result = routes[i];
            const where = { set: entry.set, fixture: f.id, bias, step: step.attempt };
            scorer.route("failure", lang, { check: "route", ...where, expected: step.expected[bias], actual: result.route }, result.route === step.expected[bias], injection);
            if (signals.needsUserRegex && step.attempt >= 2 && result.route !== "ask_user") {
              scorer.floorViolations.push({ check: "floor_needs_user", ...where, actual: result.route });
            }
            if (entry.canary && canaryLeaked("failure", result, c2c, 1, entry.canary, f.goal)) {
              scorer.injectionViolations.push({ check: "canary", ...where });
            }
          });
        }
      } else {
        const f = entry.fixture;
        const signals = replySignals(f.followups);
        const a = parseReplyAnswers(raw, signals.items.length);
        f.labels.levels.forEach((level, i) => {
          if (i >= signals.items.length) return;
          const { probs, confidence } = rawScoreProbs(raw, `followup_${i}_size`, 4);
          scorer.score("followup_size", lang, probs, level, confidence);
        });
        const n1 = (f.context?.iteration ?? 1) + 1;
        for (const bias of ROUTER_BIASES) {
          const result = simulateReply(f, bias, a, signals);
          const where = { set: entry.set, fixture: f.id, bias };
          scorer.route("reply", lang, { check: "route", ...where, expected: f.expected[bias], actual: result.route }, result.route === f.expected[bias], injection);
          if ((signals.riskItem || signals.tooMany) && result.route === "apply_followups_local") {
            scorer.floorViolations.push({ check: "floor_followups", ...where, actual: result.route });
          }
          if (entry.canary && canaryLeaked("reply", result, c2c, n1, entry.canary)) {
            scorer.injectionViolations.push({ check: "canary", ...where });
          }
        }
      }
    } catch {
      bump("invalid_response");
      continue;
    }
    answered += 1;
    usage.input_tokens += record.usage?.input_tokens ?? 0;
    usage.output_tokens += record.usage?.output_tokens ?? 0;
    latency.all.push(record.latencyMs);
    latency[record.point].push(record.latencyMs);
    if (entry.point === "intake" && lang !== "en") {
      (record.variant === "gloss" ? glossRoutes : plainRoutes).set(`${entry.set}/${record.fixtureId}`, agreeByBias);
    }
  }
  if (unknown > 0) input.warnings.push(`replay_unknown_fixtures:${unknown}`);

  let gloss: GlossReport | null = null;
  if (glossRoutes.size > 0) {
    gloss = { fixtures: 0, plain: biasRecord(emptyRate), gloss: biasRecord(emptyRate), deltaPoints: biasRecord<number | null>(() => null) };
    for (const [key, withGloss] of glossRoutes) {
      const plain = plainRoutes.get(key);
      if (!plain) continue;
      gloss.fixtures += 1;
      for (const bias of ROUTER_BIASES) {
        addRate(gloss.plain[bias], plain[bias]);
        addRate(gloss.gloss[bias], withGloss[bias]);
      }
    }
    for (const bias of ROUTER_BIASES) {
      const p = gloss.plain[bias].rate;
      const g = gloss.gloss[bias].rate;
      gloss.deltaPoints[bias] = p === null || g === null ? null : Math.round((g - p) * 1000) / 10;
    }
  }

  const lat = {
    all: latencyStats(latency.all),
    intake: latencyStats(latency.intake),
    failure: latencyStats(latency.failure),
    reply: latencyStats(latency.reply),
  };
  const releaseBias: RouterBias = "balanced";
  const agreement = scorer.agreement[releaseBias].all?.rate ?? null;
  const agreementZh = scorer.agreement[releaseBias].zhAny?.rate ?? null;
  const violations = scorer.floorViolations.length + scorer.injectionViolations.length;
  const meets =
    answered > 0 &&
    Object.keys(errors).length === 0 &&
    violations === 0 &&
    agreement !== null &&
    agreement >= RELEASE_CRITERIA.agreement &&
    (agreementZh === null || agreementZh >= RELEASE_CRITERIA.agreementZh) &&
    (lat.intake.p95 === null || lat.intake.p95 <= RELEASE_CRITERIA.intakeP95Ms);

  return {
    source: input.source,
    planned: records.length,
    answered,
    skipped,
    errors,
    aborted: input.aborted,
    usage,
    latency: lat,
    questions: scorer.questionStats(),
    routeAgreement: scorer.agreement,
    routeAgreementByPoint: scorer.byPoint,
    calibration: scorer.calibrationTable(),
    floorViolations: scorer.floorViolations,
    injectionViolations: scorer.injectionViolations,
    mismatches: scorer.mismatches,
    gloss,
    release: { bias: releaseBias, agreement, agreementZh, intakeP95Ms: lat.intake.p95, violations, meets },
    savedTo: null,
  };
}

// ---------------------------------------------------------------- runEval

function resolveModel(deps: EvalDeps): string {
  if (deps.model) return deps.model;
  try {
    return readRouterPrefs().model;
  } catch {
    return DEFAULT_MODEL;
  }
}

function offlineOk(offline: EvalReport["offline"]): boolean {
  const full = (t: RateCount) => t.passed === t.total;
  return full(offline.deterministic) && full(offline.idealReplay) && full(offline.canary) && offline.idealReplay.total > 0;
}

/**
 * Never throws for bad fixtures or saved files: problems land in `fixtures.errors` /
 * `warnings` and make `ok` false. Live mode needs a configured key (resolved from the
 * secrets file unless `deps.key` is given). It never reads or writes the routing breaker, and
 * writes only the `saveAnswers` file when asked (numbers and enum labels only, mode 0600).
 */
export async function runEval(opts: EvalOptions, deps: EvalDeps = {}): Promise<EvalReport> {
  const fixtures = loadFixtures(deps.fixturesDir ?? fixturesDir());
  const points = selectPoints(opts.points);
  const c2c = deps.c2cCommand ?? EVAL_C2C;
  const warnings: string[] = [];
  if (points.length === 0) warnings.push("no_eval_points");
  const offline = runOfflineChecks(fixtures, points, c2c);

  let mode: EvalReport["mode"] = "offline";
  let model: string | null = null;
  let live: LiveReport | null = null;
  let replayFailed = false;
  const variant = opts.variant === "gloss" ? "gloss" : null;

  if (opts.replay) {
    mode = "replay";
    if (opts.live) warnings.push("live_ignored_with_replay");
    if (opts.saveAnswers) warnings.push("save_answers_ignored_with_replay");
    const saved = readSavedAnswers(opts.replay);
    if (!saved) {
      warnings.push("replay_unreadable");
      replayFailed = true;
    } else {
      model = saved.model;
      if (saved.qsv !== QUESTION_SET_VERSION) warnings.push("replay_question_set_changed");
      const records = saved.records.filter((r) => points.includes(r.point));
      live = scoreRecords({ records, fixtures, source: "saved", aborted: saved.aborted, c2c, warnings });
    }
  } else if (opts.live) {
    mode = "live";
    model = resolveModel(deps);
    let key: ResolvedKey | null = null;
    try {
      key = deps.key === undefined ? resolveApiKey(deps.env ?? process.env) : deps.key;
    } catch {
      key = null;
    }
    const plans = planCalls(fixtures, points, variant === "gloss", key?.key);
    const { records, aborted } = await runLiveCalls(plans, model, key, deps);
    live = scoreRecords({ records, fixtures, source: "live", aborted, c2c, warnings });
    if (opts.saveAnswers) {
      const data: SavedAnswers = {
        v: 1,
        kind: "c2c-route-eval-answers",
        qsv: QUESTION_SET_VERSION,
        model,
        createdAt: new Date(deps.now ? deps.now() : Date.now()).toISOString(),
        aborted,
        records,
      };
      if (writeSavedAnswers(opts.saveAnswers, data)) live.savedTo = path.resolve(opts.saveAnswers);
      else warnings.push("save_answers_failed");
    }
  } else if (opts.saveAnswers) {
    warnings.push("save_answers_needs_live");
  }

  // Agreement is reported, not gated; a live/replay run fails only on violations or when it produced nothing.
  const liveOk =
    live === null ||
    (live.floorViolations.length === 0 && live.injectionViolations.length === 0 && live.aborted === null && live.answered > 0);
  return {
    v: 1,
    ok: fixtures.errors.length === 0 && offlineOk(offline) && liveOk && !replayFailed,
    mode,
    variant,
    qsv: QUESTION_SET_VERSION,
    model,
    points,
    fixtures: {
      dir: fixtures.dir,
      intake: fixtures.intake.length,
      failure: fixtures.failure.length,
      reply: fixtures.reply.length,
      adversarial: fixtures.adversarial.length,
      intakeZhShare: intakeZhShare(fixtures.intake),
      errors: fixtures.errors,
    },
    offline,
    live,
    warnings,
  };
}

// ---------------------------------------------------------------- Chinese summary

const MODE_ZH: Record<EvalReport["mode"], string> = { offline: "离线", live: "在线", replay: "回放" };
const ABORT_HINT_ZH: Partial<Record<JevErrorClass, string>> = {
  no_key: "没有可用的 TypeSafe Key，请先在你自己的终端运行 c2c route setup",
  network_blocked: "连不上 TypeSafe（沙箱禁网或网络不可用）",
  auth: "TypeSafe Key 无效或已失效，请重新运行 c2c route setup",
  breaker_open: "最近调用失败太多，熔断中，稍后再试",
};
const LANG_ZH: Partial<Record<LangKey, string>> = { all: "全部", zhAny: "中文", en: "英文" };

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value * 1000) / 10}%`;
}

function ms(value: number | null): string {
  if (value === null) return "—";
  return value >= 1000 ? `${Math.round(value / 100) / 10} s` : `${Math.round(value)} ms`;
}

function tallyLine(label: string, t: RateCount): string {
  return `${label}：${t.passed}/${t.total}（${pct(t.rate)}）`;
}

function issueLine(issue: EvalIssue): string {
  const parts = [issue.set, issue.fixture, issue.check];
  if (issue.bias) parts.push(issue.bias);
  if (issue.step !== undefined) parts.push(`第${issue.step}次`);
  if (issue.expected !== undefined || issue.actual !== undefined) parts.push(`期望 ${issue.expected ?? "?"}，实际 ${issue.actual ?? "?"}`);
  return `  - ${parts.join(" · ")}`;
}

function questionLine(id: string, byLang: Partial<Record<LangKey, QuestionStats>>): string {
  const all = byLang.all;
  if (!all) return `${id} —`;
  const split = (["zhAny", "en"] as const)
    .map((key) => (byLang[key] ? `${LANG_ZH[key]} ${pct(byLang[key]?.accuracy)}` : null))
    .filter((s): s is string => s !== null)
    .join(" / ");
  let main = `${id} 准确率 ${pct(all.accuracy)}`;
  if (all.kind === "score") main = `${id} 相差≤1 ${pct(all.within1)}、MAE ${all.mae ?? "—"}、完全一致 ${pct(all.accuracy)}`;
  if (all.kind === "noul") main = `${id} 准确率 ${pct(all.accuracy)}、Brier ${all.brier ?? "—"}`;
  return split ? `${main}（${split}）` : main;
}

export function formatEvalReportZh(report: EvalReport): string {
  const lines: string[] = [];
  const f = report.fixtures;
  lines.push(`路由评测 · ${MODE_ZH[report.mode]}${report.variant ? " · gloss" : ""} · 题目集 ${report.qsv}`);
  lines.push(
    `样本：intake ${f.intake}（中文/混合 ${pct(f.intakeZhShare)}）· failure ${f.failure} · reply ${f.reply} · 对抗 ${f.adversarial}`
  );
  if (f.errors.length > 0) {
    lines.push(`样本文件有 ${f.errors.length} 个问题：`);
    for (const error of f.errors.slice(0, 5)) lines.push(`  - ${error}`);
  }
  const o = report.offline;
  lines.push(tallyLine("确定性检查", o.deterministic));
  lines.push(
    `${tallyLine("理想答案回放", o.idealReplay)}；${ROUTER_BIASES.map((b) => `${b} ${pct(o.idealReplay.byBias[b].rate)}`).join(" · ")}`
  );
  lines.push(`注入金丝雀：检查 ${o.canary.total} 处，泄漏 ${o.canary.total - o.canary.passed} 处`);
  const offlineIssues = [...o.deterministic.issues, ...o.idealReplay.issues, ...o.canary.issues];
  if (offlineIssues.length > 0) {
    lines.push("离线未通过的项目（最多 8 条）：");
    for (const issue of offlineIssues.slice(0, 8)) lines.push(issueLine(issue));
  }

  const live = report.live;
  if (live) {
    const errorText = Object.entries(live.errors)
      .map(([error, count]) => `${error}×${count}`)
      .join("、");
    const skippedCount = Object.values(live.skipped).reduce((sum, n) => sum + (n ?? 0), 0);
    lines.push(
      `${live.source === "saved" ? "回放已保存的答案" : "在线调用"}（${report.model ?? "—"}）：共 ${live.planned} 项，成功 ${live.answered}，跳过 ${skippedCount}，出错 ${
        errorText || "0"
      }${live.aborted ? `；因 ${live.aborted} 提前停止` : ""}`
    );
    const hint = live.aborted ? ABORT_HINT_ZH[live.aborted] : undefined;
    if (hint) lines.push(`  ${hint}`);
    for (const bias of ROUTER_BIASES) {
      const a = live.routeAgreement[bias];
      const split = (["all", "zhAny", "en"] as const)
        .filter((key) => a[key])
        .map((key) => `${LANG_ZH[key]} ${pct(a[key]?.rate)}`)
        .join(" · ");
      lines.push(`路由一致率（${bias}）：${split || "—"}`);
    }
    const ids = Object.keys(live.questions);
    if (ids.length > 0) {
      lines.push("分题：");
      for (const id of ids) lines.push(`  - ${questionLine(id, live.questions[id])}`);
    }
    const calibration = live.calibration.all?.filter((b) => b.n > 0) ?? [];
    if (calibration.length > 0) {
      lines.push(
        `校准（全部）：${calibration.map((b) => `${b.lo.toFixed(1)}–${b.hi.toFixed(1)} n=${b.n} 准确 ${pct(b.accuracy)}`).join(" · ")}`
      );
    }
    lines.push(`延迟：p50 ${ms(live.latency.all.p50)} · p95 ${ms(live.latency.all.p95)}（intake p95 ${ms(live.latency.intake.p95)}）`);
    lines.push(`底线违例 ${live.floorViolations.length} · 注入违例 ${live.injectionViolations.length}`);
    for (const issue of [...live.floorViolations, ...live.injectionViolations].slice(0, 5)) lines.push(issueLine(issue));
    if (live.gloss) {
      lines.push(
        `gloss（中文子集 ${live.gloss.fixtures} 条）：一致率变化 ${ROUTER_BIASES.map((b) => {
          const d = live.gloss?.deltaPoints[b];
          return `${b} ${d === null || d === undefined ? "—" : `${d > 0 ? "+" : ""}${d} 个百分点`}`;
        }).join(" · ")}；提升不足 5 个百分点时不建议传 --request-en`
      );
    }
    const r = live.release;
    lines.push(
      r.meets
        ? `发布建议：满足（${r.bias} 一致率 ${pct(r.agreement)}、中文 ${pct(r.agreementZh)}、intake p95 ${ms(r.intakeP95Ms)}、0 违例）`
        : `发布建议：暂不满足（需要 ${r.bias} 一致率 ≥ ${pct(RELEASE_CRITERIA.agreement)}、中文 ≥ ${pct(RELEASE_CRITERIA.agreementZh)}、0 违例、0 出错、intake p95 ≤ ${ms(
            RELEASE_CRITERIA.intakeP95Ms
          )}；当前 ${pct(r.agreement)} / ${pct(r.agreementZh)} / 违例 ${r.violations} / p95 ${ms(r.intakeP95Ms)}）`
    );
    if (live.savedTo) lines.push(`答案已保存到 ${live.savedTo}`);
  }
  if (report.warnings.length > 0) lines.push(`提示：${report.warnings.join("、")}`);
  lines.push(report.ok ? "结论：通过" : "结论：未通过");
  return lines.join("\n");
}
