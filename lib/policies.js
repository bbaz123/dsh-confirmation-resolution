/**
 * Scenario policies for the V2 decision engine.
 *
 * 方案 §4.4: "不要使用单一加权总分决定所有任务." Different tasks need different
 * priorities, so each scenario declares its own lexicographic priority order and
 * its own risk/scale thresholds. Everything here is data plus pure comparison
 * helpers, so the ranking is reproducible and every policy can be tested
 * directly instead of being implied by prose.
 *
 * The seven comparable dimensions of 方案 §3.2 live in {@link DIMENSIONS};
 * `confidence` is NOT one of them — it decides whether we may act at all, so it
 * is handled by `lib/decision-v2.js` and `lib/evidence.js`.
 *
 * Reversibility and scope take part in comparisons as ordered pseudo-dimensions:
 * `reversible` beats `partial` beats `irreversible`, and a narrower scope beats a
 * wider one (03 §10 最小必要修改).
 *
 * @module dsh-plugin-confirmation-resolution/policies
 */

import { GATE, LEVEL, LEVEL_RANK, rank } from './evidence.js'

/** Policy schema version, recorded in every decision trace. */
export const POLICY_VERSION = '2.0'

/** The comparable quality/benefit dimensions of 方案 §3.2 (the first seven). */
export const DIMENSIONS = Object.freeze([
  'goal_fit',
  'user_value',
  'output_quality',
  'impact_risk',
  'execution_cost',
  'long_term_value',
])

/** Dimensions where a HIGHER level is better; the rest are costs/risks. */
const HIGHER_IS_BETTER = new Set(['goal_fit', 'user_value', 'output_quality', 'long_term_value'])

/** Reversibility vocabulary, best first. `UNKNOWN` sorts last. */
export const REVERSIBILITY = Object.freeze(['reversible', 'partial', 'irreversible'])

const REVERSIBILITY_RANK = Object.freeze({ reversible: 0, partial: 1, irreversible: 2, UNKNOWN: 3 })

/** Modification scope, narrowest first (03 §10). */
export const SCOPE_ORDER = Object.freeze(['value', 'state', 'component', 'section', 'page', 'system'])

const SCOPE_RANK = Object.freeze({ value: 0, state: 1, component: 2, section: 3, page: 4, system: 5, NONE: -1, UNKNOWN: 9 })

/** Candidate kinds. */
export const KIND = Object.freeze({ MODIFY: 'MODIFY', KEEP_CURRENT: 'KEEP_CURRENT' })

/** Stable reason codes. Every code is asserted by a test somewhere. */
export const REASON = Object.freeze({
  GOAL_FIT_IMPROVED: 'GOAL_FIT_IMPROVED',
  USER_VALUE_IMPROVED: 'USER_VALUE_IMPROVED',
  QUALITY_PRESERVED: 'QUALITY_PRESERVED',
  QUALITY_IMPROVED: 'QUALITY_IMPROVED',
  RISK_ACCEPTABLE: 'RISK_ACCEPTABLE',
  REVERSIBLE: 'REVERSIBLE',
  IRREVERSIBLE_BUT_AUTHORISED: 'IRREVERSIBLE_BUT_AUTHORISED',
  MINIMUM_SCOPE: 'MINIMUM_SCOPE',
  COST_REASONABLE: 'COST_REASONABLE',
  COST_EXCEEDS_MARGINAL_BENEFIT: 'COST_EXCEEDS_MARGINAL_BENEFIT',
  NO_MEASURABLE_BENEFIT: 'NO_MEASURABLE_BENEFIT',
  KEEP_CURRENT_OPTIMAL: 'KEEP_CURRENT_OPTIMAL',
  USER_PREFERENCE_HONOURED: 'USER_PREFERENCE_HONOURED',
  USER_PROPOSED_SOLUTION_SELECTED: 'USER_PROPOSED_SOLUTION_SELECTED',
  USER_PROPOSED_SOLUTION_OVERRIDDEN: 'USER_PROPOSED_SOLUTION_OVERRIDDEN',
  HARD_CONSTRAINT_BLOCKED: 'HARD_CONSTRAINT_BLOCKED',
  SCOPE_EXCEEDS_PERMITTED: 'SCOPE_EXCEEDS_PERMITTED',
  SCALE_EXCESSIVE: 'SCALE_EXCESSIVE_BY_CONSTRUCTION',
  AUTHORIZATION_MISSING: 'AUTHORIZATION_MISSING',
  AUTHORIZATION_UNVERIFIED: 'AUTHORIZATION_UNVERIFIED',
  UNKNOWN_EVIDENCE_BLOCKS_ACTION: 'UNKNOWN_EVIDENCE_BLOCKS_AUTOMATIC_ACTION',
  CONFLICTING_EVIDENCE: 'CONFLICTING_EVIDENCE',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED_FOR_HIGH_IMPACT',
  APPROVAL_ATTESTED: 'APPROVAL_ATTESTED_BY_CALLER_NOT_HOST_VERIFIED',
  NEAR_TIE_REQUIRES_TRADEOFF: 'NEAR_TIE_REQUIRES_TRADEOFF',
  NEAR_TIE_RESOLVED_BY_STABILITY: 'NEAR_TIE_RESOLVED_BY_STABILITY',
  PARETO_ELIMINATED: 'PARETO_ELIMINATED',
  REJECTED_ALL_CANDIDATES: 'REJECTED_ALL_CANDIDATES',
  NO_CANDIDATES: 'NO_FEASIBLE_SOLUTION_CANDIDATE',
  NO_ALTERNATIVE: 'NO_ALTERNATIVE_TO_THE_USERS_OWN_OPTION',
  CRITICAL_UNKNOWN: 'CRITICAL_EVIDENCE_UNKNOWN',
  BASELINE_CONSTRUCTED: 'BASELINE_CANDIDATE_CONSTRUCTED',
  ROOT_CAUSE_UNRESOLVED: 'ALTERNATIVE_ADDRESSES_ROOT_CAUSE_BETTER',
})

