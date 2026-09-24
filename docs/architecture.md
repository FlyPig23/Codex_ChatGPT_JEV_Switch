# Architecture

```
             ┌───────────────────────────┐
             │    ChatGPT Web / Sol      │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │
             │  MCP Server (RO)    │
             │  OAuth AS + PRM     │
             │  Pairing Manager    │
             │  Tunnel Manager     │
             │  Admin API (local)  │
             └──────────┬──────────┘
                        │  read-only
                        ▼
             ┌─────────────────────┐
             │   Local Workspace   │
             └──────────▲──────────┘
                        │ edit / shell / git / test
             ┌──────────┴──────────┐
             │  Codex Harness      │
             │  + c2c-router skill │
             └──────────┬──────────┘
                        │ c2c route <point>  (optional, off by default)
                        ▼
             ┌─────────────────────┐  opt-in    ┌────────────────┐
             │  C2C Router (local) │ ─────────▶ │  TypeSafe Jev  │
             │  policy + floors    │ sanitized  │  typed answers │
             └─────────────────────┘            └────────────────┘
```

## Principles

- **ChatGPT thinks. Codex works.** The bridge never re-implements a coding harness.
- **Computer Use = control plane**: tiny `[C2C]` state messages (< 1 KB).
- **MCP = data plane**: ChatGPT pulls files/diffs/search results itself.
- **Read-only by design**: no write/exec tools exist in V1 at all.
- **Workspace is the security boundary**: one bridge = one workspace = one token audience.

## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only listener, port fallback, runtime state, admin API |
| `mcp/` | McpServer with 9 read-only tools; stateless Streamable HTTP transport (fresh server per request, JSON responses) |
| `auth/` | OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment (realpath of deepest existing ancestor), sensitive-file policy, `.c2cignore`, paginated read/list, ripgrep search with Node fallback, git status/diff with pagination |
| `tunnel/` | `TunnelProvider` interface + Cloudflare Quick and workspace-configured Named Tunnel implementations; business logic is vendor-agnostic |
| `execution/` | JSONL execution records plus optional sanitized command output (`execution_output`) |
| `process/` | Daemon spawn/reuse, health probing, graceful shutdown |
| `cli/` | `c2c` commands; `--json` everywhere for the Skill; `c2c route …` lives in `cli/route.ts` |
| `config/`, `logger/` | OS-convention state dir, secret-redacting logger; `router-prefs.ts` keeps routing settings in `router.json`, separate from `prefs.json` |
| `session/` | Per-workspace ChatGPT session and task checkpoint (`initMode`, `routedBy`, `closeLocal` for routed tasks) |
| `router/` | Optional smart routing ([routing.md](routing.md)): deterministic signals (explicit phrases, error signatures, path categories, size buckets, task baseline), a pure policy per decision point, fixed `next`/`say` templates and REVIEW/DEBUG INIT builders, the outbound sanitizer + strict schemas, a pinned TypeSafe Jev client with budgets and a breaker, key + consent storage outside the sandbox roots, per-task router state, a numbers-only decision log, and the eval runner |

## Skills

| Skill | Installed to | Role |
| --- | --- | --- |
| `skill/SKILL.md` (`codex-with-chatgpt`) | `~/.codex/skills/codex-with-chatgpt/` | The real UX layer: setup, repair, the `[C2C]` loop. Triggers on explicit requests only |
| `router-skill/SKILL.md` (`c2c-router`) | `~/.codex/skills/c2c-router/` (optional; `c2c route setup` offers it) | Tiny gate (under 80 lines, no protocol text): triggers on ordinary coding requests, calls `c2c route intake` / `failure` / `review-gate`, and hands off to the main skill only when a route engages ChatGPT |

## Request lifecycles

**MCP call**: ChatGPT → tunnel (https) → bridge `/mcp` → bearer middleware
(401/403) → stateless StreamableHTTP transport → tool handler → workspace layer
(path containment → ignore rules → pagination) → JSON result.

**Authorization**: 401 with `WWW-Authenticate: resource_metadata=…` →
`/.well-known/oauth-protected-resource/mcp` → AS metadata → DCR →
`/oauth/authorize` (HTML pairing page) → pairing code verified → 302 with
authorization code → `/oauth/token` (PKCE S256) → access + refresh tokens.

**Routing decision** (only when enabled): Codex → `c2c route <point> --json`
→ enablement check (mode, consent, workspace; no writes when off) → local
signals and connection probe (loopback only) → Jev call when needed (sanitized,
schema-checked, time-boxed; heuristic fallback) → pure policy → fixed-template
`next` / `say` (+ `controlMessage` for REVIEW/DEBUG INIT) → numbers-only log.
Routing state lives under the OS state dir, never in the project:
`router.json` (machine-wide mode, bias, per-workspace opt-outs),
`routing/<workspaceId>/tasks/<taskId>.json` (per-task counters, pin and
baseline; 0600, pruned after 14 days), `routing/<workspaceId>.jsonl` (decision
log) and `routing/breaker.json`. The TypeSafe key and consent live in the
sibling `codex-with-chatgpt-keys/` dir, outside the sandbox's writable roots.

**Ports**: prefer 48765, bind 127.0.0.1 only. On conflict, `/health` identifies
whether the occupant is a c2c bridge for the same workspace (reuse) or not
(fall back to an ephemeral port). Configuration follows automatically via the
runtime state file; users never see ports.

**Tunnel**: default is a Cloudflare Quick Tunnel (`cloudflared tunnel --url …`).
The URL changes per start, so `c2c doctor` can restart it and tell the Skill to
Delete + recreate that workspace's ChatGPT connector. A workspace may instead
choose a named hostname once (`c2c tunnel choose --mode named`). The Skill asks
before the first public URL exists; `cloudflared tunnel login` is the only extra
user step. Tunnel name, hostname and preference live under the OS state dir
(`tunnels/<workspaceId>.json`), never in the project. Named starts use
`cloudflared tunnel --url … run <name>` so the public URL stays stable. If named
provisioning fails, C2C falls back to Quick Tunnel. If a named tunnel later
drops, doctor asks for a Cloudflare re-login (`namedRepair`) instead of
rotating the ChatGPT connector.
