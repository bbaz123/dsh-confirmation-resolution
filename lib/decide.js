/**
 * Deterministic decision core for 待确认事项决策 (confirmation_resolution).
 *
 * Implements 02_Confirmation_Resolution_Plugin_执行规则 §4–§9, §13:
 *
 *   QUALITY_IMPACT
 *     -> USER_IMPACT_IF_UNCHANGED   (only when QUALITY_IMPACT !== NONE)
 *       -> USER_GOAL
 *         -> BEST_SOLUTION
 *
 * Every function here is pure: no I/O, no service access, no timers. The Cordis
 * plugin in `./index.js` only maps these results onto a tool schema. Keeping the
 * core pure is what makes the fixed decision matrix verifiable by unit tests
 * instead of by opinion.
 *
 * @module dsh-plugin-confirmation-resolution/decide
 */

/** Ordered impact levels, least to most severe. */
export const LEVELS = ['NONE', 'LOW', 'MEDIUM', 'HIGH']

/** `MODIFY` / `KEEP_CURRENT` / `READY_TO_EXECUTE` / `INSUFFICIENT_CONTEXT` vocabulary. */
export const ACTION = Object.freeze({ MODIFY: 'MODIFY', KEEP_CURRENT: 'KEEP_CURRENT' })
export const STATUS = Object.freeze({
  READY: 'READY_TO_EXECUTE',
  INSUFFICIENT: 'INSUFFICIENT_CONTEXT',
  /** The call cannot belong to a confirmation flow; see the session ledger guard. */
  NOT_APPLICABLE: 'NOT_APPLICABLE',
})

/**
 * Reported when the caller supplied no goal. Text, not a sentinel: the value is
 * echoed to the model inside `USER_GOAL`, so it must read as a statement.
 */
export const NOT_IDENTIFIED_GOAL = '[not identified from the available context]'

/**
 * The quality dimensions §4 requires the judgement to cover. The mapping is
 * deliberately 1:1 with the specification's list so a reviewer can diff them.
 */
export const QUALITY_DIMENSIONS = Object.freeze([
  'correctness',
  'completeness',
  'clarity',
  'hierarchy',
  'layout',
  'consistency',
  'interaction',
  'responsive',
  'accessibility',
  'performance',
  'maintainability',
  'system_consistency',
])

/** The 实际使用影响 list from 02 §5 / 03 §7. */
export const USER_IMPACT_DIMENSIONS = Object.freeze([
  'core_task_blocked',
  'key_entry_hard_to_find',
  'key_content_hard_to_understand',
  'mistake_risk',
  'cost_increase',
  'inaccessible',
])

/** Side-effect classes checked before a solution is allowed to ship (02 §9). */
export const SIDE_EFFECT_CATEGORIES = Object.freeze([
  'functional',
  'visual',
  'layout',
  'responsive',
  'interaction',
  'content',
  'consistency',
  'accessibility',
  'performance',
])

/** rank helpers: NONE < LOW < MEDIUM < HIGH. */
const LEVEL_RANK = Object.freeze({ NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 })
const RANK_LEVEL = Object.freeze(['NONE', 'LOW', 'MEDIUM', 'HIGH'])

/** Solution scope kinds, narrowest first — 03 §10 最小必要修改. */
const SCOPE_RANK = Object.freeze({
  value: 0,
  state: 1,
  component: 2,
  section: 3,
  page: 4,
  system: 5,
})

/** Reversibility of a solution; `reversible` is the safest tie-breaker (03 §13). */
const REVERSIBILITY_RANK = Object.freeze({ reversible: 0, partial: 1, irreversible: 2 })

