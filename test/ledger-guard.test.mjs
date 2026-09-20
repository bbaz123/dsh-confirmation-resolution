/**
 * The code-level trigger guard and the register → decide → complete state
 * machine, driven through the REAL registered tool (a real Cordis context plus
 * the real `defineTool`), using `exec.agent.id` exactly as the runtime supplies
 * it.
 *
 * The properties that matter here are the ones a prompt cannot guarantee:
 *   - an item this session never registered can never be decided;
 *   - a MODIFY decision does NOT close the item — only a successful execution
 *     reported through `complete` does, so a failed run stays retryable;
 *   - KEEP_CURRENT is self-completing;
 *   - every ledger write reports REGISTERED, and NOT_APPLICABLE means refusal.
 *
 * NOTE: this file needs the host's `@deepseek-ai/dsh-tools`, so it requires a DSH
 * installation. The pure ledger unit tests live in `ledger.test.mjs`.
 *
 * Run: `node --test test/`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'

const plugin = await import('../lib/index.js')

/** Drive the real registered tool: apply() on a Context, then execute() per item. */
function makeTool() {
  const ctx = new Context()
  const sections = []
  const tools = []
  ctx.provide('systemPrompt', {
    getSectionOrder: () => 116,
    section: (section) => {
      sections.push(section)
      return () => {}
    },
  })
  ctx.provide('tools', {
    register: (definition) => {
      tools.push(definition)
      return () => {}
    },
  })
  ctx.effect = (callback) => callback()
  plugin.apply(ctx, plugin.Config({}))
  return tools[0]
}

/**
 * One well-formed confirmation item whose decision is MODIFY.
 *
 * `user_reply` is deliberately NOT part of the base shape: it is conditionally
 * required (only `decide` needs it), and `register` runs before any reply exists.
 */
const item = (id, overrides = {}) => ({
  confirmation_id: id,
  current_state: `${id} 当前状态`,
  original_confirmation: `${id} 是否需要调整？`,
  user_goal: `${id} 让入口更容易被发现`,
  quality_impact: 'NONE',
  candidate_solutions: [{ label: 'promote', approach: `${id} 提高一个视觉层级`, scope: 'component' }],
  ...overrides,
})

/** A KEEP_CURRENT item: preference-only, so the matrix keeps the current state. */
const keepItem = (id, overrides = {}) => ({
  confirmation_id: id,
  current_state: `${id} 当前状态`,
  original_confirmation: `${id} 是否需要调整？`,
  user_reply: `${id} 保持`,
  preference_only: true,
  quality_impact: 'MEDIUM',
  user_impact_if_unchanged: 'NONE',
  ...overrides,
})

/** The `exec` the runtime hands a tool: the calling agent carries the SessionId. */
const execFor = (sessionId) => ({ agent: { id: sessionId } })

/** register → the item exists and is PENDING. */
const register = (tool, id, exec, overrides = {}) =>
  tool.execute({ ...item(id, overrides), action: 'register' }, exec)

/** decide → needs the user's reply, and leaves a MODIFY awaiting execution. */
const decideItem = (tool, id, exec, overrides = {}) =>
  tool.execute({ ...item(id, { user_reply: `${id} 修改`, ...overrides }), action: 'decide' }, exec)

/** complete → the explicit closure after a successful execution. */
const completeItem = (tool, id, exec, overrides = {}) =>
  tool.execute({ ...item(id, overrides), action: 'complete' }, exec)

// ── ① the resolve timing: MODIFY is not closed by the decision ──────────────

test('① register → decide(MODIFY) 后项目进入 AWAITING_EXECUTION，complete 才 RESOLVED', async () => {
  const tool = makeTool()
  const exec = execFor('timing-1')

  const registered = await register(tool, 'C1', exec)
  assert.equal(registered.status, 'REGISTERED')
  assert.equal(registered.confirmation_state, 'PENDING')

  const decision = await decideItem(tool, 'C1', exec)
  assert.equal(decision.status, 'READY_TO_EXECUTE')
  assert.equal(decision.action, 'MODIFY')
  assert.equal(decision.execution_required, true)
  // The decision is not the execution: the item now waits for a completion.
  assert.equal(decision.confirmation_state, 'AWAITING_EXECUTION')

  const completed = await completeItem(tool, 'C1', exec)
  assert.equal(completed.status, 'REGISTERED')
  assert.equal(completed.confirmation_state, 'RESOLVED')
  assert.equal(completed.execution_required, false)
})

