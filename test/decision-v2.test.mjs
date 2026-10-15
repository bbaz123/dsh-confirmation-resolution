/**
 * Contract tests for the V2 decision core.
 *
 * These assert the expected results 方案 §9 lists as T01–T16 plus the invariant
 * tests of the same section. The V1 contract is covered by `decide.test.mjs` and
 * is deliberately NOT touched here.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GOAL_SOURCE,
  LIFECYCLE,
  OUTCOME,
  SCHEMA_VERSION,
  V2_MISSING,
  checkSensitivity,
  decideV2,
  netBenefit,
  notApplicableV2,
} from '../lib/decision-v2.js'
import { REASON, resolveScenario } from '../lib/policies.js'

/** A valid V2 request; each test overrides only what it is about. */
function request(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    confirmation_id: 'C1',
    current_state: '主按钮为次级尺寸',
    original_confirmation: '主按钮是否需要更突出？',
    user_reply: '把按钮放大 300%',
    context: { scenario: 'ui_preference', user_goal: '提高主操作的可发现性', goal_source: GOAL_SOURCE.USER_STATED },
    authorization: { verification: 'PASS' },
    candidates: [],
    ...overrides,
  }
}

/** One modification candidate with every dimension stated. */
function modify(id, dimensions = {}, extra = {}) {
  return {
    id,
    kind: 'MODIFY',
    approach: `${id} approach`,
    scope: 'component',
    reversibility: 'reversible',
    evidence_state: 'PASS',
    goal_fit: 'MEDIUM',
    user_value: 'MEDIUM',
    output_quality: 'MEDIUM',
    impact_risk: 'LOW',
    execution_cost: 'LOW',
    long_term_value: 'MEDIUM',
    ...dimensions,
    ...extra,
  }
}

/** A neutral KEEP_CURRENT baseline, stated explicitly. */
function keep(dimensions = {}) {
  return {
    id: 'KEEP',
    kind: 'KEEP_CURRENT',
    approach: 'keep the current state',
    goal_fit: 'NONE',
    user_value: 'NONE',
    output_quality: 'NONE',
    impact_risk: 'NONE',
    execution_cost: 'NONE',
    long_term_value: 'NONE',
    ...dimensions,
  }
}

// ── T01 纯偏好不自动归零 ────────────────────────────────────────────────────
test('T01 — a reversible personal preference may beat KEEP_CURRENT', () => {
  const value = decideV2(request({
    candidates: [
      keep(),
      modify('P', { goal_fit: 'MEDIUM', user_value: 'HIGH', output_quality: 'HIGH', long_term_value: 'MEDIUM' }, { user_proposed: true }),
    ],
  }))
  assert.equal(value.outcome, OUTCOME.MODIFY)
  assert.equal(value.selected_solution_id, 'P')
  assert.equal(value.lifecycle_status, LIFECYCLE.READY_TO_EXECUTE)
  assert.ok(value.reason_codes.includes(REASON.USER_PREFERENCE_HONOURED), value.reason_codes.join(','))
  assert.ok(value.reason_codes.includes(REASON.USER_PROPOSED_SOLUTION_SELECTED))
})

// ── T02 质量为 NONE 不自动修改 ──────────────────────────────────────────────
test('T02 — a costly change with no measurable benefit keeps the current state', () => {
  const value = decideV2(request({
    candidates: [
      keep(),
      modify('X', {
        goal_fit: 'NONE', user_value: 'NONE', output_quality: 'NONE',
        impact_risk: 'NONE', execution_cost: 'HIGH', long_term_value: 'NONE',
      }),
    ],
  }))
  assert.equal(value.outcome, OUTCOME.KEEP_CURRENT)
  assert.equal(value.lifecycle_status, LIFECYCLE.RESOLVED)
  assert.equal(value.executable, false)
  assert.ok(
    value.reason_codes.includes(REASON.NO_MEASURABLE_BENEFIT)
      || value.reason_codes.includes(REASON.KEEP_CURRENT_OPTIMAL),
    value.reason_codes.join(','),
  )
})

test('T02b — a huge cost with only a one-level gain is not worth executing', () => {
  const value = decideV2(request({
    candidates: [
      keep(),
      modify('X', {
        goal_fit: 'LOW', user_value: 'LOW', output_quality: 'LOW',
        execution_cost: 'HIGH', long_term_value: 'NONE', impact_risk: 'NONE',
      }),
    ],
  }))
  assert.equal(value.outcome, OUTCOME.KEEP_CURRENT)
  assert.ok(value.reason_codes.includes(REASON.COST_EXCEEDS_MARGINAL_BENEFIT), value.reason_codes.join(','))
})

