import fs from "node:fs";
import path from "node:path";
import { choice, noul, score } from "@typesafe-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askJev,
  BREAKER_FAILURE_OPEN_MS,
  BREAKER_RATE_LIMIT_OPEN_MS,
  breakerFile,
  DEFAULT_MODEL,
  JEV_BUDGETS,
  jevCallOptions,
  probeJev,
  readBreaker,
  recordJevOutcome,
  resetBreaker,
  TYPESAFE_BASE_URL,
} from "../src/router/jev.js";
import { CONSENT_VERSION, fingerprintKey, writeRouterSecrets, type ResolvedKey } from "../src/router/secrets.js";
import { DEFAULT_ROUTER_MODEL } from "../src/config/router-prefs.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const KEY_A = "tsk_test_key_aaaaaaaaaaaa";
const KEY_B = "tsk_test_key_bbbbbbbbbbbb";

function keyOf(key: string): ResolvedKey {
  return { key, source: "file", fingerprint: fingerprintKey(key) };
}

const QUESTIONS = {
  task_kind: choice(
    { question: "What kind of work does `request` ask for?" },
    { targeted_change: { what: "A specific change" }, new_feature: { what: "New behavior" } }
  ),
  scope: score({ question: "How much changes?" }, [{ situation: "none" }, { situation: "one line" }, { situation: "one file" }]),
  needs_design: noul({ question: "Does it need design?" }),
};

const ANSWERS = {
  task_kind: {
    type: "choice",
    choice: "targeted_change",
    confidence: 0.8,
    probabilities: { targeted_change: 0.8, new_feature: 0.2 },
  },
  scope: {
    type: "score",
    score: 1.1,
    confidence: 0.7,
    legend: { "0": { situation: "none" }, "1": { situation: "one line" }, "2": { situation: "one file" } },
    probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
  },
  needs_design: { type: "noul", noul: 0.1 },
};

const STATE = {
  intake: { request: "把保存按钮改成蓝色" },
  failure: { command: "pnpm test", error_lines: "AssertionError: expected 1 to be 2" },
  reply: { followups: ["把注释里的错别字改掉"] },
};

const SUCCESS_BODY = { model: "jev-1.13.0", answers: ANSWERS, usage: { input_tokens: 42, output_tokens: 7 } };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-typesafe-request-id": "req_test", ...headers },
  });
}

function okFetch(body: unknown = SUCCESS_BODY) {
  return vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, body));
}

function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      })
  );
}

function connectionError(code = "ECONNREFUSED"): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

function neverFetch() {
  return vi.fn(async (): Promise<Response> => {
    throw new Error("network must not be used");
  });
}

