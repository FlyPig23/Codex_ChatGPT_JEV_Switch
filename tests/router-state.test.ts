import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cutUtf8,
  gcTaskStates,
  markFailureAsked,
  mintTaskId,
  newTaskState,
  readTaskState,
  recordFailure,
  resetFailure,
  taskStateDir,
  taskStateExists,
  taskStateFile,
  writeTaskState,
} from "../src/router/state.js";
import { TASK_ID_RE } from "../src/router/types.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const WS = "0123456789ab";
const DAY_MS = 24 * 60 * 60 * 1000;

let stateDir: string;
let keysDir: string;
const previous = { state: process.env.C2C_STATE_DIR, keys: process.env.C2C_KEYS_DIR };

beforeEach(() => {
  stateDir = makeTmpDir("router-state");
  keysDir = makeTmpDir("router-state-keys");
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

const posixUser = process.platform !== "win32" && process.getuid?.() !== 0;

describe("mintTaskId", () => {
  it("mints c2c_ + 4 hex", () => {
    for (let i = 0; i < 50; i++) expect(mintTaskId()).toMatch(TASK_ID_RE);
  });

  it("skips ids the caller reports as taken", () => {
    const seen: string[] = [];
    const id = mintTaskId((candidate) => {
      seen.push(candidate);
      return seen.length < 3;
    });
    expect(seen).toHaveLength(3);
    expect(id).toBe(seen[2]);
  });
});

describe("task state IO", () => {
  it("round-trips a state under routing/<ws>/tasks with 0600", () => {
    const state = newTaskState("c2c_ab12", new Date("2026-09-22T10:00:00Z"), {
      goal: "修复登录 bug",
      intakeRoute: "codex_then_review",
      outSwitches: 1,
      baseline: { head: "a".repeat(40), entries: { "src/a.ts": "b".repeat(40) }, truncated: false },
    });
    expect(writeTaskState(WS, state)).toEqual({ ok: true });
    const file = taskStateFile(WS, "c2c_ab12");
    expect(file).toBe(path.join(stateDir, "routing", WS, "tasks", "c2c_ab12.json"));
    expect(taskStateExists(WS, "c2c_ab12")).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const read = readTaskState(WS, "c2c_ab12");
    expect(read).toMatchObject({
      v: 1,
      taskId: "c2c_ab12",
      goal: "修复登录 bug",
      intakeRoute: "codex_then_review",
      outSwitches: 1,
      pin: null,
      engaged: false,
      baseline: { head: "a".repeat(40), entries: { "src/a.ts": "b".repeat(40) }, truncated: false },
    });
  });

  it("returns null for missing, corrupt, mismatched or invalid ids", () => {
    expect(readTaskState(WS, "c2c_0000")).toBeNull();
    expect(readTaskState(WS, "../../etc")).toBeNull();
    expect(readTaskState("../x", "c2c_0000")).toBeNull();

    fs.mkdirSync(taskStateDir(WS), { recursive: true });
    fs.writeFileSync(taskStateFile(WS, "c2c_1111"), "{not json");
    expect(readTaskState(WS, "c2c_1111")).toBeNull();

    writeTaskState(WS, newTaskState("c2c_2222"));
    fs.copyFileSync(taskStateFile(WS, "c2c_2222"), taskStateFile(WS, "c2c_3333"));
    expect(readTaskState(WS, "c2c_3333")).toBeNull();

    fs.writeFileSync(taskStateFile(WS, "c2c_4444"), JSON.stringify({ ...newTaskState("c2c_4444"), pin: "gpt" }));
    expect(readTaskState(WS, "c2c_4444")).toBeNull();
  });

  it("refuses invalid ids and states on write without throwing", () => {
    expect(writeTaskState("../x", newTaskState("c2c_ab12"))).toEqual({ ok: false, warning: "task_state_invalid_id" });
    expect(writeTaskState(WS, newTaskState("bad"))).toEqual({ ok: false, warning: "task_state_invalid_id" });
    const broken = { ...newTaskState("c2c_ab12"), outSwitches: -1 };
    expect(writeTaskState(WS, broken)).toEqual({ ok: false, warning: "task_state_invalid" });
  });

  it("caps the goal at 400 UTF-8 bytes and keeps the last 10 failure counters", () => {
    const failures = Array.from({ length: 14 }, (_, i) => ({
      commandKey: `cmd ${i}`,
      consecutive: 1,
      sameSignatureStreak: 1,
      lastSignature: "f".repeat(40),
    }));
    writeTaskState(WS, newTaskState("c2c_ab12", new Date(), { goal: "登".repeat(300), failures }));
    const read = readTaskState(WS, "c2c_ab12");
    expect(Buffer.byteLength(read?.goal ?? "", "utf8")).toBeLessThanOrEqual(400);
    expect(read?.goal).toBe("登".repeat(133));
    expect(read?.failures.map((f) => f.commandKey)).toEqual(failures.slice(-10).map((f) => f.commandKey));
  });

  it.skipIf(!posixUser)("returns a warning instead of throwing when the state dir is read-only", () => {
    fs.chmodSync(stateDir, 0o555);
    const result = writeTaskState(WS, newTaskState("c2c_ab12"));
    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/^task_state_write_failed:(EACCES|EPERM|EROFS)$/);
  });
});

describe("gcTaskStates", () => {
  it("removes task states older than 14 days on write and keeps fresh ones", () => {
    const now = new Date("2026-09-22T12:00:00Z");
    writeTaskState(WS, newTaskState("c2c_0001"), now);
    writeTaskState(WS, newTaskState("c2c_0002"), now);
    const old = new Date(now.getTime() - 15 * DAY_MS);
    fs.utimesSync(taskStateFile(WS, "c2c_0001"), old, old);
    const recent = new Date(now.getTime() - 13 * DAY_MS);
    fs.utimesSync(taskStateFile(WS, "c2c_0002"), recent, recent);
    fs.writeFileSync(path.join(taskStateDir(WS), "notes.txt"), "keep me");
    fs.utimesSync(path.join(taskStateDir(WS), "notes.txt"), old, old);

    writeTaskState(WS, newTaskState("c2c_0003"), now);
    expect(taskStateExists(WS, "c2c_0001")).toBe(false);
    expect(taskStateExists(WS, "c2c_0002")).toBe(true);
    expect(taskStateExists(WS, "c2c_0003")).toBe(true);
    expect(fs.existsSync(path.join(taskStateDir(WS), "notes.txt"))).toBe(true);
  });

  it("never removes the task being written and tolerates a missing dir", () => {
    expect(() => gcTaskStates(WS)).not.toThrow();
    const now = new Date();
    writeTaskState(WS, newTaskState("c2c_0001"), now);
    const old = new Date(now.getTime() - 30 * DAY_MS);
    fs.utimesSync(taskStateFile(WS, "c2c_0001"), old, old);
    gcTaskStates(WS, 14, now, "c2c_0001");
    expect(taskStateExists(WS, "c2c_0001")).toBe(true);
    gcTaskStates(WS, 14, now);
    expect(taskStateExists(WS, "c2c_0001")).toBe(false);
  });
});

describe("failure counters", () => {
  it("counts consecutive failures and same-signature streaks per command key", () => {
    let failures = recordFailure([], "pnpm test", "sig-a").failures;
    let step = recordFailure(failures, "pnpm test", "sig-a");
    expect(step.counter).toEqual({ commandKey: "pnpm test", consecutive: 2, sameSignatureStreak: 2, lastSignature: "sig-a" });
    step = recordFailure(step.failures, "pnpm test", "sig-b");
    expect(step.counter).toMatchObject({ consecutive: 3, sameSignatureStreak: 1, lastSignature: "sig-b" });
    step = recordFailure(step.failures, "pnpm build", "sig-c");
    expect(step.counter).toMatchObject({ commandKey: "pnpm build", consecutive: 1, sameSignatureStreak: 1 });
    failures = resetFailure(step.failures, "pnpm test");
    expect(failures.map((f) => f.commandKey)).toEqual(["pnpm build"]);
  });

  it("remembers when the user was asked without restarting the count, and persists it", () => {
    let failures = recordFailure([], "pnpm test", "sig-a").failures;
    failures = recordFailure(failures, "pnpm test", "sig-a").failures;
    failures = recordFailure(failures, "pnpm build", "sig-b").failures;
    failures = markFailureAsked(failures, "pnpm test");
    expect(failures).toEqual([
      { commandKey: "pnpm test", consecutive: 2, sameSignatureStreak: 2, lastSignature: "sig-a", askedAt: 2 },
      { commandKey: "pnpm build", consecutive: 1, sameSignatureStreak: 1, lastSignature: "sig-b" },
    ]);
    const next = recordFailure(failures, "pnpm test", "sig-a");
    expect(next.counter).toEqual({ commandKey: "pnpm test", consecutive: 3, sameSignatureStreak: 3, lastSignature: "sig-a", askedAt: 2 });
    // an escalation still starts a fresh cycle
    expect(resetFailure(next.failures, "pnpm test").map((f) => f.commandKey)).toEqual(["pnpm build"]);

    const state = newTaskState("c2c_0a0b", new Date(), { failures: next.failures });
    expect(writeTaskState(WS, state).ok).toBe(true);
    expect(readTaskState(WS, "c2c_0a0b")?.failures).toEqual(next.failures);
  });

  it("keeps at most 10 counters, most recent last", () => {
    let failures = recordFailure([], "cmd 0", "s").failures;
    for (let i = 1; i < 12; i++) failures = recordFailure(failures, `cmd ${i}`, "s").failures;
    failures = recordFailure(failures, "cmd 5", "s").failures;
    expect(failures).toHaveLength(10);
    expect(failures[failures.length - 1]).toMatchObject({ commandKey: "cmd 5", consecutive: 2 });
  });
});

describe("cutUtf8", () => {
  it("never splits a multi-byte character", () => {
    expect(cutUtf8("abc", 10)).toBe("abc");
    expect(cutUtf8("登录页", 7)).toBe("登录");
    expect(cutUtf8("a😀b", 3)).toBe("a");
  });
});