/** Reason codes for INSUFFICIENT_CONTEXT — stable, so a caller can branch on them. */
export const MISSING_REASONS = Object.freeze({
  REQUIRED_FIELD: 'REQUIRED_FIELD_EMPTY_AND_NOT_DERIVABLE',
  QUALITY_UNDECIDABLE: 'QUALITY_IMPACT_UNDECIDABLE_WITH_AVAILABLE_CONTEXT',
  USER_IMPACT_UNDECIDABLE: 'USER_IMPACT_IF_UNCHANGED_UNDECIDABLE_AND_IT_FLIPS_THE_DECISION',
  NO_FEASIBLE_SOLUTION: 'MODIFY_REQUIRED_BUT_NO_FEASIBLE_SOLUTION_CANDIDATE',
  NO_ALTERNATIVE: 'MODIFY_REQUIRED_BUT_ONLY_THE_USERS_OWN_DAMAGING_OPTION_WAS_GIVEN',
  CONFLICT: 'CALLER_ASSESSMENT_CONTRADICTS_ITS_OWN_EVIDENCE',
})

/** Normalize one level token; unknown or absent collapses to `undefined`. */
function level(value) {
  if (typeof value !== 'string') return undefined
  const upper = value.trim().toUpperCase()
  return Object.hasOwn(LEVEL_RANK, upper) ? upper : undefined
}

function maxLevel(a, b) {
  if (a === undefined) return b
  if (b === undefined) return a
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b
}

/** Render the quality evidence for the model-facing payload. */
function qualityEvidenceText(evidence, declaredQuality, preferenceOnly) {
  if (evidence !== undefined && evidence.length > 0) {
    return evidence.map((entry) => `${entry.dimension} (${entry.severity})`).join('; ')
  }
  if (declaredQuality !== undefined) return `assessed as ${declaredQuality} by the caller`
  if (preferenceOnly === true) return 'no quality degradation claimed; preference-only declaration'
  return 'NONE'
}

/**
 * Read the caller's per-dimension evidence for how the CONFIRMED change alters
 * the result, compared with the current state (02 §4 requires comparing state
 * after the change against the current state — never "is it implementable").
 *
 * @param raw - the `quality_dimensions` input object, if any.
 * @returns severity level plus the degraded/improved dimension names.
 */
function readQualityEvidence(raw) {
  const degraded = []
  const improved = []
  if (raw === undefined || raw === null) return { level: undefined, degraded, improved, used: false }
  for (const key of QUALITY_DIMENSIONS) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'object') continue
    const token = String(value).trim().toLowerCase()
    if (token === '' || token === 'same' || token === 'none' || token === 'unchanged') continue
    const named = String(value.degraded ?? value.improved ?? '').trim().toLowerCase()
    if (token === 'degraded' || token === 'down') {
      const severity = level(value.severity) ?? 'LOW'
      degraded.push({ dimension: key, severity })
      continue
    }
    if (token === 'improved' || token === 'up') {
      improved.push(key)
      continue
    }
    if (token === 'lost' || token === 'broken' || token === 'removed') {
      degraded.push({ dimension: key, severity: 'HIGH' })
      continue
    }
    if (named === 'degraded') {
      degraded.push({ dimension: key, severity: 'LOW' })
      continue
    }
    if (named === 'improved') {
      improved.push(key)
      continue
    }
    // A plain severity token: `{"accessibility": "HIGH"}` means degraded by HIGH.
    const severity = level(token)
    if (severity !== undefined && severity !== 'NONE') degraded.push({ dimension: key, severity })
  }
  let worst
  for (const entry of degraded) worst = maxLevel(worst, entry.severity)
  return { level: worst, degraded, improved, used: degraded.length > 0 || improved.length > 0 }
}

/**
 * Read the caller's evidence that NOT changing the current state harms real use
 * (02 §5 / 03 §7). 純审美偏好、颜色偏好、非关键位置偏好、装饰变化 are explicitly not
 * usage problems, so `preference_only: true` suppresses the derived impact.
 *
 * @param raw - the `user_impact_dimensions` input object, if any.
 * @param preferenceOnly - the `preference_only` flag.
 * @returns severity level plus the flagged dimension names.
 */
function readUserImpactEvidence(raw, preferenceOnly) {
  const hits = []
  if (raw === undefined || raw === null) return { level: undefined, hits }
  for (const key of USER_IMPACT_DIMENSIONS) {
    const value = raw[key]
    if (value === undefined || value === null || value === false) continue
    const token = String(value).trim().toLowerCase()
    if (token === '' || token === 'none' || token === 'false' || token === 'no') continue
    hits.push({ dimension: key, severity: level(token) ?? 'MEDIUM' })
  }
  if (hits.length === 0) return { level: undefined, hits }
  if (preferenceOnly === true) return { level: undefined, hits }
  let worst
  for (const hit of hits) worst = maxLevel(worst, hit.severity)
  return { level: worst, hits }
}

