import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkForUpdate,
  NO_TRACKING_BRANCH_NOTE,
  runUpdateCheck,
  updateCheckFile,
  type UpdateGitRunner,
} from "../src/config/update-check.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "c2c-test",
  GIT_AUTHOR_EMAIL: "test@c2c.local",
  GIT_COMMITTER_NAME: "c2c-test",
  GIT_COMMITTER_EMAIL: "test@c2c.local",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * Records every git call; only local paths are ever used as remotes here. The ceiling keeps
 * git from walking up into this project's own checkout for dirs that are not repos.
 */
function recordingRunner(calls: string[][], ceiling: string): UpdateGitRunner {
  return (root, args) => {
    calls.push(args);
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...GIT_ENV, GIT_CEILING_DIRECTORIES: ceiling },
    });
    return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
  };
}

function commit(dir: string, file: string, content: string): string {
  write(dir, file, content);
  git(dir, "add", ".");
  git(dir, "commit", "-m", `edit ${file}`);
  return git(dir, "rev-parse", "HEAD").trim();
}

describe("update check", () => {
  const dirs: string[] = [];
  let base: string;
  let remote: string;
  let work: string;
  let calls: string[][];
  let runGit: UpdateGitRunner;
  const previousEnv = { state: process.env.C2C_STATE_DIR, keys: process.env.C2C_KEYS_DIR };

  beforeEach(() => {
    base = makeTmpDir("update-check");
    const stateDir = makeTmpDir("update-check-state");
    const keysDir = makeTmpDir("update-check-keys");
    dirs.push(base, stateDir, keysDir);
    process.env.C2C_STATE_DIR = stateDir;
    process.env.C2C_KEYS_DIR = keysDir;
    calls = [];
    runGit = recordingRunner(calls, path.dirname(base));

    const seed = path.join(base, "seed");
    fs.mkdirSync(seed);
    makeGitRepo(seed);
    remote = path.join(base, "remote.git");
    git(base, "clone", "--bare", "--quiet", seed, remote);
    work = path.join(base, "work");
    git(base, "clone", "--quiet", remote, work);
  });

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    if (previousEnv.state === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousEnv.state;
    if (previousEnv.keys === undefined) delete process.env.C2C_KEYS_DIR;
    else process.env.C2C_KEYS_DIR = previousEnv.keys;
  });

  /** Push a new commit to the bare remote from a second clone. */
  function advanceRemote(): string {
    const other = path.join(base, `other-${calls.length}-${Date.now()}`);
    git(base, "clone", "--quiet", remote, other);
    const head = commit(other, "upstream.txt", `upstream ${Date.now()}\n`);
    git(other, "push", "--quiet", "origin", "HEAD:main");
    return head;
  }

  it("reports no update when the checkout matches its tracking branch", () => {
    const status = checkForUpdate(work, runGit);
    expect(status).toMatchObject({ kind: "checked", updateAvailable: false, remote: "origin", branch: "main" });
    expect(calls).toContainEqual(["ls-remote", "origin", "refs/heads/main"]);
  });

  it("returns no tracking branch for a repo without an upstream and caches the date", () => {
    const solo = path.join(base, "solo");
    fs.mkdirSync(solo);
    makeGitRepo(solo);

    expect(checkForUpdate(solo, runGit)).toMatchObject({ kind: "no_tracking_branch", updateAvailable: false });
    expect(calls.some((args) => args[0] === "ls-remote")).toBe(false);

    const now = new Date(2026, 8, 22, 10, 0, 0);
    const result = runUpdateCheck({ repoRoot: solo, runGit, now });
    expect(result).toMatchObject({ checked: true, updateAvailable: false, note: NO_TRACKING_BRANCH_NOTE });
    const cache = JSON.parse(fs.readFileSync(updateCheckFile(), "utf8")) as { date: string; updateAvailable: boolean };
    expect(cache).toMatchObject({ date: "2026-09-22", updateAvailable: false });

    calls.length = 0;
    const again = runUpdateCheck({ repoRoot: solo, runGit, now });
    expect(again).toMatchObject({ checked: false, updateAvailable: false });
    expect(calls).toEqual([]);
  });

  it("ignores a detached HEAD (no tracking branch)", () => {
    git(work, "checkout", "--quiet", "--detach");
    expect(checkForUpdate(work, runGit)).toMatchObject({ kind: "no_tracking_branch", updateAvailable: false });
  });

  it("reports no update when the checkout is ahead of the remote", () => {
    commit(work, "local.txt", "local only\n");
    expect(checkForUpdate(work, runGit)).toMatchObject({ kind: "checked", updateAvailable: false });
  });

  it("reports an update when the remote is ahead and its tip was never fetched", () => {
    const remoteHead = advanceRemote();
    const status = checkForUpdate(work, runGit);
    expect(status).toMatchObject({ kind: "checked", updateAvailable: true, remoteCommit: remoteHead });
  });

  it("reports an update when the remote tip was fetched but not merged", () => {
    advanceRemote();
    git(work, "fetch", "--quiet", "origin");
    expect(checkForUpdate(work, runGit)).toMatchObject({ kind: "checked", updateAvailable: true });
  });

  it("reports an update when local and remote have diverged", () => {
    advanceRemote();
    commit(work, "local.txt", "local only\n");
    expect(checkForUpdate(work, runGit)).toMatchObject({ kind: "checked", updateAvailable: true });
  });

  it("follows a tracking branch on a differently named remote", () => {
    git(work, "remote", "rename", "origin", "upstream");
    git(work, "checkout", "--quiet", "-b", "feature/x", "--track", "upstream/main");
    const remoteHead = advanceRemote();
    const status = checkForUpdate(work, runGit);
    expect(status).toMatchObject({ kind: "checked", updateAvailable: true, remote: "upstream", branch: "main", remoteCommit: remoteHead });
  });

  it("caches a checked result for the day and rechecks with force", () => {
    const now = new Date(2026, 8, 22, 9, 0, 0);
    expect(runUpdateCheck({ repoRoot: work, runGit, now })).toMatchObject({ checked: true, updateAvailable: false });

    advanceRemote();
    expect(runUpdateCheck({ repoRoot: work, runGit, now })).toMatchObject({ checked: false, updateAvailable: false });
    expect(runUpdateCheck({ repoRoot: work, runGit, now, force: true })).toMatchObject({
      checked: true,
      updateAvailable: true,
    });
    expect(runUpdateCheck({ repoRoot: work, runGit, now })).toMatchObject({ checked: false, updateAvailable: true });
    const tomorrow = new Date(2026, 8, 23, 9, 0, 0);
    expect(runUpdateCheck({ repoRoot: work, runGit, now: tomorrow })).toMatchObject({ checked: true });
  });

  it("skips without caching when the remote cannot be reached", () => {
    fs.rmSync(remote, { recursive: true, force: true });
    const result = runUpdateCheck({ repoRoot: work, runGit });
    expect(result).toMatchObject({ checked: false, updateAvailable: false });
    expect(fs.existsSync(updateCheckFile())).toBe(false);
  });

  it("skips without caching outside a git checkout", () => {
    const plain = makeTmpDir("update-check-plain");
    dirs.push(plain);
    expect(checkForUpdate(plain, runGit)).toEqual({ kind: "unavailable", updateAvailable: false });
    expect(runUpdateCheck({ repoRoot: plain, runGit })).toMatchObject({ checked: false, updateAvailable: false });
    expect(fs.existsSync(updateCheckFile())).toBe(false);
  });
});