test('① 执行失败（未 complete）时可以重新 decide，且状态停在 AWAITING_EXECUTION', async () => {
  const tool = makeTool()
  const exec = execFor('timing-2')
  await register(tool, 'C1', exec)
  const first = await decideItem(tool, 'C1', exec)
  assert.equal(first.status, 'READY_TO_EXECUTE')
  assert.equal(first.confirmation_state, 'AWAITING_EXECUTION')

  // The execution failed, so DSH never called complete. Deciding again must work
  // instead of being refused with ALREADY_RESOLVED.
  const second = await decideItem(tool, 'C1', exec)
  assert.equal(second.status, 'READY_TO_EXECUTE')
  assert.equal(second.action, 'MODIFY')
  assert.equal(second.confirmation_state, 'AWAITING_EXECUTION')

  const completed = await completeItem(tool, 'C1', exec)
  assert.equal(completed.confirmation_state, 'RESOLVED')
})

test('① 完成之后再次 decide 才被守卫拒绝（ALREADY_RESOLVED）', async () => {
  const tool = makeTool()
  const exec = execFor('timing-3')
  await register(tool, 'C1', exec)
  await decideItem(tool, 'C1', exec)
  await completeItem(tool, 'C1', exec)
  const again = await decideItem(tool, 'C1', exec)
  assert.equal(again.status, 'NOT_APPLICABLE')
  assert.match(again.selection_reason, /ITEM_ALREADY_RESOLVED/)
  assert.equal(again.execution_required, false)
})

test('① KEEP_CURRENT 自完成：decide 直接 RESOLVED，且 complete 幂等', async () => {
  const tool = makeTool()
  const exec = execFor('timing-4')
  const registered = await tool.execute({ ...keepItem('C2'), action: 'register' }, exec)
  assert.equal(registered.status, 'REGISTERED')

  const decision = await tool.execute({ ...keepItem('C2'), action: 'decide' }, exec)
  assert.equal(decision.action, 'KEEP_CURRENT')
  assert.equal(decision.status, 'READY_TO_EXECUTE')
  assert.equal(decision.confirmation_state, 'RESOLVED')
  assert.equal(decision.execution_required, false)

  const completed = await tool.execute({ ...keepItem('C2'), action: 'complete' }, exec)
  assert.equal(completed.status, 'REGISTERED')
  assert.equal(completed.confirmation_state, 'RESOLVED')
})

// ── ② no implicit registration: register first, or be refused ───────────────

test('② 未 register 就 decide（哪怕带全上下文）→ NOT_APPLICABLE，无自动补登记后门', async () => {
  const tool = makeTool()
  const refused = await decideItem(tool, 'C1', execFor('no-implicit-1'))
  assert.equal(refused.status, 'NOT_APPLICABLE')
  assert.match(refused.selection_reason, /UNKNOWN_CONFIRMATION_ITEM/)
  assert.equal(refused.execution_required, false)
})

test('② 空会话里带全上下文也无法绕过；register 之后才可 decide', async () => {
  const tool = makeTool()
  const exec = execFor('no-implicit-2')
  const refused = await decideItem(tool, 'C1', exec)
  assert.equal(refused.status, 'NOT_APPLICABLE')
  await register(tool, 'C1', exec)
  const decided = await decideItem(tool, 'C1', exec)
  assert.equal(decided.status, 'READY_TO_EXECUTE')
})

test('② 未登记的 complete 同样被拒绝', async () => {
  const tool = makeTool()
  const refused = await completeItem(tool, 'C9', execFor('no-implicit-3'))
  assert.equal(refused.status, 'NOT_APPLICABLE')
  assert.match(refused.selection_reason, /UNKNOWN_CONFIRMATION_ITEM/)
})

test('② 未知 action 在参数 schema 层就被拒绝（先于守卫的一道防线）', async () => {
  const tool = makeTool()
  const exec = execFor('no-implicit-4')
  await register(tool, 'C1', exec)
  // The action enum is enforced by the registry's argument validation, so an
  // unknown action can never reach the guard as a silent `decide`. The tool
  // still keeps its own UNKNOWN_ACTION branch for a caller that bypasses it.
  await assert.rejects(
    () => tool.execute({ ...item('C1'), action: 'frobnicate' }, exec),
    (error) => error.code === 'INVALID_ARGS' && String(error.message).includes('action'),
  )
})

