import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeState } from "../src/bridge/runtime.js";
import { writeLastEndpoint, type LastEndpoint } from "../src/config/endpoint.js";
import { CATEGORY_LABEL_ZH } from "../src/router/messages.js";
import { HIGH_RISK_PATH_CATEGORIES } from "../src/router/policy.js";
import {
  HIGH_RISK_CATEGORIES,
  MEDIUM_RISK_CATEGORIES,
  NEEDS_USER_RE,
  activeCheckpointView,
  captureBaseline,
  classifyPath,
  classifyPaths,
  commandKey,
  detectExplicitRoute,
  detectNoEgress,
  errorSignature,
  extractErrorLines,
  followupIsRisky,
  followupSectionRisky,
  analyzeFollowups,
  isWarmChat,
  isWorkspaceBusy,
  matchesNeedsUser,
  parseFollowups,
  pathRisk,
  probeConnection,
  sizeBucket,
  taskChanges,
  type ConnectionDeps,
} from "../src/router/signals.js";
import type { Connection, PathCategory, SizeBucket } from "../src/router/types.js";
import { writeSession, type SavedSession } from "../src/session/state.js";
import { writeTunnelState, type TunnelState } from "../src/tunnel/state.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const savedEnv = {
  C2C_STATE_DIR: process.env.C2C_STATE_DIR,
  C2C_KEYS_DIR: process.env.C2C_KEYS_DIR,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
  GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
};
const dirs: string[] = [];
let stateDir = "";

function restoreEnv(name: keyof typeof savedEnv): void {
  const value = savedEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  stateDir = makeTmpDir("signals-state");
  const keys = makeTmpDir("signals-keys");
  dirs.push(stateDir, keys);
  process.env.C2C_STATE_DIR = stateDir;
  process.env.C2C_KEYS_DIR = keys;
  // Keep the user's global git config (excludes, diff drivers) out of the git-backed tests.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
});

afterAll(() => {
  for (const name of Object.keys(savedEnv) as (keyof typeof savedEnv)[]) restoreEnv(name);
  for (const dir of dirs) cleanup(dir);
});

// ---------------------------------------------------------------- explicit route (§3.6)

type Explicit = "chatgpt" | "codex" | null;
const EXPLICIT_CASES: ReadonlyArray<readonly [string, Explicit, "zh" | "en"]> = [
  // §3.6 table
  ["修复网页版的登录 bug", null, "zh"],
  ["直接改成蓝色", null, "zh"],
  ["直接改成用 Redis 做缓存", null, "zh"],
  ["ChatGPT 上次的方案有 bug，你直接修", null, "zh"],
  ["让 ChatGPT 先规划一下", "chatgpt", "zh"],
  ["用 GPT 看看这个方案", "chatgpt", "zh"],
  ["别问 ChatGPT，自己改", "codex", "zh"],
  ["不用 GPT 了", "codex", "zh"],
  // mentions, not requests
  ["网页版的 ChatGPT 按钮坏了，修一下", null, "zh"],
  ["上次让 ChatGPT 看过的方案有问题，直接修", null, "zh"],
  ["在后端调用 GPT 来生成商品描述", null, "zh"],
  ["把模型从 gpt-4 换成 gpt-4o", null, "zh"],
  ["帮我写个脚本，用 GPT-4 API 翻译文案", null, "zh"],
  ["解释一下 Claude 和 GPT 的区别", null, "zh"],
  ["给登录页加上 ChatGPT 风格的聊天气泡", null, "zh"],
  ["修复 chatgpt.ts 里的类型错误", null, "zh"],
  ["顺手把这个 bug 修一下", null, "zh"],
  // requests for ChatGPT
  ["用ChatGPT规划", "chatgpt", "zh"],
  ["请 ChatGPT 帮忙设计一下缓存层", "chatgpt", "zh"],
  ["交给网页版 ChatGPT 来规划这个重构", "chatgpt", "zh"],
  ["问问 GPT 想个方案", "chatgpt", "zh"],
  ["使用 Codex with ChatGPT 修复支付回调", "chatgpt", "zh"],
  ["找 ChatGPT 复核一下这次改动", "chatgpt", "zh"],
  ["这个需求先让chatgpt设计", "chatgpt", "zh"],
  ["要不要让 ChatGPT 看看？", "chatgpt", "zh"],
  ["让ＣｈａｔＧＰＴ规划", "chatgpt", "zh"],
  // codex only (negation wins)
  ["这次不用 chatgpt", "codex", "zh"],
  ["不要让 ChatGPT 参与，你直接做", "codex", "zh"],
  ["先别找 GPT，自己试试", "codex", "zh"],
  ["无需 ChatGPT，直接改", "codex", "zh"],
  ["这个小改动不需要 ChatGPT", "codex", "zh"],
  ["别再麻烦 ChatGPT 了", "codex", "zh"],
  ["不用让 ChatGPT 复核了", "codex", "zh"],
  ["这次不找 ChatGPT，你自己搞定", "codex", "zh"],
  ["这个项目的代码保密，别找 ChatGPT", "codex", "zh"],
  // English
  ["Let ChatGPT plan the migration first", "chatgpt", "en"],
  ["ask chatgpt to review this diff", "chatgpt", "en"],
  ["Use ChatGPT to help design the schema", "chatgpt", "en"],
  ["don't use ChatGPT for this one", "codex", "en"],
  ["Do not ask ChatGPT, just fix it", "codex", "en"],
  ["Fix it without ChatGPT", "codex", "en"],
  ["No need to involve ChatGPT", "codex", "en"],
  ["Fix the ChatGPT export button", null, "en"],
  ["Add an OpenAI GPT client wrapper", null, "en"],
  ["The ChatGPT review last time missed a bug; fix it", null, "en"],
];

describe("detectExplicitRoute", () => {
  it("corpus has at least 30 cases and at least 60% Chinese", () => {
    expect(EXPLICIT_CASES.length).toBeGreaterThanOrEqual(30);
    const zh = EXPLICIT_CASES.filter(([, , lang]) => lang === "zh").length;
    expect(zh / EXPLICIT_CASES.length).toBeGreaterThanOrEqual(0.6);
  });

  it.each(EXPLICIT_CASES)("%s → %s", (input, expected) => {
    expect(detectExplicitRoute(input)).toBe(expected);
  });

  it("ignores text inside fenced code blocks and empty input", () => {
    expect(detectExplicitRoute("修一下这个函数\n```ts\n// 让 ChatGPT 先规划\nconst x = 1;\n```")).toBeNull();
    expect(detectExplicitRoute("")).toBeNull();
    expect(detectExplicitRoute("   ")).toBeNull();
  });
});

