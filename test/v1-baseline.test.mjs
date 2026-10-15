/**
 * PR-0: the frozen V1 baseline, and the contrast that motivates V2.
 *
 * 方案 §2 records that V1's `normalizeSolution()` fills absent evidence with
 * optimistic defaults (`solves_user_problem` ≈ true, `violates_constraints` ≈
 * false, `quality_loss` ≈ `NONE`, `within_permitted_scope` ≈ true). These tests
 * PIN that behaviour so it can never change by accident, and assert that the V2
 * core answers the same input differently — `UNKNOWN` instead of a silent pass.
 *
 * Nothing here endorses the V1 defaults; they are recorded behaviour, and the
 * V1 contract is deliberately retained for existing callers.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { decide } from '../lib/decide.js'
import { decideV2, OUTCOME } from '../lib/decision-v2.js'

/** A V1 call whose only candidate states nothing about its gates. */
function silentCandidateCall() {
  return {
    confirmation_id: 'C1',
    current_state: '主按钮为次级尺寸',
    original_confirmation: '主按钮是否需要更突出？',
    user_reply: 'C1 修改',
    user_goal: '提高关键操作的可发现性',
    quality_impact: 'NONE',
    candidate_solutions: [
      { label: 'silent', approach: '提高一个视觉层级', scope: 'component' },
    ],
  }
}

test('V1 baseline — absent gate fields are read as passes (recorded, not endorsed)', () => {
  const value = decide(silentCandidateCall())
  assert.equal(value.action, 'MODIFY')
  assert.equal(value.status, 'READY_TO_EXECUTE')
  assert.equal(value.selected_solution, '提高一个视觉层级')
})

test('V1 baseline — an absent candidate quality_loss is read as NONE', () => {
  // The candidate never states `quality_loss`; V1 assumes NONE, so it survives
  // the avoidable-loss ceiling. V2 needs the dimension stated (see the contrast
  // test below and decision-v2.test.mjs T05).
  const value = decide(silentCandidateCall())
  assert.equal(value.action, 'MODIFY')
  assert.equal(value.status, 'READY_TO_EXECUTE')
})

test('V1 baseline — an absent within_permitted_scope is read as permitted', () => {
  const call = silentCandidateCall()
  call.candidate_solutions = [{ label: 'silent', approach: '提高一个视觉层级', scope: 'system' }]
  const value = decide(call)
  assert.equal(value.action, 'MODIFY')
  assert.equal(value.execution_required, true)
})

test('contrast — the same silent candidate is INSUFFICIENT_CONTEXT under V2', () => {
  const value = decideV2({
    schema_version: '2.0',
    confirmation_id: 'C1',
    current_state: '主按钮为次级尺寸',
    original_confirmation: '主按钮是否需要更突出？',
    user_reply: 'C1 修改',
    context: { scenario: 'ui_preference', user_goal: '提高关键操作的可发现性', goal_source: 'USER_STATED' },
    authorization: { verification: 'PASS' },
    candidates: [
      { id: 'KEEP', kind: 'KEEP_CURRENT' },
      { id: 'silent', kind: 'MODIFY', approach: '提高一个视觉层级', scope: 'component', goal_fit: 'HIGH', impact_risk: 'LOW' },
    ],
  })
  assert.equal(value.outcome, OUTCOME.INSUFFICIENT_CONTEXT)
  assert.equal(value.executable, false)
  assert.ok(value.missing_information.length > 0)
})

test('the V1 core is not touched by the V2 modules', () => {
  // V1 keeps its own vocabulary even after V2 ships: no V2 outcome leaks into it.
  const value = decide(silentCandidateCall())
  assert.ok(['MODIFY', 'KEEP_CURRENT'].includes(value.action))
  assert.equal(Object.hasOwn(value, 'outcome'), false)
  assert.equal(Object.hasOwn(value, 'schema_version'), false)
})
