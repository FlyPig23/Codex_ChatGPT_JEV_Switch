import { z } from "zod";
import type { EntryType } from "@typesafe-ai/sdk";
import { MAX_OUTPUT_LINES, containsPrivateKey, sanitizeExecutionOutput } from "../execution/sanitize.js";

/**
 * The only path by which text reaches TypeSafe: stripCode → upstream
 * sanitizeExecutionOutput → third-party redactions → caps → assertOutbound.
 */

export type OutboundKind = "request" | "request_en" | "goal" | "command" | "error_lines" | "followup";
export type OutboundPoint = "intake" | "failure" | "reply";

export const OUTBOUND_CAPS: Readonly<Record<OutboundKind, { chars: number; lines?: number }>> = {
  request: { chars: 1500 },
  request_en: { chars: 200 },
  goal: { chars: 300 },
  command: { chars: 200 },
  error_lines: { chars: 2000, lines: 40 },
  followup: { chars: 300 },
};

export const MAX_FOLLOWUPS = 12;

const STRIP_CODE_KINDS: ReadonlySet<OutboundKind> = new Set(["request", "request_en", "goal", "followup"]);
const TAIL_KINDS: ReadonlySet<OutboundKind> = new Set(["error_lines"]);
const INLINE_CODE_MAX = 40;
const MIN_KEY_LENGTH = 8;
/** Extra lines kept before sanitizing so a `KEY:` on the line above the cut still redacts its value. */
const PRE_LIMIT_LINE_MARGIN = 5;
const REDACTION_MARKER_RE = /\[REDACTED\]|<email>|<ip>|<secret>|\/Users\/\[user\]|\/home\/\[user\]|C:\\Users\\\[user\]/gi;
const UPSTREAM_TRUNCATION_RE = /\n?…\[truncated\]/g;

// ---------------------------------------------------------------- stripCode

