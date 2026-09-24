import { afterEach, describe, expect, it } from "vitest";
import { sanitizeExecutionOutput, MAX_OUTPUT_LINES } from "../src/execution/sanitize.js";
import { listExecutionOutputs, readExecutionOutput, saveExecutionOutput } from "../src/execution/output.js";
import { cleanup, isolateStateDir } from "./helpers.js";

describe("sanitizeExecutionOutput", () => {
  it("redacts bearer tokens and pairing-code shaped strings", () => {
    const result = sanitizeExecutionOutput(
      "Authorization: Bearer c2c_at_abcdefghijklmnopqrstuv\ncode ABCD-EFGH failed"
    );
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.text).not.toMatch(/c2c_at_/);
      expect(result.text).toContain("[REDACTED]");
      expect(result.text).not.toContain("ABCD-EFGH");
    }
  });

  it("rejects private keys entirely", () => {
    const result = sanitizeExecutionOutput("oops\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("private_key");
  });

  it("rejects PGP private key blocks", () => {
    const result = sanitizeExecutionOutput("-----BEGIN PGP PRIVATE KEY BLOCK-----\nversion\n-----END PGP PRIVATE KEY BLOCK-----");
    expect(result.allowed).toBe(false);
  });

  it("redacts home paths", () => {
    const result = sanitizeExecutionOutput("wrote /Users/alice/proj/src/a.ts");
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.text).not.toContain("/Users/alice");
      expect(result.text).toContain("/Users/[user]");
    }
  });

  it("redacts the backported credential patterns", () => {
    const cases: Array<[string, string]> = [
      ["key sk-proj-AbCdEf1234567890GhIjKlMnOp_qr-99 bad", "AbCdEf1234567890"],
      ["key sk-ant-api03-abcDEF123456ghiJKL789012mno bad", "abcDEF123456"],
      ["stripe sk_" + "live_51H8abcdEFGHijklMNOPqrst", "51H8abcd"],
      ["stripe rk_" + "test_4eC39HqLyjWDarjtT1zdp7dc", "4eC39HqL"],
      ["gitlab glp" + "at-AbCdEfGhIjKlMnOpQrSt12", "AbCdEfGhIjKl"],
      ["npm npm" + "_abcdefghijklmnopqrstuvwxyz0123456789", "npm_abcdef"],
      ["slack xa" + "pp-1-A0123456789-1234567890123-abcdef0123", "A0123456789"],
      ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N", "dozjgNryP4J3"],
      ["connect postgres://admin:S3cr3tPass@db.example.com:5432/app", "S3cr3tPass"],
      ['body {"password": "hunter2hunter2"}', "hunter2"],
      ['{"client_secret":"abc-123"}', "abc-123"],
      ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
      ["GITHUB_TOKEN: gho_16C7e42F292c6912E7710c838347Ae178B4a", "gho_16C7e42F"],
    ];
    for (const [raw, secret] of cases) {
      const result = sanitizeExecutionOutput(raw);
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.text, raw).not.toContain(secret);
        expect(result.text, raw).toContain("[REDACTED]");
      }
    }
  });

  it("keeps the prefix and host around redacted values", () => {
    const check = (raw: string, expected: string) => {
      const result = sanitizeExecutionOutput(raw);
      expect(result.allowed && result.text).toBe(expected);
    };
    check("postgres://admin:S3cr3tPass@db.example.com/app", "postgres://admin:[REDACTED]@db.example.com/app");
    check('{"password": "hunter2hunter2", "user": "bob"}', '{"password": "[REDACTED]", "user": "bob"}');
    check("DB_PASSWORD=hunter2 next", "DB_PASSWORD=[REDACTED] next");
    check("stripe sk_" + "live_51H8abcdEFGHijklMNOPqrst end", "stripe [REDACTED] end");
  });

  it("keeps loopback IPs, git hashes and test status lines readable", () => {
    const raw = [
      "listen EADDRINUSE: address already in use 127.0.0.1:3000",
      "HEAD is now at 3f786850e387550fdab836ed7e6dc881de23001b fix parser",
      "--- PASS: TestParse (0.00s)",
      "--- FAIL: TestFormat (0.01s)",
      "PASSED: 12 KEY: name TOKENS: 3",
    ].join("\n");
    const result = sanitizeExecutionOutput(raw);
    expect(result).toEqual({ allowed: true, text: raw, truncated: false });
  });

  it("leaves emails and non-loopback IPs to the third-party sanitizer", () => {
    const raw = "Author: dev@example.com, host 10.1.2.3";
    const result = sanitizeExecutionOutput(raw);
    expect(result.allowed && result.text).toBe(raw);
  });

  it("truncates giant logs", () => {
    const raw = Array.from({ length: MAX_OUTPUT_LINES + 50 }, (_, i) => `line ${i}`).join("\n");
    const result = sanitizeExecutionOutput(raw);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.truncated).toBe(true);
      expect(result.text.split("\n").length).toBeLessThanOrEqual(MAX_OUTPUT_LINES + 2);
    }
  });
});

describe("execution output store", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("stores readable output and hides restricted bodies", () => {
    dirs.push(isolateStateDir());
    const okItem = saveExecutionOutput("ws1", {
      command: "pnpm test",
      raw: "2 failed\nAssertionError: expected 1 to be 2",
      exitCode: 1,
      taskId: "c2c_aa",
      iteration: 3,
    });
    expect(okItem.allowed).toBe(true);
    const listed = listExecutionOutputs("ws1");
    expect(listed.some((item) => item.id === okItem.id && item.allowed)).toBe(true);
    const read = readExecutionOutput("ws1", okItem.id);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.text).toContain("AssertionError");

    const blocked = saveExecutionOutput("ws1", {
      command: "cat key",
      raw: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
      exitCode: 0,
    });
    expect(blocked.allowed).toBe(false);
    const denied = readExecutionOutput("ws1", blocked.id);
    expect(denied).toEqual({ ok: false, error: "OUTPUT_RESTRICTED" });
  });

  it("redacts token-shaped text in the stored command", () => {
    dirs.push(isolateStateDir());
    const item = saveExecutionOutput("ws1", {
      command: "curl -H Bearer c2c_at_abcdefghijklmnopqrstuv",
      raw: "ok",
      exitCode: 0,
    });
    expect(item.command).not.toMatch(/c2c_at_/);
    expect(item.command).toContain("[REDACTED]");
  });
});