// ── T03 不机械执行数值，也不按比例一刀切 ────────────────────────────────────
test('T03 — "300%" is eliminated in a UI scenario and a feasible alternative is chosen', () => {
  const value = decideV2(request({
    candidates: [
      keep(),
      modify('USER', { goal_fit: 'HIGH', user_value: 'HIGH', output_quality: 'LOW', impact_risk: 'MEDIUM' }, {
        approach: '把按钮放大 300%', user_proposed: true,
      }),
      modify('ALT', { goal_fit: 'HIGH', user_value: 'HIGH', output_quality: 'HIGH', impact_risk: 'LOW' }, {
        approach: '提高对比度并增加局部留白',
      }),
    ],
  }))
  assert.equal(value.outcome, OUTCOME.MODIFY)
  assert.equal(value.selected_solution_id, 'ALT')
  assert.ok(value.reason_codes.includes(REASON.USER_PROPOSED_SOLUTION_OVERRIDDEN), value.reason_codes.join(','))
  const rejected = value.rejected_candidates.find((entry) => entry.id === 'USER')
  assert.ok(rejected !== undefined, 'the 300% candidate must be reported as rejected')
  assert.equal(rejected.reason_code, REASON.SCALE_EXCESSIVE)
})

// ── T04 200% 不是全场景硬禁令 ──────────────────────────────────────────────
test('T04 — an explicit size verified as safe is allowed into the normal comparison', () => {
  const value = decideV2(request({
    candidates: [
      keep(),
      modify('PRECISE', { goal_fit: 'HIGH', user_value: 'HIGH', output_quality: 'HIGH', impact_risk: 'LOW' }, {
        approach: '把按钮放大 300%', scale_verified: true, user_proposed: true,
      }),
    ],
  }))
  assert.equal(value.outcome, OUTCOME.MODIFY)
  assert.equal(value.selected_solution_id, 'PRECISE')
})

test('T04b — the same magnitude in a non-UI scenario is not judged by the button rule', () => {
  const value = decideV2(request({
    context: { scenario: 'code_change', user_goal: '削减查询耗时', goal_source: GOAL_SOURCE.USER_STATED },
    candidates: [
      keep(),
      modify('CACHE', { goal_fit: 'HIGH', output_quality: 'HIGH', long_term_value: 'MEDIUM' }, { approach: '把缓存命中率提高到 300%' }),
    ],
  }))
  assert.equal(value.outcome, OUTCOME.MODIFY)
  assert.equal(value.selected_solution_id, 'CACHE')
})

// ── T05 UNKNOWN ≠ PASS ────────────────────────────────────────────────────
test('T05 — a candidate with no constraint evidence is blocked instead of executed', () => {
  const bare = {
    id: 'BARE',
    kind: 'MODIFY',
    approach: 'change something',
    scope: 'component',
    goal_fit: 'HIGH',
    user_value: 'HIGH',
    output_quality: 'HIGH',
    impact_risk: 'LOW',
    execution_cost: 'LOW',
    long_term_value: 'MEDIUM',
  }
  const value = decideV2(request({ candidates: [keep(), bare] }))
  assert.equal(value.outcome, OUTCOME.INSUFFICIENT_CONTEXT)
  assert.equal(value.lifecycle_status, LIFECYCLE.PENDING)
  assert.equal(value.executable, false)
  assert.ok(value.reason_codes.includes(REASON.CRITICAL_UNKNOWN), value.reason_codes.join(','))
  assert.match(value.missing_information.join('\n'), /BARE\./)
})

test('T05b — an unverified authorization blocks automatic action', () => {
  const value = decideV2(request({
    authorization: {},
    candidates: [keep(), modify('A')],
  }))
  assert.equal(value.outcome, OUTCOME.INSUFFICIENT_CONTEXT)
  assert.match(value.missing_information.join('\n'), /A\.AUTHORIZATION_MISSING/)
})

// ── T06 硬约束不可被评分抵消 ────────────────────────────────────────────────
test('T06 — a high-scoring candidate that exceeds the permitted scope is rejected', () => {
  const value = decideV2(request({
    candidates: [
      keep(),
      modify('BIG', { goal_fit: 'HIGH', user_value: 'HIGH' }, { within_permitted_scope: false }),
    ],
  }))
  assert.equal(value.outcome, OUTCOME.REJECT)
  assert.equal(value.selected_solution_id, null)
  const rejected = value.rejected_candidates.find((entry) => entry.id === 'BIG')
  assert.equal(rejected.reason_code, REASON.SCOPE_EXCEEDS_PERMITTED)
})

