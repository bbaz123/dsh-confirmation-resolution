# dsh-plugin-confirmation-resolution

DSH 待确认事项决策机制 —— `confirmation_resolution`（中文名：**待确认事项决策**）。

一个**宿主平面（host-plane）**的 Cordis 插件，只做两件事：

1. 向全局 `systemPrompt` 注册一个段落 `confirmation:policy`，承载
   `01_DSH_System_Prompt_待确认事项触发规则` 的**运行时规则**：何时汇报待确认事项、
   何时允许调用插件、何时禁止调用、确认项状态管理、混合消息拆分、插件结果如何执行、何时退出流程。
2. 向宿主 `tools` 注册模型工具 `confirmation_resolution`，其决策核心在 `lib/decide.js`，
   实现 `02_Confirmation_Resolution_Plugin_执行规则`。

插件**不修改**页面、代码、文件、设计稿或项目结构：它只判断、决策并返回执行方案，
实际执行由 DSH 完成。它也不发布任何服务，因此不需要 isolate realm。

三份输入文件与产物的分工（三份 `.docx` 规范源文件随仓库提供，位于仓库根目录）：

| 输入文件 | 负责 | 落地位置 |
| --- | --- | --- |
| `01_DSH_System_Prompt_待确认事项触发规则` | 触发与执行层 | `lib/rules.js` → 全局 System Prompt 段落 |
| `02_Confirmation_Resolution_Plugin_执行规则` | 插件内部决策层 | `lib/decide.js` + `lib/index.js` 工具定义 |
| `03_DSH_待确认事项决策规范` | 规范、校验与测试层 | `test/`（**不注入** System Prompt，也不进入插件运行时） |

## 目录结构

```
dsh-confirmation-resolution/
├── 01_DSH_System_Prompt_待确认事项触发规则.docx    # 规范源文件（01）
├── 02_Confirmation_Resolution_Plugin_执行规则.docx # 规范源文件（02）
├── 03_DSH_待确认事项决策规范_维护与测试基准.docx   # 规范源文件（03）
├── package.json             # dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml         # 宿主行：id confirmation-resolution，order 116
├── lib/
│   ├── index.js             # Cordis 入口：注册段落 + 注册工具 + 代码级守卫
│   ├── rules.js             # 01 的运行时规则文本（唯一事实来源）
│   ├── decide.js            # 02 的固定决策算法（纯函数，可单测）
│   └── ledger.js            # 会话级确认项账本（守卫的数据来源，纯状态容器）
├── test/
│   ├── decide.test.mjs              # 算法、输出结构、边界
│   ├── ledger-guard.test.mjs        # 账本 + 代码级守卫（驱动真实注册工具）
│   └── mandatory-scenarios.test.mjs # 任务要求的 10 个强制场景
├── verify/
│   └── wiring.mjs           # 用真实 Cordis + 真实 defineTool 验证装配
└── node_modules/@deepseek-ai/   # 指向 DSH 的 dsh-tools / schemastery / cordis 链接
```

## 两层触发保护

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 软保护 | `rules.js` 段落 + 工具描述 | 告诉模型何时该调用、何时不该调用 |
| **硬保护** | `index.js` 的 `execute()` + `ledger.js` | 真正拒绝非法调用，不依赖模型遵守 Prompt |

`execute()` 是**账本状态的唯一写入者**，三个动作把同一个确认项推进完整状态机：

```
register → 登记编号            → STATUS = REGISTERED，状态 PENDING
decide   → 账本校验 → decide()  → MODIFY：READY_TO_EXECUTE，状态仍为 PENDING
                                  KEEP_CURRENT：决策即完成 → RESOLVED
complete → DSH 实际执行成功后   → STATUS = REGISTERED，状态 RESOLVED
```

**MODIFY 决策不等于执行**：`decide` 返回后该项仍是 `PENDING`，只有执行成功并调用 `complete` 才变成
`RESOLVED`。执行失败时**不要**调用 `complete`，该项保持 `PENDING`，可以再次 `decide`——
不会出现"执行失败却已被关闭、重试反被判 `ALREADY_RESOLVED`"的情况。`KEEP_CURRENT` 是自完成的
（不修改本身在决策那一刻就已完成），插件在 `decide` 里直接标为 `RESOLVED`，`complete` 对它幂等。

拒绝条件（返回 `STATUS = NOT_APPLICABLE`、`execution_required = false`、不执行任何修改）：

- 该编号在本会话从未被 `register` 过；
- 该编号已 `RESOLVED`，且未被用新文本重新发布。

**没有任何隐式登记**：未先 `register` 的编号一律被拒，不存在"自带原文即可自动补登记"的后门。

