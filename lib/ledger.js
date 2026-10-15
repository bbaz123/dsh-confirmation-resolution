/**
 * Session-scoped confirmation ledger — the code-level half of the trigger guard.
 *
 * 01's activation scope is a System Prompt rule, and a prompt rule is a request,
 * not an enforcement point: nothing stops a model from calling the tool during an
 * ordinary task. This ledger is the enforcement point. It records, per agent
 * session, which C-numbers were actually published to the user and which are
 * still open, so the tool can reject a call that cannot belong to a confirmation
 * flow:
 *
 *   - an unknown C-number (nothing was ever published under it) → NOT_APPLICABLE
 *   - an already RESOLVED C-number unless the item is re-published → NOT_APPLICABLE
 *
 * It is deliberately a small in-process map keyed by `exec.agent.id` (the live
 * SessionId), owned by one host-plane plugin row:
 *
 *   - keys are session ids, so two sessions never see each other's C-numbers;
 *   - the registry is cleared when the plugin row unloads (see `ctx.effect`);
 *   - entries are plain JSON scalars, never live DSH objects.
 *
 * It is NOT durable: a DSH restart empties it. That is acceptable for the guard,
 * because a restarted process also loses the conversation that the C-numbers
 * belonged to — but it is a real limitation and is documented as such.
 *
 * @module dsh-plugin-confirmation-resolution/ledger
 */

/** Confirmation item states, per 01 §8 plus the execution window this module enforces. */
export const ITEM_STATE = Object.freeze({
  /** Published, waiting for the user's reply / for a decision. */
  PENDING: 'PENDING',
  /**
   * A MODIFY decision exists and the real execution has NOT been reported yet.
   * Only items in this state may be completed, which is what makes
   * `register → decide → execute → complete` a code-level contract instead of a
   * request the model could skip.
   */
  AWAITING_EXECUTION: 'AWAITING_EXECUTION',
  /**
   * V2 only (方案 §6.2): the decision chose a high-impact candidate that needs the
   * user's explicit approval before anything may be executed. Nothing is
   * authorised in this state, and `complete` is refused.
   */
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  RESOLVED: 'RESOLVED',
})

/** Contract versions a ledger item can belong to. V1 and V2 never mix. */
export const ITEM_VERSION = Object.freeze({ V1: '1', V2: '2' })

/** Why a guarded call was refused; stable codes so callers can branch. */
export const REJECTION = Object.freeze({
  UNKNOWN_ITEM: 'UNKNOWN_CONFIRMATION_ITEM',
  ALREADY_RESOLVED: 'ITEM_ALREADY_RESOLVED',
  NO_AGENT: 'NO_CALLING_SESSION',
  EMPTY_ID: 'EMPTY_CONFIRMATION_ID',
  /** The same C-number is still in use, so it must not be re-registered. */
  ITEM_STILL_OPEN: 'CONFIRMATION_ID_STILL_OPEN',
  /** `complete` was called for an item with no executable decision behind it. */
  NOT_AWAITING_EXECUTION: 'ITEM_NOT_AWAITING_EXECUTION',
  /** The item belongs to the other contract version (V1 vs V2) — never mixed. */
  VERSION_MISMATCH: 'ITEM_VERSION_MISMATCH',
  /** `complete` arrived carrying a revision that is not the outstanding one. */
  STALE_DECISION_REVISION: 'STALE_DECISION_REVISION',
  /** The item is waiting for the user's approval, so nothing may be completed. */
  AWAITING_APPROVAL: 'ITEM_AWAITING_APPROVAL',
  /** The calling session is not on the V2 allow-list. */
  SESSION_NOT_ENABLED: 'SESSION_NOT_ENABLED_FOR_V2',
  /**
   * `approve` was called, but this host exposes no verifiable user-confirmation
   * event to a tool body, so a model-supplied boolean must never be trusted
   * (方案 §6.2 rule 2, rule 5).
   */
  NO_VERIFIABLE_APPROVAL: 'NO_VERIFIABLE_APPROVAL_SOURCE',
})

/** Cap per session so a pathological caller cannot grow the ledger without bound. */
const MAX_ITEMS_PER_SESSION = 50

/**
 * One session's confirmation items. Pure state container: no I/O, no timers, and
 * every method answers with plain JSON scalars so the ledger stays testable.
 */
