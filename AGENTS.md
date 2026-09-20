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
| `lib/index.js` | 只做 Cordis 装配：注册段落 + 注册工具，不放业务判断 |
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

## 构建 / 测试 / 检查命令

```powershell
npm test        # node --test "test/*.test.mjs"（36 个用例，含 10 个强制场景；不需要 DSH）
npm run verify  # node verify/wiring.mjs（真实 Cordis 上下文的装配验证）
npm run check   # 语法检查 + 测试 + 装配验证
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
