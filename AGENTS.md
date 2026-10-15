# Project Instructions — dsh-confirmation-resolution

本文件是本项目的**项目级指令**，只描述"这个项目怎么工作"。
Agent 的通用行为规则在 `~/.dsh/AGENTS.md`；工作区级说明在上级 `../AGENTS.md`。两者叠加生效，项目级规则补充细节。

## 项目目标

实现 DSH 的「待确认事项决策机制」，把规范文件落成可运行的 System Prompt 规则 + 宿主平面 Cordis 插件：

- `01_DSH_System_Prompt_待确认事项触发规则` → 触发与执行层（`lib/rules.js`）
- `02_Confirmation_Resolution_Plugin_执行规则` → 插件决策层（V1：`lib/decide.js`；V2：`lib/decision-v2.js`）
- `03_DSH_待确认事项决策规范` → 规范、校验与测试层（`test/`，**不得注入运行时**）

插件只判断、决策、返回执行方案；**不得**直接修改页面、代码、文件、设计稿或项目结构。

### V1 与 V2 两套并存契约

V1（`confirmation_resolution`）是既有的、以质量为主轴的固定矩阵，**契约冻结**。
V2（`confirmation_resolution_v2`）是 2026-10-15 方案落地的综合评判引擎，**默认关闭**，
需要 `enableDecisionV2: true` 才注册；它带来四个新模块：

| 路径 | 约定 |
| --- | --- |
| `lib/evidence.js` | 三值证据模型：`PASS` / `FAIL` / `UNKNOWN`，保守合并、冲突诊断、缺口 |
| `lib/policies.js` | 场景策略数据 + 纯比较函数：维度、优先级、审批阈值、幅度规则、帕累托 |
| `lib/trace.js` | 结构化决策轨迹（只返回数据，不写日志、不复述原文） |
| `lib/decision-v2.js` | 纯决策核心 `decideV2()`：构造基线 → 硬门禁 → 证据可信性 → 多维比较 → 审批 → 结果 |

**V1 与 V2 的契约不得互相污染**：不得修改 V1 的 `action` / `status` 枚举、不得把 V2 的
`outcome` 塞进 V1 的返回值、不得让两者共用同一条规则段落。V2 有独立的 prompt 段落
（`confirmation:policy.v2`）和独立的工具。

## 技术栈

- Node.js ≥ 22.19.0（本机 v24.19.0），纯 ESM，零构建步骤（没有编译、没有打包）。
- Cordis 4（`@deepseek-ai/cordis`）插件模型；宿主服务 `tools`、`systemPrompt`。
- `node --test` 作为测试框架。

## 项目结构约定

| 路径 | 约定 |
| --- | --- |
| `lib/rules.js` | 01 规则文本的**唯一事实来源**（`RULES` = V1、`RULES_V2` = V2）；测试直接 import 它，不得复制文本 |
| `lib/decide.js` | V1 决策核心，只放**纯函数**：无 I/O、无服务访问、无定时器，保证可单测 |
| `lib/evidence.js` / `lib/policies.js` / `lib/trace.js` / `lib/decision-v2.js` | V2 纯函数层，同上，**不得** import 宿主包或写模板字符串 |
| `lib/ledger.js` | 会话级确认项账本：纯状态容器，无 I/O；守卫的数据来源，按 `exec.agent.id` 隔离；含 V2 版本化决策令牌 |
| `lib/index.js` | 只做 Cordis 装配与守卫：注册段落 + 注册工具 + execute 前置校验，不放决策算法 |
| `cordis.patch.yml` | 宿主行定义；`id`、`name` 必须与 `package.json` 的 `name` 保持一致 |
| `test/` | 断言规范给出的**预期结果**，不允许写"描述性"测试 |
| `verify/` | 用真实 Cordis 与真实 `defineTool` 验证装配，不使用 mock 掉的注册表 |
| `node_modules/@deepseek-ai/` | 指向 DSH 安装内同名包的目录链接，供本地 `node` 直接解析依赖 |

## 修改原则

- 改决策行为前先改 `test/`：先让测试表达 02/03 的预期，再改实现。
- 01、02、03 三层职责不得互相污染：不要在 `rules.js` 里重复 02 的完整判断算法，
  也不要把 03 的规范文本注入 System Prompt。
- 输出字段名（`confirmation_id`、`action`、`status` …）属于对外契约，改动视为破坏性变更。
- 扩大插件作用域（例如让它处理普通任务、普通修改）属于破坏 03 §4 的边界，禁止。
- **状态机是三态的，不得退回两态**：`register → decide → complete` 是硬约束。
  `decide` 返回 MODIFY 时状态为 **`AWAITING_EXECUTION`**（等待执行），只有 DSH 执行成功后调用
  `complete`（或 KEEP_CURRENT 自完成）才写 `RESOLVED`；执行失败留在 `AWAITING_EXECUTION` 可重试。
  若退回"决策即关闭"，执行失败会把项目永久关死；若允许 `register → complete` 直连，
  就等于把"必须经过 decide"降级成 Prompt 要求——**`complete` 必须只在 `AWAITING_EXECUTION` 时被接受**。
