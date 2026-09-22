## 改动内容

<!-- 一句话说明这次改动解决了什么问题，以及为什么这样做 -->

## 对应的问题

<!-- 关联 issue，例如 Closes #12；没有就写 N/A -->

## 验证

请粘贴**实际输出**，不要只写"已验证"。

- [ ] `npm run test:offline`（58 用例，无需 DSH）
- [ ] `npm run check`（94 用例 + 23 项装配检查，需要 DSH）
- [ ] 若改动 `lib/`、`test/`、`verify/`、`tools/` 或根目录元数据：已同步分发副本并复验

```text
<!-- 在此粘贴输出 -->
```

## 契约影响

- [ ] 未改动对外字段名（`confirmation_id` / `action` / `status` / `confirmation_state` / …）
- [ ] 未改动状态机语义（`register → decide → complete` 三态，`MODIFY` 后必须 `complete` 才 `RESOLVED`）
- [ ] 未引入隐式登记（未 `register` 的编号仍被拒绝）
- [ ] 决策核心 `lib/decide.js` 仍为纯函数（无 I/O、无服务访问、无定时器）