/**
 * One scenario policy.
 *
 * @typedef {object} ScenarioPolicy
 * @property {string} id                       stable scenario id
 * @property {string} label                    human-readable name
 * @property {string[]} priorities             lexicographic order, most important first
 * @property {number} approvalRiskThreshold   impact_risk at/above which a high-impact
 *                                            change needs approval rather than auto-execution
 * @property {{maxPercent:number, unit:string, reason:string}|undefined} scaleLimit
 */

/** @type {Readonly<Record<string, ScenarioPolicy>>} */
export const SCENARIOS = Object.freeze({
  /**
   * 方案 §4.4 `ui_preference`: 用户明确偏好、体验、可逆性, and 方案 §3.1 — a
   * reversible personal preference is real value, not zero value.
   */
  ui_preference: Object.freeze({
    id: 'ui_preference',
    label: '界面与个人偏好',
    priorities: Object.freeze(['user_value', 'goal_fit', 'reversibility', 'output_quality', 'impact_risk', 'execution_cost', 'long_term_value']),
    approvalRiskThreshold: LEVEL.HIGH,
    scaleLimit: Object.freeze({
      maxPercent: 200,
      unit: '%',
      reason: '在界面场景中，超过 200% 的尺寸变化是"结构上就可疑"的异常信号，而不是普适禁令（方案 §4.5）',
    }),
  }),

  /** 关键无障碍要求不能被装饰偏好抵消。 */
  accessibility: Object.freeze({
    id: 'accessibility',
    label: '无障碍与可用性',
    priorities: Object.freeze(['goal_fit', 'output_quality', 'impact_risk', 'reversibility', 'execution_cost', 'long_term_value', 'user_value']),
    approvalRiskThreshold: LEVEL.MEDIUM,
    scaleLimit: undefined,
  }),

  /** 正确性、维护、回归风险、实施成本。 */
  code_change: Object.freeze({
    id: 'code_change',
    label: '代码与工程变更',
    priorities: Object.freeze(['output_quality', 'long_term_value', 'impact_risk', 'execution_cost', 'goal_fit', 'reversibility', 'user_value']),
    approvalRiskThreshold: LEVEL.HIGH,
    scaleLimit: undefined,
  }),

  /** 权限、安全、不可逆性、对他人的影响。 */
  external_action: Object.freeze({
    id: 'external_action',
    label: '外部动作与生产影响',
    priorities: Object.freeze(['impact_risk', 'reversibility', 'goal_fit', 'output_quality', 'long_term_value', 'execution_cost', 'user_value']),
    approvalRiskThreshold: LEVEL.MEDIUM,
    scaleLimit: undefined,
  }),

  /** 阻塞程度、时效、可回滚性。 */
  urgent_fix: Object.freeze({
    id: 'urgent_fix',
    label: '紧急修复',
    priorities: Object.freeze(['goal_fit', 'execution_cost', 'reversibility', 'impact_risk', 'output_quality', 'long_term_value', 'user_value']),
    approvalRiskThreshold: LEVEL.HIGH,
    scaleLimit: undefined,
  }),

  /** Fallback: 方案 §3.2 的维度顺序本身。 */
  generic: Object.freeze({
    id: 'generic',
    label: '通用场景',
    priorities: Object.freeze([...DIMENSIONS, 'reversibility']),
    approvalRiskThreshold: LEVEL.HIGH,
    scaleLimit: undefined,
  }),
})

/** The scenario a policy-less caller falls back to. */
export const DEFAULT_SCENARIO = 'generic'

