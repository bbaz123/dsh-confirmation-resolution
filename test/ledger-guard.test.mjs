/**
 * Session-ledger unit tests and the plugin's code-level trigger guard.
 *
 * The ledger is what turns 01's activation scope from a request into an
 * enforcement point, so it is tested both as a data structure and through the
 * REAL registered tool (with a real Cordis context and real `defineTool`), using
 * `exec.agent.id` exactly as the runtime supplies it.
 *
 * Run: `node --test test/`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'

import { ConfirmationLedger, ConfirmationLedgers, ITEM_STATE, REJECTION } from '../lib/ledger.js'

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

/** One well-formed confirmation item that loses no quality. */
const item = (id, overrides = {}) => ({
  confirmation_id: id,
  current_state: `${id} 当前状态`,
  original_confirmation: `${id} 是否需要调整？`,
  user_reply: `${id} 修改`,
  quality_impact: 'NONE',
  candidate_solutions: [{ label: 'promote', approach: `${id} 提高一个视觉层级`, scope: 'component' }],
  ...overrides,
})

/** The `exec` the runtime hands a tool: the calling agent carries the SessionId. */
const execFor = (sessionId) => ({ agent: { id: sessionId } })

// ── ledger as a data structure ──────────────────────────────────────────────

test('ledger — 登记后为 PENDING，resolve 后为 RESOLVED', () => {
  const ledger = new ConfirmationLedger()
  assert.equal(ledger.register('C1', { originalConfirmation: 'x' }), ITEM_STATE.PENDING)
  assert.equal(ledger.get('C1').state, ITEM_STATE.PENDING)
  assert.equal(ledger.resolve('C1'), ITEM_STATE.RESOLVED)
  assert.equal(ledger.get('C1').state, ITEM_STATE.RESOLVED)
  assert.deepEqual(ledger.snapshot(), [{ id: 'C1', state: 'RESOLVED' }])
})

test('ledger — 重复登记同一编号的相同文本不会复活已解决项', () => {
  const ledger = new ConfirmationLedger()
  ledger.register('C1', { originalConfirmation: '原文本' })
  ledger.resolve('C1')
  assert.equal(ledger.register('C1', { originalConfirmation: '原文本' }), ITEM_STATE.RESOLVED)
  assert.equal(ledger.get('C1').state, ITEM_STATE.RESOLVED)
})

test('ledger — 同一编号以新文本重新发布时回到 PENDING', () => {
  const ledger = new ConfirmationLedger()
  ledger.register('C1', { originalConfirmation: '旧文本' })
  ledger.resolve('C1')
  assert.equal(ledger.register('C1', { originalConfirmation: '新文本' }), ITEM_STATE.PENDING)
})

test('ledger — 未发布过 / 已解决 / 空编号三种拒绝原因可区分', () => {
  const ledger = new ConfirmationLedger()
  assert.equal(ledger.guard('C9').code, REJECTION.UNKNOWN_ITEM)
  assert.equal(ledger.guard('').code, REJECTION.EMPTY_ID)
  ledger.register('C1', { originalConfirmation: 'x' })
  assert.equal(ledger.guard('C1').ok, true)
  ledger.resolve('C1')
  assert.equal(ledger.guard('C1').code, REJECTION.ALREADY_RESOLVED)
})

test('ledger — 编号按数字顺序快照（C2 在 C10 之前）', () => {
  const ledger = new ConfirmationLedger()
  for (const id of ['C10', 'C2', 'C1']) ledger.register(id, { originalConfirmation: id })
  assert.deepEqual(ledger.snapshot().map((entry) => entry.id), ['C1', 'C2', 'C10'])
})

