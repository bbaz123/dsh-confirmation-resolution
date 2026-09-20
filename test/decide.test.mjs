/**
 * Verification suite for 03_DSH_待确认事项决策规范 §16 (验收测试矩阵).
 *
 * Run: `node --test test/`
 *
 * Every scenario asserts the specification's expected result instead of
 * describing it, so the fixed decision matrix is proven rather than argued.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { decide, formatDecision } from '../lib/decide.js'
import { RULES } from '../lib/rules.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const INDEX_SOURCE = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const PATCH_SOURCE = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

/** A complete, well-formed C1 that loses no quality: the MODIFY baseline. */
function baseCall(overrides = {}) {
  return {
    confirmation_id: 'C1',
    current_state: '首页主按钮为次级尺寸，视觉层级与正文接近',
    original_confirmation: '主按钮是否需要更突出？',
    user_reply: 'C1 修改：把主按钮放大',
    relevant_context: '首页只有一个主操作入口',
    do_not_change: '页面整体布局、导航结构、其他组件',
    quality_dimensions: { layout: 'SAME', clarity: 'IMPROVED', hierarchy: 'IMPROVED' },
    candidate_solutions: [
      {
        label: 'moderate-promotion',
        approach: '把主按钮提高一个视觉层级，并调整与正文的间距',
        solves_user_problem: true,
        quality_loss: 'NONE',
        side_effects: { layout: 'NONE', consistency: 'NONE' },
        scope: 'component',
        reversibility: 'reversible',
        complexity: 'LOW',
      },
    ],
    ...overrides,
  }
}

// ── §4 固定决策算法 ─────────────────────────────────────────────────────────

test('Test 5 — 修改不损害质量 → ACTION = MODIFY', () => {
  const value = decide(baseCall({ quality_impact: 'NONE' }))
  assert.equal(value.action, 'MODIFY')
  assert.equal(value.status, 'READY_TO_EXECUTE')
  assert.equal(value.quality_impact, 'NONE')
  assert.equal(value.execution_required, true)
  assert.equal(value.confirmation_state, 'RESOLVED')
  assert.match(value.selected_solution, /主按钮/)
})

test('Test 6 — 修改损害质量但保持现状不影响实际使用 → ACTION = KEEP_CURRENT', () => {
  const value = decide({
    confirmation_id: 'C2',
    current_state: '卡片使用系统默认圆角与阴影',
    original_confirmation: '是否更换卡片视觉样式？',
    user_reply: 'C2 保持',
    relevant_context: '非关键卡片，仅涉及装饰观感',
    preference_only: true,
    quality_impact: 'MEDIUM',
    user_impact_if_unchanged: 'NONE',
  })
  assert.equal(value.action, 'KEEP_CURRENT')
  assert.equal(value.status, 'READY_TO_EXECUTE')
  assert.equal(value.selected_solution, 'KEEP_CURRENT')
  assert.equal(value.execution_scope, 'NONE')
  assert.equal(value.side_effect_risk, 'NONE')
  assert.equal(value.execution_required, false)
  assert.equal(value.confirmation_state, 'RESOLVED')
})

test('Test 6b — 纯审美偏好不得被提升为使用问题（不传 user_impact 也保持现状）', () => {
  const value = decide({
    confirmation_id: 'C2',
    current_state: '卡片使用系统默认圆角与阴影',
    original_confirmation: '是否更换卡片视觉样式？',
    user_reply: 'C2 换掉',
    preference_only: true,
    quality_impact: 'HIGH',
  })
  assert.equal(value.action, 'KEEP_CURRENT')
  assert.equal(value.user_impact_if_unchanged, 'NONE')
  assert.equal(value.status, 'READY_TO_EXECUTE')
})

