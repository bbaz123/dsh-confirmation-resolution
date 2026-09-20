# dsh-confirmation-resolution

**让 DSH 在"完成后待确认"这一步，既不机械照做，也不反复追问。**

DSH 完成任务后有时会留下几个待确认项。用户回答之后，普通流程有两种坏结局：模型**机械照做**
（用户说"放大 300%"就真的放大 300%，哪怕会破坏布局），或者**反复确认**（同一件事问第二遍）。
本插件把这一步变成一个受约束的决策流程：先判断真实目标，再在质量影响、实际使用影响和替代方案之间选择，
最后返回一个带边界的具体执行方案。

## 30 秒说明

- **它解决什么问题**：把"用户回复确认项"从一句礼貌的"好的，照做"变成一次有依据的决策——
  用户提出的**具体做法只是候选方案之一**，不自动获胜。
- **它只在什么时候生效**：仅当**主任务已完成 → DSH 已列出待确认事项 → 用户正在回复其中某一项**这个窗口内。
  首次任务、普通修改、无关追问一概不进入本流程。**它不是全局修改插件。**
- **它不会做什么**：**不修改你的页面、代码、文件、设计稿或项目结构**，也**不自动执行任何东西**。
  它只返回方案与边界，实际改动由 DSH 按方案完成。

## Example

用户对 C1 的回复是"**把主按钮放大 300%**"。

**没有本插件**（或模型直接照做）：

```
→ 按钮放大 300%，布局被挤压，视觉层级失衡
```

**有本插件**：

```
USER_GOAL          提高关键操作的可发现性          ← 先识别真实目标，而不是执行字面做法
QUALITY_IMPACT     MEDIUM（300% 会显著破坏布局）
USER_IMPACT_IF_UNCHANGED  MEDIUM（用户确实找不到入口）
ACTION             MODIFY
SELECTED_SOLUTION  把主按钮提高一个视觉层级，并强化局部间距
EXECUTION_SCOPE    主按钮尺寸、层级、局部间距
DO_NOT_CHANGE      页面整体布局、导航结构、其他组件
```

也就是说：**目标达成，质量损失更小，边界写死。** 如果用户的做法本来就是最优解，它会照采用；
如果保持现状根本不影响实际使用（纯审美偏好），它会返回 `KEEP_CURRENT` 而不是为了讨好用户牺牲质量。

## How it works

固定决策链（顺序不可绕过）：

```
QUALITY_IMPACT                这次修改会不会降低整体质量？
      ↓
USER_IMPACT_IF_UNCHANGED      不改的话，用户实际使用会受影响吗？
      ↓
USER_GOAL                     用户真正想达到什么？
      ↓
BEST_SOLUTION                 在候选方案里选损失最小、副作用最少的那个
```

三种结果：

| 情况 | 结果 |
| --- | --- |
| 修改不降低质量 | `MODIFY`，选最优方案 |
| 修改降低质量，但保持现状不影响实际使用 | `KEEP_CURRENT`，不改 |
| 修改降低质量，且保持现状影响实际使用 | `MODIFY`，但选质量损失更小的替代方案 |

### 两层保护：Prompt 软约束 + 会话账本硬约束

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 软保护 | System Prompt 段落 + 工具描述 | 告诉模型何时该调用、何时不该调用 |
| **硬保护** | `execute()` + 会话账本 | **真正拒绝**非法调用，不依赖模型遵守 Prompt |

硬保护是代码级的：编号必须先 `register` 登记过，**没有任何隐式登记后门**；
未登记或已关闭的编号会被拒绝并返回 `NOT_APPLICABLE`，不会静默按"决策"处理。

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

## Behavior

工具 `confirmation_resolution` 有三个动作，DSH 按序使用；**账本状态的唯一写入者是这个工具本身**：

```
register → 登记本轮发布的 C 编号        → STATUS = REGISTERED，状态 PENDING
decide   → 账本校验 → 决策              → MODIFY：READY_TO_EXECUTE，状态 AWAITING_EXECUTION
                                          KEEP_CURRENT：决策即完成 → RESOLVED
complete → DSH 实际执行成功后调用        → STATUS = REGISTERED，状态 RESOLVED
```

**`MODIFY` 决策不等于执行**：`decide` 之后该项进入 **`AWAITING_EXECUTION`**（等待执行），
只有执行成功并调用 `complete` 才变成 `RESOLVED`。执行失败时不要调用 `complete`，
该项保持 `AWAITING_EXECUTION`，可以再次 `decide`——不会出现"执行失败却已被关闭、
重试反被判 `ALREADY_RESOLVED`"的情况。`KEEP_CURRENT` 是自完成的（不修改本身在决策那一刻就已完成），
`complete` 对它幂等。

四种 STATUS：