/**
 * Magnitude above which a proposed change is excessive by construction: 02 §7
 * rejects "把主按钮放大 300%" mechanically even when the caller supplies no
 * comparison candidates, because the scale itself proves unnecessary loss.
 */
const EXCESSIVE_SCALE = 200

/**
 * Read an explicit magnitude from an approach described as a percentage, so the
 * "user gave a number" case is discriminated the same way whether or not the
 * caller modelled the proposal as a candidate.
 *
 * @param approach - the approach text.
 * @returns the largest percentage found, or `undefined`.
 */
function scaleFromApproach(approach) {
  let worst
  const pattern = /(\d+(?:\.\d+)?)\s*%/g
  let match = pattern.exec(approach)
  while (match !== null) {
    const value = Number(match[1])
    if (Number.isFinite(value) && (worst === undefined || value > worst)) worst = value
    match = pattern.exec(approach)
  }
  return worst
}

/** Normalize one solution candidate from the caller. */
function normalizeSolution(raw, index) {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  const label = typeof raw.label === 'string' && raw.label.trim() !== ''
    ? raw.label.trim()
    : `candidate-${index + 1}`
  const scopeRaw = typeof raw.scope === 'string' ? raw.scope.trim().toLowerCase() : ''
  const sideEffects = []
  if (raw.side_effects !== undefined && raw.side_effects !== null && typeof raw.side_effects === 'object') {
    for (const [key, value] of Object.entries(raw.side_effects)) {
      if (value === undefined || value === null || value === false) continue
      const token = String(value).trim().toLowerCase()
      if (token === '' || token === 'none' || token === 'false' || token === 'no') continue
      sideEffects.push({ category: key, severity: level(token) ?? 'LOW' })
    }
  }
  let sideEffectRisk
  for (const effect of sideEffects) sideEffectRisk = maxLevel(sideEffectRisk, effect.severity)
  const qualityLoss = level(raw.quality_loss) ?? 'NONE'
  const reversibility = typeof raw.reversibility === 'string' && Object.hasOwn(REVERSIBILITY_RANK, raw.reversibility.trim().toLowerCase())
    ? raw.reversibility.trim().toLowerCase()
    : 'partial'
  return {
    label,
    approach: typeof raw.approach === 'string' ? raw.approach.trim() : '',
    solvesUserProblem: raw.solves_user_problem !== false,
    qualityLoss,
    sideEffects,
    sideEffectRisk: sideEffectRisk ?? 'NONE',
    scope: Object.hasOwn(SCOPE_RANK, scopeRaw) ? scopeRaw : 'component',
    reversibility,
    complexity: level(raw.complexity) ?? 'LOW',
    expandsBeyondNecessity: raw.expands_beyond_necessity === true,
    violatesConstraints: raw.violates_constraints === true,
    withinPermittedScope: raw.within_permitted_scope !== false,
    addressesRootCause: raw.addresses_root_cause !== false,
    userProposed: raw.user_proposed === true,
    // 02 §8 priorities 2, 5 and 6 — compared independently, never folded into
    // `quality_loss`. HIGH user benefit ranks best; for the two risk-shaped
    // fields NONE ranks best.
    userBenefit: level(raw.user_benefit) ?? 'NONE',
    systemConsistency: level(raw.system_consistency) ?? 'NONE',
    stabilityRisk: level(raw.stability_risk) ?? 'NONE',
    scale: typeof raw.scale === 'number' && Number.isFinite(raw.scale)
      ? raw.scale
      : scaleFromApproach(typeof raw.approach === 'string' ? raw.approach : ''),
  }
}

