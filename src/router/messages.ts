import { TASK_ID_RE, type DecisionPoint, type PathCategory, type ReasonCode, type Route, type SayParams } from "./types.js";

/**
 * Fixed text for the router's trusted channels (`next`, `say`, `controlMessage`).
 * Placeholders only ever take enums, integers, a validated task id, the
 * workspace root, the c2c command, fixed category labels, or a capped goal.
 */

export const GENERIC_NEXT = "Continue the task normally with your own tools.";
export const CONTROL_MESSAGE_MAX_BYTES = 1000;
export const SAY_MAX_CHARS = 160;
export const GOAL40_MAX_CHARS = 40;

export const EXECUTED_FOLLOWUPS_LINE =
  "If only minor follow-ups remain that need no further review, reply STATE: DONE and list them under FOLLOWUPS:.";

/** Prefixed to the first non-null `say` on this machine (router.json introShownAt unset). */
export const INTRO_ZH = "我会按任务自动决定是否请 ChatGPT 参与；随时可以说「这次别找 ChatGPT」或「让 ChatGPT 来规划」。";

export const CATEGORY_LABEL_ZH: Readonly<Partial<Record<PathCategory, string>>> = Object.freeze({
  auth_security: "登录/权限相关代码",
  payments: "支付相关代码",
  data_migration: "数据库结构或迁移",
  ci_pipeline: "CI 配置",
  agent_config: "Codex/ChatGPT 的配置文件",
  install_scripts: "安装脚本",
});

const CATEGORY_LABELS: ReadonlySet<string> = new Set(Object.values(CATEGORY_LABEL_ZH));

/** Label of the first high-risk category in `categories`, if any. */
export function firstCategoryLabelZh(categories: readonly PathCategory[]): string | undefined {
  for (const category of categories) {
    const label = CATEGORY_LABEL_ZH[category];
    if (label) return label;
  }
  return undefined;
}

export interface NextParams {
  taskId: string | null;
  root: string;
  /** Shell prefix for the CLI, e.g. `node "<checkout>/bin/c2c.js"`. */
  c2c: string;
  n1?: number;
  activeTaskId?: string;
  /** chatgpt_plan / explicit_chatgpt triggered by `--explicit chatgpt`. */
  explicitUser?: boolean;
  /** Required for `ask_user / reconnect_consent`, which differs between failure and review_gate. */
  point?: DecisionPoint;
}

export interface SayOptions {
  withIntro: boolean;
  /** Required for `ask_user / reconnect_consent`, which differs between failure and review_gate. */
  point?: DecisionPoint;
}

type PairKey = `${Route}/${ReasonCode}`;

// ---------------------------------------------------------------- next templates

const NEXT_DISABLED =
  "Smart routing is off here. Work on the request normally with your own tools. Do not mention ChatGPT or routing.";
const NEXT_CODEX_SOLO =
  'Handle this yourself (task {taskId}). If a test/build/typecheck/lint command fails, save its output to a temp file and run {c2c} route failure -w {root} --task {taskId} --command "<cmd>" --output-file <tmp> --exit-code <n> --json. Before reporting done, run {c2c} route review-gate -w {root} --task {taskId} --tests passed|failed|not_run --json.';
const NEXT_CODEX_THEN_REVIEW =
  'Implement this yourself first (task {taskId}); do not commit or stage. Use route failure for failing commands. When finished, run {c2c} route review-gate -w {root} --task {taskId} --tests passed|failed|not_run [--tests-summary "<e.g. 27 passed>"] [--command "<cmd>" --output-file <tmp> --exit-code <n>] --json and follow it.';
const NEXT_CHATGPT_PLAN =
  'Read the codex-with-chatgpt skill and run "Workflow: coding task" from step 0 with task id {taskId}. When you write the first checkpoint add --routed-by router.';
const NEXT_CHATGPT_PLAN_USER =
  'Read the codex-with-chatgpt skill and run "Workflow: coding task" from step 0 with task id {taskId}. This task was requested by the user.';
const NEXT_KEEP_FIXING = "Keep fixing locally. If this command fails again, run route failure again.";
const NEXT_CLOSE_LOCAL = "Finish locally: summarize the result to the user. No ChatGPT review is needed.";
const NEXT_SEND_REVIEW =
  'The changes are recorded for ChatGPT as iteration 1 and the checkpoint is saved. Read the codex-with-chatgpt skill and run "Workflow: coding task" steps 0–1 (update check, doctor gate, open the chat) with task id {taskId}. Send controlMessage exactly as the INIT. After it is visible: {c2c} session set -w {root} --protocol-state EXECUTED_SENT --waiting-for GPT_REVIEW --next-step "wait for PLAN or DONE". Then continue from step 7. If the user declines a reconnect: {c2c} route pin -w {root} --task {taskId} --route codex --json and summarize locally.';
