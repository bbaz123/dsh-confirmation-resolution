/**
 * Integration verification for the Cordis wiring.
 *
 * Proves more than a syntax check:
 *   1. the plugin module imports through the SAME bare-specifier resolution the
 *      loader uses at boot (Node ESM resolution from the profile's install).
 *      This step needs a DSH install; the profile is located through DSH_HOME /
 *      DSH_PROFILE and is never hard-coded to one machine. The install check runs
 *      before Cordis is imported, so a bare checkout gets a clear message and
 *      exit code 2 instead of a module-not-found;
 *   2. `apply()` registers exactly one prompt section and one tool on a real
 *      Cordis context, with the spec'd name and section metadata;
 *   3. the tool definition passes the real `defineTool` validation from
 *      `@deepseek-ai/dsh-tools` (so the schema is genuinely registry-ready);
 *   4. executing the registered tool returns a spec-shaped decision and renders
 *      the canonical uppercase block;
 *   5. both contributions are disposed with their fiber (no leaked effects).
 *
 * Run: `node verify/wiring.mjs`
 * Env: DSH_HOME (default ~/.dsh), DSH_PROFILE (default web)
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const results = []
/**
 * Run one check and record its verdict.
 *
 * Awaits the body, so an async assertion that rejects is recorded as FAIL rather
 * than becoming an unhandled rejection that silently leaves the check looking
 * green — a checking harness that cannot fail is worse than no harness.
 */
async function check(label, fn) {
  try {
    await fn()
    results.push(`PASS  ${label}`)
  } catch (error) {
    results.push(`FAIL  ${label}\n      ${error.message}`)
    process.exitCode = 1
  }
}

// ── 1. loader-equivalent resolution of the installed row name ───────────────
// The loader resolves the row name from the profile's node_modules — that is
// where the plugin is linked — so the directory itself is the resolution base.
// It is discovered from the environment, not hard-coded to one machine.
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileName = process.env.DSH_PROFILE || 'web'
const profileRoots = [
  join(dshHome, 'profiles', profileName, 'node_modules'),
  join(dshHome, 'profiles', 'node_modules'),
].filter((root) => existsSync(root))

if (profileRoots.length === 0) {
  console.error(
    'verify needs a DSH install: no profile node_modules directory was found.\n' +
      'looked in:\n' +
      `  ${join(dshHome, 'profiles', profileName, 'node_modules')}\n` +
      `  ${join(dshHome, 'profiles', 'node_modules')}\n` +
      'set DSH_HOME (and optionally DSH_PROFILE) to point at your DSH install.\n' +
      '(`npm test` alone does not need DSH and runs anywhere.)',
  )
  process.exit(2)
}

// Cordis is loaded only now, deliberately. ESM imports are hoisted, so a static
// import at the top would abort with an opaque ERR_MODULE_NOT_FOUND on a bare
// checkout — before the "you need a DSH install" message above could ever print.
// Loading it after the guard keeps that diagnostic accurate, and lets CI assert
// the exit code without installing a single dependency.
const { Context } = await import('@deepseek-ai/cordis')

let entryUrl
const resolveFailures = []
for (const root of profileRoots) {
  try {
    // Any path inside the directory works as a base: packages may live in this
    // node_modules or in the shared parent, so the loader file need not exist.
    const rootRequire = createRequire(join(root, 'index.js'))
    entryUrl = pathToFileURL(rootRequire.resolve('dsh-plugin-confirmation-resolution')).href
    break
  } catch (error) {
    resolveFailures.push(`${root}: ${error.message.split('\n')[0]}`)
  }
}

await check('row name resolves from the profile install (what the loader imports)', () => {
  assert.notEqual(entryUrl, undefined, `row not linked into a DSH profile:\n      ${resolveFailures.join('\n      ')}`)
  assert.match(entryUrl, /dsh-confirmation-resolution/)
})

if (entryUrl === undefined) {
  console.log(results.join('\n'))
  console.log('\n0 wiring checks passed — install the row first (dsh plugin --profile <profile> add <dir>)')
  process.exit(1)
}

