import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listExecutionOutputs } from "../src/execution/output.js";
import { appendExecutionRecord, readExecutionRecords, type ExecutionRecord } from "../src/execution/records.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

function runRecord(root: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", cliEntry, "record", "--workspace", root, "--task", "c2c_test", ...args],
    { cwd: projectRoot, encoding: "utf8", env: process.env }
  );
}

function withRecordEnvironment(run: (root: string, workspace: Workspace) => void): void {
  const root = makeTmpDir("record-cli-workspace");
  const stateDir = makeTmpDir("record-cli-state");
  const keysDir = makeTmpDir("record-cli-keys");
  const previousStateDir = process.env.C2C_STATE_DIR;
  const previousKeysDir = process.env.C2C_KEYS_DIR;
  process.env.C2C_STATE_DIR = stateDir;
  process.env.C2C_KEYS_DIR = keysDir;

  try {
    run(root, new Workspace(root));
  } finally {
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    if (previousKeysDir === undefined) delete process.env.C2C_KEYS_DIR;
    else process.env.C2C_KEYS_DIR = previousKeysDir;
    cleanup(root);
    cleanup(stateDir);
    cleanup(keysDir);
  }
}

function withOutputDir(run: (dir: string) => void): void {
  const dir = makeTmpDir("record-cli-output");
  try {
    run(dir);
  } finally {
    cleanup(dir);
  }
}

describe("c2c record", () => {
  it("records valid numeric options and command output", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, [
        "--iteration",
        "2",
        "--changed-files",
        "3",
        "--command",
        "pnpm test",
        "--output",
        "tests passed",
        "--exit-code",
        "1",
      ]);

      expect(result.status).toBe(0);
      expect(readExecutionRecords(workspace.id)).toEqual([
        expect.objectContaining({ taskId: "c2c_test", iteration: 2, changedFiles: 3 }),
      ]);
      expect(listExecutionOutputs(workspace.id)).toEqual([
        expect.objectContaining({ command: "pnpm test", exitCode: 1, iteration: 2 }),
      ]);
    });
  });

  it("rejects a non-integer iteration without recording the execution", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, ["--iteration", "abc"]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });

  it("rejects an unsafe changed-file count before recording command output", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, [
        "--iteration",
        "1",
        "--changed-files",
        "9".repeat(400),
        "--command",
        "pnpm test",
        "--output",
        "tests passed",
      ]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
      expect(listExecutionOutputs(workspace.id)).toEqual([]);
    });
  });

  it("rejects a negative changed-file count", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, ["--iteration", "1", "--changed-files=-1"]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });

  it("rejects a non-integer exit code before recording command output", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, [
        "--iteration",
        "1",
        "--command",
        "pnpm test",
        "--output",
        "tests passed",
        "--exit-code",
        "abc",
      ]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
      expect(listExecutionOutputs(workspace.id)).toEqual([]);
    });
  });
});

describe("c2c record --output-file", () => {
  it("reads a normal temp file and saves it as command output", () => {
    withRecordEnvironment((root, workspace) => {
      withOutputDir((dir) => {
        const outputFile = write(dir, "vitest.log", "FAIL tests/a.test.ts\nExpected 3, received 2\n");
        const result = runRecord(root, [
          "--iteration",
          "1",
          "--command",
          "pnpm test",
          "--output-file",
          outputFile,
          "--exit-code",
          "1",
        ]);

        expect(result.status, result.stderr + result.stdout).toBe(0);
        expect(readExecutionRecords(workspace.id)).toEqual([
          expect.objectContaining({ taskId: "c2c_test", iteration: 1, outputAvailable: true }),
        ]);
        expect(listExecutionOutputs(workspace.id)).toEqual([
          expect.objectContaining({ command: "pnpm test", exitCode: 1, iteration: 1, allowed: true }),
        ]);
      });
    });
  });

  it("rejects a .env file without recording anything", () => {
    withRecordEnvironment((root, workspace) => {
      const envFile = write(root, ".env", "OPENAI_API_KEY=sk-test-not-a-real-key\n");
      const result = runRecord(root, [
        "--iteration",
        "1",
        "--command",
        "cat .env",
        "--output-file",
        envFile,
      ]);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("✗ 无法读取输出文件（sensitive）");
      expect(result.stdout).not.toContain("sk-test-not-a-real-key");
      expect(readExecutionRecords(workspace.id)).toEqual([]);
      expect(listExecutionOutputs(workspace.id)).toEqual([]);
    });
  });

  it.skipIf(process.platform === "win32")("rejects a symlink without recording anything", () => {
    withRecordEnvironment((root, workspace) => {
      withOutputDir((dir) => {
        const target = write(dir, "real.log", "tests passed\n");
        const link = path.join(dir, "output.log");
        fs.symlinkSync(target, link);
        const result = runRecord(root, [
          "--iteration",
          "1",
          "--command",
          "pnpm test",
          "--output-file",
          link,
        ]);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain("✗ 无法读取输出文件（symlink）");
        expect(readExecutionRecords(workspace.id)).toEqual([]);
        expect(listExecutionOutputs(workspace.id)).toEqual([]);
      });
    });
  });

  it("rejects a missing file without recording anything", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, [
        "--iteration",
        "1",
        "--command",
        "pnpm test",
        "--output-file",
        path.join(root, "missing.log"),
      ]);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("✗ 无法读取输出文件（not_found）");
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });
});

describe("execution record persistence", () => {
  it("rejects invalid records at the write boundary", () => {
    withRecordEnvironment((_root, workspace) => {
      const invalidRecord: ExecutionRecord = {
        taskId: "c2c_invalid",
        iteration: Number.NaN,
        changedFiles: 0,
        tests: null,
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      };

      expect(() => appendExecutionRecord(workspace.id, invalidRecord)).toThrow();
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });
});