test('ledger — 会话之间完全隔离，clear 清空全部', () => {
  const ledgers = new ConfirmationLedgers()
  ledgers.for('ledger-a').register('C1', { originalConfirmation: 'a' })
  assert.equal(ledgers.for('ledger-a').get('C1') !== undefined, true)
  assert.equal(ledgers.for('ledger-b').get('C1'), undefined)
  assert.equal(ledgers.sessionCount, 2)
  ledgers.clear()
  assert.equal(ledgers.sessionCount, 0)
  // A cleared store simply starts a fresh, empty ledger for the same session.
  assert.equal(ledgers.for('ledger-a').get('C1'), undefined)
  assert.equal(ledgers.for('ledger-a').size(), 0)
})

// ── the guard, through the real registered tool ─────────────────────────────

test('守卫 1 — register 只登记，不做决策', async () => {
  const tool = makeTool()
  const registered = await tool.execute({ ...item('C1'), action: 'register' }, execFor('guard-1'))
  assert.equal(registered.status, 'NOT_APPLICABLE')
  assert.equal(registered.confirmation_state, 'PENDING')
  assert.equal(registered.execution_required, false)
  assert.match(registered.notes, /C1=PENDING/)
})

test('守卫 2 — 已登记的 PENDING 项正常决策并转为 RESOLVED', async () => {
  const tool = makeTool()
  const exec = execFor('guard-2')
  await tool.execute({ ...item('C1'), action: 'register' }, exec)
  const decision = await tool.execute(item('C1'), exec)
  assert.equal(decision.status, 'READY_TO_EXECUTE')
  assert.equal(decision.action, 'MODIFY')
  assert.equal(decision.confirmation_state, 'RESOLVED')
  assert.equal(decision.execution_required, true)
})

test('守卫 3 — 已 RESOLVED 的项再次调用被拒绝（代码级，不依赖 Prompt）', async () => {
  const tool = makeTool()
  const exec = execFor('guard-3')
  await tool.execute(item('C1'), exec)               // first round: implicit register + decide
  const first = await tool.execute(item('C1'), exec)
  assert.equal(first.status, 'NOT_APPLICABLE')       // already RESOLVED
  assert.equal(first.confirmation_state, 'UNCHANGED')
  assert.match(first.selection_reason, /ITEM_ALREADY_RESOLVED/)
  assert.equal(first.execution_required, false)
  assert.match(first.notes, /normal DSH rules/)
})

test('守卫 4 — 会话已有编号时，引用其它不存在的编号被守卫拒绝', async () => {
  const tool = makeTool()
  const exec = execFor('guard-4')
  // Open the session with the item that really was published...
  await tool.execute({ ...item('C1'), action: 'register' }, exec)
  // ...then call for a number the user never saw. Implicit registration cannot
  // rescue it, because the session already holds an item.
  const refused = await tool.execute({
    confirmation_id: 'C7',
    action: 'resolve',
    current_state: 'C7 当前状态',
    original_confirmation: 'C7 是否需要调整？',
    user_reply: 'C7 修改',
    quality_impact: 'NONE',
    candidate_solutions: [{ label: 'x', approach: 'y', scope: 'component' }],
  }, exec)
  assert.equal(refused.status, 'NOT_APPLICABLE')
  assert.equal(refused.execution_required, false)
  assert.match(refused.selection_reason, /UNKNOWN_CONFIRMATION_ITEM/)
})

test('守卫 5 — 首次处理（未显式 register）但带全上下文时隐式登记并决策', async () => {
  const tool = makeTool()
  const decision = await tool.execute(item('C1'), execFor('guard-5'))
  assert.equal(decision.status, 'READY_TO_EXECUTE')
  assert.equal(decision.confirmation_state, 'RESOLVED')
})

