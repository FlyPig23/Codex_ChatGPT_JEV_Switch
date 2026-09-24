import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";
import type { Fetch } from "@typesafe-ai/sdk";
import { mergeRouterPrefs, readRouterPrefs } from "../config/router-prefs.js";
import { probeJev, resetBreaker, TYPESAFE_BASE_URL } from "./jev.js";
import {
  CONSENT_VERSION,
  fingerprintKey,
  removeRouterSecrets,
  secretsFile,
  writeRouterSecrets,
  type ResolvedKey,
  type RouterSecrets,
} from "./secrets.js";
import type { JevErrorClass } from "./types.js";

/**
 * Env vars that Codex (checked against the 2026-09 CLI) sets for, or passes
 * down to, commands it runs. Setup must be run by the user, not by Codex.
 */
export const CODEX_MARKER_ENV = [
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_THREAD_ID",
  "CODEX_NON_INTERACTIVE",
  "CODEX_CI",
  "CODEX_NETWORK_PROXY_ACTIVE",
  "CODEX_ESCALATE_SOCKET",
  "CODEX_MANAGED_BY_NPM",
  "CODEX_MANAGED_BY_BUN",
] as const;

export const SETUP_REFUSAL = "请在你自己的终端里运行这条命令。";
export const CHECKOUT_PLACEHOLDER = "<ACTUAL_CHECKOUT_PATH>";

export interface SetupIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** For the live probe (tests inject one; the default is global fetch). */
  fetch?: Fetch;
}

export interface SetupOptions {
  remove?: boolean;
  /** Absolute path of this C2C checkout (contains bin/c2c.js and router-skill/). */
  checkoutRoot: string;
  io?: Partial<SetupIO>;
}

const KEY_RE = /^[\x21-\x7e]{8,512}$/;

const PROBE_ERROR_ZH: Record<JevErrorClass, string> = {
  no_key: "没有可用的 Key",
  breaker_open: "最近请求失败过多，稍后会自动恢复",
  network_blocked: "无法连接网络",
  timeout: "请求超时",
  rate_limited: "请求过于频繁",
  auth: "Key 无效或没有权限",
  server: "TypeSafe 服务暂时不可用",
  bad_request: "请求被拒绝",
  invalid_response: "服务返回了意外的结果",
  outbound_rejected: "请求内容未通过本地检查",
};

function defaultIO(): SetupIO {
  return {
    input: process.stdin,
    output: process.stdout,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    env: process.env,
    homedir: os.homedir(),
  };
}

export function setupRefusalReason(io: Pick<SetupIO, "stdinIsTTY" | "stdoutIsTTY" | "env">): "no_tty" | "codex_env" | null {
  if (CODEX_MARKER_ENV.some((name) => (io.env[name] ?? "").trim() !== "")) return "codex_env";
  if (!io.stdinIsTTY || !io.stdoutIsTTY) return "no_tty";
  return null;
}

export function codexHomeFor(env: NodeJS.ProcessEnv, homedir: string): string {
  const fromEnv = env.CODEX_HOME?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(homedir, ".codex");
}

export function gateSkillDir(env: NodeJS.ProcessEnv, homedir: string): string {
  return path.join(codexHomeFor(env, homedir), "skills", "c2c-router");
}

export function installGateSkill(
  checkoutRoot: string,
  env: NodeJS.ProcessEnv,
  homedir: string
): { installed: boolean; path: string; reason?: "missing_source" } {
  const root = path.resolve(checkoutRoot);
  const dest = path.join(gateSkillDir(env, homedir), "SKILL.md");
  let source: string;
  try {
    source = fs.readFileSync(path.join(root, "router-skill", "SKILL.md"), "utf8");
  } catch {
    return { installed: false, path: dest, reason: "missing_source" };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Write then rename, so an existing symlink at dest is replaced rather than followed.
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, source.split(CHECKOUT_PLACEHOLDER).join(root), { mode: 0o644 });
    fs.renameSync(tmp, dest);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return { installed: true, path: dest };
}

export function removeGateSkill(env: NodeJS.ProcessEnv, homedir: string): boolean {
  const dir = gateSkillDir(env, homedir);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

class MutableOutput extends Writable {
  muted = false;

  constructor(private readonly target: NodeJS.WritableStream) {
    super();
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) this.target.write(chunk);
    callback();
  }
}

interface Prompter {
  ask(prompt: string, opts?: { hidden?: boolean }): Promise<string | null>;
  close(): void;
}