test('T06b — a declared permission scope catches an over-wide candidate', () => {
  const value = decideV2(request({
    candidates: [keep(), modify('WIDE', {}, { scope: 'system' })],
    authorization: { verification: 'PASS', permitted_scope: 'component' },
  }))
  assert.equal(value.outcome, OUTCOME.REJECT)
  assert.ok(value.reason_codes.includes(REASON.REJECTED_ALL_CANDIDATES))
})

// ── T07 权限与审批分别验证 ────────────────────────────────────────────────
test('T07 — an irreversible production change with valid permission asks for approval', () => {
  const value = decideV2(request({
    context: { scenario: 'external_action', user_goal: '清理生产数据', goal_source: GOAL_SOURCE.USER_STATED },
    candidates: [
      keep(),
      modify('DELETE', { goal_fit: 'HIGH', output_quality: 'MEDIUM', impact_risk: 'HIGH' }, { irreversible_effect: true, external_effect: true }),
    ],
  }))
  assert.equal(value.outcome, OUTCOME.REQUEST_APPROVAL)
  assert.equal(value.lifecycle_status, LIFECYCLE.AWAITING_APPROVAL)
  assert.equal(value.approval_required, true)
  assert.equal(typeof value.approval_question, 'string')
  assert.equal(value.executable, false)
  assert.equal(value.selected_solution_id, null)
  assert.equal(value.execution_scope, null)
})

// ── T08 用户同意不能赋予不存在的权限 ──────────────────────────────────────
test('T08 — a missing permission is rejected even with approval present', () => {
  const value = decideV2(request({
    context: { scenario: 'external_action', user_goal: '清理生产数据', goal_source: GOAL_SOURCE.USER_STATED },
    authorization: { verification: 'FAIL', user_decision: 'APPROVED', source: 'USER_REPLY' },
    candidates: [
      keep(),
      modify('DELETE', { goal_fit: 'HIGH', impact_risk: 'HIGH' }, { irreversible_effect: true, external_effect: true }),
    ],
  }))
  assert.equal(value.outcome, OUTCOME.REJECT)
  const rejected = value.rejected_candidates.find((entry) => entry.id === 'DELETE')
  assert.equal(rejected.reason_code, REASON.AUTHORIZATION_MISSING)
})

// ── T09 防止伪造审批 ──────────────────────────────────────────────────────
test('T09 — a model-supplied approved:true never authorises execution', () => {
  const value = decideV2(request({
    context: { scenario: 'external_action', user_goal: '清理生产数据', goal_source: GOAL_SOURCE.USER_STATED },
    authorization: { verification: 'PASS', approved: true },
    candidates: [
      keep(),
      modify('DELETE', { goal_fit: 'HIGH', impact_risk: 'HIGH' }, { irreversible_effect: true, external_effect: true }),
    ],
  }))
  assert.equal(value.outcome, OUTCOME.REQUEST_APPROVAL)
  assert.equal(value.executable, false)
})

test('T09b — user_decision without a named source is still only attested, not verified', () => {
  const value = decideV2(request({
    context: { scenario: 'external_action', user_goal: '清理生产数据', goal_source: GOAL_SOURCE.USER_STATED },
    authorization: { verification: 'PASS', user_decision: 'APPROVED' },
    candidates: [
      keep(),
      modify('DELETE', { goal_fit: 'HIGH', impact_risk: 'HIGH' }, { irreversible_effect: true, external_effect: true }),
    ],
  }))
  assert.equal(value.outcome, OUTCOME.REQUEST_APPROVAL)
})

// ── T10 同分决策稳定：更可逆、范围更小 ─────────────────────────────────────
test('T10 — a near-tie prefers the reversible, narrower candidate', () => {
  const value = decideV2(request({
    context: { scenario: 'code_change', user_goal: '修复缺陷', goal_source: GOAL_SOURCE.USER_STATED },
    candidates: [
      keep(),
      modify('WIDE', {}, { scope: 'system', reversibility: 'partial' }),
      modify('NARROW', {}, { scope: 'value', reversibility: 'reversible' }),
    ],
  }))
  assert.equal(value.outcome, OUTCOME.MODIFY)
  assert.equal(value.selected_solution_id, 'NARROW')
})

test('T10b — the candidate order never changes the winner', () => {
  const wide = modify('WIDE', {}, { scope: 'system', reversibility: 'partial' })
  const narrow = modify('NARROW', {}, { scope: 'value', reversibility: 'reversible' })
  const first = decideV2(request({ candidates: [keep(), wide, narrow] }))
  const second = decideV2(request({ candidates: [narrow, wide, keep()] }))
  assert.equal(first.selected_solution_id, second.selected_solution_id)
})