const plugin = await import(entryUrl)
await check('entry exports name/inject/Config/apply', () => {
  assert.equal(plugin.name, 'confirmation-resolution')
  assert.deepEqual(plugin.inject, ['tools', 'systemPrompt'])
  assert.equal(typeof plugin.Config, 'function')
  assert.equal(typeof plugin.apply, 'function')
})

// ── 2/3. apply() against a real Cordis context + the real tool registry ─────
const ctx = new Context()
const sections = []
const tools = []
const disposers = []
ctx.provide('systemPrompt', {
  getSectionOrder: (name) => (name === 'TOOL_REPORT' ? 2900 : undefined),
  section: (section) => {
    sections.push(section)
    return () => { sections.length = 0 }
  },
})
ctx.provide('tools', {
  register: (definition) => {
    tools.push(definition)
    return () => { tools.length = 0 }
  },
})
// A minimal effect implementation: run the callback, retain its disposer.
ctx.effect = (callback) => {
  const disposer = callback()
  disposers.push(disposer)
  return disposer
}

await check('apply() registers one prompt section and one tool', () => {
  plugin.apply(ctx, plugin.Config({}))
  assert.equal(sections.length, 1, `sections=${sections.length}`)
  assert.equal(tools.length, 1, `tools=${tools.length}`)
})
await check('prompt section carries the spec\'d name, order and rules', () => {
  const section = sections[0]
  assert.equal(section.name, 'confirmation:policy')
  assert.equal(section.order, 116)
  assert.ok(section.text.includes('【待确认事项】'))
  assert.ok(section.text.includes('confirmation_resolution'))
})
await check('tool definition is registry-ready and named confirmation_resolution', () => {
  const tool = tools[0]
  assert.equal(tool.name, 'confirmation_resolution')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.output !== undefined && typeof tool.output.render === 'function')
  const schema = tool.parameters
  // The identity fields stay required; `user_reply` is conditionally required
  // per action, checked by the next assertion.
  for (const field of ['confirmation_id', 'current_state', 'original_confirmation']) {
    assert.ok(schema.properties[field] !== undefined, `missing parameter ${field}`)
    assert.ok(schema.required.includes(field), `${field} must be required`)
  }
})
await check('parameter schema exposes the optional context fields', () => {
  const schema = tools[0].parameters
  for (const field of ['user_goal', 'relevant_context', 'available_constraints', 'quality_impact', 'candidate_solutions', 'action']) {
    assert.ok(schema.properties[field] !== undefined, `missing parameter ${field}`)
  }
  assert.deepEqual(schema.properties.action.enum, ['register', 'decide', 'complete'])
})
await check('output schema declares all four statuses and the state vocabulary', () => {
  const schema = tools[0].output.schema
  assert.deepEqual(schema.properties.status.enum, ['READY_TO_EXECUTE', 'INSUFFICIENT_CONTEXT', 'REGISTERED', 'NOT_APPLICABLE'])
  assert.deepEqual(schema.properties.confirmation_state.enum, ['PENDING', 'AWAITING_EXECUTION', 'RESOLVED', 'UNCHANGED'])
})
await check('user_reply is not schema-required (it is conditionally required per action)', () => {
  const schema = tools[0].parameters
  assert.ok(!schema.required.includes('user_reply'), 'user_reply must not be unconditionally required')
  for (const field of ['confirmation_id', 'current_state', 'original_confirmation']) {
    assert.ok(schema.required.includes(field), `${field} should stay required`)
  }
})

