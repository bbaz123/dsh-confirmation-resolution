/**
 * V2 decision core: the context-aware multi-goal engine of 方案 §3–§6.
 *
 * The pipeline is deliberately explicit and ordered (方案 §3.1):
 *
 *   作用域校验 → 硬约束过滤 → 证据可信性 → 多维比较 → 必要审批 → 结果生成
 *
 * V1 (`lib/decide.js`) is untouched and keeps its own contract. This module is a
 * pure function set: no I/O, no timers, no host calls, no ledger writes. The
 * session ledger and the tool schema live in `lib/index.js` / `lib/ledger.js`,
 * so the whole judgement stays reproducible by unit tests.
 *
 * The three properties that make it different from V1:
 *
 *   1. `KEEP_CURRENT` is a real candidate that others must beat, not a fallback;
 *   2. critical gates are three-valued, so an unverified gate is `UNKNOWN` and
 *      blocks automatic action instead of defaulting to "fine";
 *   3. the outcome vocabulary separates "decided to modify" from "the user must
 *      choose" (`REQUEST_APPROVAL`) and from "your request cannot be accepted"
 *      (`REJECT`).
 *
 * @module dsh-plugin-confirmation-resolution/decision-v2
 */

import {
  EVIDENCE_CODE,
  GATE,
  LEVEL,
  gate,
  gap as evidenceGap,
  level,
  rank as levelRank,
  worstGate,
} from './evidence.js'
import {
  DIMENSIONS,
  KIND,
  POLICY_VERSION,
  REASON,
  SCOPE_ORDER,
  approvalRequirement,
  compareCandidates,
  goodness,
  paretoFront,
  resolveScenario,
  reversibility as normalizeReversibility,
  scaleVerdict,
  scope as normalizeScope,
} from './policies.js'
import { buildTrace, describeCandidate, gapEntry, rejection } from './trace.js'

/** The V2 contract version carried in every request and response. */
export const SCHEMA_VERSION = '2.0'

/**
 * V2 outcomes. `REGISTERED` and `NOT_APPLICABLE` are LEDGER outcomes (a
 * successful ledger write, a refused call), not decision outcomes: 方案 §4.6
 * lists the five decision outcomes, and the guard vocabulary is kept separate so
 * the two can never be confused.
 */
export const OUTCOME = Object.freeze({
  MODIFY: 'MODIFY',
  KEEP_CURRENT: 'KEEP_CURRENT',
  REQUEST_APPROVAL: 'REQUEST_APPROVAL',
  INSUFFICIENT_CONTEXT: 'INSUFFICIENT_CONTEXT',
  REJECT: 'REJECT',
  REGISTERED: 'REGISTERED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
})

/** Lifecycle states of one confirmation item under V2 (方案 §6.2). */
export const LIFECYCLE = Object.freeze({
  READY_TO_EXECUTE: 'READY_TO_EXECUTE',
  AWAITING_EXECUTION: 'AWAITING_EXECUTION',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  PENDING: 'PENDING',
  RESOLVED: 'RESOLVED',
  UNCHANGED: 'UNCHANGED',
})

/** Stable gap codes for `missing_information`. */
export const V2_MISSING = Object.freeze({
  REQUIRED_FIELD: 'REQUIRED_FIELD_EMPTY_AND_NOT_DERIVABLE',
  SCHEMA_VERSION: 'SCHEMA_VERSION_MISMATCH',
  NO_CANDIDATES: 'NO_FEASIBLE_SOLUTION_CANDIDATE',
  NO_ALTERNATIVE: 'NO_ALTERNATIVE_TO_THE_USERS_OWN_OPTION',
  GOAL_REQUIRED: 'USER_GOAL_REQUIRED_FOR_MODIFY',
  CRITICAL_UNKNOWN: 'CRITICAL_EVIDENCE_UNKNOWN',
  AUTHORIZATION_UNVERIFIED: 'AUTHORIZATION_SCOPE_UNVERIFIED',
  CONFLICT: 'CONFLICTING_EVIDENCE',
})

/**
 * The gates whose missing evidence blocks automatic execution (方案 §4.2/§4.3).
 * They are critical because each one decides PERMISSION, not preference.
 */
export const CRITICAL_GATES = Object.freeze([
  'solves_user_problem',
  'within_permitted_scope',
  'violates_no_constraint',
  'authorization',
  'safety',
])

/** Dimensions that must carry real evidence before a candidate may be executed. */
export const CRITICAL_DIMENSIONS = Object.freeze(['goal_fit', 'impact_risk'])

const GATE_SPECS = Object.freeze([
  Object.freeze(['solves_user_problem', REASON.HARD_CONSTRAINT_BLOCKED, 'does not solve the real user problem']),
  Object.freeze(['violates_no_constraint', REASON.HARD_CONSTRAINT_BLOCKED, 'violates a user-stated hard constraint']),
  Object.freeze(['within_permitted_scope', REASON.SCOPE_EXCEEDS_PERMITTED, 'exceeds the permitted execution scope']),
  Object.freeze(['authorization', REASON.AUTHORIZATION_MISSING, 'there is no verified authorisation for this change']),
  Object.freeze(['safety', REASON.HARD_CONSTRAINT_BLOCKED, 'carries an unacceptable safety, privacy or over-reach risk']),
])

/** Accepted `goal_source` values (方案 §4.1: stated and inferred never mix). */
export const GOAL_SOURCE = Object.freeze({ USER_STATED: 'USER_STATED', DSH_INFERRED: 'DSH_INFERRED' })

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function list(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
  const single = text(value)
  return single === '' ? [] : [single]
}

/** Invert a boolean gate ("constraints respected" from "violates_constraints"). */
function invert(value) {
  if (value === GATE.PASS) return GATE.FAIL
  if (value === GATE.FAIL) return GATE.PASS
  return GATE.UNKNOWN
}

