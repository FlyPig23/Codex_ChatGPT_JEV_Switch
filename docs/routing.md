# Smart routing (TypeSafe Jev)

Optional. Off by default. When you turn it on, C2C decides per task **when
Codex should bring in ChatGPT (web)** and **when it should switch back to Codex
alone**, instead of waiting for you to say "使用 Codex with ChatGPT …".

A ChatGPT round trip is not free: Codex spends tokens driving the browser and
polling, and you wait 1–3+ minutes. The router offloads only when the thinking
saved is worth more than that.

- **Code owns the workflow and the policy.** TypeSafe Jev only answers narrow
  typed questions (a choice, a score, yes/no) where the answer needs semantic
  reading of text. Jev is used at three points: intake, repeated failures, and
  DONE follow-ups. The review gate is deterministic.
- **Two skills.** A tiny gate skill (`c2c-router`, `router-skill/SKILL.md`)
  triggers on ordinary coding requests and calls `c2c route`. The full
  codex-with-chatgpt skill loads only once a route actually engages ChatGPT.
- **ChatGPT authorizes the switch back.** When ChatGPT replies `STATE: DONE`
  with only minor `FOLLOWUPS:`, Codex applies them locally and closes the task
  without another review round.

In commands below, `c2c` means `node "<checkout>/bin/c2c.js"`.

## How it flows

```
user request ──► [c2c-router skill] ──► c2c route intake ──┬─ codex_solo ──► Codex works ──┬─ failure ──► c2c route failure ─┬─ keep_fixing
                                                           │                                │                                 ├─ escalate_chatgpt ─► DEBUG INIT ─► C2C loop
                                                           │                                │                                 └─ ask_user
                                                           │                                └─ done? ──► c2c route review-gate ─┬─ close_local
                                                           │                                                                    └─ send_review ─► REVIEW INIT ─► C2C loop
                                                           ├─ codex_then_review ─► Codex works ─► review-gate ─► send_review ─► REVIEW INIT ─► C2C loop
                                                           ├─ chatgpt_plan ─► codex-with-chatgpt "Workflow: coding task" (normal INIT)
                                                           └─ ask_user / active_task
C2C loop ──► ChatGPT DONE + FOLLOWUPS ──► c2c route reply ─┬─ apply_followups_local (switch back to Codex, close)
                                                           └─ apply_followups_then_review (one more EXECUTED)
```

REVIEW and DEBUG INITs are built in code and explain themselves in their
INSTRUCTION section, so existing chats and Projects understand them without a
new boot prompt ([protocol.md](protocol.md)).

Guarantees, each enforced in code and covered by tests:

1. **Off means upstream.** With routing off, no consent, the workspace
   disabled, or the workspace never set up with C2C, every `c2c route` point
   returns `enabled:false` with no network call and no file writes.
2. **Fail-safe direction.** Without Jev, the router does what upstream would:
   intake never escalates, engaged loops always send EXECUTED, follow-ups use
   regex floors only, and a heuristic result never skips a review ChatGPT would
   otherwise have done.
3. **Floors Jev can only raise.** Your explicit phrases, pins, high-risk path
   categories, the follow-up risk regex and needs-you error patterns are
   computed in code. A Jev answer can add a condition, never clear one.
4. **No input text in trusted channels.** `next` and `say` come from fixed
   templates (enums, numbers, the task id, the workspace root, fixed Chinese
   labels, and a ≤40-char goal from your local checkpoint).
5. **One ChatGPT task per workspace.** If another task holds a fresh
   checkpoint, the router never engages ChatGPT on its own.
6. **Never blocks the task.** Every decision point and support command
   exits 0 with valid JSON; errors show up as `ok:false` or warnings. The
   two exceptions are for people, not for Codex: `route setup` exits 1 when
   it refuses, and `route eval` exits 1 when the report fails (a CI gate).

## Decision points

| Point | Called when | Jev | Possible routes |
| --- | --- | --- | --- |
| `intake` | Once per new coding request, before any edit (gate skill); with `--explicit chatgpt` from the main skill's step 0 | yes (1 Choice, 1 Score, 6 yes/no) | `codex_solo`, `codex_then_review`, `chatgpt_plan`, `ask_user`, `active_task`, `disabled` |
| `failure` | Every failed test/build/typecheck/lint command | from the 2nd consecutive failure | `keep_fixing`, `escalate_chatgpt`, `ask_user` |
| `review_gate` | Codex is about to report a solo task done, or you ask for a review | no | `close_local`, `send_review`, `fix_first`, `continue_loop`, `ask_user` |
| `reply` | ChatGPT said DONE with a `FOLLOWUPS:` section | yes (1 Score per item) | `apply_followups_local`, `apply_followups_then_review` |

