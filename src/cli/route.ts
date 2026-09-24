import fs from "node:fs";
import type { Command, CommanderError } from "commander";
import { z } from "zod";
import type { DecisionPoint, Route, RouteOutput } from "../router/types.js";

/**
 * `c2c route …`: the smart-router CLI. Decision points always exit 0 and print
 * exactly one JSON object with --json (ok:false on invalid input), or one
 * Chinese line without it. Heavy router modules load lazily per command.
 */

const TASK_ID_RE = /^c2c_[0-9a-f]{4}$/;
const LOG_ID_RE = /^r_[0-9a-f]{8}$/;
const MAX_PATH = 4096;
/** Codex passes the first 1500 chars; allow slack for miscounting, the router cuts to 1500. */
const REQUEST_ARG_MAX = 16_000;
const OUTPUT_ARG_MAX = 65_536;
const COMMAND_MAX = 4000;
const REQUEST_FILE_BYTES = 16 * 1024;
const FOLLOWUPS_FILE_BYTES = 16 * 1024;
const FAILURE_OUTPUT_BYTES = 256 * 1024;
const REVIEW_OUTPUT_BYTES = 256 * 1024;

const ROUTE_ZH: Record<Route, string> = {
  disabled: "智能切换未开启，按原流程处理",
  codex_solo: "由 Codex 直接处理",
  codex_then_review: "Codex 先做，完成后请 ChatGPT 复核",
  chatgpt_plan: "先请 ChatGPT 规划",
  ask_user: "需要先问你一下",
  active_task: "有一个未完成的 ChatGPT 任务",
  keep_fixing: "继续在本地修复",
  escalate_chatgpt: "请 ChatGPT 帮忙",
  close_local: "本地收尾，不需要 ChatGPT 复核",
  send_review: "请 ChatGPT 复核",
  fix_first: "测试没通过，先修复",
  continue_loop: "ChatGPT 协作进行中",
  apply_followups_local: "本地完成剩下的小改动",
  apply_followups_then_review: "改完后再请 ChatGPT 看一眼",
};

const BIAS_ZH: Record<string, string> = { economy: "省 Codex 额度", balanced: "均衡", speed: "优先速度" };

function print(text: string): void {
  process.stdout.write(text + "\n");
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function humanRouteLine(out: Pick<RouteOutput, "ok" | "enabled" | "route" | "say" | "taskId" | "error">): string {
  if (!out.ok) return `智能切换出错（${out.error ?? "unknown"}），请按原流程继续。`;
  if (!out.enabled) return "智能切换未开启，按原流程处理。";
  if (out.say) return oneLine(out.say);
  return `智能切换：${ROUTE_ZH[out.route] ?? out.route}${out.taskId ? `（任务 ${out.taskId}）` : ""}。`;
}

function emitRoute(out: RouteOutput | (Omit<RouteOutput, "point"> & { point: string }), json: boolean): void {
  print(json ? JSON.stringify(out) : humanRouteLine(out as RouteOutput));
}

function wantsJson(): boolean {
  return process.argv.includes("--json");
}

/** Generic ok:false for a point, built without loading the router. */
function invalidPointOutput(point: DecisionPoint | "pin", error: string, taskId?: unknown) {
  return {
    ok: false,
    enabled: false,
    point,
    route: "disabled" as const,
    reason: error === "internal_error" ? ("internal_error" as const) : ("invalid_input" as const),
    source: "rule" as const,
    taskId: typeof taskId === "string" && TASK_ID_RE.test(taskId) ? taskId : null,
    say: null,
    next: "Continue the task normally with your own tools.",
    controlMessage: null,
    logId: null,
    error,
  };
}

/**
 * Commander parse errors (unknown flag, missing value, extra argument) must not
 * turn into exit 1 plus stderr text: print one ok:false result and exit 0.
 */
function backstop(command: Command, point: DecisionPoint | "pin" | null, failExitCode = 0): Command {
  return command
    .configureOutput({ outputError: () => {} })
    .exitOverride((err: CommanderError) => {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version" || err.code === "commander.help") {
        return;
      }
      const json = wantsJson();
      let text: string;
      if (point) {
        const out = invalidPointOutput(point, "invalid_arguments");
        text = json ? JSON.stringify(out) : humanRouteLine(out);
      } else {
        text = json ? JSON.stringify({ ok: false, error: "invalid_arguments" }) : "✗ 参数无效（invalid_arguments）";
      }
      try {
        fs.writeSync(1, text + "\n");
      } catch {
        // stdout closed
      }
      process.exit(failExitCode);
    });
}

