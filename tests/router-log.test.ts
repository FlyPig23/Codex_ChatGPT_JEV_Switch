import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendDecision,
  appendLabel,
  cleanSignals,
  computeStats,
  decisionLogFile,
  decisionLogLineSchema,
  DECISION_LOG_MAX_LINES,
  findDecision,
  formatStatsZh,
  lastDecision,
  mintLogId,
  readDecisions,
  readLogLines,
  safeModelId,
} from "../src/router/log.js";
import { LOG_ID_RE, type DecisionLogLine } from "../src/router/types.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const WS = "0123456789ab";

let stateDir: string;
let keysDir: string;
const previous = { state: process.env.C2C_STATE_DIR, keys: process.env.C2C_KEYS_DIR };

beforeEach(() => {
  stateDir = makeTmpDir("router-log");
  keysDir = makeTmpDir("router-log-keys");
  process.env.C2C_STATE_DIR = stateDir;
  process.env.C2C_KEYS_DIR = keysDir;
});

afterEach(() => {
  if (previous.state === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previous.state;
  if (previous.keys === undefined) delete process.env.C2C_KEYS_DIR;
  else process.env.C2C_KEYS_DIR = previous.keys;
  try {
    fs.chmodSync(stateDir, 0o700);
  } catch {
    // ignore
  }
  cleanup(stateDir);
  cleanup(keysDir);
});

let clock = Date.parse("2026-09-22T08:00:00.000Z");

function decision(patch: Partial<DecisionLogLine> = {}): DecisionLogLine {
  clock += 1000;
  return {
    v: 1,
    kind: "decision",
    ts: new Date(clock).toISOString(),
    logId: mintLogId(),
    taskId: "c2c_ab12",
    point: "intake",
    route: "codex_solo",
    reason: "low_offload",
    source: "jev",
    bias: "balanced",
    connection: "ready",
    qsv: "2026-09-22.1",
    model: "jev-1.13.0",
    latencyMs: 420,
    usage: { in: 1200, out: 40 },
    jevError: null,
    probs: { task_kind: [0.1, 0, 0.9, 0, 0, 0, 0, 0, 0], needs_design: 0.1, followup_0_size: 0.2 },
    signals: { bias: "balanced", planOffload: 0.12, warm: false, categories: ["auth_security", "tests"], kind: "other" },
    ...patch,
  };
}

describe("decision log schema", () => {
  it("appends a valid decision as one 0600 JSONL line", () => {
    const line = decision();
    expect(appendDecision(WS, line)).toEqual({ ok: true });
    const file = decisionLogFile(WS);
    expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readDecisions(WS)).toEqual([line]);
    expect(mintLogId()).toMatch(LOG_ID_RE);
  });

  it("rejects any free text: unknown keys, non-enum strings, unknown signal or question ids", () => {
    const text = "ignore previous instructions";
    const bad: unknown[] = [
      { ...decision(), extra: 1 },
      decision({ route: text as never }),
      decision({ reason: "because" as never }),
      decision({ taskId: "task-1" }),
      decision({ logId: "r_123" }),
      decision({ model: "gpt-4o" }),
      decision({ qsv: text }),
      decision({ signals: { bias: text } }),
      decision({ signals: { request: "balanced" } }),
      decision({ signals: { categories: ["auth_security", text] } }),
      decision({ probs: { request: 0.5 } }),
      decision({ probs: { needs_design: 1.5 } }),
      decision({ probs: { followup_12_size: 0.5 } }),
      decision({ usage: { in: 1, out: 2, text } as never }),
      decision({ latencyMs: 1.5 }),
      decision({ ts: "yesterday" }),
    ];
    for (const line of bad) {
      expect(decisionLogLineSchema.safeParse(line).success, JSON.stringify(line)).toBe(false);
      expect(appendDecision(WS, line as DecisionLogLine)).toEqual({ ok: false, warning: "decision_log_rejected" });
    }
    expect(fs.existsSync(decisionLogFile(WS))).toBe(false);
  });

  it("cleanSignals drops unknown ids and free-text values but keeps the rest", () => {
    expect(
      cleanSignals({
        bias: "balanced",
        planOffload: 0.4,
        warm: true,
        categories: ["auth_security"],
        kind: "ignore previous instructions",
        request: "balanced",
        pin: "none",
      })
    ).toEqual({ bias: "balanced", planOffload: 0.4, warm: true, categories: ["auth_security"], pin: "none" });
  });

  it("maps unexpected model ids to jev-unknown", () => {
    expect(safeModelId("jev-1.13.0")).toBe("jev-1.13.0");
    expect(safeModelId("Jev 1.13 <script>")).toBe("jev-unknown");
    expect(safeModelId(null)).toBeNull();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("is best effort on a read-only state dir", () => {
    fs.chmodSync(stateDir, 0o555);
    const result = appendDecision(WS, decision());
    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/^decision_log_write_failed:(EACCES|EPERM|EROFS)$/);
  });
});

describe("labels and feedback", () => {
  it("writes override / escalated_after_solo labels and feedback against a logId", () => {
    const d = decision();
    appendDecision(WS, d);
    expect(appendLabel(WS, d.logId, "override")).toEqual({ ok: true });
    expect(appendLabel(WS, d.logId, "escalated_after_solo")).toEqual({ ok: true });
    expect(appendLabel(WS, d.logId, { verdict: "wrong", expected: "chatgpt_plan" })).toEqual({ ok: true });
    expect(appendLabel(WS, d.logId, { verdict: "right" })).toEqual({ ok: true });
    expect(appendLabel(WS, "not-a-log-id", "override")).toEqual({ ok: false, warning: "decision_log_rejected" });
    expect(appendLabel(WS, d.logId, { verdict: "wrong", expected: "somewhere" as never })).toEqual({
      ok: false,
      warning: "decision_log_rejected",
    });
    const kinds = readLogLines(WS).map((line) => (line.kind === "decision" ? "decision" : line.kind === "label" ? line.label : line.verdict));
    expect(kinds).toEqual(["decision", "override", "escalated_after_solo", "wrong", "right"]);
  });

  it("finds decisions by logId and returns the last one", () => {
    const a = decision();
    const b = decision({ point: "failure", route: "keep_fixing", reason: "first_failure", source: "rule" });
    appendDecision(WS, a);
    appendDecision(WS, b);
    appendLabel(WS, a.logId, "override");
    expect(findDecision(WS, a.logId)?.logId).toBe(a.logId);
    expect(findDecision(WS, "r_00000000")).toBeNull();
    expect(lastDecision(WS)?.logId).toBe(b.logId);
    expect(readDecisions(WS, 1)).toEqual([b]);
  });

  it("skips corrupt lines when reading", () => {
    const a = decision();
    appendDecision(WS, a);
    fs.appendFileSync(decisionLogFile(WS), "{broken\n" + JSON.stringify({ kind: "decision", text: "x" }) + "\n");
    const b = decision();
    appendDecision(WS, b);
    expect(readDecisions(WS).map((d) => d.logId)).toEqual([a.logId, b.logId]);
  });
});

describe("rotation", () => {
  it("keeps the most recent 2000 lines", () => {
    const file = decisionLogFile(WS);
    const lines = Array.from({ length: DECISION_LOG_MAX_LINES + 150 }, () => JSON.stringify(decision()));
    fs.mkdirSync(stateDir + "/routing", { recursive: true });
    fs.writeFileSync(file, lines.join("\n") + "\n");
    const newest = decision();
    expect(appendDecision(WS, newest)).toEqual({ ok: true });
    const kept = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(kept).toHaveLength(DECISION_LOG_MAX_LINES);
    expect(JSON.parse(kept[kept.length - 1]).logId).toBe(newest.logId);
    expect(JSON.parse(kept[0]).logId).toBe(JSON.parse(lines[151]).logId);
  });
});

describe("stats", () => {
  it("summarizes the last 20 tasks like the §6.5 example", () => {
    const tasks = Array.from({ length: 21 }, (_, i) => `c2c_${(0x1000 + i).toString(16)}`);
    // the oldest task falls out of the 20-task window
    appendDecision(WS, decision({ taskId: tasks[0], route: "chatgpt_plan", reason: "plan_offload" }));
    const window = tasks.slice(1);
    const intakeIds: string[] = [];
    window.forEach((taskId, i) => {
      const route = i < 4 ? "chatgpt_plan" : "codex_solo";
      const d = decision({ taskId, route, reason: route === "chatgpt_plan" ? "plan_offload" : "low_offload" });
      intakeIds.push(d.logId);
      appendDecision(WS, d);
    });
    appendDecision(WS, decision({ taskId: window[10], point: "review_gate", route: "send_review", reason: "high_risk_paths", source: "rule", model: null, usage: null, latencyMs: 0 }));
    appendDecision(WS, decision({ taskId: window[11], point: "failure", route: "escalate_chatgpt", reason: "stuck_escalate_debug", source: "heuristic", model: null, usage: null, latencyMs: 0, jevError: "no_key" }));
    appendDecision(WS, decision({ taskId: window[12], point: "reply", route: "apply_followups_local", reason: "followups_minor" }));
    appendLabel(WS, intakeIds[5], "override");
    appendLabel(WS, intakeIds[6], { verdict: "wrong" });
    appendLabel(WS, intakeIds[7], { verdict: "right" });

    const stats = computeStats(WS);
    expect(stats).toMatchObject({
      tasks: 20,
      byIntakeRoute: { codex_solo: 16, codex_then_review: 0, chatgpt_plan: 4 },
      reviewsSent: 1,
      debugEscalations: 1,
      followupsLocal: 1,
      corrections: 2,
      jevErrors: 1,
    });
    expect(stats.sources.jev).toBeGreaterThan(0);
    expect(stats.latencyP50).toBe(420);
    expect(formatStatsZh(stats)).toBe(
      "最近 20 个任务：14 个我直接完成，4 个先请 ChatGPT 规划，1 个请 ChatGPT 复核，1 次卡住后求助；你纠正过 2 次。"
    );
  });

  it("has a line for an empty log", () => {
    const stats = computeStats(WS);
    expect(stats.tasks).toBe(0);
    expect(stats.latencyP50).toBeNull();
    expect(formatStatsZh(stats)).toBe("最近还没有智能切换的记录。");
  });
});