test('Test 7 — 修改损害质量且保持现状影响使用 → MODIFY，且不机械执行高损失方案', () => {
  const value = decide({
    confirmation_id: 'C1',
    current_state: '主按钮与正文同尺寸，关键入口难以发现',
    original_confirmation: '主按钮是否需要更突出？',
    user_reply: 'C1 修改：把主按钮放大 300%',
    relevant_context: '首页唯一主操作入口，用户报告找不到入口',
    do_not_change: '页面整体布局、导航结构',
    quality_impact: 'MEDIUM',
    user_impact_if_unchanged: 'MEDIUM',
    user_proposed_solution: '把主按钮放大 300%',
    candidate_solutions: [
      {
        label: 'USER_PROPOSED_SOLUTION',
        approach: '把主按钮放大 300%',
        user_proposed: true,
        solves_user_problem: true,
        quality_loss: 'HIGH',
        side_effects: { layout: 'HIGH' },
        scope: 'page',
        reversibility: 'partial',
        complexity: 'LOW',
      },
      {
        label: 'moderate-promotion',
        approach: '把主按钮提高一个层级，并强化视觉层级与局部间距',
        solves_user_problem: true,
        quality_loss: 'LOW',
        side_effects: { layout: 'LOW' },
        scope: 'component',
        reversibility: 'reversible',
        complexity: 'LOW',
      },
    ],
  })
  assert.equal(value.action, 'MODIFY')
  assert.equal(value.quality_impact, 'MEDIUM')
  assert.equal(value.user_impact_if_unchanged, 'MEDIUM')
  assert.equal(value.selected_solution, '把主按钮提高一个层级，并强化视觉层级与局部间距')
  assert.notEqual(value.selected_solution, '把主按钮放大 300%')
  assert.match(value.notes, /alternative/i)
})

test('Test 7b — 用户方案本身就是质量损失最小的方案时，仍可被选中', () => {
  const value = decide({
    confirmation_id: 'C1',
    current_state: '按钮尺寸偏小',
    original_confirmation: '主按钮是否需要更突出？',
    user_reply: 'C1 修改：把主按钮放大一档',
    quality_impact: 'LOW',
    user_impact_if_unchanged: 'MEDIUM',
    user_proposed_solution: '把主按钮放大一档',
    candidate_solutions: [
      {
        label: 'USER_PROPOSED_SOLUTION',
        approach: '把主按钮放大一档',
        user_proposed: true,
        quality_loss: 'LOW',
        side_effects: { layout: 'LOW' },
        scope: 'component',
        reversibility: 'reversible',
        complexity: 'LOW',
      },
      {
        label: 'reposition',
        approach: '保持尺寸不变，改为调整位置与对比度',
        quality_loss: 'MEDIUM',
        side_effects: { layout: 'MEDIUM' },
        scope: 'section',
        reversibility: 'partial',
        complexity: 'MEDIUM',
      },
    ],
  })
  assert.equal(value.action, 'MODIFY')
  assert.equal(value.selected_solution, '把主按钮放大一档')
})

test('Test 5b — 质量影响不确定时按"可能有损失"处理，不得默认 MODIFY', () => {
  const value = decide({
    confirmation_id: 'C1',
    current_state: '表单校验提示为行内文本',
    original_confirmation: '提示是否需要换一种呈现？',
    user_reply: 'C1 修改',
    // no quality_impact, no quality_dimensions
  })
  assert.equal(value.status, 'INSUFFICIENT_CONTEXT')
  assert.equal(value.action, 'KEEP_CURRENT')
  assert.match(value.missing_information, /quality_impact/)
})

// ── §13 信息不足 ────────────────────────────────────────────────────────────

test('Test 7c — MODIFY 必需但只有用户原始方案且它被淘汰 → INSUFFICIENT_CONTEXT，不回落执行原方案', () => {
  const value = decide({
    confirmation_id: 'C1',
    current_state: '主按钮与正文同尺寸',
    original_confirmation: '主按钮是否需要更突出？',
    user_reply: 'C1 修改：把主按钮放大 300%',
    quality_impact: 'MEDIUM',
    user_impact_if_unchanged: 'HIGH',
    user_proposed_solution: '把主按钮放大 300%',
  })
  assert.equal(value.status, 'INSUFFICIENT_CONTEXT')
  assert.equal(value.action, 'KEEP_CURRENT')
  assert.equal(value.execution_required, false)
  assert.equal(value.confirmation_state, 'PENDING')
  assert.match(value.missing_information, /candidate_solutions/)
  assert.match(value.notes, /Do not execute/)
})

