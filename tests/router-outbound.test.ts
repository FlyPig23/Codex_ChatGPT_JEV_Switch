import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sanitizeExecutionOutput } from "../src/execution/sanitize.js";
import {
  OUTBOUND_CAPS,
  OUTBOUND_SCHEMAS,
  OutboundViolationError,
  assertOutbound,
  sanitizeForThirdParty,
  stripCode,
  type OutboundKind,
  type OutboundPoint,
} from "../src/router/outbound.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const KINDS: OutboundKind[] = ["request", "request_en", "goal", "command", "error_lines", "followup"];
const CONFIGURED_KEY = "ts.live.Qx7.mNp.4.wRt";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const SECRET_CORPUS: Array<{ name: string; text: string; leaks: string[] }> = [
  {
    name: "sk-proj- key",
    text: "OPENAI key sk-proj-AbCdEf1234567890GhIjKlMnOpQrStUv_wxyz-9876 was rejected",
    leaks: ["sk-proj-", "AbCdEf1234567890", "wxyz-9876"],
  },
  {
    name: "sk-ant-api03- key",
    text: "using sk-ant-api03-abcDEF123456ghiJKL789012mnoPQR345678stuVWX-yz_AA now",
    leaks: ["sk-ant", "abcDEF123456", "stuVWX"],
  },
  { name: "sk_live_ key", text: "stripe sk_" + "live_51H8abcdEFGHijklMNOPqrst failed", leaks: ["sk_live", "51H8abcd"] },
  { name: "rk_test_ key", text: "restricted rk_" + "test_4eC39HqLyjWDarjtT1zdp7dc", leaks: ["rk_test", "4eC39HqL"] },
  {
    name: "postgres URL userinfo",
    text: "connect postgres://admin:S3cr3tPass@db.internal.example.com:5432/app failed",
    leaks: ["S3cr3tPass"],
  },
  { name: "quoted JSON password", text: 'body {"password": "hunter2hunter2", "user": "bob"}', leaks: ["hunter2"] },
  { name: "quoted JSON api_key", text: '{"api_key":"k-9f8e7d6c5b4a"}', leaks: ["k-9f8e7d6c5b4a"] },
  {
    name: "AWS secret assignment",
    text: "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    leaks: ["wJalrXUtnFEMI", "bPxRfiCYEXAMPLEKEY"],
  },
  { name: "DB password assignment", text: "DB_PASSWORD: correct-horse-battery", leaks: ["correct-horse"] },
  {
    name: "JWT",
    text: "Bearer-less eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    leaks: ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "dozjgNryP4J3jVmNHl0w5N"],
  },
  { name: "glpat- token", text: "gitlab glp" + "at-AbCdEfGhIjKlMnOpQrSt12 expired", leaks: ["glpat-", "AbCdEfGhIjKl"] },
  { name: "npm_ token", text: "//registry.npmjs.org/:_authToken=npm" + "_abcdefghijklmnopqrstuvwxyz0123456789", leaks: ["npm_abc", "wxyz0123456789"] },
  { name: "xapp- token", text: "slack xa" + "pp-1-A0123456789-1234567890123-abcdef0123", leaks: ["xapp-", "A0123456789"] },
  { name: "email", text: "Author: Alice Smith <alice.smith@example.com>", leaks: ["alice.smith", "@example.com"] },
  { name: "public IPv4", text: "connect ECONNREFUSED 203.0.113.42:5432 and 8.8.8.8", leaks: ["203.0.113.42", "8.8.8.8"] },
  { name: "private IPv4", text: "host 10.1.2.3 unreachable", leaks: ["10.1.2.3"] },
  {
    name: "40-char hex string",
    text: "token 3f786850e387550fdab836ed7e6dc881de23001b rejected",
    leaks: ["3f786850e387550fdab836ed7e6dc881de23001b", "3f786850e387"],
  },
  {
    name: "base64 blob",
    text: "secret dGhpcyBpcyBhIHNlY3JldCBrZXkgdmFsdWU9OTk5OQ== in env",
    leaks: ["dGhpcyBpcyBhIHNlY3JldCBr"],
  },
  { name: "configured TypeSafe key", text: `the key is ${CONFIGURED_KEY} ok`, leaks: [CONFIGURED_KEY, "Qx7.mNp"] },
  { name: "密码 with a full-width colon", text: "用测试账号 admin 登录复现一下，密码：Tt#2026pass", leaks: ["Tt#2026pass"] },
  { name: "密码是 X", text: "数据库密码是 Tt#2026pass，连不上了帮我看看", leaks: ["Tt#2026pass"] },
  { name: "password with a full-width colon", text: "password：Tt#2026pass", leaks: ["Tt#2026pass"] },
  { name: "short token value", text: "token: Tt2026passXyz", leaks: ["Tt2026passXyz"] },
  {
    name: "curl -u user:password",
    text: "curl -u admin:Tt2026passXyz http://localhost:3000/health && pnpm test",
    leaks: ["Tt2026passXyz"],
  },
  { name: "mysql -p<password>", text: "mysql -uroot -pTt2026passXyz app < db.sql && pnpm test", leaks: ["Tt2026passXyz"] },
  { name: "redis-cli -a <password>", text: "redis-cli -a Tt2026passXyz ping && pnpm test", leaks: ["Tt2026passXyz"] },
  { name: "--token flag", text: "vercel deploy --token Tt2026passXyz --prod", leaks: ["Tt2026passXyz"] },
];

