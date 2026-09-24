import type { FailureKind } from "./types.js";

/**
 * Specific signatures that win over the ordered table below (an engine mismatch prints
 * `Expected version ">=18"`, which would otherwise read as an assertion).
 */
export const FAILURE_KIND_OVERRIDES: ReadonlyArray<readonly [FailureKind, RegExp]> = [
  [
    "environment_or_tooling",
    /The engine "[^"]+" is incompatible|\bEBADENGINE\b|Unsupported engine|UNSUPPORTED_ENGINE|Expected version:?\s*["']?(?:>=|<=|>|<|\^|~)/i,
  ],
];

/** §4.2 heuristic table; the first kind whose pattern matches any line wins, in this order. */
export const FAILURE_KIND_PATTERNS: ReadonlyArray<readonly [FailureKind, RegExp]> = [
  ["compile_or_type_error", /\bTS\d{4}\b|SyntaxError|is not assignable|\berror\[E\d{4}\]/],
  ["missing_module_or_dependency", /cannot find module|ModuleNotFoundError|ImportError|Failed to resolve import/i],
  ["assertion_mismatch", /\bExpected\b|\bReceived\b|AssertionError|toEqual/],
  ["runtime_exception", /Traceback|Uncaught|panic|TypeError:/],
  [
    "environment_or_tooling",
    /command not found|EADDRINUSE|requires .* version|is not recognized as an internal or external command|不是内部或外部命令|Can't reach database server|\bP1001\b|ECONNREFUSED.*:(?:5432|5433|3306|6379|27017|1433|9042|11211)\b|(?:postgres|mysql|mariadb|redis|mongo)\w*\b.*ECONNREFUSED|ECONNREFUSED.*\b(?:postgres|mysql|mariadb|redis|mongo)/i,
  ],
  ["timeout_or_flaky", /timed out|ETIMEDOUT|ECONNRESET|Exceeded timeout of/i],
];

/**
 * Failures only the user can fix (login, keys, payment, OS permission). HTTP-ish status codes
 * are skipped when they are a line number (`a.ts:401:12`, `a.ts(401,5)`, `x.go:402`, `line 403`,
 * a `402 |` code frame) or timestamp milliseconds (`20:15:53.401`). "Run … login" counts only for a
 * quoted command or a known CLI (`run \`vercel login\``, `gh auth login`), not app text such as
 * "failed to run the login migration".
 */
export const NEEDS_USER_RE =
  /EACCES|EPERM|permission denied|(?<!\.|[\w.\/\\-]:|\bline )\b40[123]\b(?![:,]\d|\s*\|)|unauthori[sz]ed|forbidden|login required|not logged in|not authenticated|must be logged in|\brun(?:ning)?:?\s+(?:[`'"](?:npx\s+)?[\w.@/-]+|(?:npx\s+)?(?:npm|pnpm|yarn|gh|glab|vercel|netlify|wrangler|firebase|heroku|flyctl|fly|docker|az|gcloud|aws|supabase|railway|doctl|expo|eas))(?:\s+(?:auth|sso))?\s+login\b|api[_ ]?key|credentials?|quota exceeded|payment required/i;

/**
 * Lines that are about a test, not a tool asking for the user, never count: assertions (a test
 * expecting a 401), diff lines (`- 401`, `+ 200`), test-reporter titles (`× GET /me > returns
 * 401`, `● login › rejects unauthorized users`, ` FAIL …`, `--- FAIL: TestUnauthorized`), code
 * frames (`> 12 | expect(…)`) and Go's `got 200, want 401`.
 */
export const NEEDS_USER_EXCLUDE_RE =
  /expect|assert|received|toBe|toEqual|^\s*[-+]\s|^\s*(?:[×✗✕✘●❯→]|FAIL\b|--- FAIL)|\s[>›]\s|^\s*>?\s*\d+\s*\||\bgot\b.*\bwant\b/i;

/** Test-count summaries (`Tests  1 failed | 401 passed (402)`, `402 total`) are not status codes. */
const TEST_COUNT_RE =
  /\b\d+\s+(?:passed|failed|skipped|todo|total|tests?|pending|passing|failing|suites?|snapshots?|errors?|warnings?)\b|\(\d+\)/gi;

function toLines(lines: string | readonly string[]): readonly string[] {
  return typeof lines === "string" ? lines.split(/\r?\n/) : lines;
}

export function heuristicFailureKind(lines: string | readonly string[]): FailureKind {
  const list = toLines(lines);
  for (const [kind, pattern] of [...FAILURE_KIND_OVERRIDES, ...FAILURE_KIND_PATTERNS]) {
    if (list.some((line) => pattern.test(line))) return kind;
  }
  return "other";
}

export function needsUserRegex(lines: string | readonly string[]): boolean {
  return toLines(lines).some(
    (line) => !NEEDS_USER_EXCLUDE_RE.test(line) && NEEDS_USER_RE.test(line.replace(TEST_COUNT_RE, " "))
  );
}