test('Test 7d — 关键必填项缺失 → INSUFFICIENT_CONTEXT 且状态保持 PENDING', () => {
  const value = decide({ confirmation_id: 'C3', current_state: '', original_confirmation: '', user_reply: '' })
  assert.equal(value.status, 'INSUFFICIENT_CONTEXT')
  assert.equal(value.confirmation_state, 'PENDING')
  assert.match(value.missing_information, /current_state/)
  assert.match(value.missing_information, /original_confirmation/)
})

test('Test 7e — 调用方声明与其自身证据冲突 → 取更保守一级并记录', () => {
  const value = decide(baseCall({
    quality_impact: 'NONE',
    quality_dimensions: { accessibility: 'HIGH' },
    user_impact_if_unchanged: 'HIGH',
    candidate_solutions: [
      { label: 'accessible-fix', approach: '恢复对比度并保留更大点击区', scope: 'component', quality_loss: 'LOW', side_effects: { accessibility: 'NONE' } },
    ],
  }))
  assert.equal(value.quality_impact, 'HIGH')
  assert.equal(value.action, 'MODIFY')
  assert.equal(value.status, 'READY_TO_EXECUTE')
})

test('Test 7f — 全部候选方案触发硬性淘汰 → INSUFFICIENT_CONTEXT', () => {
  const value = decide({
    confirmation_id: 'C1',
    current_state: '受限布局',
    original_confirmation: '是否重做整个页面？',
    user_reply: 'C1 修改：重做整页',
    quality_impact: 'MEDIUM',
    user_impact_if_unchanged: 'MEDIUM',
    candidate_solutions: [
      { label: 'full-rewrite', approach: '重做整页布局', expands_beyond_necessity: true, quality_loss: 'LOW' },
      { label: 'too-lossy', approach: '移除信息层级', quality_loss: 'HIGH' },
    ],
  })
  assert.equal(value.status, 'INSUFFICIENT_CONTEXT')
  assert.match(value.missing_information, /candidate_solutions/)
})

// ── §10 输出结构 ────────────────────────────────────────────────────────────

test('输出结构包含规范要求的全部字段且取值合法', () => {
  const value = decide(baseCall({ quality_impact: 'NONE' }))
  const required = [
    'confirmation_id', 'action', 'quality_impact', 'user_impact_if_unchanged',
    'user_goal', 'selected_solution', 'execution_scope', 'do_not_change',
    'side_effect_risk', 'status', 'missing_information', 'confirmation_state',
  ]
  for (const field of required) {
    assert.ok(Object.hasOwn(value, field), `missing output field ${field}`)
    assert.equal(typeof value[field], typeof value[field] === 'boolean' ? 'boolean' : 'string')
  }
  assert.ok(['MODIFY', 'KEEP_CURRENT'].includes(value.action))
  for (const field of ['quality_impact', 'user_impact_if_unchanged', 'side_effect_risk']) {
    assert.ok(['NONE', 'LOW', 'MEDIUM', 'HIGH'].includes(value[field]), `${field}=${value[field]}`)
  }
  assert.ok(['READY_TO_EXECUTE', 'INSUFFICIENT_CONTEXT'].includes(value.status))
  assert.ok(['PENDING', 'RESOLVED'].includes(value.confirmation_state))
})

test('formatDecision 输出 02 §10–§12 的大写块', () => {
  const text = formatDecision(decide(baseCall({ quality_impact: 'NONE' })))
  for (const label of [
    'CONFIRMATION_ID:', 'ACTION:', 'QUALITY_IMPACT:', 'USER_IMPACT_IF_UNCHANGED:',
    'USER_GOAL:', 'SELECTED_SOLUTION:', 'EXECUTION_SCOPE:', 'DO_NOT_CHANGE:',
    'SIDE_EFFECT_RISK:', 'STATUS:', 'MISSING_INFORMATION:',
  ]) {
    assert.ok(text.includes(label), `missing ${label}`)
  }
})

