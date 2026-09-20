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

/** Confirmation item states, per 01 §8. */
export const ITEM_STATE = Object.freeze({ PENDING: 'PENDING', RESOLVED: 'RESOLVED' })

/** Why a guarded call was refused; stable codes so callers can branch. */
export const REJECTION = Object.freeze({
  UNKNOWN_ITEM: 'UNKNOWN_CONFIRMATION_ITEM',
  ALREADY_RESOLVED: 'ITEM_ALREADY_RESOLVED',
  NO_AGENT: 'NO_CALLING_SESSION',
  EMPTY_ID: 'EMPTY_CONFIRMATION_ID',
})

/** Cap per session so a pathological caller cannot grow the ledger without bound. */
const MAX_ITEMS_PER_SESSION = 50

/**
 * One session's confirmation items. Pure state container: no I/O, no timers, and
 * every method answers with plain JSON scalars so the ledger stays testable.
 */
export class ConfirmationLedger {
  /** @type {Map<string, { id: string, originalConfirmation: string, currentState: string, state: string, userGoal: string, publishedAt: number, resolvedAt?: number }>} */
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
   * text is treated as a newly published item under a reused number (a rare but
   * legal case when a user starts a fresh round), so it returns to PENDING.
   *
   * @param id - the stable C-number.
   * @param fields - the item's text and, when known, the inferred goal.
   * @returns the item's state after registration.
   */
  register(id, fields = {}) {
    const existing = this.#items.get(id)
    const originalConfirmation = String(fields.originalConfirmation ?? '')
    const currentState = String(fields.currentState ?? '')
    const userGoal = String(fields.userGoal ?? '')
    if (existing !== undefined) {
      if (existing.state === ITEM_STATE.RESOLVED && existing.originalConfirmation === originalConfirmation) return existing.state
      existing.originalConfirmation = originalConfirmation
      existing.currentState = currentState
      if (userGoal !== '') existing.userGoal = userGoal
      existing.state = ITEM_STATE.PENDING
      delete existing.resolvedAt
      return existing.state
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
    this.#items.set(id, {
      id,
      originalConfirmation,
      currentState,
      userGoal,
      state: ITEM_STATE.PENDING,
      publishedAt: Date.now(),
    })
    return ITEM_STATE.PENDING
  }

  /**
   * Look up one item without changing it.
   * @param id - the stable C-number.
   * @returns the item's snapshot, or `undefined` when it was never published.
   */
  get(id) {
    const item = this.#items.get(id)
    return item === undefined ? undefined : { ...item }
  }

  /**
   * Decide whether a call may proceed, before any decision is computed.
   *
   * @param id - the C-number the caller claims to be resolving.
   * @returns `{ ok: true }` or `{ ok: false, code, reason }`.
   */
  guard(id) {
    if (id === '') return { ok: false, code: REJECTION.EMPTY_ID, reason: 'confirmation_id is empty' }
    const item = this.#items.get(id)
    if (item === undefined) {
      return {
        ok: false,
        code: REJECTION.UNKNOWN_ITEM,
        reason: `${id} was never published as a confirmation item in this session`,
      }
    }
    if (item.state === ITEM_STATE.RESOLVED) {
      return {
        ok: false,
        code: REJECTION.ALREADY_RESOLVED,
        reason: `${id} is already RESOLVED and has not been re-published with new text`,
      }
    }
    return { ok: true }
  }

  /**
   * Mark one item resolved after its decision was executed.
   * @param id - the stable C-number.
   * @returns the item's state after the call.
   */
  resolve(id) {
    const item = this.#items.get(id)
    if (item === undefined) throw new Error(`cannot resolve unknown confirmation item ${id}`)
    item.state = ITEM_STATE.RESOLVED
    item.resolvedAt = Date.now()
    return item.state
  }

  /**
   * The full ledger as data, for the tool's model-facing report.
   * @returns one entry per item, ordered by C-number.
   */
  snapshot() {
    return [...this.#items.values()]
      .map((item) => ({ id: item.id, state: item.state }))
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
