import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";
import { hasValidConsent } from "../router/secrets.js";
import { ROUTER_BIASES, ROUTER_MODES, type RouterBias, type RouterMode } from "../router/types.js";

/**
 * Machine-wide smart-routing prefs. Kept in router.json, never in prefs.json:
 * upstream mergeUiPrefs rewrites prefs.json wholesale and would drop them.
 */
export interface RouterPrefs {
  mode: RouterMode;
  bias: RouterBias;
  model: string;
  disabledWorkspaces: string[];
  introShownAt?: string;
  /** workspaceId → YYYY-MM-DD of the last connection-consent question. */
  consentAsked: Record<string, string>;
  /** workspaceId (or workspaceId:taskId) → YYYY-MM-DD of the last stale-task question. */
  staleAsked: Record<string, string>;
  updatedAt: string;
}

export type RouterPrefsPatch = Partial<Omit<RouterPrefs, "updatedAt">>;

export interface RouterPrefsWrite {
  prefs: RouterPrefs;
  warning?: string;
}

export const DEFAULT_ROUTER_MODEL = "jev-1.13.0";
export const MODEL_ID_RE = /^jev-[a-z0-9.-]{1,32}$/;
export const CONSENT_REQUIRED_WARNING = "router_consent_required";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WORKSPACES = 500;
const MAX_ASKED = 200;
const KEY_RE = /^[\w.:-]{1,128}$/;

export function routerPrefsFile(): string {
  return path.join(getStateDir(), "router.json");
}

function defaults(): RouterPrefs {
  return {
    mode: "off",
    bias: "balanced",
    model: DEFAULT_ROUTER_MODEL,
    disabledWorkspaces: [],
    consentAsked: {},
    staleAsked: {},
    updatedAt: new Date().toISOString(),
  };
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && KEY_RE.test(item) && !out.includes(item)) out.push(item);
  }
  return out.slice(-MAX_WORKSPACES);
}

function cleanDays(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => KEY_RE.test(entry[0]) && typeof entry[1] === "string" && DAY_RE.test(entry[1])
  );
  return Object.fromEntries(entries.slice(-MAX_ASKED));
}

/** Never throws: a missing, corrupt or hand-edited file falls back field by field to the defaults. */
export function readRouterPrefs(): RouterPrefs {
  const base = defaults();
  const raw = readJsonIfExists<Record<string, unknown>>(routerPrefsFile());
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const prefs: RouterPrefs = {
    mode: ROUTER_MODES.includes(raw.mode as RouterMode) ? (raw.mode as RouterMode) : base.mode,
    bias: ROUTER_BIASES.includes(raw.bias as RouterBias) ? (raw.bias as RouterBias) : base.bias,
    model: typeof raw.model === "string" && MODEL_ID_RE.test(raw.model) ? raw.model : base.model,
    disabledWorkspaces: cleanList(raw.disabledWorkspaces),
    consentAsked: cleanDays(raw.consentAsked),
    staleAsked: cleanDays(raw.staleAsked),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : base.updatedAt,
  };
  if (typeof raw.introShownAt === "string" && raw.introShownAt.length <= 64) prefs.introShownAt = raw.introShownAt;
  return prefs;
}