/**
 * Resolve a caller-supplied scenario name.
 *
 * @param value - the scenario token (any casing/spacing).
 * @returns the matching policy, or the `generic` policy.
 */
export function resolveScenario(value) {
  if (typeof value !== 'string') return SCENARIOS.generic
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return Object.hasOwn(SCENARIOS, key) ? SCENARIOS[key] : SCENARIOS.generic
}

/** @returns whether a scenario name resolved to a declared policy. */
export function isDeclaredScenario(value) {
  if (typeof value !== 'string') return false
  return Object.hasOwn(SCENARIOS, value.trim().toLowerCase().replace(/[\s-]+/g, '_'))
}

/**
 * Normalize a reversibility token.
 * @param value - caller token.
 * @returns a member of {@link REVERSIBILITY} or `UNKNOWN`.
 */
export function reversibility(value) {
  if (typeof value !== 'string') return 'UNKNOWN'
  const key = value.trim().toLowerCase()
  return Object.hasOwn(REVERSIBILITY_RANK, key) ? key : 'UNKNOWN'
}

/**
 * Normalize a scope token.
 * @param value - caller token.
 * @returns a member of {@link SCOPE_ORDER} or `UNKNOWN`.
 */
export function scope(value) {
  if (typeof value !== 'string') return 'UNKNOWN'
  const key = value.trim().toLowerCase()
  return Object.hasOwn(SCOPE_RANK, key) ? key : 'UNKNOWN'
}

/**
 * "Goodness" of one candidate on one dimension: higher is always better.
 * `UNKNOWN` scores below every known value on purpose — an unchecked dimension
 * is not a reason to prefer a candidate, and the caller is told so through the
 * decision trace rather than through a silently optimistic ranking.
 *
 * @param candidate - normalized candidate.
 * @param dimension - a dimension name, `reversibility`, or `scope`.
 * @returns a numeric score (may be negative for `UNKNOWN`).
 */
export function goodness(candidate, dimension) {
  if (dimension === 'reversibility') return 2 - REVERSIBILITY_RANK[reversibility(candidate.reversibility)]
  if (dimension === 'scope') return 5 - SCOPE_RANK[scope(candidate.scope)]
  const value = candidate.dimensions?.[dimension]
  const valueRank = rank(value)
  if (valueRank === undefined) return -1
  return HIGHER_IS_BETTER.has(dimension) ? valueRank : (LEVEL_RANK.HIGH - valueRank)
}

/** @returns whether a dimension is a "less is better" cost/risk dimension. */
export function isCostDimension(dimension) {
  return !HIGHER_IS_BETTER.has(dimension)
}

/**
 * Lexicographic comparison under one scenario policy (方案 §4.4).
 *
 * Priority order, then the documented stability tie-breakers: narrower scope,
 * better reversibility, verified evidence before estimated evidence, lower
 * execution cost, then the candidate id so the result is total and deterministic.
 *
 * @param a - first normalized candidate.
 * @param b - second normalized candidate.
 * @param policy - the scenario policy.
 * @returns negative when `a` ranks better than `b`.
 */
export function compareCandidates(a, b, policy) {
  for (const dimension of policy.priorities) {
    const scoreA = goodness(a, dimension)
    const scoreB = goodness(b, dimension)
    if (scoreA !== scoreB) return scoreB - scoreA
  }
  const scopeA = SCOPE_RANK[scope(a.scope)] ?? SCOPE_RANK.UNKNOWN
  const scopeB = SCOPE_RANK[scope(b.scope)] ?? SCOPE_RANK.UNKNOWN
  if (scopeA !== scopeB) return scopeA - scopeB
  const revA = REVERSIBILITY_RANK[reversibility(a.reversibility)]
  const revB = REVERSIBILITY_RANK[reversibility(b.reversibility)]
  if (revA !== revB) return revA - revB
  if (a.evidenceState !== b.evidenceState) {
    const passFirst = { PASS: 0, UNKNOWN: 1, FAIL: 2 }
    return (passFirst[a.evidenceState] ?? 3) - (passFirst[b.evidenceState] ?? 3)
  }
  if (goodness(a, 'execution_cost') !== goodness(b, 'execution_cost')) {
    return goodness(b, 'execution_cost') - goodness(a, 'execution_cost')
  }
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
}

/**
 * Pareto dominance over every dimension that applies to this scenario
 * (方案 §4.4 step 2). A single `UNKNOWN` on either side makes the pair
 * incomparable rather than dominated, so missing evidence cannot eliminate a
 * candidate.
 *
 * @param a - the possibly-dominating candidate.
 * @param b - the other candidate.
 * @param policy - the scenario policy.
 * @returns `true` when `a` is at least as good everywhere and better somewhere.
 */