/**
 * Hard gates from 02 §6 (`reject solutions that: …`) and 03 §10. A rejected
 * candidate is never eligible, no matter how attractive its other fields are.
 *
 * @param candidate - normalized candidate.
 * @param ceiling - the unavoidable quality-loss ceiling for this confirmation.
 * @returns rejection reason, or `undefined` when the candidate survives.
 */
function rejectReason(candidate, ceiling) {
  if (!candidate.solvesUserProblem) return 'does not solve the real user problem'
  if (candidate.expandsBeyondNecessity) return 'expands the modification beyond necessity'
  if (!candidate.withinPermittedScope) return 'exceeds the permitted execution scope'
  if (candidate.violatesConstraints) return 'violates a known constraint'
  if (candidate.scale !== undefined && candidate.scale > EXCESSIVE_SCALE) {
    return `magnitude ${candidate.scale}% is excessive by construction (limit ${EXCESSIVE_SCALE}%)`
  }
  if (candidate.sideEffectRisk !== 'NONE' && LEVEL_RANK[candidate.sideEffectRisk] > LEVEL_RANK[ceiling]) {
    return `introduces new side effects (${candidate.sideEffectRisk}) rather than removing them`
  }
  if (candidate.qualityLoss !== 'NONE' && LEVEL_RANK[candidate.qualityLoss] > LEVEL_RANK[ceiling]) {
    return `causes unnecessary quality loss (${candidate.qualityLoss} above the avoidable ceiling ${ceiling})`
  }
  if (candidate.qualityLoss === 'NONE' && candidate.addressesRootCause === false && ceiling !== 'NONE') {
    return 'leaves the root cause in place while the alternative loses no quality'
  }
  return undefined
}

/**
 * Lexicographic comparison following 02 §8 / 03 §5 priority order, in the exact
 * order the specification lists it:
 *
 *   1. does it really solve the user's problem
 *   2. is real user experience better          → `userBenefit`
 *   3. is the overall quality loss smaller     → `qualityLoss`
 *   4. does it avoid new side effects          → `sideEffectRisk`
 *   5. does it keep system consistency         → `systemConsistency`
 *   6. does it keep stability                  → `stabilityRisk`
 *   7. is the implementation complexity sane   → `complexity`
 *
 * `reversibility` and `scope` break remaining ties: they implement 03 §10's
 * minimum-necessary-change rule and 03 §13's "prefer the reversible, local,
 * low-risk option" instruction, which the seven priorities do not cover.
 *
 * @returns negative when `a` ranks better than `b`.
 */
function compareSolutions(a, b) {
  if (a.solvesUserProblem !== b.solvesUserProblem) return a.solvesUserProblem ? -1 : 1
  if (LEVEL_RANK[a.userBenefit] !== LEVEL_RANK[b.userBenefit]) return LEVEL_RANK[b.userBenefit] - LEVEL_RANK[a.userBenefit]
  if (LEVEL_RANK[a.qualityLoss] !== LEVEL_RANK[b.qualityLoss]) return LEVEL_RANK[a.qualityLoss] - LEVEL_RANK[b.qualityLoss]
  if (LEVEL_RANK[a.sideEffectRisk] !== LEVEL_RANK[b.sideEffectRisk]) return LEVEL_RANK[a.sideEffectRisk] - LEVEL_RANK[b.sideEffectRisk]
  if (LEVEL_RANK[a.systemConsistency] !== LEVEL_RANK[b.systemConsistency]) return LEVEL_RANK[a.systemConsistency] - LEVEL_RANK[b.systemConsistency]
  if (LEVEL_RANK[a.stabilityRisk] !== LEVEL_RANK[b.stabilityRisk]) return LEVEL_RANK[a.stabilityRisk] - LEVEL_RANK[b.stabilityRisk]
  if (LEVEL_RANK[a.complexity] !== LEVEL_RANK[b.complexity]) return LEVEL_RANK[a.complexity] - LEVEL_RANK[b.complexity]
  if (REVERSIBILITY_RANK[a.reversibility] !== REVERSIBILITY_RANK[b.reversibility]) {
    return REVERSIBILITY_RANK[a.reversibility] - REVERSIBILITY_RANK[b.reversibility]
  }
  if (SCOPE_RANK[a.scope] !== SCOPE_RANK[b.scope]) return SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope]
  return 0
}