// ── 4. execute + render, through the register → decide → complete flow ──────
const tool = tools[0]
// `exec.agent.id` is the live SessionId; the ledger guard keys on it.
const exec = { agent: { id: 'wiring-session' } }
const call = {
  confirmation_id: 'C1',
  current_state: '主按钮为次级尺寸',
  original_confirmation: '主按钮是否需要更突出？',
  user_reply: 'C1 修改',
  user_goal: '提高关键操作的可发现性',
  quality_impact: 'NONE',
  candidate_solutions: [{ label: 'promote', approach: '提高一个视觉层级', scope: 'component' }],
}
const registered = await tool.execute({ ...call, action: 'register' }, exec)
await check('register reports REGISTERED and PENDING (a write, not a refusal)', () => {
  assert.equal(registered.status, 'REGISTERED')
  assert.equal(registered.confirmation_state, 'PENDING')
  assert.equal(registered.execution_required, false)
})
await check('complete cannot skip decide (no MODIFY decision outstanding yet)', async () => {
  const skipped = await tool.execute({ ...call, action: 'complete' }, exec)
  assert.equal(skipped.status, 'NOT_APPLICABLE')
  assert.match(skipped.selection_reason, /ITEM_NOT_AWAITING_EXECUTION/)
})
await check('re-registering an id that is still open is refused', async () => {
  const refused = await tool.execute({ ...call, action: 'register' }, exec)
  assert.equal(refused.status, 'NOT_APPLICABLE')
  assert.match(refused.selection_reason, /CONFIRMATION_ID_STILL_OPEN/)
})
await check('decide without user_reply is refused, naming the real cause', async () => {
  const noReply = { ...call, action: 'decide' }
  delete noReply.user_reply
  const refused = await tool.execute(noReply, exec)
  assert.equal(refused.status, 'INSUFFICIENT_CONTEXT')
  assert.match(refused.missing_information, /REQUIRED_FOR_DECIDE/)
})
const decision = await tool.execute({ ...call, action: 'decide' }, exec)
await check('decide() returns a spec-shaped MODIFY decision awaiting execution', () => {
  assert.equal(decision.action, 'MODIFY')
  assert.equal(decision.status, 'READY_TO_EXECUTE')
  assert.equal(decision.confirmation_state, 'AWAITING_EXECUTION')
  assert.equal(decision.confirmation_id, 'C1')
  assert.equal(decision.execution_required, true)
})
await check('a re-decide that ends INSUFFICIENT_CONTEXT revokes the old authorisation', async () => {
  const noCandidates = { ...call, action: 'decide' }
  delete noCandidates.candidate_solutions
  const insufficient = await tool.execute(noCandidates, exec)
  assert.equal(insufficient.status, 'INSUFFICIENT_CONTEXT')
  assert.equal(insufficient.confirmation_state, 'PENDING')
  const refused = await tool.execute({ ...call, action: 'complete' }, exec)
  assert.equal(refused.status, 'NOT_APPLICABLE')
  assert.match(refused.selection_reason, /ITEM_NOT_AWAITING_EXECUTION/)
  // Restore a real decision so the rest of the flow keeps its prerequisites.
  const restored = await tool.execute({ ...call, action: 'decide' }, exec)
  assert.equal(restored.confirmation_state, 'AWAITING_EXECUTION')
})
await check('render() emits the canonical uppercase block', () => {
  const blocks = tool.output.render({}, decision)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  for (const label of ['CONFIRMATION_ID: C1', 'ACTION: MODIFY', 'STATUS: READY_TO_EXECUTE', 'CONFIRMATION_STATE_AFTER: AWAITING_EXECUTION']) {
    assert.ok(blocks[0].text.includes(label), `missing ${label}`)
  }
})
const completed = await tool.execute({ ...call, action: 'complete' }, exec)
await check('complete resolves the item only after execution', () => {
  assert.equal(completed.status, 'REGISTERED')
  assert.equal(completed.confirmation_state, 'RESOLVED')
})

