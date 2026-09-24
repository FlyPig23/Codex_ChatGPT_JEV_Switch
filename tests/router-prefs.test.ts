import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONSENT_REQUIRED_WARNING,
  DEFAULT_ROUTER_MODEL,
  isConsentAskedToday,
  isStaleAskedToday,
  isWorkspaceDisabled,
  localDay,
  markConsentAsked,
  markIntroShown,
  markStaleAsked,
  mergeRouterPrefs,
  readRouterPrefs,
  routerPrefsFile,
  setWorkspaceDisabled,
} from "../src/config/router-prefs.js";
import { mergeUiPrefs, prefsFile, readUiPrefs } from "../src/config/ui-prefs.js";
import { CONSENT_VERSION, fingerprintKey, removeRouterSecrets, writeRouterSecrets } from "../src/router/secrets.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");
const canTestReadOnly = process.platform !== "win32" && process.getuid?.() !== 0;

const WS = "ws_0123456789ab";
const WS2 = "ws_ba9876543210";

function consent(version = CONSENT_VERSION): void {
  const key = "tsk_test_prefs_key_000000";
  writeRouterSecrets({
    v: 1,
    consent: { version, acceptedAt: new Date().toISOString() },
    keySource: "file",
    apiKey: key,
    fingerprint: fingerprintKey(key),
  });
}

function rawRouterJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(routerPrefsFile(), "utf8")) as Record<string, unknown>;
}