export class ConfirmationLedger {
  /**
   * `version` records which contract opened the item ('1' for V1, '2' for V2);
   * `decisionRevision` is a per-item counter that is bumped by every V2 decision
   * attempt and is the token `complete` must present, so a stale authorisation
   * can never close a newer decision (方案 §6.2 rules 1 and 3).
   *
   * @type {Map<string, { id: string, originalConfirmation: string, currentState: string, state: string, userGoal: string, version: string, publishedAt: number, resolvedAt?: number, round?: number, decisionRevision?: number, decisionOutcome?: string, authorizedRevision?: number, approval?: object }>}
   */
  #items = new Map()

  /** @returns {number} how many C-numbers this session currently holds. */
  size() {
    return this.#items.size
  }

  /**
   * Record (or re-record) a published confirmation item.
   *
   * Re-registering an id that is already RESOLVED with the SAME original text is
   * treated as a no-op: the item stays resolved, because re-publishing identical
   * text must not resurrect a closed item. Registering the same id with DIFFERENT
   * text opens a NEW ROUND under that number (a user finishing a second task in
   * one long session naturally starts again at C1), so the item returns to
   * PENDING with every decision artefact cleared. The user only ever sees `C1`;
   * the round boundary lives here.
   *
   * @param id - the stable C-number.
   * @param fields - the item's text and, when known, the inferred goal.
   * @returns the item's state after registration.
   */
  register(id, fields = {}) {
    const normalizedId = String(id ?? '').trim()
    if (normalizedId === '') throw new Error('confirmation_id is empty')
    const existing = this.#items.get(normalizedId)
    const originalConfirmation = String(fields.originalConfirmation ?? '')
    const currentState = String(fields.currentState ?? '')
    const userGoal = String(fields.userGoal ?? '')
    const version = fields.version === ITEM_VERSION.V2 ? ITEM_VERSION.V2 : ITEM_VERSION.V1
    if (existing !== undefined) {
      // An id that is still in use must never be overwritten: register would
      // otherwise silently discard a live item's decision (PENDING waiting for a
      // reply, or AWAITING_EXECUTION waiting for the execution report).
      if (existing.state !== ITEM_STATE.RESOLVED) {
        throw new Error(`${normalizedId} is still open (${existing.state}); resolve it before reusing this confirmation id`)
      }
      // Closed with identical text: that is a duplicate registration, not a new
      // round, so the item stays closed.
      if (existing.originalConfirmation === originalConfirmation) return existing.state
      // Closed with NEW text: a new round under the same number. Roll the text
      // forward, but keep the recorded goal when this call brings none — a blank
      // would silently destroy the goal the previous round learned.
      existing.originalConfirmation = originalConfirmation
      existing.currentState = currentState
      if (userGoal !== '') existing.userGoal = userGoal
      // A new round belongs to the contract that opened it; the decision
      // revision keeps counting up so an older round's token can never match.
      existing.version = version
      return this.#resetToPending(existing)
    }
    if (this.#items.size >= MAX_ITEMS_PER_SESSION) {
      // Evict the oldest RESOLVED item; if everything is still open, refuse to
      // grow rather than silently dropping an open item.
      const closed = [...this.#items.values()]
        .filter((item) => item.state === ITEM_STATE.RESOLVED)
        .sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0))[0]
      if (closed === undefined) throw new Error(`confirmation ledger is full (${MAX_ITEMS_PER_SESSION} open items)`)
      this.#items.delete(closed.id)
    }
    this.#items.set(normalizedId, {
      id: normalizedId,
      originalConfirmation,
      currentState,
      userGoal,
      version,
      state: ITEM_STATE.PENDING,
      decisionAction: undefined,
      decisionAt: undefined,
      decisionRevision: 0,
      decisionOutcome: undefined,
      authorizedRevision: undefined,
      approval: undefined,
      resolvedAt: undefined,
      round: 1,
      publishedAt: Date.now(),
    })
    return ITEM_STATE.PENDING
  }

  /**
   * Return one item to PENDING for a new round, clearing every decision artefact
   * so an earlier round's decision can never authorise this round's completion.
   *
   * @param item - the live item record.
   * @returns the item's new state.
   */
  #resetToPending(item) {
    item.state = ITEM_STATE.PENDING
    item.decisionAction = undefined
    item.decisionAt = undefined
    item.decisionOutcome = undefined
    // Every outstanding V2 authorisation and approval belongs to the previous
    // round, so both are cleared when a new round opens.
    item.authorizedRevision = undefined
    item.approval = undefined
    item.resolvedAt = undefined
    item.round = (item.round ?? 1) + 1
    return item.state
  }

  /**
   * Look up one item without changing it.
   * @param id - the stable C-number.
   * @returns the item's snapshot, or `undefined` when it was never published.
   */
  get(id) {
    const item = this.#items.get(String(id ?? '').trim())
    return item === undefined ? undefined : { ...item }
  }

  /**
   * Decide whether a call may proceed, before any decision is computed.
   *
   * @param id - the C-number the caller claims to be resolving.
   * @param options - `{ version }` restricts the call to one contract version.
   * @returns `{ ok: true }` or `{ ok: false, code, reason }`.
   */
  guard(id, options = {}) {
    const normalizedId = String(id ?? '').trim()
    if (normalizedId === '') return { ok: false, code: REJECTION.EMPTY_ID, reason: 'confirmation_id is empty' }
    const item = this.#items.get(normalizedId)
    if (item === undefined) {
      return {
        ok: false,
        code: REJECTION.UNKNOWN_ITEM,
        reason: `${normalizedId} was never published as a confirmation item in this session`,
      }
    }
    const expectedVersion = options.version
    if (expectedVersion !== undefined && (item.version ?? ITEM_VERSION.V1) !== expectedVersion) {
      return {
        ok: false,
        code: REJECTION.VERSION_MISMATCH,
        reason: `${normalizedId} was opened by the ${item.version === ITEM_VERSION.V2 ? 'V2' : 'V1'} contract and cannot be driven by the other one`,
      }
    }
    if (item.state === ITEM_STATE.RESOLVED) {
      return {
        ok: false,
        code: REJECTION.ALREADY_RESOLVED,
        reason: `${normalizedId} is already RESOLVED and has not been re-published with new text`,
      }
    }
    return { ok: true }
  }

  /**
   * Decide whether a `complete` call may close this item.
   *
   * This is the check that makes the state machine real: an item may only be
   * completed when a MODIFY decision is outstanding, i.e. the caller really went
   * through `decide` and is now reporting the execution. Without it, `complete`
   * would close any open item and `register → complete` would bypass the
   * decision entirely.
   *
   * @param id - the C-number the caller claims to have executed.
   * @param options - `{ version, revision }`. `revision` is required by the V2
   *   contract: it must be the revision the outstanding decision returned, so a
   *   stale authorisation cannot close a newer decision (方案 §6.2 rule 3).
   * @returns `{ ok: true }` or `{ ok: false, code, reason }`.
   */
  guardComplete(id, options = {}) {
    const normalizedId = String(id ?? '').trim()
    if (normalizedId === '') return { ok: false, code: REJECTION.EMPTY_ID, reason: 'confirmation_id is empty' }
    const item = this.#items.get(normalizedId)
    if (item === undefined) {
      return {
        ok: false,
        code: REJECTION.UNKNOWN_ITEM,
        reason: `${normalizedId} was never published as a confirmation item in this session`,
      }
    }
    const expectedVersion = options.version
    if (expectedVersion !== undefined && (item.version ?? ITEM_VERSION.V1) !== expectedVersion) {
      return {
        ok: false,
        code: REJECTION.VERSION_MISMATCH,
        reason: `${normalizedId} was opened by the ${item.version === ITEM_VERSION.V2 ? 'V2' : 'V1'} contract and cannot be completed by the other one`,
      }
    }
    if (item.state === ITEM_STATE.AWAITING_APPROVAL) {
      return {
        ok: false,
        code: REJECTION.AWAITING_APPROVAL,
        reason: `${normalizedId} is waiting for the user's approval; nothing may be completed before the user decides`,
      }
    }
    if (item.state === ITEM_STATE.AWAITING_EXECUTION) {
      if (options.revision !== undefined && item.authorizedRevision !== options.revision) {
        return {
          ok: false,
          code: REJECTION.STALE_DECISION_REVISION,
          reason: `${normalizedId} was authorised at revision ${item.authorizedRevision ?? 'none'}, not ${options.revision}; re-decide before completing`,
        }
      }
      return { ok: true }
    }
    const detail = item.state === ITEM_STATE.RESOLVED
      ? 'it is already RESOLVED'
      : 'no MODIFY decision is outstanding for it (call decide first)'
    return {
      ok: false,
      code: REJECTION.NOT_AWAITING_EXECUTION,
      reason: `${normalizedId} cannot be completed: ${detail}`,
    }
  }

  /**
   * Record the decision that a `decide` call just produced.
   *
   * A MODIFY decision moves the item to AWAITING_EXECUTION, which is the only
   * state `complete` accepts; any other action (or a non-executable status)
   * leaves it PENDING. Re-deciding an item that already awaits execution simply
   * overwrites the outstanding decision, so a retry after a failed run works.
   *
   * @param id - the stable C-number.
   * @param action - the decision's ACTION (`MODIFY` / `KEEP_CURRENT`).
   * @returns the item's state after the call.
   */
  markDecided(id, action) {
    const normalizedId = String(id ?? '').trim()
    const item = this.#items.get(normalizedId)
    if (item === undefined) throw new Error(`cannot record a decision for unknown confirmation item ${normalizedId}`)
    item.decisionAction = action
    item.decisionAt = Date.now()
    item.state = action === 'MODIFY' ? ITEM_STATE.AWAITING_EXECUTION : ITEM_STATE.PENDING
    return item.state
  }

  /**
   * Start a fresh decision attempt, invalidating any previous authorisation.
   *
   * A `decide` call supersedes whatever the previous decision authorised: if the
   * item was AWAITING_EXECUTION and the new attempt turns out to be
   * INSUFFICIENT_CONTEXT, the old MODIFY authorisation must NOT survive — it would
   * let `complete` close an item whose latest judgement was "not enough
   * information". So the item returns to PENDING before the decision is computed,
   * and only a READY result re-establishes an authorisation.
   *
   * @param id - the stable C-number.
   * @returns the item's state at the start of the attempt.
   */
  beginDecision(id) {
    const normalizedId = String(id ?? '').trim()
    if (normalizedId === '') throw new Error('confirmation_id is empty')
    const item = this.#items.get(normalizedId)
    if (item === undefined) throw new Error(`cannot begin decision for unknown confirmation item ${normalizedId}`)
    if (item.state === ITEM_STATE.RESOLVED) throw new Error(`cannot re-decide resolved confirmation item ${normalizedId}`)
    if (item.state === ITEM_STATE.AWAITING_EXECUTION) {
      item.state = ITEM_STATE.PENDING
      item.decisionAction = undefined
      item.decisionAt = undefined
    }
    return item.state
  }

  /**
   * The outstanding decision for one item, for reporting.
   * @param id - the stable C-number.
   * @returns the decision action and state, or `undefined` when unknown.
   */
  decisionOf(id) {
    const item = this.#items.get(String(id ?? '').trim())
    if (item === undefined) return undefined
    return {
      state: item.state,
      action: item.decisionAction,
      round: item.round ?? 1,
      version: item.version ?? ITEM_VERSION.V1,
      revision: item.decisionRevision ?? 0,
      authorizedRevision: item.authorizedRevision,
      outcome: item.decisionOutcome,
      approval: item.approval,
    }
  }

  /**
   * Start a V2 decision attempt (方案 §6.2 rule 1).
   *
   * Every attempt bumps `decisionRevision` and clears the previous approval and
   * execution authorisation BEFORE the new decision is computed. That is what
   * makes "the latest judgement was INSUFFICIENT_CONTEXT, but the old MODIFY
   * authorisation still closes it" impossible: the only token `complete` accepts
   * is the one this attempt will hand out, and it is never handed out unless the
   * outcome is MODIFY.
   *
   * @param id - the stable C-number.
   * @returns `{ revision, state }` for the attempt.
   */
  beginDecisionV2(id) {
    const normalizedId = String(id ?? '').trim()
    if (normalizedId === '') throw new Error('confirmation_id is empty')
    const item = this.#items.get(normalizedId)
    if (item === undefined) throw new Error(`cannot begin a decision for unknown confirmation item ${normalizedId}`)
    if (item.state === ITEM_STATE.RESOLVED) throw new Error(`cannot re-decide resolved confirmation item ${normalizedId}`)
    item.decisionRevision = (item.decisionRevision ?? 0) + 1
    item.decisionOutcome = undefined
    item.decisionAction = undefined
    item.decisionAt = undefined
    item.approval = undefined
    item.authorizedRevision = undefined
    item.state = ITEM_STATE.PENDING
    return { revision: item.decisionRevision, state: item.state }
  }

  /**
   * Record the outcome of a V2 decision.
   *
   * Only `MODIFY` leaves an executable authorisation behind. `KEEP_CURRENT` is
   * self-completing, `REQUEST_APPROVAL` parks the item without any permission,
   * and `INSUFFICIENT_CONTEXT` / `REJECT` return it to PENDING with nothing
   * authorised.
   *
   * @param id - the stable C-number.
   * @param outcome - one V2 decision outcome.
   * @returns the item's state after the call.
   */
  markDecidedV2(id, outcome) {
    const normalizedId = String(id ?? '').trim()
    const item = this.#items.get(normalizedId)
    if (item === undefined) throw new Error(`cannot record a decision for unknown confirmation item ${normalizedId}`)
    item.decisionOutcome = outcome
    item.decisionAt = Date.now()
    if (outcome === 'MODIFY') {
      item.state = ITEM_STATE.AWAITING_EXECUTION
      item.authorizedRevision = item.decisionRevision
    } else if (outcome === 'REQUEST_APPROVAL') {
      item.state = ITEM_STATE.AWAITING_APPROVAL
      item.approval = { required: true, askedAt: Date.now(), revision: item.decisionRevision }
    } else if (outcome === 'KEEP_CURRENT') {
      item.state = ITEM_STATE.RESOLVED
      item.resolvedAt = Date.now()
    } else {
      item.state = ITEM_STATE.PENDING
    }
    return item.state
  }

  /**
   * The item's contract version, for a caller that must branch on it.
   * @param id - the stable C-number.
   * @returns the version token, or `undefined` when the item is unknown.
   */
  versionOf(id) {
    const item = this.#items.get(String(id ?? '').trim())
    return item === undefined ? undefined : (item.version ?? ITEM_VERSION.V1)
  }

  /**
   * Mark one item resolved after its decision was executed.
   * @param id - the stable C-number.
   * @returns the item's state after the call.
   */
  resolve(id) {
    const normalizedId = String(id ?? '').trim()
    const item = this.#items.get(normalizedId)
    if (item === undefined) throw new Error(`cannot resolve unknown confirmation item ${normalizedId}`)
    item.state = ITEM_STATE.RESOLVED
    item.resolvedAt = Date.now()
    return item.state
  }

  /**
   * The full ledger as data, for the tool's model-facing report. `round` is
   * included so a reused C-number in a later round is distinguishable to a
   * maintainer; the user only ever sees `C1`.
   * @returns one entry per item, ordered by C-number.
   */
  snapshot() {
    return [...this.#items.values()]
      .map((item) => ({ id: item.id, state: item.state, round: item.round ?? 1 }))
      .sort((a, b) => compareIds(a.id, b.id))
  }

  /** Drop everything (used when the owning row unloads). */
  clear() {
    this.#items.clear()
  }
}