const NEXT_FOLLOWUPS_THEN_REVIEW =
  "Apply the follow-ups as iteration {n1}, then continue the loop at step 5 (record) and step 6 (send EXECUTED) with iteration {n1}.";

const NEXT: Readonly<Partial<Record<PairKey, string>>> = {
  // enablement
  "disabled/disabled_mode_off": NEXT_DISABLED,
  "disabled/disabled_no_consent": NEXT_DISABLED,
  "disabled/disabled_workspace": NEXT_DISABLED,
  "disabled/not_setup": NEXT_DISABLED,
  // intake
  "codex_solo/explicit_codex": NEXT_CODEX_SOLO,
  "codex_solo/no_egress": NEXT_CODEX_SOLO,
  "codex_solo/not_coding": NEXT_CODEX_SOLO,
  "codex_solo/low_offload": NEXT_CODEX_SOLO,
  "codex_solo/workspace_busy": NEXT_CODEX_SOLO,
  "codex_solo/connection_unavailable": NEXT_CODEX_SOLO,
  "codex_solo/heuristic_default": NEXT_CODEX_SOLO,
  "codex_then_review/review_band": NEXT_CODEX_THEN_REVIEW,
  "codex_then_review/risk_floor": NEXT_CODEX_THEN_REVIEW,
  "chatgpt_plan/plan_offload": NEXT_CHATGPT_PLAN,
  "chatgpt_plan/explicit_chatgpt": NEXT_CHATGPT_PLAN,
  "ask_user/goal_unclear":
    "Ask the user one short question about the result they want (task {taskId}). Do not edit yet. After they answer, run intake again with their clarified request.",
  "ask_user/connection_consent":
    'Ask the user exactly the say line and wait. If they agree: run "Workflow: coding task" of the codex-with-chatgpt skill from step 0 with task id {taskId} and --routed-by router; they already agreed to reconnect, so skip step 0\'s reconnect question and go straight to the repair. If they decline: run {c2c} route pin -w {root} --task {taskId} --route codex --json and handle the task yourself.',
  "active_task/active_task_stale":
    'An unfinished ChatGPT task ({activeTaskId}) exists in this workspace. Ask the user the say question. If they want to continue it: run codex-with-chatgpt "Workflow: coding task" from step 0 with task id {activeTaskId} and follow its resume rules. If not: run {c2c} session set -w {root} --clear-checkpoint, then run intake again.',
  // failure
  "keep_fixing/first_failure": NEXT_KEEP_FIXING,
  "keep_fixing/below_cap": NEXT_KEEP_FIXING,
  "ask_user/needs_user":
    'Stop fixing. Tell the user the say line and ask for the one thing needed (login, key, account, or permission). If this task has a checkpoint, run {c2c} session set -w {root} --waiting-for USER --known-issues "<one-line question>". Wait for the answer.',
  "ask_user/env_or_flaky_cap":
    "Stop retrying. Tell the user the say line and describe the environment problem in one sentence; ask how they want to proceed.",
  "ask_user/stuck_ask_user":
    "Stop fixing. Tell the user the say line, summarize what you tried in two sentences, and ask whether to keep going, change approach, or bring in ChatGPT (if they say yes: {c2c} route pin -w {root} --task {taskId} --route chatgpt --json).",
  "escalate_chatgpt/stuck_escalate_debug":
    'Stop fixing. The failing output is recorded for ChatGPT as iteration 0. Read the codex-with-chatgpt skill and run "Workflow: coding task" steps 0–1 with task id {taskId}. Send controlMessage exactly as the INIT (not the default INIT). After it is visible: {c2c} session set -w {root} --task {taskId} --iteration 0 --state INIT --protocol-state INIT --waiting-for GPT_PLAN --init-mode DEBUG --routed-by router --goal "<short goal>" --next-step "wait for PLAN". Then continue from step 3.',
  "escalate_chatgpt/stuck_in_loop":
    'Stop fixing. Go to step 5 of the coding workflow: record this iteration with --exit-status failed plus this command (--command, --output-file, --exit-code), then send the normal EXECUTED. After it is visible: {c2c} session set -w {root} --protocol-state EXECUTED_SENT --waiting-for GPT_REVIEW --close-local false --next-step "wait for PLAN or DONE".',
  // review gate
  "continue_loop/in_loop":
    "ChatGPT is already reviewing this task. Follow codex-with-chatgpt steps 5–6 (record, then EXECUTED) as usual.",
  "fix_first/tests_failed": "Tests are failing. Fix them first (use route failure), then run review-gate again.",
  "close_local/small_safe": NEXT_CLOSE_LOCAL,
  "close_local/nothing_to_review": NEXT_CLOSE_LOCAL,
  "close_local/committed": NEXT_CLOSE_LOCAL,
  "close_local/escalation_unavailable":
    "Finish locally: summarize the result to the user. If say is set, add it as the last line.",
  "active_task/workspace_busy":
    "Another ChatGPT task is still open in this workspace, so this review was not started and its checkpoint is untouched. Ask the user the say question. To drop that task and review this one: {c2c} session set -w {root} --clear-checkpoint, then run review-gate again with --user-asked-review and follow it. Otherwise summarize this task locally.",
  "send_review/user_asked": NEXT_SEND_REVIEW,
  "send_review/intended_review": NEXT_SEND_REVIEW,
  "send_review/high_risk_paths": NEXT_SEND_REVIEW,
  "send_review/large_diff": NEXT_SEND_REVIEW,
  // reply
  "apply_followups_local/followups_minor":
    'ChatGPT marked the task DONE. Switch back to local work: 1) {c2c} session set -w {root} --protocol-state EXECUTING --waiting-for none --close-local true --next-step "apply DONE follow-ups locally". 2) Apply the follow-ups yourself and run the relevant tests (use route failure if they fail). 3) {c2c} record -w {root} --task {taskId} --iteration {n1} --changed-files "<files>" --tests "<summary>" --exit-status ok --notes "applied DONE follow-ups; not re-reviewed". 4) Summarize to the user and mention that the last small fixes were applied without another ChatGPT review. 5) {c2c} session set -w {root} --state DONE --clear-checkpoint.',
  "apply_followups_then_review/followups_too_many": NEXT_FOLLOWUPS_THEN_REVIEW,
  "apply_followups_then_review/followups_risky": NEXT_FOLLOWUPS_THEN_REVIEW,
  "apply_followups_then_review/followups_substantive": NEXT_FOLLOWUPS_THEN_REVIEW,
  "close_local/followups_none":
    "ChatGPT marked the task DONE with no follow-ups. Summarize the result to the user, then {c2c} session set -w {root} --state DONE --clear-checkpoint.",
  // pin
  "chatgpt_plan/pinned":
    'Run codex-with-chatgpt "Workflow: coding task" from step 0 with task id {taskId}. If you already changed files for this task, first run {c2c} route review-gate -w {root} --task {taskId} --tests passed|failed|not_run --user-asked-review --json and follow it (send its controlMessage instead of the default INIT); if it returns fix_first, run {c2c} route failure -w {root} --task {taskId} --command "<cmd>" --output-file <tmp> --exit-code <n> --json and follow that.',
  "codex_solo/pinned": NEXT_CODEX_SOLO,
};