/** Line-buffered prompts; a hidden prompt mutes readline's echo so the key never reaches the screen. */
function createPrompter(io: SetupIO): Prompter {
  const output = new MutableOutput(io.output);
  const terminal = Boolean((io.input as { isTTY?: boolean }).isTTY) && io.stdoutIsTTY;
  const rl = readline.createInterface({ input: io.input, output, terminal, historySize: 0 });
  rl.setPrompt("");
  const lines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()?.(null);
  });
  rl.on("SIGINT", () => rl.close());
  return {
    async ask(prompt, opts = {}) {
      if (closed) io.output.write(prompt);
      else {
        rl.setPrompt(prompt);
        rl.prompt();
      }
      let line: string | null;
      if (lines.length > 0) line = lines.shift() ?? null;
      else if (closed) line = null;
      else {
        output.muted = opts.hidden === true;
        line = await new Promise<string | null>((resolve) => waiters.push(resolve));
        output.muted = false;
      }
      rl.setPrompt("");
      if (opts.hidden || line === null) io.output.write("\n");
      return line;
    },
    close() {
      rl.close();
    },
  };
}

function yes(answer: string | null, byDefault: boolean): boolean {
  const value = (answer ?? "").trim().toLowerCase();
  if (value === "") return answer === null ? false : byDefault;
  if (["y", "yes", "是", "好", "同意"].includes(value)) return true;
  if (["n", "no", "否", "不", "不要"].includes(value)) return false;
  return false;
}

function introLines(checkoutRoot: string): string[] {
  const c2c = `node "${path.join(checkoutRoot, "bin", "c2c.js")}"`;
  return [
    "C2C 智能切换（TypeSafe Jev）设置",
    "",
    "开启后，C2C 会在几个节点自动判断：任务由 Codex 自己做，还是请 ChatGPT（网页版）参与，以及何时切回 Codex。",
    `判断时可能会把下面这些内容发给 TypeSafe（固定地址 ${TYPESAFE_BASE_URL}）：`,
    "",
    "  · 接到新的编码请求时：你的这条请求（去掉代码块并脱敏，最多 1500 字）",
    "  · 同一命令第 2 次失败起：命令（脱敏，≤200 字）、错误行（脱敏，≤40 行 / 2000 字；可能包含报错里出现的文件路径、主机名和出错的那几行源码）",
    "  · ChatGPT 回复 DONE 并列出后续小改动时：这些条目（最多 12 条，每条 ≤300 字，去掉长代码并脱敏；条目里写到的文件名/路径会保留）",
    "  · 改完是否需要复核：不发送任何内容（本地规则判断）",
    "",
    "从不发送：完整文件内容、diff、完整日志、工作区信息、checkpoint 数据（家目录里的用户名会替换成 [user]）。",
    "请求里含私钥，或你说了「保密 / 不要上传」时，不会发送任何内容。",
    "",
    "TypeSafe 数据条款（摘要）：不会用你的输入训练模型；数据保留「合理必要的时间」，没有固定期限；零数据保留只对企业客户提供。",
    "",
    `Key 和同意记录保存在：${secretsFile()}`,
    "（目录权限 0700、文件 0600，位于 Codex 沙箱可写目录之外；Key 不会进入聊天或日志。）",
    `随时可以关闭：${c2c} route prefs set --mode off`,
    "",
  ];
}

function writeLines(io: SetupIO, lines: string[]): void {
  io.output.write(`${lines.join("\n")}\n`);
}