// ── ③ REGISTERED vs NOT_APPLICABLE ─────────────────────────────────────────

test('③ register 返回 REGISTERED（成功写入），而不是 NOT_APPLICABLE', async () => {
  const tool = makeTool()
  const registered = await register(tool, 'C1', execFor('status-1'))
  assert.equal(registered.status, 'REGISTERED')
  assert.equal(registered.confirmation_state, 'PENDING')
  assert.match(registered.notes, /C1=PENDING/)
})

test('③ 重复 register 同一项仍然是 REGISTERED + PENDING（不是拒绝）', async () => {
  const tool = makeTool()
  const exec = execFor('status-2')
  await register(tool, 'C1', exec)
  const again = await register(tool, 'C1', exec)
  assert.equal(again.status, 'REGISTERED')
  assert.equal(again.confirmation_state, 'PENDING')
})

test('③ NOT_APPLICABLE 只表示守卫拒绝：已 RESOLVED 项再 register 是拒绝', async () => {
  const tool = makeTool()
  const exec = execFor('status-3')
  await register(tool, 'C1', exec)
  await decideItem(tool, 'C1', exec)
  await completeItem(tool, 'C1', exec)
  const refused = await register(tool, 'C1', exec)
  assert.equal(refused.status, 'NOT_APPLICABLE')
  assert.match(refused.selection_reason, /ITEM_ALREADY_RESOLVED/)
})

// ── ④ user_goal is required for MODIFY ─────────────────────────────────────

/** An item with the optional user_goal key genuinely absent (not set to undefined). */
function withoutGoal(id) {
  const value = { ...item(id), user_reply: `${id} 修改` }
  delete value.user_goal
  return value
}

test('④ MODIFY 缺少 user_goal → INSUFFICIENT_CONTEXT + USER_GOAL_REQUIRED_FOR_MODIFY', async () => {
  const tool = makeTool()
  const exec = execFor('goal-1')
  await register(tool, 'C1', exec)
  const value = await tool.execute({ ...withoutGoal('C1'), action: 'decide' }, exec)
  assert.equal(value.status, 'INSUFFICIENT_CONTEXT')
  assert.equal(value.confirmation_state, 'PENDING')
  assert.match(value.missing_information, /USER_GOAL_REQUIRED_FOR_MODIFY/)
  assert.equal(value.execution_required, false)
})

test('④ 补上 user_goal 后同一项可以正常决策', async () => {
  const tool = makeTool()
  const exec = execFor('goal-2')
  await register(tool, 'C1', exec)
  const refused = await tool.execute({ ...withoutGoal('C1'), action: 'decide' }, exec)
  assert.equal(refused.status, 'INSUFFICIENT_CONTEXT')
  const decided = await decideItem(tool, 'C1', exec)
  assert.equal(decided.status, 'READY_TO_EXECUTE')
  assert.equal(decided.user_goal, 'C1 让入口更容易被发现')
})

test('④ KEEP_CURRENT 不需要 user_goal', async () => {
  const tool = makeTool()
  const exec = execFor('goal-3')
  await tool.execute({ ...keepItem('C2'), action: 'register' }, exec)
  const value = await tool.execute({ ...keepItem('C2'), action: 'decide' }, exec)
  assert.equal(value.action, 'KEEP_CURRENT')
  assert.equal(value.status, 'READY_TO_EXECUTE')
  assert.equal(value.confirmation_state, 'RESOLVED')
})

// ── 守卫的其余边界 ──────────────────────────────────────────────────────────

test('守卫 — 会话隔离：每个会话的账本互不可见', async () => {
  const tool = makeTool()
  await register(tool, 'C1', execFor('iso-x'))
  const xDecided = await decideItem(tool, 'C1', execFor('iso-x'))
  assert.equal(xDecided.status, 'READY_TO_EXECUTE')

  // Session y holds nothing, so the same C1 is unknown there.
  const yRefused = await decideItem(tool, 'C1', execFor('iso-y'))
  assert.equal(yRefused.status, 'NOT_APPLICABLE')
  assert.match(yRefused.selection_reason, /UNKNOWN_CONFIRMATION_ITEM/)

  // ...and y can still open its own C1.
  await register(tool, 'C1', execFor('iso-y'))
  const yDecided = await decideItem(tool, 'C1', execFor('iso-y'))
  assert.equal(yDecided.status, 'READY_TO_EXECUTE')
})

