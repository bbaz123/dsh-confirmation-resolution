# 参与贡献

感谢你愿意改进 `dsh-confirmation-resolution`。本文件只讲"怎么改、怎么验"；
项目结构、职责边界与硬性约定在 [`AGENTS.md`](./AGENTS.md)，改代码前请先读它。

## 环境要求

| 用途 | 需要 |
| --- | --- |
| 改动纯逻辑（`decide.js` / `ledger.js` / `rules.js`） | 只需 Node.js ≥ 22.19.0，**不需要 DSH** |
| 跑端到端与守卫用例、装配验证 | 需要本机已安装 DSH |

## 三层测试（不要混淆）

```powershell
npm run test:offline  # 58 用例：纯决策算法 + 账本，任何机器都能跑（CI 跑这一层）
npm test              # 94 用例：全部，含端到端生命周期与真实工具守卫（需要 DSH）
npm run verify        # 23 项：真实 Cordis 上下文 + 真实 defineTool 的装配验证（需要 DSH）
npm run check         # 语法 + 全部测试 + 装配验证（需要 DSH）
```

分层依据是精确的：`lib/decide.js`、`lib/ledger.js`、`lib/rules.js` **不 import 任何外部包**，
所以只覆盖它们的用例可以完全离线运行；任何 import 到 `lib/index.js` 的用例都会拉入宿主的
`@deepseek-ai/dsh-tools`（它又依赖 `dsh-scope` / `dsh-llm` / `dsh-session` 等宿主内部模块），
因此必须在已安装 DSH 的环境里跑。

> 在**没有装进 profile 的独立副本目录**里跑 `npm test` 会因宿主 peer 无法解析而失败——
> 这是依赖模型的预期结果，不是缺陷。那种环境请用 `npm run test:offline`。

## 提交前必须做的事

1. **先改测试，再改实现。** 决策行为的改动要先让 `test/` 表达规范给出的预期结果。
2. **跑门禁并保留真实输出。** 有 DSH 就跑 `npm run check`；没有就跑 `npm run test:offline`，
   并在汇报里明确说明哪一层**没有**跑过。不要把"没验证"写成"已验证"。
3. **改了 `lib/`、`test/`、`verify/`、`tools/` 或根目录元数据后，同步分发副本并复验。**
   仓库根目录之外还有一份自包含分发副本，它**不会自动跟随更新**；
   同步与复验判据见 README 的「重新同步分发副本」一节。

## 不要做的事

这些是已明确记录的边界，破坏它们会被要求返工：

- **不要退回两态状态机。** `register → decide → complete` 是硬约束；
  `decide` 返回 `MODIFY` 时状态是 `AWAITING_EXECUTION`，只有执行成功后才能 `complete`。
- **不要引入隐式登记。** 未 `register` 的编号必须被拒绝。
- **不要让 `decide()` 变得不纯。** 状态与守卫放在 `index.js` / `ledger.js`。
- **不要在 `rules.js` 正文里写裸反引号或 `${`**——它是模板字符串，会截断源码。
- **不要改动对外契约字段名**（`confirmation_id` / `action` / `status` / `confirmation_state` 等），
  这属于破坏性变更，需要先讨论。

## 提交与 PR

- 提交信息用祈使句、说明"为什么"而不是只写"改了什么"。
- PR 模板会要求你粘贴验证输出；请贴**实际输出**，不要只写"已验证"。
- 一个 PR 只做一件事，便于评审与回滚。

## License

提交贡献即表示你同意以本仓库的 [Apache License 2.0](./LICENSE) 授权你的贡献。
