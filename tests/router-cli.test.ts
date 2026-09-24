import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { mergeRouterPrefs } from "../src/config/router-prefs.js";
import { listExecutionOutputs } from "../src/execution/output.js";
import { readExecutionRecords } from "../src/execution/records.js";
import { decisionLogFile, readLogLines } from "../src/router/log.js";
import { CONSENT_VERSION, fingerprintKey, writeRouterSecrets } from "../src/router/secrets.js";
import { readTaskState } from "../src/router/state.js";
import {
  DECISION_POINTS,
  FAILURE_KINDS,
  LOG_ID_RE,
  REASON_CODES,
  ROUTES,
  SOURCES,
  TASK_ID_RE,
  TASK_KINDS,
} from "../src/router/types.js";
import { mergeSession, readSession, writeSession } from "../src/session/state.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");
const TEST_KEY = "tsk-test-0123456789abcdef0123";
const INTRO = "我会按任务自动决定是否请 ChatGPT 参与；随时可以说「这次别找 ChatGPT」或「让 ChatGPT 来规划」。";

// ---------------------------------------------------------------- fake Jev answers

type Answers = Record<string, unknown>;

function choice(probs: Record<string, number>, labels: readonly string[], confidence = 0.85) {
  const full = Object.fromEntries(labels.map((label) => [label, probs[label] ?? 0]));
  const best = Object.entries(full).sort((a, b) => b[1] - a[1])[0][0];
  return { type: "choice", choice: best, confidence, probabilities: full };
}

function score(probs: number[], confidence = 0.8) {
  const best = probs.indexOf(Math.max(...probs));
  return { type: "score", score: best, confidence, probabilities: Object.fromEntries(probs.map((p, i) => [String(i), p])) };
}

const noul = (p: number) => ({ type: "noul", noul: p });

function intakeAnswers(kind: Record<string, number>, scope: number[], needsDesign: number): Answers {
  return {
    task_kind: choice(kind, TASK_KINDS),
    scope: score(scope),
    needs_design: noul(needsDesign),
    goal_is_clear: noul(0.9),
    touches_auth_security: noul(0.05),
    touches_stored_data: noul(0.05),
    touches_concurrency: noul(0.05),
    changes_public_interface: noul(0.05),
  };
}

const PLAN_INTAKE = intakeAnswers({ design_or_architecture: 0.8, new_feature: 0.2 }, [0, 0, 0.1, 0.1, 0.5, 0.3], 0.9);
const SOLO_INTAKE = intakeAnswers({ targeted_change: 0.9, new_feature: 0.1 }, [0, 0.7, 0.3, 0, 0, 0], 0.1);
const RISKY_INTAKE: Answers = { ...SOLO_INTAKE, touches_auth_security: noul(0.9) };
const FAILURE_ANSWERS: Answers = {
  failure_kind: choice(
    { runtime_exception: 0.85, compile_or_type_error: 0.03, assertion_mismatch: 0.03, other: 0.09 },
    FAILURE_KINDS,
    0.85
  ),
  needs_user: noul(0.05),
};
const REPLY_ANSWERS: Answers = { "followup_*_size": score([0.8, 0.2, 0, 0], 0.9) };

function fakeEntry(answers: Answers) {
  return { model: "jev-1.13.0", answers, usage: { input_tokens: 900, output_tokens: 30 } };
}

// ---------------------------------------------------------------- environment

interface Env {
  root: string;
  stateDir: string;
  keysDir: string;
  outDir: string;
  fakeFile: string;
  ws: Workspace;
}

const created: string[] = [];
const previous = { state: process.env.C2C_STATE_DIR, keys: process.env.C2C_KEYS_DIR };

beforeEach(() => {
  created.length = 0;
});

afterEach(() => {
  for (const dir of created) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // ignore
    }
    cleanup(dir);
  }
  if (previous.state === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previous.state;
  if (previous.keys === undefined) delete process.env.C2C_KEYS_DIR;
  else process.env.C2C_KEYS_DIR = previous.keys;
});

function tmp(name: string): string {
  const dir = makeTmpDir(name);
  created.push(dir);
  return dir;
}

function makeEnv(opts: { enabled?: boolean; fake?: Record<string, unknown>; gitRepo?: boolean } = {}): Env {
  const root = tmp("router-cli-ws");
  const stateDir = tmp("router-cli-state");
  const keysDir = tmp("router-cli-keys");
  const outDir = tmp("router-cli-out");
  process.env.C2C_STATE_DIR = stateDir;
  process.env.C2C_KEYS_DIR = keysDir;
  if (opts.gitRepo) makeGitRepo(root);
  const ws = new Workspace(root);
  if (opts.enabled) {
    writeRouterSecrets({
      v: 1,
      consent: { version: CONSENT_VERSION, acceptedAt: new Date().toISOString() },
      keySource: "file",
      apiKey: TEST_KEY,
      fingerprint: fingerprintKey(TEST_KEY),
    });
    expect(mergeRouterPrefs({ mode: "auto" }).prefs.mode).toBe("auto");
    writeLastEndpoint({
      workspaceId: ws.id,
      port: 48765,
      publicUrl: "https://router-test.example.com",
      mcpUrl: "https://router-test.example.com/mcp",
    });
  }
  const fakeFile = path.join(outDir, "fake-jev.json");
  if (opts.fake) fs.writeFileSync(fakeFile, JSON.stringify(opts.fake));
  return { root, stateDir, keysDir, outDir, fakeFile, ws };
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, any>;
}

type RunOpts = { ready?: boolean; connection?: string; nodeArgs?: string[]; fake?: boolean };