**Intake** first applies code rules: an explicit phrase (「让 ChatGPT 先规划」,
「别问 ChatGPT」), a leftover ChatGPT task in this workspace (older than 24 h,
ended BLOCKED/DONE without clearing, or started by the router, whose pending
REVIEW, DEBUG or follow-ups a restart would otherwise orphan; asked about at
most once per task per day), or a confidentiality phrase (保密 / confidential →
Codex alone, no Jev). These detectors read the whole message (up to the
CLI's 16 000 chars), so a 保密 or 别找 ChatGPT at the end still counts; only
the first 1500 chars, after redaction, are ever sent. The main skill's
explicit intake on resume reuses the checkpoint's task id instead of minting a
second task. A fresh
checkpoint held by another task makes the workspace busy: Codex works alone
and never engages ChatGPT on its own. Otherwise Jev reads only
your request and returns probabilities for the task kind, its scope, whether it
needs a design choice, whether the goal is clear, and four risk topics. Routing
uses probability mass, not the single most likely answer:

```
planOffload = 0.45·P(scope ≥ 4) + 0.35·needs_design + 0.20·P(design | debug | refactor)
            = 0 when P(mechanical bulk edit) ≥ 0.60
```

`planOffload ≥ T_plan` → `chatgpt_plan`; under `economy` and `balanced`, a
request that is mainly a design question with an open approach
(P(design) ≥ 0.50 and needs_design ≥ 0.60) also goes to `chatgpt_plan`,
whatever its scope, because planning is what ChatGPT web is for; inside the review band, or any risk
topic ≥ 0.60 → `codex_then_review`; otherwise `codex_solo`. A light request
(question, run a command) is always `codex_solo`. If ChatGPT would help but the
goal is unclear, Codex asks you one question first. ChatGPT is engaged only
when the connection is ready; otherwise the router asks once a day to
reconnect, or works alone and remembers that the result should get a review
once the connection is back (for plan-worthy tasks too).

**Failure** counts in code, per command (`pnpm test src/a.test.ts` counts as
`pnpm test`). The first failure returns `keep_fixing` without calling Jev.
From the second, Jev classifies the first real error and says whether only you
can fix it (login, key, paid account, OS permission). Test titles, diff lines,
code frames and test-count summaries (`401 passed`) never count as a needs-you
signal. "Stuck" means the same
error signature N times in a row, or N + 2 failures of that command, where N
is the bias's cap (+1 for compile and missing-module errors, −1 when intake
was uncertain). Environment and flaky failures ask you instead of escalating,
because ChatGPT cannot run commands. When Jev is unsure between two kinds that
share a branch (environment vs flaky, compile vs missing module), their
combined probability (≥ 0.5) still picks that branch instead of "other". A
`codex_then_review` task that gets stuck before its review may spend its
reserved switch on the DEBUG escalation instead. When stuck, the failing output is recorded
as iteration 0 and ChatGPT gets a DEBUG INIT. Once ChatGPT is brought in (or
sent an EXECUTED because Codex got stuck inside the loop), that command's count
starts over, so each ChatGPT round gets a fresh local attempt cycle. After the
router asked you (`stuck_ask_user`, `env_or_flaky_cap`), the same question
comes back only after another N failures of that command, so "keep going" is
not asked again on the very next failure; the count itself does not restart,
so answering "bring in ChatGPT" (`pin chatgpt`) escalates on the next failure.
A `--tests passed` at the review gate also resets the counts.

**Review gate** compares the working tree with a baseline taken at intake, so
edits that were already there do not count. It sizes the task's own changes
(tiny ≤2 files/≤40 lines, small ≤5/≤150, medium ≤8/≤300, large ≤20/≤800,
xlarge beyond) and classifies changed paths by name only: high-risk
categories are auth/security, payments, data migrations, CI pipelines, agent
config (`AGENTS.md`, `.codex/`, `SKILL.md`…) and install scripts. No path
leaves your machine. A review is wanted for `codex_then_review` tasks (or
ones intake meant to review but could not connect), a `chatgpt` pin, any
high-risk category, or a large diff (per bias); mechanical bulk edits skip the
size rule. The gate treats a task as already in the ChatGPT loop only while the
workspace checkpoint belongs to it (and it is not pinned to `codex`). A review
you ask for (「让 ChatGPT 看看」) never replaces another task's open checkpoint:
the router asks you first (`active_task` / `workspace_busy`).