// ── T15 不猜风险或目标 ────────────────────────────────────────────────────
test('T15 — an unassessed risk with no goal is insufficient context', () => {
  const value = decideV2(request({
    context: { scenario: 'code_change' },
    candidates: [keep(), modify('RISKY', { impact_risk: undefined })],
  }))
  assert.equal(value.outcome, OUTCOME.INSUFFICIENT_CONTEXT)
  assert.equal(value.lifecycle_status, LIFECYCLE.PENDING)
  assert.equal(value.executable, false)
  assert.ok(value.missing_information.length > 0)
})

test('T15b — a MODIFY needs a goal', () => {
  const value = decideV2(request({
    context: { scenario: 'code_change' },
    candidates: [keep(), modify('A')],
  }))
  assert.equal(value.outcome, OUTCOME.INSUFFICIENT_CONTEXT)
  assert.match(value.missing_information.join('\n'), /USER_GOAL_REQUIRED_FOR_MODIFY/)
})

// ── T16 REJECT 不是 KEEP_CURRENT ──────────────────────────────────────────
test('T16 — a fully blocked request is REJECT, never a pretended KEEP_CURRENT', () => {
  const value = decideV2(request({
    candidates: [
      keep(),
      modify('A', {}, { violates_constraints: true, user_proposed: true }),
      modify('B', {}, { within_permitted_scope: false }),
    ],
  }))
  assert.equal(value.outcome, OUTCOME.REJECT)
  assert.equal(value.lifecycle_status, LIFECYCLE.PENDING)
  assert.equal(value.selected_solution_id, null)
  assert.equal(value.executable, false)
  assert.ok(value.rejected_candidates.length >= 2)
})

// ── 基线构造与「无候选不编造」 ─────────────────────────────────────────────
test('the engine constructs a KEEP_CURRENT baseline when the caller omits one', () => {
  const value = decideV2(request({ candidates: [modify('A', { impact_risk: 'LOW' })] }))
  assert.equal(value.outcome, OUTCOME.MODIFY)
  assert.ok(value.reason_codes.length > 0)
  assert.equal(value.decision_trace.constructed_baseline, true)
  assert.equal(value.decision_trace.baseline_id, 'KEEP_CURRENT')
})

test('no candidates at all is insufficient context, never an invented solution', () => {
  const value = decideV2(request({ candidates: [] }))
  assert.equal(value.outcome, OUTCOME.INSUFFICIENT_CONTEXT)
  assert.ok(value.reason_codes.includes(REASON.NO_CANDIDATES))
})

test('a caller that only asks to keep the current state closes as KEEP_CURRENT', () => {
  const value = decideV2(request({ candidates: [keep()] }))
  assert.equal(value.outcome, OUTCOME.KEEP_CURRENT)
  assert.equal(value.lifecycle_status, LIFECYCLE.RESOLVED)
  assert.ok(value.reason_codes.includes(REASON.KEEP_CURRENT_OPTIMAL))
})

// ── 属性 / 不变量测试（方案 §9） ─────────────────────────────────────────
test('invariant — authorization monotonicity: weakening permission never enables execution', () => {
  const candidates = [keep(), modify('A', { goal_fit: 'HIGH', impact_risk: 'MEDIUM' })]
  const strong = decideV2(request({ authorization: { verification: 'PASS' }, candidates }))
  for (const verification of ['UNKNOWN', 'FAIL']) {
    const weak = decideV2(request({ authorization: { verification }, candidates }))
    assert.notEqual(weak.outcome, OUTCOME.MODIFY,
      `authorization ${verification} must not reach MODIFY (strong run was ${strong.outcome})`)
    assert.equal(weak.executable, false)
  }
})

test('invariant — risk monotonicity: raising impact risk never removes the approval requirement', () => {
  const build = (risk) => decideV2(request({
    context: { scenario: 'external_action', user_goal: '部署到生产', goal_source: GOAL_SOURCE.USER_STATED },
    candidates: [keep(), modify('DEPLOY', { goal_fit: 'HIGH', impact_risk: risk }, { external_effect: true })],
  }))
  const low = build('LOW')
  const high = build('HIGH')
  if (low.outcome === OUTCOME.REQUEST_APPROVAL) {
    assert.equal(high.outcome, OUTCOME.REQUEST_APPROVAL)
  }
  assert.ok([OUTCOME.REQUEST_APPROVAL, OUTCOME.MODIFY, OUTCOME.INSUFFICIENT_CONTEXT].includes(high.outcome))
  assert.equal(high.executable, false)
})