function issueMessage(error: z.ZodError): string {
  const first = error.issues[0];
  return first?.message && !first.message.startsWith("Expected") && !first.message.startsWith("Required")
    ? first.message
    : `invalid ${first?.path.join(".") || "input"}`;
}

function flagError(flag: string) {
  return { required_error: `missing ${flag}`, invalid_type_error: `invalid ${flag}` };
}

const workspaceField = z.string(flagError("-w")).min(1, "invalid -w").max(MAX_PATH, "invalid -w").optional();
const taskField = z.string(flagError("--task")).regex(TASK_ID_RE, "invalid --task");
const pathField = (flag: string) => z.string(flagError(flag)).min(1, `invalid ${flag}`).max(MAX_PATH, `invalid ${flag}`);
const flag = z.boolean().optional();
const intField = (flag: string, min: number, max: number) =>
  z
    .string(flagError(flag))
    .regex(/^-?\d{1,9}$/, `invalid ${flag}`)
    .transform(Number)
    .refine((n) => Number.isSafeInteger(n) && n >= min && n <= max, `invalid ${flag}`);

function enumField<const T extends [string, ...string[]]>(values: T, flagName: string) {
  return z.enum(values, { errorMap: () => ({ message: `invalid ${flagName}` }) });
}

// ---------------------------------------------------------------- lazy module loading

async function loadRouter() {
  return import("../router/index.js");
}

async function openWorkspace(root: string | undefined) {
  const { Workspace } = await import("../workspace/manager.js");
  try {
    return new Workspace(root ?? process.cwd());
  } catch {
    return null;
  }
}

type LocalRead = { ok: true; text: string } | { ok: false; error: string };

async function readLocal(
  ws: import("../workspace/manager.js").Workspace,
  file: string,
  mode: "head" | "tail",
  maxBytes: number,
  label: string
): Promise<LocalRead> {
  const { guardLocalInput } = await import("../execution/local-input.js");
  const result = guardLocalInput(ws, file, { mode, maxBytes });
  return result.ok ? { ok: true, text: result.text } : { ok: false, error: `${label}_rejected:${result.reason}` };
}

// ---------------------------------------------------------------- decision points

const intakeSchema = z
  .object({
    workspace: workspaceField,
    request: z.string(flagError("--request")).max(REQUEST_ARG_MAX, "invalid --request").optional(),
    requestFile: pathField("--request-file").optional(),
    requestEn: z.string(flagError("--request-en")).max(1000, "invalid --request-en").optional(),
    explicit: enumField(["chatgpt"], "--explicit").optional(),
    threadChat: enumField(["open", "none"], "--thread-chat").optional(),
    json: flag,
    explain: flag,
    dryRun: flag,
  })
  .superRefine((v, ctx) => {
    if (v.request !== undefined && v.requestFile !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "use --request or --request-file, not both" });
    } else if (v.requestFile === undefined && (v.request === undefined || v.request.trim() === "")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "missing --request" });
    }
  });

const failureSchema = z
  .object({
    workspace: workspaceField,
    task: taskField,
    command: z.string(flagError("--command")).min(1, "missing --command").max(COMMAND_MAX, "invalid --command"),
    outputFile: pathField("--output-file").optional(),
    output: z.string(flagError("--output")).max(OUTPUT_ARG_MAX, "invalid --output").optional(),
    exitCode: intField("--exit-code", -1_000_000, 1_000_000).optional(),
    json: flag,
    explain: flag,
    dryRun: flag,
  })
  .superRefine((v, ctx) => {
    if (v.outputFile !== undefined && v.output !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "use --output-file or --output, not both" });
    } else if (v.outputFile === undefined && v.output === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "missing --output-file" });
    }
  });

const reviewSchema = z
  .object({
    workspace: workspaceField,
    task: taskField,
    tests: enumField(["passed", "failed", "not_run"], "--tests"),
    testsSummary: z.string(flagError("--tests-summary")).max(400, "invalid --tests-summary").optional(),
    command: z.string(flagError("--command")).min(1, "invalid --command").max(COMMAND_MAX, "invalid --command").optional(),
    outputFile: pathField("--output-file").optional(),
    output: z.string(flagError("--output")).max(OUTPUT_ARG_MAX, "invalid --output").optional(),
    exitCode: intField("--exit-code", -1_000_000, 1_000_000).optional(),
    userAskedReview: flag,
    json: flag,
    explain: flag,
  })
  .superRefine((v, ctx) => {
    if (v.outputFile !== undefined && v.output !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "use --output-file or --output, not both" });
    }
  });