/** Use the explicit gate when the caller gave one, otherwise the attested level. */
function gateOr(explicit, fallback) {
  const value = gate(explicit)
  return value === GATE.UNKNOWN ? fallback : value
}

/** Largest percentage found in free text — used only when the caller gave no `scale`. */
function scaleFromText(value) {
  if (typeof value !== 'string') return undefined
  let worst
  const pattern = /(\d+(?:\.\d+)?)\s*%/g
  let match = pattern.exec(value)
  while (match !== null) {
    const number = Number(match[1])
    if (Number.isFinite(number) && (worst === undefined || number > worst)) worst = number
    match = pattern.exec(value)
  }
  return worst
}

/** Normalize the caller's authorization context (方案 §4.1 `authorization_context`). */
export function normalizeAuthorization(raw) {
  const record = object(raw)
  return {
    verification: gate(record.verification ?? record.evidence_state ?? record.authorized),
    permittedScope: normalizeScope(record.permitted_scope ?? record.scope),
    source: text(record.source).toUpperCase() || 'UNSPECIFIED',
    // Only the exact token counts; a boolean `approved: true` is never consulted
    // (方案 §6.2 rule 2 / T09).
    userDecision: text(record.user_decision).toUpperCase() === 'APPROVED' ? 'APPROVED' : 'UNSPECIFIED',
  }
}

/**
 * Normalize one candidate. Absence of evidence stays `UNKNOWN`; an explicit
 * `evidence_state` attests the standard gate set, and any explicit gate field
 * overrides it (方案 §4.1, §5.1).
 */
export function normalizeCandidate(raw, index, authorization = undefined) {
  const record = object(raw)
  const id = text(record.id) || text(record.label) || `candidate-${index + 1}`
  const kindToken = text(record.kind ?? record.type).toUpperCase()
  const kind = kindToken === KIND.KEEP_CURRENT || kindToken === 'KEEP' ? KIND.KEEP_CURRENT : KIND.MODIFY
  // A KEEP_CURRENT baseline is neutral BY DEFINITION: not changing anything adds
  // no quality loss, no risk and no cost, and it cannot violate a scope or a
  // constraint. Those defaults are definitional, not optimistic inferences about
  // a proposed change, so they are only applied to a `KEEP_CURRENT` candidate.
  const declaredEvidence = gate(record.evidence_state ?? record.gate_evidence)
  const evidenceState = kind === KIND.KEEP_CURRENT && declaredEvidence === GATE.UNKNOWN ? GATE.PASS : declaredEvidence
  const dimensions = {}
  for (const dimension of DIMENSIONS) {
    const parsed = level(record[dimension] ?? object(record.dimensions)[dimension])
    dimensions[dimension] = kind === KIND.KEEP_CURRENT && parsed === LEVEL.UNKNOWN ? LEVEL.NONE : parsed
  }
  const declaredReversibility = normalizeReversibility(record.reversibility)
  const declaredScope = normalizeScope(record.scope)
  const approach = text(record.approach)
  const unit = text(record.scale_unit ?? record.unit)
  const explicitScale = typeof record.scale === 'number' && Number.isFinite(record.scale)
    ? record.scale
    : (typeof record.percentage === 'number' && Number.isFinite(record.percentage) ? record.percentage : undefined)
  const parsedScale = explicitScale === undefined ? scaleFromText(approach) : explicitScale
  const candidateScope = declaredScope
  // The call-level authorization may declare the permitted scope once for every
  // candidate; a candidate-level value wins when both are present.
  const permitted = record.authorization_scope ?? record.permitted_scope ?? authorization?.permittedScope
  const permittedScope = normalizeScope(permitted)

  const withinScope = gateOr(record.within_permitted_scope, evidenceState)
  const coverage = permittedScope === 'UNKNOWN'
    ? GATE.PASS // nothing was declared to compare against, so there is nothing to exceed
    : (candidateScope !== 'UNKNOWN' && SCOPE_ORDER.indexOf(candidateScope) <= SCOPE_ORDER.indexOf(permittedScope) ? GATE.PASS : GATE.FAIL)

  return {
    id,
    kind,
    approach,
    // Scope and reversibility have the same definitional defaults for a
    // KEEP_CURRENT candidate: doing nothing touches nothing and can always be
    // undone, so an unstated value is not an evidence gap on the baseline.
    scope: kind === KIND.KEEP_CURRENT && candidateScope === 'UNKNOWN' ? 'NONE' : candidateScope,
    reversibility: kind === KIND.KEEP_CURRENT && declaredReversibility === 'UNKNOWN'
      ? 'reversible'
      : declaredReversibility,
    dimensions,
    evidenceState,
    /** Values the caller explicitly stated, so the trace can tell them apart. */
    stated: new Set(DIMENSIONS.filter((dimension) => levelRank(dimensions[dimension]) !== undefined)),
    userProposed: record.user_proposed === true,
    expandsBeyondNecessity: record.expands_beyond_necessity === true,
    addressesRootCause: record.addresses_root_cause === true
      ? true
      : (record.addresses_root_cause === false ? false : undefined),
    externalEffect: record.external_effect === true,
    irreversibleEffect: record.irreversible_effect === true,
    approvalRequired: record.approval_required === true,
    scaleVerified: record.scale_verified === true,
    constraintsViolated: list(record.constraints_violated),
    scale: parsedScale,
    scaleUnit: unit === '' ? (parsedScale === undefined ? undefined : '%') : unit,
    gates: {
      solves_user_problem: gateOr(record.solves_user_problem, evidenceState),
      // `violates_constraints` is the inverted name of this gate, so it must not
      // be pushed through `gateOr` (whose fallback is the non-inverted attestation).
      violates_no_constraint: record.violates_constraints === undefined || record.violates_constraints === null
        ? evidenceState
        : invert(gate(record.violates_constraints)),
      within_permitted_scope: worstGate(withinScope, coverage),
      // Basic permission is checked separately from approval and can never be
      // replaced by it (方案 §4.3 step 3). It falls back to the call-level
      // authorization context; absent that it stays UNKNOWN and blocks.
      authorization: gateOr(record.authorization, authorization?.verification ?? GATE.UNKNOWN),
      safety: gateOr(record.safety, evidenceState),
    },
    approval: { required: false, attested: false, reason: undefined },
    unknownGates: [],
  }
}

