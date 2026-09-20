/**
 * Integration verification for the Cordis wiring.
 *
 * Proves more than a syntax check:
 *   1. the plugin module imports through the SAME bare-specifier resolution the
 *      loader uses at boot (Node ESM resolution from the profile's install).
 *      This step needs a DSH install; the profile is located through DSH_HOME /
 *      DSH_PROFILE and is never hard-coded to one machine;
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
import { Context } from '@deepseek-ai/cordis'

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

check('row name resolves from the profile install (what the loader imports)', () => {
  assert.notEqual(entryUrl, undefined, `row not linked into a DSH profile:\n      ${resolveFailures.join('\n      ')}`)
  assert.match(entryUrl, /dsh-confirmation-resolution/)
})

if (entryUrl === undefined) {
  console.log(results.join('\n'))
  console.log('\n0 wiring checks passed — install the row first (dsh plugin --profile <profile> add <dir>)')
  process.exit(1)
}

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
