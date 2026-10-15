/**
 * Evidence model for the V2 decision engine (`lib/decision-v2.js`).
 *
 * The V1 core of `lib/decide.js` folds every caller field through an optimistic
 * default: a candidate that never mentions `violates_constraints` is treated as
 * if it did not violate anything, and a missing `quality_loss` becomes `NONE`.
 * That is exactly the inference V2 must not make (方案 §2 `normalizeSolution()`,
 * §4.2 "不确定不等于安全"). This module therefore keeps THREE-valued evidence
 * and never silently upgrades absence into a pass:
 *
 *   布尔类门禁 GATE   PASS | FAIL | UNKNOWN
 *   程度类指标 LEVEL  NONE | LOW | MEDIUM | HIGH | UNKNOWN
 *
 * Pure by construction: normalization, conservative combination, conflict
 * diagnosis and gap reporting only. No I/O, no timers, no host access.
 *
 * @module dsh-plugin-confirmation-resolution/evidence
 */

/** Boolean-gate vocabulary (方案 §4.2). */
export const GATE = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  UNKNOWN: 'UNKNOWN',
})

/** Degree vocabulary (方案 §4.2). `UNKNOWN` is a value, not a missing key. */
export const LEVEL = Object.freeze({
  NONE: 'NONE',
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  UNKNOWN: 'UNKNOWN',
})

/**
 * Conservative combination order for gates: the WORST input wins. `UNKNOWN`
 * ranks below `PASS`, so "nobody checked" can never masquerade as "verified".
 */
const GATE_RANK = Object.freeze({ FAIL: 0, UNKNOWN: 1, PASS: 2 })

/** Level order for known values; `UNKNOWN` has no rank by design. */
export const LEVEL_RANK = Object.freeze({ NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 })

/** Known levels, least to most severe. */
export const LEVEL_ORDER = Object.freeze(['NONE', 'LOW', 'MEDIUM', 'HIGH'])

/** Stable failure codes for the trace and `missing_information`. */
export const EVIDENCE_CODE = Object.freeze({
  CONFLICT: 'CONFLICTING_EVIDENCE',
  UNKNOWN_CRITICAL: 'CRITICAL_EVIDENCE_UNKNOWN',
  UNKNOWN_ESTIMATE: 'ESTIMATED_WITH_UNKNOWN_EVIDENCE',
})

const TRUE_TOKENS = new Set([
  'true', 'pass', 'passed', 'yes', 'y', 'ok', 'allow', 'allowed',
  'satisfied', 'present', 'verified', 'met', 'supported',
])
const FALSE_TOKENS = new Set([
  'false', 'fail', 'failed', 'no', 'n', 'deny', 'denied', 'blocked',
  'violated', 'violates', 'missing', 'absent', 'unsatisfied', 'unmet',
  'rejected', 'unsafe', 'forbidden',
])
const UNKNOWN_TOKENS = new Set([
  'unknown', 'unspecified', 'unclear', 'undetermined', 'not_provided',
  'not-provided', 'not_supplied', 'unevaluated', 'unassessed', 'n/a', 'na',
  'null', 'undefined', 'tbd', '?',
])

const LEVEL_ALIASES = Object.freeze({
  none: LEVEL.NONE,
  no: LEVEL.NONE,
  same: LEVEL.NONE,
  unchanged: LEVEL.NONE,
  equal: LEVEL.NONE,
  zero: LEVEL.NONE,
  low: LEVEL.LOW,
  minor: LEVEL.LOW,
  slight: LEVEL.LOW,
  medium: LEVEL.MEDIUM,
  med: LEVEL.MEDIUM,
  moderate: LEVEL.MEDIUM,
  high: LEVEL.HIGH,
  severe: LEVEL.HIGH,
  critical: LEVEL.HIGH,
  major: LEVEL.HIGH,
})

function token(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, '_') : ''
}

/**
 * Normalize one boolean gate.
 *
 * @param value - boolean, token string, or anything else.
 * @returns `PASS`, `FAIL` or `UNKNOWN` (absence is `UNKNOWN`, never `PASS`).
 */
export function gate(value) {
  if (value === true) return GATE.PASS
  if (value === false) return GATE.FAIL
  if (value === undefined || value === null) return GATE.UNKNOWN
  if (typeof value === 'number') {
    if (value === 1) return GATE.PASS
    if (value === 0) return GATE.FAIL
    return GATE.UNKNOWN
  }
  if (typeof value !== 'string') return GATE.UNKNOWN
  const text = token(value)
  if (text === '' || UNKNOWN_TOKENS.has(text)) return GATE.UNKNOWN
  if (TRUE_TOKENS.has(text)) return GATE.PASS
  if (FALSE_TOKENS.has(text)) return GATE.FAIL
  return GATE.UNKNOWN
}

/**
 * Normalize one degree metric.
 *
 * @param value - a level token, a numeric 0-3, or an object carrying one.
 * @returns a {@link LEVEL} member; absence is `UNKNOWN`.
 */
