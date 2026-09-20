/**
 * DSH 待确认事项决策 — `confirmation_resolution`.
 *
 * A HOST-plane Cordis plugin with exactly two contributions:
 *
 *   1. one global `systemPrompt` section carrying the runtime rules of
 *      01_DSH_System_Prompt_待确认事项触发规则 — when to report 待确认事项, when the
 *      tool may be called, when it must not, how the reply maps to C-numbers,
 *      how a mixed message splits, and what to do with the returned STATUS;
 *   2. the `confirmation_resolution` model tool, whose decision core lives in
 *      `./decide.js` and implements 02_Confirmation_Resolution_Plugin_执行规则.
 *
 * It publishes no service, so it needs no isolate realm; it registers into the
 * host `tools` and `systemPrompt` registries that this profile already mounts.
 * The plugin NEVER touches pages, code, files, or project structure: it decides
 * and returns a plan, and DSH performs the execution.
 *
 * @module dsh-plugin-confirmation-resolution
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { decide, formatDecision } from './decide.js'
import { RULES } from './rules.js'

/** Cordis plugin name. */
export const name = 'confirmation-resolution'

/** The host registries this row contributes to. */
export const inject = ['tools', 'systemPrompt']

/** The global prompt-section name; a preset may shadow it by reusing the name. */
const DEFAULT_SECTION_NAME = 'confirmation:policy'

/**
 * Fallback order when the composition does not pin one. 116 sits after the
 * approval-policy runtime context (115) and before the delegation/workflow
 * policies, i.e. after identity, before per-tool instructions.
 */
const DEFAULT_SECTION_ORDER = 116

/** Composition configuration for this row; both fields carry working defaults. */
const Config = z.object({
  sectionName: z.string().default(DEFAULT_SECTION_NAME),
  order: z.number().default(DEFAULT_SECTION_ORDER),
})

/**
 * Register the prompt section and the decision tool on the host registries.
 *
 * @param ctx - the plugin's Cordis context (host plane).
 * @param config - optional row configuration (sectionName, order).
 */