/**
 * Run the fixed decision algorithm for exactly one confirmation item.
 *
 * @param input - normalized arguments of one `confirmation_resolution` call.
 * @returns the complete, spec-shaped decision value.
 */
export function decide(input) {
  const confirmationId = typeof input.confirmation_id === 'string' ? input.confirmation_id.trim() : ''
  const currentState = typeof input.current_state === 'string' ? input.current_state.trim() : ''
  const originalConfirmation = typeof input.original_confirmation === 'string' ? input.original_confirmation.trim() : ''
  const userReply = typeof input.user_reply === 'string' ? input.user_reply.trim() : ''

  // ── Step 0: only a genuinely critical gap may reach INSUFFICIENT_CONTEXT ────
  const missing = []
  for (const [field, value] of [
    ['confirmation_id', confirmationId],
    ['current_state', currentState],
    ['original_confirmation', originalConfirmation],
    ['user_reply', userReply],
  ]) {
    if (value === '') missing.push({ field, reason: MISSING_REASONS.REQUIRED_FIELD })
  }

  const evidence = readQualityEvidence(input.quality_dimensions)
  const declaredQuality = level(input.quality_impact)
  let effectiveQuality = maxLevel(declaredQuality, evidence.level)
  if (declaredQuality !== undefined && evidence.level !== undefined && declaredQuality !== evidence.level) {
    missing.push({
      field: 'quality_impact',
      reason: MISSING_REASONS.CONFLICT,
      detail: `quality_impact=${declaredQuality} but quality_dimensions evidence says ${evidence.level}; the more conservative level is used`,
    })
  }

  const preferenceOnly = input.preference_only === true
  const impactEvidence = readUserImpactEvidence(input.user_impact_dimensions, preferenceOnly)
  const declaredUser = level(input.user_impact_if_unchanged)
  let effectiveUser = maxLevel(declaredUser, impactEvidence.level)
  if (!preferenceOnly
    && (input.user_impact_if_unchanged !== undefined || input.user_impact_dimensions !== undefined)
    && effectiveUser === undefined) {
    // The caller answered the user-impact question with an explicit NONE, which
    // `level()` cannot carry: record it so a below-threshold quality loss does
    // not get re-escalated into a second question about the user's preference.
    effectiveUser = 'NONE'
  }

  // 03 §13: when the quality impact is uncertain, treat it as a possible loss
  // and continue to the user-impact step — never fail open to MODIFY. An explicit
  // preference-only signal is real context, so the conservative reading is taken
  // here and the matrix decides, instead of asking the user a second time.
  if (effectiveQuality === undefined) {
    if (preferenceOnly) effectiveQuality = 'LOW'
    else missing.push({ field: 'quality_impact', reason: MISSING_REASONS.QUALITY_UNDECIDABLE })
  }

  // USER_GOAL is the CALLER's responsibility (03 §9): DSH understands the reply
  // and passes the real goal. This pure function never guesses a goal from free
  // text, and it does not accept a second "inferred" field that only looked like
  // one — a goal nobody supplied is reported as not identified, per 02 §2.
  const userGoalProvided = typeof input.user_goal === 'string' && input.user_goal.trim() !== ''
  const userGoal = userGoalProvided ? input.user_goal.trim() : NOT_IDENTIFIED_GOAL

  const ceiling = effectiveQuality === undefined ? 'LOW' : effectiveQuality

  // ── Step 1–3: the fixed matrix ─────────────────────────────────────────────
  const insufficient = missing.some((entry) => entry.reason === MISSING_REASONS.REQUIRED_FIELD
    || entry.reason === MISSING_REASONS.QUALITY_UNDECIDABLE)
  if (insufficient) {
    return insufficientValue({
      confirmationId,
      currentState,
      originalConfirmation,
      userReply,
      userGoal,
      missing,
      quality: effectiveQuality,
      user: effectiveUser,
    })
  }

  if (effectiveQuality === 'NONE') {
    // Rule 1: no quality loss -> modify, with the best overall solution. The
    // user dimension is only evaluated when QUALITY_IMPACT != NONE, so it is not
    // reported here: an absent (or caller-supplied) user level must never leak
    // into a "no quality loss yet standing still hurts the user" combination.
    return modifyValue({
      confirmationId, currentState, originalConfirmation, userReply, userGoal,
      quality: 'NONE', user: 'NONE', input, ceiling: 'NONE', missing,
      evidence,
    })
  }

  // From here QUALITY_IMPACT != NONE, so USER_IMPACT_IF_UNCHANGED decides.
  if (effectiveUser === undefined) {
    // 03 §13: infer from the core task, real usage path, error risk,
    // accessibility and comprehension. An explicit goal or a preference-only
    // signal is real evidence; nothing at all is not.
    if (preferenceOnly) {
      effectiveUser = 'NONE'
    } else if (input.infer_user_impact_if_unchanged === true && userGoalProvided) {
      effectiveUser = 'LOW'
    } else {
      missing.push({ field: 'user_impact_if_unchanged', reason: MISSING_REASONS.USER_IMPACT_UNDECIDABLE })
      return insufficientValue({
        confirmationId, currentState, originalConfirmation, userReply, userGoal,
        missing, quality: effectiveQuality, user: undefined,
      })
    }
  }

  if (effectiveUser === 'NONE') {
    // Rule 2: quality would drop and standing still does not affect real use ->
    // keep the current state. A pure preference never outranks overall quality.
    return {
      confirmation_id: confirmationId,
      action: ACTION.KEEP_CURRENT,
      quality_impact: effectiveQuality,
      user_impact_if_unchanged: 'NONE',
      user_goal: userGoal,
      selected_solution: 'KEEP_CURRENT',
      execution_scope: 'NONE',
      do_not_change: `${currentState !== '' ? currentState : 'current state'}; this confirmation item stays exactly as it is`,
      side_effect_risk: 'NONE',
      status: STATUS.READY,
      missing_information: 'NONE',
      current_state: currentState,
      original_confirmation: originalConfirmation,
      user_reply: userReply,
      confirmation_state: 'RESOLVED',
      execution_required: false,
      quality_evidence: qualityEvidenceText(evidence.degraded, declaredQuality, preferenceOnly),
      user_impact_evidence: preferenceOnly ? 'preference-only change; no real usage impact' : 'NONE',
      selection_reason: 'the change would lower overall quality while leaving the current state does not hinder real use',
      notes: preferenceOnly
        ? 'Aesthetic, colour, non-critical-position and decorative preferences do not count as real usage problems.'
        : 'The user\u2019s stated method carries no automatic priority; overall quality decides when real use is unaffected.',
    }
  }

  // Rule 3: quality would drop AND standing still hurts real use -> always
  // modify, but pick the alternative with the smallest reasonable loss.
  return modifyValue({
    confirmationId, currentState, originalConfirmation, userReply, userGoal,
    quality: effectiveQuality, user: effectiveUser, input, ceiling, missing, evidence,
  })
}