const replySchema = z
  .object({
    workspace: workspaceField,
    task: taskField,
    iteration: intField("--iteration", 0, 10_000),
    followupsFile: pathField("--followups-file").optional(),
    followup: z.array(z.string().max(2000, "invalid --followup")).max(50, "invalid --followup").optional(),
    json: flag,
    explain: flag,
    dryRun: flag,
  })
  .superRefine((v, ctx) => {
    const inline = v.followup && v.followup.length > 0;
    if (v.followupsFile !== undefined && inline) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "use --followups-file or --followup, not both" });
    } else if (v.followupsFile === undefined && !inline) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "missing --followups-file" });
    }
  });

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

async function runPoint(
  point: DecisionPoint | "pin",
  raw: Record<string, unknown>,
  body: (json: boolean) => Promise<void>
): Promise<void> {
  const json = raw.json === true;
  try {
    await body(json);
  } catch {
    emitRoute(invalidPointOutput(point, "internal_error", raw.task), json);
  }
  process.exitCode = 0;
}

/** Enablement is checked before any local file is read; the disabled path writes nothing. */
async function preflight(
  point: DecisionPoint,
  root: string | undefined,
  json: boolean,
  opts: { explain?: boolean; dryRun?: boolean; taskId?: string }
) {
  const router = await loadRouter();
  const ws = await openWorkspace(root);
  if (!ws) {
    emitRoute(router.errorOutput(point, "workspace_not_found", { taskId: opts.taskId, explain: opts.explain }), json);
    return null;
  }
  const en = router.routerEnablement(ws);
  if (!en.enabled) {
    if (opts.dryRun && point !== "review_gate") {
      print(JSON.stringify(await router.dryRun(point, { root: ws.root })));
    } else {
      emitRoute(
        router.disabledOutput(point, en.reason ?? "disabled_mode_off", { root: ws.root, explain: opts.explain }),
        json
      );
    }
    return null;
  }
  return { router, ws };
}