/** Build the KEEP_CURRENT baseline the caller may omit (方案 §7 "构造基线"). */
export function buildBaseline(context) {
  const record = object(context)
  const dimensions = {}
  for (const dimension of DIMENSIONS) dimensions[dimension] = level(object(record.baseline)[dimension])
  return {
    id: text(record.baseline_id) || 'KEEP_CURRENT',
    kind: KIND.KEEP_CURRENT,
    approach: 'keep the current state unchanged',
    scope: 'NONE',
    reversibility: 'reversible',
    dimensions,
    evidenceState: GATE.PASS,
    stated: new Set(),
    userProposed: false,
    expandsBeyondNecessity: false,
    addressesRootCause: undefined,
    externalEffect: false,
    irreversibleEffect: false,
    approvalRequired: false,
    scaleVerified: false,
    constraintsViolated: [],
    scale: undefined,
    scaleUnit: undefined,
    gates: {
      solves_user_problem: GATE.PASS,
      violates_no_constraint: GATE.PASS,
      within_permitted_scope: GATE.PASS,
      authorization: GATE.PASS,
      safety: GATE.PASS,
    },
    approval: { required: false, attested: false, reason: undefined },
    unknownGates: [],
  }
}

/**
 * Evaluate the hard gates of one modification candidate (方案 §4.3 steps 1–6).
 *
 * @param candidate - normalized candidate.
 * @param policy - scenario policy.
 * @returns `{ failures, unknown }`, each a list of `{ code, message }`.
 */
export function evaluateHardGates(candidate, policy) {
  const failures = []
  const unknown = []
  for (const [name, code, message] of GATE_SPECS) {
    const value = candidate.gates[name]
    if (value === GATE.FAIL) failures.push({ code, message })
    else if (value === GATE.UNKNOWN) unknown.push({ code, message })
  }
  // Two dimensions are load-bearing for every scenario: without a goal-fit
  // judgement there is nothing to compare, and without a risk judgement the
  // change cannot be called safe. Both stay UNKNOWN rather than defaulting.
  for (const dimension of CRITICAL_DIMENSIONS) {
    if (levelRank(candidate.dimensions[dimension]) === undefined) {
      unknown.push({ code: EVIDENCE_CODE.UNKNOWN_CRITICAL, message: `${dimension} was not assessed for this candidate` })
    }
  }
  if (candidate.expandsBeyondNecessity === true) {
    failures.push({ code: REASON.SCOPE_EXCEEDS_PERMITTED, message: 'expands the modification beyond necessity' })
  }
  const scale = scaleVerdict(candidate, policy)
  if (scale.excessive && candidate.scaleVerified !== true) {
    failures.push({
      code: REASON.SCALE_EXCESSIVE,
      message: `magnitude ${scale.value}${candidate.scaleUnit ?? ''} exceeds the ${policy.id} anomaly limit ${scale.limit}${scale.limit === undefined ? '' : (candidate.scaleUnit ?? '')}`,
    })
  }
  return { failures, unknown, scale }
}

/**
 * 方案 §4.4 step 6: "如果最优修改的净收益不足以覆盖改变成本，可以选择
 * KEEP_CURRENT 并说明原因."
 */
const BENEFIT_DIMENSIONS = Object.freeze(['goal_fit', 'user_value', 'output_quality', 'long_term_value'])

export function netBenefit(winner, baseline, policy) {
  // A benefit that carries no evidence cannot be judged at all, so it is not
  // silently treated as "no benefit": the caller must supply the evidence.
  const usable = BENEFIT_DIMENSIONS.filter((dimension) => levelRank(winner.dimensions[dimension]) !== undefined)
  if (usable.length === 0) {
    return {
      worth: false,
      judgeable: false,
      code: REASON.CRITICAL_UNKNOWN,
      detail: 'no benefit dimension carries usable evidence, so the change cannot be judged',
    }
  }
  let bestGain = 0
  let improvesTarget = false
  for (const dimension of policy.priorities) {
    const gain = goodness(winner, dimension) - goodness(baseline, dimension)
    if (gain > bestGain) bestGain = gain
    if (gain > 0 && BENEFIT_DIMENSIONS.includes(dimension)) improvesTarget = true
  }
  if (!improvesTarget) {
    return {
      worth: false,
      judgeable: true,
      code: REASON.NO_MEASURABLE_BENEFIT,
      detail: 'the proposed change improves no benefit dimension over the current state',
    }
  }
  if (winner.dimensions.execution_cost === LEVEL.HIGH && bestGain <= 1) {
    return {
      worth: false,
      judgeable: true,
      code: REASON.COST_EXCEEDS_MARGINAL_BENEFIT,
      detail: 'the change costs a lot while improving its best dimension by only one level',
    }
  }
  return { worth: true, judgeable: true, code: undefined, detail: undefined }
}

