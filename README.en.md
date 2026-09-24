# Codex × ChatGPT · JEV Switch

**English** | [简体中文](README.md)

> ChatGPT thinks, Codex works, and **Jev decides whose turn it is**.

[Smart routing design](docs/routing.md) · [Security model](docs/security.md)

This project is a fork of [codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt) (C2C). C2C lets the ChatGPT web app read your local repository through a **read-only** MCP connection, so ChatGPT plans and reviews while Codex does the work.

JEV Switch adds **smart routing** on top. It uses [TypeSafe](https://typesafe.ai)'s Jev model together with deterministic rules to decide, per task:

1. **When to switch to ChatGPT (web):**
   - let it plan first;
   - ask it for the root cause when Codex is stuck;
   - ask it to review risky changes.
2. **When to switch back to Codex:**
   - Codex handles small changes on its own;
   - when ChatGPT says DONE with only a few minor follow-ups, Codex applies them and closes the task without another round trip.

Smart routing is off by default. While it is off, everything behaves exactly like upstream C2C.

---

## Why

In upstream C2C, switching is entirely manual. ChatGPT is only involved when you say 「使用 Codex with ChatGPT 完成 XXX」 ("use Codex with ChatGPT to do XXX"). Once the collaboration loop starts, every iteration goes back to ChatGPT for review until it says DONE.

Every round trip has a cost:

- you wait an extra **1–3 minutes**;
- Codex spends tokens driving the in-app browser and checking the page every 20–30 seconds;
- sending a purely mechanical change (a color tweak, a rename) to ChatGPT for planning is slower and more expensive, not less.

The opposite also happens. When Codex fails at the same problem again and again, upstream never asks ChatGPT for help on its own.

JEV Switch follows one rule: **hand work to ChatGPT only when the thinking it saves is worth more than a round trip.**

## When it decides

| Moment | How it decides | Possible outcomes |
|---|---|---|
| **New request** | Jev answers 8 questions: task kind, scope of change, whether an approach has to be chosen first, whether the goal is clear, and 4 kinds of risk (auth, stored data, concurrency, public interfaces). Code combines the answers with weights that depend on your preference. | Codex does it · Codex does it, then ChatGPT reviews · ChatGPT plans first · ask you one question first |
| **A command fails during the work** | Code counts how often the same error repeats. From the 2nd failure on, Jev classifies the error and checks whether it needs you (a login, a key, an OS permission). | keep fixing · send the failing output to ChatGPT to find the root cause (DEBUG) · stop and ask you |
| **Codex is about to finish** | **Code only:** size of the change, whether it touches sensitive files (login, payments, database migrations, CI, …), whether the tests pass. | finish locally · ask ChatGPT to review (REVIEW) |
| **ChatGPT says DONE + FOLLOWUPS** | Jev estimates how much code each follow-up item needs. Code applies hard floors for sensitive content. | Codex applies them and closes (switch back to Codex) · apply them, then one more ChatGPT look |

Hard rules, all enforced in code and covered by tests:

- **Jev never decides whether a review can be skipped.** Its answers can only make the system more cautious, never less.
- **When Jev is unavailable** (no key, network blocked, timeout), behavior falls back to upstream: nothing escalates automatically and no review is skipped.
- **You have the final say.** "Don't bring in ChatGPT" and "let ChatGPT plan this" take effect at any time.
- **No flip-flopping.** Each task switches to ChatGPT automatically at most once.
- **The task is never blocked.** Every decision command returns valid JSON and exits 0. The intake call to Jev has a 3-second budget.

## Measured results

Live eval with `jev-1.13.0` on 2026-09-24: 152 fixtures, 73% of them Chinese or mixed Chinese/English.

| Metric | Result | Bar for enabling |
|---|---|---|
| Route agreement (balanced) | **96.5%** (Chinese 93.3%, English 98.4%) | ≥ 85%, Chinese ≥ 80% |
| Route agreement (economy / speed) | 95.5% / 96.9% | |
| Intake latency p95 | **274 ms** | ≤ 1.5 s |
| Floor / injection violations | **0 / 0** | must be 0 |
| Accuracy of high-confidence answers (0.8–1.0) | 95.4% (n = 544) | |

Per-question accuracy is lower than route agreement. For example, `goal_is_clear` is only 65.8%. That is expected: routing combines several probabilities with weights before comparing against a threshold, so a single wrong answer usually does not change the final route.

The fixtures were written and labeled by this project, so your real-world results are what counts. Use `c2c route feedback` to correct decisions and `c2c route stats` to watch the trend.

---

## Quick start

You need:
- macOS or Windows, Node.js ≥ 20 and git;
- the [Codex](https://openai.com/codex) desktop app;
- a ChatGPT Plus or Pro account;
- for smart routing, a [TypeSafe](https://console.typesafe.ai) API key.

### 1. Install (paste this into Codex)

```text
Please install and configure JEV Switch (a fork of Codex with ChatGPT) for me,
fully automatically:

1. Check the environment: git and Node.js >= 20 are required; install whatever
   is missing (Homebrew on macOS, winget on Windows), and install cloudflared.
2. Download: clone https://github.com/FlyPig23/Codex_ChatGPT_JEV_Switch into
   ~/Codex_ChatGPT_JEV_Switch (git pull if it already exists).
3. Build: run corepack pnpm install and corepack pnpm build in that directory.
4. Install the Skill: copy skill/SKILL.md from the repo to
   ~/.codex/skills/codex-with-chatgpt/SKILL.md and change the line
   "The codex-with-chatgpt checkout lives at:" to the actual clone path.
   If the original codex-with-chatgpt is installed, overwrite it with this
   version; do not keep both.
5. First-time setup: follow the first-time setup workflow in SKILL.md
   (run c2c setup, open ChatGPT in the in-app browser, configure the connector
   and enter the pairing code). Use only the in-app browser, never a
   third-party browser.
6. Only involve me when I have to log in (ChatGPT / Cloudflare), solve a
   CAPTCHA or confirm two-factor auth, and tell me one action at a time.
7. When done, show me the ✓ checklist and confirm the file-read test passed.
```

When it is done you will see:

```
Codex with ChatGPT

✓ 当前项目已识别
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

After that, saying 「使用 Codex with ChatGPT，帮我实现 XXX」 ("use Codex with ChatGPT to implement XXX") runs the upstream ChatGPT planning workflow.

> Note: the status lines and routing messages shown to you are in Chinese, as in upstream.

### 2. Enable smart routing (configure the Jev key)

You enter the key only in your own terminal. It never goes through the chat, and Codex never sees it.

1. Create an API key in the [TypeSafe console](https://console.typesafe.ai).
2. Open macOS Terminal or iTerm. **Do not use the terminal built into Codex.** It sets environment variables such as `CODEX_SANDBOX`, and setup refuses to run there.
3. Run:

   ```bash
   node ~/Codex_ChatGPT_JEV_Switch/bin/c2c.js route setup
   ```

   Setup prompts are in Chinese. In order, setup will:
   - show what gets sent to TypeSafe, then ask `同意并启用智能切换？[y/N]` ("agree and enable smart routing?"); answer `y`;
   - ask you to paste the key, with echo off. Paste it directly rather than pressing Enter to use the `TYPESAFE_API_KEY` environment variable: the Codex desktop app does not always see your shell environment;
   - call Jev once for real and show ✓ or ✗;
   - save the key and turn smart routing on;
   - offer to install the `c2c-router` skill; press Enter to install it.
4. Verify:

   ```bash
   node ~/Codex_ChatGPT_JEV_Switch/bin/c2c.js route status --probe --json
   ```

   `"enabled": true` and `"jev": "reachable"` mean you are set. The output shows only the first 8 characters of the key's fingerprint.
5. Start a new Codex session so the new skill takes effect. From then on, just ask for what you want; you no longer need to say 「使用 Codex with ChatGPT」.

Where the key is stored:
- macOS: `~/Library/Application Support/codex-with-chatgpt-keys/`
- Windows: `%LOCALAPPDATA%\codex-with-chatgpt-keys`

The directory is 0700 and the file 0600, outside the directories the Codex sandbox can write to. To change the key or turn routing off, run `route setup --remove`, then run setup again.

## Everyday use: what you can say

| You say | Effect |
|---|---|
| "Let ChatGPT plan this one" (这次让 ChatGPT 来规划) | This task is pinned to ChatGPT |
| "Don't use ChatGPT, do it yourself" (别找 ChatGPT / 不用 ChatGPT，你自己做) | This task is pinned to Codex |
| "Have ChatGPT look at it" (让 ChatGPT 看看 / 复核一下) | Ask ChatGPT to review the current changes now |
| "From now on, save Codex quota" (以后优先省 Codex 额度) | Preference `economy`: hand thinking to ChatGPT earlier and more often |
| "From now on, be faster" (以后优先快一点) | Preference `speed`: as few round trips as possible |
| "Turn automatic switching off / on" (关闭 / 开启自动切换) | Global switch (the key is kept) |
| "Don't bring in ChatGPT automatically for this project" (这个项目别自动找 ChatGPT) | Off for the current project only |
| "That shouldn't / should have gone to ChatGPT" (刚才不该找 ChatGPT / 刚才应该找 ChatGPT) | Record feedback for later tuning |

The first time the router speaks on a machine, it adds one intro line: 「我会按任务自动决定是否请 ChatGPT 参与；随时可以说「这次别找 ChatGPT」或「让 ChatGPT 来规划」。」 ("I'll decide per task whether to bring in ChatGPT; you can say 'don't use ChatGPT this time' or 'let ChatGPT plan' at any time.")

## What is sent to TypeSafe

Nothing is sent until you run `route setup`. After that, data goes only to the fixed endpoint `https://api.typesafe.ai`. The default model is `jev-1.13.0`; you can pin another version with `route prefs set --model`.

| Moment | Sent (maximum) | Never sent |
|---|---|---|
| New request | Your request text: code blocks stripped, sanitized, ≤ 1500 chars | file contents, diffs, logs, project metadata |
| Command failure (from the 2nd on) | The command (redacted, ≤ 200 chars) plus error lines (≤ 40 lines / 2000 chars; may include file paths that appear in the error) | the task goal, full logs |
| Finishing | Nothing (code-only decision) | — |
| ChatGPT's minor follow-ups | ≤ 300 chars each, at most 12 items, sanitized | the rest of ChatGPT's reply, code blocks |

Before anything is sent, it goes through:
- code-block stripping;
- redaction of API keys, JWTs, passwords in URLs, labelled values such as `password=…` / `密码：…`, credentials on a command line, emails, public IPs, high-entropy strings, and your own TypeSafe key;
- length caps;
- a strict per-moment schema check.

No Jev call is made when:
- the request mentions confidentiality (保密 / 不要上传 / confidential). This also stops ChatGPT from being brought in automatically for that task;
- the text contains a private key;
- a deterministic rule already decides the outcome.

The local decision log stores numbers and enums only, never the text.

TypeSafe states that it does not train on your inputs. It has no fixed retention period, and zero data retention is available to enterprise customers only. If a repository's content must not be processed by a third party, run `c2c route disable -w <repo>` on it. See [docs/security.md](docs/security.md).

## Command reference

Below, `c2c` means `node ~/Codex_ChatGPT_JEV_Switch/bin/c2c.js`.

| Command | Purpose |
|---|---|
| `c2c route setup [--remove]` | Turn smart routing on or off (only in your own terminal) |
| `c2c route status [--probe] --json` | Mode, preference, key fingerprint, Jev reachability |
| `c2c route prefs set --mode off\|auto --bias economy\|balanced\|speed` | Global settings |
| `c2c route disable\|enable -w <project>` | Per-project switch |
| `c2c route stats -w <project>` | A one-line summary of recent routing (in Chinese) |
| `c2c route log -w <project>` | Recent decisions (numbers and enums only) |
| `c2c route feedback -w <project> --last --verdict right\|wrong` | Label the last decision |
| `c2c route eval [--live] [--save-answers <file>] [--replay <file>]` | Evaluate routing on the bundled fixtures |

Codex calls the decision commands (`intake`, `failure`, `review-gate`, `reply`, `pin`, `message`) through the skills, so you rarely run them by hand. Two flags help when you do:
- `--explain` shows the signals, probabilities and thresholds behind each step;
- `--dry-run` shows exactly what would be sent, without sending it.

Full reference: [docs/routing.md](docs/routing.md).

## Eval and tuning

```bash
# Offline: deterministic rules and policy replay only; no network, no key needed
node bin/c2c.js route eval

# Live: real Jev calls, about 150 of them, roughly $0.01; save the answers for offline replay
node bin/c2c.js route eval --live --save-answers ~/jev-answers.json

# After changing only thresholds or policy (not the questions), re-check offline for free
node bin/c2c.js route eval --replay ~/jev-answers.json
```

- Thresholds live in `THRESHOLDS` in [src/router/policy.ts](src/router/policy.ts), set separately for `economy`, `balanced` and `speed`.
- Jev's questions are defined in [src/router/questions.ts](src/router/questions.ts).
- Fixtures are in [src/router/fixtures/](src/router/fixtures/).

After changing the policy, regenerate the fixtures' expected results:

```bash
node --import tsx scripts/regen-router-fixtures.ts --write
```

## How it works

```
request ─► [c2c-router skill] ─► c2c route intake ─┬─ Codex solo ──────┬─ fails ─► route failure ─┬─ keep fixing
                                                   │                   │                          ├─ DEBUG ─► ChatGPT finds the root cause
                                                   │                   │                          └─ ask you
                                                   │                   └─ done ─► route review-gate ─┬─ finish locally
                                                   │                                                 └─ REVIEW ─► ChatGPT reviews
                                                   ├─ Codex, then review ─► review-gate ─► REVIEW ─► ChatGPT reviews
                                                   ├─ ChatGPT plans first ─► upstream C2C loop
                                                   └─ ask you one question
ChatGPT: DONE + FOLLOWUPS ─► route reply ─┬─ Codex applies them and closes (back to Codex)
                                          └─ apply, then one more ChatGPT look
```

- **Two skills.** `c2c-router` ([router-skill/SKILL.md](router-skill/SKILL.md), about 80 lines) triggers on ordinary coding requests. The full `codex-with-chatgpt` skill ([skill/SKILL.md](skill/SKILL.md)) loads only when ChatGPT is really needed, so a small change never pays for reading tens of KB of instructions.
- **Backward-compatible protocol extensions.** There are two new INIT modes: `MODE: REVIEW` (Codex already did the work; ChatGPT reviews it) and `MODE: DEBUG` (Codex is stuck; ChatGPT finds the root cause). DONE can now carry an optional `FOLLOWUPS:` section. The instructions travel inside the message itself, so existing chats need no new boot prompt. See [docs/protocol.md](docs/protocol.md).
- **The upstream data path is unchanged.** ChatGPT still reads code only through the read-only MCP connection. Control messages never contain file contents, diffs or logs.

For the upstream C2C architecture (read-only MCP bridge, OAuth 2.1 with one-time pairing codes, Cloudflare tunnel), see [docs/architecture.md](docs/architecture.md).

## Other improvements over upstream

- **Update check.** It follows the remote branch that your local branch tracks, so forks correctly detect new versions. Updates no longer run `git stash` on your local changes.
- **`c2c record --output-file`.** It refuses sensitive files (`.env`, `~/.ssh`, …) and symlinks.
- **Shared sanitizer.** It covers more credential formats, such as `sk-proj-`, `sk_live_`, JWTs and passwords in URLs.
- **Session checkpoints.** Starting a new task no longer inherits fields from the previous one. Three new flags: `--init-mode`, `--routed-by`, `--close-local`.

## Migrating from upstream / syncing with upstream

Already using the original codex-with-chatgpt?
1. Overwrite `~/.codex/skills/codex-with-chatgpt/SKILL.md` with this repo's `skill/SKILL.md`, and change the checkout-path line to this repo's path.
2. Remove any other copies of the original skill.

Both versions use the same local state directory, so your existing ChatGPT connector keeps working.

To pull in upstream changes:

```bash
git remote add upstream https://github.com/XiaoDuoYa/codex-with-chatgpt.git
git fetch upstream && git merge upstream/main
```

## Development

```bash
corepack pnpm install
corepack pnpm build        # builds dist/; bin/c2c.js prefers dist/
corepack pnpm test         # vitest: 1167 tests, no network access
corepack pnpm typecheck
```

The router lives in `src/router/`:

```
types.ts       shared types and enums         policy.ts     pure policy functions and thresholds
questions.ts   Jev question definitions       signals.ts    deterministic signals (regexes, error signatures,
                                                            path categories, change stats, connection probe)
outbound.ts    outbound sanitizing and        jev.ts        TypeSafe client pinned to a fixed endpoint and model;
               schema checks                                circuit breaker
messages.ts    next/say templates,            index.ts      orchestration of each decision point
               REVIEW/DEBUG INIT
secrets.ts     key and consent storage        setup.ts      interactive terminal setup
state.ts       per-task routing state         log.ts        numbers-only decision log and stats
eval.ts        evaluation                     fixtures/     eval fixtures
```

The CLI entry point is [src/cli/route.ts](src/cli/route.ts).

## Docs

[Smart routing](docs/routing.md) · [Protocol](docs/protocol.md) · [Security](docs/security.md) · [Architecture](docs/architecture.md) · [Troubleshooting](docs/troubleshooting.md)

## Credits and disclaimer

- Based on [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt) (MIT). The bridge, OAuth, tunnel, skill and protocol design all come from the original author.
- Smart routing uses [TypeSafe](https://typesafe.ai)'s Jev model and the official [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript).
- **This is an unofficial community project. It is not affiliated with or endorsed by OpenAI or TypeSafe.**
- License: [MIT](LICENSE).