const NO_EGRESS_CASES: ReadonlyArray<readonly [string, boolean]> = [
  ["这段代码保密，别外传", true],
  ["公司机密项目，修一下登录", true],
  ["不要上传任何代码", true],
  ["别上传到第三方", true],
  ["代码不能外传，帮我重构", true],
  ["This repo is confidential", true],
  ["don't upload the logs anywhere", true],
  ["We're under NDA, fix the build", true],
  ["修复上传文件失败的 bug", false],
  ["给上传按钮加进度条", false],
  ["Add an upload endpoint", false],
  ["修复网页版的登录 bug", false],
];

describe("detectNoEgress", () => {
  it.each(NO_EGRESS_CASES)("%s → %s", (input, expected) => {
    expect(detectNoEgress(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------- failure signals (§4.2)

const OUTPUTS: Record<string, { raw: string; mustInclude: RegExp }> = {
  vitest: {
    raw: [
      " RUN  v3.2.4 /Users/me/proj",
      "",
      " \u001b[31m❯\u001b[39m tests/math.test.ts (2 tests | 1 failed) 12ms",
      "   × add > adds numbers 5ms",
      "     → expected 3 to be 4 // Object.is equality",
      "",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
      "",
      " FAIL  tests/math.test.ts > add > adds numbers",
      "AssertionError: expected 3 to be 4 // Object.is equality",
      "",
      "- Expected",
      "+ Received",
      "",
      "- 4",
      "+ 3",
      "",
      " ❯ tests/math.test.ts:5:23",
      "      5|     expect(add(1, 2)).toBe(4);",
      "",
      " Test Files  1 failed (1)",
      "      Tests  1 failed | 1 passed (2)",
      "   Duration  301ms",
    ].join("\n"),
    mustInclude: /AssertionError: expected 3 to be 4/,
  },
  jest: {
    raw: [
      "FAIL src/sum.test.js",
      "  ● sum › adds 1 + 2 to equal 3",
      "",
      "    expect(received).toBe(expected) // Object.is equality",
      "",
      "    Expected: 3",
      "    Received: 4",
      "",
      "      at Object.toBe (src/sum.test.js:4:20)",
      "",
      "Tests:       1 failed, 1 total",
    ].join("\n"),
    mustInclude: /Expected: 3/,
  },
  tsc: {
    raw: [
      "src/index.ts:3:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
      "",
      '3 const x: number = "a";',
      "        ~",
      "",
      "Found 1 error in src/index.ts:3",
    ].join("\n"),
    mustInclude: /TS2322/,
  },
  pytest: {
    raw: [
      "============================= test session starts ==============================",
      "collected 1 item",
      "",
      "tests/test_calc.py F                                                     [100%]",
      "",
      "=================================== FAILURES ===================================",
      "__________________________________ test_add ____________________________________",
      "",
      "    def test_add():",
      ">       assert add(1, 2) == 4",
      "E       assert 3 == 4",
      "E        +  where 3 = add(1, 2)",
      "",
      "tests/test_calc.py:5: AssertionError",
      "=========================== short test summary info ============================",
      "FAILED tests/test_calc.py::test_add - assert 3 == 4",
      "============================== 1 failed in 0.02s ===============================",
    ].join("\n"),
    mustInclude: /assert 3 == 4/,
  },
  go: {
    raw: [
      "=== RUN   TestAdd",
      "--- FAIL: TestAdd (0.00s)",
      "    calc_test.go:9: Add(1, 2) = 3; want 4",
      "FAIL",
      "FAIL\texample.com/calc\t0.002s",
      "FAIL",
    ].join("\n"),
    mustInclude: /Add\(1, 2\) = 3; want 4/,
  },
  cargo: {
    raw: [
      "   Compiling calc v0.1.0 (/home/me/calc)",
      "error[E0308]: mismatched types",
      " --> src/main.rs:2:18",
      "  |",
      '2 |     let x: i32 = "a";',
      "  |            ---   ^^^ expected `i32`, found `&str`",
      "",
      "For more information about this error, try `rustc --explain E0308`.",
      'error: could not compile `calc` (bin "calc") due to 1 previous error',
    ].join("\n"),
    mustInclude: /E0308\]: mismatched types/,
  },
  npm: {
    raw: [
      "npm ERR! code E404",
      "npm ERR! 404 Not Found - GET https://registry.npmjs.org/nonexistent-pkg - Not found",
      "npm ERR! 404",
      "npm ERR! 404  'nonexistent-pkg@*' is not in this registry.",
      "",
      "npm ERR! A complete log of this run can be found in: /Users/me/.npm/_logs/debug.log",
    ].join("\n"),
    mustInclude: /code E404/,
  },
};

describe("extractErrorLines", () => {
  it.each(Object.entries(OUTPUTS))("%s output keeps the error", (_name, { raw, mustInclude }) => {
    const lines = extractErrorLines(raw);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(40);
    expect(lines.join("\n").length).toBeLessThanOrEqual(2000);
    expect(lines.some((line) => mustInclude.test(line))).toBe(true);
    expect(lines.some((line) => line.trim() === "")).toBe(false);
    expect(lines.join("\n")).not.toContain("\u001b");
  });

  it("caps long output to 40 lines / 2000 chars and keeps the tail", () => {
    const raw = Array.from({ length: 500 }, (_, i) => `error at step ${i}: something failed`).join("\n");
    const lines = extractErrorLines(raw);
    expect(lines.length).toBeLessThanOrEqual(40);
    expect(lines.join("\n").length).toBeLessThanOrEqual(2000);
    expect(lines[lines.length - 1]).toContain("step 499");
    const tight = extractErrorLines(raw, { maxLines: 5, maxChars: 100000 });
    expect(tight).toHaveLength(5);
  });

  it("falls back to the last 20 lines when nothing matches", () => {
    const raw = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const lines = extractErrorLines(raw);
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("line 30");
    expect(lines[19]).toBe("line 49");
  });

  it("keeps ±2 lines of context and de-duplicates", () => {
    const raw = ["a", "b", "c", "d", "Error: boom", "e", "f", "g", "h", "Error: boom", "i"].join("\n");
    expect(extractErrorLines(raw)).toEqual(["c", "d", "Error: boom", "e", "f", "g", "h", "i"]);
    expect(extractErrorLines("")).toEqual([]);
  });

  it("uses only the last carriage-return frame of a progress line", () => {
    const lines = extractErrorLines("progress 10%\rprogress 50%\rError: disk full\n");
    expect(lines).toEqual(["Error: disk full"]);
  });
});

describe("errorSignature", () => {
  it("is stable across line numbers, timings, paths and hashes", () => {
    const pairs: Array<[string[], string[]]> = [
      [
        ["src/a.test.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'."],
        ["/Users/other/repo/pkg/a.test.ts:99:1 - error TS2322: Type 'string' is not assignable to type 'number'."],
      ],
      [["Error: Test timed out in 5000ms."], ["Error: Test timed out in 3000ms."]],
      [
        ["TypeError: Cannot read properties of undefined (reading 'id')", "    at run (/home/a/proj/src/x.ts:10:5)"],
        ["TypeError: Cannot read properties of undefined (reading 'id')", "    at run (C:\\work\\proj\\src\\x.ts:77:9)"],
      ],
      [["segfault at 0x7ffeefbff5c8"], ["segfault at 0x7ffee1234567"]],
      [["object abc123def456 missing"], ["object fff999aaa000 missing"]],
      [["  Error:   spaced    out  "], ["error: spaced out"]],
    ];
    for (const [a, b] of pairs) expect(errorSignature(a)).toBe(errorSignature(b));
  });

  it("differs for different errors and only uses the first 5 lines", () => {
    expect(errorSignature(["Expected: 3 Received: 2"])).not.toBe(errorSignature(["Cannot find module 'zod'"]));
    expect(errorSignature(["Error: EADDRINUSE"])).not.toBe(errorSignature(["Error: ECONNRESET"]));
    const base = ["e1", "e2", "e3", "e4", "e5"];
    expect(errorSignature([...base, "tail A"])).toBe(errorSignature([...base, "tail B"]));
    expect(errorSignature(base)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("commandKey", () => {
  it.each([
    ["pnpm test src/a.test.ts", "pnpm test"],
    ["pnpm test", "pnpm test"],
    ["CI=1 pnpm test src/a.test.ts", "pnpm test"],
    ["env NODE_ENV=test npx jest src/foo.spec.ts", "npx jest"],
    ["pnpm vitest run tests/router-signals.test.ts", "pnpm vitest run"],
    ["PNPM Vitest Run", "pnpm vitest run"],
    ["npx tsc --noEmit -p tsconfig.json", "npx tsc --noemit"],
    ["cd packages/web && npm run test -- --watch=false", "npm run test"],
    ["npm test -- src/foo.test.ts", "npm test"],
    ["pnpm test 2>&1 | tee /tmp/out.txt", "pnpm test"],
    ["pytest tests/test_login.py -k auth", "pytest -k auth"],
    ["go test ./...", "go test"],
    ["cargo test --workspace", "cargo test --workspace"],
    ['vitest -t "renders the header"', "vitest -t"],
    ["", "unknown"],
  ])("%s → %s", (input, expected) => {
    expect(commandKey(input)).toBe(expected);
  });
});

describe("matchesNeedsUser", () => {
  it.each([
    [["npm ERR! 401 Unauthorized - you must be logged in"], true],
    [["Error: OPENAI_API_KEY is not set"], true],
    [["Error: EACCES: permission denied, open '/etc/hosts'"], true],
    [["fatal: could not read Username: credentials required"], true],
    [["HTTP 402 Payment Required"], true],
    [["expect(res.status).toBe(401) — received 200"], false],
    [["AssertionError: expected 403 to equal 200"], false],
    [["TypeError: x is undefined"], false],
    [["    at run (src/app.ts:401:12)"], false],
  ] as Array<[string[], boolean]>)("%j → %s", (lines, expected) => {
    expect(matchesNeedsUser(lines)).toBe(expected);
  });

  it("ignores full test-runner output for a test that asserts a 401 (vitest and jest)", () => {
    const vitest = [
      " RUN  v3.2.7 /tmp/vt401",
      "",
      " ❯ api.test.ts (1 test | 1 failed) 4ms",
      "   × GET /me > rejects a missing token 4ms",
      "     → expected 200 to be 401 // Object.is equality",
      "",
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
      "",
      " FAIL  api.test.ts > GET /me > rejects a missing token",
      "AssertionError: expected 200 to be 401 // Object.is equality",
      "",
      "\u001b[32m- Expected\u001b[39m",
      "\u001b[31m+ Received\u001b[39m",
      "",
      "\u001b[32m- 401\u001b[39m",
      "\u001b[31m+ 200\u001b[39m",
      "",
      " ❯ api.test.ts:5:24",
      "      3|   it(\"rejects a missing token\", () => {",
      "      4|     const res = { status: 200 };",
      "      5|     expect(res.status).toBe(401);",
      "       |                        ^",
      "",
      " Test Files  1 failed (1)",
      "      Tests  1 failed | 401 passed (402)",
    ].join("\n");
    expect(matchesNeedsUser(extractErrorLines(vitest))).toBe(false);
    const jest = [
      " FAIL  tests/login.test.js",
      "  ● login › rejects unauthorized users",
      "",
      "    expect(received).toBe(expected) // Object.is equality",
      "",
      "    Expected: 401",
      "    Received: 200",
      "",
      "      12 |   const res = await request(app).get('/me');",
      "    > 13 |   expect(res.status).toBe(401);",
      "",
      "Tests:       1 failed, 401 passed, 402 total",
    ].join("\n");
    expect(matchesNeedsUser(extractErrorLines(jest))).toBe(false);
    const goTest = "--- FAIL: TestUnauthorized (0.00s)\n    api_test.go:22: got 200, want 401\nFAIL";
    expect(matchesNeedsUser(extractErrorLines(goTest))).toBe(false);
    // a real registry 401 in the same run still counts
    expect(matchesNeedsUser(extractErrorLines(`${jest}\nnpm ERR! 401 Unauthorized - you must be logged in`))).toBe(true);
  });

  it("accepts a string and re-exports the shared regex", () => {
    expect(matchesNeedsUser("ok\nquota exceeded for this key")).toBe(true);
    expect(NEEDS_USER_RE.test("forbidden")).toBe(true);
  });
});

// ---------------------------------------------------------------- path categories and size (§4.3)

const PATH_CASES: ReadonlyArray<readonly [string, PathCategory]> = [
  ["src/auth/login.ts", "auth_security"],
  ["src/oauth/callback.ts", "auth_security"],
  ["lib/session.ts", "auth_security"],
  ["app/security/csp.ts", "auth_security"],
  ["src/crypto/hash.ts", "auth_security"],
  ["src/permissions.ts", "auth_security"],
  ["server/acl/rules.go", "auth_security"],
  ["utils/jwt.ts", "auth_security"],
  ["src/components/LoginForm.tsx", "auth_security"],
  ["src/services/AuthService.ts", "auth_security"],
  ["src/hooks/useAuth.ts", "auth_security"],
  ["src/password-reset.ts", "auth_security"],
  ["src/oauth2/client.ts", "auth_security"],
  ["config/secrets.yaml", "auth_security"],
  ["src\\auth\\login.ts", "auth_security"],
  ["tests/auth/login.test.ts", "auth_security"],
  ["src/payments/refund.ts", "payments"],
  ["app/billing/invoice.rb", "payments"],
  ["web/checkout.tsx", "payments"],
  ["lib/stripeClient.ts", "payments"],
  ["db/migrations/001_init.sql", "data_migration"],
  ["prisma/schema.prisma", "data_migration"],
  ["alembic/versions/abc.py", "data_migration"],
  ["src/db/schema.ts", "data_migration"],
  ["scripts/migrate.ts", "data_migration"],
  ["queries/report.sql", "data_migration"],
  [".github/workflows/ci.yml", "ci_pipeline"],
  [".gitlab-ci.yml", "ci_pipeline"],
  [".circleci/config.yml", "ci_pipeline"],
  ["azure-pipelines.yml", "ci_pipeline"],
  ["Jenkinsfile", "ci_pipeline"],
  ["AGENTS.md", "agent_config"],
  ["CLAUDE.md", "agent_config"],
  [".c2c.json", "agent_config"],
  [".c2cignore", "agent_config"],
  [".codex/config.toml", "agent_config"],
  [".claude/settings.json", "agent_config"],
  ["skill/SKILL.md", "agent_config"],
  ["router-skill/SKILL.md", "agent_config"],
  ["scripts/postinstall.js", "install_scripts"],
  ["install.sh", "install_scripts"],
  ["preinstall.ts", "install_scripts"],
  ["package.json", "deps_manifest"],
  ["packages/web/package.json", "deps_manifest"],
  ["pnpm-lock.yaml", "deps_manifest"],
  ["yarn.lock", "deps_manifest"],
  ["requirements-dev.txt", "deps_manifest"],
  ["pyproject.toml", "deps_manifest"],
  ["go.mod", "deps_manifest"],
  ["Cargo.toml", "deps_manifest"],
  ["Gemfile", "deps_manifest"],
  ["Dockerfile", "infra"],
  ["Dockerfile.dev", "infra"],
  ["docker-compose.yml", "infra"],
  ["docker-compose.prod.yaml", "infra"],
  ["infra/main.tf", "infra"],
  ["k8s/deployment.yaml", "infra"],
  ["helm/values.yaml", "infra"],
  ["tests/router.test.ts", "tests"],
  ["src/utils/format.spec.ts", "tests"],
  ["__tests__/App.tsx", "tests"],
  ["tests/test_api.py", "tests"],
  ["pkg/calc_test.go", "tests"],
  ["e2e/home.cy.ts", "tests"],
  ["README.md", "docs"],
  ["docs/guide.md", "docs"],
  ["docs/images/flow.png", "docs"],
  ["CHANGELOG.md", "docs"],
  ["LICENSE", "docs"],
  ["tsconfig.json", "config"],
  [".eslintrc.json", "config"],
  ["vite.config.ts", "config"],
  [".prettierrc", "config"],
  ["config/app.json", "config"],
  [".editorconfig", "config"],
  [".gitignore", "config"],
  ["settings.toml", "config"],
  ["src/index.ts", "other"],
  ["./src/index.ts", "other"],
  ["src/components/Button.tsx", "other"],
  ["src/author.ts", "other"],
  ["src/styles/tokens.css", "other"],
  ["", "other"],
];

describe("classifyPath", () => {
  it("has at least 40 cases", () => {
    expect(PATH_CASES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(PATH_CASES)("%s → %s", (input, expected) => {
    expect(classifyPath(input)).toBe(expected);
  });

  it("high-risk set matches the policy list and the Chinese labels", () => {
    expect([...HIGH_RISK_CATEGORIES].sort()).toEqual([...HIGH_RISK_PATH_CATEGORIES].sort());
    expect([...HIGH_RISK_CATEGORIES].sort()).toEqual(Object.keys(CATEGORY_LABEL_ZH).sort());
    expect([...MEDIUM_RISK_CATEGORIES].sort()).toEqual(["deps_manifest", "infra"]);
    expect(pathRisk("payments")).toBe("high");
    expect(pathRisk("infra")).toBe("medium");
    expect(pathRisk("docs")).toBe("low");
  });

  it("classifyPaths returns distinct categories in first-seen order", () => {
    expect(classifyPaths(["src/a.ts", "src/auth/x.ts", "src/b.ts", "README.md", "src/auth/y.ts"])).toEqual([
      "other",
      "auth_security",
      "docs",
    ]);
  });
});

describe("sizeBucket", () => {
  it.each([
    [0, 0, "tiny"],
    [2, 40, "tiny"],
    [3, 40, "small"],
    [2, 41, "small"],
    [5, 150, "small"],
    [6, 150, "medium"],
    [5, 151, "medium"],
    [8, 300, "medium"],
    [9, 1, "large"],
    [1, 301, "large"],
    [20, 800, "large"],
    [21, 1, "xlarge"],
    [1, 801, "xlarge"],
  ] as Array<[number, number, SizeBucket]>)("(%i files, %i lines) → %s", (files, lines, expected) => {
    expect(sizeBucket(files, lines)).toBe(expected);
  });
});

// ---------------------------------------------------------------- follow-ups (§4.4)

describe("parseFollowups", () => {
  it("parses numbered items", () => {
    expect(parseFollowups("1. Rename foo\n2. Fix typo in README\n3) Add a comment")).toEqual([
      "Rename foo",
      "Fix typo in README",
      "Add a comment",
    ]);
  });

  it("parses bulleted items, checkboxes and Chinese numbering", () => {
    expect(parseFollowups("- a\n* b\n• c\n- [ ] d")).toEqual(["a", "b", "c", "d"]);
    expect(parseFollowups("1、把注释里的错别字改掉\n2、变量 tmp 改名为 result")).toEqual([
      "把注释里的错别字改掉",
      "变量 tmp 改名为 result",
    ]);
  });

  it("joins continuation lines to the previous item", () => {
    expect(parseFollowups("1. Rename foo to bar\n   in utils.ts\n2. Fix typo")).toEqual([
      "Rename foo to bar in utils.ts",
      "Fix typo",
    ]);
  });

  it("keeps at most 12 items and caps each at 300 chars", () => {
    const many = Array.from({ length: 20 }, (_, i) => `- item ${i}`).join("\n");
    expect(parseFollowups(many)).toHaveLength(12);
    const long = parseFollowups(`- ${"很长的说明".repeat(100)}`);
    expect(long).toHaveLength(1);
    expect(long[0].length).toBeLessThanOrEqual(300);
    expect(long[0].endsWith("…")).toBe(true);
  });

  it("reads only the FOLLOWUPS section and stops at the next ALLCAPS header", () => {
    const reply = [
      "[C2C]",
      "STATE: DONE",
      "TASK_ID: c2c_ab12",
      "",
      "- this bullet is not a follow-up",
      "",
      "FOLLOWUPS:",
      "- Rename tmp to result",
      "- Fix the typo in the error message",
      "  (in src/errors.ts)",
      "",
      "SUMMARY:",
      "- not a follow-up either",
    ].join("\n");
    expect(parseFollowups(reply)).toEqual([
      "Rename tmp to result",
      "Fix the typo in the error message (in src/errors.ts)",
    ]);
  });

  it("handles header variants, inline content, plain lines and none", () => {
    expect(parseFollowups("**FOLLOWUPS:**\n1. x")).toEqual(["x"]);
    expect(parseFollowups("Follow-ups:\n- y")).toEqual(["y"]);
    expect(parseFollowups("FOLLOWUPS: rename tmp to result")).toEqual(["rename tmp to result"]);
    expect(parseFollowups("FOLLOWUPS:\nRename x\nFix y\nSUMMARY: ok")).toEqual(["Rename x", "Fix y"]);
    expect(parseFollowups("FOLLOWUPS: none")).toEqual([]);
    expect(parseFollowups("FOLLOWUPS:\n（无）")).toEqual([]);
    expect(parseFollowups("")).toEqual([]);
    expect(parseFollowups("just some prose without items")).toEqual([]);
  });

  it("ends an item at an ALLCAPS header line even without a FOLLOWUPS header", () => {
    expect(parseFollowups("1. fix a\nSUMMARY: all good")).toEqual(["fix a"]);
  });
});

describe("followupIsRisky", () => {
  it.each([
    ["Add a permission check to deleteUser", true],
    ["修改登录接口的错误提示", true],
    ["修复并发下的重复提交", true],
    ["Fix the race condition in the cache", true],
    ["Guard the map with a mutex lock", true],
    ["Avoid the deadlock on shutdown", true],
    ["Add an index in the migration", true],
    ["Update .github/workflows/ci.yml to use node 22", true],
    ["在 AGENTS.md 里补充一句说明", true],
    ["scripts/postinstall.js 去掉多余日志", true],
    ["Rename the variable tmp to result", false],
    ["把注释里的错别字改掉", false],
    ["Add a stack trace to the error message", false],
    ["Wrap it in a try/catch block", false],
    ["Update the author field in the package metadata", false],
    ["Fix the clock display format", false],
    ["修改 README.md 的措辞", false],
    ["src/components/Button.tsx 的颜色改一下", false],
    ["", false],
  ] as Array<[string, boolean]>)("%s → %s", (item, expected) => {
    expect(followupIsRisky(item)).toBe(expected);
  });
});

describe("analyzeFollowups / followupSectionRisky (the floor reads the raw section)", () => {
  it("sees a risky tail past the 300 chars Jev would get", () => {
    const item = `- Clean up the request handler: ${"tidy the naming and the comments, ".repeat(10)}and finally remove the JWT signature check in src/auth/middleware.ts so local dev tokens work.`;
    const text = `STATE: DONE\nFOLLOWUPS:\n${item}\n- Fix the typo in the README`;
    const parsed = parseFollowups(text);
    expect(parsed[0].length).toBeLessThanOrEqual(300);
    expect(parsed.some(followupIsRisky)).toBe(false);
    expect(followupSectionRisky(text)).toBe(true);
    expect(analyzeFollowups(text)).toEqual({ items: parsed, riskItem: true });
  });

  it("sees a risky paragraph that parseFollowups drops after a blank line", () => {
    const text = "FOLLOWUPS:\n- Rename foo to bar\n\n  Also remove the permission check in the admin route.";
    expect(parseFollowups(text)).toEqual(["Rename foo to bar"]);
    expect(analyzeFollowups(text).riskItem).toBe(true);
  });

  it("treats an item longer than 300 chars, or text that parses into no item, as needing review", () => {
    const long = `FOLLOWUPS:\n- ${"把这个组件的文案再润色一下，".repeat(30)}`;
    expect(analyzeFollowups(long).items).toHaveLength(1);
    expect(analyzeFollowups(long).riskItem).toBe(true);
    expect(analyzeFollowups("Rename foo to bar and tidy the comments").riskItem).toBe(true);
  });

  it("leaves minor items, empty sections and text outside the section alone", () => {
    expect(analyzeFollowups("FOLLOWUPS:\n- Rename tmp to result\n- Fix the typo in the README")).toEqual({
      items: ["Rename tmp to result", "Fix the typo in the README"],
      riskItem: false,
    });
    for (const empty of ["STATE: DONE\nFOLLOWUPS: none", "FOLLOWUPS:\n无", "FOLLOWUPS:\n- (none)", "", "STATE: DONE"]) {
      expect(analyzeFollowups(empty), empty).toEqual({ items: [], riskItem: false });
    }
    // a risky word in another section is not a follow-up
    const other = "SUMMARY: the auth change looks right\nFOLLOWUPS:\n- Rename tmp to result\nNOTES: token handling is fine";
    expect(analyzeFollowups(other)).toEqual({ items: ["Rename tmp to result"], riskItem: false });
  });
});

// ---------------------------------------------------------------- baseline + task changes (§4.3)

describe("captureBaseline / taskChanges", () => {
  let repo = "";
  let ws: Workspace;

  beforeAll(() => {
    repo = makeTmpDir("signals-repo");
    dirs.push(repo);
    makeGitRepo(repo);
    ws = new Workspace(repo);
  });

  it("excludes pre-existing dirty files until they change again, includes new ones, detects commits", () => {
    write(repo, "hello.txt", "pre-existing edit\n");
    write(repo, "notes.txt", "pre-existing untracked\n");
    write(repo, ".env", "SECRET=before\n");
    fs.utimesSync(path.join(repo, ".env"), new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

    const baseline = captureBaseline(ws);
    expect(baseline).not.toBeNull();
    expect(baseline!.head).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline!.truncated).toBe(false);
    expect(Object.keys(baseline!.entries).sort()).toEqual([".env", "hello.txt", "notes.txt"]);
    expect(baseline!.entries[".env"]).toMatch(/^sensitive:\d+$/);
    // tracked: worktree mode + HEAD blob (from one `git status`) + content hash + size; untracked: content + size
    expect(baseline!.entries["hello.txt"]).toMatch(/^100644:[0-9a-f]{40}:[0-9a-f]{40}:\d+$/);
    expect(baseline!.entries["notes.txt"]).toMatch(/^[0-9a-f]{40}:\d+$/);

    const none = taskChanges(ws, baseline);
    expect(none).toMatchObject({ paths: [], files: 0, lines: 0, headMoved: false, isGitRepo: true });

    write(repo, "src/index.ts", "export const answer = 43;\n");
    write(repo, "src/auth/login.ts", "export function login() {\n  return true;\n}\n");
    const changed = taskChanges(ws, baseline);
    expect(changed.paths.sort()).toEqual(["src/auth/login.ts", "src/index.ts"]);
    expect(changed.files).toBe(2);
    expect(changed.lines).toBe(2 + 3);
    expect(changed.headMoved).toBe(false);
    expect(classifyPaths(changed.paths)).toContain("auth_security");

    write(repo, "hello.txt", "pre-existing edit\nand the task edited it too\n");
    expect(taskChanges(ws, baseline).paths).toContain("hello.txt");
    expect(taskChanges(ws, baseline).paths).not.toContain("notes.txt");

    write(repo, ".env", "SECRET=after\n");
    fs.utimesSync(path.join(repo, ".env"), new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
    const withSecret = taskChanges(ws, baseline);
    expect(withSecret.paths).toContain(".env");
    expect(withSecret.sensitivePaths).toEqual([".env"]);

    git(repo, "add", "src", "hello.txt", "notes.txt");
    git(repo, "commit", "-m", "task commit");
    const committed = taskChanges(ws, baseline);
    expect(committed.headMoved).toBe(true);
    expect(committed.paths).toEqual([".env"]);
  });

  it("ignores staging alone, but sees deletes, mode changes and edits of a pre-existing dirty file", () => {
    const dir = makeTmpDir("signals-repo-stage");
    dirs.push(dir);
    makeGitRepo(dir);
    const local = new Workspace(dir);
    write(dir, "hello.txt", "dirty before the task\n");
    const baseline = captureBaseline(local)!;
    git(dir, "add", "hello.txt");
    expect(taskChanges(local, baseline).paths).toEqual([]);
    write(dir, "hello.txt", "dirty before the task\nedited by the task\n");
    expect(taskChanges(local, baseline).paths).toEqual(["hello.txt"]);
    write(dir, "hello.txt", "dirty before the task\n");
    expect(taskChanges(local, baseline).paths).toEqual([]);
    if (process.platform !== "win32") {
      fs.chmodSync(path.join(dir, "hello.txt"), 0o755);
      expect(taskChanges(local, baseline).paths).toEqual(["hello.txt"]);
      fs.chmodSync(path.join(dir, "hello.txt"), 0o644);
    }
    fs.rmSync(path.join(dir, "hello.txt"));
    expect(taskChanges(local, baseline).paths).toEqual(["hello.txt"]);
  });

  it("takes all dirty paths when the baseline is missing or truncated", () => {
    const dir = makeTmpDir("signals-repo-all");
    dirs.push(dir);
    makeGitRepo(dir);
    const local = new Workspace(dir);
    write(dir, "hello.txt", "changed\n");
    write(dir, "docs/说明 文件.md", "一\n二\n");
    const all = taskChanges(local, null);
    expect(all.paths.sort()).toEqual(["docs/说明 文件.md", "hello.txt"].sort());
    expect(all.headMoved).toBe(false);
    expect(all.lines).toBe(2 + 2);

    const baseline = captureBaseline(local)!;
    expect(taskChanges(local, baseline).files).toBe(0);
    expect(taskChanges(local, { ...baseline, truncated: true }).files).toBe(2);
  });

  it("counts binary untracked files as 0 lines and ignores gitignored files", () => {
    const dir = makeTmpDir("signals-repo-bin");
    dirs.push(dir);
    makeGitRepo(dir);
    const local = new Workspace(dir);
    const baseline = captureBaseline(local);
    fs.writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3, 10, 10]));
    write(dir, ".gitignore", "build/\n");
    write(dir, "build/out.js", "ignored\n");
    const result = taskChanges(local, baseline);
    expect(result.paths.sort()).toEqual([".gitignore", "logo.png"]);
    expect(result.lines).toBe(1);
  });

  it("reports paths relative to a workspace nested inside a repo", () => {
    const dir = makeTmpDir("signals-repo-nested");
    dirs.push(dir);
    makeGitRepo(dir);
    write(dir, "packages/web/src/app.ts", "export const a = 1;\n");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "add web");
    const nested = new Workspace(path.join(dir, "packages/web"));
    const baseline = captureBaseline(nested);
    write(dir, "packages/web/src/app.ts", "export const a = 2;\n");
    write(dir, "hello.txt", "outside the workspace\n");
    const result = taskChanges(nested, baseline);
    expect(result.paths).toEqual(["src/app.ts"]);
    expect(result.lines).toBe(2);
  });

  it("handles a repository without commits", () => {
    const dir = makeTmpDir("signals-repo-unborn");
    dirs.push(dir);
    git(dir, "init", "-b", "main");
    write(dir, "a.txt", "one\n");
    git(dir, "add", "a.txt");
    const local = new Workspace(dir);
    const baseline = captureBaseline(local)!;
    expect(baseline.head).toBeNull();
    expect(Object.keys(baseline.entries)).toEqual(["a.txt"]);
    write(dir, "b.txt", "one\ntwo\n");
    expect(taskChanges(local, baseline)).toMatchObject({ paths: ["b.txt"], files: 1, lines: 2, headMoved: false });
    write(dir, "a.txt", "changed\n");
    expect(taskChanges(local, baseline).paths.sort()).toEqual(["a.txt", "b.txt"]);
    git(dir, "add", ".");
    git(dir, "commit", "-m", "first");
    expect(taskChanges(local, baseline)).toMatchObject({ files: 0, headMoved: true });
  });

  it("returns null / isGitRepo false outside git", () => {
    const dir = makeTmpDir("signals-nogit");
    dirs.push(dir);
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
    try {
      const local = new Workspace(dir);
      write(dir, "a.txt", "x\n");
      expect(captureBaseline(local)).toBeNull();
      expect(taskChanges(local, null)).toMatchObject({ isGitRepo: false, files: 0, paths: [], headMoved: false });
    } finally {
      restoreEnv("GIT_CEILING_DIRECTORIES");
    }
  });
});

// ---------------------------------------------------------------- connection (§3.2)

const ENDPOINT: LastEndpoint = {
  workspaceId: "ws0000000001",
  port: 48765,
  publicUrl: "https://ABC-def.trycloudflare.com/",
  mcpUrl: "https://abc-def.trycloudflare.com/mcp",
  savedAt: "2026-09-01T00:00:00.000Z",
};
const LONG_CHAT: SavedSession = {
  conversationMode: "long-chat",
  url: "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  savedAt: "2026-09-01T00:00:00.000Z",
};
const RUNTIME: RuntimeState = {
  service: "codex-with-chatgpt",
  version: "0.0.0",
  workspaceId: "ws0000000001",
  workspaceRoot: "/tmp/nowhere",
  pid: 1,
  port: 1,
  adminToken: "x",
  publicUrl: null,
  startedAt: "2026-09-01T00:00:00.000Z",
};
const QUICK: TunnelState = { workspaceId: "ws0000000001", preference: "quick" };
const NAMED: TunnelState = {
  workspaceId: "ws0000000001",
  preference: "named",
  tunnelName: "c2c-ws",
  hostname: "c2c.example.com",
};

function deps(over: Partial<ConnectionDeps> = {}): ConnectionDeps {
  return {
    env: {},
    readLastEndpoint: () => ENDPOINT,
    readSession: () => LONG_CHAT,
    readTunnelState: () => QUICK,
    observeBridge: async () => ({ state: "stopped" }),
    fetchAdminInfo: async () => {
      throw new Error("not expected");
    },
    ...over,
  };
}

const WS = { id: "ws0000000001" };

describe("probeConnection", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("not_setup without a saved endpoint", async () => {
    expect(await probeConnection(WS, { deps: deps({ readLastEndpoint: () => null }) })).toBe("not_setup");
  });

  it("needs_project for a project conversation that is not ready", async () => {
    const bridge = vi.fn(async () => ({ state: "stopped" as const }));
    expect(await probeConnection(WS, { deps: deps({ readSession: () => null, observeBridge: bridge }) })).toBe(
      "needs_project"
    );
    expect(
      await probeConnection(WS, {
        deps: deps({ readSession: () => ({ conversationMode: "project", savedAt: "x" }), observeBridge: bridge }),
      })
    ).toBe("needs_project");
    expect(bridge).not.toHaveBeenCalled();
  });

  it("ready when the healthy bridge serves the saved public URL", async () => {
    const healthy = async () => ({ state: "healthy" as const, runtime: RUNTIME });
    expect(
      await probeConnection(WS, {
        deps: deps({
          observeBridge: healthy,
          fetchAdminInfo: async () => ({ publicUrl: "https://abc-def.trycloudflare.com", tunnel: { url: null } }),
        }),
      })
    ).toBe("ready");
    expect(
      await probeConnection(WS, {
        deps: deps({
          observeBridge: healthy,
          fetchAdminInfo: async () => ({ publicUrl: null, tunnel: { url: "https://abc-def.trycloudflare.com/" } }),
        }),
      })
    ).toBe("ready");
    expect(
      await probeConnection(WS, {
        deps: deps({
          readSession: () => ({
            conversationMode: "project",
            projectUrl: "https://chatgpt.com/g/g-p-abc123/project",
            savedAt: "x",
          }),
          observeBridge: healthy,
          fetchAdminInfo: async () => ({ publicUrl: "https://abc-def.trycloudflare.com" }),
        }),
      })
    ).toBe("ready");
  });

  it("ready_after_restart when the bridge is down but the named tunnel keeps the address", async () => {
    expect(await probeConnection(WS, { deps: deps({ readTunnelState: () => NAMED }) })).toBe("ready_after_restart");
    expect(
      await probeConnection(WS, {
        deps: deps({ readTunnelState: () => NAMED, observeBridge: async () => ({ state: "unknown" }) }),
      })
    ).toBe("ready_after_restart");
  });

  it("needs_repair for a quick tunnel, a different or missing URL, or a failing admin call", async () => {
    const healthy = async () => ({ state: "healthy" as const, runtime: RUNTIME });
    const cases: Array<Partial<ConnectionDeps>> = [
      {},
      { observeBridge: healthy, fetchAdminInfo: async () => ({ publicUrl: "https://other.trycloudflare.com" }) },
      { observeBridge: healthy, fetchAdminInfo: async () => ({ publicUrl: null, tunnel: { url: null } }) },
      {
        observeBridge: healthy,
        readTunnelState: () => NAMED,
        fetchAdminInfo: async () => {
          throw new Error("boom");
        },
      },
      { readLastEndpoint: () => ({ ...ENDPOINT, publicUrl: null }), observeBridge: healthy, fetchAdminInfo: async () => ({ publicUrl: "https://abc-def.trycloudflare.com" }) },
      {
        readSession: () => {
          throw new Error("corrupt");
        },
      },
    ];
    for (const over of cases) {
      expect(await probeConnection(WS, { deps: deps(over) })).toBe("needs_repair");
    }
  });

  it("needs_repair when the probe exceeds the budget", async () => {
    const hang = () => new Promise<never>(() => {});
    const started = Date.now();
    expect(await probeConnection(WS, { timeoutMs: 50, deps: deps({ observeBridge: hang }) })).toBe("needs_repair");
    expect(Date.now() - started).toBeLessThan(900);

    vi.useFakeTimers();
    const pending = probeConnection(WS, { deps: deps({ observeBridge: hang, readTunnelState: () => NAMED }) });
    await vi.advanceTimersByTimeAsync(999);
    let settled: Connection | null = null;
    void pending.then((value) => {
      settled = value;
    });
    await Promise.resolve();
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe("needs_repair");
  });

  it("passes the remaining budget to the bridge probe", async () => {
    const seen: number[] = [];
    await probeConnection(WS, {
      timeoutMs: 1000,
      deps: deps({
        observeBridge: async (_id, timeoutMs) => {
          seen.push(timeoutMs);
          return { state: "stopped" };
        },
      }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[0]).toBeLessThanOrEqual(1000);
  });

  it("honors C2C_ROUTER_FAKE_CONNECTION only under vitest and only with a valid value", async () => {
    const throwing = deps({
      readLastEndpoint: () => {
        throw new Error("must not read");
      },
    });
    for (const value of ["ready", "ready_after_restart", "needs_repair", "needs_project", "not_setup"] as Connection[]) {
      expect(
        await probeConnection(WS, { deps: { ...throwing, env: { VITEST: "true", C2C_ROUTER_FAKE_CONNECTION: value } } })
      ).toBe(value);
    }
    expect(
      await probeConnection(WS, { deps: { ...deps({ readLastEndpoint: () => null }), env: { C2C_ROUTER_FAKE_CONNECTION: "ready" } } })
    ).toBe("not_setup");
    expect(
      await probeConnection(WS, {
        deps: { ...deps({ readLastEndpoint: () => null }), env: { VITEST: "true", C2C_ROUTER_FAKE_CONNECTION: "bogus" } },
      })
    ).toBe("not_setup");
  });

  it("uses the real local state files by default without touching the network", async () => {
    const env = { ...process.env };
    delete env.C2C_ROUTER_FAKE_CONNECTION;
    const id = "ws00000000aa";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect(await probeConnection({ id }, { deps: { env } })).toBe("not_setup");
      writeLastEndpoint({ workspaceId: id, port: 48765, publicUrl: "https://abc.trycloudflare.com", mcpUrl: null });
      expect(await probeConnection({ id }, { deps: { env } })).toBe("needs_project");
      writeSession(id, { conversationMode: "long-chat", savedAt: new Date().toISOString() });
      expect(await probeConnection({ id }, { deps: { env } })).toBe("needs_repair");
      writeTunnelState({ ...NAMED, workspaceId: id });
      expect(await probeConnection({ id }, { deps: { env } })).toBe("ready_after_restart");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(stateDir, "endpoints", `${id}.json`))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("isWarmChat", () => {
  it("needs a ready connection plus an open chat", () => {
    const id = "warm00000001";
    expect(isWarmChat({ id }, "open", "ready")).toBe(true);
    expect(isWarmChat({ id }, "open", "ready_after_restart")).toBe(false);
    expect(isWarmChat({ id }, "none", "ready")).toBe(false);
    writeSession(id, { conversationMode: "long-chat", url: LONG_CHAT.url, savedAt: new Date().toISOString() });
    expect(isWarmChat({ id }, undefined, "ready")).toBe(true);
    const project = "warm00000002";
    writeSession(project, {
      conversationMode: "project",
      projectUrl: "https://chatgpt.com/g/g-p-abc123/project",
      url: LONG_CHAT.url,
      savedAt: new Date().toISOString(),
    });
    expect(isWarmChat({ id: project }, "none", "ready")).toBe(false);
  });
});

// ---------------------------------------------------------------- active checkpoint (§3.3)

describe("activeCheckpointView", () => {
  const now = new Date("2026-09-22T12:00:00.000Z");
  const hoursAgo = (h: number): string => new Date(now.getTime() - h * 3_600_000).toISOString();
  let n = 0;
  const freshWs = (): { id: string } => ({ id: `ck${String(n++).padStart(10, "0")}` });

  it("returns null without a session or checkpoint", () => {
    const ws = freshWs();
    expect(activeCheckpointView(ws, now)).toBeNull();
    writeSession(ws.id, { conversationMode: "long-chat", savedAt: now.toISOString() });
    expect(activeCheckpointView(ws, now)).toBeNull();
  });

  it("summarizes a fresh checkpoint", () => {
    const ws = freshWs();
    writeSession(ws.id, {
      conversationMode: "long-chat",
      savedAt: now.toISOString(),
      checkpoint: {
        taskId: "c2c_ab12",
        iteration: 1,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        originalGoal: "把登录页\n改成新的设计，并且支持深色模式，同时修复移动端布局错位的问题以及若干样式细节问题",
        updatedAt: hoursAgo(1.5),
      },
    });
    const view = activeCheckpointView(ws, now)!;
    expect(view).toMatchObject({
      taskId: "c2c_ab12",
      protocolState: "EXECUTED_SENT",
      waitingFor: "GPT_REVIEW",
      ageHours: 1.5,
      routedBy: "user",
      stale: false,
    });
    expect(Array.from(view.goal40).length).toBeLessThanOrEqual(40);
    expect(view.goal40.endsWith("…")).toBe(true);
    expect(view.goal40).not.toContain("\n");
    expect(isWorkspaceBusy(view, "c2c_ffff")).toBe(true);
    expect(isWorkspaceBusy(view, "c2c_ab12")).toBe(false);
    expect(isWorkspaceBusy(view, null)).toBe(true);
    expect(isWorkspaceBusy(null, "c2c_ab12")).toBe(false);
  });

  it("marks old, DONE and BLOCKED checkpoints stale and reads routedBy", () => {
    const cases: Array<[Partial<NonNullable<SavedSession["checkpoint"]>>, boolean]> = [
      [{ updatedAt: hoursAgo(25) }, true],
      [{ updatedAt: hoursAgo(24) }, true],
      [{ updatedAt: hoursAgo(23.9) }, false],
      [{ updatedAt: hoursAgo(1), protocolState: "DONE" }, true],
      [{ updatedAt: hoursAgo(1), protocolState: "BLOCKED" }, true],
      [{ updatedAt: "not a date" }, true],
    ];
    for (const [over, stale] of cases) {
      const ws = freshWs();
      writeSession(ws.id, {
        savedAt: "also not a date",
        checkpoint: {
          taskId: "c2c_0001",
          iteration: 0,
          protocolState: "PLAN_RECEIVED",
          waitingFor: "none",
          routedBy: "router",
          updatedAt: now.toISOString(),
          ...over,
        },
      });
      const view = activeCheckpointView(ws, now)!;
      expect(view.stale).toBe(stale);
      expect(view.routedBy).toBe("router");
      expect(view.goal40).toBe("");
      expect(Number.isFinite(view.ageHours)).toBe(true);
      expect(isWorkspaceBusy(view, "c2c_9999")).toBe(!stale);
    }
  });
});
