/**
 * Materialize the plugin's complete runtime dependency closure into a bundle.
 *
 * Copying only the three direct packages is not enough: `schemastery` and
 * `cordis` import `@deepseek-ai/cosmokit`, and dsh-tools imports further
 * packages, so each direct copy must bring its own transitive closure. This
 * walks `dependencies` (never devDependencies, never peerDependencies — peers
 * are the target DSH's own packages) and copies real directories, because a
 * junction would not survive the bundle being moved to another machine.
 *
 * Usage: node tools/materialize-deps.mjs <bundleDir> <sourceNodeModules...>
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [bundleDir, ...sources] = process.argv.slice(2)
if (bundleDir === undefined || sources.length === 0) {
  console.error('usage: node tools/materialize-deps.mjs <bundleDir> <sourceNodeModules...>')
  process.exit(2)
}

const roots = ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', '@deepseek-ai/cordis']
const target = join(bundleDir, 'node_modules')

/** Resolve one package directory against the ordered source node_modules roots. */
function resolvePackage(name) {
  for (const root of sources) {
    const candidate = join(root, ...name.split('/'))
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

const copied = new Map()
const skippedPeers = new Set()
const queue = [...roots]

while (queue.length > 0) {
  const name = queue.shift()
  if (copied.has(name)) continue
  const from = resolvePackage(name)
  if (from === undefined) {
    console.error(`UNRESOLVED: ${name} (no source root provides it)`)
    process.exitCode = 1
    continue
  }
  const manifest = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'))
  const to = join(target, ...name.split('/'))
  rmSync(to, { recursive: true, force: true })
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true, dereference: true })
  copied.set(name, manifest.version ?? '?')

  const deps = manifest.dependencies ?? {}
  const peers = manifest.peerDependencies ?? {}
  for (const dep of Object.keys(deps)) {
    // A peer that the target harness supplies is never bundled; a dependency is
    // always bundled, even when it is also listed as a peer.
    if (deps[dep] === undefined) continue
    queue.push(dep)
  }
  for (const peer of Object.keys(peers)) {
    if (deps[peer] === undefined) skippedPeers.add(`${name} -> ${peer}`)
  }
}

const rows = [...copied.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
for (const [name, version] of rows) console.log(`${name}@${version}`)
console.log(`\n${rows.length} packages materialized into ${target}`)
if (skippedPeers.size > 0) {
  console.log('\npeer dependencies left to the target DSH (not bundled):')
  for (const line of [...skippedPeers].sort()) console.log(`  ${line}`)
}