**Reply** splits the FOLLOWUPS list into items. More than 8 items, or the risk
regex (auth, token, migration, payment, race, 权限, 迁移, 并发 …) or a
high-risk path anywhere in the raw section, always goes back to ChatGPT. The
floor reads the whole section, not just the parsed items, because Codex applies
all of it: an item longer than the 300 chars Jev would see, or text that parses
into no item, also goes back. An empty list (`FOLLOWUPS: none`) is a plain
DONE. Otherwise Jev scores each item's size; any item with P(logic change or
more) ≥ θ goes back to ChatGPT, else Codex applies them locally and closes the
task.

## Thresholds and hysteresis

The bias is machine-wide: `c2c route prefs set --bias economy|balanced|speed`
(default `balanced`). `economy` saves Codex tokens: it plans with ChatGPT more
readily and reviews *less*, because a review round trip spends Codex tokens and
saves none. `speed` avoids waiting on ChatGPT: Codex works alone unless a
task clearly needs a plan.

| Parameter | economy | balanced | speed |
| --- | --- | --- | --- |
| `T_plan` (planOffload ≥ T → chatgpt_plan) | 0.40 | 0.55 | 0.75 |
| Warm-chat adjustment to `T_plan` | −0.05 | −0.05 | −0.05 |
| Review band `[T_plan−0.15, T_plan)` → codex_then_review | no | yes | no |
| Risk floor (`maxRisk ≥ 0.60`) → at least codex_then_review | yes | yes | yes |
| Failure `capBase` | 2 | 3 | 4 |
| Review gate size trigger (codex_solo) | ≥ xlarge | ≥ large | never |
| Follow-up substantive threshold `P(level≥2) ≥` | 0.35 | 0.25 | 0.40 |
| Ask consent when the connection needs repair or a Project | yes | yes | no |

"Warm" means this Codex thread already has a ChatGPT chat open and the
connection is ready.

Hysteresis:

- At most **one automatic switch out to ChatGPT per task** (intake plan or
  review, review-gate `send_review`, or a failure escalation). After that,
  bringing ChatGPT in again needs you: 「让 ChatGPT 看看」 or a `chatgpt` pin.
- Switching back to Codex (`apply_followups_local`, `close_local`) is always
  allowed.
- A message that continues the current task never re-runs intake.
- `pin codex` turns off every automatic switch to ChatGPT for the task, even
  while a checkpoint of it is open (the failure gate can still ask you).
  `pin chatgpt` does not by itself mark ChatGPT as engaged: the INIT (or the
  review / DEBUG escalation it leads to) does. `pin chatgpt` overrides the switch cap and
  the thresholds, but not the reconnect consent.
- Reconnect consent is asked at most once per workspace per day.

## Fail-safe behavior

| Point | With Jev | Without Jev (`source: "heuristic"`) |
| --- | --- | --- |
| intake | Probability-mass policy above | `codex_solo` / `heuristic_default`. Explicit, confidentiality and active-task rules still apply. Never escalates on its own. |
| failure | Jev failure kind + needs-you, raised by the regex floor | Regex failure kind + regex needs-you. May still escalate, but only on code-counted repeated failures with a ready connection. |
| review_gate | Deterministic | Same (no Jev) |
| reply | Regex floors, then Jev item sizes | Regex floors only; otherwise local, because ChatGPT itself said DONE |
| ChatGPT loop already running | EXECUTED as usual | EXECUTED as usual |

| Cause | What happens |
| --- | --- |
| No key, or an env key that does not match the stored fingerprint | Heuristic; `status` says `jev: "no_key"` |
| Codex sandbox has network off (`CODEX_SANDBOX_NETWORK_DISABLED=1`) | Heuristic immediately, no doomed timeout; `jev: "network_blocked"` |
| Timeout (intake 3 s total, no retry; failure and reply 5 s total, 1 retry) | Heuristic for this call |
| 2 consecutive timeouts / server / network errors | Breaker opens for 15 min |
| 429 rate limit | Breaker opens for 2 min (`Retry-After` is not waited on) |
| 401 / 403 | Breaker stays open until the key changes (run setup again) |
| Unexpected answer shape, or the payload fails the outbound schema | Heuristic for this call; nothing is sent in the second case |

