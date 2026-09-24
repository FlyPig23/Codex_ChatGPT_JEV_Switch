import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRouterPrefs, routerPrefsFile } from "../src/config/router-prefs.js";
import { breakerFile, readBreaker, recordJevOutcome, TYPESAFE_BASE_URL } from "../src/router/jev.js";
import {
  CONSENT_VERSION,
  consentStatus,
  fingerprintKey,
  hasValidConsent,
  keyStatus,
  keysDir,
  readRouterSecrets,
  removeRouterSecrets,
  resolveApiKey,
  secretsFile,
  writeRouterSecrets,
  type RouterSecrets,
} from "../src/router/secrets.js";
import {
  CHECKOUT_PLACEHOLDER,
  CODEX_MARKER_ENV,
  gateSkillDir,
  runSetup,
  SETUP_REFUSAL,
  setupRefusalReason,
  type SetupIO,
} from "../src/router/setup.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posix = process.platform !== "win32";

const KEY = "tsk_live_secret_key_0123456789abcdef";
const OTHER_KEY = "tsk_live_other_key_fedcba9876543210";

const PROBE_BODY = {
  model: "jev-1.13.0",
  answers: { goal_is_clear: { type: "noul", noul: 0.93 } },
  usage: { input_tokens: 12, output_tokens: 1 },
};

function fileSecrets(key = KEY, version = CONSENT_VERSION): RouterSecrets {
  return {
    v: 1,
    consent: { version, acceptedAt: "2026-09-22T08:00:00.000Z" },
    keySource: "file",
    apiKey: key,
    fingerprint: fingerprintKey(key),
  };
}

function envSecrets(key = KEY): RouterSecrets {
  return {
    v: 1,
    consent: { version: CONSENT_VERSION, acceptedAt: "2026-09-22T08:00:00.000Z" },
    keySource: "env",
    fingerprint: fingerprintKey(key),
  };
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

function probeFetch(status = 200, body: unknown = PROBE_BODY) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  );
}

function neverFetch() {
  return vi.fn(async (): Promise<Response> => {
    throw new Error("network must not be used");
  });
}

interface Scripted {
  io: Partial<SetupIO>;
  text(): string;
}

/**
 * Answers each prompt only once it has been printed, like a person at a
 * terminal. With tty: true the input looks like a raw-mode TTY, so readline
 * echoes keystrokes through the (muted) output.
 */
function scripted(answers: Array<[string, string]>, opts: { tty?: boolean; env?: NodeJS.ProcessEnv; homedir: string; fetch?: SetupIO["fetch"] }): Scripted {
  const input = new PassThrough();
  if (opts.tty) Object.assign(input, { isTTY: true, setRawMode: () => input });
  let text = "";
  let from = 0;
  let next = 0;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      while (next < answers.length) {
        const [prompt, answer] = answers[next];
        const at = text.indexOf(prompt, from);
        if (at < 0) break;
        from = at + prompt.length;
        next += 1;
        setImmediate(() => input.write(`${answer}${opts.tty ? "\r" : "\n"}`));
      }
      callback();
    },
  });
  return {
    io: {
      input,
      output,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: opts.env ?? {},
      homedir: opts.homedir,
      fetch: opts.fetch ?? neverFetch(),
    },
    text: () => text,
  };
}

const CONSENT_PROMPT = "同意并启用智能切换";
const KEY_PROMPT = "TypeSafe API Key";
const SKILL_PROMPT = "安装 c2c-router 技能";
const REMOVE_SKILL_PROMPT = "同时删除 c2c-router 技能";

