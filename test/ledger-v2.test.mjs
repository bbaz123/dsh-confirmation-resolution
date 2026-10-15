/**
 * Tests for the V2 half of the session ledger (方案 §6).
 *
 * These cover the two properties the plan calls out as security rules: a stale
 * decision revision can never complete a newer decision, and the V1 and V2
 * contracts can never drive each other's items.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ConfirmationLedger, ITEM_STATE, ITEM_VERSION, REJECTION } from '../lib/ledger.js'

function ledgerWithV2Item(id = 'C1') {
  const ledger = new ConfirmationLedger()
  ledger.register(id, { originalConfirmation: '问题', currentState: '现状', version: ITEM_VERSION.V2 })
  return ledger
}

test('a V2 item records its version and starts at revision 0', () => {
  const ledger = ledgerWithV2Item()
  const item = ledger.get('C1')
  assert.equal(item.state, ITEM_STATE.PENDING)
  assert.equal(item.version, ITEM_VERSION.V2)
  assert.equal(item.decisionRevision, 0)
  assert.equal(ledger.versionOf('C1'), ITEM_VERSION.V2)
})

test('a V1 registration stays on version 1', () => {
  const ledger = new ConfirmationLedger()
  ledger.register('C1', { originalConfirmation: 'q', currentState: 's' })
  assert.equal(ledger.versionOf('C1'), ITEM_VERSION.V1)
})

test('beginDecisionV2 bumps the revision and clears every outstanding permission', () => {
  const ledger = ledgerWithV2Item()
  const first = ledger.beginDecisionV2('C1')
  assert.equal(first.revision, 1)
  ledger.markDecidedV2('C1', 'MODIFY')
  assert.equal(ledger.get('C1').state, ITEM_STATE.AWAITING_EXECUTION)
  assert.equal(ledger.get('C1').authorizedRevision, 1)

  const second = ledger.beginDecisionV2('C1')
  assert.equal(second.revision, 2)
  assert.equal(ledger.get('C1').state, ITEM_STATE.PENDING)
  assert.equal(ledger.get('C1').authorizedRevision, undefined)
})

test('MODIFY opens exactly one executable authorisation at the current revision', () => {
  const ledger = ledgerWithV2Item()
  ledger.beginDecisionV2('C1')
  ledger.markDecidedV2('C1', 'MODIFY')
  assert.equal(ledger.guardComplete('C1', { version: ITEM_VERSION.V2, revision: 1 }).ok, true)
})

test('T11 — a stale revision cannot complete a newer decision', () => {
  const ledger = ledgerWithV2Item()
  ledger.beginDecisionV2('C1')
  ledger.markDecidedV2('C1', 'MODIFY')
  assert.equal(ledger.guardComplete('C1', { version: ITEM_VERSION.V2, revision: 1 }).ok, true)

  ledger.beginDecisionV2('C1')
  ledger.markDecidedV2('C1', 'MODIFY')
  const stale = ledger.guardComplete('C1', { version: ITEM_VERSION.V2, revision: 1 })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, REJECTION.STALE_DECISION_REVISION)
  assert.equal(ledger.guardComplete('C1', { version: ITEM_VERSION.V2, revision: 2 }).ok, true)
})

test('an INSUFFICIENT_CONTEXT re-decide revokes the previous authorisation entirely', () => {
  const ledger = ledgerWithV2Item()
  ledger.beginDecisionV2('C1')
  ledger.markDecidedV2('C1', 'MODIFY')
  ledger.beginDecisionV2('C1')
  ledger.markDecidedV2('C1', 'INSUFFICIENT_CONTEXT')
  assert.equal(ledger.get('C1').state, ITEM_STATE.PENDING)
  const attempt = ledger.guardComplete('C1', { version: ITEM_VERSION.V2, revision: 1 })
  assert.equal(attempt.ok, false)
  assert.equal(attempt.code, REJECTION.NOT_AWAITING_EXECUTION)
  const current = ledger.guardComplete('C1', { version: ITEM_VERSION.V2, revision: 2 })
  assert.equal(current.ok, false)
  assert.equal(current.code, REJECTION.NOT_AWAITING_EXECUTION)
})

test('REQUEST_APPROVAL parks the item with no permission at all', () => {
  const ledger = ledgerWithV2Item()
  ledger.beginDecisionV2('C1')
  ledger.markDecidedV2('C1', 'REQUEST_APPROVAL')
  assert.equal(ledger.get('C1').state, ITEM_STATE.AWAITING_APPROVAL)
  assert.equal(ledger.get('C1').authorizedRevision, undefined)
  const refused = ledger.guardComplete('C1', { version: ITEM_VERSION.V2, revision: 1 })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, REJECTION.AWAITING_APPROVAL)
})

test('KEEP_CURRENT closes the item itself and REJECT returns it to PENDING', () => {
  const kept = ledgerWithV2Item()
  kept.beginDecisionV2('C1')
  kept.markDecidedV2('C1', 'KEEP_CURRENT')
  assert.equal(kept.get('C1').state, ITEM_STATE.RESOLVED)

  const rejected = ledgerWithV2Item()
  rejected.beginDecisionV2('C1')
  rejected.markDecidedV2('C1', 'REJECT')
  assert.equal(rejected.get('C1').state, ITEM_STATE.PENDING)
  assert.equal(rejected.get('C1').authorizedRevision, undefined)
  assert.equal(rejected.guardComplete('C1', { version: ITEM_VERSION.V2, revision: 1 }).ok, false)
})

test('the two contract versions can never drive each other', () => {
  const ledger = new ConfirmationLedger()
  ledger.register('C1', { originalConfirmation: 'q', currentState: 's' })
  const asV2 = ledger.guard('C1', { version: ITEM_VERSION.V2 })
  assert.equal(asV2.ok, false)
  assert.equal(asV2.code, REJECTION.VERSION_MISMATCH)
  assert.equal(ledger.guard('C1', { version: ITEM_VERSION.V1 }).ok, true)

  const other = new ConfirmationLedger()
  other.register('C1', { originalConfirmation: 'q', currentState: 's', version: ITEM_VERSION.V2 })
  const asV1 = other.guard('C1', { version: ITEM_VERSION.V1 })
  assert.equal(asV1.ok, false)
  assert.equal(asV1.code, REJECTION.VERSION_MISMATCH)
  assert.equal(other.guardComplete('C1', { version: ITEM_VERSION.V1 }).code, REJECTION.VERSION_MISMATCH)
})

test('a new round clears the previous approval and authorisation', () => {
  const ledger = ledgerWithV2Item()
  ledger.beginDecisionV2('C1')
  ledger.markDecidedV2('C1', 'REQUEST_APPROVAL')
  assert.equal(ledger.get('C1').approval.required, true)
  // An approval-pending item is still in use, so it must be closed before the
  // number can be reused (the same rule as PENDING / AWAITING_EXECUTION).
  assert.throws(() => ledger.register('C1', { originalConfirmation: 'x', currentState: 's' }), /still open/)
  ledger.resolve('C1')

  ledger.register('C1', { originalConfirmation: '新问题', currentState: '新现状', version: ITEM_VERSION.V2 })
  const item = ledger.get('C1')
  assert.equal(item.state, ITEM_STATE.PENDING)
  assert.equal(item.approval, undefined)
  assert.equal(item.authorizedRevision, undefined)
  assert.equal(item.round, 2)
  // The revision keeps counting up, so the previous round's token is unusable.
  assert.equal(item.decisionRevision, 1)
})

test('decisionOf reports the revision, version and approval for reporting', () => {
  const ledger = ledgerWithV2Item()
  ledger.beginDecisionV2('C1')
  ledger.markDecidedV2('C1', 'REQUEST_APPROVAL')
  const info = ledger.decisionOf('C1')
  assert.equal(info.version, ITEM_VERSION.V2)
  assert.equal(info.revision, 1)
  assert.equal(info.outcome, 'REQUEST_APPROVAL')
  assert.equal(info.state, ITEM_STATE.AWAITING_APPROVAL)
  assert.equal(info.approval.required, true)
})

test('re-registering a V2 item that is still open is still refused', () => {
  const ledger = ledgerWithV2Item()
  ledger.beginDecisionV2('C1')
  ledger.markDecidedV2('C1', 'MODIFY')
  assert.throws(
    () => ledger.register('C1', { originalConfirmation: 'other', currentState: 's', version: ITEM_VERSION.V2 }),
    /still open/,
  )
})

test('a V2 item cannot be re-decided once it is RESOLVED', () => {
  const ledger = ledgerWithV2Item()
  ledger.beginDecisionV2('C1')
  ledger.markDecidedV2('C1', 'KEEP_CURRENT')
  assert.throws(() => ledger.beginDecisionV2('C1'), /resolved/)
})