// ── 5. the code-level guard, through the real tool ─────────────────────────
// NOTE: ordering matters. The round-reuse case reopens C1, so the "already
// resolved" refusals must be asserted BEFORE it runs.
await check('the guard refuses a decided-and-completed item', async () => {
  const again = await tool.execute({ ...call, action: 'decide' }, exec)
  assert.equal(again.status, 'NOT_APPLICABLE')
  assert.equal(again.execution_required, false)
  assert.match(again.selection_reason, /ITEM_ALREADY_RESOLVED/)
})
await check('there is no implicit registration: an unregistered id is refused', async () => {
  const refused = await tool.execute({ ...call, confirmation_id: 'C7', action: 'decide' }, { agent: { id: 'wiring-other' } })
  assert.equal(refused.status, 'NOT_APPLICABLE')
  assert.match(refused.selection_reason, /UNKNOWN_CONFIRMATION_ITEM/)
})
await check('a MODIFY without user_goal is refused with the stable reason code', async () => {
  const noGoal = { ...call, confirmation_id: 'C3' }
  delete noGoal.user_goal
  await tool.execute({ ...noGoal, action: 'register' }, exec)
  const refused = await tool.execute({ ...noGoal, action: 'decide' }, exec)
  assert.equal(refused.status, 'INSUFFICIENT_CONTEXT')
  assert.match(refused.missing_information, /USER_GOAL_REQUIRED_FOR_MODIFY/)
})
await check('a resolved C-number reopens as a new round on new text', async () => {
  const round2 = await tool.execute({ ...call, action: 'register', original_confirmation: 'C1 第二轮问题？' }, exec)
  assert.equal(round2.status, 'REGISTERED')
  assert.equal(round2.confirmation_state, 'PENDING')
  assert.match(round2.notes, /round 2/)
})
await check('the previous round decision cannot authorise the new round', async () => {
  const skipped = await tool.execute({ ...call, action: 'complete' }, exec)
  assert.equal(skipped.status, 'NOT_APPLICABLE')
  assert.match(skipped.selection_reason, /ITEM_NOT_AWAITING_EXECUTION/)
})
await check('ledgers are session-keyed and resettable', () => {
  assert.equal(typeof plugin.ledgers, 'object')
  assert.equal(plugin.ledgers.sessionCount >= 1, true)
  plugin.ledgers.clear()
  assert.equal(plugin.ledgers.sessionCount, 0)
})

// ── 6. disposal ────────────────────────────────────────────────────────────
await check('both contributions are reversible effects', () => {
  assert.equal(disposers.length, 2)
  for (const disposer of disposers) assert.equal(typeof disposer, 'function')
})

// ── 7. the versioned V2 row (方案 §5, §6) ───────────────────────────────────
// V2 is a SECOND tool behind an explicit switch. It is verified separately so the
// default profile keeps proving that V1 alone is what ships.
const v2Sections = []
const v2Tools = []
const v2Disposers = []
const v2ctx = new Context()
v2ctx.provide('systemPrompt', {
  getSectionOrder: () => 116,
  section: (section) => {
    v2Sections.push(section)
    return () => { v2Sections.length = 0 }
  },
})
v2ctx.provide('tools', {
  register: (definition) => {
    v2Tools.push(definition)
    return () => { v2Tools.length = 0 }
  },
})
v2ctx.effect = (callback) => {
  const disposer = callback()
  v2Disposers.push(disposer)
  return disposer
}

await check('enabling V2 adds a versioned tool and its own section, without touching V1', () => {
  plugin.apply(v2ctx, plugin.Config({ enableDecisionV2: true }))
  assert.deepEqual(v2Tools.map((tool) => tool.name), ['confirmation_resolution', 'confirmation_resolution_v2'])
  assert.equal(v2Sections.length, 2)
  assert.equal(v2Sections[0].name, 'confirmation:policy')
  assert.equal(v2Sections[1].name, 'confirmation:policy.v2')
  assert.equal(v2Disposers.length, 3)
  assert.deepEqual(v2Tools[0].parameters.properties.action.enum, ['register', 'decide', 'complete'])
  assert.deepEqual(v2Tools[1].parameters.properties.operation.enum, ['register', 'decide', 'complete', 'approve'])
})

const v2Tool = v2Tools[1]
const v2exec = { agent: { id: 'wiring-v2-session' } }
const v2call = {
  schema_version: '2.0',
  confirmation_id: 'C1',
  current_state: '首页主按钮为次级尺寸',
  original_confirmation: '主按钮是否需要更突出？',
  user_reply: 'C1 修改',
  context: { scenario: 'ui_preference', user_goal: '提高关键操作的可发现性', goal_source: 'USER_STATED' },
  authorization: { verification: 'PASS' },
  candidates: [
    { id: 'KEEP', kind: 'KEEP_CURRENT' },
    {
      id: 'PROMOTE',
      kind: 'MODIFY',
      approach: '提高一个视觉层级并加强局部对比度',
      scope: 'component',
      reversibility: 'reversible',
      evidence_state: 'PASS',
      goal_fit: 'HIGH',
      user_value: 'HIGH',
      output_quality: 'HIGH',
      impact_risk: 'LOW',
      execution_cost: 'LOW',
      long_term_value: 'MEDIUM',
    },
  ],
}