function apply(ctx, config) {
  const sectionName = typeof config?.sectionName === 'string' && config.sectionName.trim() !== ''
    ? config.sectionName.trim()
    : DEFAULT_SECTION_NAME
  const order = Number.isFinite(config?.order)
    ? config.order
    : (ctx.systemPrompt.getSectionOrder('TOOL_REPORT') ?? DEFAULT_SECTION_ORDER)

  ctx.effect(
    () => ctx.systemPrompt.section({ name: sectionName, order, text: RULES }),
    'confirmation-resolution: prompt section',
  )

  ctx.tools.register(defineTool({
    name: 'confirmation_resolution',
    description: [
      '待确认事项决策：对 DSH 已输出、且用户刚刚回复的**一个**确认事项做出判断并返回执行指令。',
      '',
      '只在同时满足以下条件时调用：DSH 已完成当前主任务；DSH 已输出尚未解决的待确认事项；用户当前消息正在回复其中至少一个事项。',
      '禁止在首次任务、普通修改、普通新需求、无关 follow-up、已解决事项、或正常任务执行阶段调用。',
      '一次调用只处理一个确认事项；同一条消息里回复了多个确认项时，逐个调用。',
      '',
      '调用方（DSH）必须已经完成语义判断并作为证据传入：quality_impact（或 quality_dimensions），并在 quality_impact !== NONE 时给出 user_impact_if_unchanged（或 user_impact_dimensions / preference_only）。',
      '本工具据此执行固定决策：质量不受损 → MODIFY；质量受损但保持现状不影响实际使用 → KEEP_CURRENT；质量受损且保持现状影响实际使用 → MODIFY，并在候选方案中选择真实收益最大、质量损失最小、副作用最少的方案。',
      '用户提出的具体做法只是候选方案之一，不自动获得优先级；若它触发硬性淘汰条件，返回的方案不是用户的原话。',
      '信息确实不足以可靠判断时才返回 INSUFFICIENT_CONTEXT，否则必须直接决策。',
      '',
      '本工具不修改页面、代码、文件或项目结构；实际执行由 DSH 按返回的 SELECTED_SOLUTION / EXECUTION_SCOPE / DO_NOT_CHANGE 完成。',
    ].join('\n'),
    parameters: {
      confirmation_id: {
        type: 'string',
        required: true,
        description: '稳定确认项编号，例如 C1。必须与已输出给用户的编号一致。',
      },
      current_state: {
        type: 'string',
        required: true,
        description: '该确认事项当前已存在的状态（用户如果要"改"，改的就是这个状态）。',
      },
      original_confirmation: {
        type: 'string',
        required: true,
        description: 'DSH 原先提出的确认事项原文。',
      },
      user_reply: {
        type: 'string',
        required: true,
        description: '用户针对该确认项的实际回复。',
      },
      relevant_context: {
        type: 'string',
        description: '仅传入影响本次判断的相关上下文；不要整段粘贴无关对话。',
      },
      user_goal: {
        type: 'string',
        description: '已明确识别出的真实目标。为空时由 user_reply 与 relevant_context 推断。',
      },
      available_constraints: {
        type: 'string',
        description: '不可改变项、设计系统、技术限制等。',
      },
      quality_impact: {
        type: 'string',
        enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'],
        description: '调用方对"执行该确认修改后的状态 vs 当前状态"的整体质量影响判断。省略时用 quality_dimensions 推导。',
      },
      quality_dimensions: {
        type: 'json',
        description: '逐维度质量证据，例如 {"layout":"DEGRADED","clarity":"SAME"}；可用 degraded/improved 或 NONE/LOW/MEDIUM/HIGH。与 quality_impact 同时给出且冲突时取更保守的一级。',
      },
      user_impact_if_unchanged: {
        type: 'string',
        enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'],
        description: '保持当前状态不改时对用户实际使用的影响。只在 quality_impact !== NONE 时需要。',
      },
      user_impact_dimensions: {
        type: 'json',
        description: '逐维度使用影响证据，例如 {"key_entry_hard_to_find":"MEDIUM","core_task_blocked":true}。',
      },
      preference_only: {
        type: 'boolean',
        description: '该项属于纯审美/颜色/非关键位置/装饰偏好（默认不等于实际使用问题）。true 时保持现状不构成使用影响。',
      },
      user_proposed_solution: {
        type: 'string',
        description: '用户提出的具体实现方式（若有）。它只是候选方案之一，不自动优先。',
      },
      candidate_solutions: {
        type: 'array',
        description: '候选方案列表（ACTION = MODIFY 时至少给出一个替代方案，否则可能因缺少可行方案而返回 INSUFFICIENT_CONTEXT）。硬性淘汰条件：solves_user_problem=false、expands_beyond_necessity=true、within_permitted_scope=false、violates_constraints=true、quality_loss 超过可避免上限、side_effects 更严重、幅度超过 200%。',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            label: { type: 'string', description: '候选方案标识；用户原话请用 USER_PROPOSED_SOLUTION。' },
            approach: { type: 'string', required: true, description: '该方案具体怎么做（会作为 SELECTED_SOLUTION 返回）。' },
            solves_user_problem: { type: 'boolean', description: '是否真正解决用户的实际问题。' },
            quality_loss: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'], description: '该方案自身的质量损失。' },
            side_effects: {
              type: 'object',
              additionalProperties: true,
              properties: {
                functional: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
                visual: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
                layout: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
                responsive: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
                interaction: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
                content: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
                consistency: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
                accessibility: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
                performance: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
              },
            },
            scope: { type: 'string', enum: ['value', 'state', 'component', 'section', 'page', 'system'], description: '最小必要修改的粒度，越窄越好。' },
            reversibility: { type: 'string', enum: ['reversible', 'partial', 'irreversible'] },
            complexity: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
            expands_beyond_necessity: { type: 'boolean', description: '是否超出解决问题所必需的范围。' },
            violates_constraints: { type: 'boolean', description: '是否违反 available_constraints。' },
            within_permitted_scope: { type: 'boolean' },
            addresses_root_cause: { type: 'boolean' },
            user_proposed: { type: 'boolean', description: '该候选是否就是用户提出的原话方案。' },
          },
        },
      },
      do_not_change: {
        type: 'string',
        description: '明确不得修改的范围；作为 DO_NOT_CHANGE 原样返回。',
      },
      infer_user_impact_if_unchanged: {
        type: 'boolean',
        description: '在缺少显式使用影响证据时，允许依据已识别的 user_goal 推断一个较低的保持现状影响。默认 false。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          confirmation_id: { type: 'string' },
          action: { type: 'string', enum: ['MODIFY', 'KEEP_CURRENT'] },
          quality_impact: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
          user_impact_if_unchanged: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
          user_goal: { type: 'string' },
          selected_solution: { type: 'string' },
          execution_scope: { type: 'string' },
          do_not_change: { type: 'string' },
          side_effect_risk: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
          status: { type: 'string', enum: ['READY_TO_EXECUTE', 'INSUFFICIENT_CONTEXT'] },
          missing_information: { type: 'string' },
          current_state: { type: 'string' },
          original_confirmation: { type: 'string' },
          user_reply: { type: 'string' },
          confirmation_state: { type: 'string', enum: ['PENDING', 'RESOLVED'] },
          execution_required: { type: 'boolean' },
          quality_evidence: { type: 'string' },
          user_impact_evidence: { type: 'string' },
          selection_reason: { type: 'string' },
          notes: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${formatDecision(value)}\n\nEXECUTION_REQUIRED: ${value.execution_required === true ? 'YES' : 'NO'}\nCONFIRMATION_STATE_AFTER: ${value.confirmation_state}\nWHY: ${value.selection_reason}\nEVIDENCE: quality[${value.quality_evidence}] user[${value.user_impact_evidence}]`,
      }],
    },
    execute(args) {
      return Promise.resolve(decide(args))
    },
  }))
}

export { Config, apply }
