# Codex × ChatGPT · JEV Switch

[English](README.en.md) | **简体中文**

> ChatGPT 负责思考，Codex 负责干活，**Jev 决定什么时候该谁上**。

[智能切换设计文档](docs/routing.md) · [安全模型](docs/security.md)

本项目是 [codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)（C2C）的分支。C2C 让网页版 ChatGPT 通过一条**只读** MCP 连接读取本地仓库，负责规划和审查，Codex 负责执行。

在这个基础上，JEV Switch 加了**智能切换**：用 [TypeSafe](https://typesafe.ai) 的 Jev 模型加上一套确定性规则，按任务自动判断：

1. **什么时候切到网页版 ChatGPT**：先让它出方案；Codex 卡住时请它找根因；改动有风险时请它复核。
2. **什么时候切回 Codex**：小改动 Codex 直接做；ChatGPT 说 DONE、只剩几处小修改时，Codex 直接改完收尾，不再来回确认。

智能切换默认关闭。不开启时，行为与原版 C2C 完全一致。

---

## 为什么需要它

原版 C2C 的切换完全靠手动：你得说「使用 Codex with ChatGPT 完成 XXX」才会去找 ChatGPT。进入协作后，每一轮都要把结果发回 ChatGPT 复核，直到它说 DONE。

但每一次来回都有成本：

- 你要多等 **1–3 分钟**；
- Codex 要花 token 驱动内置浏览器、每 20–30 秒检查一次页面；
- 纯机械的小改动（改个颜色、重命名）交给 ChatGPT 规划，反而更贵、更慢。

反过来，Codex 在同一个问题上反复失败时，原版不会主动去问 ChatGPT。

JEV Switch 的原则是：**只有省下的思考比一次来回更值钱时，才把工作交给 ChatGPT。**

## 它在哪些时机做判断

| 时机 | 怎么判断 | 可能的结果 |
|---|---|---|
| **收到新任务** | Jev 回答 8 个问题：任务类型、改动范围、是否需要方案取舍、目标是否清楚、4 类风险（鉴权/数据/并发/对外接口）。代码按偏好加权打分。 | Codex 直接做 · Codex 做完请 ChatGPT 复核 · ChatGPT 先出方案 · 先问你一句 |
| **执行中命令失败** | 代码统计同一错误出现了几次；从第 2 次失败起，Jev 判断错误类型、是否需要你来处理（登录、key、系统权限等）。 | 继续修 · 带着失败输出请 ChatGPT 找根因（DEBUG） · 停下来问你 |
| **Codex 准备收尾** | **只用代码判断**：改动大小、是否动到登录/支付/数据库迁移/CI 等敏感文件、测试是否通过。 | 直接结束 · 请 ChatGPT 复核（REVIEW） |
| **ChatGPT 说 DONE + FOLLOWUPS** | Jev 逐条估每项小修改的改动量；代码对敏感内容设硬门槛。 | Codex 直接改完收尾（切回 Codex） · 改完再请 ChatGPT 看一眼 |

几条硬性原则（都由代码保证，并有测试覆盖）：

- **能不能跳过复核，永远不由 Jev 决定。** Jev 的回答只能让系统更谨慎，不能让它更松。
- **Jev 不可用时**（没配 key、网络被拦、超时），行为退回原版：不会自动升级，也不会跳过复核。
- **你说了算。** 「别找 ChatGPT」「让 ChatGPT 来规划」随时生效。
- **不来回反复。** 每个任务最多自动切到 ChatGPT 一次。
- **永远不卡住任务。** 每个决策命令都返回合法 JSON，退出码为 0。intake 调用 Jev 的时间上限是 3 秒。

## 实测效果

2026-09-24 用 `jev-1.13.0` 在线评测，共 152 个样本，73% 为中文或中英混合：

| 指标 | 结果 | 启用标准 |
|---|---|---|
| 路由一致率（balanced） | **96.5%**（中文 93.3%，英文 98.4%） | ≥ 85%，中文 ≥ 80% |
| 路由一致率（economy / speed） | 95.5% / 96.9% | |
| intake 延迟 p95 | **274 ms** | ≤ 1.5 s |
| 底线违例 / 注入违例 | **0 / 0** | 必须为 0 |
| 高置信（0.8–1.0）答案准确率 | 95.4%（n = 544） | |

单题准确率比路由一致率低，比如 `goal_is_clear` 只有 65.8%。这是预期内的：路由把多个概率加权合并后再和阈值比较，单题判错多数时候不会改变最终走哪条路。另外，评测样本是本项目自己编写并标注的，真实效果以你实际使用为准。可以用 `c2c route feedback` 纠正、用 `c2c route stats` 观察。

---

## 快速开始

需要：macOS 或 Windows、Node.js ≥ 20、git、[Codex](https://openai.com/codex) 桌面版、ChatGPT Plus/Pro 账号。智能切换另需一个 [TypeSafe](https://console.typesafe.ai) API key。

### 1. 安装（把这段话交给 Codex）

```text
请帮我完整安装并配置 JEV Switch（Codex with ChatGPT 的分支），全程自动：

1. 环境自检：需要 git 和 Node.js ≥ 20，缺什么就自动安装
  （macOS 用 Homebrew，Windows 用 winget），同时安装 cloudflared。
2. 下载：把 https://github.com/FlyPig23/Codex_ChatGPT_JEV_Switch 克隆到
   ~/Codex_ChatGPT_JEV_Switch（已存在就 git pull 更新）。
3. 构建：在该目录里执行 corepack pnpm install 和 corepack pnpm build。
4. 安装 Skill：把仓库里的 skill/SKILL.md 复制到
   ~/.codex/skills/codex-with-chatgpt/SKILL.md，并把文件中
   "The codex-with-chatgpt checkout lives at:" 那一行的路径改成实际克隆路径。
   如果之前装过原版 codex-with-chatgpt，用这个版本覆盖它，不要两个同时装。
5. 首次配置：按 SKILL.md 里的 first-time setup 流程执行
  （运行 c2c setup，用内置浏览器打开 ChatGPT 配置连接器并输入配对码）。
   全程只用内置浏览器，禁止打开任何第三方浏览器。
6. 只有遇到需要我登录（ChatGPT / Cloudflare）、验证码或两步验证时才叫我，
   而且一次只告诉我一个动作。
7. 完成后给我看 ✓ 清单，并确认文件读取测试通过。
```

完成后你会看到：

```
Codex with ChatGPT

✓ 当前项目已识别
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

之后说「使用 Codex with ChatGPT，帮我实现 XXX」，就走原版的 ChatGPT 规划流程。

### 2. 开启智能切换（配置 Jev key）

Key 只在你自己的终端里输入，不经过聊天，Codex 也看不到它。

1. 在 [TypeSafe 控制台](https://console.typesafe.ai) 创建一个 API key。
2. 打开 macOS「终端」或 iTerm。**不要用 Codex 里内置的终端**：那里带有 `CODEX_SANDBOX` 等环境变量，setup 会拒绝运行。
3. 运行：

   ```bash
   node ~/Codex_ChatGPT_JEV_Switch/bin/c2c.js route setup
   ```

   它会依次：
   - 说明哪些内容会发给 TypeSafe，然后问 `同意并启用智能切换？[y/N]`，输入 `y`；
   - 让你粘贴 key，输入时不显示。建议直接粘贴，不用环境变量：Codex 桌面版不一定能读到你 shell 里的环境变量；
   - 实际调用一次 Jev，显示 ✓ 或 ✗；
   - 保存 key，开启智能切换；
   - 问要不要安装 `c2c-router` 技能，回车即安装。
4. 验证：

   ```bash
   node ~/Codex_ChatGPT_JEV_Switch/bin/c2c.js route status --probe --json
   ```

   看到 `"enabled": true` 和 `"jev": "reachable"` 就配好了。输出里只显示 key 指纹的前 8 位。
5. 重开一个 Codex 会话，新技能就会生效。之后正常提需求即可，不用再说「使用 Codex with ChatGPT」。

Key 保存在 `~/Library/Application Support/codex-with-chatgpt-keys/`（Windows 为 `%LOCALAPPDATA%\codex-with-chatgpt-keys`），目录权限 0700、文件 0600，位于 Codex 沙箱可写目录之外。换 key 或关闭：`route setup --remove`，再重新 setup。

## 日常使用：你可以这么说

| 你说 | 效果 |
|---|---|
| 这次让 ChatGPT 来规划 | 这个任务固定走 ChatGPT |
| 别找 ChatGPT / 不用 ChatGPT，你自己做 | 这个任务固定由 Codex 做 |
| 让 ChatGPT 看看 / 复核一下 | 立即请 ChatGPT 复核当前改动 |
| 以后优先省 Codex 额度 | 偏好改为 `economy`：更早、更多地把思考交给 ChatGPT |
| 以后优先快一点 | 偏好改为 `speed`：尽量少来回 |
| 关闭 / 开启自动切换 | 全局开关（保留 key） |
| 这个项目别自动找 ChatGPT | 只对当前项目关闭 |
| 刚才不该找 ChatGPT / 刚才应该找 ChatGPT | 记一条反馈，用于之后调参 |

路由第一次说话时会附一句提示：「我会按任务自动决定是否请 ChatGPT 参与；随时可以说「这次别找 ChatGPT」或「让 ChatGPT 来规划」。」

## 哪些内容会发给 TypeSafe

只有你运行过 `route setup` 之后才会发送。只发往固定地址 `https://api.typesafe.ai`，默认模型 `jev-1.13.0`（可用 `route prefs set --model` 固定到其他版本）。

| 时机 | 发送的内容（上限） | 不会发送 |
|---|---|---|
| 新任务 | 你的需求原文：去掉代码块、脱敏，≤ 1500 字 | 文件内容、diff、日志、项目信息 |
| 命令失败（第 2 次起） | 命令（脱敏，≤ 200 字）+ 报错行（≤ 40 行 / 2000 字，可能含报错里出现的文件路径） | 任务目标、完整日志 |
| 收尾 | 不发送（纯代码判断） | — |
| ChatGPT 列出的小修改 | 每条 ≤ 300 字，最多 12 条，脱敏 | ChatGPT 回复的其余部分、代码块 |

发送前会做这些处理：去掉代码块；脱敏各类 API key、JWT、URL 里的密码、`密码：…` / `password=…` 形式的值、命令行里的凭据、邮箱、公网 IP、高熵字符串以及你的 TypeSafe key；截断长度；按每个时机的严格 schema 校验。

以下情况不会调用 Jev：
- 需求里提到「保密 / 不要上传 / confidential」，这时也不会自动找 ChatGPT；
- 文本里含私钥；
- 命中了确定性规则，不需要问 Jev。

本地决策日志只记录数字和枚举，不记录任何原文。

TypeSafe 声明不会用输入数据训练模型，但保存期限没有固定时长，零数据保留只对企业客户提供。某个仓库的内容如果不能给第三方处理，请对它运行 `c2c route disable -w <仓库>`。详见 [docs/security.md](docs/security.md)。

## 命令速查

下面的 `c2c` 指 `node ~/Codex_ChatGPT_JEV_Switch/bin/c2c.js`。

| 命令 | 用途 |
|---|---|
| `c2c route setup [--remove]` | 开启或关闭智能切换（只能在你自己的终端里运行） |
| `c2c route status [--probe] --json` | 查看模式、偏好、key 指纹、Jev 连通性 |
| `c2c route prefs set --mode off\|auto --bias economy\|balanced\|speed` | 全局设置 |
| `c2c route disable\|enable -w <项目>` | 单个项目开关 |
| `c2c route stats -w <项目>` | 最近的路由情况，一行中文总结 |
| `c2c route log -w <项目>` | 最近的决策记录（只有数字和枚举） |
| `c2c route feedback -w <项目> --last --verdict right\|wrong` | 标注最近一次决策 |
| `c2c route eval [--live] [--save-answers <文件>] [--replay <文件>]` | 用内置样本评测路由 |

`intake`、`failure`、`review-gate`、`reply`、`pin`、`message` 这几个决策命令由 Codex 通过技能调用，一般不用手动运行。加 `--explain` 可以看每一步的信号、概率和阈值；加 `--dry-run` 可以看将要发送的内容，但不实际发送。完整说明见 [docs/routing.md](docs/routing.md)。

## 评测与调参

```bash
# 离线：只检查确定性规则和策略回放，不联网，也不需要 key
node bin/c2c.js route eval

# 在线：真实调用 Jev，约 150 次，费用约 $0.01；保存答案供之后离线回放
node bin/c2c.js route eval --live --save-answers ~/jev-answers.json

# 只改了阈值或策略（没改问题）时，用保存的答案离线验证，不花钱
node bin/c2c.js route eval --replay ~/jev-answers.json
```

- 阈值在 [src/router/policy.ts](src/router/policy.ts) 的 `THRESHOLDS` 里，按 `economy` / `balanced` / `speed` 三种偏好分别设置。
- Jev 的问题定义在 [src/router/questions.ts](src/router/questions.ts)。
- 样本在 [src/router/fixtures/](src/router/fixtures/)。

调整策略后，用下面的命令重新生成样本的期望结果：

```bash
node --import tsx scripts/regen-router-fixtures.ts --write
```

## 工作原理

```
用户需求 ─► [c2c-router 技能] ─► c2c route intake ─┬─ Codex 直接做 ──┬─ 失败 ─► route failure ─┬─ 继续修
                                                  │                  │                         ├─ DEBUG ─► ChatGPT 找根因
                                                  │                  │                         └─ 问你
                                                  │                  └─ 收尾 ─► route review-gate ─┬─ 直接结束
                                                  │                                                └─ REVIEW ─► ChatGPT 复核
                                                  ├─ Codex 做完请复核 ─► review-gate ─► REVIEW ─► ChatGPT 复核
                                                  ├─ ChatGPT 先出方案 ─► 原版 C2C 协作流程
                                                  └─ 先问你一句
ChatGPT: DONE + FOLLOWUPS ─► route reply ─┬─ Codex 直接改完收尾（切回 Codex）
                                          └─ 改完再请 ChatGPT 看一眼
```

- **两个技能**：`c2c-router`（[router-skill/SKILL.md](router-skill/SKILL.md)，约 80 行）在普通写代码的请求上触发。只有确实要找 ChatGPT 时，才加载完整的 `codex-with-chatgpt` 技能（[skill/SKILL.md](skill/SKILL.md)），避免每个小改动都读几十 KB 的说明。
- **协议扩展，向后兼容**：新增 `MODE: REVIEW`（Codex 已经做完，请 ChatGPT 复核）和 `MODE: DEBUG`（Codex 卡住，请 ChatGPT 找根因）两种 INIT，以及 DONE 后可选的 `FOLLOWUPS:` 段。说明都写在消息正文里，已有的对话无需重新发引导词。详见 [docs/protocol.md](docs/protocol.md)。
- **原版的数据通路不变**：ChatGPT 仍然只通过只读 MCP 读代码，控制消息里从不粘贴文件、diff 或日志。

原版 C2C 的架构（只读 MCP 桥、OAuth 2.1 + 一次性配对码、Cloudflare 隧道）见 [docs/architecture.md](docs/architecture.md)。

## 相对原版的其他改进

- **更新检查**：跟随本地分支所跟踪的远端分支，fork 也能正确判断是否有新版本。更新时不会再用 `git stash` 改动你的本地修改。
- **`c2c record --output-file`**：拒绝读取敏感文件（`.env`、`~/.ssh` 等）和符号链接。
- **共享脱敏器**：补充了更多凭据格式，例如 `sk-proj-`、`sk_live_`、JWT、URL 中的密码。
- **会话检查点**：切换到新任务时不再继承上一个任务的字段。新增 `--init-mode`、`--routed-by`、`--close-local` 三个参数。

## 从原版迁移 / 同步上游

已经装过原版 codex-with-chatgpt 的：用本仓库的 `skill/SKILL.md` 覆盖 `~/.codex/skills/codex-with-chatgpt/SKILL.md`（把路径那一行改成本仓库的路径），并删掉原版技能的其他副本。本地状态目录两者通用，已连接的 ChatGPT 连接器不需要重建。

同步原版的更新：

```bash
git remote add upstream https://github.com/XiaoDuoYa/codex-with-chatgpt.git
git fetch upstream && git merge upstream/main
```

## 开发

```bash
corepack pnpm install
corepack pnpm build        # 产出 dist/；bin/c2c.js 优先使用 dist/
corepack pnpm test         # vitest：1167 个测试，全程不联网
corepack pnpm typecheck
```

路由模块在 `src/router/`：

```
types.ts       共享类型与枚举          policy.ts     纯函数策略与阈值
questions.ts   Jev 问题定义            signals.ts    确定性信号（正则、错误签名、路径分类、改动统计、连接探测）
outbound.ts    外发脱敏与 schema 校验   jev.ts        固定端点/模型的 TypeSafe 客户端、熔断
messages.ts    next/say 模板、REVIEW/DEBUG INIT    index.ts    各决策点的编排
secrets.ts     key 与同意记录           setup.ts      终端交互式开启
state.ts       单任务路由状态           log.ts        仅数字的决策日志与统计
eval.ts        评测                     fixtures/     评测样本
```

CLI 入口在 [src/cli/route.ts](src/cli/route.ts)。

## 文档

[智能切换](docs/routing.md) · [协议](docs/protocol.md) · [安全](docs/security.md) · [架构](docs/architecture.md) · [故障排查](docs/troubleshooting.md)

## 致谢与声明

- 基于 [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)（MIT）。原版的桥接、OAuth、隧道、技能与协议设计都来自原作者。
- 智能切换使用 [TypeSafe](https://typesafe.ai) 的 Jev 模型和官方 [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)。
- **非官方社区项目，与 OpenAI、TypeSafe 均无关联，也未获它们背书。**
- 许可证：[MIT](LICENSE)。
