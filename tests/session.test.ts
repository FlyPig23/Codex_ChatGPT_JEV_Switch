import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearChatPointer,
  INIT_MODES,
  mergeSession,
  normalizeProjectUrl,
  projectIdFromUrl,
  readSession,
  resolveConversation,
  writeSession,
  type InitMode,
  type SavedSession,
} from "../src/session/state.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

const PROJECT = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";

describe("normalizeProjectUrl", () => {
  it("accepts the collection URL and strips extras", () => {
    expect(normalizeProjectUrl(`${PROJECT}/`)).toBe(PROJECT);
    expect(normalizeProjectUrl("https://www.chatgpt.com/g/g-p-abc123/project?foo=1")).toBe(
      "https://chatgpt.com/g/g-p-abc123/project"
    );
    expect(projectIdFromUrl(PROJECT)).toBe("g-p-6a94399430e08191860ab5364b7748b8");
  });

  it("rejects a normal chat URL or a guessed name", () => {
    expect(normalizeProjectUrl("https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBeNull();
    expect(normalizeProjectUrl("https://chatgpt.com/")).toBeNull();
    expect(normalizeProjectUrl("https://example.com/g/g-p-abc/project")).toBeNull();
  });
});

describe("resolveConversation", () => {
  it("treats a missing file as a new workspace (Project by default)", () => {
    const view = resolveConversation(null);
    expect(view.mode).toBe("project");
    expect(view.reason).toBe("new-workspace");
    expect(view.reuseSavedChat).toBe(false);
    expect(view.projectReady).toBe(false);
  });

  it("keeps a legacy session file on long-chat and does not migrate", () => {
    const view = resolveConversation({
      url: "https://chatgpt.com/c/old-chat",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(view.mode).toBe("long-chat");
    expect(view.reason).toBe("existing-long-chat");
    expect(view.reuseSavedChat).toBe(true);
    expect(view.chatUrl).toBe("https://chatgpt.com/c/old-chat");
  });

  it("lets an explicit long-chat opt-out win over a leftover collection URL", () => {
    const view = resolveConversation({
      conversationMode: "long-chat",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/c/keep",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(view.mode).toBe("long-chat");
    expect(view.reuseSavedChat).toBe(true);
  });

  it("uses Project when a collection URL is stored", () => {
    const view = resolveConversation({
      conversationMode: "project",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/c/thread-1",
      connectorName: "Codex with ChatGPT · Demo",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(view.mode).toBe("project");
    expect(view.projectReady).toBe(true);
    expect(view.reuseSavedChat).toBe(false);
    expect(view.connectorName).toBe("Codex with ChatGPT · Demo");
  });
});

describe("mergeSession", () => {
  it("keeps Project fields when only the chat URL is updated", () => {
    const next = mergeSession(
      {
        conversationMode: "project",
        projectUrl: PROJECT,
        connectorName: "Codex with ChatGPT · Demo",
        url: "https://chatgpt.com/c/old",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      { url: "https://chatgpt.com/c/new", taskId: "c2c_ab12", iteration: 1 }
    );
    expect(next.projectUrl).toBe(PROJECT);
    expect(next.conversationMode).toBe("project");
    expect(next.url).toBe("https://chatgpt.com/c/new");
    expect(next.connectorName).toBe("Codex with ChatGPT · Demo");
    expect(next.taskId).toBe("c2c_ab12");
  });

  it("writes and clears a checkpoint without dropping the chat URL", () => {
    const withCheckpoint = mergeSession(
      {
        url: "https://chatgpt.com/c/keep",
        taskId: "c2c_ab12",
        iteration: 7,
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "EXECUTED_SENT",
          waitingFor: "GPT_REVIEW",
          originalGoal: "dark mode",
          nextExpectedStep: "wait for review",
        },
      }
    );
    expect(withCheckpoint.url).toBe("https://chatgpt.com/c/keep");
    expect(withCheckpoint.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(withCheckpoint.checkpoint?.waitingFor).toBe("GPT_REVIEW");
    expect(withCheckpoint.checkpoint?.taskId).toBe("c2c_ab12");
    const cleared = mergeSession(withCheckpoint, { clearCheckpoint: true });
    expect(cleared.checkpoint).toBeUndefined();
    expect(cleared.url).toBe("https://chatgpt.com/c/keep");
  });

  it("keeps an existing checkpoint when only the chat URL is updated", () => {
    const previous = mergeSession(
      {
        url: "https://chatgpt.com/c/keep",
        taskId: "c2c_ab12",
        iteration: 7,
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "EXECUTED_SENT",
          waitingFor: "GPT_REVIEW",
          originalGoal: "dark mode",
        },
      }
    );
    const next = mergeSession(previous, { url: "https://chatgpt.com/c/new" });
    expect(next.url).toBe("https://chatgpt.com/c/new");
    expect(next.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(next.checkpoint?.originalGoal).toBe("dark mode");
  });

  it("caps checkpoint text so it cannot become a log dump", () => {
    const next = mergeSession(
      {
        url: "https://chatgpt.com/c/keep",
        taskId: "c2c_ab12",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "PLAN_RECEIVED",
          originalGoal: "x".repeat(600),
        },
      }
    );
    expect(next.checkpoint?.originalGoal?.length).toBeLessThanOrEqual(501);
    expect(next.checkpoint?.originalGoal?.endsWith("…")).toBe(true);
  });

  it("leaves legacy sessions without a checkpoint unchanged", () => {
    const next = mergeSession(
      {
        url: "https://chatgpt.com/c/old",
        taskId: "c2c_aa01",
        iteration: 2,
        lastState: "EXECUTED",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      { iteration: 3, lastState: "EXECUTED" }
    );
    expect(next.checkpoint).toBeUndefined();
    expect(next.taskId).toBe("c2c_aa01");
  });

  it("rejects a non-collection project URL", () => {
    expect(() =>
      mergeSession(null, {
        conversationMode: "project",
        projectUrl: "https://chatgpt.com/c/nope",
      })
    ).toThrow(/project URL/);
  });
});

describe("mergeSession routing fields", () => {
  const routedReview = (): SavedSession =>
    mergeSession(
      {
        url: "https://chatgpt.com/c/keep",
        taskId: "c2c_ab12",
        iteration: 1,
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        taskId: "c2c_ab12",
        iteration: 1,
        lastState: "EXECUTED",
        checkpoint: {
          protocolState: "EXECUTED_LOCAL",
          waitingFor: "none",
          initMode: "REVIEW",
          routedBy: "router",
          closeLocal: true,
          originalGoal: "dark mode",
          completedSubtasks: "toggle added",
          knownIssues: "none yet",
          nextExpectedStep: "send REVIEW INIT",
          chatUrl: "https://chatgpt.com/c/task-chat",
          projectUrl: PROJECT,
        },
      }
    );

  it("stores initMode, routedBy and closeLocal on the checkpoint", () => {
    const next = routedReview();
    expect(next.checkpoint).toMatchObject({
      taskId: "c2c_ab12",
      iteration: 1,
      protocolState: "EXECUTED_LOCAL",
      initMode: "REVIEW",
      routedBy: "router",
      closeLocal: true,
    });
  });

  it("keeps the routing fields when the same task only moves protocol state", () => {
    const next = mergeSession(routedReview(), {
      checkpoint: { protocolState: "EXECUTED_SENT", waitingFor: "GPT_REVIEW" },
    });
    expect(next.checkpoint).toMatchObject({
      taskId: "c2c_ab12",
      iteration: 1,
      protocolState: "EXECUTED_SENT",
      waitingFor: "GPT_REVIEW",
      initMode: "REVIEW",
      routedBy: "router",
      closeLocal: true,
      originalGoal: "dark mode",
      chatUrl: "https://chatgpt.com/c/task-chat",
    });
  });

  it("ends the local follow-up phase when a new PLAN (or INIT) arrives", () => {
    const executing = mergeSession(routedReview(), { checkpoint: { protocolState: "EXECUTING", closeLocal: true } });
    const sent = mergeSession(executing, {
      iteration: 2,
      checkpoint: { protocolState: "EXECUTED_SENT", waitingFor: "GPT_REVIEW" },
    });
    expect(sent.checkpoint?.closeLocal).toBe(true);
    const plan = mergeSession(sent, { checkpoint: { protocolState: "PLAN_RECEIVED", waitingFor: "none" } });
    expect(plan.checkpoint?.closeLocal).toBeUndefined();
    const again = mergeSession(plan, { checkpoint: { protocolState: "EXECUTING" } });
    expect(again.checkpoint).toMatchObject({ protocolState: "EXECUTING", iteration: 2, initMode: "REVIEW", routedBy: "router" });
    expect(again.checkpoint?.closeLocal).toBeUndefined();
    // an explicit value on the same write still wins
    expect(mergeSession(sent, { checkpoint: { protocolState: "PLAN_RECEIVED", closeLocal: true } }).checkpoint?.closeLocal).toBe(true);
    expect(mergeSession(executing, { checkpoint: { protocolState: "INIT" } }).checkpoint?.closeLocal).toBeUndefined();
  });

  it("lets an explicit patch override each routing field for the same task", () => {
    const next = mergeSession(routedReview(), {
      taskId: "c2c_ab12",
      checkpoint: { initMode: "DEBUG", routedBy: "user", closeLocal: false },
    });
    expect(next.checkpoint).toMatchObject({
      protocolState: "EXECUTED_LOCAL",
      initMode: "DEBUG",
      routedBy: "user",
      closeLocal: false,
    });
  });

  it("resets every inherited field when the task id changes", () => {
    const next = mergeSession(routedReview(), {
      taskId: "c2c_cd34",
      checkpoint: { protocolState: "INIT", waitingFor: "GPT_PLAN" },
    });
    expect(next.checkpoint?.taskId).toBe("c2c_cd34");
    expect(next.checkpoint?.iteration).toBe(0);
    expect(next.checkpoint?.protocolState).toBe("INIT");
    expect(next.checkpoint?.waitingFor).toBe("GPT_PLAN");
    expect(next.checkpoint?.originalGoal).toBeUndefined();
    expect(next.checkpoint?.completedSubtasks).toBeUndefined();
    expect(next.checkpoint?.knownIssues).toBeUndefined();
    expect(next.checkpoint?.nextExpectedStep).toBeUndefined();
    expect(next.checkpoint?.initMode).toBeUndefined();
    expect(next.checkpoint?.routedBy).toBeUndefined();
    expect(next.checkpoint?.closeLocal).toBeUndefined();
    expect(next.checkpoint?.chatUrl).toBe("https://chatgpt.com/c/keep");
    expect(next.url).toBe("https://chatgpt.com/c/keep");
    expect(next.taskId).toBe("c2c_cd34");
  });

  it("resets on a task id given only inside the checkpoint patch", () => {
    const next = mergeSession(routedReview(), {
      checkpoint: { taskId: "c2c_ef56", iteration: 3, protocolState: "PLAN_RECEIVED", chatUrl: "https://chatgpt.com/c/other" },
    });
    expect(next.checkpoint).toMatchObject({
      taskId: "c2c_ef56",
      iteration: 3,
      protocolState: "PLAN_RECEIVED",
      waitingFor: "none",
      chatUrl: "https://chatgpt.com/c/other",
    });
    expect(next.checkpoint?.initMode).toBeUndefined();
    expect(next.checkpoint?.originalGoal).toBeUndefined();
  });

  it("does not inherit the protocol state of a different task", () => {
    expect(() =>
      mergeSession(routedReview(), { taskId: "c2c_cd34", checkpoint: { initMode: "PLAN" } })
    ).toThrow(/protocol state/);
  });

  it("takes the patch iteration for a new task", () => {
    const next = mergeSession(routedReview(), {
      taskId: "c2c_cd34",
      iteration: 0,
      checkpoint: { protocolState: "INIT", initMode: "DEBUG", routedBy: "router" },
    });
    expect(next.checkpoint).toMatchObject({ taskId: "c2c_cd34", iteration: 0, initMode: "DEBUG", routedBy: "router" });
  });

  it("validates initMode, routedBy and closeLocal", () => {
    expect(INIT_MODES).toEqual(["PLAN", "REVIEW", "DEBUG"]);
    expect(() =>
      mergeSession(routedReview(), { checkpoint: { initMode: "PLANNING" as InitMode } })
    ).toThrow(/init-mode/);
    expect(() =>
      mergeSession(routedReview(), { checkpoint: { routedBy: "bot" as "user" } })
    ).toThrow(/routed-by/);
    expect(() =>
      mergeSession(routedReview(), { checkpoint: { closeLocal: "yes" as unknown as boolean } })
    ).toThrow(/close-local/);
  });
});

describe("c2c session set checkpoint flags", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
  });

  function setup(): { root: string; workspaceId: string; env: NodeJS.ProcessEnv } {
    const root = makeTmpDir("session-cli-workspace");
    const stateDir = makeTmpDir("session-cli-state");
    const keysDir = makeTmpDir("session-cli-keys");
    dirs.push(root, stateDir, keysDir);
    return {
      root,
      workspaceId: new Workspace(root).id,
      env: { ...process.env, C2C_STATE_DIR: stateDir, C2C_KEYS_DIR: keysDir },
    };
  }

  function sessionSet(ctx: { root: string; env: NodeJS.ProcessEnv }, args: string[]) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", cliEntry, "session", "set", "-w", ctx.root, ...args],
      { cwd: projectRoot, encoding: "utf8", env: ctx.env }
    );
  }

  function saved(ctx: { workspaceId: string; env: NodeJS.ProcessEnv }): SavedSession | null {
    const previous = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = ctx.env.C2C_STATE_DIR;
    try {
      return readSession(ctx.workspaceId);
    } finally {
      if (previous === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previous;
    }
  }

  it("keeps initMode and routedBy across a later --protocol-state update", () => {
    const ctx = setup();
    const first = sessionSet(ctx, [
      "--task", "c2c_ab12", "--iteration", "0", "--state", "INIT",
      "--protocol-state", "INIT", "--waiting-for", "GPT_PLAN",
      "--init-mode", "debug", "--routed-by", "router", "--goal", "fix flaky login",
    ]);
    expect(first.status, first.stderr + first.stdout).toBe(0);
    expect(saved(ctx)?.checkpoint).toMatchObject({
      taskId: "c2c_ab12",
      protocolState: "INIT",
      initMode: "DEBUG",
      routedBy: "router",
    });

    const second = sessionSet(ctx, ["--protocol-state", "PLAN_RECEIVED", "--waiting-for", "none"]);
    expect(second.status, second.stderr + second.stdout).toBe(0);
    expect(saved(ctx)?.checkpoint).toMatchObject({
      taskId: "c2c_ab12",
      protocolState: "PLAN_RECEIVED",
      waitingFor: "none",
      initMode: "DEBUG",
      routedBy: "router",
      originalGoal: "fix flaky login",
    });
  });

  it("updates an existing checkpoint from --init-mode or --close-local without --protocol-state", () => {
    const ctx = setup();
    expect(sessionSet(ctx, ["--task", "c2c_ab12", "--protocol-state", "EXECUTED_SENT", "--waiting-for", "GPT_REVIEW"]).status).toBe(0);

    const initOnly = sessionSet(ctx, ["--init-mode", "REVIEW"]);
    expect(initOnly.status, initOnly.stderr + initOnly.stdout).toBe(0);
    expect(saved(ctx)?.checkpoint).toMatchObject({ protocolState: "EXECUTED_SENT", initMode: "REVIEW" });

    const closeLocal = sessionSet(ctx, ["--close-local", "true", "--next-step", "apply DONE follow-ups locally"]);
    expect(closeLocal.status, closeLocal.stderr + closeLocal.stdout).toBe(0);
    expect(saved(ctx)?.checkpoint).toMatchObject({
      protocolState: "EXECUTED_SENT",
      waitingFor: "GPT_REVIEW",
      initMode: "REVIEW",
      closeLocal: true,
      nextExpectedStep: "apply DONE follow-ups locally",
    });

    expect(sessionSet(ctx, ["--close-local", "FALSE"]).status).toBe(0);
    expect(saved(ctx)?.checkpoint?.closeLocal).toBe(false);
  });

  it("still requires a protocol state when no checkpoint exists", () => {
    const ctx = setup();
    const result = sessionSet(ctx, ["--task", "c2c_ab12", "--init-mode", "REVIEW"]);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/protocol state/);
    expect(saved(ctx)).toBeNull();
  });

  it("rejects invalid routing flag values without writing", () => {
    const ctx = setup();
    expect(sessionSet(ctx, ["--task", "c2c_ab12", "--protocol-state", "INIT"]).status).toBe(0);
    const before = saved(ctx);
    for (const args of [
      ["--init-mode", "PLANNING"],
      ["--routed-by", "robot"],
      ["--close-local", "yes"],
    ]) {
      const result = sessionSet(ctx, args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/init-mode|routed-by|close-local/);
    }
    expect(saved(ctx)?.checkpoint).toEqual(before?.checkpoint);
  });

  it("starts a fresh checkpoint for a new --task", () => {
    const ctx = setup();
    expect(
      sessionSet(ctx, [
        "--task", "c2c_ab12", "--iteration", "4", "--protocol-state", "EXECUTING",
        "--init-mode", "REVIEW", "--routed-by", "router", "--close-local", "true",
        "--goal", "old goal", "--known-issues", "old issue",
      ]).status
    ).toBe(0);
    const result = sessionSet(ctx, ["--task", "c2c_cd34", "--protocol-state", "INIT", "--waiting-for", "GPT_PLAN"]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const checkpoint = saved(ctx)?.checkpoint;
    expect(checkpoint).toMatchObject({ taskId: "c2c_cd34", iteration: 0, protocolState: "INIT", waitingFor: "GPT_PLAN" });
    expect(checkpoint?.initMode).toBeUndefined();
    expect(checkpoint?.routedBy).toBeUndefined();
    expect(checkpoint?.closeLocal).toBeUndefined();
    expect(checkpoint?.originalGoal).toBeUndefined();
    expect(checkpoint?.knownIssues).toBeUndefined();
  });
});

describe("clearChatPointer", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("keeps the collection binding in Project mode", () => {
    const dir = makeTmpDir("session-clear");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    writeSession("abc123abc123", {
      conversationMode: "project",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/c/gone",
      connectorName: "Codex with ChatGPT · Demo",
      checkpoint: {
        taskId: "c2c_ab12",
        iteration: 4,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        originalGoal: "dark mode",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(clearChatPointer("abc123abc123")).toEqual({ cleared: true, keptProject: true });
    const saved = readSession("abc123abc123");
    expect(saved?.projectUrl).toBe(PROJECT);
    expect(saved?.url).toBeUndefined();
    expect(saved?.checkpoint?.protocolState).toBe("EXECUTED_SENT");
  });

  it("deletes a legacy long-chat file", () => {
    const dir = makeTmpDir("session-clear-legacy");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    writeSession("def456def456", {
      url: "https://chatgpt.com/c/legacy",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(clearChatPointer("def456def456")).toEqual({ cleared: true, keptProject: false });
    expect(readSession("def456def456")).toBeNull();
  });
});
