/**
 * The versioned V2 tool, driven through the REAL registered tool (a real Cordis
 * context plus the real `defineTool`), using `exec.agent.id` exactly as the
 * runtime supplies it.
 *
 * The properties that matter here are the ones the plan calls security rules:
 *   - V1 keeps its own tool and its own behaviour, untouched;
 *   - a stale decision_revision can never close a newer decision;
 *   - the V1 and V2 contracts never drive each other's items;
 *   - an approval-pending item authorises nothing.
 *
 * NOTE: this file needs the host's `@deepseek-ai/dsh-tools`, so it requires a
 * DSH installation. The pure ledger tests live in `ledger-v2.test.mjs`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'

const plugin = await import('../lib/index.js')

/** Apply the plugin with a given config and return the registered tools. */
function applyWith(config) {
  const ctx = new Context()
  const sections = []
  const tools = []
  ctx.provide('systemPrompt', {
    getSectionOrder: () => 116,
    section: (section) => {
      sections.push(section)
      return () => {}
    },
  })
  ctx.provide('tools', {
    register: (definition) => {
      tools.push(definition)
      return () => {}
    },
  })
  ctx.effect = (callback) => callback()
  plugin.apply(ctx, plugin.Config(config))
  return { tools, sections }
}

/** The V2 tool with every session allowed. */
function makeV2Tool(config = {}) {
  const { tools } = applyWith({ enableDecisionV2: true, ...config })
  return tools.find((tool) => tool.name === 'confirmation_resolution_v2')
}

const execFor = (sessionId) => ({ agent: { id: sessionId } })

/** A V2 request whose decision is MODIFY. */
function v2Call(id, overrides = {}) {
  return {
    schema_version: '2.0',
    confirmation_id: id,
    current_state: `${id} 当前状态`,
    original_confirmation: `${id} 是否需要调整？`,
    user_reply: `${id} 修改`,
    context: { scenario: 'code_change', user_goal: `${id} 修复缺陷`, goal_source: 'USER_STATED' },
    authorization: { verification: 'PASS' },
    candidates: [
      { id: 'KEEP', kind: 'KEEP_CURRENT' },
      {
        id: 'A',
        kind: 'MODIFY',
        approach: `${id} 只改必要的一处`,
        scope: 'component',
        reversibility: 'reversible',
        evidence_state: 'PASS',
        goal_fit: 'HIGH',
        user_value: 'MEDIUM',
        output_quality: 'HIGH',
        impact_risk: 'LOW',
        execution_cost: 'LOW',
        long_term_value: 'MEDIUM',
      },
    ],
    ...overrides,
  }
}

// ── 双版本共存 ─────────────────────────────────────────────────────────────
test('the default configuration registers exactly one tool and one section (V1 only)', () => {
  const { tools, sections } = applyWith({})
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'confirmation_resolution')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'confirmation:policy')
})

test('enabling V2 adds a second tool and a second section without touching V1', () => {
  const { tools, sections } = applyWith({ enableDecisionV2: true })
  assert.deepEqual(tools.map((tool) => tool.name), ['confirmation_resolution', 'confirmation_resolution_v2'])
  assert.equal(sections.length, 2)
  assert.equal(sections[0].name, 'confirmation:policy')
  assert.equal(sections[1].name, 'confirmation:policy.v2')
  assert.ok(sections[1].text.includes('REQUEST_APPROVAL'))
  assert.ok(sections[1].order > sections[0].order)
  // The V1 tool keeps its own schema and status vocabulary.
  assert.deepEqual(tools[0].parameters.properties.action.enum, ['register', 'decide', 'complete'])
  assert.deepEqual(tools[1].parameters.properties.operation.enum, ['register', 'decide', 'complete', 'approve'])
})

test('the V2 schema is registry-ready', () => {
  const tool = makeV2Tool()
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.parameters.required.includes('schema_version'))
  assert.ok(tool.parameters.required.includes('confirmation_id'))
  assert.ok(tool.output !== undefined && typeof tool.output.render === 'function')
})

// ── 状态机 ────────────────────────────────────────────────────────────────
test('register → decide → complete is the only path to RESOLVED', async () => {
  const tool = makeV2Tool()
  const exec = execFor('v2-flow')
  const registered = await tool.execute({ ...v2Call('C1'), operation: 'register' }, exec)
  assert.equal(registered.outcome, 'REGISTERED')
  assert.equal(registered.lifecycle_status, 'PENDING')
  assert.equal(registered.executable, false)

  const decided = await tool.execute({ ...v2Call('C1'), operation: 'decide' }, exec)
  assert.equal(decided.outcome, 'MODIFY')
  assert.equal(decided.lifecycle_status, 'AWAITING_EXECUTION')
  assert.equal(decided.executable, true)
  assert.equal(decided.decision_revision, 1)
  assert.equal(decided.selected_solution_id, 'A')

  const completed = await tool.execute({ ...v2Call('C1'), operation: 'complete', decision_revision: 1 }, exec)
  assert.equal(completed.outcome, 'REGISTERED')
  assert.equal(completed.lifecycle_status, 'RESOLVED')
})

