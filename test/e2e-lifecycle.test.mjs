/**
 * End-to-end walkthrough of one session's confirmation lifecycle.
 *
 * This drives the REAL registered tool (real Cordis context, real `defineTool`,
 * real `exec.agent.id`) and follows a session the way DSH actually would:
 *
 *   round 1  publish C1 (MODIFY) + C2 (KEEP_CURRENT) → register
 *   round 1  user replies                            → decide
 *   round 1  C1 execution FAILS                      → no complete, retryable
 *   round 1  C1 execution SUCCEEDS                   → complete → RESOLVED
 *   round 2  the session reuses C1/C2 for a new task  → new round
 *   guard    illegal calls are refused at every step
 *
 * Unlike the unit suites, nothing here is asserted in isolation: every step
 * checks the state the next step depends on, so the test fails at the first
 * place the lifecycle diverges from the documented state machine.
 *
 * NOTE: needs the host's `@deepseek-ai/dsh-tools` (a DSH installation).
 *
 * Run: `node --test test/`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'

const plugin = await import('../lib/index.js')

/** A fresh tool over a fresh Cordis context, as one DSH session would build it. */
function makeSession(sessionId) {
  const ctx = new Context()
  const tools = []
  ctx.provide('systemPrompt', { getSectionOrder: () => 116, section: () => () => {} })
  ctx.provide('tools', { register: (definition) => { tools.push(definition); return () => {} } })
  ctx.effect = (callback) => callback()
  plugin.apply(ctx, plugin.Config({}))
  const tool = tools[0]
  const exec = { agent: { id: sessionId } }
  /**
   * Registering happens right after DSH publishes the item, when the user has not
   * replied yet: `user_reply` is absent from the payload (deleted, not set to
   * undefined — args must stay a lossless JSON object).
   */
  const withoutReply = (args) => {
    const payload = { ...args }
    delete payload.user_reply
    return payload
  }
  return {
    register: (args) => tool.execute({ ...withoutReply(args), action: 'register' }, exec),
    decide: (args) => tool.execute({ ...args, action: 'decide' }, exec),
    complete: (args) => tool.execute({ ...withoutReply(args), action: 'complete' }, exec),
  }
}

/** C1: a real change is required, so it will need an execution + complete. */
const c1 = (original) => ({
  confirmation_id: 'C1',
  current_state: '首页主按钮为次级尺寸',
  original_confirmation: original,
  user_reply: 'C1 修改',
  user_goal: '提高关键操作的可发现性',
  quality_impact: 'NONE',
  candidate_solutions: [{ label: 'promote', approach: '把主按钮提高一个视觉层级', scope: 'component' }],
})

/** C2: a preference-only change, so the matrix keeps the current state. */
const c2 = (original) => ({
  confirmation_id: 'C2',
  current_state: '卡片使用系统默认圆角',
  original_confirmation: original,
  user_reply: 'C2 保持',
  preference_only: true,
  quality_impact: 'MEDIUM',
  user_impact_if_unchanged: 'NONE',
})