/**
 * Does `a` already dominate `b` on every dimension BOTH of them measured?
 *
 * Used only to decide whether an undecidable candidate has to interrupt the
 * flow. A dimension either side left unknown is skipped rather than treated as
 * a win or a loss, so missing evidence never silently eliminates a candidate.
 *
 * @param a - the decidable candidate.
 * @param b - the blocked candidate.
 * @param policy - scenario policy.
 * @returns `true` when `a` is at least as good on every shared dimension and
 *          strictly better on one.
 */
export function dominatesOnKnownEvidence(a, b, policy) {
  const dimensions = [...new Set([...policy.priorities, 'scope'])]
  let strictlyBetter = false
  for (const dimension of dimensions) {
    if (dimension === 'reversibility' && (normalizeReversibility(a.reversibility) === 'UNKNOWN' || normalizeReversibility(b.reversibility) === 'UNKNOWN')) continue
    if (dimension === 'scope' && (normalizeScope(a.scope) === 'UNKNOWN' || normalizeScope(b.scope) === 'UNKNOWN')) continue
    if (dimension !== 'reversibility' && dimension !== 'scope'
      && (levelRank(a.dimensions[dimension]) === undefined || levelRank(b.dimensions[dimension]) === undefined)) continue
    const scoreA = goodness(a, dimension)
    const scoreB = goodness(b, dimension)
    if (scoreA < scoreB) return false
    if (scoreA > scoreB) strictlyBetter = true
  }
  return strictlyBetter
}

/**
 * Sensitivity check (方案 §4.4 step 4): if two candidates differ on exactly one
 * priority dimension by exactly one level and carry the same scope and
 * reversibility, a small evidence shift flips the ranking. When the stakes are
 * not negligible the trade-off is surfaced for confirmation instead of being
 * decided silently.
 */
export function checkSensitivity(ranked, policy) {
  const [winner, runnerUp] = ranked
  if (winner === undefined || runnerUp === undefined) {
    return { checked: true, near_tie: false, stable: true, flips: [], high_stakes: false }
  }
  const differing = []
  for (const dimension of policy.priorities) {
    const gap = goodness(winner, dimension) - goodness(runnerUp, dimension)
    if (gap !== 0) differing.push({ dimension, gap })
  }
  const sameScope = normalizeScope(winner.scope) === normalizeScope(runnerUp.scope)
  const sameReversibility = normalizeReversibility(winner.reversibility) === normalizeReversibility(runnerUp.reversibility)
  const nearTie = differing.length === 1 && Math.abs(differing[0].gap) === 1 && sameScope && sameReversibility
  const highStakes = [winner, runnerUp].some((candidate) => (levelRank(candidate.dimensions.impact_risk) ?? -1) >= 2)
  return {
    checked: true,
    near_tie: nearTie,
    stable: !(nearTie && highStakes),
    flips: nearTie ? [differing[0].dimension] : [],
    high_stakes: highStakes,
  }
}

/** Compose the reason codes that explain one selected modification. */
function modifyReasonCodes(candidate, baseline, policy, sure) {
  const codes = []
  if (candidate.userProposed) codes.push(REASON.USER_PROPOSED_SOLUTION_SELECTED)
  if (goodness(candidate, 'goal_fit') > goodness(baseline, 'goal_fit')) codes.push(REASON.GOAL_FIT_IMPROVED)
  if (goodness(candidate, 'user_value') > goodness(baseline, 'user_value')) codes.push(REASON.USER_VALUE_IMPROVED)
  if (goodness(candidate, 'output_quality') > goodness(baseline, 'output_quality')) codes.push(REASON.QUALITY_IMPROVED)
  else codes.push(REASON.QUALITY_PRESERVED)
  if (goodness(candidate, 'impact_risk') >= goodness(baseline, 'impact_risk')) codes.push(REASON.RISK_ACCEPTABLE)
  if (normalizeReversibility(candidate.reversibility) === 'reversible') codes.push(REASON.REVERSIBLE)
  else if (candidate.irreversibleEffect === true) codes.push(REASON.IRREVERSIBLE_BUT_AUTHORISED)
  const scopeIndex = (entry) => {
    const index = SCOPE_ORDER.indexOf(normalizeScope(entry.scope))
    return index === -1 ? SCOPE_ORDER.length : index
  }
  const narrowest = sure.filter((entry) => entry.kind === KIND.MODIFY)
    .every((entry) => scopeIndex(entry) >= scopeIndex(candidate))
  if (narrowest) codes.push(REASON.MINIMUM_SCOPE)
  if (levelRank(candidate.dimensions.execution_cost) !== undefined && levelRank(candidate.dimensions.execution_cost) <= 1) {
    codes.push(REASON.COST_REASONABLE)
  }
  if (policy.id === 'ui_preference' && goodness(candidate, 'user_value') > goodness(baseline, 'user_value')) {
    codes.push(REASON.USER_PREFERENCE_HONOURED)
  }
  if (candidate.approval.attested === true) codes.push(REASON.APPROVAL_ATTESTED)
  return codes
}

/** Assemble the response envelope every V2 result shares. */
function envelope(parts) {
  return {
    schema_version: SCHEMA_VERSION,
    confirmation_id: parts.id,
    outcome: parts.outcome,
    lifecycle_status: parts.lifecycle,
    selected_solution_id: parts.selectedId ?? null,
    selected_solution: parts.selectedSolution ?? null,
    approval_required: parts.approvalRequired === true,
    approval_question: parts.approvalQuestion ?? null,
    execution_scope: parts.executionScope ?? null,
    do_not_change: parts.doNotChange ?? [],
    executable: parts.executable === true,
    reason_codes: parts.reasonCodes ?? [],
    missing_information: parts.missingInformation ?? [],
    rejected_candidates: parts.rejectedCandidates ?? [],
    decision_revision: Number.isInteger(parts.decisionRevision) ? parts.decisionRevision : 0,
    decision_trace: parts.trace ?? null,
    notes: parts.notes ?? [],
  }
}