test('守卫 — 缺少调用会话时不崩溃，按信息不足处理', async () => {
  const tool = makeTool()
  const value = await tool.execute(item('C1'), {})
  assert.equal(value.status, 'INSUFFICIENT_CONTEXT')
  assert.equal(value.execution_required, false)
  assert.match(value.notes, /Ledger guard failed/)
})

test('守卫 — 拒绝结果不包含任何可执行内容', async () => {
  const tool = makeTool()
  const refused = await decideItem(tool, 'C9', execFor('guard-safe'))
  assert.equal(refused.selected_solution, 'NONE')
  assert.equal(refused.execution_scope, 'NONE')
  assert.equal(refused.execution_required, false)
  assert.equal(refused.quality_impact, 'NONE')
})

test('守卫 — INSUFFICIENT_CONTEXT 不关闭确认项，补全上下文后仍可处理', async () => {
  const tool = makeTool()
  const exec = execFor('guard-insufficient')
  await register(tool, 'C1', exec)
  const first = await tool.execute({
    confirmation_id: 'C1',
    current_state: 'C1 当前状态',
    original_confirmation: 'C1 是否需要调整？',
    user_reply: 'C1 修改',
  }, exec)
  assert.equal(first.status, 'INSUFFICIENT_CONTEXT')
  assert.equal(first.confirmation_state, 'PENDING')
  const second = await decideItem(tool, 'C1', exec)
  assert.equal(second.status, 'READY_TO_EXECUTE')
})

// ── ⑤ complete 必须证明存在 READY/MODIFY 裁决（不能跳过 decide） ─────────────

test('⑤ register → 直接 complete 被拒绝：complete 必须证明之前有 MODIFY 裁决', async () => {
  const tool = makeTool()
  const exec = execFor('skip-1')
  const registered = await register(tool, 'C1', exec)
  assert.equal(registered.confirmation_state, 'PENDING')

  const skipped = await completeItem(tool, 'C1', exec)
  assert.equal(skipped.status, 'NOT_APPLICABLE')
  assert.match(skipped.selection_reason, /ITEM_NOT_AWAITING_EXECUTION/)
  assert.equal(skipped.confirmation_state, 'UNCHANGED')
  assert.equal(skipped.execution_required, false)

  // ...and the item is still open, so the correct path still works.
  const decided = await decideItem(tool, 'C1', exec)
  assert.equal(decided.confirmation_state, 'AWAITING_EXECUTION')
  const completed = await completeItem(tool, 'C1', exec)
  assert.equal(completed.confirmation_state, 'RESOLVED')
})

test('⑤ KEEP_CURRENT 裁决后 complete 幂等（没有可执行动作，也没有待授权项）', async () => {
  const tool = makeTool()
  const exec = execFor('skip-2')
  await tool.execute({ ...keepItem('C2'), action: 'register' }, exec)
  const decided = await tool.execute({ ...keepItem('C2'), action: 'decide' }, exec)
  assert.equal(decided.confirmation_state, 'RESOLVED')
  const completed = await tool.execute({ ...keepItem('C2'), action: 'complete' }, exec)
  assert.equal(completed.status, 'REGISTERED')
  assert.equal(completed.confirmation_state, 'RESOLVED')
})

// ── ⑥ 同一 session 内 C 编号跨轮复用 ───────────────────────────────────────

test('⑥ 已 RESOLVED 的 C1 用新文本 register → 开启第 2 轮并回到 PENDING', async () => {
  const tool = makeTool()
  const exec = execFor('round-1')
  await register(tool, 'C1', exec)
  await decideItem(tool, 'C1', exec)
  await completeItem(tool, 'C1', exec)

  // Same text: refuses to resurrect a closed item.
  const sameText = await register(tool, 'C1', exec)
  assert.equal(sameText.status, 'NOT_APPLICABLE')
  assert.match(sameText.selection_reason, /ITEM_ALREADY_RESOLVED/)

  // New text: a new round under the same visible number.
  const round2 = await register(tool, 'C1', exec, { original_confirmation: 'C1 第二轮：另一个问题？', current_state: '第二轮状态' })
  assert.equal(round2.status, 'REGISTERED')
  assert.equal(round2.confirmation_state, 'PENDING')
  assert.match(round2.notes, /round 2/)
})