// ── 01 System Prompt 接入（静态契约） ───────────────────────────────────────

test('Test 1/2/10 — 插件触发条件与禁止场景已写入 System Prompt 文本', () => {
  for (const fragment of [
    '待确认事项汇报规则',
    '只有同时满足以下三条时，才允许调用 confirmation_resolution',
    '禁止触发插件的场景',
    '用户第一次提出任务',
    '普通修改或普通新需求',
    '已经处理完成、且用户没有重新涉及的事项',
    '本插件不是全局修改插件',
    '退出条件',
  ]) {
    assert.ok(RULES.includes(fragment), `prompt rules missing: ${fragment}`)
  }
})

test('Test 3/8/9 — 编号稳定性、状态管理、混合消息拆分已写入 System Prompt 文本', () => {
  for (const fragment of [
    'C1 = PENDING，C2 = PENDING，C3 = PENDING',
    'C1 = RESOLVED，C2 = RESOLVED，C3 = PENDING',
    '不得擅自替用户处理用户没有回复的确认项',
    '确认项不得因为下一轮对话而重新编号',
    '混合消息的处理',
    '"修改首页标题" → 使用正常 DSH 规则，不进入插件决策流程',
    '【待确认事项】',
  ]) {
    assert.ok(RULES.includes(fragment), `prompt rules missing: ${fragment}`)
  }
})

test('Test 4/5/6/7 执行规则 — READY_TO_EXECUTE 后必须直接执行，不得再次询问', () => {
  for (const fragment of [
    '不得再次询问',
    'ACTION = MODIFY：按 SELECTED_SOLUTION 执行，只修改 EXECUTION_SCOPE 指定的范围，不得修改 DO_NOT_CHANGE 指定的范围',
    'ACTION = KEEP_CURRENT：保持当前状态',
    'STATUS = INSUFFICIENT_CONTEXT：不执行任何修改',
  ]) {
    assert.ok(RULES.includes(fragment), `prompt rules missing: ${fragment}`)
  }
})

test('§9 作用域隔离 — 规则声明不改变正常 DSH 工作逻辑', () => {
  assert.ok(RULES.includes('它不改变其他任何情况下的正常行为'))
  assert.ok(RULES.includes('不得在未满足上述条件时应用'))
  assert.ok(RULES.includes('它们不修改正常 DSH 工作逻辑'))
})

test('插件边界 — 运行时不修改页面/代码/文件/项目结构', () => {
  assert.ok(INDEX_SOURCE.includes('本工具不修改页面、代码、文件或项目结构'))
  for (const forbidden of ['node:fs', 'writeFile', "from 'node:child_process'", 'child_process']) {
    assert.ok(!INDEX_SOURCE.includes(forbidden), `plugin must not use ${forbidden}`)
  }
})

test('Cordis 行契约 — 名称、注入、工具名、补丁行 id 一致', () => {
  assert.ok(INDEX_SOURCE.includes("export const name = 'confirmation-resolution'"))
  assert.ok(INDEX_SOURCE.includes("export const inject = ['tools', 'systemPrompt']"))
  assert.ok(INDEX_SOURCE.includes("name: 'confirmation_resolution'"))
  assert.ok(PATCH_SOURCE.includes('id: confirmation-resolution'))
  assert.ok(PATCH_SOURCE.includes("'dsh-plugin-confirmation-resolution'"))
  assert.ok(ROOT.length > 0)
})

// ── 输入结构（02 §2 / 第三阶段） ─────────────────────────────────────────────

test('输入结构接受 02 §2 的全部字段', () => {
  const value = decide({
    confirmation_id: 'C9',
    current_state: 'state',
    original_confirmation: 'confirmation',
    user_reply: 'reply',
    user_goal: 'goal',
    relevant_context: 'context',
    available_constraints: 'constraints',
    quality_impact: 'NONE',
    candidate_solutions: [{ label: 'a', approach: 'b' }],
  })
  assert.equal(value.confirmation_id, 'C9')
  assert.equal(value.status, 'READY_TO_EXECUTE')
  assert.equal(value.action, 'MODIFY')
})