test('e2e — 完整生命周期：登记 → 决策 → 执行失败可重试 → 执行成功关闭 → 新轮复用编号', async () => {
  const session = makeSession('e2e-full-lifecycle')
  const task1C1 = '主按钮是否需要更突出？'
  const task1C2 = '卡片视觉是否需要调整？'

  // ── 发布后立刻登记（此时用户还没回复，所以不带 user_reply） ──────────────
  const regC1 = await session.register({ ...c1(task1C1) })
  assert.equal(regC1.status, 'REGISTERED')
  assert.equal(regC1.confirmation_state, 'PENDING')
  const regC2 = await session.register({ ...c2(task1C2) })
  assert.equal(regC2.status, 'REGISTERED')

  // ── 守卫：登记后不能直接 complete（必须经过 decide） ─────────────────────
  const skip = await session.complete({ ...c1(task1C1) })
  assert.equal(skip.status, 'NOT_APPLICABLE')
  assert.match(skip.selection_reason, /ITEM_NOT_AWAITING_EXECUTION/)

  // ── 守卫：编号仍在使用时不得被下一次 register 覆盖 ───────────────────────
  const whilePending = await session.register({ ...c1(task1C1) })
  assert.equal(whilePending.status, 'NOT_APPLICABLE')
  assert.match(whilePending.selection_reason, /CONFIRMATION_ID_STILL_OPEN/)

  // ── 用户回复，逐项决策 ───────────────────────────────────────────────────
  const decisionC1 = await session.decide(c1(task1C1))
  assert.equal(decisionC1.action, 'MODIFY')
  assert.equal(decisionC1.status, 'READY_TO_EXECUTE')
  assert.equal(decisionC1.confirmation_state, 'AWAITING_EXECUTION')
  assert.equal(decisionC1.execution_required, true)
  assert.match(decisionC1.selected_solution, /主按钮/)

  // ── 守卫：等待执行期间同样不能被覆盖，新文本也不行 ───────────────────────
  const whileAwaiting = await session.register({ ...c1('趁执行期间换个新文本？') })
  assert.equal(whileAwaiting.status, 'NOT_APPLICABLE')
  assert.match(whileAwaiting.selection_reason, /CONFIRMATION_ID_STILL_OPEN/)

  const decisionC2 = await session.decide(c2(task1C2))
  assert.equal(decisionC2.action, 'KEEP_CURRENT')
  assert.equal(decisionC2.confirmation_state, 'RESOLVED')   // self-completing
  assert.equal(decisionC2.execution_required, false)

  // ── C1 的执行第一次失败：不调用 complete，保持可重试 ─────────────────────
  const afterFailure = await session.decide(c1(task1C1))     // DSH retries the decision
  assert.equal(afterFailure.status, 'READY_TO_EXECUTE')
  assert.equal(afterFailure.confirmation_state, 'AWAITING_EXECUTION')

  // ── 执行成功 → complete → RESOLVED ───────────────────────────────────────
  const doneC1 = await session.complete(c1(task1C1))
  assert.equal(doneC1.status, 'REGISTERED')
  assert.equal(doneC1.confirmation_state, 'RESOLVED')

  // ── 守卫：已关闭的项再次 decide 被拒 ─────────────────────────────────────
  const closed = await session.decide(c1(task1C1))
  assert.equal(closed.status, 'NOT_APPLICABLE')
  assert.match(closed.selection_reason, /ITEM_ALREADY_RESOLVED/)

  // ── 第二个任务开始，DSH 很自然又从 C1 编号 ───────────────────────────────
  const task2C1 = '设置页的保存按钮是否需要更明显？'
  const sameText = await session.register({ ...c1(task1C1) })
  assert.equal(sameText.status, 'NOT_APPLICABLE')            // identical text: no resurrection
  assert.match(sameText.selection_reason, /ITEM_ALREADY_RESOLVED/)

  const round2 = await session.register({ ...c1(task2C1) })
  assert.equal(round2.status, 'REGISTERED')
  assert.equal(round2.confirmation_state, 'PENDING')
  assert.match(round2.notes, /round 2/)

  // ── 关键不变量：上一轮的裁决不能授权新一轮的完成 ─────────────────────────
  const skipRound2 = await session.complete(c1(task2C1))
  assert.equal(skipRound2.status, 'NOT_APPLICABLE')
  assert.match(skipRound2.selection_reason, /ITEM_NOT_AWAITING_EXECUTION/)

  // ── 新一轮走完整流程 ─────────────────────────────────────────────────────
  const round2Decision = await session.decide(c1(task2C1))
  assert.equal(round2Decision.confirmation_state, 'AWAITING_EXECUTION')
  const round2Done = await session.complete(c1(task2C1))
  assert.equal(round2Done.confirmation_state, 'RESOLVED')
})

test('e2e — 混合消息：C1 走插件，紧接着的新需求不进入确认流程', async () => {
  const session = makeSession('e2e-mixed-message')
  await session.register({ ...c1('C1 原文？') })
  const decision = await session.decide(c1('C1 原文？'))
  assert.equal(decision.confirmation_id, 'C1')
  // The unrelated new requirement never reaches the tool: it is not part of the
  // item's payload, and the decision only speaks about C1.
  assert.ok(!JSON.stringify(decision).includes('搜索框'))
})

test('e2e — 误触发：普通任务期间调用插件会被代码挡住（不依赖 Prompt）', async () => {
  const session = makeSession('e2e-mis-trigger')
  // A perfectly well-formed call for a number this session never published.
  const refused = await session.decide(c1('这个编号从未发布过？'))
  assert.equal(refused.status, 'NOT_APPLICABLE')
  assert.match(refused.selection_reason, /UNKNOWN_CONFIRMATION_ITEM/)
  assert.equal(refused.execution_required, false)
  assert.equal(refused.selected_solution, 'NONE')
})

test('e2e — 信息不足不关闭项目：补齐后同一项仍可处理', async () => {
  const session = makeSession('e2e-insufficient')
  await session.register({ ...c1('C1 原文？') })

  const noGoal = { ...c1('C1 原文？') }
  delete noGoal.user_goal
  const insufficient = await session.decide(noGoal)
  assert.equal(insufficient.status, 'INSUFFICIENT_CONTEXT')
  assert.match(insufficient.missing_information, /USER_GOAL_REQUIRED_FOR_MODIFY/)
  assert.equal(insufficient.confirmation_state, 'PENDING')

  const completed = await session.decide(c1('C1 原文？'))
  assert.equal(completed.status, 'READY_TO_EXECUTE')
  assert.equal(completed.confirmation_state, 'AWAITING_EXECUTION')
})

test('e2e — 会话隔离：两个会话各自持有同名编号，互不影响', async () => {
  const a = makeSession('e2e-session-a')
  const b = makeSession('e2e-session-b')
  await a.register({ ...c1('会话 A 的 C1？') })
  const aDecision = await a.decide(c1('会话 A 的 C1？'))
  assert.equal(aDecision.status, 'READY_TO_EXECUTE')

  // Session B holds nothing yet, so the same C1 is unknown there.
  const bRefused = await b.decide(c1('会话 A 的 C1？'))
  assert.equal(bRefused.status, 'NOT_APPLICABLE')

  // ...and B can open its own C1 afterwards.
  await b.register({ ...c1('会话 B 的 C1？') })
  const bDecision = await b.decide(c1('会话 B 的 C1？'))
  assert.equal(bDecision.status, 'READY_TO_EXECUTE')
  assert.equal(bDecision.confirmation_state, 'AWAITING_EXECUTION')
})