test('invariant — determinism: identical input yields an identical result', () => {
  const input = request({ candidates: [keep(), modify('A'), modify('B', { goal_fit: 'HIGH' })] })
  assert.deepEqual(decideV2(input), decideV2(input))
})

test('invariant — non-executable outcomes carry no execution authorisation', () => {
  const cases = [
    decideV2(request({ candidates: [keep(), modify('A')], authorization: {} })),
    decideV2(request({ candidates: [keep(), modify('B', {}, { within_permitted_scope: false })] })),
    decideV2(request({
      context: { scenario: 'external_action', user_goal: 'g', goal_source: GOAL_SOURCE.USER_STATED },
      candidates: [keep(), modify('C', { goal_fit: 'HIGH', impact_risk: 'HIGH' }, { irreversible_effect: true })],
    })),
  ]
  for (const value of cases) {
    assert.notEqual(value.lifecycle_status, LIFECYCLE.READY_TO_EXECUTE)
    assert.equal(value.executable, false)
    assert.equal(value.selected_solution_id, null)
    assert.equal(value.execution_scope, null)
  }
})

test('robustness — malformed input produces a predictable, non-throwing result', () => {
  assert.equal(decideV2(undefined).outcome, OUTCOME.INSUFFICIENT_CONTEXT)
  assert.equal(decideV2({}).outcome, OUTCOME.INSUFFICIENT_CONTEXT)
  assert.equal(decideV2(request({ candidates: [null, 42, 'x'] })).outcome, OUTCOME.INSUFFICIENT_CONTEXT)
  const extreme = decideV2(request({ candidates: [keep(), modify('E', { goal_fit: 'HIGH' }, { scale: 1e9 })] }))
  assert.equal(extreme.outcome, OUTCOME.REJECT)
  const badEnum = decideV2(request({
    candidates: [keep(), modify('E', { goal_fit: 'HIGH' }, { scope: 'galaxy', reversibility: 'maybe' })],
  }))
  assert.ok([OUTCOME.MODIFY, OUTCOME.INSUFFICIENT_CONTEXT, OUTCOME.KEEP_CURRENT, OUTCOME.REJECT].includes(badEnum.outcome))
})

test('robustness — a wrong schema_version is refused with a stable code', () => {
  const value = decideV2(request({ schema_version: '1.0', candidates: [keep()] }))
  assert.equal(value.outcome, OUTCOME.INSUFFICIENT_CONTEXT)
  assert.match(value.missing_information.join('\n'), /SCHEMA_VERSION_MISMATCH/)
})

// ── 辅助函数直测 ─────────────────────────────────────────────────────────
test('checkSensitivity flags a one-level, same-scope, high-stakes near tie', () => {
  const policy = resolveScenario('code_change')
  const a = { id: 'A', scope: 'component', reversibility: 'reversible', dimensions: { goal_fit: 'HIGH', impact_risk: 'MEDIUM', user_value: 'LOW', output_quality: 'LOW', execution_cost: 'LOW', long_term_value: 'LOW' } }
  const b = { id: 'B', scope: 'component', reversibility: 'reversible', dimensions: { goal_fit: 'MEDIUM', impact_risk: 'MEDIUM', user_value: 'LOW', output_quality: 'LOW', execution_cost: 'LOW', long_term_value: 'LOW' } }
  const verdict = checkSensitivity([a, b], policy)
  assert.equal(verdict.near_tie, true)
  assert.equal(verdict.stable, false)
})

test('netBenefit refuses to judge a candidate whose benefit evidence is missing', () => {
  const policy = resolveScenario('generic')
  const baseline = { dimensions: { goal_fit: 'NONE', user_value: 'NONE', output_quality: 'NONE', impact_risk: 'NONE', execution_cost: 'NONE', long_term_value: 'NONE' } }
  const blank = { dimensions: { goal_fit: 'UNKNOWN', user_value: 'UNKNOWN', output_quality: 'UNKNOWN', impact_risk: 'LOW', execution_cost: 'LOW', long_term_value: 'UNKNOWN' } }
  const verdict = netBenefit(blank, baseline, policy)
  assert.equal(verdict.worth, false)
  assert.equal(verdict.judgeable, false)
})

test('notApplicableV2 is a refusal, not a decision', () => {
  const value = notApplicableV2({ confirmationId: 'C9', code: 'UNKNOWN_CONFIRMATION_ITEM', reason: 'never published', decisionRevision: 0 })
  assert.equal(value.outcome, OUTCOME.NOT_APPLICABLE)
  assert.equal(value.lifecycle_status, LIFECYCLE.UNCHANGED)
  assert.equal(value.executable, false)
  assert.equal(value.selected_solution_id, null)
})