/**
 * Run the V2 decision for exactly one confirmation item.
 *
 * @param input - the V2 tool arguments (方案 §5.1).
 * @returns the complete, contract-shaped V2 decision value.
 */
export function decideV2(input) {
  const raw = object(input)
  const id = text(raw.confirmation_id)
  const currentState = text(raw.current_state)
  const originalConfirmation = text(raw.original_confirmation)
  const userReply = text(raw.user_reply)
  const context = object(raw.context)
  const policy = resolveScenario(context.scenario)
  const goal = text(context.user_goal)
  const goalSource = text(context.goal_source).toUpperCase() === GOAL_SOURCE.USER_STATED
    ? GOAL_SOURCE.USER_STATED
    : GOAL_SOURCE.DSH_INFERRED
  const constraints = list(context.constraints)
  const authorization = normalizeAuthorization(raw.authorization)
  const declaredScenario = text(context.scenario)
  const revision = Number.isInteger(raw.decision_revision) ? raw.decision_revision : 0

  const gaps = []
  for (const [field, value] of [
    ['confirmation_id', id],
    ['current_state', currentState],
    ['original_confirmation', originalConfirmation],
    ['user_reply', userReply],
  ]) {
    if (value === '') gaps.push({ field, code: V2_MISSING.REQUIRED_FIELD, detail: `${field} is required for a V2 decision` })
  }
  const declaredVersion = text(raw.schema_version)
  if (declaredVersion !== '' && declaredVersion !== SCHEMA_VERSION) {
    gaps.push({
      field: 'schema_version',
      code: V2_MISSING.SCHEMA_VERSION,
      detail: `expected schema_version ${SCHEMA_VERSION}, received ${declaredVersion}`,
    })
  }

  const conflicts = []
  const doNotChange = [...new Set([
    ...constraints,
    ...list(context.do_not_change),
  ])]

  if (gaps.length > 0) {
    return envelope({
      id, outcome: OUTCOME.INSUFFICIENT_CONTEXT, lifecycle: LIFECYCLE.PENDING,
      reasonCodes: [V2_MISSING.REQUIRED_FIELD], missingInformation: gaps.map(describeGap),
      doNotChange, decisionRevision: revision,
      trace: buildTrace({
        policyVersion: POLICY_VERSION, scenario: policy.id, goalSource, baselineId: null,
        gaps, conflicts, steps: ['input validation failed'],
      }),
      notes: ['Nothing was decided. Supply the missing identity fields and call again.'],
    })
  }

  const rawCandidates = Array.isArray(raw.candidates)
    ? raw.candidates
    : (Array.isArray(raw.candidate_solutions) ? raw.candidate_solutions : [])
  const supplied = rawCandidates.map((entry, index) => normalizeCandidate(entry, index, authorization))
  const suppliedModify = supplied.filter((candidate) => candidate.kind === KIND.MODIFY)
  const suppliedKeep = supplied.filter((candidate) => candidate.kind === KIND.KEEP_CURRENT)

  if (supplied.length === 0) {
    return envelope({
      id, outcome: OUTCOME.INSUFFICIENT_CONTEXT, lifecycle: LIFECYCLE.PENDING,
      reasonCodes: [REASON.NO_CANDIDATES],
      missingInformation: [`candidates: ${V2_MISSING.NO_CANDIDATES} — no candidate was supplied, and this plugin never invents one`],
      doNotChange, decisionRevision: revision,
      trace: buildTrace({
        policyVersion: POLICY_VERSION, scenario: policy.id, goalSource, baselineId: 'KEEP_CURRENT',
        constructedBaseline: true, gaps: [{ field: 'candidates', code: V2_MISSING.NO_CANDIDATES }], conflicts,
        steps: ['no candidates supplied'],
      }),
      notes: ['Supply at least the current state as a KEEP_CURRENT candidate, plus the alternatives to compare.'],
    })
  }

  // A baseline may be supplied or constructed; 方案 §7 makes constructing it the
  // core's job, so a caller that only lists modifications still gets a fair
  // "do nothing" comparison instead of an automatic win for changing things.
  const constructedBaseline = suppliedKeep.length === 0
  const baseline = constructedBaseline ? buildBaseline(context) : suppliedKeep[0]

  if (suppliedModify.length === 0) {
    const reasonCodes = [REASON.KEEP_CURRENT_OPTIMAL]
    if (constructedBaseline) reasonCodes.push(REASON.BASELINE_CONSTRUCTED)
    return envelope({
      id, outcome: OUTCOME.KEEP_CURRENT, lifecycle: LIFECYCLE.RESOLVED,
      selectedId: baseline.id, selectedSolution: baseline.approach,
      executionScope: 'NONE', doNotChange, reasonCodes,
      decisionRevision: revision,
      trace: buildTrace({
        policyVersion: POLICY_VERSION, scenario: policy.id, goalSource, baselineId: baseline.id,
        constructedBaseline, ranking: [describeCandidate(baseline)], selectedId: baseline.id,
        steps: ['no modification candidate was supplied; the caller asked to keep the current state'],
      }),
      notes: ['The caller supplied no modification candidate, so the current state stands. Nothing has to be executed.'],
    })
  }

  // ── 硬约束过滤 ────────────────────────────────────────────────────────────
  const hardRejected = []
  const survivors = [...suppliedKeep]
  const scaleNotes = []
  for (const candidate of suppliedModify) {
    const verdict = evaluateHardGates(candidate, policy)
    if (verdict.scale.excessive && candidate.scaleVerified === true) {
      scaleNotes.push(`${candidate.id}: magnitude ${verdict.scale.value} exceeded the ${policy.id} anomaly limit but was explicitly verified as safe`)
    }
    if (verdict.failures.length > 0) {
      hardRejected.push({
        candidate,
        failures: verdict.failures,
        entry: rejection(candidate.id, verdict.failures[0].code, verdict.failures.map((failure) => failure.message).join('; ')),
      })
    } else {
      candidate.unknownGates = verdict.unknown
      survivors.push(candidate)
    }
  }
  if (constructedBaseline) survivors.push(baseline)

  // Root-cause rule: an alternative that keeps the existing quality loss is only
  // eliminated when a strictly better option is actually available (02 §6 / 03 §10).
  for (let index = survivors.length - 1; index >= 0; index -= 1) {
    const candidate = survivors[index]
    if (candidate.kind !== KIND.MODIFY || candidate.addressesRootCause !== false) continue
    const better = survivors.some((other) => other !== candidate
      && other.kind === KIND.MODIFY
      && goodness(other, 'output_quality') > goodness(candidate, 'output_quality'))
    if (!better) continue
    survivors.splice(index, 1)
    hardRejected.push({
      candidate,
      failures: [{ code: REASON.ROOT_CAUSE_UNRESOLVED, message: 'leaves the root cause in place while a better alternative exists' }],
      entry: rejection(candidate.id, REASON.ROOT_CAUSE_UNRESOLVED, 'leaves the root cause in place while a better alternative exists'),
    })
  }

  for (const candidate of survivors) {
    if (candidate.kind !== KIND.MODIFY) continue
    candidate.approval = approvalRequirement(candidate, policy, authorization)
  }

  const sure = survivors.filter((candidate) => candidate.kind === KIND.KEEP_CURRENT
    || (candidate.unknownGates.length === 0 && candidate.approval.required !== true))
  const blocked = survivors.filter((candidate) => candidate.kind === KIND.MODIFY
    && (candidate.unknownGates.length > 0 || candidate.approval.required === true))

  const rankedSure = [...sure].sort((a, b) => compareCandidates(a, b, policy))
  const rankedBlocked = [...blocked].sort((a, b) => compareCandidates(a, b, policy))
  const bestSure = rankedSure[0]
  const bestBlocked = rankedBlocked[0]

  const rejectedCandidates = hardRejected.map((entry) => entry.entry)
  const traceBase = {
    policyVersion: POLICY_VERSION,
    scenario: policy.id,
    goalSource,
    baselineId: baseline.id,
    constructedBaseline,
    hardGateResults: hardRejected.map((entry) => ({ id: entry.candidate.id, failures: entry.failures.map((failure) => failure.code) })),
    ranking: rankedSure.concat(rankedBlocked).map(describeCandidate),
    gaps,
    conflicts,
    steps: [],
  }
  if (declaredScenario !== '' && policy.id !== declaredScenario.trim().toLowerCase().replace(/[\s-]+/g, '_')) {
    traceBase.steps.push(`scenario "${declaredScenario}" is not declared; the generic policy was used`)
  }
  if (scaleNotes.length > 0) traceBase.steps.push(...scaleNotes)

  // ── 全部修改候选都被硬门禁淘汰 → REJECT（方案 §4.6，T16） ────────────────
  // "不能接受这个请求" 与 "保持现状已经满足目标" 是两件事，不能用 KEEP_CURRENT
  // 把被拒绝的请求伪装成已完成的目标。
  const survivingModify = survivors.filter((candidate) => candidate.kind === KIND.MODIFY)
  if (survivingModify.length === 0) {
    const onlyUserOption = suppliedModify.every((candidate) => candidate.userProposed)
    const reasonCodes = [REASON.REJECTED_ALL_CANDIDATES]
    if (onlyUserOption) reasonCodes.push(REASON.NO_ALTERNATIVE)
    return envelope({
      id, outcome: OUTCOME.REJECT, lifecycle: LIFECYCLE.PENDING,
      reasonCodes,
      missingInformation: [],
      rejectedCandidates, doNotChange, decisionRevision: revision,
      trace: buildTrace({
        ...traceBase,
        selectedId: null,
        steps: [...traceBase.steps, 'every modification candidate was eliminated by a hard gate'],
      }),
      notes: [
        'The request cannot be accepted as given: every candidate violated a hard gate. This is NOT "keep the current state".',
        onlyUserOption
          ? 'Supply a genuinely different alternative, or ask the user to reconsider the constraint the request breaks.'
          : 'Nothing executable remains; explain the blocking gate to the user and ask how to proceed.',
      ],
    })
  }

  // ── 被阻塞的候选优先：一个可能更优但证据/审批未决的方案不能被静默跳过 ──────
  if (bestBlocked !== undefined) {
    // 但如果这个候选即便证据齐全也不值得改，就不该为它去索取证据或审批：
    // "不做" 不需要权限，也不需要审批。
    const blockedBenefit = netBenefit(bestBlocked, baseline, policy)
    if (blockedBenefit.judgeable && !blockedBenefit.worth) {
      return envelope({
        id, outcome: OUTCOME.KEEP_CURRENT, lifecycle: LIFECYCLE.RESOLVED,
        selectedId: baseline.id, selectedSolution: baseline.approach,
        executionScope: 'NONE', doNotChange,
        reasonCodes: [blockedBenefit.code],
        rejectedCandidates, decisionRevision: revision,
        trace: buildTrace({
          ...traceBase, selectedId: baseline.id,
          steps: [...traceBase.steps, blockedBenefit.detail],
        }),
        notes: ['No change is worth making here, so no extra evidence or approval is requested.'],
      })
    }
    // A candidate that cannot be judged at all still has to interrupt: its
    // missing evidence could overturn the decidable winner. Otherwise the
    // interruption only happens when the decidable winner does not already
    // dominate the blocked candidate on every dimension both of them measured.
    const canWait = blockedBenefit.judgeable && dominatesOnKnownEvidence(bestSure, bestBlocked, policy)
    if (!canWait) {
    const unknown = bestBlocked.unknownGates.length > 0
    const missingInformation = unknown
      ? bestBlocked.unknownGates.map((entry) => `${bestBlocked.id}.${entry.code}: ${entry.message}`)
      : []
    return envelope({
      id,
      outcome: unknown ? OUTCOME.INSUFFICIENT_CONTEXT : OUTCOME.REQUEST_APPROVAL,
      lifecycle: unknown ? LIFECYCLE.PENDING : LIFECYCLE.AWAITING_APPROVAL,
      approvalRequired: !unknown,
      approvalQuestion: unknown ? null : approvalQuestion(bestBlocked, rankedSure, policy),
      reasonCodes: unknown
        ? [REASON.CRITICAL_UNKNOWN, ...(bestBlocked.unknownGates.map((entry) => entry.code))]
        : [REASON.APPROVAL_REQUIRED],
      missingInformation,
      rejectedCandidates,
      doNotChange,
      decisionRevision: revision,
      trace: buildTrace({
        ...traceBase,
        approvals: [{ id: bestBlocked.id, required: !unknown, reason: bestBlocked.approval.reason ?? bestBlocked.unknownGates.map((entry) => entry.message).join('; ') }],
        selectedId: null,
        steps: [...traceBase.steps, unknown
          ? `${bestBlocked.id} outranks every decidable candidate but its critical evidence is UNKNOWN`
          : `${bestBlocked.id} outranks every decidable candidate but needs explicit approval`],
      }),
      notes: unknown
        ? ['UNKNOWN is not PASS: collect the listed evidence and call again. Nothing may be executed yet.']
        : ['This is an approval suggestion, not an execution authorisation. Ask the user; a later decide call must carry the outcome.'],
    })
    }
  }

  // ── 与 KEEP_CURRENT 基线比较 ─────────────────────────────────────────────
  if (bestSure.kind === KIND.KEEP_CURRENT) {
    const dominated = sure.filter((candidate) => candidate.kind === KIND.MODIFY)
    return envelope({
      id, outcome: OUTCOME.KEEP_CURRENT, lifecycle: LIFECYCLE.RESOLVED,
      selectedId: bestSure.id, selectedSolution: bestSure.approach,
      executionScope: 'NONE', doNotChange,
      reasonCodes: [REASON.KEEP_CURRENT_OPTIMAL, ...(constructedBaseline ? [REASON.BASELINE_CONSTRUCTED] : [])],
      rejectedCandidates: rejectedCandidates.concat(dominated.map((candidate) => rejection(candidate.id, REASON.PARETO_ELIMINATED, 'ranks below keeping the current state under this scenario policy'))),
      decisionRevision: revision,
      trace: buildTrace({
        ...traceBase, selectedId: bestSure.id,
        paretoFront: paretoFront(dominated, policy).map((candidate) => candidate.id),
        steps: [...traceBase.steps, 'keeping the current state outranks every decidable modification'],
      }),
      notes: ['No change is worth making here. The item is closed as RESOLVED; nothing is executed.'],
    })
  }

  // ── 最优修改是否值得做（方案 §4.4 step 6） ────────────────────────────────
  const benefit = netBenefit(bestSure, baseline, policy)
  if (!benefit.worth && !benefit.judgeable) {
    return envelope({
      id, outcome: OUTCOME.INSUFFICIENT_CONTEXT, lifecycle: LIFECYCLE.PENDING,
      reasonCodes: [REASON.CRITICAL_UNKNOWN],
      missingInformation: [`candidates.${bestSure.id}: ${REASON.CRITICAL_UNKNOWN} — ${benefit.detail}`],
      rejectedCandidates, doNotChange, decisionRevision: revision,
      trace: buildTrace({ ...traceBase, selectedId: null, steps: [...traceBase.steps, benefit.detail] }),
      notes: ['UNKNOWN is not NONE: supply the benefit evidence (goal_fit / user_value / output_quality) and call again.'],
    })
  }
  if (!benefit.worth) {
    return envelope({
      id, outcome: OUTCOME.KEEP_CURRENT, lifecycle: LIFECYCLE.RESOLVED,
      selectedId: baseline.id, selectedSolution: baseline.approach,
      executionScope: 'NONE', doNotChange,
      reasonCodes: [benefit.code],
      rejectedCandidates,
      decisionRevision: revision,
      trace: buildTrace({
        ...traceBase, selectedId: baseline.id,
        steps: [...traceBase.steps, benefit.detail],
      }),
      notes: ['The current state already satisfies the goal well enough that changing it is not justified.'],
    })
  }

  // 方案 §5.1: choosing between candidates requires a stated goal.
  if (goal === '') {
    return envelope({
      id, outcome: OUTCOME.INSUFFICIENT_CONTEXT, lifecycle: LIFECYCLE.PENDING,
      reasonCodes: [V2_MISSING.GOAL_REQUIRED],
      missingInformation: [`context.user_goal: ${V2_MISSING.GOAL_REQUIRED} — a modification cannot be selected without a goal`],
      rejectedCandidates, doNotChange, decisionRevision: revision,
      trace: buildTrace({ ...traceBase, selectedId: null, steps: [...traceBase.steps, 'no user_goal was supplied for a modification'] }),
      notes: ['Identify the real user goal and call again. KEEP_CURRENT does not need a goal; MODIFY does.'],
    });
  }

  // ── 敏感性检查（方案 §4.4 step 4） ───────────────────────────────────────
  const sensitivity = checkSensitivity(rankedSure, policy)
  if (sensitivity.near_tie && sensitivity.high_stakes) {
    return envelope({
      id, outcome: OUTCOME.REQUEST_APPROVAL, lifecycle: LIFECYCLE.AWAITING_APPROVAL,
      approvalRequired: true,
      approvalQuestion: `两个候选在 ${sensitivity.flips.join(', ')} 上只差一级，且都涉及中高影响风险；请确认取舍：${rankedSure.slice(0, 2).map((candidate) => `${candidate.id}（${candidate.approach || candidate.id}）`).join(' 对比 ')}`,
      reasonCodes: [REASON.NEAR_TIE_REQUIRES_TRADEOFF],
      rejectedCandidates, doNotChange, decisionRevision: revision,
      trace: buildTrace({ ...traceBase, selectedId: null, sensitivity, steps: [...traceBase.steps, 'ranking flips under a one-level evidence shift with non-trivial stakes'] }),
      notes: ['Small evidence changes flip this ranking, so the trade-off is yours to make. No execution is authorised.'],
    })
  }

  // ── 产出 MODIFY ─────────────────────────────────────────────────────────
  const selected = bestSure
  const reasonCodes = modifyReasonCodes(selected, baseline, policy, sure)
  if (sensitivity.near_tie) reasonCodes.push(REASON.NEAR_TIE_RESOLVED_BY_STABILITY)
  if (selected.evidenceState === GATE.PASS
    && DIMENSIONS.some((dimension) => levelRank(selected.dimensions[dimension]) === undefined)) {
    reasonCodes.push(EVIDENCE_CODE.UNKNOWN_ESTIMATE)
  }
  const userProposedOutranked = suppliedModify.some((candidate) => candidate.userProposed && candidate !== selected)
  if (userProposedOutranked) reasonCodes.push(REASON.USER_PROPOSED_SOLUTION_OVERRIDDEN)
  const dominated = sure.filter((candidate) => candidate.kind === KIND.MODIFY && candidate !== selected)
  const front = paretoFront(dominated, policy)

  return envelope({
    id,
    outcome: OUTCOME.MODIFY,
    lifecycle: LIFECYCLE.READY_TO_EXECUTE,
    selectedId: selected.id,
    selectedSolution: selected.approach === '' ? selected.id : selected.approach,
    executionScope: selected.scope,
    doNotChange: doNotChange.length > 0
      ? doNotChange
      : ['everything outside the execution scope; unrelated components, layout and system conventions'],
    reasonCodes,
    rejectedCandidates: rejectedCandidates.concat(
      dominated.filter((candidate) => !front.includes(candidate))
        .map((candidate) => rejection(candidate.id, REASON.PARETO_ELIMINATED, 'is dominated on every dimension that applies to this scenario')),
    ),
    executable: true,
    decisionRevision: revision,
    trace: buildTrace({
      ...traceBase,
      selectedId: selected.id,
      paretoFront: front.concat(selected).map((candidate) => candidate.id),
      sensitivity,
      approvals: selected.approval.attested === true ? [{ id: selected.id, required: false, attested: true, reason: selected.approval.reason }] : [],
      steps: [...traceBase.steps, `${selected.id} survived the hard gates, the comparison and the cost check`],
    }),
    notes: [
      goalSource === GOAL_SOURCE.USER_STATED
        ? 'The goal was stated by the user; the selected solution is the one that serves it best.'
        : 'The goal is inferred by DSH, not stated by the user; say so if the inference matters.',
      'Execute only the selected solution inside the execution scope, then call complete with this decision_revision.',
    ],
  })
}