test('complete without a decision_revision is refused, not treated as any revision', async () => {
  const tool = makeV2Tool()
  const exec = execFor('v2-norev')
  await tool.execute({ ...v2Call('C1'), operation: 'register' }, exec)
  await tool.execute({ ...v2Call('C1'), operation: 'decide' }, exec)
  const refused = await tool.execute({ ...v2Call('C1'), operation: 'complete' }, exec)
  assert.equal(refused.outcome, 'NOT_APPLICABLE')
  assert.ok(refused.reason_codes.includes('MISSING_DECISION_REVISION'))
  assert.equal(refused.executable, false)
})

test('T11 — a stale revision cannot complete a newer decision', async () => {
  const tool = makeV2Tool()
  const exec = execFor('v2-stale')
  await tool.execute({ ...v2Call('C1'), operation: 'register' }, exec)
  await tool.execute({ ...v2Call('C1'), operation: 'decide' }, exec)
  const second = await tool.execute({ ...v2Call('C1'), operation: 'decide' }, exec)
  assert.equal(second.decision_revision, 2)

  const stale = await tool.execute({ ...v2Call('C1'), operation: 'complete', decision_revision: 1 }, exec)
  assert.equal(stale.outcome, 'NOT_APPLICABLE')
  assert.ok(stale.reason_codes.includes('STALE_DECISION_REVISION'))

  const fresh = await tool.execute({ ...v2Call('C1'), operation: 'complete', decision_revision: 2 }, exec)
  assert.equal(fresh.lifecycle_status, 'RESOLVED')
})

test('T18 — a failed execution is not completed, so the item stays awaiting execution', async () => {
  const tool = makeV2Tool()
  const exec = execFor('v2-execfail')
  await tool.execute({ ...v2Call('C1'), operation: 'register' }, exec)
  await tool.execute({ ...v2Call('C1'), operation: 'decide' }, exec)
  // DSH reports a failed run by NOT calling complete; a retry must re-decide.
  const retry = await tool.execute({ ...v2Call('C1'), operation: 'decide' }, exec)
  assert.equal(retry.lifecycle_status, 'AWAITING_EXECUTION')
  assert.equal(retry.decision_revision, 2)
  // The first attempt's authorisation is gone.
  const stale = await tool.execute({ ...v2Call('C1'), operation: 'complete', decision_revision: 1 }, exec)
  assert.equal(stale.outcome, 'NOT_APPLICABLE')
})

test('a re-decide that ends INSUFFICIENT_CONTEXT revokes the previous authorisation', async () => {
  const tool = makeV2Tool()
  const exec = execFor('v2-revoke')
  await tool.execute({ ...v2Call('C1'), operation: 'register' }, exec)
  await tool.execute({ ...v2Call('C1'), operation: 'decide' }, exec)
  const insufficient = await tool.execute({
    ...v2Call('C1', { authorization: {} }),
    operation: 'decide',
  }, exec)
  assert.equal(insufficient.outcome, 'INSUFFICIENT_CONTEXT')
  assert.equal(insufficient.lifecycle_status, 'PENDING')
  const refused = await tool.execute({ ...v2Call('C1'), operation: 'complete', decision_revision: 1 }, exec)
  assert.equal(refused.outcome, 'NOT_APPLICABLE')
  assert.ok(
    refused.reason_codes.includes('ITEM_NOT_AWAITING_EXECUTION'),
    refused.reason_codes.join(','),
  )
})

// ── 审批 ──────────────────────────────────────────────────────────────────
test('REQUEST_APPROVAL parks the item and authorises nothing', async () => {
  const tool = makeV2Tool()
  const exec = execFor('v2-approval')
  const call = v2Call('C1', {
    context: { scenario: 'external_action', user_goal: '清理生产数据', goal_source: 'USER_STATED' },
    candidates: [
      { id: 'KEEP', kind: 'KEEP_CURRENT' },
      {
        id: 'DELETE',
        kind: 'MODIFY',
        approach: '删除生产库中的历史分区',
        scope: 'component',
        evidence_state: 'PASS',
        goal_fit: 'HIGH',
        impact_risk: 'HIGH',
        irreversible_effect: true,
        external_effect: true,
      },
    ],
  })
  await tool.execute({ ...call, operation: 'register' }, exec)
  const decided = await tool.execute({ ...call, operation: 'decide' }, exec)
  assert.equal(decided.outcome, 'REQUEST_APPROVAL')
  assert.equal(decided.lifecycle_status, 'AWAITING_APPROVAL')
  assert.equal(decided.approval_required, true)
  assert.equal(typeof decided.approval_question, 'string')
  assert.equal(decided.executable, false)
  assert.equal(decided.selected_solution_id, null)

  const refused = await tool.execute({ ...call, operation: 'complete', decision_revision: decided.decision_revision }, exec)
  assert.equal(refused.outcome, 'NOT_APPLICABLE')
  assert.ok(refused.reason_codes.includes('ITEM_AWAITING_APPROVAL'))
})

