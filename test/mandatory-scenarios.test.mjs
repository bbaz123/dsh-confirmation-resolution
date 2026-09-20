/**
 * The 10 mandatory scenarios of the task spec, each as an executable assertion.
 *
 * The trigger scenarios (1, 2, 8, 10) are decided by 01's activation scope. That
 * scope lives in the System Prompt, not in the tool — so it is verified here
 * against the real, composed prompt section rather than by remembering to obey
 * it: the section text is extracted from the plugin exactly as the runtime
 * registers it, and each scenario asserts that the statement governing it is
 * present and states the required outcome.
 *
 * Run: `node --test test/`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decide } from '../lib/decide.js'

const { RULES } = await import('../lib/rules.js')

/** One C1 that loses no quality: the MODIFY baseline. */
const C1 = {
  confirmation_id: 'C1',
  current_state: '首页主按钮为次级尺寸',
  original_confirmation: '主按钮是否需要更突出？',
  user_reply: 'C1 修改：把主按钮放大',
  relevant_context: '首页唯一主操作入口',
  quality_impact: 'NONE',
  candidate_solutions: [
    { label: 'promote', approach: '把主按钮提高一个视觉层级', scope: 'component', quality_loss: 'NONE' },
  ],
}

// ── 触发类场景 ──────────────────────────────────────────────────────────────

test('Test 1 — 用户正常提出新任务 → 不调用 confirmation_resolution', () => {
  // The gate requires a COMPLETED main task that already published open C-items.
  assert.match(RULES, /只有同时满足以下三条时，才允许调用 confirmation_resolution/)
  assert.match(RULES, /1\. DSH 已完成当前主任务；/)
  assert.match(RULES, /2\. DSH 已经明确输出一个或多个尚未解决的待确认事项；/)
  assert.match(RULES, /3\. 用户当前消息正在确认、选择、拒绝、修改、补充或处理其中至少一个待确认事项。/)
  assert.match(RULES, /用户第一次提出任务；/)
})

test('Test 2 — 有待确认事项但用户问无关问题 → 不调用插件，确认项继续 PENDING', () => {
  assert.match(RULES, /与已有确认项无关的问题或 follow-up；/)
  assert.match(RULES, /用户没有回复任何待确认事项；/)
  assert.match(RULES, /未被回复的确认项保持 PENDING/)
})

test('Test 8 — 混合消息：C1 走插件，新增需求走正常 DSH', () => {
  assert.match(RULES, /用户在同一条消息里同时回复确认项并提出新需求时，必须拆分处理，不得把整条消息交给插件/)
  assert.match(RULES, /"修改首页标题" → 使用正常 DSH 规则，不进入插件决策流程。/)
  // The new requirement must not reach the tool: one call carries one item.
  const value = decide(C1)
  assert.equal(value.confirmation_id, 'C1')
  assert.ok(!JSON.stringify(value).includes('首页标题'))
})

test('Test 10 — 确认流程结束后提出普通修改 → 不再调用插件', () => {
  assert.match(RULES, /立即退出待确认事项处理流程，恢复正常 DSH 行为/)
  assert.match(RULES, /该流程不得继续影响之后无关的用户请求/)
  assert.match(RULES, /它不改变其他任何情况下的正常行为/)
  assert.match(RULES, /不得在未满足上述条件时应用/)
})

// ── 决策类场景 ──────────────────────────────────────────────────────────────

test('Test 3 — 用户只回复 C1 修改 → 仅 C1 决策并 RESOLVED', () => {
  const value = decide(C1)
  assert.equal(value.confirmation_id, 'C1')
  assert.equal(value.status, 'READY_TO_EXECUTE')
  assert.equal(value.action, 'MODIFY')
  assert.equal(value.confirmation_state, 'RESOLVED')
  assert.equal(value.execution_required, true)
})