const NEXT_BY_POINT: Readonly<Partial<Record<PairKey, Partial<Record<DecisionPoint, string>>>>> = {
  "ask_user/reconnect_consent": {
    failure:
      'Ask the user the say line and wait. Yes (they already agreed to reconnect: skip step 0\'s reconnect question): follow codex-with-chatgpt "Workflow: coding task" steps 0–1 with task id {taskId}, then send controlMessage from {c2c} route message debug-init -w {root} --task {taskId} --json as the INIT. After it is visible: {c2c} session set -w {root} --task {taskId} --iteration 0 --state INIT --protocol-state INIT --waiting-for GPT_PLAN --init-mode DEBUG --routed-by router --goal "<short goal>" --next-step "wait for PLAN". Then continue from step 3. No: {c2c} route pin -w {root} --task {taskId} --route codex --json and keep working.',
    review_gate:
      "Ask the user the say line. Yes: run review-gate again with --user-asked-review and follow it (they already agreed to reconnect: skip step 0's reconnect question). No: summarize locally.",
  },
};

// ---------------------------------------------------------------- say templates

const SAY_ACTIVE_TASK_NO_GOAL = "上次让 ChatGPT 协作的任务还没结束，要继续吗？";
const SAY_BUSY_REVIEW_NO_GOAL = "另一个 ChatGPT 协作任务还没结束，要先结束它、改为复核这次改动吗？";