describe("router prefs", () => {
  const dirs: string[] = [];
  const saved: Record<string, string | undefined> = {};
  let stateDir = "";

  beforeEach(() => {
    for (const name of ["C2C_STATE_DIR", "C2C_KEYS_DIR"]) saved[name] = process.env[name];
    stateDir = makeTmpDir("router-prefs-state");
    const keys = makeTmpDir("router-prefs-keys");
    dirs.push(stateDir, keys);
    process.env.C2C_STATE_DIR = stateDir;
    process.env.C2C_KEYS_DIR = keys;
  });

  afterEach(() => {
    try {
      fs.chmodSync(stateDir, 0o700);
    } catch {
      // already gone
    }
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
  });

  it("defaults to off / balanced / jev-1.13.0 in <stateDir>/router.json and reading writes nothing", () => {
    expect(routerPrefsFile()).toBe(path.join(stateDir, "router.json"));
    const prefs = readRouterPrefs();
    expect(prefs).toMatchObject({
      mode: "off",
      bias: "balanced",
      model: "jev-1.13.0",
      disabledWorkspaces: [],
      consentAsked: {},
      staleAsked: {},
    });
    expect(prefs.introShownAt).toBeUndefined();
    expect(DEFAULT_ROUTER_MODEL).toBe("jev-1.13.0");
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("keeps router prefs apart from prefs.json, so mergeUiPrefs cannot wipe the bias", () => {
    mergeRouterPrefs({ bias: "economy", model: "jev-1.14.0" });
    expect(fs.existsSync(prefsFile())).toBe(false);

    mergeUiPrefs({ developerModeEnabled: true });
    expect(readRouterPrefs()).toMatchObject({ bias: "economy", model: "jev-1.14.0", mode: "off" });
    const ui = JSON.parse(fs.readFileSync(prefsFile(), "utf8")) as Record<string, unknown>;
    expect(Object.keys(ui).sort()).toEqual(["developerModeEnabled", "updatedAt"]);
    expect(ui.developerModeEnabled).toBe(true);

    mergeUiPrefs({ setupMode: "manual" });
    const before = fs.readFileSync(prefsFile(), "utf8");
    mergeRouterPrefs({ bias: "speed" });
    expect(fs.readFileSync(prefsFile(), "utf8")).toBe(before);
    expect(Object.keys(JSON.parse(before) as object).sort()).toEqual(["developerModeEnabled", "setupMode", "updatedAt"]);
    expect(readUiPrefs()).toMatchObject({ developerModeEnabled: true, setupMode: "manual" });
    expect(readRouterPrefs().bias).toBe("speed");
    expect(Object.keys(rawRouterJson())).not.toContain("developerModeEnabled");
  });

  it("keeps the bias across `c2c prefs set --developer-mode`", () => {
    mergeRouterPrefs({ bias: "economy" });
    const result = spawnSync(process.execPath, ["--import", "tsx", cliEntry, "prefs", "set", "--developer-mode", "--json"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, C2C_STATE_DIR: stateDir },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, developerModeEnabled: true });
    expect(readRouterPrefs().bias).toBe("economy");
    const ui = JSON.parse(fs.readFileSync(prefsFile(), "utf8")) as Record<string, unknown>;
    expect(Object.keys(ui).sort()).toEqual(["developerModeEnabled", "updatedAt"]);
  });

  it("keeps mode off with a warning when auto is set without consent", () => {
    const denied = mergeRouterPrefs({ mode: "auto", bias: "speed" });
    expect(denied.prefs.mode).toBe("off");
    expect(denied.warning).toBe(CONSENT_REQUIRED_WARNING);
    expect(readRouterPrefs()).toMatchObject({ mode: "off", bias: "speed" });

    consent("2020-01-old");
    expect(mergeRouterPrefs({ mode: "auto" })).toMatchObject({ prefs: { mode: "off" }, warning: CONSENT_REQUIRED_WARNING });

    consent();
    const allowed = mergeRouterPrefs({ mode: "auto" });
    expect(allowed.prefs.mode).toBe("auto");
    expect(allowed.warning).toBeUndefined();
    expect(readRouterPrefs().mode).toBe("auto");
    expect(mergeRouterPrefs({ bias: "economy" }).prefs.mode).toBe("auto");

    removeRouterSecrets();
    expect(mergeRouterPrefs({ mode: "auto" })).toMatchObject({ prefs: { mode: "off" }, warning: CONSENT_REQUIRED_WARNING });
    expect(mergeRouterPrefs({ mode: "off" }).warning).toBeUndefined();
  });

  it("rejects invalid values without writing", () => {
    expect(() => mergeRouterPrefs({ mode: "on" as never })).toThrow(/mode/);
    expect(() => mergeRouterPrefs({ bias: "fast" as never })).toThrow(/bias/);
    expect(() => mergeRouterPrefs({ model: "gpt-4o" })).toThrow(/model/);
    expect(() => mergeRouterPrefs({ model: "jev-../../x" })).toThrow(/model/);
    expect(() => mergeRouterPrefs({ disabledWorkspaces: ["../etc"] })).toThrow(/disabledWorkspaces/);
    expect(() => mergeRouterPrefs({ consentAsked: { [WS]: "yesterday" } })).toThrow(/consentAsked/);
    expect(fs.existsSync(routerPrefsFile())).toBe(false);
  });

  it("tolerates a corrupt or hand-edited router.json field by field", () => {
    fs.writeFileSync(routerPrefsFile(), "{not json");
    expect(readRouterPrefs()).toMatchObject({ mode: "off", bias: "balanced", model: "jev-1.13.0" });
    fs.writeFileSync(routerPrefsFile(), JSON.stringify(["auto"]));
    expect(readRouterPrefs().mode).toBe("off");
    fs.writeFileSync(routerPrefsFile(), "null");
    expect(readRouterPrefs().bias).toBe("balanced");

    fs.writeFileSync(
      routerPrefsFile(),
      JSON.stringify({
        mode: "maybe",
        bias: "economy",
        model: "gpt-4o",
        disabledWorkspaces: [WS, 7, "../x", WS],
        consentAsked: { [WS]: "2026-09-22", [WS2]: "soon", "bad/key": "2026-09-22" },
        staleAsked: "nope",
        introShownAt: 12,
      })
    );
    const prefs = readRouterPrefs();
    expect(prefs).toMatchObject({
      mode: "off",
      bias: "economy",
      model: "jev-1.13.0",
      disabledWorkspaces: [WS],
      consentAsked: { [WS]: "2026-09-22" },
      staleAsked: {},
    });
    expect(prefs.introShownAt).toBeUndefined();

    fs.writeFileSync(routerPrefsFile(), "{not json");
    expect(mergeRouterPrefs({ bias: "speed" }).prefs).toMatchObject({ bias: "speed", mode: "off" });
    expect(rawRouterJson()).toMatchObject({ bias: "speed", mode: "off", model: "jev-1.13.0" });
  });

  it.skipIf(process.platform === "win32")("writes router.json with mode 0600", () => {
    mergeRouterPrefs({ bias: "speed" });
    expect(fs.statSync(routerPrefsFile()).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(stateDir)).toEqual(["router.json"]);
  });

  it.skipIf(!canTestReadOnly)("turns write failures into a warning instead of throwing", () => {
    fs.chmodSync(stateDir, 0o500);
    const out = mergeRouterPrefs({ bias: "speed" });
    expect(out.prefs.bias).toBe("speed");
    expect(out.warning).toMatch(/^router_prefs_write_failed:E(ACCES|PERM|ROFS)$/);
    expect(markConsentAsked(WS, "2026-09-22").warning).toMatch(/^router_prefs_write_failed:/);
    expect(markIntroShown().warning).toMatch(/^router_prefs_write_failed:/);
    const noConsent = mergeRouterPrefs({ mode: "auto" });
    expect(noConsent.warning).toContain(CONSENT_REQUIRED_WARNING);
    expect(noConsent.warning).toContain("router_prefs_write_failed:");
    fs.chmodSync(stateDir, 0o700);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("asks for connection consent at most once per workspace per day", () => {
    const day = "2026-09-22";
    expect(isConsentAskedToday(readRouterPrefs(), WS, day)).toBe(false);
    markConsentAsked(WS, day);
    let prefs = readRouterPrefs();
    expect(isConsentAskedToday(prefs, WS, day)).toBe(true);
    expect(isConsentAskedToday(prefs, WS2, day)).toBe(false);
    expect(isConsentAskedToday(prefs, WS, "2026-09-23")).toBe(false);

    markConsentAsked(WS2, day);
    expect(readRouterPrefs().consentAsked).toEqual({ [WS]: day, [WS2]: day });

    markConsentAsked(WS2, "2026-09-23");
    prefs = readRouterPrefs();
    expect(prefs.consentAsked).toEqual({ [WS2]: "2026-09-23" });
    expect(isConsentAskedToday(prefs, WS, "2026-09-23")).toBe(false);
    expect(isConsentAskedToday(prefs, WS2, "2026-09-23")).toBe(true);
  });

  it("tracks the stale-task question per workspace and task per day", () => {
    const day = "2026-09-22";
    markStaleAsked(WS, day, "c2c_ab12");
    const prefs = readRouterPrefs();
    expect(isStaleAskedToday(prefs, WS, day, "c2c_ab12")).toBe(true);
    expect(isStaleAskedToday(prefs, WS, day, "c2c_cd34")).toBe(false);
    expect(isStaleAskedToday(prefs, WS, day)).toBe(false);
    expect(isStaleAskedToday(prefs, WS, "2026-09-23", "c2c_ab12")).toBe(false);
    markStaleAsked(WS2, day);
    expect(isStaleAskedToday(readRouterPrefs(), WS2, day)).toBe(true);
    expect(readRouterPrefs().consentAsked).toEqual({});
  });

  it("uses the local calendar day", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("records the first-time intro once", () => {
    const first = new Date("2026-09-22T08:00:00.000Z");
    expect(markIntroShown(first).prefs.introShownAt).toBe(first.toISOString());
    expect(markIntroShown(new Date("2026-09-23T08:00:00.000Z")).prefs.introShownAt).toBe(first.toISOString());
    expect(readRouterPrefs().introShownAt).toBe(first.toISOString());
  });

  it("disables and re-enables a workspace without touching the others", () => {
    setWorkspaceDisabled(WS, true);
    setWorkspaceDisabled(WS2, true);
    setWorkspaceDisabled(WS, true);
    expect(readRouterPrefs().disabledWorkspaces).toEqual([WS2, WS]);
    setWorkspaceDisabled(WS, false);
    const prefs = readRouterPrefs();
    expect(isWorkspaceDisabled(prefs, WS)).toBe(false);
    expect(isWorkspaceDisabled(prefs, WS2)).toBe(true);
  });
});