async function runEnable(io: SetupIO, checkoutRoot: string, prompter: Prompter): Promise<number> {
  writeLines(io, introLines(checkoutRoot));
  if (!yes(await prompter.ask("同意并启用智能切换？[y/N] "), false)) {
    writeLines(io, ["已取消，没有做任何更改。"]);
    return 0;
  }

  const answer = await prompter.ask("TypeSafe API Key（输入时不显示；直接回车＝使用环境变量 TYPESAFE_API_KEY）：", {
    hidden: true,
  });
  if (answer === null) {
    writeLines(io, ["已取消，没有做任何更改。"]);
    return 1;
  }
  const typed = answer.trim();
  let resolved: ResolvedKey;
  if (typed !== "") {
    if (!KEY_RE.test(typed)) {
      writeLines(io, ["✗ Key 格式不对（应为 8–512 个可见字符，不含空格）。没有做任何更改。"]);
      return 1;
    }
    resolved = { key: typed, source: "file", fingerprint: fingerprintKey(typed) };
  } else {
    const envKey = io.env.TYPESAFE_API_KEY?.trim() ?? "";
    if (!KEY_RE.test(envKey)) {
      writeLines(io, ["✗ 没有输入 Key，环境变量 TYPESAFE_API_KEY 也没有设置。没有做任何更改。"]);
      return 1;
    }
    resolved = { key: envKey, source: "env", fingerprint: fingerprintKey(envKey) };
    writeLines(io, ["将使用环境变量 TYPESAFE_API_KEY（只保存它的指纹；以后换了 Key 需要重新运行 setup）。"]);
  }

  const model = readRouterPrefs().model;
  resetBreaker();
  writeLines(io, ["正在测试连接…"]);
  const probe = await probeJev({ model, budgetMs: 5000 }, { key: resolved, env: io.env, fetch: io.fetch });
  if (probe.ok) writeLines(io, [`✓ 已连通 TypeSafe（${model}，${probe.latencyMs} ms）`]);
  else writeLines(io, [`✗ 连接测试失败：${PROBE_ERROR_ZH[probe.error]}。设置仍会保存；连不上时会自动改用本地规则。`]);

  const secrets: RouterSecrets = {
    v: 1,
    consent: { version: CONSENT_VERSION, acceptedAt: new Date().toISOString() },
    keySource: resolved.source,
    fingerprint: resolved.fingerprint,
  };
  if (resolved.source === "file") secrets.apiKey = resolved.key;
  try {
    writeRouterSecrets(secrets);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
    writeLines(io, [`✗ 无法保存设置（${code}）。智能切换保持关闭。`]);
    return 1;
  }
  const prefs = mergeRouterPrefs({ mode: "auto" });
  if (prefs.prefs.mode !== "auto" || prefs.warning) {
    writeLines(io, ["✗ Key 已保存，但无法开启智能切换（router.json 写入失败）。"]);
    return 1;
  }
  writeLines(io, [`✓ 已保存（Key 指纹 ${resolved.fingerprint.slice(0, 8)}），智能切换已开启。`]);

  const skillDir = gateSkillDir(io.env, io.homedir);
  if (yes(await prompter.ask(`安装 c2c-router 技能到 ${skillDir}？[Y/n] `), true)) {
    try {
      const result = installGateSkill(checkoutRoot, io.env, io.homedir);
      if (result.installed) writeLines(io, [`✓ 已安装：${result.path}`]);
      else writeLines(io, ["✗ 没有找到 router-skill/SKILL.md，已跳过技能安装。"]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
      writeLines(io, [`✗ 技能安装失败（${code}）。`]);
    }
  }
  const c2c = `node "${path.join(checkoutRoot, "bin", "c2c.js")}"`;
  writeLines(io, [
    "",
    `关闭：${c2c} route prefs set --mode off`,
    `彻底移除 Key：${c2c} route setup --remove`,
  ]);
  return 0;
}

async function runRemove(io: SetupIO, prompter: Prompter): Promise<number> {
  let removed = false;
  resetBreaker();
  try {
    removed = removeRouterSecrets();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
    writeLines(io, [`✗ 无法删除 Key 文件（${code}）：${secretsFile()}`]);
  }
  const prefs = mergeRouterPrefs({ mode: "off" });
  writeLines(io, [
    removed ? "✓ 已删除 TypeSafe Key 和同意记录。" : "没有找到已保存的 Key。",
    prefs.warning ? "✗ 无法写入 router.json；没有 Key 和同意记录时智能切换也不会运行。" : "✓ 智能切换已关闭。",
  ]);
  const skillDir = gateSkillDir(io.env, io.homedir);
  if (fs.existsSync(skillDir) && yes(await prompter.ask(`同时删除 c2c-router 技能（${skillDir}）？[Y/n] `), true)) {
    try {
      removeGateSkill(io.env, io.homedir);
      writeLines(io, ["✓ 已删除 c2c-router 技能。"]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
      writeLines(io, [`✗ 删除技能失败（${code}）。`]);
    }
  }
  return 0;
}

/**
 * `c2c route setup [--remove]`, run by the user in their own terminal (never
 * by Codex). Returns the process exit code. Never prints the key.
 */
export async function runSetup(opts: SetupOptions): Promise<number> {
  const io: SetupIO = { ...defaultIO(), ...opts.io };
  if (setupRefusalReason(io) !== null) {
    writeLines(io, [SETUP_REFUSAL]);
    return 1;
  }
  const checkoutRoot = path.resolve(opts.checkoutRoot);
  const prompter = createPrompter(io);
  try {
    return opts.remove ? await runRemove(io, prompter) : await runEnable(io, checkoutRoot, prompter);
  } finally {
    prompter.close();
  }
}