/** §7.2 rows that are third-party only (not backported to the shared sanitizer). */
const THIRD_PARTY_ONLY = new Set([
  "email",
  "public IPv4",
  "private IPv4",
  "40-char hex string",
  "base64 blob",
  "configured TypeSafe key",
  "密码 with a full-width colon",
  "密码是 X",
  "password with a full-width colon",
  "short token value",
  "curl -u user:password",
  "mysql -p<password>",
  "redis-cli -a <password>",
  "--token flag",
]);

const PEM_BLOCKS = [
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
  "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----",
];

function sanitizedText(text: string, kind: OutboundKind, apiKey?: string): string {
  const result = sanitizeForThirdParty(text, kind, { apiKey });
  expect(result.allowed).toBe(true);
  return result.allowed ? result.text : "";
}

function expectViolation(point: OutboundPoint, state: unknown, issue: RegExp): OutboundViolationError {
  let caught: unknown;
  try {
    assertOutbound(point, state);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OutboundViolationError);
  const violation = caught as OutboundViolationError;
  expect(violation.point).toBe(point);
  expect(violation.issues.some((entry) => issue.test(entry))).toBe(true);
  return violation;
}

let tmpDirs: string[] = [];

beforeAll(() => {
  tmpDirs = [makeTmpDir("state"), makeTmpDir("keys")];
  process.env.C2C_STATE_DIR = tmpDirs[0];
  process.env.C2C_KEYS_DIR = tmpDirs[1];
});

afterAll(() => {
  for (const dir of tmpDirs) cleanup(dir);
  delete process.env.C2C_STATE_DIR;
  delete process.env.C2C_KEYS_DIR;
});

describe("stripCode", () => {
  it("replaces fenced blocks with a line count and keeps the surrounding text", () => {
    const text = "修复这个报错：\n```ts\nconst a = 1;\nconst b = a + 1;\nexport { b };\n```\n谢谢";
    expect(stripCode(text)).toBe("修复这个报错：\n[code: 3 lines]\n谢谢");
  });

  it("strips several blocks, tilde fences and single-line triple backticks", () => {
    const text = "a ```foo()``` b\n~~~\nx\ny\n~~~\nc\n```\n```\nd";
    expect(stripCode(text)).toBe("a [code: 1 lines] b\n[code: 2 lines]\nc\n[code: 0 lines]\nd");
  });

  it("treats a first line that is not a language tag as code", () => {
    expect(stripCode("```const a = 1;\nconst b = 2;\n```")).toBe("[code: 2 lines]");
  });

  it("strips an unterminated fence to the end of the text", () => {
    expect(stripCode("Fix this:\n```js\nfoo();\nbar();")).toBe("Fix this:\n[code: 2 lines]");
  });

  it("keeps short inline code and replaces inline code longer than 40 chars", () => {
    const long = "a".repeat(41);
    const exact = "b".repeat(40);
    expect(stripCode(`rename \`getUser\` to \`fetchUser\``)).toBe("rename `getUser` to `fetchUser`");
    expect(stripCode(`run \`${long}\` and \`${exact}\``)).toBe(`run [code] and \`${exact}\``);
  });

  it("is idempotent and leaves text without code alone", () => {
    const text = "Plain request with no code at all.\n第二行";
    expect(stripCode(text)).toBe(text);
    const once = stripCode("x\n```py\nprint(1)\n```\n`" + "z".repeat(50) + "`");
    expect(stripCode(once)).toBe(once);
  });
});