- **不得引入隐式登记**：未 `register` 的编号必须被拒绝；任何"自带原文即自动补登记"的后门都会削弱守卫。
- **C 编号跨轮复用**：只有**真正结束（RESOLVED）**的编号才能被复用，而且必须带**新文本**：
  新文本 → 开启新一轮（清空上一轮裁决，轮次 +1）；同文本 → 拒绝（`ITEM_ALREADY_RESOLVED`）。
  **正在使用中的编号（`PENDING` / `AWAITING_EXECUTION`）一律拒绝重新 register**
  （`CONFIRMATION_ID_STILL_OPEN`），否则会覆盖活跃项及其未完成的裁决。
  `ledger.register()` 自身也对该情况抛错，作为绕过 `index.js` 时的第二层防御。
  新一轮必须重新 `decide`，上一轮裁决不得授权新一轮的 `complete`。
- **每一次新的 `decide` 必须先废除上一份尚未执行的授权**：`execute()` 在调用 `decide()` **之前**
  执行 `ledger.beginDecision(itemId)`，把 AWAITING_EXECUTION 退回 PENDING 并清空 `decisionAction`。
  否则"重试决策但结果是 INSUFFICIENT_CONTEXT"会让旧 MODIFY 授权存活、`complete` 仍能关闭该项——
  即"最新判断是信息不足，旧授权却仍可执行"。只有 READY 结果才重新建立授权。
- 四种 STATUS 语义不得混用：`REGISTERED`（账本写入成功）/ `READY_TO_EXECUTE`（待执行）/
  `INSUFFICIENT_CONTEXT`（保持 PENDING）/ `NOT_APPLICABLE`（守卫拒绝）。
- **`user_reply` 是按 action 条件必填**（schema 无法表达，故在 `execute()` 里按 action 校验）：
  `register` 不需要（此时用户还没回复）、`decide` 必须有、`complete` 不需要。
- **`lib/rules.js` 是模板字符串**：正文里出现裸反引号或 `${` 会截断源码（已踩两次）。
  `mandatory-scenarios.test.mjs` 有机械检查兜底，但改动时请直接避开。
- **`verify/wiring.mjs` 的 `check()` 是 async 的**：每个调用都必须 `await`，否则断言失败会变成
  未处理的 rejection 而被静默忽略——"不会失败的检查器比没有检查器更糟"。
- **`ACTION = MODIFY` 必须有 `user_goal`**，缺失时返回 `INSUFFICIENT_CONTEXT` +
  `USER_GOAL_REQUIRED_FOR_MODIFY`；`KEEP_CURRENT` 不要求（它不选方案）。
- 触发保护必须保持两层：`rules.js` + 工具描述（软）+ `execute()` 的账本守卫（硬）。
  `decide()` 必须保持纯函数，状态与守卫放在 `index.js`/`ledger.js`。
- 账本按会话隔离，且**不持久化**（DSH 重启即空）。改成持久化属于契约变更，需先确认。
- 测试涉及账本时必须用**每用例唯一的会话 ID**：`ledgers` 是模块级共享状态，
  复用会话号会让用例互相污染（已实测踩过）。
- **存在第二份"分发副本"`C:\Users\a1941\Desktop\dsh-confirmation-resolution`（非仓库）。**
  它不是本仓库的一部分，**不会自动跟随更新**。改动 `lib/`、`test/`、`verify/`、`tools/`
  或根目录元数据后，必须按 README「重新同步分发副本」一节同步并复验。
  曾因漏做这一步，导致按副本评审时看到的仍是旧代码（旧 `execute`、旧 `addressRootCause`、
  无 `ledger.js`），并因此产生了一整轮无效返工。
- 测试分三层，**不要混淆**（数字以 `node --test --experimental-test-isolation=none` 实测为准）：
  `npm run test:offline`（130 用例：V1/V2 纯逻辑 + 证据 + 策略 + 账本，不需要 DSH）、
  `npm test`（187 用例：全部，需要 DSH）、`npm run verify`（32 项装配检查，需要 DSH）。
  凡 import 到 `lib/index.js` 的用例都会拉入宿主 `@deepseek-ai/dsh-tools`，因此**不能**放进离线子集
  （`e2e-lifecycle.test.mjs`、`ledger-guard.test.mjs`、`v2-tool.test.mjs` 都属于这一类；
  曾误把 e2e 当离线用例，在分发副本里实测失败才发现）。
  **不要**在未安装到 profile 的独立副本目录里期待 `npm test` 全绿。
- 本机沙箱会拦截 npm 的子进程管道：`npm run test:offline` 报 `spawn EPERM` 属**沙箱限制**
  （每条用例文件各报一次），不是用例失败。等价跑法：
  `node --test --experimental-test-isolation=none test/*.test.mjs`（PowerShell 里逐文件列出）。

### V2 专属硬约束

- **V1 与 V2 不得互相驱动**：同一个 `C` 编号的归属版本记录在账本里，跨版本调用必须返回
  `ITEM_VERSION_MISMATCH`。改 `guard()` / `guardComplete()` 时必须保留 `options.version` 检查。
