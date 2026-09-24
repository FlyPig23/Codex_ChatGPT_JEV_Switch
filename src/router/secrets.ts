import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";

/** Bump when the routing data terms shown by `c2c route setup` change. */
// -2: the terms now say that error lines and follow-up items can carry file paths, hostnames and
// failing source lines, and that the failure payload no longer includes the task goal.
export const CONSENT_VERSION = "2026-09-routing-2";

export const SECRETS_FILE_NAME = ".c2c-secrets-typesafe.json";

export interface RouterSecrets {
  v: 1;
  consent: { version: string; acceptedAt: string };
  keySource: "file" | "env";
  /** Present only when keySource is "file". */
  apiKey?: string;
  /** sha256 hex prefix (16) of the key; for keySource "env" this pins which env key may be used. */
  fingerprint: string;
}

export interface ResolvedKey {
  key: string;
  source: "file" | "env";
  fingerprint: string;
}

export interface KeyStatus {
  configured: boolean;
  source: "file" | "env" | null;
  fingerprint8: string | null;
}

export interface ConsentStatus {
  accepted: boolean;
  version: string | null;
  current: string;
}

const FINGERPRINT_RE = /^[0-9a-f]{16}$/;

const secretsSchema = z.object({
  v: z.literal(1),
  consent: z.object({
    version: z.string().min(1).max(64),
    acceptedAt: z.string().min(1).max(64),
  }),
  keySource: z.enum(["file", "env"]),
  apiKey: z.string().min(1).max(512).optional(),
  fingerprint: z.string().regex(FINGERPRINT_RE),
});

/**
 * Keys live next to the state dir, not inside it: the state dir is one of the
 * Codex sandbox writable roots, so consent stored there could be forged.
 */
export function keysDir(): string {
  const override = process.env.C2C_KEYS_DIR;
  if (override && override.trim() !== "") return path.resolve(override);
  return `${getStateDir()}-keys`;
}

export function secretsFile(): string {
  return path.join(keysDir(), SECRETS_FILE_NAME);
}

export function fingerprintKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

export function readRouterSecrets(): RouterSecrets | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(secretsFile(), "utf8"));
  } catch {
    return null;
  }
  const parsed = secretsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data;
  if (s.keySource === "file" && (!s.apiKey || fingerprintKey(s.apiKey.trim()) !== s.fingerprint)) return null;
  const out: RouterSecrets = {
    v: 1,
    consent: { version: s.consent.version, acceptedAt: s.consent.acceptedAt },
    keySource: s.keySource,
    fingerprint: s.fingerprint,
  };
  if (s.keySource === "file" && s.apiKey) out.apiKey = s.apiKey;
  return out;
}

/** Dir 0700, file 0600, atomic replace. Throws on failure (setup reports it). */
export function writeRouterSecrets(s: RouterSecrets): void {
  const parsed = secretsSchema.parse(s);
  if (parsed.keySource === "file" && !parsed.apiKey) throw new Error("apiKey is required when keySource is file");
  if (parsed.keySource === "file" && fingerprintKey(parsed.apiKey?.trim() ?? "") !== parsed.fingerprint) {
    throw new Error("fingerprint does not match apiKey");
  }
  const data: RouterSecrets = {
    v: 1,
    consent: parsed.consent,
    keySource: parsed.keySource,
    fingerprint: parsed.fingerprint,
  };
  if (parsed.keySource === "file") data.apiKey = parsed.apiKey;
  const dir = keysDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort on platforms without chmod semantics
  }
  const file = secretsFile();
  const tmp = path.join(dir, `${SECRETS_FILE_NAME}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // best effort
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function removeRouterSecrets(): boolean {
  const file = secretsFile();
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

export function hasValidConsent(secrets: RouterSecrets | null = readRouterSecrets()): boolean {
  return secrets !== null && secrets.consent.version === CONSENT_VERSION;
}

/**
 * The file key when keySource is "file". The env key only when keySource is
 * "env" AND its fingerprint matches the one saved at setup, so a
 * `TYPESAFE_API_KEY=… c2c route …` prefix cannot swap the key.
 */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): ResolvedKey | null {
  const secrets = readRouterSecrets();
  if (!secrets || !hasValidConsent(secrets)) return null;
  if (secrets.keySource === "file") {
    const key = secrets.apiKey?.trim();
    if (!key) return null;
    return { key, source: "file", fingerprint: fingerprintKey(key) };
  }
  const envKey = env.TYPESAFE_API_KEY?.trim();
  if (!envKey) return null;
  const fingerprint = fingerprintKey(envKey);
  if (fingerprint !== secrets.fingerprint) return null;
  return { key: envKey, source: "env", fingerprint };
}

/** Safe to print: never contains the key itself. */
export function keyStatus(env: NodeJS.ProcessEnv = process.env): KeyStatus {
  const secrets = readRouterSecrets();
  if (!secrets) return { configured: false, source: null, fingerprint8: null };
  return {
    configured: resolveApiKey(env) !== null,
    source: secrets.keySource,
    fingerprint8: secrets.fingerprint.slice(0, 8),
  };
}

export function consentStatus(): ConsentStatus {
  const secrets = readRouterSecrets();
  return {
    accepted: hasValidConsent(secrets),
    version: secrets?.consent.version ?? null,
    current: CONSENT_VERSION,
  };
}