describe("sanitizeForThirdParty", () => {
  for (const secret of SECRET_CORPUS) {
    it(`never lets ${secret.name} survive any kind`, () => {
      for (const kind of KINDS) {
        const out = sanitizedText(secret.text, kind, CONFIGURED_KEY);
        for (const leak of secret.leaks) expect(out, `${kind}: ${out}`).not.toContain(leak);
      }
    });
  }

  it("scrubs the whole corpus from one multi-line error log", () => {
    const log = SECRET_CORPUS.map((entry, i) => `Error ${i}: ${entry.text}`).join("\n");
    const result = sanitizeForThirdParty(log, "error_lines", { apiKey: CONFIGURED_KEY });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    for (const entry of SECRET_CORPUS) {
      for (const leak of entry.leaks) expect(result.text).not.toContain(leak);
    }
    expect(result.redactions).toBeGreaterThanOrEqual(SECRET_CORPUS.length);
  });

  it("redacts secrets inside short inline code in a request", () => {
    const out = sanitizedText("用 `sk-proj-AbCdEf1234567890GhIj` 调一下接口", "request");
    expect(out).not.toContain("AbCdEf1234567890");
    expect(out).toContain("[REDACTED]");
  });

  it("only redacts the configured key literally when it is given", () => {
    const text = `key ${CONFIGURED_KEY} here`;
    expect(sanitizedText(text, "request")).toContain(CONFIGURED_KEY);
    expect(sanitizedText(text, "request", CONFIGURED_KEY)).toBe("key [REDACTED] here");
    const special = "k3y+(a|b)*[x]?";
    expect(sanitizedText(`use ${special} now`, "command", special)).toBe("use [REDACTED] now");
  });

  it("rejects private-key blocks for every kind, even inside fenced code", () => {
    for (const pem of PEM_BLOCKS) {
      for (const kind of KINDS) {
        expect(sanitizeForThirdParty(`oops\n${pem}\n`, kind)).toEqual({ allowed: false, reason: "private_key" });
      }
      expect(sanitizeForThirdParty("here:\n```\n" + pem + "\n```", "request")).toEqual({
        allowed: false,
        reason: "private_key",
      });
    }
  });

  it("backported rows are stripped by sanitizeExecutionOutput too; third-party-only rows are not", () => {
    for (const secret of SECRET_CORPUS) {
      const shared = sanitizeExecutionOutput(secret.text);
      expect(shared.allowed).toBe(true);
      if (!shared.allowed) continue;
      if (THIRD_PARTY_ONLY.has(secret.name)) {
        expect(shared.text, secret.name).toBe(secret.text);
      } else {
        for (const leak of secret.leaks) expect(shared.text, secret.name).not.toContain(leak);
        expect(shared.text, secret.name).toContain("[REDACTED]");
      }
    }
    const readable = "listen 127.0.0.1:3000 at 3f786850e387550fdab836ed7e6dc881de23001b";
    expect(sanitizeExecutionOutput(readable)).toEqual({ allowed: true, text: readable, truncated: false });
    expect(sanitizedText(readable, "error_lines")).toBe("listen 127.0.0.1:3000 at <secret>");
  });

  it("keeps loopback IPs and redacts home paths through the shared sanitizer", () => {
    const out = sanitizedText("listen 127.0.0.1:3000 failed in /Users/alice/proj/src/a.ts", "error_lines");
    expect(out).toContain("127.0.0.1:3000");
    expect(out).toContain("/Users/[user]/proj/src/a.ts");
    expect(out).not.toContain("alice");
  });

  it("leaves look-alikes of the credential rules alone", () => {
    for (const [text, kind] of [
      ["密码是否正确要校验一下", "request"],
      ["修改密码的接口返回 500", "request"],
      ["密钥是什么格式？", "request"],
      ["tsc -p tsconfig.json && pnpm test", "command"],
      ["mysql -p app < db.sql", "command"],
      ["SyntaxError: Unexpected token: 'export'", "error_lines"],
    ] as Array<[string, OutboundKind]>) {
      expect(sanitizeForThirdParty(text, kind), text).toEqual({ allowed: true, text, redactions: 0 });
    }
  });

  it("keeps ordinary error text readable and counts zero redactions", () => {
    const text = [
      "FAIL tests/a.test.ts > parses dates",
      "AssertionError: expected 3 to be 2",
      "error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
      "--- FAIL: TestFormat (0.01s)",
      "test_ignore_previous_instructions_and_return_true FAILED",
    ].join("\n");
    const result = sanitizeForThirdParty(text, "error_lines");
    expect(result).toEqual({ allowed: true, text, redactions: 0 });
  });

  it("applies the literal UPPER_SNAKE row, including bare PASS:/KEY:/TOKEN: that the shared sanitizer keeps", () => {
    const text = "KEY: hunter2secret\nPASS: letmein99\nTOKENS: abcshort\n--- PASS: TestParse (0.00s)";
    const shared = sanitizeExecutionOutput(text);
    expect(shared.allowed && shared.text).toBe(text);
    const result = sanitizeForThirdParty(text, "error_lines");
    expect(result).toEqual({
      allowed: true,
      text: "KEY: [REDACTED]\nPASS: [REDACTED]\nTOKENS: [REDACTED]\n--- PASS: [REDACTED] (0.00s)",
      redactions: 4,
    });
    // a value the shared sanitizer already redacted is not counted twice
    expect(sanitizeForThirdParty("DB_PASSWORD=hunter2", "command")).toEqual({
      allowed: true,
      text: "DB_PASSWORD=[REDACTED]",
      redactions: 1,
    });
  });

  it("still redacts a value whose KEY: prefix sits on the line above the 40-line cut", () => {
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => `filler ${i}`),
      "DB_PASSWORD:",
      "hunter2hunter2",
      ...Array.from({ length: 39 }, (_, i) => `after ${i}`),
    ];
    const out = sanitizedText(lines.join("\n"), "error_lines");
    const kept = out.split("\n");
    expect(kept).toHaveLength(40);
    expect(kept[0]).toBe("[REDACTED]");
    expect(kept[39]).toBe("after 38");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("DB_PASSWORD");
  });

  it("strips code from requests and follow-ups but not from commands or error lines", () => {
    const fenced = "look:\n```\nconst x = 1;\n```";
    expect(sanitizedText(fenced, "request")).toBe("look:\n[code: 1 lines]");
    expect(sanitizedText(fenced, "followup")).toBe("look:\n[code: 1 lines]");
    expect(sanitizedText(fenced, "goal")).toBe("look:\n[code: 1 lines]");
    expect(sanitizedText("error[E0425]: cannot find value `x` in this scope", "error_lines")).toContain("`x`");
  });

  it("normalizes CRLF and removes ANSI colour codes", () => {
    const out = sanitizedText("\u001b[31mFAIL\u001b[39m a.test.ts\r\nExpected 1\r\n", "error_lines");
    expect(out).toBe("FAIL a.test.ts\nExpected 1");
  });

  it("caps each kind to its limit", () => {
    const words = Array.from({ length: 3000 }, (_, i) => `word${i % 10}x`).join(" ");
    for (const kind of KINDS) {
      const out = sanitizedText(words, kind);
      expect(out.length, kind).toBeLessThanOrEqual(OUTBOUND_CAPS[kind].chars);
      expect(out.length, kind).toBeGreaterThan(OUTBOUND_CAPS[kind].chars - 20);
    }
    expect(OUTBOUND_CAPS.request.chars).toBe(1500);
    expect(OUTBOUND_CAPS.goal.chars).toBe(300);
    expect(OUTBOUND_CAPS.command.chars).toBe(200);
    expect(OUTBOUND_CAPS.followup.chars).toBe(300);
    expect(OUTBOUND_CAPS.error_lines).toEqual({ chars: 2000, lines: 40 });
  });

  it("keeps the head of a request", () => {
    const out = sanitizedText(`开头 ${"内容".repeat(2000)} 结尾`, "request");
    expect(out.startsWith("开头")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("结尾");
  });

  it("keeps the last 40 lines of error output without the upstream truncation marker", () => {
    const raw = Array.from({ length: 500 }, (_, i) => `line ${i} failed`).join("\n");
    const out = sanitizedText(raw, "error_lines");
    const lines = out.split("\n");
    expect(lines.length).toBe(40);
    expect(lines[0]).toBe("line 460 failed");
    expect(lines[39]).toBe("line 499 failed");
    expect(out).not.toContain("truncated");
  });

  it("keeps the tail of long error lines within 2000 chars", () => {
    const raw = Array.from({ length: 30 }, (_, i) => `E${i} ${"x".repeat(150)}`).join("\n");
    const out = sanitizedText(raw, "error_lines");
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.startsWith("…")).toBe(true);
    expect(out).toContain("E29 ");
    expect(out).not.toContain("E0 ");
  });

  it("never splits a surrogate pair when cutting", () => {
    const emoji = "😀".repeat(3000);
    for (const kind of KINDS) {
      for (const text of [emoji, `a${emoji}`]) {
        const out = sanitizedText(text, kind);
        expect(out.length, kind).toBeLessThanOrEqual(OUTBOUND_CAPS[kind].chars);
        expect(LONE_SURROGATE.test(out), kind).toBe(false);
        expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
      }
    }
  });

  it("produces state that always passes the outbound schema", () => {
    const huge = `${"需要 ".repeat(1000)}\n${"x".repeat(9000)}\n${Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n")}`;
    const text = (kind: OutboundKind): string => sanitizedText(huge, kind, CONFIGURED_KEY);
    expect(() => assertOutbound("intake", { request: text("request"), request_en: text("request_en") })).not.toThrow();
    expect(() =>
      assertOutbound("failure", { command: text("command"), error_lines: text("error_lines") })
    ).not.toThrow();
    expect(() => assertOutbound("reply", { followups: Array.from({ length: 12 }, () => text("followup")) })).not.toThrow();
  });
});