function registerPoints(route: Command): void {
  backstop(
    route
      .command("intake")
      .description("Decide whether ChatGPT should join a new coding request")
      .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
      .option("--request <text>", "the user's request (first 1500 chars)")
      .option("--request-file <path>", "read the request from a local file")
      .option("--request-en <text>", "English gloss (eval only)")
      .option("--explicit <route>", "chatgpt: explicit 使用 Codex with ChatGPT request")
      .option("--thread-chat <state>", "open | none")
      .option("--json", "machine-readable output")
      .option("--explain", "include signals, probabilities and thresholds")
      .option("--dry-run", "print the payload that would be sent; send and write nothing"),
    "intake"
  ).action((raw: Record<string, unknown>) =>
    runPoint("intake", raw, async (json) => {
      const parsed = intakeSchema.safeParse(raw);
      if (!parsed.success) return emitRoute(invalidPointOutput("intake", issueMessage(parsed.error)), json);
      const o = parsed.data;
      const pre = await preflight("intake", o.workspace, json, { explain: o.explain, dryRun: o.dryRun });
      if (!pre) return;
      let request = o.request ?? "";
      if (o.requestFile !== undefined) {
        const read = await readLocal(pre.ws, o.requestFile, "head", REQUEST_FILE_BYTES, "request_file");
        if (!read.ok) return emitRoute(pre.router.errorOutput("intake", read.error, { explain: o.explain }), json);
        request = read.text;
      }
      if (request.trim() === "") return emitRoute(pre.router.errorOutput("intake", "missing --request", { explain: o.explain }), json);
      const input = {
        root: pre.ws.root,
        request,
        requestEn: o.requestEn,
        explicit: o.explicit,
        threadChat: o.threadChat,
        explain: o.explain === true,
      };
      if (o.dryRun) return print(JSON.stringify(await pre.router.dryRun("intake", input)));
      emitRoute(await pre.router.runIntake(input), json);
    })
  );

  backstop(
    route
      .command("failure")
      .description("After a failed test/build/typecheck/lint command: keep fixing, ask ChatGPT, or ask the user")
      .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
      .option("--task <id>", "task id from intake (c2c_xxxx)")
      .option("--command <cmd>", "the command that failed")
      .option("--output-file <path>", "local file with the command output (last 256 KB are read)")
      .option("--output <text>", "the command output (prefer --output-file)")
      .option("--exit-code <n>", "exit code of the command")
      .option("--json", "machine-readable output")
      .option("--explain", "include signals, probabilities and thresholds")
      .option("--dry-run", "print the payload that would be sent; send and write nothing"),
    "failure"
  ).action((raw: Record<string, unknown>) =>
    runPoint("failure", raw, async (json) => {
      const parsed = failureSchema.safeParse(raw);
      if (!parsed.success) return emitRoute(invalidPointOutput("failure", issueMessage(parsed.error), raw.task), json);
      const o = parsed.data;
      const pre = await preflight("failure", o.workspace, json, { explain: o.explain, dryRun: o.dryRun, taskId: o.task });
      if (!pre) return;
      let output = o.output ?? "";
      if (o.outputFile !== undefined) {
        const read = await readLocal(pre.ws, o.outputFile, "tail", FAILURE_OUTPUT_BYTES, "output_file");
        if (!read.ok) return emitRoute(pre.router.errorOutput("failure", read.error, { taskId: o.task, explain: o.explain }), json);
        output = read.text;
      }
      const input = {
        root: pre.ws.root,
        taskId: o.task,
        command: o.command,
        output,
        exitCode: o.exitCode,
        explain: o.explain === true,
      };
      if (o.dryRun) return print(JSON.stringify(await pre.router.dryRun("failure", input)));
      emitRoute(await pre.router.runFailure(input), json);
    })
  );

  backstop(
    route
      .command("review-gate")
      .description("Before reporting a task done: close locally or ask ChatGPT to review")
      .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
      .option("--task <id>", "task id from intake (c2c_xxxx)")
      .option("--tests <status>", "passed | failed | not_run")
      .option("--tests-summary <text>", "e.g. '27 passed' (≤ 80 chars)")
      .option("--command <cmd>", "test command whose output ChatGPT may read")
      .option("--output-file <path>", "local file with that command's output")
      .option("--output <text>", "that command's output (prefer --output-file)")
      .option("--exit-code <n>", "exit code of that command")
      .option("--user-asked-review", "the user asked for a ChatGPT review")
      .option("--json", "machine-readable output")
      .option("--explain", "include signals and thresholds"),
    "review_gate"
  ).action((raw: Record<string, unknown>) =>
    runPoint("review_gate", raw, async (json) => {
      const parsed = reviewSchema.safeParse(raw);
      if (!parsed.success) return emitRoute(invalidPointOutput("review_gate", issueMessage(parsed.error), raw.task), json);
      const o = parsed.data;
      const pre = await preflight("review_gate", o.workspace, json, { explain: o.explain, taskId: o.task });
      if (!pre) return;
      let output = o.output;
      if (o.outputFile !== undefined) {
        const read = await readLocal(pre.ws, o.outputFile, "head", REVIEW_OUTPUT_BYTES, "output_file");
        if (!read.ok) return emitRoute(pre.router.errorOutput("review_gate", read.error, { taskId: o.task, explain: o.explain }), json);
        output = read.text;
      }
      emitRoute(
        await pre.router.runReviewGate({
          root: pre.ws.root,
          taskId: o.task,
          tests: o.tests,
          testsSummary: o.testsSummary?.slice(0, 80),
          command: o.command,
          output,
          exitCode: o.exitCode,
          userAskedReview: o.userAskedReview === true,
          explain: o.explain === true,
        }),
        json
      );
    })
  );

  backstop(
    route
      .command("reply")
      .description("ChatGPT said DONE with FOLLOWUPS: apply locally or send back for review")
      .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
      .option("--task <id>", "task id (c2c_xxxx)")
      .option("--iteration <n>", "iteration ChatGPT just reviewed")
      .option("--followups-file <path>", "local file with the FOLLOWUPS: section (first 16 KB are read)")
      .option("--followup <item>", "one follow-up item (repeatable)", collect)
      .option("--json", "machine-readable output")
      .option("--explain", "include signals, probabilities and thresholds")
      .option("--dry-run", "print the payload that would be sent; send and write nothing"),
    "reply"
  ).action((raw: Record<string, unknown>) =>
    runPoint("reply", raw, async (json) => {
      const parsed = replySchema.safeParse(raw);
      if (!parsed.success) return emitRoute(invalidPointOutput("reply", issueMessage(parsed.error), raw.task), json);
      const o = parsed.data;
      const pre = await preflight("reply", o.workspace, json, { explain: o.explain, dryRun: o.dryRun, taskId: o.task });
      if (!pre) return;
      let text: string;
      if (o.followupsFile !== undefined) {
        const read = await readLocal(pre.ws, o.followupsFile, "head", FOLLOWUPS_FILE_BYTES, "followups_file");
        if (!read.ok) return emitRoute(pre.router.errorOutput("reply", read.error, { taskId: o.task, explain: o.explain }), json);
        text = read.text;
      } else {
        text = ["FOLLOWUPS:", ...(o.followup ?? []).map((item) => `- ${oneLine(item)}`)].join("\n");
      }
      const input = {
        root: pre.ws.root,
        taskId: o.task,
        iteration: o.iteration,
        followupsText: text,
        explain: o.explain === true,
      };
      if (o.dryRun) return print(JSON.stringify(await pre.router.dryRun("reply", input)));
      emitRoute(await pre.router.runReply(input), json);
    })
  );
}

