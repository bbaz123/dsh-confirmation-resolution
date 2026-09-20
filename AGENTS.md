# Project Instructions — dsh-confirmation-resolution

本文件是本项目的**项目级指令**，只描述"这个项目怎么工作"。
Agent 的通用行为规则在 `~/.dsh/AGENTS.md`；工作区级说明在上级 `../AGENTS.md`。两者叠加生效，项目级规则补充细节。

## 项目目标

实现 DSH 的「待确认事项决策机制」`confirmation_resolution`，把三份规范文件落成可运行的
System Prompt 规则 + 宿主平面 Cordis 插件：

- `01_DSH_System_Prompt_待确认事项触发规则` → 触发与执行层（`lib/rules.js`）
- `02_Confirmation_Resolution_Plugin_执行规则` → 插件决策层（`lib/decide.js`）
- `03_DSH_待确认事项决策规范` → 规范、校验与测试层（`test/`，**不得注入运行时**）

插件只判断、决策、返回执行方案；**不得**直接修改页面、代码、文件、设计稿或项目结构。

## 技术栈

- Node.js ≥ 22.19.0（本机 v24.19.0），纯 ESM，零构建步骤（没有编译、没有打包）。
- Cordis 4（`@deepseek-ai/cordis`）插件模型；宿主服务 `tools`、`systemPrompt`。
- `node --test` 作为测试框架。

## 项目结构约定

| 路径 | 约定 |
| --- | --- |
| `lib/rules.js` | 01 规则文本的**唯一事实来源**；测试直接 import 它，不得在测试里复制一份文本 |
| `lib/decide.js` | 只放**纯函数**：无 I/O、无服务访问、无定时器，保证可单测 |
| `lib/ledger.js` | 会话级确认项账本：纯状态容器，无 I/O；守卫的数据来源，按 `exec.agent.id` 隔离 |
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
- 测试分三层，**不要混淆**（数字以 `Select-String -Pattern '^test\('` 实测为准）：
  `npm run test:offline`（56 用例：纯逻辑 + 账本，不需要 DSH）、
  `npm test`（88 用例：全部，需要 DSH）、`npm run verify`（22 项装配检查，需要 DSH）。
  凡 import 到 `lib/index.js` 的用例都会拉入宿主 `@deepseek-ai/dsh-tools`，因此**不能**放进离线子集
  （`e2e-lifecycle.test.mjs` 与 `ledger-guard.test.mjs` 都属于这一类；曾误把 e2e 当离线用例，
  在分发副本里实测失败才发现）。
  **不要**在未安装到 profile 的独立副本目录里期待 `npm test` 全绿。

## 构建 / 测试 / 检查命令

```powershell
npm run test:offline  # 56 个用例：纯决策算法 + 账本，任何环境（不需要 DSH）
npm test              # 88 个用例：全部（含端到端生命周期与真实工具守卫用例，需要 DSH）
npm run verify        # 22 项：真实 Cordis 上下文的装配验证（需要 DSH）
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

## 验证要求

- 任何决策逻辑改动后必须运行 `npm run check`，并在汇报中给出实际输出。
- 改动宿主行、包名、依赖链接后，必须额外运行一次 `dsh --profile web --dump-config` 并确认退出码为 0。
- 未能执行的验证必须在汇报中明确标注为"未验证"。
