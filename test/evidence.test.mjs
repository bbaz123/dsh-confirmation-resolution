/**
 * Tests for the three-valued evidence model (方案 §4.2).
 *
 * The point of these cases is the failure mode they forbid: an absent field must
 * never become `PASS`, and `UNKNOWN` must never be folded into a level.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EVIDENCE_CODE,
  GATE,
  LEVEL,
  conflictOf,
  describeLevel,
  gap,
  gate,
  isFail,
  isKnownLevel,
  isPass,
  level,
  rank,
  readGates,
  readLevels,
  worstGate,
  worstLevel,
} from '../lib/evidence.js'

test('gate() maps booleans, tokens and absence without optimism', () => {
  assert.equal(gate(true), GATE.PASS)
  assert.equal(gate(false), GATE.FAIL)
  assert.equal(gate('PASS'), GATE.PASS)
  assert.equal(gate(' ok '), GATE.PASS)
  assert.equal(gate('failed'), GATE.FAIL)
  assert.equal(gate('violated'), GATE.FAIL)
  for (const absent of [undefined, null, '', 'unknown', 'TBD', 'whatever']) {
    assert.equal(gate(absent), GATE.UNKNOWN, `gate(${String(absent)}) must be UNKNOWN`)
  }
})

test('level() normalizes aliases, numbers and nested objects', () => {
  assert.equal(level('none'), LEVEL.NONE)
  assert.equal(level('SAME'), LEVEL.NONE)
  assert.equal(level('low'), LEVEL.LOW)
  assert.equal(level('Moderate'), LEVEL.MEDIUM)
  assert.equal(level('severe'), LEVEL.HIGH)
  assert.equal(level(0), LEVEL.NONE)
  assert.equal(level(3), LEVEL.HIGH)
  assert.equal(level({ value: 'medium' }), LEVEL.MEDIUM)
  assert.equal(level({ level: 'high' }), LEVEL.HIGH)
  for (const absent of [undefined, null, '', 'unknown', 99, {}, true]) {
    assert.equal(level(absent), LEVEL.UNKNOWN, `level(${JSON.stringify(absent)}) must be UNKNOWN`)
  }
})

test('worstGate combines conservatively and never upgrades absence to PASS', () => {
  assert.equal(worstGate(GATE.PASS, GATE.PASS), GATE.PASS)
  assert.equal(worstGate(GATE.PASS, GATE.UNKNOWN), GATE.UNKNOWN)
  assert.equal(worstGate(GATE.UNKNOWN, GATE.FAIL), GATE.FAIL)
  assert.equal(worstGate(GATE.PASS, GATE.FAIL, GATE.UNKNOWN), GATE.FAIL)
  assert.equal(worstGate(), GATE.PASS)
})

test('worstLevel keeps UNKNOWN out of the known ordering', () => {
  assert.equal(worstLevel(LEVEL.LOW, LEVEL.HIGH), LEVEL.HIGH)
  assert.equal(worstLevel(LEVEL.NONE, LEVEL.LOW), LEVEL.LOW)
  assert.equal(worstLevel(LEVEL.UNKNOWN, LEVEL.MEDIUM), LEVEL.MEDIUM)
  assert.equal(worstLevel(LEVEL.UNKNOWN, undefined), LEVEL.UNKNOWN)
  assert.equal(worstLevel(), LEVEL.UNKNOWN)
})

test('rank() reports UNKNOWN as having no rank', () => {
  assert.equal(rank(LEVEL.NONE), 0)
  assert.equal(rank(LEVEL.HIGH), 3)
  assert.equal(rank(LEVEL.UNKNOWN), undefined)
  assert.equal(isKnownLevel(LEVEL.MEDIUM), true)
  assert.equal(isKnownLevel(LEVEL.UNKNOWN), false)
})

test('readGates and readLevels treat missing keys as UNKNOWN', () => {
  const gates = readGates({ a: true }, ['a', 'b'])
  assert.deepEqual(gates, { a: GATE.PASS, b: GATE.UNKNOWN })
  const levels = readLevels({ a: 'high' }, ['a', 'b'])
  assert.deepEqual(levels, { a: LEVEL.HIGH, b: LEVEL.UNKNOWN })
  assert.deepEqual(readGates(undefined, ['a']), { a: GATE.UNKNOWN })
})

test('conflictOf records a contradiction and stays silent when there is none', () => {
  assert.equal(conflictOf('quality', 'NONE', 'NONE'), undefined)
  assert.equal(conflictOf('quality', undefined, 'HIGH'), undefined)
  const conflict = conflictOf('quality', 'NONE', 'HIGH')
  assert.equal(conflict.code, EVIDENCE_CODE.CONFLICT)
  assert.equal(conflict.field, 'quality')
  assert.match(conflict.detail, /conservative/)
})

test('gap() and the small predicates keep one shape', () => {
  const entry = gap('authorization', 'AUTHORIZATION_UNVERIFIED', 'not verified')
  assert.deepEqual(entry, { field: 'authorization', code: 'AUTHORIZATION_UNVERIFIED', detail: 'not verified' })
  assert.equal(isPass(GATE.PASS), true)
  assert.equal(isPass(GATE.UNKNOWN), false)
  assert.equal(isFail(GATE.FAIL), true)
  assert.equal(isFail(GATE.UNKNOWN), false)
  assert.equal(describeLevel(LEVEL.UNKNOWN), LEVEL.UNKNOWN)
})
