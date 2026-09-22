# dsh-confirmation-resolution

[![offline verification](https://github.com/bbaz123/dsh-confirmation-resolution/actions/workflows/offline-verification.yml/badge.svg)](https://github.com/bbaz123/dsh-confirmation-resolution/actions/workflows/offline-verification.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522.19.0-brightgreen.svg)](https://nodejs.org)
[![offline tests](https://img.shields.io/badge/offline%20tests-58%20passing-brightgreen.svg)](https://github.com/bbaz123/dsh-confirmation-resolution/actions/workflows/offline-verification.yml)

**让 DSH 在任务完成后的"待确认事项"阶段，既不机械照做，也不反复询问。**

`dsh-confirmation-resolution` 是一个用于 DeepSeek Harness（DSH）的待确认事项决策插件。

当 DSH 完成主任务、留下 `C1` / `C2` / `C3` … 等待确认事项之后，用户的回复不会被简单理解为"照原话修改"。

插件会按照固定顺序判断：

```
整体质量影响
      ↓
保持现状是否影响用户实际使用
      ↓
用户真实目标
      ↓
最优可行方案
```

最终决定：

| 情况 | 决定 |
| --- | --- |
| 质量不受损 | `MODIFY` |
| 质量会下降，但保持现状不影响实际使用 | `KEEP_CURRENT` |
| 质量会下降，而且保持现状会影响实际使用 | `MODIFY` → 选择用户收益更高、质量损失更小、副作用更少的方案 |

## 核心特性

- **固定决策顺序，不是模型即兴判断**：`质量影响` → `保持现状是否影响实际使用` → `用户真实目标` → `最优可行方案`。
- **用户提出的做法只是一个候选方案**。它必须通过同一组硬性淘汰条件，不会因为用户说了就照做。
- **代码级硬守卫 + 会话账本**：未登记的 `C` 编号、已关闭的确认项会被拒绝（`NOT_APPLICABLE`），
  而不是被静默当成一次决策。硬守卫不依赖模型是否遵守 Prompt。
- **三态状态机**：`register → decide → complete`。`MODIFY` 决策后必须真的执行成功才变 `RESOLVED`，
  执行失败可重试，不会把确认项永久关死。
- **纯函数决策核心**：`lib/decide.js` 无 I/O、无服务访问、无定时器，可完全离线单测。
- **零构建、零配置、零运行时依赖**：纯 ESM，无编译步骤；只依赖宿主 DSH 提供的
  `tools` 与 `systemPrompt` 两个服务；安装后规则自动进入每个会话的 System Prompt。

## 为什么需要它？

例如 DSH 完成一个页面后提出：

> **C1** — 是否需要进一步强化主操作按钮？

用户回复：

> 把按钮放大 300%

插件不会因为用户说了"放大 300%"就机械执行。它先区分两件事：

```
用户提出的方案     按钮放大 300%
用户真正的目标     让关键操作更容易发现
```

再比较候选方案：

```
放大 300%
适度增加尺寸
调整视觉层级
改善位置与间距
提高对比度
```

最后选择能解决真实问题、同时质量损失与副作用更小的方案：

```
没有本插件（或模型直接照做）
→ 按钮放大 300%，布局被挤压，视觉层级失衡

有本插件
USER_GOAL                 提高关键操作的可发现性        ← 先识别真实目标，而不是执行字面做法
QUALITY_IMPACT            MEDIUM（300% 会显著破坏布局）
USER_IMPACT_IF_UNCHANGED  MEDIUM（用户确实找不到入口）
ACTION                    MODIFY
SELECTED_SOLUTION         把主按钮提高一个视觉层级，并强化局部间距
EXECUTION_SCOPE           主按钮尺寸、层级、局部间距
DO_NOT_CHANGE             页面整体布局、导航结构、其他组件
```

也就是说：**目标达成，质量损失更小，边界写死。** 如果用户的做法本来就是最优解，它会照采用；
如果保持现状根本不影响实际使用（纯审美偏好），它会返回 `KEEP_CURRENT`，而不是为了讨好用户
牺牲质量。

## 只在待确认阶段生效

这个插件不是全局修改规则。只有同时满足以下条件时，才进入确认决策流程：

```
主任务已经完成
+
DSH 已经主动输出待确认事项
+
用户当前正在回复其中某个待确认事项
```

普通新任务、普通修改、新需求和无关 follow-up 继续使用 DSH 原有行为。

## 双层触发保护

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 软规则 | System Prompt 段落 + 工具描述 | 告诉模型什么时候应该调用、什么时候不该调用 |
| **硬守卫** | `execute()` + 会话账本（Session Ledger） | **代码级校验**：这个 `C` 编号是否真的由当前会话发布过、是否仍处于未关闭状态 |

未登记的确认项、已经完成的确认项会被**拒绝**（返回 `NOT_APPLICABLE`），而不是进入决策流程：
**没有任何隐式登记后门**，也不会被静默当成一次"决策"处理。
硬守卫不依赖模型是否遵守 Prompt——这正是本插件与"只靠提示词约束"的区别所在。

## 状态机

每个确认事项都经过明确的生命周期：

```
DSH 输出 C1
      ↓
register(C1)  → 登记本轮发布的编号      STATUS = REGISTERED，状态 PENDING
      ↓
用户回复 C1
      ↓
decide(C1)    → 账本校验 → 固定决策
      │
      ├─ KEEP_CURRENT → 决策即完成 ───────────────────→ RESOLVED
      │
      └─ MODIFY       → STATUS = READY_TO_EXECUTE
                        （账本状态 AWAITING_EXECUTION：等待执行）
                              ↓
                        DSH 实际执行
                              ↓
                        complete(C1)  → STATUS = REGISTERED，状态 RESOLVED
```

**`MODIFY` 决策不等于执行。** 只有 DSH 真的执行成功、并调用 `complete(C1)` 之后，该项才变成
`RESOLVED`；如果修改执行失败，就不要调用 `complete`，确认项保持**等待执行**，可以重新决策、
重试执行，不会被误判成"已经完成"。`KEEP_CURRENT` 是自完成的——不修改本身在决策那一刻就已完成。

**每一次新的决策都会先废除上一份尚未执行的授权。** 重试 `decide` 时，旧的 MODIFY 授权在重新计算
**之前**就被撤销；因此如果这次的结果是 `INSUFFICIENT_CONTEXT`，该项回到 `PENDING`，
`complete` 再也无法拿旧授权把它关掉。不存在"最新判断是信息不足、旧 MODIFY 却仍可完成"这种状态。

## 插件不会直接修改你的项目

`confirmation_resolution` 只负责：

```
判断质量影响
判断用户实际使用影响
识别决策条件
淘汰不合理方案
比较候选方案
返回 MODIFY / KEEP_CURRENT
限制允许修改的范围
```

它**不会直接修改**你的页面、代码、文件、设计稿或项目结构，也**不自动执行**任何东西。
实际修改仍由 DSH 完成。

## 设计目标

这个插件试图避免两个极端：

```
极端 1    用户说怎么改 → 不判断影响，直接照做
极端 2    为了保护当前结果 → 忽略真实的用户使用问题
```

目标是：**当修改不会降低质量时满足用户；当修改会降低质量且没有实际使用收益时保持现状；
当真实使用确实受到影响时，解决问题，同时尽可能减少质量损失和副作用。**

## Quick start

```powershell
# 1. 安装进你的 profile（会同时写入 dsh.profile.bundles）
dsh plugin --profile web add <本仓库路径>

# 2. 重启 DSH（bundle 层在启动时组合，不会热加载）

# 3. 验证：退出码 0 且输出含 id: confirmation-resolution
dsh --profile web --dump-config
```

`dsh` 启动时会执行 `assertEntriesActivated`：任何一条行无法解析或无法激活都会让整个 profile 启动失败。
因此 `--dump-config` 退出码 0 等价于「该行已成功解析并激活」。

不需要任何配置项。规则会自动出现在每个会话的 System Prompt 中（段落名 `confirmation:policy`）。

## Behavior：状态与 STATUS 契约

工具 `confirmation_resolution` 有三个动作，DSH 按序使用；**账本状态的唯一写入者是这个工具本身**：

```
register → 登记本轮发布的 C 编号        → STATUS = REGISTERED，状态 PENDING
decide   → 账本校验 → 决策              → MODIFY：READY_TO_EXECUTE，状态 AWAITING_EXECUTION
                                          KEEP_CURRENT：决策即完成 → RESOLVED
complete → DSH 实际执行成功后调用        → STATUS = REGISTERED，状态 RESOLVED
```

四种 STATUS：

| STATUS | 含义 | DSH 应当怎么做 |
| --- | --- | --- |
| `REGISTERED` | 账本写入成功（`register` 登记，或 `complete` 关闭） | 这不是拒绝，按 notes 继续 |
| `READY_TO_EXECUTE` | 决策完成，等待执行 | 按 `SELECTED_SOLUTION` 执行；成功后调用 `complete` |
| `INSUFFICIENT_CONTEXT` | 信息不足，未做决策 | 补齐 `MISSING_INFORMATION` 后重新 `decide`；该项保持 `PENDING` |
| `NOT_APPLICABLE` | **守卫拒绝，属于非法调用** | 不重试、不执行，改走正常 DSH 流程 |

`complete` **只在状态为 `AWAITING_EXECUTION` 时被接受**，因此 `register` 之后直接 `complete`
会被拒绝（`ITEM_NOT_AWAITING_EXECUTION`）。也就是说"必须经过 decide"是**代码强制**的，
不是 Prompt 要求。

`NOT_APPLICABLE` 的触发条件：编号在本会话从未 `register` 过、已 `RESOLVED` 且未被用新文本重新发布、
或 `complete` 时没有待执行的 MODIFY 裁决。

### 同一会话里编号可以跨轮复用

一个长会话里完成第一个任务后开始第二个任务时，DSH 很自然又会从 C1 开始编号，**用户仍然只看到 C1**。
接受与拒绝的界线是明确的：

| 该编号的当前状态 | `register` 的结果 |
| --- | --- |
| 不存在 | 登记成功（第 1 轮） |
| `PENDING`（等用户回复） | **拒绝** `CONFIRMATION_ID_STILL_OPEN`——不覆盖正在处理中的项 |
| `AWAITING_EXECUTION`（等执行） | **拒绝** `CONFIRMATION_ID_STILL_OPEN`——连新文本也不行 |
| `RESOLVED` + **相同**文本 | **拒绝** `ITEM_ALREADY_RESOLVED`——重复登记，不复活已结束项 |
| `RESOLVED` + **新**文本 | 开启新一轮：回到 `PENDING`，轮次 +1，上一轮裁决被清空 |

新一轮必须重新 `decide`：**上一轮的裁决不会授权新一轮的 `complete`**。
换句话说，编号只有在**真正结束之后**才能被复用。

## Architecture

```
lib/
├── rules.js     01 触发/执行规则文本 → 注册为全局 System Prompt 段落（唯一事实来源）
├── decide.js    02 固定决策算法：纯函数、无 I/O、不做自然语言推断
├── ledger.js    会话级确认项账本：纯状态容器，按 exec.agent.id 隔离
└── index.js     Cordis 装配 + 代码级守卫 + 状态机（register / decide / complete）
```

职责边界：本插件是**方案评审器，不是方案生成器**。调用前 DSH 必须完成四件事——

1. 识别 `user_goal`（**`ACTION = MODIFY` 时必填**，缺失返回 `INSUFFICIENT_CONTEXT` +
   `USER_GOAL_REQUIRED_FOR_MODIFY`；`KEEP_CURRENT` 不需要，因为它不选方案）；
2. 判断 `quality_impact`（或给出 `quality_dimensions` 证据）；
3. `quality_impact !== NONE` 时判断 `user_impact_if_unchanged`；
4. 生成 2–3 个 `candidate_solutions` 供淘汰与排序。

第 4 项缺失时返回 `INSUFFICIENT_CONTEXT` 而不是自行编造方案——这正是决策核心能保持纯函数、
测试稳定的原因。候选方案的排序优先级（`02 §8`）：解决真实问题 → 用户收益 → 质量损失更小 →
副作用更少 → 系统一致性 → 稳定性 → 实现复杂度。

仓库根目录另附三份规范 `.docx` 源文件，与代码的对应关系：

| 规范文件 | 负责 | 落地位置 |
| --- | --- | --- |
| `01_DSH_System_Prompt_待确认事项触发规则` | 触发与执行层 | `lib/rules.js` → System Prompt 段落 |
| `02_Confirmation_Resolution_Plugin_执行规则` | 决策层 | `lib/decide.js` + `lib/index.js` |
| `03_DSH_待确认事项决策规范` | 规范、校验与测试 | `test/`（**不注入**运行时） |

## Testing

```powershell
npm run test:offline   # 58 个用例：纯决策算法 + 账本，任何机器都能跑，不需要 DSH
npm test               # 94 个用例：上面 + 端到端生命周期 + 驱动真实注册工具的状态机与守卫用例（需要 DSH）
npm run verify         # 23 项：真实 Cordis 上下文 + 真实 defineTool 的装配验证（需要 DSH）
npm run check          # 语法 + 全部测试 + 装配验证（需要 DSH）
```

`test/e2e-lifecycle.test.mjs` 是端到端叙事测试：走完一个会话的完整生命周期
（发布 → 登记 → 决策 → **执行失败可重试** → 执行成功关闭 → **新轮复用编号** → 非法调用被拒），
每一步都断言下一步所依赖的状态，因此流程一旦偏离文档化的状态机就会在偏离处失败。
它驱动真实注册的工具，所以与 `ledger-guard.test.mjs` 一样需要 DSH。

测试能分层的依据是精确的：`lib/decide.js`、`lib/ledger.js`、`lib/rules.js` **不 import 任何外部包**，
所以只覆盖它们的用例可以完全离线运行；而任何 import 到 `lib/index.js` 的用例都会拉入宿主的
`@deepseek-ai/dsh-tools`（它自己又依赖 `dsh-scope`/`dsh-llm`/`dsh-session` 等宿主内部模块），
因此必须在已安装 DSH 的环境里跑。`npm run verify` 用 `DSH_HOME` 与 `DSH_PROFILE` 定位 profile，
没有硬编码路径；找不到 DSH 时以退出码 2 明确报错，**不会把"没能执行"当成通过**。

覆盖重点：决策矩阵的三种结果、硬性淘汰门、跨字段矛盾输入、信息不足不回落原方案、
状态机的 `register → decide → complete`、无隐式登记、会话隔离。

## Compatibility

- Node.js ≥ 22.19.0；纯 ESM，无构建步骤。
- Cordis 4（`@deepseek-ai/cordis`）；宿主服务 `tools`、`systemPrompt`。
- 依赖闭包与打包时的 DSH 一致（`dsh-tools`/`dsh-brand`/`dsh-util-values` `0.1.5-rc.2`、
  `cordis` `4.0.2`、`schemastery` `3.18.2`）。DSH 版本差异较大时按下方说明重新生成依赖闭包。

## Uninstall

```powershell
dsh plugin --profile web remove dsh-plugin-confirmation-resolution
```

行随 bundle 层一起消失，System Prompt 段落与工具同时下线（两者都是 fiber 作用域的可逆 effect）。
卸载后 DSH 恢复原行为：不再有确认项决策流程，也不再有这几条 System Prompt 规则。

## Roadmap

- **可配置的决策边界**：把"什么算影响实际使用"的判断维度暴露成配置，而不是只有一套固定口径。
- **账本可选持久化**：目前账本按会话隔离且**不持久化**（DSH 重启即空）。是否需要跨重启保留，
  属于契约变更，需先讨论（见 `AGENTS.md`）。
- **决策轨迹可观测**：把每次 `decide` 的输入维度与淘汰理由输出成结构化日志，便于事后复盘。
- **跟随宿主演进**：持续跟踪 DSH 宿主内部模块的版本变化，验证装配兼容性。

> Roadmap 是方向而不是承诺。想推进其中某项，欢迎先开 issue 讨论范围与契约影响。

## Contributing

欢迎贡献。请先读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)（怎么改、怎么验）与
[`AGENTS.md`](./AGENTS.md)（项目结构、职责边界与硬性约定）。

最快的自检（**不需要安装 DSH**）：

```powershell
npm run test:offline   # 应 58/58
```

CI 在 Node 22 与 24 上跑这层离线套件，并额外断言"没有 DSH 时 `verify` 必须以退出码 2 报错"——
防止验证套件在根本跑不起来时静默通过。

## License

[Apache License 2.0](./LICENSE) © 2026 bbaz123

---

<details>
<summary><b>维护者说明：自包含分发副本、依赖模型与同步步骤</b>（点开）</summary>

### 两个物理副本

| | 路径 | 说明 |
| --- | --- | --- |
| 源仓库 | 本仓库 | 唯一开发位置 |
| 分发副本 | 同名目录 + 同名 `.zip` | 自包含离线包，用于备份或搬到另一台机器 |

> **副本不会自动跟随仓库更新。** 曾经出现过"仓库已修好、分发副本仍是旧版，于是按副本评审时看到旧代码"
> 的事故。凡改动 `lib/`、`test/`、`verify/`、`tools/` 或根目录元数据，都必须重新同步并复验。

### 依赖模型

- **随包携带**：`lib/`、`test/`、`verify/`、`tools/`、`cordis.patch.yml`、`package.json`、`README.md`、
  `AGENTS.md`、`LICENSE`、`CONTRIBUTING.md`、三份规范 `.docx`，以及 `node_modules` 中的直接依赖闭包 —— `@deepseek-ai/dsh-tools`、
  `@deepseek-ai/schemastery`、`@deepseek-ai/cordis` 及三者的运行期依赖
  （`@deepseek-ai/cosmokit`、`@deepseek-ai/dsh-brand`、`@deepseek-ai/dsh-util-values`、
  `@standard-schema/spec`，共 7 个包）。依赖是**真实目录副本**而非目录链接，移动或解压后仍可用。
- **不随包携带**：目标 DSH 自身提供的 peer 包（`dsh-agent`、`dsh-llm`、`dsh-scope`、`dsh-session`、
  `dsh-invariants`、`dsh-system-prompt`、`cordis-plugin-loader` 等）。这是刻意的：这些是**宿主内部模块**，
  自带副本会造成模块身份冲突。目标机器上必须已安装 DSH。
- 依赖闭包由 `tools/materialize-deps.mjs` 生成，可重复执行：

```powershell
node tools/materialize-deps.mjs <bundleDir> "$env:USERPROFILE\.dsh\profiles\node_modules"
```

因此：**在未安装到 profile 的独立副本目录里跑 `npm test` 会因宿主 peer 无法解析而失败**，
这是依赖模型的预期结果，不是缺陷。副本里请用 `npm run test:offline`（应 58/58 通过）；
装进 profile 后再跑 `npm test`（应 94/94）与 `npm run verify`（应 23/23）。

### 在目标机器上安装

```powershell
dsh plugin --profile <profile> add <解压目录>
# 然后重启 DSH 使宿主组合重新加载
```

安装验证：`dsh --profile <profile> --dump-config` 退出码 0 且输出包含 `id: confirmation-resolution`。

### 重新同步分发副本（改完仓库必做）

```powershell
$src  = '<仓库路径>'
$pack = '<分发副本路径>'
foreach ($d in 'lib','test','verify','tools') {
  Remove-Item (Join-Path $pack $d) -Recurse -Force
  Copy-Item (Join-Path $src $d) $pack -Recurse -Force
}
foreach ($f in 'README.md','AGENTS.md','package.json','cordis.patch.yml','.gitignore',
               'LICENSE','CONTRIBUTING.md',
               '01_DSH_System_Prompt_待确认事项触发规则.docx',
               '02_Confirmation_Resolution_Plugin_执行规则.docx',
               '03_DSH_待确认事项决策规范_维护与测试基准.docx') {
  Copy-Item (Join-Path $src $f) $pack -Force
}
# 副本目录里宿主 peer 不可解析，因此跑离线层（不要跑 npm test）
cd $pack; npm run test:offline
```

复验判据（缺一不可）：副本内 `lib/ledger.js` 存在、`lib/index.js` 含 `ledger.guard` 与
`action === 'complete'`、`lib/decide.js` 含 `USER_GOAL_REQUIRED_FOR_MODIFY`、
`npm run test:offline` 全绿。

</details>