describe("router jev client", () => {
  const dirs: string[] = [];
  const saved: Record<string, string | undefined> = {};
  const touched = [
    "C2C_STATE_DIR",
    "C2C_KEYS_DIR",
    "C2C_ROUTER_FAKE_JEV",
    "TYPESAFE_BASE_URL",
    "TYPESAFE_DEFAULT_MODEL",
    "TYPESAFE_API_KEY",
    "TYPESAFE_LOG_LEVEL",
    "VITEST",
  ];
  let stateDir = "";

  beforeEach(() => {
    for (const name of touched) saved[name] = process.env[name];
    stateDir = makeTmpDir("jev-state");
    const keys = makeTmpDir("jev-keys");
    dirs.push(stateDir, keys);
    process.env.C2C_STATE_DIR = stateDir;
    process.env.C2C_KEYS_DIR = keys;
    delete process.env.C2C_ROUTER_FAKE_JEV;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const name of touched) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
  });

  it("pins the endpoint, model and key even when TYPESAFE_* env vars are set", async () => {
    process.env.TYPESAFE_BASE_URL = "http://evil.example";
    process.env.TYPESAFE_DEFAULT_MODEL = "x";
    process.env.TYPESAFE_API_KEY = "env-key-must-not-be-used";
    const fetch = okFetch();
    const out = await askJev({ request: "把保存按钮改成蓝色" }, QUESTIONS, jevCallOptions("intake"), {
      key: keyOf(KEY_A),
      env: {},
      fetch,
    });
    expect(out.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${TYPESAFE_BASE_URL}/v1/systemone`);
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(String(init?.body)) as { model: string; state: unknown; questions: Record<string, unknown> };
    expect(body.model).toBe("jev-1.13.0");
    expect(body.state).toEqual({ request: "把保存按钮改成蓝色" });
    expect(Object.keys(body.questions)).toEqual(["task_kind", "scope", "needs_design"]);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY_A}`);
    if (out.ok) {
      expect(out.model).toBe("jev-1.13.0");
      expect(out.usage).toEqual({ input_tokens: 42, output_tokens: 7 });
      expect(out.answers.task_kind.choice).toBe("targeted_change");
      expect(out.answers.needs_design.noul).toBe(0.1);
    }
  });

  it("uses the default model for an invalid model id and keeps DEFAULT_MODEL in sync with router prefs", async () => {
    expect(DEFAULT_MODEL).toBe("jev-1.13.0");
    expect(DEFAULT_ROUTER_MODEL).toBe(DEFAULT_MODEL);
    const fetch = okFetch();
    await askJev(STATE.intake, QUESTIONS, { ...jevCallOptions("intake"), model: "gpt-4o/../../x" }, { key: keyOf(KEY_A), env: {}, fetch });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).model).toBe("jev-1.13.0");
    const custom = okFetch();
    await askJev(STATE.reply, QUESTIONS, jevCallOptions("reply", "jev-1.14.0"), { key: keyOf(KEY_A), env: {}, fetch: custom });
    expect(JSON.parse(String(custom.mock.calls[0][1]?.body)).model).toBe("jev-1.14.0");
  });

  it("prints nothing even with TYPESAFE_LOG_LEVEL=debug", async () => {
    process.env.TYPESAFE_LOG_LEVEL = "debug";
    const spies = [
      vi.spyOn(process.stdout, "write").mockImplementation(() => true),
      vi.spyOn(process.stderr, "write").mockImplementation(() => true),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const deps = { key: keyOf(KEY_A), env: {} };
    const ok = await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { ...deps, fetch: okFetch() });
    const serverError = vi.fn(async () => jsonResponse(500, { error: "boom with secret body" }));
    const failed = await askJev(STATE.failure, QUESTIONS, jevCallOptions("failure"), { ...deps, fetch: serverError });
    const refused = await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), {
      key: keyOf(KEY_B),
      env: {},
      fetch: vi.fn(async (): Promise<Response> => {
        throw connectionError();
      }),
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const spy of spies) spy.mockRestore();
    expect(ok.ok).toBe(true);
    expect(failed).toMatchObject({ ok: false, error: "server", status: 500 });
    expect(serverError).toHaveBeenCalledTimes(2);
    expect(refused).toMatchObject({ ok: false, error: "network_blocked" });
  });

  it("aborts at the intake budget of about 3000 ms (fake timers)", async () => {
    vi.useFakeTimers();
    const fetch = hangingFetch();
    let settled = false;
    const pending = askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { key: keyOf(KEY_A), env: {}, fetch }).then((out) => {
      settled = true;
      return out;
    });
    await vi.advanceTimersByTimeAsync(2900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    const out = await pending;
    expect(out).toMatchObject({ ok: false, error: "timeout" });
    expect(out.latencyMs).toBeGreaterThanOrEqual(2900);
    expect(out.latencyMs).toBeLessThanOrEqual(3100);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JEV_BUDGETS.intake).toEqual({ budgetMs: 3000, retries: 0 });
    expect(JEV_BUDGETS.failure).toEqual({ budgetMs: 5000, retries: 1 });
    expect(JEV_BUDGETS.reply).toEqual({ budgetMs: 5000, retries: 1 });
  });

  it("treats the budget as a total across the retry", async () => {
    const hang = hangingFetch();
    const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (fetch.mock.calls.length === 1) throw connectionError("ECONNRESET");
      return hang(url, init);
    });
    const started = Date.now();
    const out = await askJev(STATE.failure, QUESTIONS, { point: "failure", budgetMs: 400, retries: 1, model: DEFAULT_MODEL }, {
      key: keyOf(KEY_A),
      env: {},
      fetch,
    });
    const elapsed = Date.now() - started;
    expect(out).toMatchObject({ ok: false, error: "timeout" });
    expect(elapsed).toBeLessThan(700);
  });

  it("returns rate_limited on 429 with retry-after: 60 without waiting or retrying", async () => {
    const fetch = vi.fn(async () => jsonResponse(429, { error: "slow down" }, { "retry-after": "60" }));
    const started = Date.now();
    const out = await askJev(STATE.failure, QUESTIONS, jevCallOptions("failure"), { key: keyOf(KEY_A), env: {}, fetch });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out).toMatchObject({ ok: false, error: "rate_limited", status: 429, requestId: "req_test" });
    expect(fetch).toHaveBeenCalledTimes(1);

    const now = Date.now();
    expect(readBreaker({ fingerprint: fingerprintKey(KEY_A), now }).open).toBe(true);
    expect(readBreaker({ now }).reason).toBe("rate_limited");
    const blocked = neverFetch();
    expect(await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { key: keyOf(KEY_A), env: {}, fetch: blocked })).toMatchObject({
      ok: false,
      error: "breaker_open",
    });
    expect(blocked).not.toHaveBeenCalled();
    expect(readBreaker({ now: now + BREAKER_RATE_LIMIT_OPEN_MS + 1000 }).open).toBe(false);
  });

  it("does not retry a connection error on intake but retries once on failure", async () => {
    const intakeFetch = vi.fn(async (): Promise<Response> => {
      throw connectionError("ECONNREFUSED");
    });
    const intake = await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { key: keyOf(KEY_A), env: {}, fetch: intakeFetch });
    expect(intake).toMatchObject({ ok: false, error: "network_blocked" });
    expect(intakeFetch).toHaveBeenCalledTimes(1);

    const failureFetch = vi.fn(async (): Promise<Response> => {
      if (failureFetch.mock.calls.length === 1) throw connectionError("ECONNRESET");
      return jsonResponse(200, SUCCESS_BODY);
    });
    const failure = await askJev(STATE.failure, QUESTIONS, jevCallOptions("failure"), { key: keyOf(KEY_A), env: {}, fetch: failureFetch });
    expect(failure.ok).toBe(true);
    expect(failureFetch).toHaveBeenCalledTimes(2);
  });

  it("opens the breaker on 401 until the key fingerprint changes", async () => {
    const unauthorized = vi.fn(async () => jsonResponse(401, { error: "bad key" }));
    const out = await askJev(STATE.failure, QUESTIONS, jevCallOptions("failure"), { key: keyOf(KEY_A), env: {}, fetch: unauthorized });
    expect(out).toMatchObject({ ok: false, error: "auth", status: 401 });
    expect(unauthorized).toHaveBeenCalledTimes(1);

    const later = Date.now() + 24 * 60 * 60_000;
    expect(readBreaker({ fingerprint: fingerprintKey(KEY_A), now: later })).toMatchObject({ open: true, reason: "auth", until: null });
    expect(readBreaker({ fingerprint: fingerprintKey(KEY_B) }).open).toBe(false);
    expect(readBreaker().open).toBe(true);

    const blocked = neverFetch();
    const again = await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), {
      key: keyOf(KEY_A),
      env: {},
      fetch: blocked,
      now: () => later,
    });
    expect(again).toMatchObject({ ok: false, error: "breaker_open" });
    expect(blocked).not.toHaveBeenCalled();

    const noKey = await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { key: null, env: {}, fetch: blocked });
    expect(noKey).toMatchObject({ ok: false, error: "no_key" });

    const fresh = okFetch();
    const rotated = await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { key: keyOf(KEY_B), env: {}, fetch: fresh });
    expect(rotated.ok).toBe(true);
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(readBreaker().open).toBe(false);

    const raw = fs.readFileSync(breakerFile(), "utf8");
    expect(breakerFile()).toBe(path.join(stateDir, "routing", "breaker.json"));
    expect(raw).not.toContain(KEY_A);
    expect(raw).not.toContain(KEY_B);
  });

  it("opens the breaker for 15 minutes after two consecutive 5xx and resets on success", async () => {
    const base = Date.now();
    const deps = { key: keyOf(KEY_A), env: {}, now: () => base };
    const unavailable = vi.fn(async () => jsonResponse(503, { error: "down" }));
    expect(await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { ...deps, fetch: unavailable })).toMatchObject({ error: "server" });
    expect(readBreaker({ now: base }).open).toBe(false);
    expect(await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { ...deps, fetch: unavailable })).toMatchObject({ error: "server" });
    expect(unavailable).toHaveBeenCalledTimes(2);

    const view = readBreaker({ now: base });
    expect(view).toMatchObject({ open: true, reason: "server" });
    expect(Date.parse(view.until ?? "")).toBe(base + BREAKER_FAILURE_OPEN_MS);

    const blocked = neverFetch();
    expect(await askJev(STATE.reply, QUESTIONS, jevCallOptions("reply"), { ...deps, fetch: blocked })).toMatchObject({ error: "breaker_open" });
    const almost = () => base + BREAKER_FAILURE_OPEN_MS - 1000;
    expect(await askJev(STATE.reply, QUESTIONS, jevCallOptions("reply"), { ...deps, now: almost, fetch: blocked })).toMatchObject({
      error: "breaker_open",
    });
    expect(blocked).not.toHaveBeenCalled();

    const after = () => base + BREAKER_FAILURE_OPEN_MS + 1000;
    const healthy = okFetch();
    expect((await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { ...deps, now: after, fetch: healthy })).ok).toBe(true);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(readBreaker({ now: after() })).toEqual({ open: false, until: null, reason: null, authFingerprint: null });
  });

  it("with breaker: false neither trips nor obeys the shared breaker (route eval)", async () => {
    const base = Date.now();
    const deps = { key: keyOf(KEY_A), env: {}, now: () => base, breaker: false };
    const unavailable = vi.fn(async () => jsonResponse(503, { error: "down" }));
    for (let i = 0; i < 3; i++) {
      expect(await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { ...deps, fetch: unavailable })).toMatchObject({ error: "server" });
    }
    expect(fs.existsSync(breakerFile())).toBe(false);
    const unauthorized = vi.fn(async () => jsonResponse(401, { error: "bad key" }));
    expect(await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { ...deps, fetch: unauthorized })).toMatchObject({ error: "auth" });
    expect(readBreaker().open).toBe(false);

    // a breaker opened by real routing does not block an eval call, and eval does not reset it
    recordJevOutcome({ ok: false, error: "rate_limited" }, fingerprintKey(KEY_A), base);
    expect(readBreaker({ now: base }).open).toBe(true);
    const healthy = okFetch();
    expect((await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { ...deps, fetch: healthy })).ok).toBe(true);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(readBreaker({ now: base })).toMatchObject({ open: true, reason: "rate_limited" });
  });

  it("counts one retried 5xx call as a single failure", async () => {
    const serverError = vi.fn(async () => jsonResponse(502, { error: "bad gateway" }));
    const out = await askJev(STATE.failure, QUESTIONS, jevCallOptions("failure"), { key: keyOf(KEY_A), env: {}, fetch: serverError });
    expect(out).toMatchObject({ ok: false, error: "server", status: 502 });
    expect(serverError).toHaveBeenCalledTimes(2);
    expect(readBreaker().open).toBe(false);
  });

  it("records outcomes with the documented breaker rules", () => {
    const t = Date.parse("2026-09-22T10:00:00.000Z");
    recordJevOutcome({ ok: false, error: "timeout" }, null, t);
    recordJevOutcome({ ok: false, error: "bad_request" }, null, t);
    recordJevOutcome({ ok: false, error: "invalid_response" }, null, t);
    expect(readBreaker({ now: t }).open).toBe(false);
    recordJevOutcome({ ok: false, error: "network_blocked" }, null, t);
    expect(readBreaker({ now: t })).toMatchObject({ open: true, reason: "network_blocked" });
    recordJevOutcome({ ok: true }, null, t);
    expect(readBreaker({ now: t }).open).toBe(false);
    recordJevOutcome({ ok: false, error: "timeout" }, null, t);
    recordJevOutcome({ ok: true }, null, t);
    recordJevOutcome({ ok: false, error: "timeout" }, null, t);
    expect(readBreaker({ now: t }).open).toBe(false);
  });

  it("makes no fetch call when CODEX_SANDBOX_NETWORK_DISABLED=1", async () => {
    const fetch = neverFetch();
    const out = await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), {
      key: keyOf(KEY_A),
      env: { CODEX_SANDBOX_NETWORK_DISABLED: "1" },
      fetch,
    });
    expect(out).toMatchObject({ ok: false, error: "network_blocked" });
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(breakerFile())).toBe(false);
  });

  it("resolves the key from the secrets file and returns no_key without consent", async () => {
    const fetch = okFetch();
    const none = await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { env: {}, fetch });
    expect(none).toMatchObject({ ok: false, error: "no_key" });
    expect(fetch).not.toHaveBeenCalled();

    writeRouterSecrets({
      v: 1,
      consent: { version: CONSENT_VERSION, acceptedAt: new Date().toISOString() },
      keySource: "file",
      apiKey: KEY_A,
      fingerprint: fingerprintKey(KEY_A),
    });
    const out = await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { env: { TYPESAFE_API_KEY: KEY_B }, fetch });
    expect(out.ok).toBe(true);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("authorization")).toBe(`Bearer ${KEY_A}`);
  });

  it("rejects malformed answers as invalid_response without tripping the breaker", async () => {
    const missing = { ...SUCCESS_BODY, answers: { task_kind: ANSWERS.task_kind, scope: ANSWERS.scope } };
    const wrongType = { ...SUCCESS_BODY, answers: { ...ANSWERS, needs_design: { type: "choice", choice: "x" } } };
    const badChoice = { ...SUCCESS_BODY, answers: { ...ANSWERS, task_kind: { ...ANSWERS.task_kind, choice: "made_up" } } };
    const outOfRange = { ...SUCCESS_BODY, answers: { ...ANSWERS, needs_design: { type: "noul", noul: 7 } } };
    for (const body of [missing, wrongType, badChoice, outOfRange, "not json at all", { nothing: true }]) {
      const fetch = vi.fn(async () =>
        typeof body === "string" ? new Response(body, { status: 200, headers: { "content-type": "text/plain" } }) : jsonResponse(200, body)
      );
      const out = await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { key: keyOf(KEY_A), env: {}, fetch });
      expect(out).toMatchObject({ ok: false, error: "invalid_response" });
    }
    expect(readBreaker().open).toBe(false);
  });

  it("maps other 4xx to bad_request and 403 to auth", async () => {
    const badRequest = vi.fn(async () => jsonResponse(422, { detail: "nope" }));
    expect(await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { key: keyOf(KEY_A), env: {}, fetch: badRequest })).toMatchObject({
      error: "bad_request",
      status: 422,
    });
    const forbidden = vi.fn(async () => jsonResponse(403, { error: "forbidden" }));
    expect(await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { key: keyOf(KEY_B), env: {}, fetch: forbidden })).toMatchObject({
      error: "auth",
      status: 403,
    });
  });

  it("returns outbound_rejected when the outbound check throws, before any request", async () => {
    const fetch = neverFetch();
    const out = await askJev({ request: "x", extra: "y" }, QUESTIONS, jevCallOptions("intake"), {
      key: keyOf(KEY_A),
      env: {},
      fetch,
      assertState(point, state) {
        expect(point).toBe("intake");
        expect(state).toEqual({ request: "x", extra: "y" });
        throw new Error("unknown key");
      },
    });
    expect(out).toMatchObject({ ok: false, error: "outbound_rejected" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the outbound manifest by default and sends only schema-valid state", async () => {
    const fetch = neverFetch();
    const deps = { key: keyOf(KEY_A), env: {}, fetch };
    const rejected = [
      await askJev("plain string", QUESTIONS, jevCallOptions("intake"), deps),
      await askJev({ request: "x", extra: "y" }, QUESTIONS, jevCallOptions("intake"), deps),
      await askJev({ request: "x".repeat(1501) }, QUESTIONS, jevCallOptions("intake"), deps),
      await askJev({ goal: "g", command: "pnpm test" }, QUESTIONS, jevCallOptions("failure"), deps),
      await askJev({ followups: [] }, QUESTIONS, jevCallOptions("reply"), deps),
      await askJev(STATE.intake, QUESTIONS, jevCallOptions("reply"), deps),
    ];
    for (const out of rejected) expect(out).toMatchObject({ ok: false, error: "outbound_rejected" });
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(breakerFile())).toBe(false);

    const sent = okFetch();
    expect((await askJev(STATE.failure, QUESTIONS, jevCallOptions("failure"), { ...deps, fetch: sent })).ok).toBe(true);
    expect(JSON.parse(String(sent.mock.calls[0][1]?.body)).state).toEqual(STATE.failure);
  });

  it("never reaches the real network under vitest without an injected or stubbed fetch", async () => {
    const original = globalThis.fetch;
    let realCalls = 0;
    globalThis.fetch = (async () => {
      realCalls += 1;
      throw new Error("network must not be used");
    }) as typeof fetch;
    try {
      const out = await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { key: keyOf(KEY_A), env: {} });
      expect(out).toMatchObject({ ok: false, error: "network_blocked" });
      expect(realCalls).toBe(0);
      expect(fs.existsSync(breakerFile())).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
    const stubbed = okFetch();
    vi.stubGlobal("fetch", stubbed);
    try {
      const out = await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { key: keyOf(KEY_A), env: {} });
      expect(out.ok).toBe(true);
      expect(stubbed).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("fake hook", () => {
    function writeFake(content: unknown): string {
      const file = path.join(stateDir, "fake-jev.json");
      fs.writeFileSync(file, JSON.stringify(content));
      process.env.C2C_ROUTER_FAKE_JEV = file;
      return file;
    }

    function calls(file: string): string[] {
      try {
        return fs.readFileSync(`${file}.calls`, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    }

    it("answers from the fake file, counts calls and never fetches", async () => {
      const file = writeFake({ intake: { model: "jev-1.13.0", answers: ANSWERS, usage: { input_tokens: 1, output_tokens: 1 } } });
      const fetch = neverFetch();
      const out = await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { key: keyOf(KEY_A), env: {}, fetch });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.answers.scope.probabilities).toEqual({ "0": 0.1, "1": 0.7, "2": 0.2 });
        expect(out.usage).toEqual({ input_tokens: 1, output_tokens: 1 });
        expect(out.model).toBe("jev-1.13.0");
      }
      const missingPoint = await askJev(STATE.failure, QUESTIONS, jevCallOptions("failure"), { key: keyOf(KEY_A), env: {}, fetch });
      expect(missingPoint).toMatchObject({ ok: false, error: "server" });
      expect(fetch).not.toHaveBeenCalled();
      expect(calls(file)).toEqual(["intake", "failure"]);
    });

    it("returns a configured error class and invalid_response for incomplete answers", async () => {
      const file = writeFake({
        reply: { error: "rate_limited" },
        intake: { model: "jev-1.13.0", answers: { task_kind: ANSWERS.task_kind }, usage: { input_tokens: 1, output_tokens: 1 } },
      });
      const fetch = neverFetch();
      expect(await askJev(STATE.reply, QUESTIONS, jevCallOptions("reply"), { key: keyOf(KEY_A), env: {}, fetch })).toMatchObject({
        ok: false,
        error: "rate_limited",
      });
      // A fake outcome feeds the breaker like a real one: rate_limited opens it for every key.
      expect(readBreaker({ fingerprint: fingerprintKey(KEY_B) })).toMatchObject({ open: true, reason: "rate_limited" });
      expect(await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { key: keyOf(KEY_B), env: {}, fetch })).toMatchObject({
        ok: false,
        error: "breaker_open",
      });
      resetBreaker();
      expect(await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { key: keyOf(KEY_B), env: {}, fetch })).toMatchObject({
        ok: false,
        error: "invalid_response",
      });
      expect(readBreaker().open).toBe(false);
      expect(calls(file)).toEqual(["reply", "intake"]);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("expands followup_*_size to every reply item", async () => {
      writeFake({
        reply: {
          model: "jev-1.13.0",
          answers: {
            "followup_*_size": {
              type: "score",
              score: 0.4,
              confidence: 0.8,
              legend: {},
              probabilities: { "0": 0.7, "1": 0.2, "2": 0.08, "3": 0.02 },
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      const rubric = [{ situation: "a" }, { situation: "b" }, { situation: "c" }, { situation: "d" }] as const;
      const questions = {
        followup_0_size: score("q0", rubric),
        followup_1_size: score("q1", rubric),
        followup_2_size: score("q2", rubric),
      };
      const out = await askJev({ followups: ["a", "b", "c"] }, questions, jevCallOptions("reply"), {
        key: keyOf(KEY_A),
        env: {},
        fetch: neverFetch(),
      });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(Object.keys(out.answers).sort()).toEqual(["followup_0_size", "followup_1_size", "followup_2_size"]);
        expect(out.answers.followup_2_size.probabilities["3"]).toBe(0.02);
      }
    });

    it("still applies the network, breaker and key short-circuits", async () => {
      const file = writeFake({ intake: { model: "jev-1.13.0", answers: ANSWERS } });
      const blocked = await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), {
        key: keyOf(KEY_A),
        env: { CODEX_SANDBOX_NETWORK_DISABLED: "1" },
      });
      expect(blocked).toMatchObject({ error: "network_blocked" });
      expect(await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { key: null, env: {} })).toMatchObject({ error: "no_key" });
      expect(calls(file)).toEqual([]);
    });

    it("serves the probe question from the intake entry", async () => {
      writeFake({
        intake: { model: "jev-1.13.0", answers: { ...ANSWERS, goal_is_clear: { type: "noul", noul: 0.9 } } },
      });
      const out = await probeJev({}, { key: keyOf(KEY_A), env: {}, fetch: neverFetch() });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.answers.goal_is_clear.noul).toBe(0.9);
    });

    it("is ignored outside vitest", async () => {
      const file = writeFake({ intake: { error: "server" } });
      process.env.VITEST = "false";
      const fetch = okFetch();
      const out = await askJev(STATE.intake, QUESTIONS, jevCallOptions("intake"), { key: keyOf(KEY_A), env: {}, fetch });
      process.env.VITEST = "true";
      expect(out.ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(calls(file)).toEqual([]);
    });
  });
});