const SAY: Readonly<Partial<Record<PairKey, string>>> = {
  // intake
  "chatgpt_plan/plan_offload":
    "这个任务涉及多处改动和方案取舍，我先请 ChatGPT 出方案再动手（会多等一两分钟；说「别找 ChatGPT」可改为我直接做）。",
  "ask_user/connection_consent": "这个任务建议让 ChatGPT 先规划，但需要先重新连接 ChatGPT（约 1 分钟），现在连接吗？",
  "active_task/active_task_stale": "上次让 ChatGPT 协作的任务「{goal40}」还没结束，要继续吗？",
  // failure
  "ask_user/needs_user": "这个错误需要你来处理一步（比如登录、授权或系统权限），我先暂停。",
  "ask_user/env_or_flaky_cap": "这像是运行环境的问题（不是代码本身），我试了 {n} 次没解决，需要你确认一下。",
  "ask_user/stuck_ask_user": "这个问题我试了 {n} 次还没解决，需要你决定下一步。",
  "escalate_chatgpt/stuck_escalate_debug": "同一个问题我试了 {n} 次还没解决，先请 ChatGPT 帮忙找根因。",
  "escalate_chatgpt/stuck_in_loop": "执行中反复遇到同一个错误，我先把情况交给 ChatGPT 看一下，再继续。",
  // review gate
  "close_local/escalation_unavailable": "这次改动涉及{categoryZh}，如需 ChatGPT 复核，可以说「让 ChatGPT 看看」。",
  "active_task/workspace_busy": "另一个 ChatGPT 协作任务「{goal40}」还没结束，要先结束它、改为复核这次改动吗？",
  "send_review/intended_review": "改动已完成，我请 ChatGPT 帮忙复核一下（约 1–2 分钟）。",
  "send_review/high_risk_paths": "改动涉及{categoryZh}，我请 ChatGPT 复核一下再收尾（约 1–2 分钟）。",
  "send_review/large_diff": "这次改动比较多，我请 ChatGPT 复核一下再收尾（约 1–2 分钟）。",
  // reply
  "apply_followups_local/followups_minor": "ChatGPT 确认主要改动没问题，只剩几处小调整，我直接改完收尾，不再来回确认。",
  "apply_followups_then_review/followups_too_many": "ChatGPT 还提了几处需要再确认的修改，我改完后再请它看一眼。",
  "apply_followups_then_review/followups_risky": "ChatGPT 还提了几处需要再确认的修改，我改完后再请它看一眼。",
  "apply_followups_then_review/followups_substantive": "ChatGPT 还提了几处需要再确认的修改，我改完后再请它看一眼。",
};

const SAY_BY_POINT: Readonly<Partial<Record<PairKey, Partial<Record<DecisionPoint, string>>>>> = {
  "ask_user/reconnect_consent": {
    failure: "同一个问题我试了 {n} 次，想请 ChatGPT 帮忙找根因，但需要先重新连接（约 1 分钟），现在连接吗？",
    review_gate: "改动已完成，建议请 ChatGPT 复核，但需要先重新连接（约 1 分钟），现在连接吗？",
  },
};

// ---------------------------------------------------------------- rendering

export function renderNext(route: Route, reason: ReasonCode, p: NextParams): string {
  const key: PairKey = `${route}/${reason}`;
  const template =
    key === "chatgpt_plan/explicit_chatgpt" && p.explicitUser === true
      ? NEXT_CHATGPT_PLAN_USER
      : lookup(key, NEXT, NEXT_BY_POINT, p.point);
  if (template === undefined) return GENERIC_NEXT;
  return fill(template, {
    taskId: () => taskIdParam(p.taskId, "taskId"),
    activeTaskId: () => taskIdParam(p.activeTaskId, "activeTaskId"),
    root: () => rootParam(p.root),
    c2c: () => c2cParam(p.c2c),
    n1: () => intParam(p.n1, "n1"),
  });
}

export function renderSay(route: Route, reason: ReasonCode, p: SayParams, opts: SayOptions): string | null {
  const key: PairKey = `${route}/${reason}`;
  let template = lookup(key, SAY, SAY_BY_POINT, opts.point);
  if (key === "close_local/escalation_unavailable" && p.categoryZh === undefined) template = undefined;
  const noGoal = p.goal40 === undefined || (typeof p.goal40 === "string" && flatten(p.goal40) === "");
  if (key === "active_task/active_task_stale" && noGoal) template = SAY_ACTIVE_TASK_NO_GOAL;
  if (key === "active_task/workspace_busy" && noGoal) template = SAY_BUSY_REVIEW_NO_GOAL;
  if (template === undefined) return null;
  const say = fill(template, {
    n: () => intParam(p.n, "n"),
    categoryZh: () => categoryParam(p.categoryZh),
    goal40: () => goal40Param(p.goal40),
  });
  return opts.withIntro === true ? `${INTRO_ZH}\n${say}` : say;
}

