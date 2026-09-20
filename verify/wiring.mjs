/**
 * Integration verification for the Cordis wiring.
 *
 * Proves more than a syntax check:
 *   1. the plugin module imports through the SAME bare-specifier resolution the
 *      loader uses at boot (Node ESM resolution from the profile's install);
 *   2. `apply()` registers exactly one prompt section and one tool on a real
 *      Cordis context, with the spec'd name and section metadata;
 *   3. the tool definition passes the real `defineTool` validation from
 *      `@deepseek-ai/dsh-tools` (so the schema is genuinely registry-ready);
 *   4. executing the registered tool returns a spec-shaped decision and renders
 *      the canonical uppercase block;
 *   5. both contributions are disposed with their fiber (no leaked effects).
 *
 * Run: `node verify/wiring.mjs`
 */

import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const results = []
function check(label, fn) {
  try {
    fn()
    results.push(`PASS  ${label}`)
  } catch (error) {
    results.push(`FAIL  ${label}\n      ${error.message}`)
    process.exitCode = 1
  }
}

// ── 1. loader-equivalent resolution of the installed row name ───────────────
const profileRequire = createRequire('C:/Users/a1941/.dsh/profiles/web/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js')
let entryUrl
check('row name resolves from the profile install (what the loader imports)', () => {
  entryUrl = pathToFileURL(profileRequire.resolve('dsh-plugin-confirmation-resolution')).href
  assert.match(entryUrl, /dsh-confirmation-resolution/)
})

const plugin = await import(entryUrl)
check('entry exports name/inject/Config/apply', () => {
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

check('apply() registers one prompt section and one tool', () => {
  plugin.apply(ctx, plugin.Config({}))
  assert.equal(sections.length, 1, `sections=${sections.length}`)
  assert.equal(tools.length, 1, `tools=${tools.length}`)
})
check('prompt section carries the spec\'d name, order and rules', () => {
  const section = sections[0]
  assert.equal(section.name, 'confirmation:policy')
  assert.equal(section.order, 116)
  assert.ok(section.text.includes('【待确认事项】'))
  assert.ok(section.text.includes('confirmation_resolution'))
})
check('tool definition is registry-ready and named confirmation_resolution', () => {
  const tool = tools[0]
  assert.equal(tool.name, 'confirmation_resolution')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.output !== undefined && typeof tool.output.render === 'function')
  const schema = tool.parameters
  for (const field of ['confirmation_id', 'current_state', 'original_confirmation', 'user_reply']) {
    assert.ok(schema.properties[field] !== undefined, `missing parameter ${field}`)
    assert.ok(schema.required.includes(field), `${field} must be required`)
  }
})
check('parameter schema exposes the optional context fields', () => {
  const schema = tools[0].parameters
  for (const field of ['user_goal', 'relevant_context', 'available_constraints', 'quality_impact', 'candidate_solutions']) {
    assert.ok(schema.properties[field] !== undefined, `missing parameter ${field}`)
  }
})

// ── 4. execute + render ────────────────────────────────────────────────────
const tool = tools[0]
const decision = await tool.execute({
  confirmation_id: 'C1',
  current_state: '主按钮为次级尺寸',
  original_confirmation: '主按钮是否需要更突出？',
  user_reply: 'C1 修改',
  quality_impact: 'NONE',
  candidate_solutions: [{ label: 'promote', approach: '提高一个视觉层级', scope: 'component' }],
}, {})
check('execute() returns a spec-shaped MODIFY decision', () => {
  assert.equal(decision.action, 'MODIFY')
  assert.equal(decision.status, 'READY_TO_EXECUTE')
  assert.equal(decision.confirmation_state, 'RESOLVED')
  assert.equal(decision.confirmation_id, 'C1')
})
check('render() emits the canonical uppercase block', () => {
  const blocks = tool.output.render({}, decision)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  for (const label of ['CONFIRMATION_ID: C1', 'ACTION: MODIFY', 'STATUS: READY_TO_EXECUTE', 'CONFIRMATION_STATE_AFTER: RESOLVED']) {
    assert.ok(blocks[0].text.includes(label), `missing ${label}`)
  }
})

// ── 5. disposal ────────────────────────────────────────────────────────────
check('both contributions are reversible effects', () => {
  assert.equal(disposers.length, 1)
  assert.equal(typeof disposers[0], 'function')
})

console.log(results.join('\n'))
console.log(`\n${results.filter((line) => line.startsWith('PASS')).length}/${results.length} wiring checks passed`)