/** Build a MODIFY decision, selecting the best feasible solution. */
function modifyValue({ confirmationId, currentState, originalConfirmation, userReply, userGoal, quality, user, input, ceiling, missing, evidence }) {
  const rawCandidates = Array.isArray(input.candidate_solutions) ? input.candidate_solutions : []
  const candidates = []
  for (let index = 0; index < rawCandidates.length; index += 1) {
    const normalized = normalizeSolution(rawCandidates[index], index)
    if (normalized !== undefined) candidates.push(normalized)
  }
  // 02 §7: the user's own wording is only a candidate. When the caller did not
  // restate it as one, model it as a candidate so it must pass the SAME hard
  // gates as every alternative — 02 §13 forbids treating it as a default.
  if (candidates.length === 0 && typeof input.user_proposed_solution === 'string' && input.user_proposed_solution.trim() !== '') {
    candidates.push(normalizeSolution({
      label: 'USER_PROPOSED_SOLUTION',
      approach: input.user_proposed_solution.trim(),
      user_proposed: true,
      scope: 'component',
      reversibility: 'partial',
    }, 0))
  }

  const evaluated = []
  const rejected = []
  for (const candidate of candidates) {
    const reason = rejectReason(candidate, ceiling)
    if (reason === undefined) evaluated.push(candidate)
    else rejected.push({ label: candidate.label, reason })
  }
  evaluated.sort(compareSolutions)

  const alternatives = evaluated.filter((candidate) => candidate.userProposed !== true)
  const chosen = evaluated[0]

  // 03 §9 / 02 §13: with no feasible candidate, never fall back to the user's
  // original method — report what is missing instead.
  if (chosen === undefined) {
    const noAlternative = candidates.length > 0
      && evaluated.length === 0
      && alternatives.length === 0
      && !missing.some((entry) => entry.reason === MISSING_REASONS.NO_FEASIBLE_SOLUTION)
    missing.push({
      field: 'candidate_solutions',
      reason: noAlternative ? MISSING_REASONS.NO_ALTERNATIVE : MISSING_REASONS.NO_FEASIBLE_SOLUTION,
      detail: rejected.length > 0
        ? `rejected candidates: ${rejected.map((entry) => `${entry.label} (${entry.reason})`).join('; ')}`
        : 'no candidate solution was supplied for a change that is required',
    })
    return insufficientValue({
      confirmationId, currentState, originalConfirmation, userReply, userGoal,
      missing, quality, user,
    })
  }

  const userProposedWasChosen = evaluated.some((candidate) => candidate.userProposed === true && candidate.label === chosen.label)
  const overridden = candidates.some((candidate) => candidate.userProposed === true) && !userProposedWasChosen

  return {
    confirmation_id: confirmationId,
    action: ACTION.MODIFY,
    quality_impact: quality,
    user_impact_if_unchanged: user,
    user_goal: userGoal,
    selected_solution: chosen.approach !== '' ? chosen.approach : chosen.label,
    execution_scope: chosen.scope === 'component' && chosen.approach !== ''
      ? `minimum necessary scope (${chosen.scope}) of: ${chosen.approach}`
      : `minimum necessary scope (${chosen.scope})`,
    do_not_change: typeof input.do_not_change === 'string' && input.do_not_change.trim() !== ''
      ? input.do_not_change.trim()
      : 'everything outside the execution scope; unrelated components, layout, navigation and system conventions',
    side_effect_risk: chosen.sideEffectRisk,
    status: STATUS.READY,
    missing_information: 'NONE',
    current_state: currentState,
    original_confirmation: originalConfirmation,
    user_reply: userReply,
    confirmation_state: 'RESOLVED',
    execution_required: true,
    quality_evidence: qualityEvidenceText(evidence?.degraded, input.quality_impact, input.preference_only === true),
    user_impact_evidence: impactEvidenceText(user, input),
    selection_reason: chosen.userProposed
      ? 'the user\u2019s own method already satisfies the hard gates and loses nothing relative to the alternatives'
      : 'minimum necessary change: best real-user benefit with the smallest reasonable quality loss and fewest side effects',
    notes: overridden
      ? 'The user\u2019s proposed method was rejected by a hard gate; execute the selected alternative, not the literal request.'
      : (rejected.length > 0
        ? `Rejected candidates: ${rejected.map((entry) => `${entry.label} (${entry.reason})`).join('; ')}`
        : 'Only the selected solution survived the hard gates.'),
  }
}