四种 STATUS 语义互不混用：`REGISTERED`＝账本写入成功（含 `complete`），`READY_TO_EXECUTE`＝决策完成待执行，
`INSUFFICIENT_CONTEXT`＝信息不足（保持 PENDING），`NOT_APPLICABLE`＝守卫拒绝（非法调用，不得重试）。

账本以 `exec.agent.id`（会话 ID）为键，会话之间互不可见；宿主行卸载时清空（fiber 作用域 effect）。

**已知限制：账本不持久化。** DSH 重启后账本为空，需要重新 `register`；重启同时也会结束该对话，
因此守卫仍然成立，但不要把它当作跨重启的持久状态使用。

## 职责边界：插件是"评审器"，不是"生成器"

`decide.js` 是确定性的纯函数，不做自然语言推断。调用方（DSH）必须在调用前完成四件事：

1. 识别 `user_goal`；
2. 判断 `quality_impact`（或给出 `quality_dimensions` 证据）；
3. `quality_impact !== NONE` 时判断 `user_impact_if_unchanged`（或给出 `user_impact_dimensions` / `preference_only`）；
4. 对可能落到 `ACTION = MODIFY` 的确认项生成 2–3 个 `candidate_solutions`。

第 4 项缺失时插件返回 `INSUFFICIENT_CONTEXT`（`02 §13`：不得把用户原方案当默认方案），
**不会自行创造方案**——这正是纯函数可稳定测试的原因。

## 决策算法（固定，不可绕过）

```
QUALITY_IMPACT
  ├─ NONE                → ACTION = MODIFY（选最优方案）
  └─ != NONE
       ├─ USER_IMPACT_IF_UNCHANGED == NONE → ACTION = KEEP_CURRENT
       └─ 否则                              → ACTION = MODIFY（选质量损失最小的替代方案）
```

关键约束：

- 用户提出的具体做法只是**候选方案之一**（`USER_PROPOSED_SOLUTION` ≠ 自动最优）。它必须通过同一组硬性淘汰条件
  （不解决真实问题、无必要地扩大范围、超出许可范围、违反约束、引入更严重副作用、质量损失超过可避免上限、幅度过大）。
- 候选方案按 `02 §8` 的优先级排序：解决真实问题 → 使用体验 → 质量损失更小 → 副作用更少 → 系统一致性 → 稳定性 → 实现复杂度。
- 只有「关键信息缺失 **且** 无法可靠判断 **且** 不同选择导致实质不同结果」时才返回 `INSUFFICIENT_CONTEXT`；
  此时**不得**把用户原始方案当作默认方案执行。

## 安装与生效

```powershell
# 把本地包链接进 profile 并加入 dsh.profile.bundles
dsh plugin --profile <profile> add <本仓库路径>
# 例：dsh plugin --profile web add C:\Users\<你>\Desktop\dsh-confirmation-resolution
```

行由 bundle 补丁 `cordis.patch.yml` 插入宿主组合，因此**需要重启 DSH Web 进程**才会加载
（bundle 层在启动时组合；`dsh.profile.bundles` 变化不会热加载）。

## 验证

```powershell
npm test        # 69 个用例，含 10 个强制场景与守卫用例（需要 DSH）
npm run verify  # 真实 Cordis 上下文 + 真实 defineTool 的装配验证（需要已安装 DSH）
npm run check   # 语法 + 测试 + 装配（需要 DSH）
```

测试分两层，**不要混淆**：

| 命令 | 覆盖 | 是否需要 DSH |
| --- | --- | --- |
| `npm run test:offline` | 50 个用例：`decide.test.mjs`、`ledger.test.mjs`、`mandatory-scenarios.test.mjs` | **不需要**，任何机器都能跑 |
| `npm test` | 69 个用例：上面三个 + `ledger-guard.test.mjs`（含状态机与守卫用例） | 需要（该文件驱动**真实注册的工具**，会 import `@deepseek-ai/dsh-tools`） |
| `npm run verify` | 真实 Cordis 上下文 + 真实 `defineTool` 的装配验证 | 需要 |

`lib/decide.js`、`lib/rules.js`、`lib/ledger.js` 不 import 任何外部包，因此纯逻辑与账本单测可以完全离线运行。
`lib/index.js` 必须 import 宿主的 `@deepseek-ai/dsh-tools`（它自己又依赖 `dsh-scope`/`dsh-llm`/`dsh-session` 等
**宿主内部模块**），所以**任何 import 到 `lib/index.js` 的验证都必须在已安装 DSH 的环境里跑**。

`npm run verify` 用 `DSH_HOME`（默认 `~/.dsh`）与 `DSH_PROFILE`（默认 `web`）定位 profile 的
`node_modules`，没有硬编码的机器路径；找不到 DSH 时以退出码 2 明确报错，**不会把"没能执行"当成通过**。