// ---------------------------------------------------------------- supporting commands (§4.5)

function emitResult(json: boolean, out: Record<string, unknown>, human: string): void {
  print(json ? JSON.stringify(out) : human);
}

async function guarded(json: boolean, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch {
    emitResult(json, { ok: false, error: "internal_error" }, "✗ 智能切换命令出错（internal_error）。");
  }
}

function acceptUnusedWorkspace(command: Command): Command {
  return command.option("-w, --workspace <path>", "ignored; this command is machine-wide");
}

function registerSupport(route: Command): void {
  backstop(
    route
      .command("pin")
      .description("Pin (or unpin) the route of one task")
      .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
      .option("--task <id>", "task id (c2c_xxxx)")
      .option("--route <route>", "chatgpt | codex | none")
      .option("--json", "machine-readable output"),
    "pin"
  ).action((raw: Record<string, unknown>) =>
    runPoint("pin", raw, async (json) => {
      const schema = z.object({
        workspace: workspaceField,
        task: taskField,
        route: enumField(["chatgpt", "codex", "none"], "--route"),
        json: flag,
      });
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return emitRoute(invalidPointOutput("pin", issueMessage(parsed.error), raw.task), json);
      const router = await loadRouter();
      const ws = await openWorkspace(parsed.data.workspace);
      if (!ws) return emitRoute(invalidPointOutput("pin", "workspace_not_found", parsed.data.task), json);
      const out = await router.runPin({ root: ws.root, taskId: parsed.data.task, route: parsed.data.route });
      if (json) print(JSON.stringify(out));
      else if (!out.ok || !out.enabled) print(humanRouteLine({ ...out, route: out.route }));
      else print(out.pin === "codex" ? "好的，这个任务我自己完成，不找 ChatGPT。" : out.pin === "chatgpt" ? "好的，这个任务请 ChatGPT 参与。" : "已取消这个任务的固定路线。");
    })
  );

  const message = backstop(route.command("message").description("Regenerate a REVIEW / DEBUG INIT for a task"), null);
  for (const kind of ["review-init", "debug-init"] as const) {
    backstop(
      message
        .command(kind)
        .description(kind === "review-init" ? "REVIEW INIT (MODE: REVIEW)" : "DEBUG INIT (MODE: DEBUG)")
        .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
        .option("--task <id>", "task id (c2c_xxxx)")
        .option("--json", "machine-readable output"),
      null
    ).action((raw: Record<string, unknown>) => {
      const json = raw.json === true;
      return guarded(json, async () => {
        const schema = z.object({ workspace: workspaceField, task: taskField, json: flag });
        const parsed = schema.safeParse(raw);
        const mode = kind === "review-init" ? "REVIEW" : "DEBUG";
        if (!parsed.success) {
          const error = issueMessage(parsed.error);
          return emitResult(json, { ok: false, taskId: null, mode, controlMessage: null, error }, `✗ ${error}`);
        }
        const router = await loadRouter();
        const out = router.buildControlMessage(parsed.data.workspace ?? process.cwd(), parsed.data.task, kind);
        emitResult(json, { ...out }, out.ok && out.controlMessage ? out.controlMessage : `✗ ${out.error ?? "internal_error"}`);
      });
    });
  }

  const prefs = backstop(route.command("prefs").description("Machine-wide smart-routing preferences (router.json)"), null);
  backstop(
    acceptUnusedWorkspace(prefs.command("get", { isDefault: true }).description("Show routing preferences")).option(
      "--json",
      "machine-readable output"
    ),
    null
  ).action((raw: Record<string, unknown>) => {
    const json = raw.json === true;
    return guarded(json, async () => {
      const { readRouterPrefs } = await import("../config/router-prefs.js");
      const { consentStatus } = await import("../router/secrets.js");
      const p = readRouterPrefs();
      const consent = consentStatus();
      emitResult(
        json,
        { ok: true, mode: p.mode, bias: p.bias, model: p.model, disabledWorkspaces: p.disabledWorkspaces.length, consent },
        `智能切换：${p.mode === "auto" ? "已开启" : "已关闭"}；偏好：${BIAS_ZH[p.bias] ?? p.bias}；模型：${p.model}${consent.accepted ? "" : "（尚未在终端里完成 route setup）"}`
      );
    });
  });
  backstop(
    acceptUnusedWorkspace(prefs.command("set").description("Change routing preferences"))
      .option("--mode <mode>", "off | auto")
      .option("--bias <bias>", "economy | balanced | speed")
      .option("--model <id>", "Jev model id, e.g. jev-1.13.0")
      .option("--json", "machine-readable output"),
    null
  ).action((raw: Record<string, unknown>) => {
    const json = raw.json === true;
    return guarded(json, async () => {
      const schema = z.object({
        workspace: z.string().optional(),
        mode: enumField(["off", "auto"], "--mode").optional(),
        bias: enumField(["economy", "balanced", "speed"], "--bias").optional(),
        model: z.string(flagError("--model")).regex(/^jev-[a-z0-9.-]{1,32}$/, "invalid --model").optional(),
        json: flag,
      });
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const error = issueMessage(parsed.error);
        return emitResult(json, { ok: false, error }, `✗ ${error}`);
      }
      const { mode, bias, model } = parsed.data;
      if (!mode && !bias && !model) {
        return emitResult(json, { ok: false, error: "nothing to save: pass --mode, --bias or --model" }, "✗ 没有要保存的设置（--mode / --bias / --model）。");
      }
      const { mergeRouterPrefs, CONSENT_REQUIRED_WARNING } = await import("../config/router-prefs.js");
      const result = mergeRouterPrefs({ mode, bias, model });
      const warnings = result.warning ? result.warning.split("; ") : [];
      const view = { mode: result.prefs.mode, bias: result.prefs.bias, model: result.prefs.model };
      if (warnings.includes(CONSENT_REQUIRED_WARNING)) {
        const { defaultC2cCommand } = await loadRouter();
        const { renderSetupNext } = await import("../router/messages.js");
        const c2c = defaultC2cCommand();
        return emitResult(
          json,
          { ok: false, error: "consent_required", next: renderSetupNext(c2c), ...view },
          `需要先在你自己的终端里运行 ${c2c} route setup 完成授权，才能开启智能切换。`
        );
      }
      if (warnings.length > 0) {
        return emitResult(json, { ok: false, error: warnings[0], ...view }, `✗ 保存失败（${warnings[0]}）。`);
      }
      emitResult(
        json,
        { ok: true, ...view },
        `✓ 已保存：智能切换${view.mode === "auto" ? "已开启" : "已关闭"}，偏好${BIAS_ZH[view.bias] ?? view.bias}，模型 ${view.model}`
      );
    });
  });

  for (const [name, disabled] of [
    ["disable", true],
    ["enable", false],
  ] as const) {
    backstop(
      route
        .command(name)
        .description(disabled ? "Turn smart routing off for this workspace" : "Turn smart routing back on for this workspace")
        .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
        .option("--json", "machine-readable output"),
      null
    ).action((raw: Record<string, unknown>) => {
      const json = raw.json === true;
      return guarded(json, async () => {
        const parsed = z.object({ workspace: workspaceField, json: flag }).safeParse(raw);
        if (!parsed.success) return emitResult(json, { ok: false, error: issueMessage(parsed.error) }, "✗ 参数无效。");
        const ws = await openWorkspace(parsed.data.workspace);
        if (!ws) return emitResult(json, { ok: false, error: "workspace_not_found" }, "✗ 找不到这个工作区。");
        const { setWorkspaceDisabled } = await import("../config/router-prefs.js");
        const result = setWorkspaceDisabled(ws.id, disabled);
        if (result.warning) {
          return emitResult(json, { ok: false, error: result.warning, disabled: !disabled }, `✗ 保存失败（${result.warning}）。`);
        }
        emitResult(
          json,
          { ok: true, disabled },
          disabled ? "✓ 这个项目不再自动找 ChatGPT。" : "✓ 已恢复这个项目的智能切换。"
        );
      });
    });
  }

  backstop(
    route
      .command("status")
      .description("Routing mode, consent, key fingerprint, breaker and Jev reachability")
      .option("-w, --workspace <path>", "also report this workspace")
      .option("--probe", "make one live 1-question Jev call")
      .option("--json", "machine-readable output"),
    null
  ).action((raw: Record<string, unknown>) => {
    const json = raw.json === true;
    return guarded(json, async () => {
      const parsed = z.object({ workspace: workspaceField, probe: flag, json: flag }).safeParse(raw);
      if (!parsed.success) return emitResult(json, { ok: false, error: issueMessage(parsed.error) }, "✗ 参数无效。");
      const router = await loadRouter();
      const out = await router.routerStatus({ root: parsed.data.workspace, probe: parsed.data.probe === true });
      const human = [
        `智能切换：${out.enabled ? "已开启" : "未开启"}（${out.mode}，${BIAS_ZH[out.bias] ?? out.bias}，${out.model}）`,
        `授权：${out.consent.accepted ? "已同意" : "未完成"}；Key：${out.key.configured ? `已配置（${out.key.source}，${out.key.fingerprint8}）` : "未配置"}；Jev：${out.jev}${out.breaker.open ? `；熔断中（${out.breaker.reason ?? "?"}）` : ""}`,
        ...(out.workspace
          ? [`工作区：${out.workspace.setup ? "已连接过 C2C" : "尚未设置 C2C"}${out.workspace.disabled ? "，已关闭智能切换" : ""}；连接：${out.workspace.connection}`]
          : []),
      ].join("\n");
      emitResult(json, { ...out }, out.ok ? human : `✗ ${out.error ?? "internal_error"}`);
    });
  });

  backstop(
    acceptUnusedWorkspace(route.command("setup").description("Enable smart routing (run this in your own terminal)")).option(
      "--remove",
      "delete the key and consent, and turn routing off"
    ),
    null,
    1
  ).action(async (raw: Record<string, unknown>) => {
    const { runSetup } = await import("../router/setup.js");
    const { CHECKOUT_ROOT } = await loadRouter();
    process.exitCode = await runSetup({ remove: raw.remove === true, checkoutRoot: CHECKOUT_ROOT });
  });

  backstop(
    route
      .command("log")
      .description("Recent routing decisions (numbers and enums only)")
      .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
      .option("--limit <n>", "how many decisions (default 20)")
      .option("--json", "machine-readable output"),
    null
  ).action((raw: Record<string, unknown>) => {
    const json = raw.json === true;
    return guarded(json, async () => {
      const parsed = z
        .object({ workspace: workspaceField, limit: intField("--limit", 1, 2000).optional(), json: flag })
        .safeParse(raw);
      if (!parsed.success) return emitResult(json, { ok: false, error: issueMessage(parsed.error) }, "✗ 参数无效。");
      const ws = await openWorkspace(parsed.data.workspace);
      if (!ws) return emitResult(json, { ok: false, error: "workspace_not_found" }, "✗ 找不到这个工作区。");
      const { readDecisions } = await import("../router/log.js");
      const decisions = readDecisions(ws.id, parsed.data.limit ?? 20);
      const human =
        decisions.length === 0
          ? "还没有智能切换的记录。"
          : decisions
              .map(
                (d) =>
                  `${d.ts} ${d.logId} ${d.point} → ${d.route}（${d.reason}，${d.source}${d.jevError ? `，jev:${d.jevError}` : ""}）${d.taskId ? ` ${d.taskId}` : ""}`
              )
              .join("\n");
      emitResult(json, { ok: true, decisions }, human);
    });
  });

  backstop(
    route
      .command("stats")
      .description("A one-line Chinese summary of recent routing")
      .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
      .option("--json", "machine-readable output"),
    null
  ).action((raw: Record<string, unknown>) => {
    const json = raw.json === true;
    return guarded(json, async () => {
      const parsed = z.object({ workspace: workspaceField, json: flag }).safeParse(raw);
      if (!parsed.success) return emitResult(json, { ok: false, error: issueMessage(parsed.error) }, "✗ 参数无效。");
      const ws = await openWorkspace(parsed.data.workspace);
      if (!ws) return emitResult(json, { ok: false, error: "workspace_not_found" }, "✗ 找不到这个工作区。");
      const { computeStats, formatStatsZh } = await import("../router/log.js");
      const stats = computeStats(ws.id);
      const summary = formatStatsZh(stats);
      emitResult(json, { ok: true, stats, summary }, summary);
    });
  });

  backstop(
    route
      .command("feedback")
      .description("Mark a routing decision right or wrong")
      .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
      .option("--last", "the most recent decision")
      .option("--log-id <id>", "a decision's logId (r_xxxxxxxx)")
      .option("--verdict <verdict>", "right | wrong")
      .option("--expected <route>", "the route that would have been right")
      .option("--json", "machine-readable output"),
    null
  ).action((raw: Record<string, unknown>) => {
    const json = raw.json === true;
    return guarded(json, async () => {
      const { ROUTES } = await import("../router/types.js");
      const parsed = z
        .object({
          workspace: workspaceField,
          last: flag,
          logId: z.string(flagError("--log-id")).regex(LOG_ID_RE, "invalid --log-id").optional(),
          verdict: enumField(["right", "wrong"], "--verdict"),
          expected: z
            .string(flagError("--expected"))
            .refine((v) => (ROUTES as readonly string[]).includes(v), "invalid --expected")
            .optional(),
          json: flag,
        })
        .superRefine((v, ctx) => {
          if ((v.last === true) === (v.logId !== undefined)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pass --last or --log-id" });
          }
        })
        .safeParse(raw);
      if (!parsed.success) {
        const error = issueMessage(parsed.error);
        return emitResult(json, { ok: false, error }, `✗ ${error}`);
      }
      const ws = await openWorkspace(parsed.data.workspace);
      if (!ws) return emitResult(json, { ok: false, error: "workspace_not_found" }, "✗ 找不到这个工作区。");
      const log = await import("../router/log.js");
      const decision = parsed.data.logId ? log.findDecision(ws.id, parsed.data.logId) : log.lastDecision(ws.id);
      if (!decision) return emitResult(json, { ok: false, error: "no_decision" }, "还没有可以反馈的智能切换记录。");
      const result = log.appendLabel(ws.id, decision.logId, {
        verdict: parsed.data.verdict,
        ...(parsed.data.expected ? { expected: parsed.data.expected as Route } : {}),
      });
      if (!result.ok) return emitResult(json, { ok: false, error: result.warning ?? "write_failed" }, "✗ 反馈保存失败。");
      emitResult(json, { ok: true, logId: decision.logId, verdict: parsed.data.verdict }, "✓ 已记下你的反馈，谢谢。");
    });
  });

  backstop(
    acceptUnusedWorkspace(route.command("eval").description("Evaluate routing on the bundled fixtures"))
      .option("--live", "call Jev for each fixture (needs setup; costs a few cents)")
      .option("--variant <variant>", "gloss: intake with request_en")
      .option("--points <list>", "comma-separated: intake,failure,reply")
      .option("--save-answers <file>", "save live answers for --replay")
      .option("--replay <file>", "re-apply the current policy to saved answers")
      .option("--json", "machine-readable output"),
    null,
    1
  ).action(async (raw: Record<string, unknown>) => {
    const json = raw.json === true;
    const schema = z.object({
      workspace: z.string().optional(),
      live: flag,
      variant: enumField(["gloss"], "--variant").optional(),
      points: z
        .string(flagError("--points"))
        .transform((v) => v.split(",").map((p) => p.trim()).filter(Boolean))
        .refine((list) => list.length > 0 && list.every((p) => ["intake", "failure", "reply"].includes(p)), "invalid --points")
        .optional(),
      saveAnswers: pathField("--save-answers").optional(),
      replay: pathField("--replay").optional(),
      json: flag,
    });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const error = issueMessage(parsed.error);
      emitResult(json, { ok: false, error }, `✗ ${error}`);
      process.exitCode = 1;
      return;
    }
    await runEvalCommand(parsed.data, json);
  });
}

async function runEvalCommand(
  o: { live?: boolean; variant?: "gloss"; points?: string[]; saveAnswers?: string; replay?: string },
  json: boolean
): Promise<void> {
  try {
    const { runEval, formatEvalReportZh } = await import("../router/eval.js");
    const report = await runEval({
      live: o.live === true,
      ...(o.variant ? { variant: o.variant } : {}),
      ...(o.points ? { points: o.points as DecisionPoint[] } : {}),
      ...(o.saveAnswers ? { saveAnswers: o.saveAnswers } : {}),
      ...(o.replay ? { replay: o.replay } : {}),
    });
    print(json ? JSON.stringify(report) : formatEvalReportZh(report));
    // a dev/CI check: a failing report fails the command
    process.exitCode = report.ok ? 0 : 1;
  } catch {
    emitResult(json, { ok: false, error: "internal_error" }, "✗ 评测失败（internal_error）。");
    process.exitCode = 1;
  }
}

export function registerRouteCommands(program: Command): void {
  const route = backstop(
    program.command("route").description("Smart routing: decide when Codex brings in ChatGPT (TypeSafe Jev)"),
    null
  );
  registerPoints(route);
  registerSupport(route);
}