function impactEvidenceText(user, input) {
  if (input !== undefined && input.preference_only === true) return 'preference-only change; not a real usage problem'
  return user === 'NONE' ? 'NONE' : `derived from the stated usage impact (${user})`
}

/**
 * Build a NOT_APPLICABLE refusal.
 *
 * This is what the session-ledger guard answers with: the call could not belong
 * to a confirmation flow, so no decision is made and nothing may be executed.
 * DSH treats it exactly like an ordinary task — see the prompt rules — and must
 * not retry the call or execute anything on its behalf.
 *
 * @param fields - the identity of the refused call and the ledger's reason.
 * @returns the refusal value, shaped like every other decision.
 */
export function notApplicableValue({ confirmationId, currentState, originalConfirmation, userReply, code, reason }) {
  return {
    confirmation_id: confirmationId,
    action: ACTION.KEEP_CURRENT,
    quality_impact: 'NONE',
    user_impact_if_unchanged: 'NONE',
    user_goal: NOT_IDENTIFIED_GOAL,
    selected_solution: 'NONE',
    execution_scope: 'NONE',
    do_not_change: currentState !== '' ? currentState : 'current state',
    side_effect_risk: 'NONE',
    status: STATUS.NOT_APPLICABLE,
    missing_information: 'NONE',
    current_state: currentState,
    original_confirmation: originalConfirmation,
    user_reply: userReply,
    confirmation_state: 'UNCHANGED',
    execution_required: false,
    quality_evidence: 'not evaluated',
    user_impact_evidence: 'not evaluated',
    selection_reason: `refused by the session ledger guard: ${code}`,
    notes: `${reason}. This call is outside the 待确认事项 flow: handle the user's message with the normal DSH rules instead, and do not execute any change on this item's behalf.`,
  }
}