describe("router secrets and setup", () => {
  const dirs: string[] = [];
  const touched = ["C2C_STATE_DIR", "C2C_KEYS_DIR", "C2C_ROUTER_FAKE_JEV", "TYPESAFE_API_KEY"];
  const saved: Record<string, string | undefined> = {};
  let stateDir = "";
  let keys = "";
  let home = "";
  let codexHome = "";

  beforeEach(() => {
    for (const name of touched) saved[name] = process.env[name];
    stateDir = makeTmpDir("secrets-state");
    keys = path.join(makeTmpDir("secrets-keys-parent"), "keys");
    home = makeTmpDir("secrets-home");
    codexHome = makeTmpDir("secrets-codex-home");
    dirs.push(stateDir, path.dirname(keys), home, codexHome);
    process.env.C2C_STATE_DIR = stateDir;
    process.env.C2C_KEYS_DIR = keys;
    delete process.env.C2C_ROUTER_FAKE_JEV;
    delete process.env.TYPESAFE_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of touched) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
  });

  describe("key storage", () => {
    it("puts the keys dir next to the state dir unless C2C_KEYS_DIR is set", () => {
      expect(keysDir()).toBe(keys);
      expect(secretsFile()).toBe(path.join(keys, ".c2c-secrets-typesafe.json"));
      delete process.env.C2C_KEYS_DIR;
      expect(keysDir()).toBe(`${stateDir}-keys`);
      expect(path.dirname(keysDir())).toBe(path.dirname(stateDir));
      expect(keysDir().startsWith(`${stateDir}${path.sep}`)).toBe(false);
    });

    it("fingerprints a key as the first 16 hex chars of its sha256", () => {
      const fp = fingerprintKey(KEY);
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
      expect(fp).toBe(createHash("sha256").update(KEY).digest("hex").slice(0, 16));
      expect(fingerprintKey(OTHER_KEY)).not.toBe(fp);
    });

    it.skipIf(!posix)("writes the secrets file 0600 inside a 0700 dir and round-trips it", () => {
      writeRouterSecrets(fileSecrets());
      expect(mode(keys)).toBe(0o700);
      expect(mode(secretsFile())).toBe(0o600);
      expect(readRouterSecrets()).toEqual(fileSecrets());
      expect(fs.readdirSync(keys)).toEqual([".c2c-secrets-typesafe.json"]);

      fs.chmodSync(keys, 0o755);
      writeRouterSecrets(fileSecrets(OTHER_KEY));
      expect(mode(keys)).toBe(0o700);
      expect(mode(secretsFile())).toBe(0o600);
      expect(readRouterSecrets()?.apiKey).toBe(OTHER_KEY);
    });

    it("never stores a raw key for keySource env and rejects inconsistent secrets", () => {
      writeRouterSecrets({ ...envSecrets(), apiKey: KEY });
      const raw = fs.readFileSync(secretsFile(), "utf8");
      expect(raw).not.toContain(KEY);
      expect(readRouterSecrets()).toEqual(envSecrets());

      expect(() => writeRouterSecrets({ ...fileSecrets(), fingerprint: fingerprintKey(OTHER_KEY) })).toThrow();
      expect(() => writeRouterSecrets({ ...fileSecrets(), apiKey: undefined })).toThrow();
      expect(() => writeRouterSecrets({ ...fileSecrets(), fingerprint: "not-hex" })).toThrow();
      expect(readRouterSecrets()).toEqual(envSecrets());
    });

    it("treats a missing, corrupt or tampered secrets file as absent", () => {
      expect(readRouterSecrets()).toBeNull();
      expect(resolveApiKey({})).toBeNull();
      fs.mkdirSync(keys, { recursive: true });
      fs.writeFileSync(secretsFile(), "{not json");
      expect(readRouterSecrets()).toBeNull();
      fs.writeFileSync(secretsFile(), JSON.stringify({ ...fileSecrets(), fingerprint: fingerprintKey(OTHER_KEY) }));
      expect(readRouterSecrets()).toBeNull();
      fs.writeFileSync(secretsFile(), JSON.stringify({ ...fileSecrets(), v: 2 }));
      expect(readRouterSecrets()).toBeNull();
      expect(hasValidConsent()).toBe(false);
    });

    it("removes the secrets file", () => {
      expect(removeRouterSecrets()).toBe(false);
      writeRouterSecrets(fileSecrets());
      expect(removeRouterSecrets()).toBe(true);
      expect(fs.existsSync(secretsFile())).toBe(false);
      expect(readRouterSecrets()).toBeNull();
    });
  });

  describe("key resolution", () => {
    it("uses the file key and ignores TYPESAFE_API_KEY when keySource is file", () => {
      writeRouterSecrets(fileSecrets());
      expect(resolveApiKey({ TYPESAFE_API_KEY: OTHER_KEY })).toEqual({ key: KEY, source: "file", fingerprint: fingerprintKey(KEY) });
      expect(resolveApiKey({})).toEqual({ key: KEY, source: "file", fingerprint: fingerprintKey(KEY) });
    });

    it("uses the env key only with keySource env and a matching fingerprint", () => {
      writeRouterSecrets(envSecrets());
      expect(resolveApiKey({ TYPESAFE_API_KEY: KEY })).toEqual({ key: KEY, source: "env", fingerprint: fingerprintKey(KEY) });
      expect(resolveApiKey({ TYPESAFE_API_KEY: ` ${KEY}\n` })?.key).toBe(KEY);
      expect(resolveApiKey({ TYPESAFE_API_KEY: OTHER_KEY })).toBeNull();
      expect(resolveApiKey({ TYPESAFE_API_KEY: "" })).toBeNull();
      expect(resolveApiKey({})).toBeNull();
      process.env.TYPESAFE_API_KEY = KEY;
      expect(resolveApiKey()?.source).toBe("env");
      process.env.TYPESAFE_API_KEY = OTHER_KEY;
      expect(resolveApiKey()).toBeNull();
    });

    it("an exported TYPESAFE_API_KEY alone does nothing", () => {
      expect(resolveApiKey({ TYPESAFE_API_KEY: KEY })).toBeNull();
      expect(keyStatus({ TYPESAFE_API_KEY: KEY })).toEqual({ configured: false, source: null, fingerprint8: null });
      expect(consentStatus()).toEqual({ accepted: false, version: null, current: CONSENT_VERSION });
    });

    it("resolves no key for an outdated consent version", () => {
      writeRouterSecrets(fileSecrets(KEY, "2020-01-old"));
      expect(hasValidConsent()).toBe(false);
      expect(resolveApiKey({})).toBeNull();
      expect(consentStatus()).toEqual({ accepted: false, version: "2020-01-old", current: CONSENT_VERSION });
      // consent to the first wording ("never file paths", failure goal sent) must be asked again
      writeRouterSecrets(fileSecrets(KEY, "2026-09-routing-1"));
      expect(hasValidConsent()).toBe(false);
    });
  });

  describe("status output", () => {
    it("never contains the key in key/consent status, the breaker file or router.json", () => {
      writeRouterSecrets(fileSecrets());
      const status = { key: keyStatus({}), consent: consentStatus() };
      expect(status).toEqual({
        key: { configured: true, source: "file", fingerprint8: fingerprintKey(KEY).slice(0, 8) },
        consent: { accepted: true, version: CONSENT_VERSION, current: CONSENT_VERSION },
      });
      recordJevOutcome({ ok: false, error: "auth" }, fingerprintKey(KEY));
      const { open, until, reason } = readBreaker({ fingerprint: fingerprintKey(KEY) });
      expect({ open, until, reason }).toEqual({ open: true, until: null, reason: "auth" });

      // The `route status` shape: only fingerprint8 of the key, never the key or its full fingerprint.
      const printed = JSON.stringify({ ...status, breaker: { open, until, reason } });
      expect(printed).not.toContain(fingerprintKey(KEY).slice(8));
      for (const text of [printed, fs.readFileSync(breakerFile(), "utf8")]) {
        expect(text).not.toContain(KEY);
        expect(text).not.toContain(KEY.slice(0, 16));
      }

      writeRouterSecrets(envSecrets(OTHER_KEY));
      const envStatus = JSON.stringify({ missing: keyStatus({}), present: keyStatus({ TYPESAFE_API_KEY: OTHER_KEY }) });
      expect(envStatus).not.toContain(OTHER_KEY);
      expect(keyStatus({})).toEqual({ configured: false, source: "env", fingerprint8: fingerprintKey(OTHER_KEY).slice(0, 8) });
      expect(keyStatus({ TYPESAFE_API_KEY: OTHER_KEY }).configured).toBe(true);
    });
  });

  describe("setup refusals", () => {
    it("refuses without a TTY on stdin or stdout", async () => {
      for (const [stdinIsTTY, stdoutIsTTY] of [
        [false, true],
        [true, false],
        [false, false],
      ] as const) {
        expect(setupRefusalReason({ stdinIsTTY, stdoutIsTTY, env: {} })).toBe("no_tty");
        const run = scripted([], { homedir: home });
        const code = await runSetup({ checkoutRoot: projectRoot, io: { ...run.io, stdinIsTTY, stdoutIsTTY } });
        expect(code).toBe(1);
        expect(run.text().trim()).toBe(SETUP_REFUSAL);
      }
      expect(fs.existsSync(secretsFile())).toBe(false);
      expect(fs.existsSync(routerPrefsFile())).toBe(false);
    });

    it("refuses under every Codex marker env var, even with TTYs", async () => {
      expect(CODEX_MARKER_ENV).toEqual(
        expect.arrayContaining(["CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID", "CODEX_NON_INTERACTIVE"])
      );
      for (const name of CODEX_MARKER_ENV) {
        const env = { [name]: name === "CODEX_SANDBOX" ? "seatbelt" : "1" };
        expect(setupRefusalReason({ stdinIsTTY: true, stdoutIsTTY: true, env })).toBe("codex_env");
        const run = scripted([[CONSENT_PROMPT, "y"]], { homedir: home, env });
        expect(await runSetup({ checkoutRoot: projectRoot, io: run.io })).toBe(1);
        expect(run.text().trim()).toBe(SETUP_REFUSAL);
        expect(await runSetup({ checkoutRoot: projectRoot, remove: true, io: scripted([], { homedir: home, env }).io })).toBe(1);
      }
      expect(setupRefusalReason({ stdinIsTTY: true, stdoutIsTTY: true, env: { CODEX_SANDBOX: " " } })).toBeNull();
      expect(fs.existsSync(secretsFile())).toBe(false);
      expect(fs.existsSync(routerPrefsFile())).toBe(false);
    });

    it("refuses in a real process with piped stdio", () => {
      const script = path.join(stateDir, "run-setup.ts");
      fs.writeFileSync(
        script,
        [
          `import { runSetup } from ${JSON.stringify(path.join(projectRoot, "src/router/setup.ts"))};`,
          `process.exitCode = await runSetup({ checkoutRoot: ${JSON.stringify(projectRoot)} });`,
        ].join("\n")
      );
      const env: NodeJS.ProcessEnv = { ...process.env, C2C_STATE_DIR: stateDir, C2C_KEYS_DIR: keys, HOME: home, CODEX_HOME: codexHome };
      for (const name of CODEX_MARKER_ENV) delete env[name];
      const plain = spawnSync(process.execPath, ["--import", "tsx", script], {
        cwd: projectRoot,
        encoding: "utf8",
        env,
        input: `y\n${KEY}\ny\n`,
        stdio: "pipe",
      });
      expect(plain.status).toBe(1);
      expect(plain.stdout.trim()).toBe(SETUP_REFUSAL);
      expect(plain.stdout + plain.stderr).not.toContain(KEY);

      const sandboxed = spawnSync(process.execPath, ["--import", "tsx", script], {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...env, CODEX_SANDBOX: "seatbelt" },
        input: "y\n",
        stdio: "pipe",
      });
      expect(sandboxed.status).toBe(1);
      expect(sandboxed.stdout.trim()).toBe(SETUP_REFUSAL);
      expect(fs.existsSync(secretsFile())).toBe(false);
      expect(fs.existsSync(routerPrefsFile())).toBe(false);
      expect(fs.existsSync(path.join(codexHome, "skills"))).toBe(false);
    });
  });

  describe("setup", () => {
    it("saves consent and the key, turns routing on and installs the gate skill", async () => {
      const fetch = probeFetch();
      const run = scripted(
        [
          [CONSENT_PROMPT, "y"],
          [KEY_PROMPT, KEY],
          [SKILL_PROMPT, ""],
        ],
        { homedir: home, env: { CODEX_HOME: codexHome, TYPESAFE_API_KEY: OTHER_KEY }, fetch }
      );
      expect(await runSetup({ checkoutRoot: projectRoot, io: run.io })).toBe(0);
      const text = run.text();
      expect(text).toContain(TYPESAFE_BASE_URL);
      expect(text).toContain(secretsFile());
      // the disclosure matches what is sent: error lines and follow-ups can carry paths; no task goal on failure
      expect(text).toContain("可能包含报错里出现的文件路径、主机名和出错的那几行源码");
      expect(text).toContain("条目里写到的文件名/路径会保留");
      expect(text).not.toMatch(/从不发送：[^\n]*文件路径/);
      expect(text).not.toContain("任务目标");
      expect(text).toContain("✓ 已连通 TypeSafe");
      expect(text).toContain(fingerprintKey(KEY).slice(0, 8));
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(OTHER_KEY);

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0];
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
      const body = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, unknown> };
      expect(body.model).toBe("jev-1.13.0");
      expect(Object.keys(body.questions)).toEqual(["goal_is_clear"]);

      expect(readRouterSecrets()).toMatchObject({
        v: 1,
        consent: { version: CONSENT_VERSION },
        keySource: "file",
        apiKey: KEY,
        fingerprint: fingerprintKey(KEY),
      });
      if (posix) {
        expect(mode(secretsFile())).toBe(0o600);
        expect(mode(keys)).toBe(0o700);
      }
      expect(resolveApiKey({})?.key).toBe(KEY);
      expect(readRouterPrefs().mode).toBe("auto");
      expect(fs.readFileSync(routerPrefsFile(), "utf8")).not.toContain(KEY);

      const skill = path.join(codexHome, "skills", "c2c-router", "SKILL.md");
      expect(gateSkillDir({ CODEX_HOME: codexHome }, home)).toBe(path.dirname(skill));
      const installed = fs.readFileSync(skill, "utf8");
      expect(installed).not.toContain(CHECKOUT_PLACEHOLDER);
      expect(installed).toContain(`node "${projectRoot}/bin/c2c.js" route`);
      expect(installed).toContain("name: c2c-router");
      expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
    });

    it("installs the skill under <home>/.codex without CODEX_HOME and replaces a symlink instead of following it", async () => {
      const target = path.join(home, "elsewhere.md");
      fs.writeFileSync(target, "keep me");
      const dest = path.join(home, ".codex", "skills", "c2c-router", "SKILL.md");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.symlinkSync(target, dest);
      const run = scripted(
        [
          [CONSENT_PROMPT, "y"],
          [KEY_PROMPT, KEY],
          [SKILL_PROMPT, "y"],
        ],
        { homedir: home, fetch: probeFetch() }
      );
      expect(await runSetup({ checkoutRoot: projectRoot, io: run.io })).toBe(0);
      expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(dest, "utf8")).toContain("name: c2c-router");
      expect(fs.readFileSync(target, "utf8")).toBe("keep me");
    });

    it("hides the key while it is typed at a terminal", async () => {
      const run = scripted(
        [
          [CONSENT_PROMPT, "y"],
          [KEY_PROMPT, KEY],
          [SKILL_PROMPT, "n"],
        ],
        { tty: true, homedir: home, env: { CODEX_HOME: codexHome }, fetch: probeFetch() }
      );
      expect(await runSetup({ checkoutRoot: projectRoot, io: run.io })).toBe(0);
      expect(run.text()).toContain(CONSENT_PROMPT);
      expect(run.text()).not.toContain(KEY);
      expect(run.text()).not.toContain(KEY.slice(0, 8));
      expect(readRouterSecrets()?.apiKey).toBe(KEY);
      expect(fs.existsSync(path.join(codexHome, "skills"))).toBe(false);
    });

    it("falls back to TYPESAFE_API_KEY and stores only its fingerprint", async () => {
      const fetch = probeFetch();
      const run = scripted(
        [
          [CONSENT_PROMPT, "y"],
          [KEY_PROMPT, ""],
          [SKILL_PROMPT, "n"],
        ],
        { homedir: home, env: { CODEX_HOME: codexHome, TYPESAFE_API_KEY: KEY }, fetch }
      );
      expect(await runSetup({ checkoutRoot: projectRoot, io: run.io })).toBe(0);
      expect(new Headers(fetch.mock.calls[0][1]?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
      expect(readRouterSecrets()).toEqual({
        v: 1,
        consent: { version: CONSENT_VERSION, acceptedAt: expect.any(String) },
        keySource: "env",
        fingerprint: fingerprintKey(KEY),
      });
      expect(fs.readFileSync(secretsFile(), "utf8")).not.toContain(KEY);
      expect(run.text()).not.toContain(KEY);
      expect(resolveApiKey({ TYPESAFE_API_KEY: KEY })?.source).toBe("env");
      expect(resolveApiKey({ TYPESAFE_API_KEY: OTHER_KEY })).toBeNull();
      expect(readRouterPrefs().mode).toBe("auto");
    });

    it("changes nothing when consent is declined or no key is available", async () => {
      const declined = scripted([[CONSENT_PROMPT, ""]], { homedir: home, env: { CODEX_HOME: codexHome } });
      expect(await runSetup({ checkoutRoot: projectRoot, io: declined.io })).toBe(0);
      expect(declined.text()).toContain("已取消");

      const noKey = scripted(
        [
          [CONSENT_PROMPT, "y"],
          [KEY_PROMPT, ""],
        ],
        { homedir: home, env: { CODEX_HOME: codexHome } }
      );
      expect(await runSetup({ checkoutRoot: projectRoot, io: noKey.io })).toBe(1);

      const badKey = scripted(
        [
          [CONSENT_PROMPT, "y"],
          [KEY_PROMPT, "has spaces in it"],
        ],
        { homedir: home, env: { CODEX_HOME: codexHome } }
      );
      expect(await runSetup({ checkoutRoot: projectRoot, io: badKey.io })).toBe(1);
      expect(badKey.text()).not.toContain("has spaces in it");

      expect(fs.existsSync(secretsFile())).toBe(false);
      expect(fs.existsSync(routerPrefsFile())).toBe(false);
      expect(fs.existsSync(path.join(codexHome, "skills"))).toBe(false);
    });

    it("saves the settings even when the live probe fails", async () => {
      const fetch = probeFetch(401, { error: "bad key" });
      const run = scripted(
        [
          [CONSENT_PROMPT, "y"],
          [KEY_PROMPT, KEY],
          [SKILL_PROMPT, "n"],
        ],
        { homedir: home, env: { CODEX_HOME: codexHome }, fetch }
      );
      expect(await runSetup({ checkoutRoot: projectRoot, io: run.io })).toBe(0);
      expect(run.text()).toContain("✗ 连接测试失败");
      expect(run.text()).not.toContain("bad key");
      expect(readRouterSecrets()?.apiKey).toBe(KEY);
      expect(readRouterPrefs().mode).toBe("auto");
      expect(readBreaker({ fingerprint: fingerprintKey(KEY) })).toMatchObject({ open: true, reason: "auth" });
    });

    it("--remove deletes the key, turns routing off and offers to remove the gate skill", async () => {
      const enable = scripted(
        [
          [CONSENT_PROMPT, "y"],
          [KEY_PROMPT, KEY],
          [SKILL_PROMPT, "y"],
        ],
        { homedir: home, env: { CODEX_HOME: codexHome }, fetch: probeFetch() }
      );
      expect(await runSetup({ checkoutRoot: projectRoot, io: enable.io })).toBe(0);
      const skillDir = path.join(codexHome, "skills", "c2c-router");
      expect(fs.existsSync(skillDir)).toBe(true);
      recordJevOutcome({ ok: false, error: "rate_limited" }, fingerprintKey(KEY));

      const keep = scripted([[REMOVE_SKILL_PROMPT, "n"]], { homedir: home, env: { CODEX_HOME: codexHome } });
      expect(await runSetup({ checkoutRoot: projectRoot, remove: true, io: keep.io })).toBe(0);
      expect(fs.existsSync(secretsFile())).toBe(false);
      expect(readRouterPrefs().mode).toBe("off");
      expect(readBreaker().open).toBe(false);
      expect(fs.existsSync(skillDir)).toBe(true);
      expect(keep.text()).toContain("✓ 已删除 TypeSafe Key");

      const drop = scripted([[REMOVE_SKILL_PROMPT, "y"]], { homedir: home, env: { CODEX_HOME: codexHome } });
      expect(await runSetup({ checkoutRoot: projectRoot, remove: true, io: drop.io })).toBe(0);
      expect(fs.existsSync(skillDir)).toBe(false);
      expect(drop.text()).toContain("没有找到已保存的 Key");

      const nothing = scripted([], { homedir: home, env: { CODEX_HOME: codexHome } });
      expect(await runSetup({ checkoutRoot: projectRoot, remove: true, io: nothing.io })).toBe(0);
      expect(nothing.text()).not.toContain(REMOVE_SKILL_PROMPT);
      expect(readRouterPrefs().mode).toBe("off");
    });
  });
});
