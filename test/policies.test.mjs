/**
 * Tests for the scenario policies (方案 §3.2, §4.4, §4.5).
 *
 * Every scenario's ordering, threshold and scale rule is data, so each can be
 * asserted directly instead of being inferred from the decision results.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { GATE, LEVEL } from '../lib/evidence.js'
import {
  DIMENSIONS,
  SCENARIOS,
  SCOPE_ORDER,
  approvalRequirement,
  compareCandidates,
  goodness,
  isDeclaredScenario,
  paretoDominates,
  paretoFront,
  resolveScenario,
  reversibility,
  scaleVerdict,
  scope,
} from '../lib/policies.js'

function candidate(id, dimensions = {}, extra = {}) {
  return {
    id,
    kind: 'MODIFY',
    scope: 'component',
    reversibility: 'reversible',
    evidenceState: GATE.PASS,
    dimensions: {
      goal_fit: LEVEL.MEDIUM,
      user_value: LEVEL.MEDIUM,
      output_quality: LEVEL.MEDIUM,
      impact_risk: LEVEL.LOW,
      execution_cost: LEVEL.LOW,
      long_term_value: LEVEL.MEDIUM,
      ...dimensions,
    },
    ...extra,
  }
}

test('resolveScenario falls back to generic and accepts loose casing', () => {
  assert.equal(resolveScenario('ui_preference').id, 'ui_preference')
  assert.equal(resolveScenario('UI Preference').id, 'ui_preference')
  assert.equal(resolveScenario('external-action').id, 'external_action')
  assert.equal(resolveScenario('nonsense').id, 'generic')
  assert.equal(resolveScenario(undefined).id, 'generic')
  assert.equal(isDeclaredScenario('code_change'), true)
  assert.equal(isDeclaredScenario('nonsense'), false)
})

test('every scenario orders all comparable dimensions plus reversibility', () => {
  for (const [key, policy] of Object.entries(SCENARIOS)) {
    assert.equal(policy.id, key)
    const required = [...DIMENSIONS, 'reversibility']
    for (const dimension of required) {
      assert.ok(policy.priorities.includes(dimension), `${key} is missing priority ${dimension}`)
    }
    assert.equal(new Set(policy.priorities).size, policy.priorities.length, `${key} repeats a priority`)
    assert.ok(Object.hasOwn({ NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 }, policy.approvalRiskThreshold))
    assert.equal(typeof policy.label, 'string')
  }
})

test('goodness() ranks higher-is-better and lower-is-better dimensions consistently', () => {
  const cheap = candidate('A', { impact_risk: LEVEL.NONE, execution_cost: LEVEL.NONE })
  const risky = candidate('B', { impact_risk: LEVEL.HIGH, execution_cost: LEVEL.HIGH })
  assert.ok(goodness(cheap, 'impact_risk') > goodness(risky, 'impact_risk'))
  assert.ok(goodness(cheap, 'execution_cost') > goodness(risky, 'execution_cost'))
  const good = candidate('C', { goal_fit: LEVEL.HIGH })
  const weak = candidate('D', { goal_fit: LEVEL.LOW })
  assert.ok(goodness(good, 'goal_fit') > goodness(weak, 'goal_fit'))
  const unknown = candidate('E', { goal_fit: LEVEL.UNKNOWN })
  assert.ok(goodness(unknown, 'goal_fit') < goodness(weak, 'goal_fit'))
})

test('reversibility beats irreversibility and a narrower scope beats a wider one', () => {
  const policy = resolveScenario('code_change')
  const a = candidate('A', {}, { reversibility: 'reversible', scope: 'value' })
  const b = candidate('B', {}, { reversibility: 'irreversible', scope: 'system' })
  const ranked = [b, a].sort((left, right) => compareCandidates(left, right, policy))
  assert.equal(ranked[0].id, 'A')
  assert.equal(compareCandidates(a, b, policy) < 0, true)
})

test('the scenario policy changes the winner: ui_preference weights user value first', () => {
  const valueFirst = candidate('V', { user_value: LEVEL.HIGH, output_quality: LEVEL.NONE })
  const qualityFirst = candidate('Q', { user_value: LEVEL.NONE, output_quality: LEVEL.HIGH })
  const ui = resolveScenario('ui_preference')
  const code = resolveScenario('code_change')
  assert.equal([valueFirst, qualityFirst].sort((a, b) => compareCandidates(a, b, ui))[0].id, 'V')
  assert.equal([valueFirst, qualityFirst].sort((a, b) => compareCandidates(a, b, code))[0].id, 'Q')
})

test('pareto dominance ignores pairs it cannot compare', () => {
  const policy = resolveScenario('generic')
  const strong = candidate('S', { goal_fit: LEVEL.HIGH, impact_risk: LEVEL.NONE })
  const weak = candidate('W', { goal_fit: LEVEL.LOW, impact_risk: LEVEL.MEDIUM })
  assert.equal(paretoDominates(strong, weak, policy), true)
  assert.equal(paretoDominates(weak, strong, policy), false)
  const unknown = candidate('U', { goal_fit: LEVEL.HIGH, impact_risk: LEVEL.UNKNOWN })
  assert.equal(paretoDominates(strong, unknown, policy), false, 'an UNKNOWN dimension makes the pair incomparable')
  assert.equal(paretoDominates(unknown, strong, policy), false)
})

test('paretoFront keeps every incomparable candidate', () => {
  const policy = resolveScenario('generic')
  const a = candidate('A', { goal_fit: LEVEL.HIGH, user_value: LEVEL.NONE })
  const b = candidate('B', { goal_fit: LEVEL.NONE, user_value: LEVEL.HIGH })
  const dominated = candidate('C', { goal_fit: LEVEL.NONE, user_value: LEVEL.NONE })
  const front = paretoFront([a, b, dominated], policy).map((entry) => entry.id)
  assert.deepEqual(front.sort(), ['A', 'B'])
})

test('scope() and reversibility() normalize unknown tokens without guessing', () => {
  assert.equal(scope('PAGE'), 'page')
  assert.equal(scope('galaxy'), 'UNKNOWN')
  assert.equal(reversibility('Reversible'), 'reversible')
  assert.equal(reversibility('maybe'), 'UNKNOWN')
  assert.deepEqual(SCOPE_ORDER, ['value', 'state', 'component', 'section', 'page', 'system'])
})

test('approvalRequirement only accepts an explicit source-named user decision', () => {
  const policy = resolveScenario('external_action')
  const risky = candidate('R', { impact_risk: LEVEL.HIGH }, { externalEffect: true })
  assert.equal(approvalRequirement(risky, policy, {}).required, true)
  assert.equal(approvalRequirement(risky, policy, { userDecision: 'UNSPECIFIED' }).required, true)
  // A bare `approved: true` is not part of the normalized context at all.
  assert.equal(approvalRequirement(risky, policy, { approved: true }).required, true)
  // A user decision that names its source is honoured, but flagged as attested.
  const attested = approvalRequirement(risky, policy, { userDecision: 'APPROVED', source: 'USER_REPLY' })
  assert.equal(attested.required, false)
  assert.equal(attested.attested, true)
  // A user decision attributed to the model is not.
  assert.equal(approvalRequirement(risky, policy, { userDecision: 'APPROVED', source: 'MODEL' }).required, true)
  // Irreversibility alone is enough, whatever the scenario.
  const irreversible = candidate('I', { impact_risk: LEVEL.LOW }, { irreversibleEffect: true })
  assert.equal(approvalRequirement(irreversible, resolveScenario('generic'), {}).required, true)
  // An ordinary change below the threshold needs no approval.
  assert.equal(approvalRequirement(candidate('N'), resolveScenario('generic'), {}).required, false)
})

test('scaleVerdict applies only where a scenario declared a limit', () => {
  const ui = resolveScenario('ui_preference')
  const code = resolveScenario('code_change')
  assert.equal(scaleVerdict({ scale: 300, scaleUnit: '%' }, ui).excessive, true)
  assert.equal(scaleVerdict({ scale: 150, scaleUnit: '%' }, ui).excessive, false)
  assert.equal(scaleVerdict({ scale: 300, scaleUnit: '%' }, code).excessive, false,
    'the button-size rule must not be reused for data/budget percentages')
  assert.equal(scaleVerdict({ scale: 300, scaleUnit: 'MB' }, ui).excessive, false,
    'a different unit of meaning disables the UI-size limit')
  assert.match(scaleVerdict({ scale: 300, scaleUnit: '%' }, ui).reason, /UI|界面/)
})