function validatePatch(patch: RouterPrefsPatch): void {
  if (patch.mode !== undefined && !ROUTER_MODES.includes(patch.mode)) {
    throw new Error(`mode must be one of ${ROUTER_MODES.join(", ")}`);
  }
  if (patch.bias !== undefined && !ROUTER_BIASES.includes(patch.bias)) {
    throw new Error(`bias must be one of ${ROUTER_BIASES.join(", ")}`);
  }
  if (patch.model !== undefined && (typeof patch.model !== "string" || !MODEL_ID_RE.test(patch.model))) {
    throw new Error("model must look like jev-1.13.0");
  }
  if (patch.disabledWorkspaces !== undefined) {
    if (!Array.isArray(patch.disabledWorkspaces) || patch.disabledWorkspaces.some((id) => typeof id !== "string" || !KEY_RE.test(id))) {
      throw new Error("disabledWorkspaces must be workspace ids");
    }
  }
  for (const key of ["consentAsked", "staleAsked"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} must be an object`);
    for (const [id, day] of Object.entries(value)) {
      if (!KEY_RE.test(id) || typeof day !== "string" || !DAY_RE.test(day)) throw new Error(`${key} entries must be id → YYYY-MM-DD`);
    }
  }
  if (patch.introShownAt !== undefined && (typeof patch.introShownAt !== "string" || patch.introShownAt.length > 64)) {
    throw new Error("introShownAt must be an ISO timestamp");
  }
}

function writeWarning(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return `router_prefs_write_failed:${typeof code === "string" ? code : "unknown"}`;
}

/** Atomic, best effort: any filesystem error (EPERM/EACCES/EROFS/…) becomes a warning. */
function writePrefs(prefs: RouterPrefs): string | undefined {
  const file = routerPrefsFile();
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeSecureJson(tmp, prefs);
    fs.renameSync(tmp, file);
    return undefined;
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    if (error && typeof error === "object" && typeof (error as NodeJS.ErrnoException).code === "string") {
      return writeWarning(error);
    }
    throw error;
  }
}

/**
 * Throws on invalid enum / model / id values (like mergeUiPrefs). Setting
 * mode "auto" without consent from `c2c route setup` keeps mode "off" and
 * returns CONSENT_REQUIRED_WARNING; the rest of the patch is still saved.
 */
export function mergeRouterPrefs(patch: RouterPrefsPatch): RouterPrefsWrite {
  validatePatch(patch);
  const previous = readRouterPrefs();
  const next: RouterPrefs = {
    mode: patch.mode ?? previous.mode,
    bias: patch.bias ?? previous.bias,
    model: patch.model ?? previous.model,
    disabledWorkspaces: patch.disabledWorkspaces ? cleanList(patch.disabledWorkspaces) : previous.disabledWorkspaces,
    consentAsked: patch.consentAsked ? cleanDays(patch.consentAsked) : previous.consentAsked,
    staleAsked: patch.staleAsked ? cleanDays(patch.staleAsked) : previous.staleAsked,
    updatedAt: new Date().toISOString(),
  };
  const introShownAt = patch.introShownAt ?? previous.introShownAt;
  if (introShownAt) next.introShownAt = introShownAt;
  const warnings: string[] = [];
  if (patch.mode === "auto" && !hasValidConsent()) {
    next.mode = "off";
    warnings.push(CONSENT_REQUIRED_WARNING);
  }
  const writeFailed = writePrefs(next);
  if (writeFailed) warnings.push(writeFailed);
  return warnings.length > 0 ? { prefs: next, warning: warnings.join("; ") } : { prefs: next };
}

/** Local calendar day, YYYY-MM-DD. */
export function localDay(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function askedKey(workspaceId: string, taskId?: string): string {
  return taskId ? `${workspaceId}:${taskId}` : workspaceId;
}

/** Keep only today's entries: older days can never matter again. */
function markDay(map: Record<string, string>, key: string, today: string): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(map).filter(([, day]) => day === today));
  kept[key] = today;
  return kept;
}

export function isConsentAskedToday(prefs: RouterPrefs, workspaceId: string, today: string = localDay()): boolean {
  return prefs.consentAsked[workspaceId] === today;
}

export function markConsentAsked(workspaceId: string, today: string = localDay()): RouterPrefsWrite {
  const prefs = readRouterPrefs();
  return mergeRouterPrefs({ consentAsked: markDay(prefs.consentAsked, workspaceId, today) });
}

export function isStaleAskedToday(
  prefs: RouterPrefs,
  workspaceId: string,
  today: string = localDay(),
  taskId?: string
): boolean {
  return prefs.staleAsked[askedKey(workspaceId, taskId)] === today;
}

export function markStaleAsked(workspaceId: string, today: string = localDay(), taskId?: string): RouterPrefsWrite {
  const prefs = readRouterPrefs();
  return mergeRouterPrefs({ staleAsked: markDay(prefs.staleAsked, askedKey(workspaceId, taskId), today) });
}

/** Sets introShownAt once; later calls leave the first timestamp. */
export function markIntroShown(now: Date = new Date()): RouterPrefsWrite {
  const prefs = readRouterPrefs();
  if (prefs.introShownAt) return { prefs };
  return mergeRouterPrefs({ introShownAt: now.toISOString() });
}

export function isWorkspaceDisabled(prefs: RouterPrefs, workspaceId: string): boolean {
  return prefs.disabledWorkspaces.includes(workspaceId);
}

export function setWorkspaceDisabled(workspaceId: string, disabled: boolean): RouterPrefsWrite {
  const prefs = readRouterPrefs();
  const rest = prefs.disabledWorkspaces.filter((id) => id !== workspaceId);
  return mergeRouterPrefs({ disabledWorkspaces: disabled ? [...rest, workspaceId] : rest });
}