| STATUS | 含义 | DSH 应当怎么做 |
| --- | --- | --- |
| `REGISTERED` | 账本写入成功（`register` 登记，或 `complete` 关闭） | 这不是拒绝，按 notes 继续 |
| `READY_TO_EXECUTE` | 决策完成，等待执行 | 按 `SELECTED_SOLUTION` 执行；成功后调用 `complete` |
| `INSUFFICIENT_CONTEXT` | 信息不足，未做决策 | 补齐 `MISSING_INFORMATION` 后重新 `decide`；该项保持 `PENDING` |
| `NOT_APPLICABLE` | **守卫拒绝，属于非法调用** | 不重试、不执行，改走正常 DSH 流程 |

`complete` **只在状态为 `AWAITING_EXECUTION` 时被接受**，因此 `register` 之后直接 `complete`
会被拒绝（`ITEM_NOT_AWAITING_EXECUTION`）。也就是说"必须经过 decide"是**代码强制**的，
不是 Prompt 要求——这是这个插件与"只靠提示词约束"的区别所在。

`NOT_APPLICABLE` 的触发条件：编号在本会话从未 `register` 过、已 `RESOLVED` 且未被用新文本重新发布、
或 `complete` 时没有待执行的 MODIFY 裁决。

### 同一会话里编号可以跨轮复用

一个长会话里完成第一个任务后开始第二个任务时，DSH 很自然又会从 C1 开始编号，**用户仍然只看到 C1**：

- 用**新的确认内容** `register` 该编号 → 开启新一轮，回到 `PENDING`（内部轮次 +1，上一轮的裁决被清空）；
- 用**完全相同的内容**重复 `register` 已关闭的编号 → 被拒绝（不会复活已结束的项）；
- 新一轮必须重新 `decide`：**上一轮的裁决不会授权新一轮的 `complete`**。

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
npm run test:offline   # 54 个用例：纯决策算法 + 账本，任何机器都能跑，不需要 DSH
npm test               # 85 个用例：上面 + 端到端生命周期 + 驱动真实注册工具的状态机与守卫用例（需要 DSH）
npm run verify         # 21 项：真实 Cordis 上下文 + 真实 defineTool 的装配验证（需要 DSH）
npm run check          # 语法 + 全部测试 + 装配验证（需要 DSH）
```

`test/e2e-lifecycle.test.mjs` 是端到端叙事测试：走完一个会话的完整生命周期
（发布 → 登记 → 决策 → **执行失败可重试** → 执行成功关闭 → **新轮复用编号** → 非法调用被拒），
每一步都断言下一步所依赖的状态，因此流程一旦偏离文档化的状态机就会在偏离处失败。
它驱动真实注册的工具，所以与 `ledger-guard.test.mjs` 一样需要 DSH。

哪些测试不需要 DSH 是可以精确说明的：`lib/decide.js`、`lib/ledger.js`、`lib/rules.js` **不 import 任何外部包**，
所以只覆盖它们的用例可完全离线运行；任何 import 到 `lib/index.js` 的用例都会拉入宿主的
`@deepseek-ai/dsh-tools`，因而必须有 DSH 安装。

测试分两层是有原因的：`lib/decide.js`、`lib/rules.js`、`lib/ledger.js` **不 import 任何外部包**，
所以纯逻辑与账本单测可完全离线运行；而 `lib/index.js` 必须 import 宿主的 `@deepseek-ai/dsh-tools`
（它自己又依赖 `dsh-scope`/`dsh-llm`/`dsh-session` 等宿主内部模块），所以涉及装配的验证必须在
已安装 DSH 的环境里跑。`npm run verify` 用 `DSH_HOME` 与 `DSH_PROFILE` 定位 profile，没有硬编码路径；
找不到 DSH 时以退出码 2 明确报错，**不会把"没能执行"当成通过**。

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
  `AGENTS.md`、三份规范 `.docx`，以及 `node_modules` 中的直接依赖闭包 —— `@deepseek-ai/dsh-tools`、
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
这是依赖模型的预期结果，不是缺陷。副本里请用 `npm run test:offline`（应 54/54 通过）；
装进 profile 后再跑 `npm test`（应 85/85）与 `npm run verify`（应 21/21）。

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
               '01_DSH_System_Prompt_待确认事项触发规则.docx',
               '02_Confirmation_Resolution_Plugin_执行规则.docx',
               '03_DSH_待确认事项决策规范_维护与测试基准.docx') {
  Copy-Item (Join-Path $src $f) $pack -Force
}
# 副本内把 package.json 的 test 指向 test:offline（副本目录里宿主 peer 不可解析）
cd $pack; npm run test:offline
```

复验判据（缺一不可）：副本内 `lib/ledger.js` 存在、`lib/index.js` 含 `ledger.guard` 与
`action === 'complete'`、`lib/decide.js` 含 `USER_GOAL_REQUIRED_FOR_MODIFY`、
`npm run test:offline` 全绿。

</details>