const FENCE_RE = /(`{3,}|~{3,})([\s\S]*?)(?:\1`*|$)/g;
const INLINE_RE = /`([^`\n]+)`/g;
const INFO_STRING_RE = /^[\w+#.-]*$/;

function fencedLineCount(inner: string): number {
  const newline = inner.indexOf("\n");
  let body = inner;
  if (newline !== -1 && INFO_STRING_RE.test(inner.slice(0, newline).trim())) {
    body = inner.slice(newline + 1);
  }
  body = body.replace(/^\n+|\n+$/g, "");
  return body.trim() === "" ? 0 : body.split("\n").length;
}

/** ```fenced``` (also ~~~ and unterminated) → "[code: N lines]"; `inline` longer than 40 chars → "[code]". */
export function stripCode(text: string): string {
  return text
    .replace(FENCE_RE, (_match, _fence: string, inner: string) => `[code: ${fencedLineCount(inner)} lines]`)
    .replace(INLINE_RE, (match, inner: string) => (inner.length > INLINE_CODE_MAX ? "[code]" : match));
}

// ---------------------------------------------------------------- caps (UTF-16 length, never splitting a surrogate pair)

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function sliceHead(text: string, length: number): string {
  let end = Math.max(0, length);
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

function sliceTail(text: string, length: number): string {
  let start = Math.max(0, text.length - length);
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start))) start += 1;
  return text.slice(start);
}

function capHead(text: string, max: number): string {
  return text.length <= max ? text : `${sliceHead(text, max - 1)}…`;
}

function capTail(text: string, max: number): string {
  return text.length <= max ? text : `…${sliceTail(text, max - 1)}`;
}

function capLines(text: string, maxLines: number, tail: boolean): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return (tail ? lines.slice(-maxLines) : lines.slice(0, maxLines)).join("\n");
}

/** Pre-limit so upstream never truncates (no "…[truncated]" marker) and a cut never leaves half a token. */
function preLimit(text: string, kind: OutboundKind): string {
  const cap = OUTBOUND_CAPS[kind];
  const tail = TAIL_KINDS.has(kind);
  const maxLines = cap.lines ? Math.min(cap.lines + PRE_LIMIT_LINE_MARGIN, MAX_OUTPUT_LINES) : MAX_OUTPUT_LINES;
  const out = capLines(text, maxLines, tail);
  const maxChars = cap.chars * 4;
  if (out.length <= maxChars) return out;
  if (tail) {
    const cut = sliceTail(out, maxChars);
    const boundary = cut.search(/\s/);
    return boundary === -1 ? cut : cut.slice(boundary + 1);
  }
  const cut = sliceHead(out, maxChars);
  const boundary = cut.search(/\s\S*$/);
  return boundary === -1 ? cut : cut.slice(0, boundary);
}

function applyCaps(text: string, kind: OutboundKind): string {
  const cap = OUTBOUND_CAPS[kind];
  const tail = TAIL_KINDS.has(kind);
  let out = cap.lines ? capLines(text, cap.lines, tail) : text;
  out = tail ? out.replace(/^\s*\n/, "").trimEnd() : out.trim();
  return tail ? capTail(out, cap.chars) : capHead(out, cap.chars);
}

// ---------------------------------------------------------------- third-party redactions (not in the shared sanitizer)

/**
 * The §7.2 UPPER_SNAKE row as written. The shared sanitizer exempts bare `PASS:` / `KEY:` /
 * `TOKEN:` so ChatGPT can read `--- PASS: TestFoo`; the third-party path does not.
 */
const STRICT_UPPER_SNAKE_RE = /\b([A-Z0-9_]{0,60}(?:SECRET|PASS|TOKEN|KEY|CREDENTIAL)[A-Z0-9_]{0,60}\s*[:=]\s*)\S+/g;
/**
 * A labelled secret value, including Chinese labels, the full-width colon a Chinese IME types, and
 * 「密码是 X」 (not 「密码是否…」). `Unexpected token: '}'` in compiler output is left alone.
 */
const LABELLED_SECRET_RE =
  /((?:密码|口令|密钥|令牌|\b(?:password|passwd|pwd|secret)\b|(?<!unexpected\s)\btoken\b)\s*(?:[:=：]|是(?!否|不是|什么|多少|啥))\s*)(?!\[REDACTED\])[^\s，。、,;；)）]+/gi;
/** Credentials passed on a command line, scoped to the tool so `tsc -p tsconfig.json` is untouched. */
const CLI_SECRET_RES: readonly RegExp[] = [
  /(\bcurl\b[^\n&|;]*?\s(?:-u|--user)[\s=]+[^\s:]+:)(?!\[REDACTED\])\S+/g,
  /(\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^\n&|;]*?\s-p)(?!\s|\[REDACTED\])\S+/g,
  /(\bredis-cli\b[^\n&|;]*?\s-a\s+)(?!\[REDACTED\])\S+/g,
  /(--(?:password|passwd|pass|token)[=\s]+)(?!\[REDACTED\])\S+/gi,
];
const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}\b/g;
const IPV4_RE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)/g;
const HIGH_ENTROPY_RE = /[A-Za-z0-9+/=_-]{32,}/g;
const CONTROL_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]/g;

function isRedactableIpv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] !== 127;
}

/** 32+ base64/hex-ish chars with mixed character classes. */
function isHighEntropy(run: string): boolean {
  const letters = run.replace(/[^A-Za-z]/g, "").length;
  const digits = run.replace(/[^0-9]/g, "").length;
  if (letters === 0 || digits === 0) return false;
  if (/^[0-9a-f-]+$/i.test(run)) return true;
  if (/[A-Z]/.test(run) && /[a-z]/.test(run)) return true;
  return digits / (letters + digits) >= 0.2;
}

function replaceLiteral(text: string, needle: string | undefined): string {
  const key = needle?.trim();
  if (!key || key.length < MIN_KEY_LENGTH) return text;
  return text.split(key).join("[REDACTED]");
}

function applyThirdPartyRedactions(text: string, apiKey: string | undefined): string {
  let out = replaceLiteral(text, apiKey).replace(STRICT_UPPER_SNAKE_RE, (match, prefix: string) =>
    match.slice(prefix.length) === "[REDACTED]" ? match : `${prefix}[REDACTED]`
  );
  out = out.replace(LABELLED_SECRET_RE, "$1[REDACTED]");
  for (const re of CLI_SECRET_RES) out = out.replace(re, "$1[REDACTED]");
  return out
    .replace(EMAIL_RE, "<email>")
    .replace(IPV4_RE, (ip) => (isRedactableIpv4(ip) ? "<ip>" : ip))
    .replace(HIGH_ENTROPY_RE, (run) => (isHighEntropy(run) ? "<secret>" : run));
}

function countMarkers(text: string): number {
  return text.match(REDACTION_MARKER_RE)?.length ?? 0;
}

export type ThirdPartySanitizeResult =
  | { allowed: true; text: string; redactions: number }
  | { allowed: false; reason: "private_key" };

export function sanitizeForThirdParty(
  text: string,
  kind: OutboundKind,
  opts: { apiKey?: string } = {}
): ThirdPartySanitizeResult {
  const normalized = text.replace(/\r\n?/g, "\n").replace(CONTROL_RE, "");
  if (containsPrivateKey(text) || containsPrivateKey(normalized)) return { allowed: false, reason: "private_key" };
  let working = replaceLiteral(normalized, opts.apiKey);
  const keyHits = countMarkers(working) - countMarkers(normalized);
  if (STRIP_CODE_KINDS.has(kind)) working = stripCode(working);
  working = preLimit(working, kind);
  const before = countMarkers(working);
  const shared = sanitizeExecutionOutput(working);
  if (!shared.allowed) return { allowed: false, reason: "private_key" };
  const redacted = applyThirdPartyRedactions(shared.text.replace(UPSTREAM_TRUNCATION_RE, ""), opts.apiKey);
  const redactions = keyHits + Math.max(0, countMarkers(redacted) - before);
  return { allowed: true, text: applyCaps(redacted, kind), redactions };
}

// ---------------------------------------------------------------- outbound manifest

function outboundText(kind: OutboundKind) {
  const cap = OUTBOUND_CAPS[kind];
  return z
    .string()
    .max(cap.chars)
    .superRefine((value, ctx) => {
      if (containsPrivateKey(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "private_key" });
      if (cap.lines && value.split("\n").length > cap.lines) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "too_many_lines" });
      }
    });
}

export const OUTBOUND_SCHEMAS = {
  intake: z
    .object({
      request: outboundText("request").refine((value) => value.trim() !== "", { message: "empty" }),
      request_en: outboundText("request_en").optional(),
    })
    .strict(),
  failure: z
    .object({
      command: outboundText("command"),
      error_lines: outboundText("error_lines"),
    })
    .strict(),
  reply: z
    .object({
      followups: z.array(outboundText("followup")).min(1).max(MAX_FOLLOWUPS),
    })
    .strict(),
} as const;

export type IntakeOutboundState = z.infer<typeof OUTBOUND_SCHEMAS.intake>;
export type FailureOutboundState = z.infer<typeof OUTBOUND_SCHEMAS.failure>;
export type ReplyOutboundState = z.infer<typeof OUTBOUND_SCHEMAS.reply>;

/** Carries field paths and issue codes only — never the rejected text. */
export class OutboundViolationError extends Error {
  readonly point: OutboundPoint;
  readonly issues: string[];

  constructor(point: OutboundPoint, issues: string[]) {
    super(`outbound_rejected:${point} (${issues.join(", ")})`);
    this.name = "OutboundViolationError";
    this.point = point;
    this.issues = issues;
  }
}

function describeIssue(issue: z.ZodIssue): string {
  const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  const what = issue.code === z.ZodIssueCode.custom ? issue.message : issue.code;
  return `${where}:${what}`;
}

export function assertOutbound(point: OutboundPoint, state: unknown): EntryType {
  const schema = OUTBOUND_SCHEMAS[point];
  if (!schema) throw new OutboundViolationError(point, ["(root):unknown_point"]);
  const parsed = schema.safeParse(state);
  if (!parsed.success) throw new OutboundViolationError(point, parsed.error.issues.map(describeIssue));
  return parsed.data as EntryType;
}