export function level(value) {
  if (value === undefined || value === null || value === false) return LEVEL.UNKNOWN
  if (typeof value === 'number') {
    const name = LEVEL_ORDER[value]
    return name === undefined ? LEVEL.UNKNOWN : name
  }
  if (typeof value === 'object') {
    return level(value.level ?? value.value ?? value.state)
  }
  if (value === true) return LEVEL.UNKNOWN
  if (typeof value !== 'string') return LEVEL.UNKNOWN
  const text = token(value)
  if (text === '') return LEVEL.UNKNOWN
  const upper = text.toUpperCase()
  if (Object.hasOwn(LEVEL_RANK, upper)) return upper
  if (upper === LEVEL.UNKNOWN) return LEVEL.UNKNOWN
  const alias = LEVEL_ALIASES[text]
  return alias === undefined ? LEVEL.UNKNOWN : alias
}

/** @returns whether a level token carries a usable rank. */
export function isKnownLevel(value) {
  return Object.hasOwn(LEVEL_RANK, value)
}

/** @returns the rank of a known level, or `undefined` for `UNKNOWN`. */
export function rank(levelToken) {
  return Object.hasOwn(LEVEL_RANK, levelToken) ? LEVEL_RANK[levelToken] : undefined
}

/** Conservative gate combination: the worst input wins. */
export function worstGate(...values) {
  // Start from the best possible value so the result degrades toward the worst
  // input; starting at UNKNOWN would make a PASS/FAIL pair collapse to UNKNOWN.
  let worst = GATE.PASS
  for (const value of values) {
    const normalized = Object.hasOwn(GATE_RANK, value) ? value : gate(value)
    if (GATE_RANK[normalized] < GATE_RANK[worst]) worst = normalized
  }
  return worst
}

/**
 * Conservative level combination: the largest KNOWN value wins, and if nothing
 * is known the answer stays `UNKNOWN`. `UNKNOWN` is never folded into a level,
 * because "we did not check" is not the same statement as "severity is zero".
 */
export function worstLevel(...values) {
  let worst
  for (const value of values) {
    const normalized = Object.hasOwn(LEVEL_RANK, value) ? value : level(value)
    if (!Object.hasOwn(LEVEL_RANK, normalized)) continue
    if (worst === undefined || LEVEL_RANK[normalized] > LEVEL_RANK[worst]) worst = normalized
  }
  return worst ?? LEVEL.UNKNOWN
}

/**
 * Read a map of gate fields out of a caller object.
 *
 * @param raw - the caller's object (may be undefined).
 * @param keys - the gate field names to read.
 * @returns one {@link GATE} value per key; absent keys are `UNKNOWN`.
 */
export function readGates(raw, keys) {
  const values = {}
  for (const key of keys) {
    const value = raw === undefined || raw === null ? undefined : raw[key]
    values[key] = gate(value)
  }
  return values
}

/**
 * Read a map of level fields out of a caller object.
 *
 * @param raw - the caller's object (may be undefined).
 * @param keys - the level field names to read.
 * @returns one {@link LEVEL} value per key; absent keys are `UNKNOWN`.
 */
export function readLevels(raw, keys) {
  const values = {}
  for (const key of keys) {
    const value = raw === undefined || raw === null ? undefined : raw[key]
    values[key] = level(value)
  }
  return values
}

/**
 * Diagnose a declaration that contradicts its own supporting evidence.
 *
 * 方案 §4.2: conflicting evidence is recorded as `CONFLICTING_EVIDENCE` and the
 * more conservative reading is used; the optimistic input is never silently
 * believed.
 *
 * @param field - the field the conflict belongs to.
 * @param declared - the caller's summary claim.
 * @param derived - the value derived from the caller's own detailed evidence.
 * @returns a gap entry, or `undefined` when there is no conflict.
 */
export function conflictOf(field, declared, derived) {
  if (declared === undefined || derived === undefined) return undefined
  if (declared === derived) return undefined
  return {
    field,
    code: EVIDENCE_CODE.CONFLICT,
    declared,
    derived,
    detail: `${field}=${declared} contradicts the supplied evidence (${derived}); the more conservative value is used`,
  }
}

/**
 * Describe an evidence gap in the shape used by `missing_information`.
 *
 * @param field - where the gap is.
 * @param code - a stable {@link EVIDENCE_CODE} (or a module-specific code).
 * @param detail - one readable sentence.
 * @returns the gap entry.
 */
export function gap(field, code, detail) {
  return { field, code, detail }
}

/** @returns whether a gate value permits automatic action (i.e. is `PASS`). */
export function isPass(value) {
  return gate(value) === GATE.PASS
}

/** @returns whether a gate value forbids the candidate outright. */
export function isFail(value) {
  return gate(value) === GATE.FAIL
}

/**
 * Render a level for the model-facing audit trail: `UNKNOWN` is spelled out
 * rather than shown as a made-up severity.
 *
 * @param value - a level token.
 * @returns the audit string.
 */
export function describeLevel(value) {
  return Object.hasOwn(LEVEL_RANK, value) ? value : LEVEL.UNKNOWN
}