## What is sent

Only after `c2c route setup`, only to the fixed endpoint
`https://api.typesafe.ai`, with a pinned model (`jev-1.13.0` by default) and SDK
logging off:

| Point | Sent (max) | Never sent |
| --- | --- | --- |
| intake | `request`: the user's message, code blocks stripped, sanitized, ≤1500 chars | file contents, diffs, logs, workspace metadata, checkpoint data (a path goes out only if you wrote it in the message) |
| failure (from the 2nd failure) | `command` ≤200 (redacted), `error_lines` ≤40 lines / 2000 chars from the local output file (as printed, after redaction: may include file paths, hostnames and the failing source lines) | the task goal, full logs, previous excerpts, restricted outputs, paths outside the error lines |
| review_gate | nothing (no Jev) | (none) |
| reply | `followups[]` ≤12 × 300 chars, long code stripped, sanitized (file names and paths written in an item stay) | the rest of ChatGPT's reply, code blocks |

No call is made for a confidentiality phrase, a private-key block anywhere in
the text, a deterministic early exit, or the disabled path. Every payload goes
through code-block stripping, the shared C2C sanitizer, extra third-party
redactions (API keys, JWTs, URL passwords, JSON secrets, labelled values such
as `password：…` / `密码是 …` / `token: …`, credentials on a command line such as
`curl -u user:pw`, `mysql -p…`, `redis-cli -a …`, `--password` / `--token`,
emails, public IPs, high-entropy strings, your TypeSafe key), caps, and a strict
per-point schema.
The decision log (`<stateDir>/routing/<workspaceId>.jsonl`, 0600, last 2000
lines) holds numbers and enums only. Details and retention:
[security.md](security.md#smart-routing-typesafe-jev-what-leaves-your-machine).

## Setup

Prerequisite: the workspace is already set up with C2C (`c2c setup`); the
router never sends anything for a workspace that was not.

Run this **in your own terminal**, not in the Codex chat:

```
node "<checkout>/bin/c2c.js" route setup
```

Codex never runs it. It refuses without an interactive terminal or inside the
Codex sandbox (「请在你自己的终端里运行这条命令。」). Setup:

1. Shows what is sent (the table above), TypeSafe's terms, and where the key
   is stored.
2. Asks `同意并启用智能切换？[y/N]`.
3. Reads your TypeSafe API key with echo off. Press Enter on an empty line to
   use the `TYPESAFE_API_KEY` environment variable instead; then only its
   fingerprint is stored, and a different env key later is ignored.
4. Runs one live probe and reports ✓ or ✗ (settings are saved either way).
5. Writes the key and consent, and sets `mode=auto`.
6. Offers to install the gate skill to `~/.codex/skills/c2c-router/`
   (`$CODEX_HOME/skills/c2c-router/` when `CODEX_HOME` is set) with its
   checkout path filled in. The skill takes effect from the next Codex
   session. "更新 Codex with ChatGPT" (or the daily update) refreshes it
   whenever that directory exists.

The key and consent live in `codex-with-chatgpt-keys/.c2c-secrets-typesafe.json`,
a sibling of the C2C state directory (macOS
`~/Library/Application Support/codex-with-chatgpt-keys`, Windows
`%LOCALAPPDATA%\codex-with-chatgpt-keys`, Linux
`$XDG_STATE_HOME/codex-with-chatgpt-keys`; dir 0700, file 0600). It sits
outside the directories `c2c sandbox-allow` makes writable, so an agent inside
the sandbox cannot forge consent or swap the key.

Check it: `c2c route status --probe --json` (the key shows only as an 8-char
fingerprint).

Turn it off:

- Everywhere, keep the key: `c2c route prefs set --mode off` (on again:
  `--mode auto`), or tell Codex 「关闭自动切换」.
- One project: `c2c route disable -w <project>` (undo: `c2c route enable -w <project>`).
  This is stored machine-wide; a repo's `.c2c.json` can never turn routing on.
- Remove key and consent: `c2c route setup --remove` (also offers to remove
  the gate skill).

## What you can say

| You say | Codex runs |
| --- | --- |
| 这次/这个任务 让 ChatGPT 来规划 | `c2c route pin -w <ws> --task <id> --route chatgpt --json` |
| 别找 ChatGPT / 不用 ChatGPT，你自己做 | `c2c route pin -w <ws> --task <id> --route codex --json` |
| 让 ChatGPT 看看 / 复核一下 | `c2c route review-gate -w <ws> --task <id> --tests <status> --user-asked-review --json` |
| 以后优先省 Codex 额度 / 优先快一点 | `c2c route prefs set --bias economy` / `--bias speed` |
| 关闭 / 开启自动切换 | `c2c route prefs set --mode off` / `--mode auto` |
| 这个项目别自动找 ChatGPT | `c2c route disable -w <ws>` |
| 刚才不该找 ChatGPT / 刚才应该找 ChatGPT | `c2c route feedback -w <ws> --last --verdict wrong` |
| 开启智能切换 / 设置 TypeSafe | Nothing: Codex tells you to run `route setup` in your own terminal |

The first time the router speaks on a machine, it adds one intro line:
「我会按任务自动决定是否请 ChatGPT 参与；随时可以说「这次别找 ChatGPT」或「让 ChatGPT 来规划」。」

## Commands

Every decision point prints the JSON below with `--json` and always exits 0
(`route setup` and `route eval` are the only commands that can exit 1).
`--explain` adds the signals, raw probabilities, thresholds, latency and
warnings (stdout only, never stored). `--dry-run` (intake, failure, reply)
prints the exact payload that would be sent, and sends and writes nothing.

| Command | Purpose |
| --- | --- |
| `c2c route intake -w <root> (--request "<text>" \| --request-file <path>) [--explicit chatgpt] [--thread-chat open\|none] [--request-en "<gloss>"]` | Route a new request; mints the task id |
| `c2c route failure -w <root> --task <id> --command "<cmd>" (--output-file <path> \| --output "<text>") [--exit-code <n>]` | A command failed |
| `c2c route review-gate -w <root> --task <id> --tests passed\|failed\|not_run [--tests-summary "<text>"] [--command "<cmd>" --output-file <path> --exit-code <n>] [--user-asked-review]` | Close locally or ask for a review |
| `c2c route reply -w <root> --task <id> --iteration <n> (--followups-file <path> \| --followup "<item>" …)` | DONE with FOLLOWUPS |
| `c2c route pin -w <root> --task <id> --route chatgpt\|codex\|none` | Pin or unpin a task |
| `c2c route message review-init\|debug-init -w <root> --task <id>` | Rebuild a REVIEW / DEBUG INIT on resume |
| `c2c route prefs [get]`, `c2c route prefs set [--mode off\|auto] [--bias economy\|balanced\|speed] [--model <model>]` | Machine-wide settings (`<stateDir>/router.json`) |
| `c2c route disable\|enable -w <root>` | Per-workspace opt-out |
| `c2c route status [-w <root>] [--probe] --json` | Mode, bias, consent, key fingerprint, breaker, Jev reachability |
| `c2c route setup [--remove]` | Opt in or out (your own terminal only) |
| `c2c route log -w <root> [--limit 20]`, `c2c route stats -w <root>` | Numbers-only decision log; a Chinese summary |
| `c2c route feedback -w <root> (--last \| --log-id <id>) --verdict right\|wrong [--expected <route>]` | Label a decision |
| `c2c route eval [--live] [--variant gloss] [--points intake,failure,reply] [--save-answers <file>] [--replay <file>] [--json]` | Evaluate (below) |

Output of a decision point:

```
{ ok, enabled, point, route, reason, source: "jev"|"heuristic"|"override"|"rule",
  taskId, say, next, controlMessage, logId, activeCheckpoint?, error?, explain? }
```

`say` is one Chinese line for you (or null), `next` is the instruction Codex
follows, and `controlMessage` is a REVIEW or DEBUG INIT (≤ 1000 bytes).

## Eval and tuning

`c2c route eval` runs the bundled fixtures (`src/router/fixtures/`: 60+ intake
requests, mostly Chinese or mixed; 25+ failure outputs from tsc, vitest, jest,
pytest, go, cargo and npm; 20+ follow-up lists; 10+ prompt-injection cases).

- **Offline** (default; runs in CI, no key, no network): the deterministic
  parts (regexes, floors, early exits, heuristic routes) must score 100%, and a
  policy replay with ideal answers synthesized from the labels must match the
  expected route for every bias. This is the regression test for the tables
  above.
- **`--live`** (you run it, with your key): calls Jev for every fixture
  (concurrency 4; about 110 fixtures × ~2k tokens, roughly $0.01). Reports
  per-question accuracy (choice accuracy; score within-1 and mean absolute
  error; yes/no accuracy and Brier score) split by language, route agreement
  per bias and language, a calibration table, latency p50/p95, and floor and
  injection violations (must be 0).
- **`--save-answers <file>`** snapshots the live answers; **`--replay <file>`**
  re-applies the current policy to them, so you can retune thresholds without
  paying for new calls.
- **`--variant gloss`** re-runs intake with an English gloss (`request_en`)
  and reports the Chinese-subset delta. The skill starts passing
  `--request-en` only if this improves Chinese route agreement by ≥ 5 points.
- **`--points intake,failure,reply`** limits the run.
- A live run never reads or writes the breaker that real routing uses; it
  stops on its own after a fatal error (no key, no network, auth).
- Fixtures are held out from the prompts: a fixture whose request, gloss or
  follow-up text contains an in-prompt criteria example (ignoring case,
  whitespace and punctuation), or nearly copies one (≥ 80 % of the example's
  character bigrams inside one window of about its length, e.g. "the cart"
  for "the list"), is a fixture error, because agreement on it would measure
  recall of the prompt, not generalization. Failure outputs are exempt (real
  tool output shares canonical error strings).
- After a deliberate policy change, recompute the derived expectations with
  `node --import tsx scripts/regen-router-fixtures.ts` (dry run), `--write`
  to update `expected` / `heuristicExpected` / `heuristic` in
  `src/router/fixtures/*.json`, or `--check` to fail when anything is stale.
  It never edits requests, outputs, labels or tags; it prints tag
  disagreements for you to fix by hand. Review the diff: every changed
  expectation is a behavior change.

Release criteria for recommending routing on (documented, not enforced):

- live route agreement ≥ 85% overall and ≥ 80% on Chinese fixtures;
- 0 floor or injection violations;
- intake p95 latency ≤ 1.5 s;
- disabled-path CLI ≤ 300 ms.

Day to day, `c2c route stats -w <project>` summarizes recent tasks in one line,
and 「刚才不该找 ChatGPT」 records a correction. A pin against the intake route and a
solo task that later needed ChatGPT are labeled automatically. These labels are
what future threshold changes are fitted from.

## Troubleshooting

### It never routes anything

Check `c2c route status -w <project> --json`. A decision point returns
`enabled:false` with one of these reasons: `disabled_mode_off` (run setup, or
`prefs set --mode auto`), `disabled_no_consent` (run setup; also after a
consent-text update), `disabled_workspace` (`c2c route enable -w`), or
`not_setup` (set this workspace up with C2C first).

### Setup says 「请在你自己的终端里运行这条命令。」

Setup refuses to run without an interactive terminal or when it sees Codex's
environment (for example `CODEX_SANDBOX`), so that an agent cannot consent for
you. Open Terminal (or PowerShell) yourself and run the command there.

### It always says `heuristic`

`c2c route status --probe --json` shows why in `jev`:

- `no_key` — setup was not finished, or it was set to use `TYPESAFE_API_KEY`
  and that variable is now missing or holds a different key. Run setup again.
- `network_blocked` — Codex's sandbox has network access disabled
  (`CODEX_SANDBOX_NETWORK_DISABLED=1`), so the router skips Jev at once. C2C
  never changes Codex's `network_access` or `writable_roots`. Turning sandbox
  network on (`network_access = true` under `[sandbox_workspace_write]` in
  `~/.codex/config.toml`) is your decision: it lets every command Codex runs in
  the sandbox reach the network, not just the router. Heuristic mode works
  without it and is simply more conservative: intake always starts with Codex
  alone, and ChatGPT still comes in when Codex is stuck, at the review gate
  for risky or large changes, or when you ask.
- `auth_failed` — the key was revoked or mistyped. The breaker stays open
  until the key changes: run setup with a new key.
- `rate_limited` — the breaker reopens after 2 minutes.
- `unavailable` — the probe reached TypeSafe but the call failed for another
  reason (server error, rejected request or an unexpected answer); `jevError`
  in the same output names the error class.
- Repeated timeouts or server errors open the breaker for 15 minutes
  (`breaker.until` in `status`). It closes by itself.

`c2c route log -w <project>` shows `jevError` for each recent decision.

### Why did it (not) bring in ChatGPT?

`c2c route log -w <project>` lists recent decisions with their reason, signals
and probabilities; `--explain` on a call shows the same live, and `--dry-run`
shows the exact payload. The usual answers: the connection was not ready (the
router works alone, or asks once a day to reconnect), another ChatGPT task is
still open in this workspace, the task already used its one automatic switch,
you pinned the task, or the request asked for confidentiality.

## Route and reason reference

| Point | Route | Reason | Meaning |
| --- | --- | --- | --- |
| any | `disabled` | `disabled_mode_off`, `disabled_no_consent`, `disabled_workspace`, `not_setup` | Routing off here; work as upstream |
| any | — | `invalid_input`, `internal_error` | `ok:false`; ignore the call and continue |
| intake | `codex_solo` | `explicit_codex` | You said not to use ChatGPT (also pins `codex`) |
| intake | `codex_solo` | `no_egress` | Confidentiality phrase: no Jev, no automatic ChatGPT |
| intake | `codex_solo` | `not_coding` | A question or a command to run |
| intake | `codex_solo` | `low_offload` | Not worth a ChatGPT plan |
| intake | `codex_solo` | `workspace_busy` | Another ChatGPT task is active in this workspace |
| intake | `codex_solo` | `connection_unavailable` | ChatGPT would help, but the connection is not ready (a wanted review is remembered) |
| intake | `codex_solo` | `heuristic_default` | Jev unavailable |
| intake | `chatgpt_plan` | `explicit_chatgpt` | You asked for ChatGPT |
| intake | `chatgpt_plan` | `plan_offload` | Broad or design-heavy task: ChatGPT plans first |
| intake | `codex_then_review` | `review_band`, `risk_floor` | Codex implements, then ChatGPT reviews |
| intake | `ask_user` | `goal_unclear` | Codex asks you one question first |
| intake | `ask_user` | `connection_consent` | A plan would help, but ChatGPT needs reconnecting |
| intake | `active_task` | `active_task_stale` | An unfinished ChatGPT task exists (stale, or started by the router); continue it? |
| failure | `keep_fixing` | `first_failure`, `below_cap` | Keep fixing locally |
| failure | `ask_user` | `needs_user` | Only you can fix it (login, key, account, permission) |
| failure | `ask_user` | `env_or_flaky_cap` | Environment or flaky problem, retried enough |
| failure | `ask_user` | `stuck_ask_user` | Stuck, and ChatGPT cannot be brought in automatically |
| failure | `ask_user` | `reconnect_consent` | Stuck; ChatGPT would help but needs reconnecting |
| failure | `escalate_chatgpt` | `stuck_escalate_debug` | Stuck: DEBUG INIT with the failing output as iteration 0 |
| failure | `escalate_chatgpt` | `stuck_in_loop` | Stuck while executing a ChatGPT PLAN: send EXECUTED now |
| review_gate | `continue_loop` | `in_loop` | ChatGPT is already on this task |
| review_gate | `fix_first` | `tests_failed` | Fix the tests first |
| review_gate | `close_local` | `nothing_to_review`, `committed` | No task changes left to review |
| review_gate | `close_local` | `small_safe` | Small, low-risk change |
| review_gate | `close_local` | `escalation_unavailable` | Review not possible automatically (pin, cap, busy, confidentiality, connection); `say` may offer one |
| review_gate | `send_review` | `intended_review`, `high_risk_paths`, `large_diff`, `user_asked` | REVIEW INIT; the changes are recorded as iteration 1 |
| review_gate | `ask_user` | `reconnect_consent` | A review would help, but ChatGPT needs reconnecting |
| review_gate | `active_task` | `workspace_busy` | You asked for a review, but another ChatGPT task is open here; end it first? |
| reply | `close_local` | `followups_none` | DONE with an empty follow-up list: summarize and close |
| reply | `apply_followups_local` | `followups_minor` | Apply locally and close (switch back to Codex) |
| reply | `apply_followups_then_review` | `followups_too_many`, `followups_risky`, `followups_substantive` | Apply, then one more EXECUTED |
| pin | `chatgpt_plan`, `codex_solo` | `pinned` | `--route chatgpt` / `codex`: the pin was saved; run the ChatGPT workflow, or keep working alone |
| pin | `codex_solo`, `continue_loop` | `pinned` | `--route none`: the pin was removed; keep working alone, or continue the running ChatGPT loop |
