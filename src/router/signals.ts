import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { normalizePublicUrl, readLastEndpoint, type LastEndpoint } from "../config/endpoint.js";
import { probeBridge, readRuntimeState, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch } from "../process/daemon.js";
import { isNamedTunnelReady, readTunnelState, type TunnelState } from "../tunnel/state.js";
import { readSession, resolveConversation, type SavedSession } from "../session/state.js";
import type { Workspace } from "../workspace/manager.js";
import { NEEDS_USER_RE, needsUserRegex } from "./heuristics.js";
import { stripCode } from "./outbound.js";
import { HIGH_RISK_PATH_CATEGORIES } from "./policy.js";
import {
  CONNECTIONS,
  type ActiveCheckpointView,
  type Baseline,
  type Connection,
  type PathCategory,
  type SizeBucket,
} from "./types.js";

export type { ActiveCheckpointView, Baseline };
export { NEEDS_USER_RE };

// ---------------------------------------------------------------- explicit route / confidentiality (§3.6)

/** Negation first; a codex match wins over a chatgpt match. */
export const CODEX_ONLY_PATTERNS: readonly RegExp[] = [
  /(?:(?<![特区分告识级性类鉴辨个差派])别|(?<!要)不要|(?<!用)不用|无需|先别|不必|(?<!需)不需要|甭)\s*(?:再)?\s*(?:用|让|问|找|麻烦|交给|管|经过|通过|走)?\s*(?:网页版\s*)?(?:chat[\s-]*gpt|gpt)/i,
  /(?<![要用需])不\s*(?:再)?\s*(?:让|问|找|麻烦|交给|需要)\s*(?:网页版\s*)?(?:chat[\s-]*gpt|gpt)/i,
  /\b(?:don['’]?t|do not|no need to|never)\s+(?:use|ask|involve|call)\s+chat[\s-]*gpt\b/i,
  /\b(?:don['’]?t|do not)\s+(?:bother|need)\s+(?:to\s+)?(?:use|ask|involve|call)\s+chat[\s-]*gpt\b/i,
  /\bwithout\s+chat[\s-]*gpt\b/i,
];

export const CHATGPT_PATTERNS: readonly RegExp[] = [
  /使用\s*codex\s*with\s*chat[\s-]*gpt/i,
  /\buse\s+codex\s+with\s+chat[\s-]*gpt\b/i,
  /(?<!(?:上次|之前|刚才|刚刚|已经|昨天|以前)\s*)(?:(?<![调采应作费信引启禁停复通实])用|让|请|(?<!访)问|交给|找)\s*(?:网页版\s*)?(?:chat[\s-]*gpt|gpt)\s*(?:来|先|帮|去|规划|设计|看|复核|review|想)(?![过了的])/i,
  /\b(?:ask|have|let|use)\s+chat[\s-]*gpt\s+(?:to\s+)?(?:plan|design|review|help|look)/i,
];

export const NO_EGRESS_RE =
  /(保密|机密|不要上传|别上传|不能上传|勿上传|禁止上传|不能外传|不要外传|别外传|不得外传|严禁外传|不要发给第三方|别发给第三方|不要传给第三方|confidential|do not upload|don['’]?t upload|under nda)/i;

function normalizeRequest(text: string): string {
  return stripCode(text.normalize("NFKC")).replace(/[\u200b-\u200d\u2060\ufeff]/g, "");
}

export function detectExplicitRoute(text: string): "chatgpt" | "codex" | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const normalized = normalizeRequest(text);
  if (CODEX_ONLY_PATTERNS.some((re) => re.test(normalized))) return "codex";
  if (CHATGPT_PATTERNS.some((re) => re.test(normalized))) return "chatgpt";
  return null;
}

export function detectNoEgress(text: string): boolean {
  if (typeof text !== "string" || text === "") return false;
  return NO_EGRESS_RE.test(text.normalize("NFKC"));
}

// ---------------------------------------------------------------- failure signals (§4.2)

export const ERROR_LINE_RE =
  /error|fail|assert|expected|received|exception|traceback|panic|TS\d{4}|\bE\d{3,4}\b|cannot|not found|undefined|denied|refused|timed out|exceeded timeout/i;

const ERROR_CONTEXT = 2;
const DEFAULT_ERROR_MAX_LINES = 40;
const DEFAULT_ERROR_MAX_CHARS = 2000;
const FALLBACK_TAIL_LINES = 20;
const MAX_ERROR_LINE_CHARS = 400;
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function splitOutputLines(raw: string): string[] {
  return raw
    .replace(ANSI_RE, "")
    .split(/\r?\n/)
    .map((line) => {
      const cr = line.lastIndexOf("\r");
      const visible = cr === -1 ? line : line.slice(cr + 1);
      return visible.replace(/\s+$/, "");
    });
}

function capLine(line: string): string {
  if (line.length <= MAX_ERROR_LINE_CHARS) return line;
  let end = MAX_ERROR_LINE_CHARS - 1;
  const code = line.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${line.slice(0, end)}…`;
}

/**
 * Error lines (±2 lines of context), de-duplicated, keeping the tail within
 * `maxLines` / `maxChars`. Falls back to the last 20 lines when nothing matches.
 * Not sanitized: callers pass the result through sanitizeForThirdParty.
 */
export function extractErrorLines(raw: string, opts: { maxLines?: number; maxChars?: number } = {}): string[] {
  const maxLines = Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_ERROR_MAX_LINES));
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_ERROR_MAX_CHARS));
  if (typeof raw !== "string" || raw === "") return [];
  const lines = splitOutputLines(raw);

  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (!ERROR_LINE_RE.test(line)) return;
    for (let j = Math.max(0, i - ERROR_CONTEXT); j <= Math.min(lines.length - 1, i + ERROR_CONTEXT); j++) keep.add(j);
  });

  let picked: string[];
  if (keep.size > 0) {
    picked = [...keep].sort((a, b) => a - b).map((i) => lines[i]);
  } else {
    picked = lines.filter((line) => line.trim() !== "").slice(-FALLBACK_TAIL_LINES);
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const line of picked) {
    if (line.trim() === "") continue;
    const capped = capLine(line);
    if (seen.has(capped)) continue;
    seen.add(capped);
    unique.push(capped);
  }

  const out: string[] = [];
  let chars = 0;
  for (let i = unique.length - 1; i >= 0 && out.length < maxLines; i--) {
    const cost = unique[i].length + (out.length > 0 ? 1 : 0);
    if (chars + cost > maxChars) {
      if (out.length === 0) out.unshift(unique[i].slice(-maxChars));
      break;
    }
    out.unshift(unique[i]);
    chars += cost;
  }
  return out;
}

const SIGNATURE_LINES = 5;
const PATH_TOKEN_RE = /(?:[a-z]:)?(?:file:\/\/)?(?:[\w.@~+-]*[\\/])+[\w.@~+-]*/g;
const HEX_PREFIXED_RE = /\b0x[0-9a-f]+\b/g;
const HEX_RUN_RE = /\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/g;

export function normalizeErrorLine(line: string): string {
  return line
    .toLowerCase()
    .replace(PATH_TOKEN_RE, "<p>")
    .replace(HEX_PREFIXED_RE, "<h>")
    .replace(HEX_RUN_RE, "<h>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** sha1 (hex) of the first 5 normalized error lines. */
export function errorSignature(lines: readonly string[]): string {
  const head = lines
    .map(normalizeErrorLine)
    .filter((line) => line !== "")
    .slice(0, SIGNATURE_LINES);
  return createHash("sha1").update(head.join("\n")).digest("hex");
}

const COMMAND_KEY_TOKENS = 3;
const COMMAND_KEY_MAX = 80;
const SHELL_SETUP = new Set(["cd", "pushd", "popd", "export", "source", ".", "set", "unset"]);

/** `pnpm test src/a.test.ts` → `pnpm test`. Stable across runs of the same check. */
export function commandKey(command: string): string {
  if (typeof command !== "string") return "unknown";
  const segments = command
    .toLowerCase()
    .split(/&&|\|\||;|\n/)
    .map((segment) => segment.split(/\s\|\s?|\|(?!\|)|\s\d?>{1,2}|\s<|\s&>/)[0].trim())
    .filter((segment) => segment !== "");
  const commands = segments
    .map((segment) => segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .filter((tokens) => tokens.length > 0 && !SHELL_SETUP.has(tokens[0]));
  const tokens = commands[commands.length - 1] ?? [];

  let i = 0;
  while (i < tokens.length && (tokens[i] === "env" || /^[a-z_][a-z0-9_]*=/.test(tokens[i]))) i++;
  const kept = tokens
    .slice(i)
    .filter(
      (token) =>
        token !== "--" &&
        !token.startsWith('"') &&
        !token.startsWith("'") &&
        !token.includes("/") &&
        !token.includes("\\") &&
        !/\.(test|spec)\.[\w.]+$/.test(token) &&
        !/^test_[\w-]+\.py$|_test\.(py|go)$/.test(token)
    )
    .slice(0, COMMAND_KEY_TOKENS)
    .join(" ");
  return kept.slice(0, COMMAND_KEY_MAX) || "unknown";
}

/** Only on lines that are not assertions (a test expecting a 401 never triggers it). */
export function matchesNeedsUser(lines: string | readonly string[]): boolean {
  return needsUserRegex(lines);
}

// ---------------------------------------------------------------- path categories and size (§4.3)

export const HIGH_RISK_CATEGORIES: ReadonlySet<PathCategory> = new Set(HIGH_RISK_PATH_CATEGORIES);
export const MEDIUM_RISK_CATEGORIES: ReadonlySet<PathCategory> = new Set<PathCategory>(["deps_manifest", "infra"]);

/** First match wins; high categories first, then medium, then low. */
export const PATH_CATEGORY_RULES: ReadonlyArray<readonly [PathCategory, RegExp]> = [
  [
    "auth_security",
    /(^|[/._-])(auth|oauth|login|sessions?|security|crypto|permissions?|acl|rbac|jwt|passwords?|secrets?)([/._-]|\d|$)/,
  ],
  ["payments", /(^|[/._-])(payments?|billing|checkout|stripe)([/._-]|\d|$)/],
  ["data_migration", /(^|\/)(migrations?|migrate|alembic|schema)([/._-]|$)|\.sql$|schema\.prisma$/],
  ["ci_pipeline", /^\.github\/workflows\/|^\.gitlab-ci|^\.circleci\/|azure-pipelines|jenkinsfile/],
  [
    "agent_config",
    /(^|\/)(agents\.md|claude\.md|\.c2c\.json|\.c2cignore)$|(^|\/)\.codex\/|(^|\/)\.claude\/|(^|\/)skill\.md$/,
  ],
  ["install_scripts", /(^|\/)(pre|post)?install\.(sh|js|ts|ps1)$/],
  [
    "deps_manifest",
    /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|requirements[\w.-]*\.txt|pyproject\.toml|poetry\.lock|pipfile(\.lock)?|uv\.lock|go\.mod|go\.sum|cargo\.toml|cargo\.lock|gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?)$/,
  ],
  [
    "infra",
    /(^|\/)dockerfile([._-][\w.-]*)?$|\.dockerfile$|(^|\/)\.dockerignore$|(^|\/)(docker-)?compose[\w.-]*\.ya?ml$|\.tf$|\.tfvars$|(^|\/)(k8s|kubernetes|helm|charts?)\/.*\.ya?ml$|(^|\/)chart\.ya?ml$/,
  ],
  [
    "tests",
    /(^|\/)(tests?|__tests__|spec|specs|e2e|__mocks__|fixtures?)\/|\.(test|spec)\.[\w]+$|(^|\/)test_[\w-]+\.py$|_test\.(go|py)$|(^|\/)conftest\.py$/,
  ],
  [
    "docs",
    /\.(md|mdx|rst|adoc|txt)$|(^|\/)(docs?|documentation)\/|(^|\/)(readme|changelog|license|contributing|authors|notice)([._-][\w.-]*)?$/,
  ],
  [
    "config",
    /(^|\/)(tsconfig[\w.-]*\.json|jsconfig\.json|\.eslintrc[\w.-]*|\.prettierrc[\w.-]*|\.editorconfig|\.gitignore|\.gitattributes|\.npmrc|\.nvmrc|\.node-version|\.env\.example|makefile|[\w.-]+\.config\.[cm]?[jt]s)$|\.(ya?ml|toml|ini|cfg|conf|properties)$|(^|\/)(config|\.vscode)\//,
  ],
];

function normalizeRelPath(relPath: string): string {
  return relPath
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

export function classifyPath(relPath: string): PathCategory {
  if (typeof relPath !== "string" || relPath.trim() === "") return "other";
  const p = normalizeRelPath(relPath.trim());
  for (const [category, re] of PATH_CATEGORY_RULES) {
    if (re.test(p)) return category;
  }
  return "other";
}

/** Distinct categories of `paths`, in first-seen order. */
export function classifyPaths(paths: readonly string[]): PathCategory[] {
  const out: PathCategory[] = [];
  for (const p of paths) {
    const category = classifyPath(p);
    if (!out.includes(category)) out.push(category);
  }
  return out;
}

export function pathRisk(category: PathCategory): "high" | "medium" | "low" {
  if (HIGH_RISK_CATEGORIES.has(category)) return "high";
  if (MEDIUM_RISK_CATEGORIES.has(category)) return "medium";
  return "low";
}

const SIZE_LIMITS: ReadonlyArray<readonly [SizeBucket, number, number]> = [
  ["tiny", 2, 40],
  ["small", 5, 150],
  ["medium", 8, 300],
  ["large", 20, 800],
];

export function sizeBucket(files: number, lines: number): SizeBucket {
  for (const [bucket, maxFiles, maxLines] of SIZE_LIMITS) {
    if (files <= maxFiles && lines <= maxLines) return bucket;
  }
  return "xlarge";
}

// ---------------------------------------------------------------- baseline + task changes (§4.3)

export const BASELINE_MAX_PATHS = 300;
const HASH_CAP_BYTES = 1024 * 1024;
const LINE_COUNT_CAP = 5000;
const LINE_COUNT_MAX_FILES = 300;
const LINE_COUNT_MAX_BYTES = 8 * 1024 * 1024;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;

type GitWorkspace = Pick<Workspace, "root" | "ignoreRules">;

interface DirtyEntry {
  rel: string;
  tracked: boolean;
  /** Tracked entries: `<worktree mode>:<HEAD blob id>` from `git status --porcelain=v2`. */
  git?: string;
}

function gitRaw(root: string, args: string[]): { ok: boolean; stdout: Buffer } {
  try {
    const result = spawnSync("git", args, {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return {
      ok: result.status === 0 && !result.error,
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    };
  } catch {
    return { ok: false, stdout: Buffer.alloc(0) };
  }
}

function gitText(root: string, args: string[]): string | null {
  const result = gitRaw(root, args);
  return result.ok ? result.stdout.toString("utf8") : null;
}

function isGitWorkTree(root: string): boolean {
  return gitText(root, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

function headCommit(root: string): string | null {
  const out = gitText(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const head = out?.trim() ?? "";
  return /^[0-9a-f]{7,64}$/.test(head) ? head : null;
}

/** Dirty paths from `git status --porcelain=v2 -z`, relative to the workspace root. */
function dirtyEntries(root: string): DirtyEntry[] | null {
  const prefix = gitText(root, ["rev-parse", "--show-prefix"]);
  if (prefix === null) return null;
  const strip = prefix.trim();
  const out = gitText(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames", "--", "."]);
  if (out === null) return null;

  const entries: DirtyEntry[] = [];
  const seen = new Set<string>();
  const add = (repoRel: string, tracked: boolean, git?: string): void => {
    if (!repoRel) return;
    const rel = strip && repoRel.startsWith(strip) ? repoRel.slice(strip.length) : repoRel;
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    entries.push(git === undefined ? { rel, tracked } : { rel, tracked, git });
  };
  // v2 records: `1 XY sub mH mI mW hH hI path`, `2 XY sub mH mI mW hH hI Xscore path\0orig`,
  // `u XY sub m1 m2 m3 mW h1 h2 h3 path` (h2 = the HEAD / "ours" stage)
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("1 ")) {
      const f = token.split(" ");
      add(f.slice(8).join(" "), true, `${f[5]}:${f[6]}`);
    } else if (token.startsWith("2 ")) {
      const f = token.split(" ");
      add(f.slice(9).join(" "), true, `${f[5]}:${f[6]}`);
      i++; // original path of a rename/copy
    } else if (token.startsWith("u ")) {
      const f = token.split(" ");
      add(f.slice(10).join(" "), true, `${f[6]}:${f[8] ?? "0"}`);
    } else if (token.startsWith("? ")) {
      add(token.slice(2), false);
    }
  }
  return entries;
}

function isSensitivePath(ws: GitWorkspace, rel: string): boolean {
  try {
    return ws.ignoreRules.isSensitive(rel.replace(/\/+$/, "")) || ws.ignoreRules.isSensitive(path.posix.basename(rel));
  } catch {
    return true;
  }
}

function sha1(data: Buffer | string): string {
  return createHash("sha1").update(data).digest("hex");
}

function readHead(abs: string, maxBytes: number): Buffer {
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    let total = 0;
    while (total < maxBytes) {
      const n = fs.readSync(fd, buf, total, maxBytes - total, null);
      if (n === 0) break;
      total += n;
    }
    return buf.subarray(0, total);
  } finally {
    fs.closeSync(fd);
  }
}

/** sha1 of the first 1 MB plus the byte size, so most edits past 1 MB still change it. */
function contentHash(abs: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return "missing";
  }
  try {
    if (stat.isSymbolicLink()) return `link:${sha1(fs.readlinkSync(abs))}`;
    if (stat.isDirectory()) return "dir";
    if (!stat.isFile()) return "special";
    return `${sha1(readHead(abs, HASH_CAP_BYTES))}:${stat.size}`;
  } catch {
    return "unreadable";
  }
}

/**
 * One in-process hash per dirty path (no git spawn per file). Tracked: worktree mode + HEAD blob
 * id (both from the single `git status` call) + worktree content, so it changes when the content,
 * the mode or the HEAD version changes. Staging alone does not count as a change.
 */
function entryHash(ws: GitWorkspace, entry: DirtyEntry): string {
  const abs = path.join(ws.root, entry.rel);
  if (isSensitivePath(ws, entry.rel)) {
    try {
      return `sensitive:${Math.floor(fs.lstatSync(abs).mtimeMs)}`;
    } catch {
      return "sensitive:missing";
    }
  }
  const content = contentHash(abs);
  return entry.tracked && entry.git ? `${entry.git}:${content}` : content;
}

/** HEAD plus a hash per dirty path, so later changes can be told apart from pre-existing ones. Null outside git. */
export function captureBaseline(ws: GitWorkspace): Baseline | null {
  try {
    if (!isGitWorkTree(ws.root)) return null;
    const dirty = dirtyEntries(ws.root);
    if (dirty === null) return null;
    const head = headCommit(ws.root);
    const entries: Record<string, string> = {};
    for (const entry of dirty.slice(0, BASELINE_MAX_PATHS)) {
      entries[entry.rel] = entryHash(ws, entry);
    }
    return { head, entries, truncated: dirty.length > BASELINE_MAX_PATHS };
  } catch {
    return null;
  }
}

function countFileLines(abs: string): number {
  let fd: number | null = null;
  try {
    const stat = fs.lstatSync(abs);
    if (!stat.isFile()) return 0;
    fd = fs.openSync(abs, "r");
    const chunk = Buffer.alloc(64 * 1024);
    let lines = 0;
    let read = 0;
    let first = true;
    let lastByte = -1;
    while (read < LINE_COUNT_MAX_BYTES) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      const view = chunk.subarray(0, n);
      if (first && view.subarray(0, 8192).includes(0)) return 0;
      first = false;
      for (let i = 0; i < n; i++) {
        if (view[i] === 0x0a) {
          lines++;
          if (lines >= LINE_COUNT_CAP) return LINE_COUNT_CAP;
        }
      }
      lastByte = view[n - 1];
      read += n;
    }
    if (lastByte !== -1 && lastByte !== 0x0a) lines++;
    return Math.min(lines, LINE_COUNT_CAP);
  } catch {
    return 0;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function numstat(root: string): Map<string, number> {
  const map = new Map<string, number>();
  const out = gitText(root, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--numstat",
    "-z",
    "--relative",
    "HEAD",
    "--",
    ".",
  ]);
  if (out === null) return map;
  for (const record of out.split("\0")) {
    const m = record.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
    if (!m) continue;
    const added = m[1] === "-" ? 0 : Number(m[1]);
    const deleted = m[2] === "-" ? 0 : Number(m[2]);
    map.set(m[3], added + deleted);
  }
  return map;
}

export interface TaskChanges {
  paths: string[];
  files: number;
  lines: number;
  headMoved: boolean;
  isGitRepo: boolean;
  /** Subset of `paths` matching the sensitive-file policy (never read; keep them out of anything sent to ChatGPT). */
  sensitivePaths: string[];
}

/** Dirty paths that are new since the baseline or whose hash changed (all dirty paths when the baseline is missing or truncated). */
export function taskChanges(ws: GitWorkspace, baseline: Baseline | null): TaskChanges {
  const empty: TaskChanges = { paths: [], files: 0, lines: 0, headMoved: false, isGitRepo: false, sensitivePaths: [] };
  try {
    if (!isGitWorkTree(ws.root)) return empty;
    const head = headCommit(ws.root);
    const headMoved = baseline !== null && (baseline.head ?? null) !== head;
    const dirty = dirtyEntries(ws.root);
    if (dirty === null) return { ...empty, isGitRepo: true, headMoved };

    const compareAll = baseline === null || baseline.truncated;
    const changed = dirty.filter((entry) => {
      if (compareAll) return true;
      const before = baseline.entries[entry.rel];
      if (before === undefined) return true;
      return entryHash(ws, entry) !== before;
    });

    const sensitivePaths: string[] = [];
    let lines = 0;
    let counted = 0;
    let stats: Map<string, number> | null = null;
    for (const entry of changed) {
      if (isSensitivePath(ws, entry.rel)) {
        sensitivePaths.push(entry.rel);
        continue;
      }
      if (entry.tracked && head) {
        stats ??= numstat(ws.root);
        lines += stats.get(entry.rel) ?? 0;
      } else if (counted < LINE_COUNT_MAX_FILES) {
        counted++;
        lines += countFileLines(path.join(ws.root, entry.rel));
      }
    }
    const paths = changed.map((entry) => entry.rel);
    return { paths, files: paths.length, lines, headMoved, isGitRepo: true, sensitivePaths };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------- DONE follow-ups (§4.4)

export const MAX_FOLLOWUP_ITEMS = 12;
export const MAX_FOLLOWUP_CHARS = 300;

export const FOLLOWUP_RISK_RE =
  /(auth(?!or)|login|password|token|secret|permission|oauth|jwt|crypto|migration|schema|drop\s+table|payment|billing|\brac(?:e|es|y|ing)\b|(?<![bc])lock|concurren|登录|鉴权|权限|密码|令牌|密钥|迁移|数据库结构|支付|并发|锁)/i;

const FOLLOWUPS_HEADER_RE = /^\s*[#>*_\s]*follow[\s-]?ups?\s*[*_]*\s*[:：]\s*[*_]*\s*(.*)$/i;
const SECTION_HEADER_RE = /^\s*[#>*_\s]*[A-Z][A-Z0-9_ ]{2,}\s*[*_]*\s*:|^\s*\[C2C\]\s*$/;
const ITEM_RE =
  /^\s*(?:(?:[-*+•·‣▪◦–—]|\d{1,2}[.)]|[a-zA-Z][.)])\s+|\d{1,2}、\s*|[（(]\d{1,2}[)）]\s*)(?:\[[ xX]\]\s+)?(.*\S)\s*$/;
const NONE_RE = /^[(（]?(none|n\/a|no|nothing|无|没有|暂无)[)）]?[.。!！]?$/i;

function capItem(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_FOLLOWUP_CHARS) return flat;
  let end = MAX_FOLLOWUP_CHARS - 1;
  const code = flat.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${flat.slice(0, end)}…`;
}

interface FollowupSection {
  hasHeader: boolean;
  /** Text after `FOLLOWUPS:` on the header line. */
  inline: string | null;
  /** Raw lines of the section (the whole text when there is no header). */
  lines: string[];
}

/** The `FOLLOWUPS:` section up to the next ALLCAPS header, or the whole text when there is no header. */
function followupSection(text: string): FollowupSection {
  let lines = text.replace(ANSI_RE, "").split(/\r?\n/);
  let inline: string | null = null;
  const headerAt = lines.findIndex((line) => FOLLOWUPS_HEADER_RE.test(line));
  const hasHeader = headerAt !== -1;
  if (hasHeader) {
    inline = (lines[headerAt].match(FOLLOWUPS_HEADER_RE)?.[1] ?? "").replace(/[*_]+$/, "").trim();
    const rest = lines.slice(headerAt + 1);
    const end = rest.findIndex((line) => !ITEM_RE.test(line) && SECTION_HEADER_RE.test(line));
    lines = end === -1 ? rest : rest.slice(0, end);
  }
  return { hasHeader, inline, lines };
}

/**
 * Numbered or bulleted items (continuation lines join the previous item), each ≤ 300 chars, at most 12.
 * When the text has a `FOLLOWUPS:` header, only that section is read, up to the next ALLCAPS header.
 */
export function parseFollowups(text: string): string[] {
  return rawFollowupItems(text).slice(0, MAX_FOLLOWUP_ITEMS).map(capItem);
}

/** Uncapped items, in order (parseFollowups caps each at 300 chars and keeps 12). */
function rawFollowupItems(text: string): string[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  const { hasHeader, inline, lines } = followupSection(text);

  const items: string[] = [];
  let current: string | null = null;
  const flush = (): void => {
    if (current !== null && current.trim() !== "") items.push(current);
    current = null;
  };
  if (inline && !NONE_RE.test(inline)) current = inline;

  let bulleted = 0;
  for (const line of lines) {
    const item = line.match(ITEM_RE);
    if (item) {
      flush();
      bulleted++;
      current = item[1];
    } else if (line.trim() === "" || SECTION_HEADER_RE.test(line)) {
      flush();
    } else if (current !== null) {
      current = `${current} ${line.trim()}`;
    }
  }
  flush();

  if (hasHeader && bulleted === 0) {
    const plain = lines.map((line) => line.trim()).filter((line) => line !== "" && !NONE_RE.test(line));
    return inline && !NONE_RE.test(inline) ? [inline, ...plain] : plain;
  }
  return items.map((item) => item.trim()).filter((item) => item !== "" && !NONE_RE.test(item));
}

/**
 * The follow-up risk floor over the raw section, before parsing, capping or dropping lines:
 * any line (or the section joined, for a phrase split across lines) that trips followupIsRisky.
 */
export function followupSectionRisky(text: string): boolean {
  if (typeof text !== "string" || text.trim() === "") return false;
  const { inline, lines } = followupSection(text);
  const all = inline ? [inline, ...lines] : lines;
  return all.some((line) => followupIsRisky(line)) || followupIsRisky(all.join(" "));
}

/** True when the section holds something besides blank lines, "none" markers and ALLCAPS headers. */
function followupSectionHasContent(text: string): boolean {
  if (typeof text !== "string" || text.trim() === "") return false;
  const { inline, lines } = followupSection(text);
  return [inline ?? "", ...lines].some((line) => {
    const body = (line.match(ITEM_RE)?.[1] ?? line).trim();
    return body !== "" && !NONE_RE.test(body) && !SECTION_HEADER_RE.test(line);
  });
}

export interface FollowupAnalysis {
  /** parseFollowups(text). */
  items: string[];
  /**
   * The deterministic review floor. Codex applies the whole section it saved, so this looks past
   * the parsed items: a risky word anywhere in the section, an item longer than the 300 chars Jev
   * would see, or text that parsed into no item at all.
   */
  riskItem: boolean;
}

export function analyzeFollowups(text: string): FollowupAnalysis {
  const raw = rawFollowupItems(text);
  const items = raw.slice(0, MAX_FOLLOWUP_ITEMS).map(capItem);
  const truncated = raw.some((item) => item.replace(/\s+/g, " ").trim().length > MAX_FOLLOWUP_CHARS);
  const unparsed = items.length === 0 && followupSectionHasContent(text);
  const riskItem = items.some(followupIsRisky) || followupSectionRisky(text) || truncated || unparsed;
  return { items, riskItem };
}

const PATH_CANDIDATE_RE = /[A-Za-z0-9_.@~+\-/\\]+/g;
const EXTENSIONLESS_RISKY = new Set(["jenkinsfile"]);

function pathTokens(item: string): string[] {
  return (item.match(PATH_CANDIDATE_RE) ?? [])
    .map((token) => token.replace(/^-+/, "").replace(/[.,;:]+$/, ""))
    .filter(
      (token) =>
        token.includes("/") ||
        token.includes("\\") ||
        /\.[a-z0-9]{1,10}$/i.test(token) ||
        EXTENSIONLESS_RISKY.has(token.toLowerCase())
    );
}

/** Risk regex, or a path token whose category is high risk. */
export function followupIsRisky(item: string): boolean {
  if (typeof item !== "string" || item.trim() === "") return false;
  if (FOLLOWUP_RISK_RE.test(item)) return true;
  return pathTokens(item).some((token) => HIGH_RISK_CATEGORIES.has(classifyPath(token)));
}

// ---------------------------------------------------------------- connection (§3.2)

export interface AdminInfoLike {
  publicUrl?: string | null;
  tunnel?: { url?: string | null } | null;
}

export type BridgeProbe = { state: "healthy"; runtime: RuntimeState } | { state: "stopped" | "unknown" };

export interface ConnectionDeps {
  readLastEndpoint?: (workspaceId: string) => LastEndpoint | null;
  readSession?: (workspaceId: string) => SavedSession | null;
  readTunnelState?: (workspaceId: string) => TunnelState;
  /** Loopback `/health` probe of the workspace's bridge, within `timeoutMs`. */
  observeBridge?: (workspaceId: string, timeoutMs: number) => Promise<BridgeProbe>;
  /** Loopback `GET /admin/info`, within `timeoutMs`. */
  fetchAdminInfo?: (runtime: RuntimeState, timeoutMs: number) => Promise<AdminInfoLike>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export const CONNECTION_PROBE_TIMEOUT_MS = 1000;

async function defaultObserveBridge(workspaceId: string, timeoutMs: number): Promise<BridgeProbe> {
  const runtime = readRuntimeState(workspaceId);
  if (!runtime) return { state: "stopped" };
  const health = await probeBridge(runtime.port, timeoutMs);
  if (health && health.workspaceId === workspaceId) return { state: "healthy", runtime };
  return { state: health ? "unknown" : "stopped" };
}

function defaultFetchAdminInfo(runtime: RuntimeState, timeoutMs: number): Promise<AdminInfoLike> {
  return adminFetch<AdminInfoLike>(runtime, "GET", "/admin/info", timeoutMs);
}

/** Test hook: honored only under vitest. */
function fakeConnection(env: NodeJS.ProcessEnv): Connection | null {
  if (env.VITEST !== "true") return null;
  const value = env.C2C_ROUTER_FAKE_CONNECTION;
  return value && (CONNECTIONS as readonly string[]).includes(value) ? (value as Connection) : null;
}

async function probeInner(
  workspaceId: string,
  deps: Required<Omit<ConnectionDeps, "env">>,
  remaining: () => number
): Promise<Connection> {
  const endpoint = deps.readLastEndpoint(workspaceId);
  if (!endpoint) return "not_setup";
  const conversation = resolveConversation(deps.readSession(workspaceId));
  if (conversation.mode === "project" && !conversation.projectReady) return "needs_project";

  const bridge = await deps.observeBridge(workspaceId, remaining());
  if (bridge.state === "healthy") {
    let info: AdminInfoLike | null = null;
    try {
      info = await deps.fetchAdminInfo(bridge.runtime, remaining());
    } catch {
      info = null;
    }
    const current = info?.publicUrl ?? info?.tunnel?.url ?? null;
    if (
      typeof current === "string" &&
      current.trim() !== "" &&
      typeof endpoint.publicUrl === "string" &&
      endpoint.publicUrl.trim() !== "" &&
      normalizePublicUrl(current) === normalizePublicUrl(endpoint.publicUrl)
    ) {
      return "ready";
    }
    return "needs_repair";
  }
  return isNamedTunnelReady(deps.readTunnelState(workspaceId)) ? "ready_after_restart" : "needs_repair";
}

/** Local reads plus loopback probes only; never repairs anything. Over budget → needs_repair. */
export async function probeConnection(
  ws: Pick<Workspace, "id">,
  opts: { timeoutMs?: number; deps?: ConnectionDeps } = {}
): Promise<Connection> {
  const env = opts.deps?.env ?? process.env;
  const fake = fakeConnection(env);
  if (fake) return fake;

  const deps: Required<Omit<ConnectionDeps, "env">> = {
    readLastEndpoint: opts.deps?.readLastEndpoint ?? readLastEndpoint,
    readSession: opts.deps?.readSession ?? readSession,
    readTunnelState: opts.deps?.readTunnelState ?? readTunnelState,
    observeBridge: opts.deps?.observeBridge ?? defaultObserveBridge,
    fetchAdminInfo: opts.deps?.fetchAdminInfo ?? defaultFetchAdminInfo,
    now: opts.deps?.now ?? Date.now,
  };
  const timeoutMs = Math.max(1, opts.timeoutMs ?? CONNECTION_PROBE_TIMEOUT_MS);
  const deadline = deps.now() + timeoutMs;
  const remaining = (): number => Math.max(1, deadline - deps.now());

  let timer: NodeJS.Timeout | undefined;
  const overBudget = new Promise<Connection>((resolve) => {
    timer = setTimeout(() => resolve("needs_repair"), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([probeInner(ws.id, deps, remaining).catch((): Connection => "needs_repair"), overBudget]);
  } catch {
    return "needs_repair";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Warm = a ChatGPT chat is already open for this thread and the connection is ready.
 * `open` comes from `--thread-chat open`, or a reusable saved chat in long-chat mode.
 */
export function isWarmChat(
  ws: Pick<Workspace, "id">,
  threadChat: "open" | "none" | undefined,
  connection: Connection
): boolean {
  if (connection !== "ready") return false;
  if (threadChat === "open") return true;
  try {
    const view = resolveConversation(readSession(ws.id));
    return view.mode === "long-chat" && view.reuseSavedChat;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- active checkpoint (§3.3)

export const STALE_CHECKPOINT_HOURS = 24;
const GOAL40_MAX = 40;
const MAX_AGE_HOURS = 999_999;

function flattenText(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cs}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cutChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

function ageHoursSince(iso: string | undefined, now: Date): number | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const hours = (now.getTime() - t) / 3_600_000;
  return Math.round(Math.max(0, hours) * 100) / 100;
}

export function activeCheckpointView(ws: Pick<Workspace, "id">, now: Date = new Date()): ActiveCheckpointView | null {
  let session: SavedSession | null;
  try {
    session = readSession(ws.id);
  } catch {
    return null;
  }
  const checkpoint = session?.checkpoint;
  if (!checkpoint || typeof checkpoint !== "object" || typeof checkpoint.taskId !== "string") return null;
  const ageHours = Math.min(
    ageHoursSince(checkpoint.updatedAt, now) ?? ageHoursSince(session?.savedAt, now) ?? MAX_AGE_HOURS,
    MAX_AGE_HOURS
  );
  const protocolState = typeof checkpoint.protocolState === "string" ? checkpoint.protocolState : "INIT";
  return {
    taskId: Array.from(flattenText(checkpoint.taskId)).slice(0, 64).join(""),
    protocolState,
    waitingFor: typeof checkpoint.waitingFor === "string" ? checkpoint.waitingFor : "none",
    ageHours,
    routedBy: checkpoint.routedBy === "router" ? "router" : "user",
    stale: ageHours >= STALE_CHECKPOINT_HOURS || protocolState === "BLOCKED" || protocolState === "DONE",
    goal40: typeof checkpoint.originalGoal === "string" ? cutChars(flattenText(checkpoint.originalGoal), GOAL40_MAX) : "",
  };
}

/** A fresh checkpoint for a different task holds the workspace. */
export function isWorkspaceBusy(view: ActiveCheckpointView | null, taskId: string | null): boolean {
  return view !== null && !view.stale && view.taskId !== taskId;
}
