/**
 * Structured decision trace for the V2 engine (方案 §7 `lib/trace.js`).
 *
 * The trace exists so a human can answer "why was THIS chosen and THAT dropped"
 * without re-reading the caller's input. It returns data only: no logging, no
 * I/O, and no copies of the user's raw text beyond the short labels the caller
 * already supplied — 方案 §10.3 requires privacy minimization, so free-text
 * context is never duplicated here.
 *
 * @module dsh-plugin-confirmation-resolution/trace
 */

/**
 * One rejected candidate, in the shape the tool result exposes.
 * @param id - the candidate id.
 * @param reasonCode - a stable {@link import('./policies.js').REASON} member.
 * @param reason - one readable sentence.
 * @returns the rejection record.
 */
export function rejection(id, reasonCode, reason) {
  return { id: String(id), reason_code: reasonCode, reason }
}

/**
 * One evidence gap.
 * @param field - the field the gap belongs to.
 * @param code - a stable code.
 * @param detail - one readable sentence.
 * @returns the gap record.
 */
export function gapEntry(field, code, detail) {
  return { field, code, detail }
}

/**
 * Build the complete trace value.
 *
 * @param parts - the recorded steps of one decision.
 * @returns a JSON-serializable trace object.
 */
export function buildTrace(parts) {
  return {
    policy_version: parts.policyVersion,
    scenario: parts.scenario,
    goal_source: parts.goalSource,
    baseline_id: parts.baselineId,
    constructed_baseline: parts.constructedBaseline === true,
    hard_gate_results: parts.hardGateResults ?? [],
    pareto_front: parts.paretoFront ?? [],
    ranking: parts.ranking ?? [],
    selected_id: parts.selectedId ?? null,
    sensitivity: parts.sensitivity ?? { checked: false },
    gaps: parts.gaps ?? [],
    conflicts: parts.conflicts ?? [],
    approvals: parts.approvals ?? [],
    steps: parts.steps ?? [],
  }
}

/** @returns a short, deterministic description of one candidate for the trace. */
export function describeCandidate(candidate) {
  return {
    id: candidate.id,
    kind: candidate.kind,
    scope: candidate.scope,
    reversibility: candidate.reversibility,
    evidence_state: candidate.evidenceState,
    estimated: candidate.estimated === true,
  }
}
