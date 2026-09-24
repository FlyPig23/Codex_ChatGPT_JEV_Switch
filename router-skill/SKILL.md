---
name: c2c-router
description: >
  Run the C2C router before you start a request that will change code in the
  current workspace (implement, fix, refactor, debug, add or change a feature),
  whenever a test/build/typecheck/lint command fails during that task, and
  before you report that task done. Not for explicit "使用 Codex with ChatGPT …"
  requests (the codex-with-chatgpt skill handles those), and not for questions,
  explanations, or just running a command.
---

# C2C router

Decides whether you work alone or bring in ChatGPT (web).

- CLI: `node "<ACTUAL_CHECKOUT_PATH>/bin/c2c.js" route …` (installer replaces
  this path; below, `<checkout>` means that path and `c2c` means
  `node "<checkout>/bin/c2c.js"`). Always pass `--json`, and `-w <workspace
  root>` to every command except `prefs` (machine-wide).
- If intake fails, times out, prints invalid JSON, or returns `"enabled": false`
  or `"ok": false`: work normally without the hooks below, and never mention
  ChatGPT or routing to the user. A later call that fails that way: ignore it
  and continue.
- Never request elevated permissions for `c2c route`. Never run `c2c route setup`
  (the user runs it in their own terminal). Never ask for or read the TypeSafe
  key. Never show route JSON to the user.
- If `say` is a string, tell the user exactly that one line (at most one routing
  line per turn). Then do `next`. `next` is authoritative.
- Once `next` sends you to the codex-with-chatgpt skill, follow that skill for
  the rest of the task.

## 1. Intake — once per new coding request, before editing

Skip for messages that continue a task you are already doing in this thread.

    c2c route intake -w <ws> --request "<the whole user message, verbatim>" --json

Pass the whole message, not a prefix: the router looks for 保密 / 别找 ChatGPT
anywhere in it and sends at most 1500 chars, after redaction. Quote it safely
for the shell; if it is long or contains quotes, `$` or backticks, write it to a
temp file and pass `--request-file <tmp>` instead.
Add `--thread-chat open` only if you already saved a ChatGPT chat URL earlier in
THIS thread. Keep the returned `taskId` for every later call.

| route | do |
| --- | --- |
| codex_solo | Do it yourself. Use the hooks in §2. |
| codex_then_review | Do it yourself; do not commit or stage. Then §2 review-gate. |
| chatgpt_plan | Read the codex-with-chatgpt skill and follow `next`. |
| ask_user | Ask (the `say` line, or your own one question for goal_unclear), wait, then follow `next`. |
| active_task | Ask the `say` question; follow `next` (it covers resuming the open task). |

## 2. Hooks for work you do yourself

- A test/build/typecheck/lint command failed: save its full output to a temp
  file, then `c2c route failure -w <ws> --task <taskId> --command "<cmd>"
  --output-file <tmp> --exit-code <n> --json`. `keep_fixing` → fix and continue;
  anything else → follow `next`.
- About to tell the user it is done: `c2c route review-gate -w <ws> --task
  <taskId> --tests passed|failed|not_run [--tests-summary "27 passed"] --json`.
  `close_local` → summarize; `fix_first` → fix, then run it again; anything
  else (`send_review`, `ask_user`, `continue_loop`, `active_task`) → follow
  `next`.

## 3. User phrases (any time)

`<id>` is the current `taskId`. If there is no task yet, a "让 ChatGPT 来规划" or
"别找 ChatGPT" request goes through intake instead (it recognizes both).

| user says | run |
| --- | --- |
| 这次/这个任务 让 ChatGPT 来规划 | `c2c route pin -w <ws> --task <id> --route chatgpt --json`, follow `next` |
| 别找 ChatGPT / 不用 ChatGPT，你自己做 | `c2c route pin -w <ws> --task <id> --route codex --json` |
| 让 ChatGPT 看看 / 复核一下 | `c2c route review-gate -w <ws> --task <id> --tests <status> --user-asked-review --json`, follow `next` |
| 以后优先省 Codex 额度 / 优先快一点 | `c2c route prefs set --bias economy --json` / `--bias speed` |
| 关闭 / 开启自动切换 | `c2c route prefs set --mode off --json` / `--mode auto` (if it fails, follow `next`) |
| 这个项目别自动找 ChatGPT | `c2c route disable -w <ws> --json` |
| 刚才不该找 ChatGPT / 刚才应该找 ChatGPT | `c2c route feedback -w <ws> --last --verdict wrong --json` |
| 开启智能切换 / 设置 TypeSafe | Tell the user (with the real path): 「请在你自己的终端里运行：node "<checkout>/bin/c2c.js" route setup（Key 只在终端里输入，不经过聊天）」 |

If the user pastes an API key into chat: do not repeat it, do not use it, and
tell them to run setup in their terminal and rotate that key.