/** Describe one approval-requiring candidate as a question for the user. */
function approvalQuestion(blocked, ranked, policy) {
  const alternatives = ranked
    .filter((candidate) => candidate !== blocked && candidate.kind === KIND.MODIFY)
    .slice(0, 3)
    .map((candidate) => `${candidate.id}（${candidate.approach || candidate.id}）`)
  const parts = [
    `${policy.label}场景下 ${blocked.id} 综合最优，但${blocked.approval.reason}。`,
    '请确认是否按该方案执行',
  ]
  if (alternatives.length > 0) parts.push(`，或改选 ${alternatives.join('、')}`)
  parts.push('。未获确认前不会执行任何修改。')
  return parts.join('')
}

/** Render a gap record as one readable line for `missing_information`. */
function describeGap(entry) {
  return `${entry.field}: ${entry.code}${entry.detail === undefined ? '' : ` — ${entry.detail}`}`
}

/**
 * Build a NOT_APPLICABLE refusal for the V2 contract.
 *
 * @param parts - the refused call's identity and the ledger's reason.
 * @returns the refusal envelope.
 */
export function notApplicableV2({ confirmationId, code, reason, decisionRevision }) {
  return envelope({
    id: confirmationId,
    outcome: OUTCOME.NOT_APPLICABLE,
    lifecycle: LIFECYCLE.UNCHANGED,
    reasonCodes: [code],
    missingInformation: [],
    decisionRevision,
    trace: null,
    notes: [
      `${reason}`,
      'This call is outside the 待确认事项 flow. Do not retry it and do not execute anything on its behalf; handle the user message with the normal DSH rules.',
    ],
  })
}

/**
 * Build the ledger acknowledgement for `register` / `complete`.
 *
 * @param parts - the item, its new state and the reason.
 * @returns the acknowledgement envelope.
 */
export function ledgerValueV2({ confirmationId, lifecycle, reasonCode, reason, notes, decisionRevision, approvalRequired }) {
  return envelope({
    id: confirmationId,
    outcome: OUTCOME.REGISTERED,
    lifecycle,
    approvalRequired: approvalRequired === true,
    reasonCodes: [reasonCode ?? 'REGISTERED'],
    decisionRevision,
    notes: [reason, ...(notes ?? [])],
  })
}

/** Re-exported so a caller can build a gap without importing two modules. */
export { evidenceGap, gapEntry }