test('Test 4 — C1 修改，C2 保持 → C1 决策；C2 KEEP 且 RESOLVED', () => {
  const c1 = decide(C1)
  const c2 = decide({
    confirmation_id: 'C2',
    current_state: '卡片为默认视觉样式',
    original_confirmation: '是否更换卡片样式？',
    user_reply: 'C2 保持',
    preference_only: true,
    quality_impact: 'MEDIUM',
    user_impact_if_unchanged: 'NONE',
  })
  assert.equal(c1.action, 'MODIFY')
  assert.equal(c1.confirmation_state, 'RESOLVED')
  assert.equal(c2.action, 'KEEP_CURRENT')
  assert.equal(c2.selected_solution, 'KEEP_CURRENT')
  assert.equal(c2.execution_required, false)
  assert.equal(c2.confirmation_state, 'RESOLVED')
  assert.notEqual(c1.confirmation_id, c2.confirmation_id)
})

test('Test 5 — 修改不会降低质量 → ACTION = MODIFY', () => {
  const value = decide({ ...C1, quality_impact: 'NONE' })
  assert.equal(value.action, 'MODIFY')
  assert.equal(value.quality_impact, 'NONE')
})

test('Test 6 — 修改降低质量但保持现状不影响使用 → ACTION = KEEP_CURRENT', () => {
  const value = decide({
    confirmation_id: 'C2',
    current_state: '次要卡片为默认样式',
    original_confirmation: '是否调整卡片视觉？',
    user_reply: 'C2 调整',
    preference_only: true,
    quality_impact: 'MEDIUM',
    user_impact_if_unchanged: 'NONE',
  })
  assert.equal(value.action, 'KEEP_CURRENT')
  assert.equal(value.quality_impact, 'MEDIUM')
  assert.equal(value.user_impact_if_unchanged, 'NONE')
})

test('Test 7 — 修改降低质量且保持现状影响使用 → MODIFY，且选质量损失更小的方案', () => {
  const value = decide({
    confirmation_id: 'C1',
    current_state: '主按钮难以发现，用户报告找不到入口',
    original_confirmation: '主按钮是否需要更突出？',
    user_reply: 'C1 修改：把主按钮放大 300%',
    relevant_context: '首页唯一主操作入口',
    quality_impact: 'MEDIUM',
    user_impact_if_unchanged: 'MEDIUM',
    user_proposed_solution: '把主按钮放大 300%',
    candidate_solutions: [
      {
        label: 'USER_PROPOSED_SOLUTION',
        approach: '把主按钮放大 300%',
        user_proposed: true,
        quality_loss: 'HIGH',
        side_effects: { layout: 'HIGH' },
        scope: 'page',
      },
      {
        label: 'promote-one-level',
        approach: '提高一个视觉层级并强化局部间距',
        quality_loss: 'LOW',
        side_effects: { layout: 'LOW' },
        scope: 'component',
        reversibility: 'reversible',
      },
    ],
  })
  assert.equal(value.action, 'MODIFY')
  assert.equal(value.selected_solution, '提高一个视觉层级并强化局部间距')
  assert.notEqual(value.selected_solution, '把主按钮放大 300%')
  assert.equal(value.side_effect_risk, 'LOW')
  assert.equal(value.status, 'READY_TO_EXECUTE')
})

test('Test 9 — 用户只回复 C1 → C1 RESOLVED，C2/C3 保持 PENDING', () => {
  const c1 = decide(C1)
  assert.equal(c1.confirmation_state, 'RESOLVED')
  // The tool only ever speaks about the item it was called for, so C2/C3 cannot
  // be resolved or renumbered by it.
  const serialized = JSON.stringify(c1)
  assert.ok(!serialized.includes('C2'))
  assert.ok(!serialized.includes('C3'))
  assert.match(RULES, /C1 = RESOLVED，C2 = RESOLVED，C3 = PENDING/)
  assert.match(RULES, /不得擅自替用户处理用户没有回复的确认项/)
})

test('全部 10 个场景的规则文本都存在于实际注册的 System Prompt 段落中', () => {
  assert.ok(RULES.startsWith('## 待确认事项决策'))
  assert.ok(RULES.length > 1500, `rules text unexpectedly short: ${RULES.length}`)
  assert.ok(RULES.includes('【待确认事项】'))
  assert.ok(RULES.includes('confirmation_resolution'))
  assert.ok(RULES.includes('PENDING'))
  assert.ok(RULES.includes('RESOLVED'))
})