另外两项组合层验证：

```powershell
dsh --profile web --dump-config              # 行出现在组合树中，退出码 0
dsh --profile <临时 profile> --dump-config   # 只装配 tools/system-prompt + 本行，退出码 0 即代表条目已激活
```

`dsh` 启动时会执行 `assertEntriesActivated`：任何一条行无法解析或无法激活都会让整个 profile 启动失败，
因此 `--dump-config` 退出码 0 等价于「该行已成功解析并激活」。

## 打包分发（自包含副本）

除本仓库外，另有一份与仓库内容一致的**自包含分发副本**（同名目录及同名 `.zip`），用于离线备份或搬到另一台机器：

> **同步要求（重要）**：分发副本不会自动跟随仓库更新。以前出现过"仓库已修好、分发副本仍是旧版，
> 于是按副本评审时看到的是旧代码"的事故。凡是改动 `lib/`、`test/`、`verify/`、`tools/`
> 或根目录元数据，都必须重新同步副本并复验，步骤见本节末尾。

- **随包携带**：`lib/`、`test/`、`verify/`、`tools/`、`cordis.patch.yml`、`package.json`、`README.md`、`AGENTS.md`、
  三份规范 `.docx` 源文件，以及 `node_modules` 中的直接依赖闭包 —— `@deepseek-ai/dsh-tools`、
  `@deepseek-ai/schemastery`、`@deepseek-ai/cordis` 及三者的运行期依赖（`@deepseek-ai/cosmokit`、
  `@deepseek-ai/dsh-brand`、`@deepseek-ai/dsh-util-values`、`@standard-schema/spec`，共 7 个包）。
  依赖是**真实目录副本**而非目录链接，因此移动或解压后仍然可用。
- **不随包携带**：目标 DSH 自身提供的 peer 包（`dsh-agent`、`dsh-llm`、`dsh-scope`、`dsh-session`、
  `dsh-invariants`、`dsh-system-prompt`、`cordis-plugin-loader` 等）。这是刻意的：这些是**宿主内部模块**，
  自带副本会造成模块身份冲突。目标机器上必须已安装 DSH。
- 依赖闭包由 `tools/materialize-deps.mjs` 生成，可重复执行：

```powershell
node tools/materialize-deps.mjs <bundleDir> "$env:USERPROFILE\.dsh\profiles\node_modules"
```

在目标机器上安装（DSH 已安装的前提下）：

```powershell
dsh plugin --profile <profile> add <解压目录>
# 例：dsh plugin --profile web add C:\Users\<你>\Desktop\dsh-confirmation-resolution
# 然后重启 DSH 使宿主组合重新加载
```

验证安装：

1. **离线自检**（不需 DSH，任何位置都能跑）：`npm run test:offline` → **50/50 通过**。
2. **装进 profile 后**（此时宿主 peer 可解析）：`npm test` → **69/69** 通过、`npm run verify` → **16/16** 通过。
   注意：在**未安装到 profile 的独立副本目录**里跑 `npm test` 会因 `@deepseek-ai/dsh-scope` 等
   宿主 peer 无法解析而失败，这是依赖模型的预期结果，不是缺陷——那些 peer 按设计不随包携带。
3. `dsh --profile <profile> --dump-config` 退出码为 0 且输出包含 `id: confirmation-resolution`
   （退出码 0 即代表该行已解析并激活，因为 DSH 的启动审计会让任何未激活的行导致整个 profile 启动失败）。

兼容性：依赖闭包版本与打包时的 DSH 一致（`dsh-tools`/`dsh-brand`/`dsh-util-values` 为 `0.1.5-rc.2`，
`cordis` 为 `4.0.2`，`schemastery` 为 `3.18.2`）。目标机器 DSH 版本差异较大时，用上面的
`materialize-deps.mjs` 按目标机器重新生成依赖闭包。

### 重新同步分发副本（改完仓库必做）

```powershell
$src  = 'C:\Users\a1941\Desktop\DeepSeek\dsh-confirmation-resolution'   # 仓库
$pack = 'C:\Users\a1941\Desktop\dsh-confirmation-resolution'            # 分发副本
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
# 副本内把 test 指向离线子集（副本目录里宿主 peer 不可解析）
# 然后复验：
cd $pack; npm run test:offline
```

复验判据（缺一不可）：副本内 `grep ledger.guard lib/index.js` 有命中、`lib/ledger.js` 存在、
`grep addressRootCause lib/decide.js` **无**命中、`npm run test:offline` 全绿。

## 卸载

```powershell
dsh plugin --profile web remove dsh-plugin-confirmation-resolution
```

行随 bundle 层一起消失，System Prompt 段落与工具同时下线（两者都是 fiber 作用域的可逆 effect）。