test('守卫 6 — INSUFFICIENT_CONTEXT 不关闭确认项，补全上下文后仍可处理', async () => {
  const tool = makeTool()
  const exec = execFor('guard-6')
  await tool.execute({ ...item('C1'), action: 'register' }, exec)
  // Required identity fields present, but the evidence a decision needs is absent.
  const first = await tool.execute({
    confirmation_id: 'C1',
    current_state: 'C1 当前状态',
    original_confirmation: 'C1 是否需要调整？',
    user_reply: 'C1 修改',
  }, exec)
  assert.equal(first.status, 'INSUFFICIENT_CONTEXT')
  assert.equal(first.confirmation_state, 'PENDING')
  const second = await tool.execute(item('C1'), exec)
  assert.equal(second.status, 'READY_TO_EXECUTE')
  assert.equal(second.confirmation_state, 'RESOLVED')
})

test('守卫 7 — 会话隔离：每个会话的账本互不可见', async () => {
  const tool = makeTool()
  // Session x opens C1 and keeps it under a repeated identical publish.
  await tool.execute({ ...item('C1'), action: 'register' }, execFor('guard-7-x'))
  const sessionX = await tool.execute(item('C1'), execFor('guard-7-x'))
  assert.equal(sessionX.status, 'READY_TO_EXECUTE')
  const sessionXRepeat = await tool.execute(item('C1'), execFor('guard-7-x'))
  assert.equal(sessionXRepeat.status, 'NOT_APPLICABLE')
  assert.match(sessionXRepeat.selection_reason, /ITEM_ALREADY_RESOLVED/)

  // Session y never published anything: it holds no item of its own, so the very
  // same C1 resolves to a different, correct answer there.
  const sessionY = await tool.execute(item('C1'), execFor('guard-7-y'))
  assert.equal(sessionY.status, 'READY_TO_EXECUTE')
  assert.equal(sessionY.confirmation_state, 'RESOLVED')
  const sessionYRepeat = await tool.execute(item('C1'), execFor('guard-7-y'))
  assert.equal(sessionYRepeat.status, 'NOT_APPLICABLE')
})

test('守卫 8 — 缺少调用会话时不崩溃，按信息不足处理', async () => {
  const tool = makeTool()
  const value = await tool.execute(item('C1'), {})
  assert.equal(value.status, 'INSUFFICIENT_CONTEXT')
  assert.equal(value.execution_required, false)
  assert.match(value.notes, /Ledger guard failed/)
})

test('守卫 9 — 拒绝结果不包含任何可执行内容', async () => {
  const tool = makeTool()
  const refused = await tool.execute({
    confirmation_id: 'C9',
    action: 'resolve',
    current_state: 'C9 当前状态',
    original_confirmation: 'C9 是否需要调整？',
    user_reply: 'C9 修改',
  }, execFor('guard-9'))
  assert.equal(refused.selected_solution, 'NONE')
  assert.equal(refused.execution_scope, 'NONE')
  assert.equal(refused.execution_required, false)
  assert.equal(refused.quality_impact, 'NONE')
})

test('守卫 11 — 会话已有编号后，新编号必须显式 register，不能靠隐式登记绕过', async () => {
  const tool = makeTool()
  const exec = execFor('guard-11')
  await tool.execute(item('C1'), exec)   // session now owns C1
  const invented = await tool.execute(item('C9'), exec)
  assert.equal(invented.status, 'NOT_APPLICABLE')
  assert.match(invented.selection_reason, /UNKNOWN_CONFIRMATION_ITEM/)
})

test('守卫 12 — 显式 register 之后，同一会话的新编号可以被处理', async () => {
  const tool = makeTool()
  const exec = execFor('guard-12')
  await tool.execute(item('C1'), exec)
  await tool.execute({ ...item('C2'), action: 'register' }, exec)
  const second = await tool.execute(item('C2'), exec)
  assert.equal(second.status, 'READY_TO_EXECUTE')
  assert.equal(second.confirmation_id, 'C2')
})

test('守卫 10 — 插件入口经真实解析路径可加载，且导出未变', () => {
  assert.ok(pathToFileURL(process.cwd()).href.length > 0)
  assert.equal(plugin.name, 'confirmation-resolution')
  assert.deepEqual(plugin.inject, ['tools', 'systemPrompt'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.ledgers, 'object')
})