function run(env: Env, args: string[], opts: RunOpts = {}): RunResult {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, C2C_STATE_DIR: env.stateDir, C2C_KEYS_DIR: env.keysDir, VITEST: "true" };
  delete childEnv.C2C_ROUTER_FAKE_JEV;
  delete childEnv.C2C_ROUTER_FAKE_CONNECTION;
  delete childEnv.CODEX_SANDBOX_NETWORK_DISABLED;
  delete childEnv.TYPESAFE_API_KEY;
  if (opts.fake !== false && fs.existsSync(env.fakeFile)) childEnv.C2C_ROUTER_FAKE_JEV = env.fakeFile;
  if (opts.ready) childEnv.C2C_ROUTER_FAKE_CONNECTION = "ready";
  if (opts.connection) childEnv.C2C_ROUTER_FAKE_CONNECTION = opts.connection;
  const result = spawnSync(process.execPath, [...(opts.nodeArgs ?? []), "--import", "tsx", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: childEnv,
  });
  let json: Record<string, any> = {};
  const lines = result.stdout.trim().split("\n");
  if (args.includes("--json")) {
    expect(lines, result.stdout + result.stderr).toHaveLength(1);
    json = JSON.parse(lines[0]);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function route(env: Env, point: string, args: string[], opts: RunOpts = {}) {
  const result = run(env, ["route", point, "-w", env.root, ...args, "--json"], opts);
  expect(result.status, result.stderr).toBe(0);
  return result.json;
}

function fakeCalls(env: Env): string[] {
  try {
    return fs.readFileSync(`${env.fakeFile}.calls`, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = fs.statSync(full);
        out.push(`${path.relative(dir, full)}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

const routeOutputSchema = z
  .object({
    ok: z.boolean(),
    enabled: z.boolean(),
    point: z.enum(DECISION_POINTS as [string, ...string[]]),
    route: z.enum(ROUTES as [string, ...string[]]),
    reason: z.enum(REASON_CODES as [string, ...string[]]),
    source: z.enum(SOURCES as [string, ...string[]]),
    taskId: z.string().regex(TASK_ID_RE).nullable(),
    say: z.string().max(160 + 80).nullable(),
    next: z.string().min(1),
    controlMessage: z.string().nullable(),
    logId: z.string().regex(LOG_ID_RE).nullable(),
    activeCheckpoint: z.unknown().optional(),
    error: z.string().optional(),
    explain: z.unknown().optional(),
  })
  .strict();

const VITEST_FAILURE = [
  " FAIL  tests/parse.test.ts > parses the order",
  "TypeError: Cannot read properties of undefined (reading 'id')",
  " ❯ parseOrder src/orders/parse.ts:12:18",
  " ❯ tests/parse.test.ts:8:5",
  "Test Files  1 failed (1)",
].join("\n");

// ---------------------------------------------------------------- scenarios

describe("c2c route (CLI)", () => {
  it("1. disabled: exits 0 with enabled:false, writes nothing and never fetches", () => {
    const env = makeEnv();
    const guard = write(
      env.outDir,
      "fetch-guard.mjs",
      `import fs from "node:fs";\nglobalThis.fetch = () => { fs.writeFileSync(${JSON.stringify(path.join(env.outDir, "fetched"))}, "1"); throw new Error("network is off in tests"); };\n`
    );
    const out = route(env, "intake", ["--request", "修复登录页的 bug"], { nodeArgs: ["--import", guard] });
    expect(routeOutputSchema.parse(out)).toMatchObject({
      ok: true,
      enabled: false,
      route: "disabled",
      reason: "disabled_mode_off",
      taskId: null,
      say: null,
      logId: null,
    });
    expect(out.next).toBe(
      "Smart routing is off here. Work on the request normally with your own tools. Do not mention ChatGPT or routing."
    );
    expect(fs.readdirSync(env.stateDir)).toEqual([]);
    expect(fs.readdirSync(env.keysDir)).toEqual([]);
    expect(fs.existsSync(path.join(env.outDir, "fetched"))).toBe(false);

    for (const point of ["failure", "review-gate", "reply"]) {
      const args =
        point === "failure"
          ? ["--task", "c2c_ab12", "--command", "pnpm test", "--output", "Error: boom"]
          : point === "review-gate"
            ? ["--task", "c2c_ab12", "--tests", "passed"]
            : ["--task", "c2c_ab12", "--iteration", "1", "--followup", "rename tmp"];
      expect(route(env, point, args)).toMatchObject({ ok: true, enabled: false, route: "disabled" });
    }
    expect(fs.readdirSync(env.stateDir)).toEqual([]);
  });

  it("2. enabled with fake answers: chatgpt_plan JSON matches the schema and stays small", () => {
    const env = makeEnv({ enabled: true, fake: { intake: fakeEntry(PLAN_INTAKE) } });
    const request = "帮我设计团队的权限模型，要支持多租户，前后端和数据库都要改";
    const out = route(env, "intake", ["--request", request], { ready: true });
    expect(routeOutputSchema.parse(out)).toMatchObject({
      ok: true,
      enabled: true,
      point: "intake",
      route: "chatgpt_plan",
      reason: "plan_offload",
      source: "jev",
      controlMessage: null,
      activeCheckpoint: null,
    });
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(1200);
    expect(out.taskId).toMatch(TASK_ID_RE);
    expect(out.logId).toMatch(LOG_ID_RE);
    expect(out.next).toContain(`task id ${out.taskId}`);
    expect(out.next).toContain("--routed-by router");
    expect(out.say?.startsWith(`${INTRO}\n`)).toBe(true);
    expect(fakeCalls(env)).toEqual(["intake"]);

    const state = readTaskState(env.ws.id, out.taskId);
    expect(state).toMatchObject({ intakeRoute: "chatgpt_plan", engaged: true, outSwitches: 1, intakeLogId: out.logId });
    const decisions = readLogLines(env.ws.id).filter((line) => line.kind === "decision");
    expect(decisions).toHaveLength(1);
    expect(fs.readFileSync(decisionLogFile(env.ws.id), "utf8")).not.toContain("权限");

    // the intro line is shown once per machine
    const second = route(env, "intake", ["--request", request], { ready: true });
    expect(second.route).toBe("chatgpt_plan");
    expect(second.say).toBe("这个任务涉及多处改动和方案取舍，我先请 ChatGPT 出方案再动手（会多等一两分钟；说「别找 ChatGPT」可改为我直接做）。");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "3. read-only state dir: still exits 0 with valid JSON and reports warnings",
    () => {
      const env = makeEnv({ enabled: true, fake: { intake: fakeEntry(PLAN_INTAKE) } });
      fs.chmodSync(env.stateDir, 0o555);
      const out = route(env, "intake", ["--request", "帮我设计团队的权限模型，要支持多租户", "--explain"], { ready: true });
      expect(routeOutputSchema.parse(out).ok).toBe(true);
      expect(out.enabled).toBe(true);
      expect(out.route).toBe("chatgpt_plan");
      expect(out.logId).toBeNull();
      expect(out.explain.warnings.length).toBeGreaterThan(0);
      expect(out.explain.warnings.join(" ")).toMatch(/task_state_write_failed|decision_log_write_failed/);
    }
  );

  it("4. failure sequence: first attempt stays local, a repeated failure escalates with a DEBUG INIT", () => {
    const env = makeEnv({ enabled: true, fake: { intake: fakeEntry(SOLO_INTAKE), failure: fakeEntry(FAILURE_ANSWERS) } });
    const intake = route(env, "intake", ["--request", "修复订单解析时偶发的崩溃"], { ready: true });
    expect(intake).toMatchObject({ route: "codex_solo", reason: "low_offload" });
    const taskId = intake.taskId as string;
    const log = write(env.outDir, "vitest.log", VITEST_FAILURE);
    const args = ["--task", taskId, "--command", "pnpm test tests/parse.test.ts", "--output-file", log, "--exit-code", "1"];

    const first = route(env, "failure", args, { ready: true });
    expect(routeOutputSchema.parse(first)).toMatchObject({ route: "keep_fixing", reason: "first_failure", source: "rule" });
    expect(fakeCalls(env)).toEqual(["intake"]);

    const second = route(env, "failure", args, { ready: true });
    expect(second).toMatchObject({ route: "keep_fixing", reason: "below_cap", source: "jev" });
    expect(fakeCalls(env)).toEqual(["intake", "failure"]);

    const third = route(env, "failure", args, { ready: true });
    expect(routeOutputSchema.parse(third)).toMatchObject({
      route: "escalate_chatgpt",
      reason: "stuck_escalate_debug",
      taskId,
    });
    // the first non-null say on this machine carries the one-time intro line
    expect(third.say).toBe(`${INTRO}\n同一个问题我试了 3 次还没解决，先请 ChatGPT 帮忙找根因。`);
    expect(third.controlMessage).toContain("MODE: DEBUG");
    expect(third.controlMessage).toContain(`TASK_ID: ${taskId}`);
    expect(third.controlMessage).toContain("ITERATION: 0");
    expect(Buffer.byteLength(third.controlMessage, "utf8")).toBeLessThanOrEqual(1000);

    const records = readExecutionRecords(env.ws.id);
    expect(records).toEqual([
      expect.objectContaining({ taskId, iteration: 0, exitStatus: "failed", tests: null, outputAvailable: true }),
    ]);
    expect(listExecutionOutputs(env.ws.id)).toEqual([
      expect.objectContaining({ taskId, iteration: 0, exitCode: 1, allowed: true }),
    ]);
    expect(readTaskState(env.ws.id, taskId)).toMatchObject({ engaged: true, outSwitches: 1 });
    // escalation resets this command's counter (eval.simulateFailure models the same)
    expect(readTaskState(env.ws.id, taskId)?.failures).toEqual([]);
    const labels = readLogLines(env.ws.id).filter((line) => line.kind === "label");
    expect(labels).toEqual([expect.objectContaining({ label: "escalated_after_solo", logId: intake.logId })]);

    const fourth = route(env, "failure", args, { ready: true });
    expect(fourth).toMatchObject({ route: "keep_fixing", reason: "first_failure", source: "rule" });
  });

  it("5. review gate in a git repo: only the task's own files count; auth path → send_review", () => {
    const env = makeEnv({ enabled: true, gitRepo: true, fake: { intake: fakeEntry(SOLO_INTAKE) } });
    write(env.root, "hello.txt", "edited before the task\n");
    write(env.root, "notes/todo.md", "- unrelated\n");
    const intake = route(env, "intake", ["--request", "登录接口加上失败次数限制"], { ready: true });
    expect(intake.route).toBe("codex_solo");
    const taskId = intake.taskId as string;
    expect(readTaskState(env.ws.id, taskId)?.baseline?.entries).toHaveProperty("hello.txt");

    write(env.root, "src/auth/login.ts", Array.from({ length: 12 }, (_, i) => `export const limit${i} = ${i};`).join("\n") + "\n");
    const out = route(env, "review-gate", ["--task", taskId, "--tests", "passed", "--tests-summary", "3 passed"], {
      ready: true,
    });
    expect(routeOutputSchema.parse(out)).toMatchObject({
      route: "send_review",
      reason: "high_risk_paths",
      source: "rule",
      taskId,
    });
    expect(out.say).toBe(`${INTRO}\n改动涉及登录/权限相关代码，我请 ChatGPT 复核一下再收尾（约 1–2 分钟）。`);
    expect(out.controlMessage).toContain("MODE: REVIEW");
    expect(out.controlMessage).toContain("ITERATION: 1");
    expect(Buffer.byteLength(out.controlMessage, "utf8")).toBeLessThanOrEqual(1000);

    expect(readExecutionRecords(env.ws.id)).toEqual([
      expect.objectContaining({ taskId, iteration: 1, changedFiles: ["src/auth/login.ts"], tests: "3 passed", exitStatus: "ok" }),
    ]);
    expect(readSession(env.ws.id)?.checkpoint).toMatchObject({
      taskId,
      iteration: 1,
      protocolState: "EXECUTED_LOCAL",
      waitingFor: "none",
      initMode: "REVIEW",
      routedBy: "router",
    });
    expect(readTaskState(env.ws.id, taskId)).toMatchObject({ engaged: true, outSwitches: 1 });

    // once ChatGPT is engaged the gate only says: keep following the loop
    const again = route(env, "review-gate", ["--task", taskId, "--tests", "passed"], { ready: true });
    expect(again).toMatchObject({ route: "continue_loop", reason: "in_loop" });
    git(env.root, "status");
  });

  it("6. canary: request, error output and FOLLOWUPS text never reach the JSON (except the request in GOAL)", () => {
    const env = makeEnv({
      enabled: true,
      fake: { intake: fakeEntry(SOLO_INTAKE), failure: fakeEntry(FAILURE_ANSWERS), reply: fakeEntry(REPLY_ANSWERS) },
    });
    const REQ = "ZQXCANARYREQ";
    const ERR = "ZQXCANARYERR";
    const FUP = "ZQXCANARYFUP";
    const intake = route(env, "intake", ["--request", `把设置页的标题改成「设置」${REQ}`, "--explain"], { ready: true });
    expect(intake.route).toBe("codex_solo");
    expect(JSON.stringify(intake)).not.toContain(REQ);
    const taskId = intake.taskId as string;

    const log = write(env.outDir, "err.log", `Error: ${ERR} exploded\n    at run (src/a.ts:1:1)\nTypeError: ${ERR}\n`);
    const outputs = [1, 2, 3].map(() =>
      route(env, "failure", ["--task", taskId, "--command", `pnpm test ${ERR}`, "--output-file", log, "--exit-code", "1", "--explain"], {
        ready: true,
      })
    );
    expect(outputs[2].route).toBe("escalate_chatgpt");
    for (const out of outputs) {
      expect(JSON.stringify(out)).not.toContain(ERR);
      expect(JSON.stringify({ ...out, controlMessage: null })).not.toContain(REQ);
    }
    expect(outputs[2].controlMessage).toContain(REQ);

    const followups = write(env.outDir, "followups.md", `STATE: DONE\nFOLLOWUPS:\n- rename ${FUP} to result\n- fix the typo in the README\n`);
    const reply = route(env, "reply", ["--task", taskId, "--iteration", "1", "--followups-file", followups, "--explain"]);
    expect(reply).toMatchObject({ route: "apply_followups_local", reason: "followups_minor", source: "jev" });
    expect(reply.next).toContain("--iteration 2");
    expect(JSON.stringify(reply)).not.toContain(FUP);

    const logText = fs.readFileSync(decisionLogFile(env.ws.id), "utf8");
    for (const canary of [REQ, ERR, FUP]) expect(logText).not.toContain(canary);
    expect(fakeCalls(env)).toEqual(["intake", "failure", "failure", "reply"]);
  });

  it("7. --dry-run prints a redacted payload and writes nothing", () => {
    const env = makeEnv({ enabled: true, fake: { intake: fakeEntry(SOLO_INTAKE) } });
    const before = listFiles(env.stateDir);
    const secret = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const out = route(env, "intake", ["--request", `修复登录 bug，测试 key 是 ${secret}，有问题发 dev@example.com`, "--dry-run"]);
    expect(out).toMatchObject({ point: "intake", ok: true, enabled: true, wouldSend: true, model: "jev-1.13.0", qsv: "2026-09-23.1" });
    expect(out.questionIds).toHaveLength(8);
    expect(out.state.request).toContain("[REDACTED]");
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(JSON.stringify(out)).not.toContain("dev@example.com");
    expect(JSON.stringify(out)).not.toContain(TEST_KEY);

    const failure = route(env, "failure", ["--task", "c2c_ab12", "--command", "pnpm test", "--output", `Error: ${secret}`, "--dry-run"]);
    expect(failure).toMatchObject({ point: "failure", wouldSend: false });
    expect(JSON.stringify(failure)).not.toContain(secret);

    expect(listFiles(env.stateDir)).toEqual(before);
    expect(fakeCalls(env)).toEqual([]);
  });

  it("8. output files: sensitive names, protected dirs and symlinks are rejected; so is record --output-file .env", () => {
    const env = makeEnv({ enabled: true, fake: { failure: fakeEntry(FAILURE_ANSWERS) } });
    const secretText = "-----BEGIN OPENSSH PRIVATE KEY----- AAAA";
    const cases: Array<[string, string]> = [
      [write(env.outDir, "ssh/id_rsa", secretText), "sensitive"],
      [write(env.root, ".env", "OPENAI_API_KEY=sk-test-not-a-real-key\n"), "sensitive"],
      [write(env.stateDir, "leak.log", "Error: state\n"), "protected_location"],
      [write(env.keysDir, "leak.log", "Error: keys\n"), "protected_location"],
    ];
    if (process.platform !== "win32") {
      const target = write(env.outDir, "real.log", "Error: real\n");
      const link = path.join(env.outDir, "link.log");
      fs.symlinkSync(target, link);
      cases.push([link, "symlink"]);
    }
    for (const [file, reason] of cases) {
      const out = route(env, "failure", ["--task", "c2c_ab12", "--command", "pnpm test", "--output-file", file]);
      expect(routeOutputSchema.parse(out)).toMatchObject({ ok: false, error: `output_file_rejected:${reason}`, reason: "invalid_input" });
      expect(JSON.stringify(out)).not.toContain("PRIVATE KEY");
      expect(JSON.stringify(out)).not.toContain("sk-test-not-a-real-key");
    }
    expect(readTaskState(env.ws.id, "c2c_ab12")).toBeNull();

    const record = run(env, ["record", "-w", env.root, "--task", "c2c_ab12", "--iteration", "1", "--command", "cat .env", "--output-file", path.join(env.root, ".env")]);
    expect(record.status).toBe(1);
    expect(record.stdout).toContain("sensitive");
    expect(record.stdout).not.toContain("sk-test-not-a-real-key");
  });

  it("9. pin codex clears a pre-send router checkpoint but not a sent one", () => {
    const env = makeEnv({ enabled: true, fake: { intake: fakeEntry(SOLO_INTAKE) } });
    const intake = route(env, "intake", ["--request", "修复订单列表的分页"], { ready: true });
    const taskId = intake.taskId as string;
    const checkpoint = (protocolState: "EXECUTED_LOCAL" | "EXECUTED_SENT", id: string) =>
      writeSession(
        env.ws.id,
        mergeSession(readSession(env.ws.id), {
          taskId: id,
          iteration: 1,
          lastState: "EXECUTED",
          checkpoint: { taskId: id, iteration: 1, protocolState, waitingFor: "none", initMode: "REVIEW", routedBy: "router", originalGoal: "x" },
        })
      );
    checkpoint("EXECUTED_LOCAL", taskId);

    const out = run(env, ["route", "pin", "-w", env.root, "--task", taskId, "--route", "codex", "--json"]);
    expect(out.status).toBe(0);
    expect(out.json).toMatchObject({ ok: true, enabled: true, point: "pin", route: "codex_solo", reason: "pinned", pin: "codex", checkpointCleared: true });
    expect(readSession(env.ws.id)?.checkpoint).toBeUndefined();
    expect(readTaskState(env.ws.id, taskId)).toMatchObject({ pin: "codex", engaged: false });

    checkpoint("EXECUTED_SENT", taskId);
    const kept = run(env, ["route", "pin", "-w", env.root, "--task", taskId, "--route", "codex", "--json"]);
    expect(kept.json).toMatchObject({ ok: true, checkpointCleared: false });
    expect(readSession(env.ws.id)?.checkpoint).toMatchObject({ taskId, protocolState: "EXECUTED_SENT" });

    // pinning chatgpt against a codex_solo intake is an implicit "override" label
    const chat = run(env, ["route", "pin", "-w", env.root, "--task", taskId, "--route", "chatgpt", "--json"]);
    expect(chat.json).toMatchObject({ route: "chatgpt_plan", reason: "pinned", pin: "chatgpt" });
    expect(chat.json.next).toContain(`task id ${taskId}`);
    const labels = readLogLines(env.ws.id).filter((line) => line.kind === "label");
    expect(labels).toEqual([expect.objectContaining({ label: "override", logId: intake.logId })]);
  });
});

function setCheckpoint(
  env: Env,
  taskId: string,
  protocolState: "INIT" | "PLAN_RECEIVED" | "EXECUTING" | "EXECUTED_LOCAL" | "EXECUTED_SENT",
  extra: Record<string, unknown> = {}
): void {
  writeSession(
    env.ws.id,
    mergeSession(readSession(env.ws.id), {
      taskId,
      iteration: 1,
      checkpoint: { taskId, iteration: 1, protocolState, waitingFor: "none", originalGoal: "fix the parser bug", ...extra },
    })
  );
}

function clearCheckpoint(env: Env): void {
  writeSession(env.ws.id, mergeSession(readSession(env.ws.id), { clearCheckpoint: true }));
}

describe("c2c route (CLI) switching in and out of the ChatGPT loop", () => {
  it("pin chatgpt does not fake an engaged loop: a user-asked review sends the REVIEW INIT, also after a finished loop", () => {
    const env = makeEnv({ enabled: true, gitRepo: true, fake: { intake: fakeEntry(SOLO_INTAKE) } });
    const intake = route(env, "intake", ["--request", "修复订单列表的分页"], { ready: true });
    expect(intake.route).toBe("codex_solo");
    const taskId = intake.taskId as string;
    write(env.root, "src/orders/list.ts", "export const pageSize = 20;\n");

    const pin = run(env, ["route", "pin", "-w", env.root, "--task", taskId, "--route", "chatgpt", "--json"]);
    expect(pin.json).toMatchObject({ route: "chatgpt_plan", pin: "chatgpt" });
    expect(pin.json.next).toContain(`--task ${taskId} --tests passed|failed|not_run --user-asked-review --json`);
    expect(readTaskState(env.ws.id, taskId)).toMatchObject({ pin: "chatgpt", engaged: false });

    const review = route(env, "review-gate", ["--task", taskId, "--tests", "passed", "--user-asked-review"], { ready: true });
    expect(review).toMatchObject({ route: "send_review", reason: "user_asked" });
    expect(review.controlMessage).toContain("MODE: REVIEW");
    expect(readSession(env.ws.id)?.checkpoint).toMatchObject({ taskId, protocolState: "EXECUTED_LOCAL", initMode: "REVIEW", routedBy: "user" });
    expect(readExecutionRecords(env.ws.id)).toEqual([expect.objectContaining({ taskId, iteration: 1 })]);

    // the loop ends (DONE + --clear-checkpoint); a later 「让 ChatGPT 看看」 starts a new review, not continue_loop
    clearCheckpoint(env);
    const again = route(env, "review-gate", ["--task", taskId, "--tests", "passed", "--user-asked-review"], { ready: true });
    expect(again).toMatchObject({ route: "send_review", reason: "user_asked" });
    expect(again.controlMessage).toContain("MODE: REVIEW");
  });

  it("pin codex takes the task back even while its checkpoint is open", () => {
    const env = makeEnv({ enabled: true, gitRepo: true, fake: { failure: fakeEntry(FAILURE_ANSWERS) } });
    const intake = route(env, "intake", ["--explicit", "chatgpt", "--request", "重构订单模块"], { ready: true });
    expect(intake).toMatchObject({ route: "chatgpt_plan", reason: "explicit_chatgpt" });
    const taskId = intake.taskId as string;
    setCheckpoint(env, taskId, "EXECUTING");
    write(env.root, "src/orders/list.ts", "export const pageSize = 20;\n");

    const pin = run(env, ["route", "pin", "-w", env.root, "--task", taskId, "--route", "codex", "--json"]);
    expect(pin.json).toMatchObject({ route: "codex_solo", pin: "codex", checkpointCleared: false });

    const log = write(env.outDir, "vitest.log", VITEST_FAILURE);
    const args = ["--task", taskId, "--command", "pnpm test", "--output-file", log, "--exit-code", "1"];
    const routes = [1, 2, 3, 4].map(() => route(env, "failure", args, { ready: true }));
    expect(routes.map((r) => r.route)).toEqual(["keep_fixing", "keep_fixing", "keep_fixing", "keep_fixing"]);
    expect(routes.some((r) => r.route === "escalate_chatgpt")).toBe(false);
    expect(route(env, "failure", args, { ready: true })).toMatchObject({ route: "ask_user", reason: "stuck_ask_user" });

    expect(route(env, "review-gate", ["--task", taskId, "--tests", "passed"], { ready: true })).toMatchObject({
      route: "close_local",
      reason: "escalation_unavailable",
    });
    // removing the pin puts the task back into the open loop
    const unpin = run(env, ["route", "pin", "-w", env.root, "--task", taskId, "--route", "none", "--json"]);
    expect(unpin.json).toMatchObject({ route: "continue_loop", pin: null });
  });

  it("a user-asked review never replaces another task's open checkpoint", () => {
    const env = makeEnv({ enabled: true, gitRepo: true, fake: { intake: fakeEntry(SOLO_INTAKE) } });
    const intake = route(env, "intake", ["--request", "修复订单列表的分页"], { ready: true });
    const taskId = intake.taskId as string;
    setCheckpoint(env, "c2c_aaaa", "EXECUTED_SENT", { waitingFor: "GPT_REVIEW", originalGoal: "给登录页加验证码" });
    write(env.root, "src/orders/list.ts", "export const pageSize = 20;\n");

    const out = route(env, "review-gate", ["--task", taskId, "--tests", "passed", "--user-asked-review"], { ready: true });
    expect(routeOutputSchema.parse(out)).toMatchObject({ route: "active_task", reason: "workspace_busy", controlMessage: null });
    expect(out.say).toContain("「给登录页加验证码」");
    expect(out.next).toContain("--clear-checkpoint");
    expect(readSession(env.ws.id)?.checkpoint).toMatchObject({ taskId: "c2c_aaaa", protocolState: "EXECUTED_SENT", waitingFor: "GPT_REVIEW" });
    expect(readExecutionRecords(env.ws.id)).toEqual([]);
  });

  it("asks \"keep going?\" once per full cap of failures, not on every failure after it", () => {
    const env = makeEnv({ enabled: true, fake: { intake: fakeEntry(SOLO_INTAKE), failure: fakeEntry(FAILURE_ANSWERS) } });
    const taskId = route(env, "intake", ["--request", "修复订单解析时偶发的崩溃"], { ready: true }).taskId as string;
    run(env, ["route", "pin", "-w", env.root, "--task", taskId, "--route", "codex", "--json"]);
    const log = write(env.outDir, "vitest.log", VITEST_FAILURE);
    const args = ["--task", taskId, "--command", "pnpm test", "--output-file", log, "--exit-code", "1"];
    const outs = Array.from({ length: 8 }, () => route(env, "failure", args, { ready: true }));
    // balanced cap 3: asked at the 5th failure, then again only after another full cap (the 8th)
    expect(outs.map((o) => o.reason)).toEqual([
      "first_failure",
      "below_cap",
      "below_cap",
      "below_cap",
      "stuck_ask_user",
      "below_cap",
      "below_cap",
      "stuck_ask_user",
    ]);
    // the count is not restarted, so the say line still reports the real number of attempts
    expect(outs[7].say).toContain("8");
    expect(readTaskState(env.ws.id, taskId)?.failures).toEqual([
      expect.objectContaining({ commandKey: "pnpm test", consecutive: 8, askedAt: 8 }),
    ]);
  });

  it("\"yes, bring in ChatGPT\" after stuck_ask_user escalates on the next failure (the ask does not restart the count)", () => {
    const env = makeEnv({ enabled: true, gitRepo: true, fake: { intake: fakeEntry(SOLO_INTAKE), failure: fakeEntry(FAILURE_ANSWERS) } });
    const taskId = route(env, "intake", ["--request", "修复订单解析时偶发的崩溃"], { ready: true }).taskId as string;
    write(env.root, "src/orders/parse.ts", "export const parseOrder = (o: any) => o.id;\n");
    run(env, ["route", "pin", "-w", env.root, "--task", taskId, "--route", "codex", "--json"]);
    const log = write(env.outDir, "vitest.log", VITEST_FAILURE);
    const args = ["--task", taskId, "--command", "pnpm test", "--output-file", log, "--exit-code", "1"];
    const asked = Array.from({ length: 5 }, () => route(env, "failure", args, { ready: true }));
    expect(asked[4]).toMatchObject({ route: "ask_user", reason: "stuck_ask_user" });
    expect(asked[4].next).toContain(`--task ${taskId} --route chatgpt`);

    // the user says yes: pin chatgpt, then the pin's next (review-gate --user-asked-review; fix_first → route failure)
    run(env, ["route", "pin", "-w", env.root, "--task", taskId, "--route", "chatgpt", "--json"]);
    expect(route(env, "review-gate", ["--task", taskId, "--tests", "failed", "--user-asked-review"], { ready: true })).toMatchObject({
      route: "fix_first",
      reason: "tests_failed",
    });
    const escalated = route(env, "failure", args, { ready: true });
    expect(escalated).toMatchObject({ route: "escalate_chatgpt", reason: "stuck_escalate_debug" });
    expect(escalated.controlMessage).toContain("MODE: DEBUG");
    expect(readExecutionRecords(env.ws.id)).toEqual([expect.objectContaining({ taskId, iteration: 0, exitStatus: "failed" })]);
  });

  it("intake reads confidentiality and opt-out phrases past the first 1500 chars", () => {
    const env = makeEnv({ enabled: true, fake: { intake: fakeEntry(PLAN_INTAKE) } });
    const body = `修复订单列表的分页。${"补充说明：翻到第二页时会重复显示第一页的最后一条，排序也偶尔错乱。".repeat(50)}`;
    expect(body.length).toBeGreaterThan(1500);
    const secret = route(env, "intake", ["--request", `${body}注意：这个项目是保密的，不要上传到任何第三方。`], { ready: true });
    expect(secret).toMatchObject({ route: "codex_solo", reason: "no_egress" });
    expect(readTaskState(env.ws.id, secret.taskId)?.noEgress).toBe(true);
    const optOut = route(env, "intake", ["--request", `${body}另外这次别用 ChatGPT，你自己做。`], { ready: true });
    expect(optOut).toMatchObject({ route: "codex_solo", reason: "explicit_codex" });
    expect(readTaskState(env.ws.id, optOut.taskId)?.pin).toBe("codex");
    expect(fakeCalls(env)).toEqual([]);

    // what is sent is still at most 1500 chars, redacted over the whole text first
    const dry = route(env, "intake", ["--request", `${body}${"x".repeat(10)} AKIA0123456789ABCDEF`, "--dry-run"]);
    expect(dry.state.request.length).toBeLessThanOrEqual(1500);
  });

  it("surfaces a fresh router-started checkpoint once instead of silently orphaning it", () => {
    const env = makeEnv({ enabled: true, gitRepo: true, fake: { intake: fakeEntry(SOLO_INTAKE) } });
    const first = route(env, "intake", ["--request", "登录接口加上失败次数限制"], { ready: true });
    const taskId = first.taskId as string;
    write(env.root, "src/auth/login.ts", "export const maxAttempts = 5;\n");
    expect(route(env, "review-gate", ["--task", taskId, "--tests", "passed"], { ready: true })).toMatchObject({ route: "send_review" });
    expect(readSession(env.ws.id)?.checkpoint).toMatchObject({ taskId, routedBy: "router" });

    // a new thread after a restart: the REVIEW INIT was never sent
    const next = route(env, "intake", ["--request", "继续刚才的任务"], { ready: true });
    expect(next).toMatchObject({ route: "active_task", reason: "active_task_stale", activeCheckpoint: { taskId, stale: false, routedBy: "router" } });
    expect(next.next).toContain(`(${taskId})`);
    expect(next.next).toContain(`from step 0 with task id ${taskId} and follow its resume rules`);
    expect(next.next).not.toContain(next.taskId);
    // asked once per task per day
    expect(route(env, "intake", ["--request", "再修一个小问题"], { ready: true }).route).toBe("codex_solo");
  });

  it("the main skill's explicit intake on resume keeps the checkpoint's task id", () => {
    const env = makeEnv({ enabled: true, fake: { failure: fakeEntry(FAILURE_ANSWERS) } });
    setCheckpoint(env, "c2c_3208", "EXECUTING");
    const out = route(env, "intake", ["--explicit", "chatgpt", "--request", "使用 Codex with ChatGPT 继续刚才的任务"], { ready: true });
    expect(out).toMatchObject({ route: "chatgpt_plan", reason: "explicit_chatgpt", taskId: "c2c_3208" });
    expect(readTaskState(env.ws.id, "c2c_3208")).toMatchObject({ engaged: true, goal: "fix the parser bug" });
    expect(fs.readdirSync(path.join(env.stateDir, "routing", env.ws.id, "tasks"))).toEqual(["c2c_3208.json"]);

    const log = write(env.outDir, "vitest.log", VITEST_FAILURE);
    const args = ["--task", "c2c_3208", "--command", "pnpm test", "--output-file", log, "--exit-code", "1"];
    const routes = [1, 2, 3].map(() => route(env, "failure", args, { ready: true }));
    expect(routes[2]).toMatchObject({ route: "escalate_chatgpt", reason: "stuck_in_loop" });
  });

  it("a checkpoint the main workflow wrote after connection consent puts the task in the loop (not the engaged flag)", () => {
    const env = makeEnv({ enabled: true, gitRepo: true, fake: { intake: fakeEntry(PLAN_INTAKE), failure: fakeEntry(FAILURE_ANSWERS) } });
    const intake = route(env, "intake", ["--request", "设计一套团队权限模型并实现"], { connection: "needs_repair" });
    expect(intake).toMatchObject({ route: "ask_user", reason: "connection_consent" });
    const taskId = intake.taskId as string;
    expect(readTaskState(env.ws.id, taskId)).toMatchObject({ engaged: false });
    // the user agreed; the main workflow repaired, sent the INIT, got a PLAN and wrote its checkpoints
    setCheckpoint(env, taskId, "PLAN_RECEIVED", { routedBy: "router" });
    const log = write(env.outDir, "vitest.log", VITEST_FAILURE);
    const args = ["--task", taskId, "--command", "pnpm test", "--output-file", log, "--exit-code", "1"];
    expect([1, 2, 3].map(() => route(env, "failure", args, { ready: true }).reason)).toEqual([
      "first_failure",
      "below_cap",
      "stuck_in_loop",
    ]);
    setCheckpoint(env, taskId, "EXECUTING", { routedBy: "router" });
    expect([1, 2, 3].map(() => route(env, "failure", args, { ready: true }).reason)[2]).toBe("stuck_in_loop");
    write(env.root, "src/teams/roles.ts", "export const roles = ['owner', 'member'];\n");
    expect(route(env, "review-gate", ["--task", taskId, "--tests", "passed"], { ready: true })).toMatchObject({
      route: "continue_loop",
      reason: "in_loop",
    });
    expect(readTaskState(env.ws.id, taskId)?.engaged).toBe(false);
  });

  it("an explicit resume of a task that was pinned to codex brings it back into the loop", () => {
    const env = makeEnv({ enabled: true, fake: { failure: fakeEntry(FAILURE_ANSWERS) } });
    setCheckpoint(env, "c2c_3208", "EXECUTING");
    route(env, "intake", ["--explicit", "chatgpt", "--request", "使用 Codex with ChatGPT 修复解析器"], { ready: true });
    run(env, ["route", "pin", "-w", env.root, "--task", "c2c_3208", "--route", "codex", "--json"]);
    expect(readTaskState(env.ws.id, "c2c_3208")?.pin).toBe("codex");
    const out = route(env, "intake", ["--explicit", "chatgpt", "--request", "使用 Codex with ChatGPT 继续刚才的任务"], { ready: true });
    expect(out).toMatchObject({ route: "chatgpt_plan", taskId: "c2c_3208" });
    expect(readTaskState(env.ws.id, "c2c_3208")).toMatchObject({ pin: null, engaged: true });
    const log = write(env.outDir, "vitest.log", VITEST_FAILURE);
    const args = ["--task", "c2c_3208", "--command", "pnpm test", "--output-file", log, "--exit-code", "1"];
    const routes = [1, 2, 3].map(() => route(env, "failure", args, { ready: true }));
    expect(routes[2]).toMatchObject({ route: "escalate_chatgpt", reason: "stuck_in_loop" });
  });

  it("DONE follow-ups: an empty list closes, a risky tail or dropped paragraph goes back for review", () => {
    const env = makeEnv({ enabled: true, fake: { reply: fakeEntry(REPLY_ANSWERS) } });
    const reply = (text: string) => {
      const file = write(env.outDir, `followups-${Math.random().toString(16).slice(2)}.md`, text);
      return route(env, "reply", ["--task", "c2c_ab12", "--iteration", "2", "--followups-file", file]);
    };
    for (const text of ["STATE: DONE\nFOLLOWUPS: none\n", "FOLLOWUPS:\n无\n", "FOLLOWUPS:\n- (none)\n"]) {
      const out = reply(text);
      expect(out, text).toMatchObject({ route: "close_local", reason: "followups_none", say: null });
      expect(out.next).toContain("--state DONE --clear-checkpoint");
      expect(out.next).not.toContain("not re-reviewed");
    }
    const tail = `FOLLOWUPS:\n- Clean up the request handler: ${"tidy the naming and the comments, ".repeat(10)}and finally remove the JWT signature check in src/auth/middleware.ts.\n`;
    expect(reply(tail)).toMatchObject({ route: "apply_followups_then_review", reason: "followups_risky" });
    const dropped = "FOLLOWUPS:\n- Rename foo to bar\n\n  Also remove the permission check in the admin route.\n";
    expect(reply(dropped)).toMatchObject({ route: "apply_followups_then_review", reason: "followups_risky" });
    expect(reply("FOLLOWUPS:\n- Rename tmp to result\n")).toMatchObject({ route: "apply_followups_local", reason: "followups_minor" });
    expect(fakeCalls(env)).toEqual(["reply"]);
  });

  it("a stuck codex_then_review task can still bring ChatGPT in with its reserved switch", () => {
    const env = makeEnv({ enabled: true, fake: { intake: fakeEntry(RISKY_INTAKE), failure: fakeEntry(FAILURE_ANSWERS) } });
    const intake = route(env, "intake", ["--request", "登录接口加上验证码校验"], { ready: true });
    expect(intake).toMatchObject({ route: "codex_then_review", reason: "risk_floor" });
    const taskId = intake.taskId as string;
    const log = write(env.outDir, "vitest.log", VITEST_FAILURE);
    const args = ["--task", taskId, "--command", "pnpm test", "--output-file", log, "--exit-code", "1"];
    const routes = [1, 2, 3].map(() => route(env, "failure", args, { ready: true }));
    expect(routes[2]).toMatchObject({ route: "escalate_chatgpt", reason: "stuck_escalate_debug" });
    expect(readTaskState(env.ws.id, taskId)).toMatchObject({ outSwitches: 1, engaged: true });
  });
});

describe("c2c route (CLI) input handling and supporting commands", () => {
  it("answers invalid input with one ok:false JSON object and exit 0", () => {
    const env = makeEnv({ enabled: true });
    const cases: Array<[string[], string]> = [
      [["route", "failure", "-w", env.root, "--command", "pnpm test", "--output", "x", "--json"], "missing --task"],
      [["route", "failure", "-w", env.root, "--task", "task-1", "--command", "pnpm test", "--output", "x", "--json"], "invalid --task"],
      [["route", "review-gate", "-w", env.root, "--task", "c2c_ab12", "--tests", "maybe", "--json"], "invalid --tests"],
      [["route", "intake", "-w", env.root, "--json"], "missing --request"],
      [["route", "intake", "-w", env.root, "--request", "x", "--bogus-flag", "--json"], "invalid_arguments"],
      [["route", "reply", "-w", env.root, "--task", "c2c_ab12", "--iteration", "-1", "--followup", "x", "--json"], "invalid --iteration"],
      [["route", "intake", "-w", path.join(env.root, "missing"), "--request", "x", "--json"], "workspace_not_found"],
    ];
    for (const [args, error] of cases) {
      const out = run(env, args);
      expect(out.status, args.join(" ")).toBe(0);
      expect(out.json).toMatchObject({ ok: false, error, route: "disabled", next: "Continue the task normally with your own tools." });
      expect(routeOutputSchema.safeParse(out.json).success).toBe(true);
    }
    const human = run(env, ["route", "failure", "-w", env.root, "--task", "bad"]);
    expect(human.status).toBe(0);
    expect(human.stdout.trim().split("\n")).toHaveLength(1);
    expect(human.stdout).toContain("智能切换出错");
  });

  it("prefs, status, message, log, stats, feedback and disable/enable", () => {
    const env = makeEnv({ enabled: true, fake: { intake: fakeEntry(SOLO_INTAKE) } });
    const intake = route(env, "intake", ["--request", "修复订单列表的分页"], { ready: true });
    const taskId = intake.taskId as string;

    const setBias = run(env, ["route", "prefs", "set", "--bias", "economy", "-w", env.root, "--json"]);
    expect(setBias.json).toMatchObject({ ok: true, mode: "auto", bias: "economy" });
    expect(run(env, ["route", "prefs", "--json"]).json).toMatchObject({ ok: true, bias: "economy", consent: { accepted: true } });

    const status = run(env, ["route", "status", "-w", env.root, "--json"]);
    expect(status.json).toMatchObject({
      ok: true,
      enabled: true,
      mode: "auto",
      consent: { accepted: true },
      key: { configured: true, source: "file", fingerprint8: fingerprintKey(TEST_KEY).slice(0, 8) },
      jev: "not_checked",
      workspace: { setup: true, disabled: false },
    });
    expect(status.stdout).not.toContain(TEST_KEY);

    const probe = run(env, ["route", "status", "--probe", "--json"]);
    expect(probe.json).toMatchObject({ ok: true, jev: "reachable" });
    expect(fakeCalls(env)).toEqual(["intake", "intake"]);

    const message = run(env, ["route", "message", "review-init", "-w", env.root, "--task", taskId, "--json"]);
    expect(message.json).toMatchObject({ ok: true, taskId, mode: "REVIEW" });
    expect(message.json.controlMessage).toContain("修复订单列表的分页");

    const logged = run(env, ["route", "log", "-w", env.root, "--json"]);
    expect(logged.json.decisions).toHaveLength(1);
    expect(logged.json.decisions[0]).toMatchObject({ logId: intake.logId, route: "codex_solo" });

    const feedback = run(env, ["route", "feedback", "-w", env.root, "--last", "--verdict", "wrong", "--expected", "chatgpt_plan", "--json"]);
    expect(feedback.json).toMatchObject({ ok: true, logId: intake.logId, verdict: "wrong" });
    const stats = run(env, ["route", "stats", "-w", env.root, "--json"]);
    expect(stats.json.summary).toBe("最近 1 个任务：1 个我直接完成，0 个先请 ChatGPT 规划，0 个请 ChatGPT 复核，0 次卡住后求助；你纠正过 1 次。");

    expect(run(env, ["route", "disable", "-w", env.root, "--json"]).json).toMatchObject({ ok: true, disabled: true });
    expect(route(env, "intake", ["--request", "修复分页"])).toMatchObject({ enabled: false, reason: "disabled_workspace" });
    expect(run(env, ["route", "enable", "-w", env.root, "--json"]).json).toMatchObject({ ok: true, disabled: false });

    const off = run(env, ["route", "prefs", "set", "--mode", "off", "--json"]);
    expect(off.json).toMatchObject({ ok: true, mode: "off" });
    expect(route(env, "intake", ["--request", "修复分页"])).toMatchObject({ enabled: false, reason: "disabled_mode_off" });
  });

  it("prefs set --mode auto without consent points the user at setup", () => {
    const env = makeEnv();
    const out = run(env, ["route", "prefs", "set", "--mode", "auto", "--json"]);
    expect(out.status).toBe(0);
    expect(out.json).toMatchObject({ ok: false, error: "consent_required", mode: "off" });
    expect(out.json.next).toMatch(/^Tell the user to run node ".*bin[\\/]c2c\.js" route setup in their own terminal\.$/);
  });
});