- **`UNKNOWN` 不得被折成 `PASS` 或某个等级**：`lib/evidence.js` 的
  `worstGate` 从 `PASS` 起降级、`worstLevel` 只取**已知**最大值；`normalizeCandidate` 里
  缺失证据一律 `UNKNOWN`。V2 只允许对 `KEEP_CURRENT` 候选使用「不变量式」默认
  （不变即无损、无风险、无成本、必然可逆），那是定义而非乐观推断。
- **每一轮 `decide` 必须先递增 `decision_revision` 并清空旧审批与旧执行许可**（`ledger.beginDecisionV2`），
  且 `complete` 必须带对该版本（`guardComplete(id, { version: '2', revision })`）。
  缺 `decision_revision` 一律拒绝（`MISSING_DECISION_REVISION`），不得当成"任意版本"。
- **不得实现自动审批跃迁**：`AWAITING_APPROVAL → AWAITING_EXECUTION` 只能经由一次**新的 decide**
  （用户答复已进入输入）。`approve` 动作在当前宿主一律返回
  `NOT_APPLICABLE`（`NO_VERIFIABLE_APPROVAL_SOURCE`）；模型自填的 `approved: true` 永远不采信。
  只有 `authorization.source = 'USER_REPLY'` 且 `user_decision = 'APPROVED'` 才被当作
  调用方申明的用户同意，并在轨迹里标记为 attested（不是 verified）。
- **V2 规则段落是第二个模板字符串**：`RULES_V2` 同样不得出现裸反引号或 `${`，
  由 `mandatory-scenarios.test.mjs` 机械断言。
- **不得扩大 V2 触发范围**：`RULES_V2` 必须与 V1 完全相同的触发条件；V2 也不能被注册成
  默认工具——`enableDecisionV2` 默认 `false`，默认 profile 里只有 V1。

## 构建 / 测试 / 检查命令

```powershell
npm run test:offline  # 130 个用例：V1/V2 纯决策算法 + 证据 + 策略 + 账本（不需要 DSH）
npm test              # 187 个用例：全部（含端到端生命周期与真实工具守卫用例，需要 DSH）
npm run verify        # 32 项：真实 Cordis 上下文的装配验证，含 V2 双版本共存（需要 DSH）
npm run check         # 语法检查 + 全部测试 + 装配验证（需要 DSH）
```

本项目没有编译、打包、lint、type check 步骤；`npm run check` 即是完整门禁。
语法层面等价的单文件检查：`node --check lib/*.js`。

组合层验证（需要 DSH 安装，耗时约数秒）：

```powershell
dsh --profile web --dump-config   # 退出码 0 且包含 id: confirmation-resolution
```

`npm run verify` 同样需要 DSH：它按 `DSH_HOME`（默认 `~/.dsh`）与 `DSH_PROFILE`（默认 `web`）
定位 profile 的 `node_modules`，没有硬编码的机器路径；找不到 DSH 时退出码为 2，不得当作通过。

## 需要谨慎修改的区域

- `cordis.patch.yml` 中的 `name`：写错会让该行无法解析。DSH 启动时的 `assertEntriesActivated`
  会因此**让整个 profile 启动失败**（不是静默跳过）。
- `lib/index.js` 的 `inject`：只声明真正需要的宿主服务（`tools`、`systemPrompt`）。
- `confirmation:policy` 段落名与 `order`：段落名被预设（preset）同名注册时会遮蔽全局段落，属预期行为；
  改 `order` 会改变规则在 System Prompt 中的位置。
- V2 段落名（默认 `confirmation:policy.v2`）与 V1 段落名不得相同，否则 preset 遮蔽规则会把两条
  规则合成一条；V2 段落只在 `enableDecisionV2: true` 时注册。
- `lib/index.js` 的 V2 输出 schema：`dsh-tools` 只接受受支持的 JSON Schema 子集，
  可空字段必须写成 `oneOf: [{type:'string'},{type:'null'}]`，自由 JSON 必须写成 `{type:'json'}`
  （空对象 `{}` 会被 `defineTool` 拒绝，代码 `UNSUPPORTED_SCHEMA`）。
- V2 参数 schema 里 `schema_version` 带 `enum: ['2.0']`：写错版本会在 `execute()` 之前被
  注册表拒绝（`INVALID_ARGS`），这是预期的第一道门，不要为了"更友好"去掉枚举。

## 验证要求

- 任何决策逻辑改动后必须运行 `npm run check`，并在汇报中给出实际输出。
- 改动宿主行、包名、依赖链接后，必须额外运行一次 `dsh --profile web --dump-config` 并确认退出码为 0。
- 改动 `lib/`、`test/`、`verify/`、`tools/` 或根目录元数据后，必须按 README
  「重新同步分发副本」一节同步第二份副本并复验（V2 之后判据含四个新模块与
  `confirmation_resolution_v2`）。
- 未能执行的验证必须在汇报中明确标注为"未验证"。
- 验证结果要**分层报告**：离线用例数、宿主用例数、装配检查数分别列出，并写明实际使用的命令；
  缺失 DSH 时 `verify` 的退出码 2 是"未能验证"，不得写成通过。