test('approve is refused: this host exposes no verifiable approval source', async () => {
  const tool = makeV2Tool()
  const exec = execFor('v2-approve')
  await tool.execute({ ...v2Call('C1'), operation: 'register' }, exec)
  const refused = await tool.execute({ ...v2Call('C1'), operation: 'approve' }, exec)
  assert.equal(refused.outcome, 'NOT_APPLICABLE')
  assert.ok(refused.reason_codes.includes('NO_VERIFIABLE_APPROVAL_SOURCE'))
  assert.equal(refused.executable, false)
})

// ── 守卫 ──────────────────────────────────────────────────────────────────
test('T12 — an unregistered id is refused before any decision is computed', async () => {
  const tool = makeV2Tool()
  const refused = await tool.execute({ ...v2Call('C9'), operation: 'decide' }, execFor('v2-unknown'))
  assert.equal(refused.outcome, 'NOT_APPLICABLE')
  assert.ok(refused.reason_codes.includes('UNKNOWN_CONFIRMATION_ITEM'))
})

test('T13 — re-registering a resolved id with the same text is refused', async () => {
  const tool = makeV2Tool()
  const exec = execFor('v2-sametext')
  await tool.execute({ ...v2Call('C1'), operation: 'register' }, exec)
  await tool.execute({ ...v2Call('C1'), operation: 'decide' }, exec)
  await tool.execute({ ...v2Call('C1'), operation: 'complete', decision_revision: 1 }, exec)
  const refused = await tool.execute({ ...v2Call('C1'), operation: 'register' }, exec)
  assert.equal(refused.outcome, 'NOT_APPLICABLE')
  assert.ok(refused.reason_codes.includes('ITEM_ALREADY_RESOLVED'))
})

test('T14 — a resolved id reopens as a new round on new text and cannot be completed by the old token', async () => {
  const tool = makeV2Tool()
  const exec = execFor('v2-newround')
  await tool.execute({ ...v2Call('C1'), operation: 'register' }, exec)
  await tool.execute({ ...v2Call('C1'), operation: 'decide' }, exec)
  await tool.execute({ ...v2Call('C1'), operation: 'complete', decision_revision: 1 }, exec)

  const round2 = await tool.execute({
    ...v2Call('C1', { original_confirmation: 'C1 第二轮问题？' }),
    operation: 'register',
  }, exec)
  assert.equal(round2.outcome, 'REGISTERED')
  assert.equal(round2.lifecycle_status, 'PENDING')
  const skipped = await tool.execute({ ...v2Call('C1'), operation: 'complete', decision_revision: 1 }, exec)
  assert.equal(skipped.outcome, 'NOT_APPLICABLE')
})

test('a number still in use cannot be re-registered', async () => {
  const tool = makeV2Tool()
  const exec = execFor('v2-open')
  await tool.execute({ ...v2Call('C1'), operation: 'register' }, exec)
  const refused = await tool.execute({ ...v2Call('C1'), operation: 'register' }, exec)
  assert.equal(refused.outcome, 'NOT_APPLICABLE')
  assert.ok(refused.reason_codes.includes('CONFIRMATION_ID_STILL_OPEN'))
})

test('an unsupported schema_version is rejected before execute() ever runs', async () => {
  const tool = makeV2Tool()
  const exec = execFor('v2-version')
  // The schema pins the version, so a wrong one is a named argument error rather
  // than a silently accepted call. `execute()` also re-checks it, as a second
  // layer for a caller that bypasses the registry.
  await assert.rejects(
    () => tool.execute({ ...v2Call('C1', { schema_version: '1.0' }), operation: 'register' }, exec),
    (error) => error.code === 'INVALID_ARGS' || /schema_version/.test(String(error.message)),
  )
  const accepted = await tool.execute({ ...v2Call('C1'), operation: 'register' }, exec)
  assert.equal(accepted.outcome, 'REGISTERED')
})