export function paretoDominates(a, b, policy) {
  const dimensions = [...new Set([...policy.priorities, 'scope'])]
  let strictlyBetter = false
  for (const dimension of dimensions) {
    if (dimension === 'reversibility' && (a.reversibility === 'UNKNOWN' || b.reversibility === 'UNKNOWN')) return false
    if (dimension === 'scope' && (scope(a.scope) === 'UNKNOWN' || scope(b.scope) === 'UNKNOWN')) return false
    const valueA = a.dimensions?.[dimension]
    const valueB = b.dimensions?.[dimension]
    if (dimension !== 'reversibility' && dimension !== 'scope'
      && (rank(valueA) === undefined || rank(valueB) === undefined)) return false
    const scoreA = goodness(a, dimension)
    const scoreB = goodness(b, dimension)
    if (scoreA < scoreB) return false
    if (scoreA > scoreB) strictlyBetter = true
  }
  return strictlyBetter
}

/**
 * The Pareto front of a candidate list, preserving input order.
 *
 * @param candidates - normalized candidates.
 * @param policy - the scenario policy.
 * @returns the non-dominated subset.
 */
export function paretoFront(candidates, policy) {
  return candidates.filter((candidate) => !candidates.some((other) => (
    other !== candidate && paretoDominates(other, candidate, policy)
  )))
}

/**
 * Whether a modification needs explicit approval rather than automatic
 * execution (方案 §4.3, §6.2). Basic authorization is checked separately; this
 * only decides "high impact, the user must choose".
 *
 * 方案 §6.2 rule 2 and T09: a bare model-supplied `approved: true` never counts.
 * The only accepted signal is an explicit `user_decision: "APPROVED"` whose
 * `source` names the user turn it came from; anything else keeps the item in
 * approval, and the trace records the signal as ATTESTED rather than verified
 * (the host exposes no verifiable approval event to a tool body).
 *
 * @param candidate - the normalized candidate.
 * @param policy - the scenario policy.
 * @param authorization - the normalized authorization context.
 * @returns `{ required, reason, attested }`.
 */
export function approvalRequirement(candidate, policy, authorization) {
  const risk = candidate.dimensions?.impact_risk
  const riskRank = rank(risk)
  const threshold = rank(policy.approvalRiskThreshold)

  let highImpact
  if (candidate.approvalRequired === true) {
    highImpact = 'the candidate is flagged as requiring explicit user approval'
  } else if (candidate.irreversibleEffect === true) {
    highImpact = 'the change is irreversible for production data or an external system'
  } else if (candidate.externalEffect === true && riskRank !== undefined && threshold !== undefined && riskRank >= threshold) {
    highImpact = `external action with impact_risk ${risk} at or above the ${policy.id} threshold ${policy.approvalRiskThreshold}`
  } else if (policy.id === 'external_action' && riskRank !== undefined && threshold !== undefined && riskRank >= threshold) {
    highImpact = `the ${policy.id} scenario requires approval at impact_risk ${policy.approvalRiskThreshold} or above`
  }

  if (highImpact === undefined) return { required: false, reason: undefined, attested: false }

  // The user's explicit decision may only be recognised when the caller names
  // the turn it came from. `approved: true` is deliberately not consulted.
  const attested = authorization?.userDecision === 'APPROVED' && authorization.source === 'USER_REPLY'
  if (attested) {
    return {
      required: false,
      attested: true,
      reason: `${highImpact}; the caller attests the user approved it in the same reply (source=USER_REPLY, not host-verifiable)`,
    }
  }
  return { required: true, attested: false, reason: highImpact }
}

/**
 * The scale anomaly signal of 方案 §4.5, now context-dependent: only a scenario
 * that declared a limit applies one, and the reason travels with it.
 *
 * @param candidate - the normalized candidate.
 * @param policy - the scenario policy.
 * @returns `{ excessive, limit, value, reason }`.
 */
export function scaleVerdict(candidate, policy) {
  const limit = policy.scaleLimit
  const value = candidate.scale
  if (limit === undefined || value === undefined) {
    return { excessive: false, limit: undefined, value, reason: undefined }
  }
  if (candidate.scaleUnit !== undefined && candidate.scaleUnit !== limit.unit) {
    // A percentage in a data/budget metric is a different unit of meaning than a
    // UI size step; 方案 §4.5 forbids reusing the button rule there.
    return { excessive: false, limit: limit.maxPercent, value, reason: undefined }
  }
  return {
    excessive: value > limit.maxPercent,
    limit: limit.maxPercent,
    value,
    reason: limit.reason,
  }
}

/** @returns the number of levels by which `a` is better than `b` on a dimension. */
export function levelGain(a, b, dimension) {
  return goodness(a, dimension) - goodness(b, dimension)
}

/** Re-exported so callers can branch on a gate token without importing both modules. */
export { GATE, LEVEL }