/** Build an INSUFFICIENT_CONTEXT decision. */
function insufficientValue({ confirmationId, currentState, originalConfirmation, userReply, userGoal, missing, quality, user }) {  // A dimension the caller could not answer is reported as NONE — its true level
  // is unknown, and `missing_information` carries that fact. Emitting LOW here
  // would assert a judgement nobody made.
  return {
    confirmation_id: confirmationId,
    action: ACTION.KEEP_CURRENT,
    quality_impact: quality === undefined ? 'NONE' : quality,
    user_impact_if_unchanged: user === undefined ? 'NONE' : user,
    user_goal: userGoal,
    selected_solution: 'NONE',
    execution_scope: 'NONE',
    do_not_change: currentState !== '' ? currentState : 'current state must not change while context is insufficient',
    side_effect_risk: 'NONE',
    status: STATUS.INSUFFICIENT,
    missing_information: missing.length > 0 ? missing.map((entry) => `${entry.field}: ${entry.reason}`).join('; ') : 'NONE',
    current_state: currentState,
    original_confirmation: originalConfirmation,
    user_reply: userReply,
    confirmation_state: 'PENDING',
    execution_required: false,
    quality_evidence: quality === undefined
      ? 'unknown: no quality evidence and no assessment were supplied'
      : `assessed ${quality}; reliability was not sufficient to act on it`,
    user_impact_evidence: user === undefined
      ? 'unknown: standing still could not be judged from the supplied context'
      : `assessed ${user}; reliability was not sufficient to act on it`,
    selection_reason: 'context is insufficient for a reliable decision, so no solution is selected',
    notes: 'A confirmation item with INSUFFICIENT_CONTEXT stays PENDING. Do not execute the user\u2019s original method as a fallback.',
  }
}

/**
 * Format one decision exactly as 02 §10–§12 specifies, so the model receives the
 * canonical block as well as the structured fields.
 *
 * @param value - a decision value returned by {@link decide}.
 * @returns the canonical uppercase report text.
 */
export function formatDecision(value) {
  return [
    `CONFIRMATION_ID: ${value.confirmation_id}`,
    '',
    `ACTION: ${value.action}`,
    '',
    `QUALITY_IMPACT: ${value.quality_impact}`,
    '',
    `USER_IMPACT_IF_UNCHANGED: ${value.user_impact_if_unchanged}`,
    '',
    `USER_GOAL: ${value.user_goal}`,
    '',
    `SELECTED_SOLUTION: ${value.selected_solution}`,
    '',
    `EXECUTION_SCOPE: ${value.execution_scope}`,
    '',
    `DO_NOT_CHANGE: ${value.do_not_change}`,
    '',
    `SIDE_EFFECT_RISK: ${value.side_effect_risk}`,
    '',
    `STATUS: ${value.status}`,
    '',
    `MISSING_INFORMATION: ${value.missing_information}`,
    '',
    `CONFIRMATION_STATE: ${value.confirmation_state}`,
  ].join('\n')
}

/** Export for tests: the level vocabulary in rank order. */
export const LEVEL_ORDER = Object.freeze([...RANK_LEVEL])