test('decide without a user_reply is insufficient context, not a ledger write', async () => {
  const tool = makeV2Tool()
  const exec = execFor('v2-noreply')
  await tool.execute({ ...v2Call('C1'), operation: 'register' }, exec)
  const call = { ...v2Call('C1'), operation: 'decide' }
  delete call.user_reply
  const refused = await tool.execute(call, exec)
  assert.equal(refused.outcome, 'INSUFFICIENT_CONTEXT')
  assert.match(refused.missing_information.join('\n'), /REQUIRED_FOR_DECIDE/)
  assert.equal(refused.lifecycle_status, 'PENDING')
})

// ── 版本隔离与会话隔离 ────────────────────────────────────────────────────
test('the two contracts can never drive each other’s items', async () => {
  const { tools } = applyWith({ enableDecisionV2: true })
  const v1 = tools.find((tool) => tool.name === 'confirmation_resolution')
  const v2 = tools.find((tool) => tool.name === 'confirmation_resolution_v2')
  const exec = execFor('v2-mixed')

  // A V1 registration is invisible to V2.
  await v1.execute({
    confirmation_id: 'C1',
    current_state: '现状',
    original_confirmation: '问题？',
    user_goal: '目标',
    quality_impact: 'NONE',
    candidate_solutions: [{ label: 'a', approach: '做法', scope: 'component' }],
    action: 'register',
  }, exec)
  const crossV2 = await v2.execute({ ...v2Call('C1'), operation: 'decide' }, exec)
  assert.equal(crossV2.outcome, 'NOT_APPLICABLE')
  assert.ok(crossV2.reason_codes.includes('ITEM_VERSION_MISMATCH'))

  // And a V2 registration is invisible to V1.
  await v2.execute({ ...v2Call('C2'), operation: 'register' }, exec)
  const crossV1 = await v1.execute({
    confirmation_id: 'C2',
    current_state: '现状',
    original_confirmation: '问题？',
    user_reply: '修改',
    user_goal: '目标',
    quality_impact: 'NONE',
    candidate_solutions: [{ label: 'a', approach: '做法', scope: 'component' }],
    action: 'decide',
  }, exec)
  assert.equal(crossV1.status, 'NOT_APPLICABLE')
  assert.match(crossV1.selection_reason, /ITEM_VERSION_MISMATCH/)
})

test('an empty allow-list admits every session, a populated one only the listed ids', async () => {
  const open = makeV2Tool()
  const allowed = await open.execute({ ...v2Call('C1'), operation: 'register' }, execFor('v2-any-session'))
  assert.equal(allowed.outcome, 'REGISTERED')

  const restricted = makeV2Tool({ decisionV2Sessions: ['s-allowed'] })
  const refused = await restricted.execute({ ...v2Call('C2'), operation: 'register' }, execFor('v2-other-session'))
  assert.equal(refused.outcome, 'NOT_APPLICABLE')
  assert.ok(refused.reason_codes.includes('SESSION_NOT_ENABLED_FOR_V2'))
  const admitted = await restricted.execute({ ...v2Call('C3'), operation: 'register' }, execFor('s-allowed'))
  assert.equal(admitted.outcome, 'REGISTERED')
})

// ── render ────────────────────────────────────────────────────────────────
test('render() reports the outcome, revision and executability', async () => {
  const tool = makeV2Tool()
  const exec = execFor('v2-render')
  await tool.execute({ ...v2Call('C1'), operation: 'register' }, exec)
  const decided = await tool.execute({ ...v2Call('C1'), operation: 'decide' }, exec)
  const blocks = tool.output.render({}, decided)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  for (const label of ['OUTCOME: MODIFY', 'LIFECYCLE_STATUS: AWAITING_EXECUTION', 'DECISION_REVISION: 1', 'EXECUTABLE: YES']) {
    assert.ok(blocks[0].text.includes(label), `missing ${label}\n${blocks[0].text}`)
  }
})

test('the V1 tool description and output schema are unchanged by the V2 addition', () => {
  const { tools } = applyWith({ enableDecisionV2: true })
  const v1 = tools[0]
  assert.deepEqual(v1.output.schema.properties.status.enum, ['READY_TO_EXECUTE', 'INSUFFICIENT_CONTEXT', 'REGISTERED', 'NOT_APPLICABLE'])
  assert.deepEqual(v1.output.schema.properties.confirmation_state.enum, ['PENDING', 'AWAITING_EXECUTION', 'RESOLVED', 'UNCHANGED'])
  assert.ok(v1.description.includes('调用纪律'))
})

test('module-level ledgers stay session-keyed for V2 too', async () => {
  const tool = makeV2Tool()
  await tool.execute({ ...v2Call('C1'), operation: 'register' }, execFor('v2-session-a'))
  const other = await tool.execute({ ...v2Call('C1'), operation: 'decide' }, execFor('v2-session-b'))
  assert.equal(other.outcome, 'NOT_APPLICABLE')
  assert.ok(other.reason_codes.includes('UNKNOWN_CONFIRMATION_ITEM'))
})