describe("assertOutbound", () => {
  it("accepts valid state for each point and returns it", () => {
    expect(assertOutbound("intake", { request: "把保存按钮改成蓝色" })).toEqual({ request: "把保存按钮改成蓝色" });
    expect(assertOutbound("intake", { request: "改颜色", request_en: "change the colour" })).toEqual({
      request: "改颜色",
      request_en: "change the colour",
    });
    const failure = { command: "pnpm test", error_lines: "Expected 1\nReceived 2" };
    expect(assertOutbound("failure", failure)).toEqual(failure);
    expect(assertOutbound("reply", { followups: ["rename tmp", "fix typo"] })).toEqual({
      followups: ["rename tmp", "fix typo"],
    });
  });

  it("rejects unknown keys at every point", () => {
    expectViolation("intake", { request: "hi", repo: "/Users/alice/secret" }, /unrecognized_keys/);
    expectViolation(
      "failure",
      { command: "c", error_lines: "e", diff: "--- a/x\n+++ b/x" },
      /unrecognized_keys/
    );
    // neither failure question reads the goal, so it is not part of the failure payload
    expectViolation("failure", { goal: "fix login", command: "c", error_lines: "e" }, /unrecognized_keys/);
    expectViolation("reply", { followups: ["a"], paths: ["src/auth.ts"] }, /unrecognized_keys/);
  });

  it("rejects oversized strings", () => {
    expectViolation("intake", { request: "a".repeat(1501) }, /^request:too_big$/);
    expectViolation("intake", { request: "a", request_en: "b".repeat(201) }, /^request_en:too_big$/);
    expectViolation("failure", { command: "c".repeat(201), error_lines: "e" }, /^command:too_big$/);
    expectViolation("failure", { command: "c", error_lines: "e".repeat(2001) }, /^error_lines:too_big$/);
    expectViolation("reply", { followups: ["ok", "f".repeat(301)] }, /^followups\.1:too_big$/);
  });

  it("rejects too many error lines and too many follow-ups", () => {
    const lines = Array.from({ length: 41 }, (_, i) => `e${i}`).join("\n");
    expectViolation("failure", { command: "c", error_lines: lines }, /^error_lines:too_many_lines$/);
    expectViolation("reply", { followups: Array.from({ length: 13 }, (_, i) => `item ${i}`) }, /^followups:too_big$/);
    expectViolation("reply", { followups: [] }, /^followups:too_small$/);
  });

  it("rejects missing fields, wrong types, empty requests and private keys", () => {
    expectViolation("intake", {}, /^request:invalid_type$/);
    expectViolation("intake", { request: "   " }, /^request:empty$/);
    expectViolation("intake", "just a string", /^\(root\):invalid_type$/);
    expectViolation("failure", { command: ["pnpm", "test"], error_lines: "e" }, /^command:invalid_type$/);
    expectViolation("reply", { followups: [{ text: "nested" }] }, /^followups\.0:invalid_type$/);
    expectViolation("intake", { request: PEM_BLOCKS[0] }, /^request:private_key$/);
  });

  it("never puts the rejected text in the error", () => {
    const canary = "CANARY_7f3a_do_not_leak";
    const violation = expectViolation("intake", { request: canary.repeat(100), [canary]: canary }, /too_big/);
    expect(violation.message).not.toContain(canary);
    expect(violation.issues.join(" ")).not.toContain(canary);
  });

  it("uses strict zod object schemas", () => {
    expect(OUTBOUND_SCHEMAS.intake.safeParse({ request: "x", extra: 1 }).success).toBe(false);
    expect(OUTBOUND_SCHEMAS.failure.safeParse({ command: "", error_lines: "" }).success).toBe(true);
    expect(OUTBOUND_SCHEMAS.failure.safeParse({ goal: "", command: "", error_lines: "" }).success).toBe(false);
    expect(OUTBOUND_SCHEMAS.reply.safeParse({ followups: ["x"] }).success).toBe(true);
  });
});
