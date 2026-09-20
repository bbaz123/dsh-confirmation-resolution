/**
 * Session-ledger unit tests — pure state, no DSH installation required.
 *
 * `lib/ledger.js` imports nothing, so this file runs anywhere, including inside
 * the offline distribution copy. The guard behaviour that drives the REAL
 * registered tool lives in `ledger-guard.test.mjs`, which needs the host's
 * `@deepseek-ai/dsh-tools` and therefore only runs where DSH is installed.
 *
 * Run: `node --test test/`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ConfirmationLedger, ConfirmationLedgers, ITEM_STATE, REJECTION } from '../lib/ledger.js'

test('ledger — 登记后为 PENDING，裁决 MODIFY 后进入 AWAITING_EXECUTION，resolve 后为 RESOLVED', () => {
  const ledger = new ConfirmationLedger()
  assert.equal(ledger.register('C1', { originalConfirmation: 'x' }), ITEM_STATE.PENDING)
  assert.equal(ledger.get('C1').state, ITEM_STATE.PENDING)
  assert.equal(ledger.markDecided('C1', 'MODIFY'), ITEM_STATE.AWAITING_EXECUTION)
  assert.equal(ledger.get('C1').state, ITEM_STATE.AWAITING_EXECUTION)
  assert.equal(ledger.resolve('C1'), ITEM_STATE.RESOLVED)
  assert.equal(ledger.get('C1').state, ITEM_STATE.RESOLVED)
  assert.deepEqual(ledger.snapshot(), [{ id: 'C1', state: 'RESOLVED', round: 1 }])
})

test('ledger — KEEP_CURRENT 裁决不进入 AWAITING_EXECUTION（没有可执行的动作）', () => {
  const ledger = new ConfirmationLedger()
  ledger.register('C1', { originalConfirmation: 'x' })
  assert.equal(ledger.markDecided('C1', 'KEEP_CURRENT'), ITEM_STATE.PENDING)
  assert.equal(ledger.decisionOf('C1').action, 'KEEP_CURRENT')
})

test('ledger — guardComplete 只放行 AWAITING_EXECUTION（这就是"不能跳过 decide"）', () => {
  const ledger = new ConfirmationLedger()
  ledger.register('C1', { originalConfirmation: 'x' })
  // Freshly registered: nothing executable behind it yet.
  assert.equal(ledger.guardComplete('C1').ok, false)
  assert.equal(ledger.guardComplete('C1').code, REJECTION.NOT_AWAITING_EXECUTION)
  ledger.markDecided('C1', 'MODIFY')
  assert.equal(ledger.guardComplete('C1').ok, true)
  ledger.resolve('C1')
  assert.equal(ledger.guardComplete('C1').ok, false)
  // Unknown id and empty id stay distinguishable.
  assert.equal(ledger.guardComplete('C9').code, REJECTION.UNKNOWN_ITEM)
  assert.equal(ledger.guardComplete('').code, REJECTION.EMPTY_ID)
})

test('ledger — 重复登记同一编号的相同文本不会复活已解决项', () => {
  const ledger = new ConfirmationLedger()
  ledger.register('C1', { originalConfirmation: '原文本' })
  ledger.resolve('C1')
  assert.equal(ledger.register('C1', { originalConfirmation: '原文本' }), ITEM_STATE.RESOLVED)
  assert.equal(ledger.get('C1').state, ITEM_STATE.RESOLVED)
})

test('ledger — 同一编号以新文本重新发布时开启新轮：回到 PENDING 且轮次 +1', () => {
  const ledger = new ConfirmationLedger()
  ledger.register('C1', { originalConfirmation: '旧文本' })
  ledger.markDecided('C1', 'MODIFY')
  ledger.resolve('C1')
  assert.equal(ledger.register('C1', { originalConfirmation: '新文本' }), ITEM_STATE.PENDING)
  assert.equal(ledger.decisionOf('C1').round, 2)
  assert.equal(ledger.decisionOf('C1').action, undefined)
  // The previous round's decision must not authorise this round's completion.
  assert.equal(ledger.guardComplete('C1').ok, false)
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

test('ledger — 同一编号重新发布新文本后，旧文本的记录被替换', () => {
  const ledger = new ConfirmationLedger()
  ledger.register('C1', { originalConfirmation: '旧', currentState: '旧状态', userGoal: '旧目标' })
  ledger.register('C1', { originalConfirmation: '新', currentState: '新状态', userGoal: '新目标' })
  const item = ledger.get('C1')
  assert.equal(item.originalConfirmation, '新')
  assert.equal(item.currentState, '新状态')
  assert.equal(item.userGoal, '新目标')
  assert.equal(item.state, ITEM_STATE.PENDING)
})

test('ledger — 未登记的编号不能直接 resolve（内部一致性）', () => {
  const ledger = new ConfirmationLedger()
  assert.throws(() => ledger.resolve('C7'), /unknown confirmation item C7/)
})

test('ledger — 快照是纯数据（只含 id/state/round），不含任何实时对象', () => {
  const ledger = new ConfirmationLedger()
  ledger.register('C1', { originalConfirmation: 'x' })
  const snapshot = ledger.snapshot()
  assert.equal(JSON.stringify(snapshot), '[{"id":"C1","state":"PENDING","round":1}]')
  assert.deepEqual(Object.keys(snapshot[0]), ['id', 'state', 'round'])
})
