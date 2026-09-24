import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardLocalInput } from "../src/execution/local-input.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const posixIt = process.platform === "win32" ? it.skip : it;

describe("guardLocalInput", () => {
  const dirs: string[] = [];
  let root: string;
  let outside: string;
  let home: string;
  let stateDir: string;
  let keysDir: string;
  let workspace: Workspace;
  const previousEnv = { state: process.env.C2C_STATE_DIR, keys: process.env.C2C_KEYS_DIR };

  const read = (file: string, opts: { mode?: "head" | "tail"; maxBytes?: number } = {}) =>
    guardLocalInput(workspace, file, { mode: opts.mode ?? "head", maxBytes: opts.maxBytes ?? 1024, homeDir: home });

  beforeEach(() => {
    root = makeTmpDir("local-input-ws");
    outside = makeTmpDir("local-input-tmp");
    home = makeTmpDir("local-input-home");
    stateDir = makeTmpDir("local-input-state");
    keysDir = makeTmpDir("local-input-keys");
    dirs.push(root, outside, home, stateDir, keysDir);
    process.env.C2C_STATE_DIR = stateDir;
    process.env.C2C_KEYS_DIR = keysDir;
    write(root, ".c2cignore", "private/\n");
    workspace = new Workspace(root);
  });

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    if (previousEnv.state === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousEnv.state;
    if (previousEnv.keys === undefined) delete process.env.C2C_KEYS_DIR;
    else process.env.C2C_KEYS_DIR = previousEnv.keys;
  });

  it("reads a normal file outside the workspace", () => {
    const file = write(outside, "vitest-output.log", "FAIL src/a.test.ts\nExpected 3, received 2\n");
    expect(read(file)).toEqual({ ok: true, text: "FAIL src/a.test.ts\nExpected 3, received 2\n", truncated: false });
  });

  it("reads a normal file inside the workspace and resolves relative paths from cwd", () => {
    const file = write(root, "logs/build.log", "error TS2345\n");
    expect(read(file)).toMatchObject({ ok: true, text: "error TS2345\n" });
    const relative = path.relative(process.cwd(), file);
    expect(read(relative)).toMatchObject({ ok: true, text: "error TS2345\n" });
  });

  it("reports a missing file", () => {
    expect(read(path.join(outside, "nope.log"))).toEqual({ ok: false, reason: "not_found" });
    expect(read("")).toEqual({ ok: false, reason: "not_found" });
    expect(read("bad\0path")).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects directories", () => {
    fs.mkdirSync(path.join(outside, "dir"));
    expect(read(path.join(outside, "dir"))).toEqual({ ok: false, reason: "not_regular_file" });
  });

  posixIt("rejects a symlink even when it points at an ordinary file", () => {
    const target = write(outside, "real.log", "ok\n");
    const link = path.join(outside, "link.log");
    fs.symlinkSync(target, link);
    expect(read(link)).toEqual({ ok: false, reason: "symlink" });
  });

  posixIt("rejects a FIFO without blocking", () => {
    const fifo = path.join(outside, "pipe");
    if (spawnSync("mkfifo", [fifo]).status !== 0) return;
    expect(read(fifo)).toEqual({ ok: false, reason: "not_regular_file" });
  });

  it("rejects sensitive files by workspace-relative path", () => {
    expect(read(write(root, ".env", "API_KEY=abc\n"))).toEqual({ ok: false, reason: "sensitive" });
    expect(read(write(root, "config/.env.production", "X=1\n"))).toEqual({ ok: false, reason: "sensitive" });
    expect(read(write(root, "private/notes.txt", "custom rule\n"))).toEqual({ ok: false, reason: "sensitive" });
    expect(read(write(root, "certs/server.pem", "pem\n"))).toEqual({ ok: false, reason: "sensitive" });
    expect(read(write(root, ".env.example", "API_KEY=\n"))).toMatchObject({ ok: true });
  });

  it("rejects sensitive basenames outside the workspace", () => {
    expect(read(write(outside, ".env", "API_KEY=abc\n"))).toEqual({ ok: false, reason: "sensitive" });
    expect(read(write(outside, "id_rsa", "key\n"))).toEqual({ ok: false, reason: "sensitive" });
    expect(read(write(outside, ".c2c-secrets-typesafe.json", "{}\n"))).toEqual({ ok: false, reason: "sensitive" });
    expect(read(write(outside, "private/notes.txt", "outside the workspace\n"))).toMatchObject({ ok: true });
  });

  it("rejects files under credential directories in the home directory", () => {
    for (const rel of [
      ".ssh/config",
      ".aws/config",
      ".gnupg/pubring.kbx",
      ".config/gcloud/configurations/config_default",
      ".docker/config.json",
      ".codex/auth.json",
      ".cloudflared/tunnel.json",
    ]) {
      expect(read(write(home, rel, "secret\n")), rel).toEqual({ ok: false, reason: "protected_location" });
    }
    expect(read(write(home, "Downloads/output.log", "fine\n"))).toMatchObject({ ok: true });
  });

  posixIt("uses the real path, so a symlinked parent cannot reach a protected directory", () => {
    write(home, ".ssh/known_hosts", "host\n");
    const linkedDir = path.join(outside, "innocent");
    fs.symlinkSync(path.join(home, ".ssh"), linkedDir);
    expect(read(path.join(linkedDir, "known_hosts"))).toEqual({ ok: false, reason: "protected_location" });
  });

  it("rejects files under the state dir and the keys dir", () => {
    expect(read(write(stateDir, "sessions/abc.json", "{}\n"))).toEqual({ ok: false, reason: "protected_location" });
    expect(read(write(keysDir, "notes.txt", "x\n"))).toEqual({ ok: false, reason: "protected_location" });
  });

  it("defaults the keys dir to a sibling of the state dir", () => {
    delete process.env.C2C_KEYS_DIR;
    const sibling = `${stateDir}-keys`;
    dirs.push(sibling);
    expect(read(write(sibling, "notes.txt", "x\n"))).toEqual({ ok: false, reason: "protected_location" });
    expect(read(write(`${stateDir}-other`, "notes.txt", "x\n"))).toMatchObject({ ok: true });
    dirs.push(`${stateDir}-other`);
  });

  it("caps head and tail reads and reports truncation", () => {
    const file = write(outside, "long.log", "0123456789");
    expect(read(file, { mode: "head", maxBytes: 4 })).toEqual({ ok: true, text: "0123", truncated: true });
    expect(read(file, { mode: "tail", maxBytes: 4 })).toEqual({ ok: true, text: "6789", truncated: true });
    expect(read(file, { mode: "tail", maxBytes: 100 })).toEqual({ ok: true, text: "0123456789", truncated: false });
    expect(read(file, { mode: "head", maxBytes: 0 })).toEqual({ ok: true, text: "", truncated: true });
  });

  it("never splits a UTF-8 character at the cut", () => {
    const file = write(outside, "zh.log", "你好世界");
    const head = read(file, { mode: "head", maxBytes: 4 });
    expect(head).toEqual({ ok: true, text: "你", truncated: true });
    const tail = read(file, { mode: "tail", maxBytes: 4 });
    expect(tail).toEqual({ ok: true, text: "界", truncated: true });
    const emoji = write(outside, "emoji.log", "a😀b");
    expect(read(emoji, { mode: "head", maxBytes: 4 })).toEqual({ ok: true, text: "a", truncated: true });
    expect(read(emoji, { mode: "tail", maxBytes: 3 })).toEqual({ ok: true, text: "b", truncated: true });
  });
});