/** The `next` for `route prefs set --mode auto` without valid consent. */
export function renderSetupNext(c2c: string): string {
  return `Tell the user to run ${c2cParam(c2c)} route setup in their own terminal.`;
}

function lookup(
  key: PairKey,
  plain: Readonly<Partial<Record<PairKey, string>>>,
  byPoint: Readonly<Partial<Record<PairKey, Partial<Record<DecisionPoint, string>>>>>,
  point: DecisionPoint | undefined
): string | undefined {
  const variants = byPoint[key];
  if (!variants) return plain[key];
  const template = point === undefined ? undefined : variants[point];
  if (template === undefined) {
    throw new Error(`${key} needs point ${Object.keys(variants).join(" or ")}`);
  }
  return template;
}

function fill(template: string, values: Record<string, () => string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (!value) throw new Error(`no value for template placeholder {${name}}`);
    return value();
  });
}

function taskIdParam(value: unknown, name: string): string {
  if (typeof value !== "string" || !TASK_ID_RE.test(value)) {
    throw new Error(`${name} must match ${TASK_ID_RE.source}`);
  }
  return value;
}

function rootParam(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("root must be a non-empty string");
  return JSON.stringify(value);
}

function c2cParam(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || /\p{Cc}/u.test(value)) {
    throw new Error("c2c must be a non-empty single-line command");
  }
  return value;
}

function intParam(value: unknown, name: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return String(value);
}

function categoryParam(value: unknown): string {
  if (typeof value !== "string" || !CATEGORY_LABELS.has(value)) {
    throw new Error("categoryZh must be a CATEGORY_LABEL_ZH value");
  }
  return value;
}

function goal40Param(value: unknown): string {
  if (typeof value !== "string") throw new Error("goal40 must be a string");
  return cut(flatten(value), (s) => s.length, GOAL40_MAX_CHARS);
}

// ---------------------------------------------------------------- control messages

const REVIEW_INSTRUCTION = `Codex already implemented iteration 1 without a plan. Do not plan from scratch. Treat this as EXECUTED: execution_summary lists this task's changed files; review them with git_diff mode=head (git_status and read_file for new files). If execution_output lists a readable item for this iteration, list then read it. Reply STATE: DONE, PLAN (iteration 2) or BLOCKED. ${EXECUTED_FOLLOWUPS_LINE}`;
const DEBUG_INSTRUCTION =
  "Codex tried to fix this locally and is stuck. Uncommitted changes are its partial attempt. execution_output has the failing command for this task, iteration 0 (list, then read). Find the root cause and reply with a C2C PLAN. Do not ask for pasted logs.";
const EMPTY_GOAL = "(not recorded)";

export function buildReviewInit(p: { taskId: string; goal: string }): string {
  return buildInit("REVIEW", 1, REVIEW_INSTRUCTION, p);
}

export function buildDebugInit(p: { taskId: string; goal: string }): string {
  return buildInit("DEBUG", 0, DEBUG_INSTRUCTION, p);
}

function buildInit(
  mode: "REVIEW" | "DEBUG",
  iteration: 0 | 1,
  instruction: string,
  p: { taskId: string; goal: string }
): string {
  const taskId = taskIdParam(p.taskId, "taskId");
  if (typeof p.goal !== "string") throw new Error("goal must be a string");
  const compose = (goal: string): string =>
    [
      "[C2C]",
      "STATE: INIT",
      `TASK_ID: ${taskId}`,
      `ITERATION: ${iteration}`,
      `MODE: ${mode}`,
      "",
      "GOAL:",
      goal,
      "",
      "INSTRUCTION:",
      instruction,
    ].join("\n");
  const budget = CONTROL_MESSAGE_MAX_BYTES - utf8Bytes(compose(""));
  return compose(cut(flatten(p.goal) || EMPTY_GOAL, utf8Bytes, budget));
}

// ---------------------------------------------------------------- text helpers

const ELLIPSIS = "…";
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** One line: control, line-separator, bidi-override and lone-surrogate chars become spaces; whitespace runs collapse. */
function flatten(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cs}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut at a grapheme boundary so `measure(result) ≤ max`, ending with "…" when cut. */
function cut(text: string, measure: (s: string) => number, max: number): string {
  if (measure(text) <= max) return text;
  const budget = max - measure(ELLIPSIS);
  let out = "";
  let used = 0;
  for (const piece of segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text)) {
    const size = measure(piece);
    if (used + size > budget) break;
    out += piece;
    used += size;
  }
  return `${out.trimEnd()}${ELLIPSIS}`;
}