/**
 * Order `C1`, `C2`, … `C10` numerically rather than lexicographically, so the
 * reported order stays stable past nine items.
 *
 * @param a - first C-number.
 * @param b - second C-number.
 * @returns comparison result.
 */
export function compareIds(a, b) {
  const na = Number.parseInt(String(a).replace(/^[^0-9]*/, ''), 10)
  const nb = Number.parseInt(String(b).replace(/^[^0-9]*/, ''), 10)
  if (Number.isInteger(na) && Number.isInteger(nb) && na !== nb) return na - nb
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

/**
 * Session-keyed store of ledgers, owned by one plugin row.
 *
 * Session ids are plain strings, so nothing live is retained: the map holds no
 * DSH object, no Agent, and no Session reference.
 */
export class ConfirmationLedgers {
  /** @type {Map<string, ConfirmationLedger>} */
  #bySession = new Map()

  /**
   * The ledger for one session, created on first use.
   * @param sessionId - the calling agent's live session id.
   * @returns the session's ledger.
   */
  for(sessionId) {
    let ledger = this.#bySession.get(sessionId)
    if (ledger === undefined) {
      ledger = new ConfirmationLedger()
      this.#bySession.set(sessionId, ledger)
    }
    return ledger
  }

  /** @returns how many sessions currently hold a ledger. */
  get sessionCount() {
    return this.#bySession.size
  }

  /** Drop every session's ledger (used when the owning row unloads). */
  clear() {
    for (const ledger of this.#bySession.values()) ledger.clear()
    this.#bySession.clear()
  }
}