test('每次调用只处理一个确认事项 — 其它确认项状态不被本工具改写', () => {
  const value = decide(baseCall({ confirmation_id: 'C1', quality_impact: 'NONE' }))
  assert.equal(value.confirmation_id, 'C1')
  assert.equal(value.confirmation_state, 'RESOLVED')
  assert.ok(!JSON.stringify(value).includes('C2'))
})

test('算法顺序 — ACTION 只由 QUALITY_IMPACT 与 USER_IMPACT_IF_UNCHANGED 决定', () => {
  const cases = [
    { quality: 'NONE', user: undefined, expected: 'MODIFY' },
    { quality: 'LOW', user: 'NONE', expected: 'KEEP_CURRENT' },
    { quality: 'MEDIUM', user: 'NONE', expected: 'KEEP_CURRENT' },
    { quality: 'HIGH', user: 'NONE', expected: 'KEEP_CURRENT' },
    { quality: 'HIGH', user: 'LOW', expected: 'MODIFY' },
    { quality: 'HIGH', user: 'HIGH', expected: 'MODIFY' },
  ]
  for (const item of cases) {
    const value = decide(baseCall({
      quality_impact: item.quality,
      ...(item.user === undefined ? {} : { user_impact_if_unchanged: item.user }),
    }))
    assert.equal(value.action, item.expected, `quality=${item.quality} user=${item.user}`)
  }
})

// ── 复核修复的回归用例（2026-09-20） ────────────────────────────────────────

test('回归 — 声明 preference_only 但未给 quality_impact 时，不得再向用户索要确认', () => {
  const value = decide({
    confirmation_id: 'C2',
    current_state: '卡片使用系统默认圆角与阴影',
    original_confirmation: '是否更换卡片视觉样式？',
    user_reply: 'C2 换掉',
    preference_only: true,
  })
  assert.equal(value.status, 'READY_TO_EXECUTE')
  assert.equal(value.action, 'KEEP_CURRENT')
  assert.equal(value.user_impact_if_unchanged, 'NONE')
  assert.match(value.quality_evidence, /preference-only/)
  assert.match(value.notes, /preference/i)
})

test('回归 — 调用方显式声明"保持现状不影响使用"(NONE) 时，不得升级为 INSUFFICIENT_CONTEXT', () => {
  const value = decide({
    confirmation_id: 'C2',
    current_state: '次要卡片为默认样式',
    original_confirmation: '是否调整？',
    user_reply: 'C2 调整',
    quality_impact: 'LOW',
    user_impact_if_unchanged: 'NONE',
  })
  assert.equal(value.status, 'READY_TO_EXECUTE')
  assert.equal(value.action, 'KEEP_CURRENT')
  assert.equal(value.execution_required, false)
})

test('回归 — QUALITY_IMPACT=NONE 时 USER_IMPACT_IF_UNCHANGED 必须为 NONE（该维度未被评估）', () => {
  const value = decide(baseCall({
    quality_impact: 'NONE',
    user_impact_dimensions: { core_task_blocked: 'HIGH' },
  }))
  assert.equal(value.action, 'MODIFY')
  assert.equal(value.quality_impact, 'NONE')
  assert.equal(value.user_impact_if_unchanged, 'NONE')
})

test('回归 — INSUFFICIENT_CONTEXT 不得虚报未评估的维度等级', () => {
  const undecided = decide({
    confirmation_id: 'C1',
    current_state: '表单校验提示为行内文本',
    original_confirmation: '提示是否需要换一种呈现？',
    user_reply: 'C1 修改',
  })
  assert.equal(undecided.status, 'INSUFFICIENT_CONTEXT')
  assert.equal(undecided.quality_impact, 'NONE')
  assert.equal(undecided.user_impact_if_unchanged, 'NONE')
  assert.match(undecided.quality_evidence, /unknown/)
  assert.match(undecided.user_impact_evidence, /unknown/)
})
