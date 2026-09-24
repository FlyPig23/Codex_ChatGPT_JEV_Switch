# Security Model

## Trust boundaries

1. **Workspace root** is the smallest authorization boundary. One bridge serves
   exactly one workspace; every token is bound to `workspace_id`; a token for
   project A returns 403 on project B's bridge.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Every MCP tool description carries an explicit warning and
   tools never grant capabilities based on file content.
3. **The model never sees long-lived credentials.** Computer Use only ever
   handles the one-time pairing code. Access/refresh tokens travel only inside
   the OAuth redirect/token endpoints between ChatGPT's client and the bridge.
4. **Smart routing sends a small, sanitized text payload to a third party only
   after you opt in.** After `c2c route setup` in your own terminal, a routing
   decision may send a small payload to TypeSafe at the fixed endpoint
   `https://api.typesafe.ai`. Jev's answers are advisory. Code-enforced floors
   (your explicit request, high-risk paths, risky follow-ups, needs-you errors)
   can be raised but never lowered by Jev, and any failure falls back to
   upstream behavior.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request requires a valid bearer token (401 without, 403 wrong workspace) |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` reveals only a salted workspace hash |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404 |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |
| Execution output leak | Codex may nominate test/build/lint logs; a local sanitizer redacts tokens (including API-key shapes, JWTs, URL passwords, quoted JSON secrets and `*_SECRET=`-style assignments), pairing-code-shaped strings and home paths, truncates size, and refuses private-key blocks entirely. Restricted items are listed without a body. `c2c record --output-file` refuses symlinks, sensitive paths, credential dirs such as `~/.ssh`, and C2C's own state and key dirs. ChatGPT still cannot run commands. |
| Checkpoint / resume dump | Session checkpoints store short protocol fields only (capped). Resume uses the existing chat or HANDOFF — no new protocol state, no log paste, no re-pairing. |
| Secrets in routed text | Routed text passes code stripping, the shared sanitizer, extra third-party redactions (API-key shapes, JWTs, URL passwords, quoted JSON secrets, `*_SECRET=`-style assignments, labelled values such as `password：…` / `密码是 …` / `token: …`, `curl -u user:pw`, `mysql -p…`, `redis-cli -a …`, `--password` / `--token` flags, emails, public IPs, high-entropy runs, the configured TypeSafe key), size caps and a strict per-point schema that rejects unknown keys. A private-key block cancels the call. Whole files, diffs and full logs are never sent; the error lines and follow-up items are sent as written (after redaction), so they can include file paths, hostnames and the failing source lines. Output files are read only through a guard that rejects symlinks, sensitive paths, `~/.ssh`-style credential dirs and C2C's own state and key dirs. |
| Routing key theft or swap | The key lives outside the Codex sandbox's writable roots (dir 0700, file 0600) and is never printed (`status` shows an 8-char fingerprint). An env key is used only if its hash matches the fingerprint stored at setup, so a `TYPESAFE_API_KEY=… c2c route …` prefix cannot swap it. Endpoint, model and logging are pinned in code; `TYPESAFE_BASE_URL` and similar env vars are ignored. |
| Prompt injection steering routes | `next` and `say` are fixed templates that never echo input; every Jev question marks its field as data; floors are computed in code and Jev can only raise them; skipping a review is never Jev's call (the review gate is deterministic, and follow-ups skip review only after ChatGPT itself said DONE). Adversarial fixtures and a canary test cover this. |
| Router unavailable | No key, no network, timeout, rate limit or an open breaker all fall back to deterministic rules that never escalate at intake and never skip a review upstream would have done. Every `c2c route` decision point exits 0 with valid JSON. |
| Silent enablement | Off by default. Consent is recorded only by `c2c route setup` run in your own terminal (it refuses without a TTY or inside Codex) and lives next to the key, outside the sandbox roots. An exported `TYPESAFE_API_KEY` alone does nothing. `.c2c.json` in a repo cannot configure routing. A per-command env prefix (`C2C_STATE_DIR`, `C2C_KEYS_DIR`, `HOME`, `XDG_STATE_HOME`) can point one `c2c route` call at other state or key files; that lasts for that one call only (nothing persists), and it is no more than an agent that can run commands as you can already do. |

## Token & scope design

Scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`offline_access`. Tools enforce scopes individually (`INSUFFICIENT_SCOPE`).
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. All tokens bound to
`workspace_id` and `client_id`.

## Storage

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. Named-hostname preference and tunnel metadata live there too
(`tunnels/<workspaceId>.json`) — never in the project. Only SHA-256 hashes of
tokens are persisted — a stolen state file does not yield usable bearer tokens.
Exception: the optional TypeSafe API key is stored raw (the API requires it)
in a separate 0700 directory outside the Codex sandbox's writable roots.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain
integration is a V2 item.

## Smart routing (TypeSafe Jev): what leaves your machine

Nothing, unless you ran `c2c route setup` yourself. After that, only these
fields go to `https://api.typesafe.ai` ([routing.md](routing.md)):

| Point | Sent (max) | Never sent |
| --- | --- | --- |
| intake | `request`: the user's message, code blocks stripped, sanitized, ≤1500 chars | file contents, diffs, logs, workspace metadata, checkpoint data (a path goes out only if you wrote it in the message) |
| failure (from the 2nd failure) | `command` ≤200 (redacted), `error_lines` ≤40 lines / 2000 chars from the local output file (as printed, after redaction: may include file paths, hostnames and the failing source lines) | the task goal, full logs, previous excerpts, restricted outputs, paths outside the error lines |
| review_gate | nothing (no Jev) | (none) |
| reply | `followups[]` ≤12 × 300 chars, long code stripped, sanitized (file names and paths written in an item stay) | the rest of ChatGPT's reply, code blocks |

No call is made for a confidentiality phrase (保密 / 不要上传 / confidential…,
which also stops ChatGPT from being brought in automatically for that task), a
private-key block anywhere in the text, a deterministic early exit, or a
disabled workspace. Router logs keep numbers and enums only — never the text.

Retention: TypeSafe states that it does not train on inputs. It keeps them "as
long as reasonably necessary", with no fixed period; zero data retention is
available to enterprise customers only. For a repository whose content must not
reach another processor, run `c2c route disable -w <repo>` (or keep routing off
with `c2c route prefs set --mode off`).

The key is protected from being printed, entering the chat transcript, being
swapped persistently from inside the sandbox, or being sent anywhere but the
fixed endpoint. Codex runs as you, so it can technically read the key file;
the Skills forbid it.

## What ChatGPT can never do (V1)

Write files, delete files, run shell commands, commit, install packages —
these tools do not exist on the server, so no prompt injection, scope bug, or
UI confusion can enable them.