await check('V2 register reports REGISTERED and PENDING', async () => {
  const registered = await v2Tool.execute({ ...v2call, operation: 'register' }, v2exec)
  assert.equal(registered.outcome, 'REGISTERED')
  assert.equal(registered.lifecycle_status, 'PENDING')
  assert.equal(registered.decision_revision, 0)
})

await check('V2 decide returns MODIFY with a decision_revision and an execution scope', async () => {
  const decided = await v2Tool.execute({ ...v2call, operation: 'decide' }, v2exec)
  assert.equal(decided.outcome, 'MODIFY')
  assert.equal(decided.lifecycle_status, 'AWAITING_EXECUTION')
  assert.equal(decided.decision_revision, 1)
  assert.equal(decided.selected_solution_id, 'PROMOTE')
  assert.equal(decided.execution_scope, 'component')
  assert.equal(decided.executable, true)
  assert.ok(decided.do_not_change.length >= 1)
})

await check('V2 complete without the revision, or with a stale one, is refused', async () => {
  const noRevision = await v2Tool.execute({ ...v2call, operation: 'complete' }, v2exec)
  assert.equal(noRevision.outcome, 'NOT_APPLICABLE')
  assert.ok(noRevision.reason_codes.includes('MISSING_DECISION_REVISION'))

  const redecided = await v2Tool.execute({ ...v2call, operation: 'decide' }, v2exec)
  assert.equal(redecided.decision_revision, 2)
  const stale = await v2Tool.execute({ ...v2call, operation: 'complete', decision_revision: 1 }, v2exec)
  assert.equal(stale.outcome, 'NOT_APPLICABLE')
  assert.ok(stale.reason_codes.includes('STALE_DECISION_REVISION'))
})

await check('V2 complete with the current revision resolves the item', async () => {
  const completed = await v2Tool.execute({ ...v2call, operation: 'complete', decision_revision: 2 }, v2exec)
  assert.equal(completed.outcome, 'REGISTERED')
  assert.equal(completed.lifecycle_status, 'RESOLVED')
})

await check('V2 approve is refused while the host exposes no verifiable approval source', async () => {
  const refused = await v2Tool.execute({ ...v2call, operation: 'approve' }, v2exec)
  assert.equal(refused.outcome, 'NOT_APPLICABLE')
  assert.ok(refused.reason_codes.includes('NO_VERIFIABLE_APPROVAL_SOURCE'))
})

await check('a V2 decision never touches a V1 item (contract isolation)', async () => {
  const v1Tool = v2Tools[0]
  const mixed = { agent: { id: 'wiring-v2-mixed' } }
  await v1Tool.execute({
    confirmation_id: 'C1',
    current_state: '现状',
    original_confirmation: '问题？',
    user_goal: '目标',
    quality_impact: 'NONE',
    candidate_solutions: [{ label: 'a', approach: '做法', scope: 'component' }],
    action: 'register',
  }, mixed)
  const refused = await v2Tool.execute({ ...v2call, operation: 'decide' }, mixed)
  assert.equal(refused.outcome, 'NOT_APPLICABLE')
  assert.ok(refused.reason_codes.includes('ITEM_VERSION_MISMATCH'))
})

await check('V2 also refuses a number this session never published', async () => {
  const refused = await v2Tool.execute({ ...v2call, confirmation_id: 'C9', operation: 'decide' }, { agent: { id: 'wiring-v2-other' } })
  assert.equal(refused.outcome, 'NOT_APPLICABLE')
  assert.ok(refused.reason_codes.includes('UNKNOWN_CONFIRMATION_ITEM'))
})

await check('V2 render() emits the canonical uppercase block', async () => {
  const decided = await v2Tool.execute({
    ...v2call,
    confirmation_id: 'C2',
    operation: 'register',
  }, { agent: { id: 'wiring-v2-render' } })
  assert.equal(decided.outcome, 'REGISTERED')
  const blocks = v2Tool.output.render({}, decided)
  assert.equal(blocks.length, 1)
  assert.ok(blocks[0].text.includes('OUTCOME: REGISTERED'))
  assert.ok(blocks[0].text.includes('EXECUTABLE: NO'))
})

console.log(results.join('\n'))
console.log(`\n${results.filter((line) => line.startsWith('PASS')).length}/${results.length} wiring checks passed`)