test('⑥ 上一轮的 MODIFY 裁决不能授权新一轮的 complete（关键不变量）', async () => {
  const tool = makeTool()
  const exec = execFor('round-2')
  await register(tool, 'C1', exec)
  await decideItem(tool, 'C1', exec)          // round 1 has an outstanding MODIFY
  const round2 = await register(tool, 'C1', exec, { original_confirmation: 'C1 第二轮：换一个问题？' })
  assert.equal(round2.confirmation_state, 'PENDING')

  // The round-1 decision must NOT let round 2 be completed without its own decide.
  const skipped = await completeItem(tool, 'C1', exec)
  assert.equal(skipped.status, 'NOT_APPLICABLE')
  assert.match(skipped.selection_reason, /ITEM_NOT_AWAITING_EXECUTION/)

  const decided = await decideItem(tool, 'C1', exec)
  assert.equal(decided.confirmation_state, 'AWAITING_EXECUTION')
  const completed = await completeItem(tool, 'C1', exec)
  assert.equal(completed.confirmation_state, 'RESOLVED')
})

test('⑥ 两轮分别使用 C1/C2：第二轮重新从 C1 开始也能正常工作', async () => {
  const tool = makeTool()
  const exec = execFor('round-3')
  for (const id of ['C1', 'C2']) {
    await register(tool, id, exec)
    await decideItem(tool, id, exec)
    await completeItem(tool, id, exec)
  }
  // Round 2 under the same two numbers, with new text.
  for (const id of ['C1', 'C2']) {
    const again = await register(tool, id, exec, { original_confirmation: `${id} 第二轮问题？` })
    assert.equal(again.status, 'REGISTERED')
    assert.equal(again.confirmation_state, 'PENDING')
    await decideItem(tool, id, exec, { original_confirmation: `${id} 第二轮问题？` })
    const done = await completeItem(tool, id, exec, { original_confirmation: `${id} 第二轮问题？` })
    assert.equal(done.confirmation_state, 'RESOLVED')
  }
})

// ── ⑦ user_reply 按 action 条件必填 ────────────────────────────────────────

test('⑦ register 与 complete 不需要 user_reply，只有 decide 需要', async () => {
  const tool = makeTool()
  const exec = execFor('reply-1')

  const registered = await register(tool, 'C1', exec)   // no user_reply in play
  assert.equal(registered.status, 'REGISTERED')

  const noReply = await tool.execute({ ...item('C1'), action: 'decide' }, exec)
  assert.equal(noReply.status, 'INSUFFICIENT_CONTEXT')
  assert.match(noReply.missing_information, /REQUIRED_FOR_DECIDE/)
  // The refusal must name the real cause, not a ledger failure.
  assert.ok(!String(noReply.notes).includes('Ledger guard failed'))
  assert.equal(noReply.confirmation_state, 'PENDING')

  const decided = await decideItem(tool, 'C1', exec)
  assert.equal(decided.status, 'READY_TO_EXECUTE')
  const completed = await completeItem(tool, 'C1', exec)   // no user_reply needed
  assert.equal(completed.status, 'REGISTERED')
  assert.equal(completed.confirmation_state, 'RESOLVED')
})

test('⑦ decide 的 user_reply 为空字符串同样被拒绝（不是"传了就算"）', async () => {
  const tool = makeTool()
  const exec = execFor('reply-2')
  await register(tool, 'C1', exec)
  const refused = await tool.execute({ ...item('C1'), action: 'decide', user_reply: '   ' }, exec)
  assert.equal(refused.status, 'INSUFFICIENT_CONTEXT')
  assert.match(refused.missing_information, /REQUIRED_FOR_DECIDE/)
})

test('插件入口经真实解析路径可加载，且导出未变', () => {
  assert.ok(pathToFileURL(process.cwd()).href.length > 0)
  assert.equal(plugin.name, 'confirmation-resolution')
  assert.deepEqual(plugin.inject, ['tools', 'systemPrompt'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.ledgers, 'object')
})
