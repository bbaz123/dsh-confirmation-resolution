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
 * Trigger protection is deliberately TWO layers:
 *
 *   - soft: the prompt section and the tool description tell the model when the
 *     tool belongs to the conversation, and when it does not;
 *   - hard: `./ledger.js` records which C-numbers this session actually
 *     published, and `execute()` refuses anything else with NOT_APPLICABLE
 *     BEFORE a decision is computed. A prompt rule is a request; the ledger is
 *     the enforcement point.
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
import { NOT_IDENTIFIED_GOAL, STATUS, decide, formatDecision, notApplicableValue } from './decide.js'
import { ConfirmationLedgers } from './ledger.js'
import { RULES } from './rules.js'

/**
 * One ledger store for the whole plugin row, shared by every session.
 *
 * Module scope is deliberate: a Cordis row has a single instance, and the store
 * is keyed by session id, so sharing it across sessions is what keeps each
 * session's C-numbers separate. It holds no live DSH object — only strings and
 * numbers — and `apply()` clears it when the row unloads.
 */
const ledgers = new ConfirmationLedgers()

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

  // The ledger lives on one host-plane row; drop every session's items with it.
  ctx.effect(() => () => ledgers.clear(), 'confirmation-resolution: session ledgers')

  ctx.tools.register(defineTool({
    name: 'confirmation_resolution',
    description: [
      '待确认事项决策：对 DSH 已输出、且用户刚刚回复的**一个**确认事项做出判断并返回执行指令。',
      '',
      '只在同时满足以下条件时调用：DSH 已完成当前主任务；DSH 已输出尚未解决的待确认事项；用户当前消息正在回复其中至少一个事项。',
      '禁止在首次任务、普通修改、普通新需求、无关 follow-up、已解决事项、或正常任务执行阶段调用。',
      '一次调用只处理一个确认事项；同一条消息里回复了多个确认项时，逐个调用。',
      '本工具带有**会话级代码守卫**：编号从未发布过、或已经 RESOLVED 且未被重新发布时，会返回 STATUS = NOT_APPLICABLE 并拒绝决策。请勿重试该调用，改按普通 DSH 规则处理用户消息。',
      '',
      '调用方（DSH）在调用前必须完成四项语义工作，本工具不做自然语言推断：',
      '1. 识别 user_goal（用户真实目标）；',
      '2. 判断 quality_impact（或给出 quality_dimensions 证据）；',
      '3. 在 quality_impact !== NONE 时判断 user_impact_if_unchanged（或给出 user_impact_dimensions / preference_only）；',
      '4. 为 ACTION = MODIFY 的情形生成 2–3 个 candidate_solutions 供淘汰与排序（未提供时候本工具返回 INSUFFICIENT_CONTEXT，不会自行创造方案）。',
      '本工具据此执行固定决策：质量不受损 → MODIFY；质量受损但保持现状不影响实际使用 → KEEP_CURRENT；质量受损且保持现状影响实际使用 → MODIFY，并在候选方案中按 02 §8 优先级选择方案。',
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
        description: '已识别出的真实目标（03 §9 要求调用方在调用前完成识别）。本工具不做自然语言推断：为空时输出 USER_GOAL 为"未识别"，且 ACTION = MODIFY 需要目标才能比较方案。',
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
            user_benefit: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'], description: '对用户实际使用的收益（02 §8 优先级 2）。' },
            system_consistency: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'], description: '与既有系统/组件/设计规范的一致性风险（优先级 5）。NONE 最好。' },
            stability_risk: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'], description: '对稳定性的风险（优先级 6）。NONE 最好。' },
            expands_beyond_necessity: { type: 'boolean', description: '是否超出解决问题所必需的范围。' },
            violates_constraints: { type: 'boolean', description: '是否违反 available_constraints。' },
            within_permitted_scope: { type: 'boolean' },
            addresses_root_cause: { type: 'boolean', description: '是否解决根因；false 且存在零质量损失的替代方案时会被淘汰。' },
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
        description: '在缺少显式使用影响证据、且已提供 user_goal 时，允许推断一个较低的保持现状影响。默认 false。',
      },
      action: {
        type: 'string',
        enum: ['resolve', 'register'],
        description: 'resolve（默认）对本项做决策；register 只把本轮发布给用户的确认项编号登记进会话账本，不做决策。调用前请先用 register 登记本轮输出的全部 C 编号。',
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
          status: { type: 'string', enum: ['READY_TO_EXECUTE', 'INSUFFICIENT_CONTEXT', 'NOT_APPLICABLE'] },
          missing_information: { type: 'string' },
          current_state: { type: 'string' },
          original_confirmation: { type: 'string' },
          user_reply: { type: 'string' },
          confirmation_state: { type: 'string', enum: ['PENDING', 'RESOLVED', 'UNCHANGED'] },
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
    /**
     * The code-level half of the trigger guard.
     *
     * 01's activation scope lives in the System Prompt, which is a request, not an
     * enforcement point. Before any decision is computed this checks the session
     * ledger: an unknown C-number, or one that is already RESOLVED, can only come
     * from a call that does not belong to a confirmation flow, so it is refused
     * with NOT_APPLICABLE and nothing is computed or executed.
     *
     * @param args - validated tool arguments.
     * @param exec - the run context; `exec.agent.id` is the live SessionId.
     * @returns the decision, the registration confirmation, or the refusal.
     */
    execute(args, exec) {
      const sessionId = exec?.agent?.id
      let ledger
      try {
        ledger = ledgers.for(requireSessionId(sessionId))
        const itemId = typeof args.confirmation_id === 'string' ? args.confirmation_id.trim() : ''
        const registering = args.action === 'register'

        if (registering) {
          const state = ledger.register(itemId, {
            originalConfirmation: args.original_confirmation,
            currentState: args.current_state,
            userGoal: args.user_goal,
          })
          return Promise.resolve(registeredValue({ itemId, state, ledger, currentState: args.current_state, originalConfirmation: args.original_confirmation, userReply: args.user_reply }))
        }

        // Implicit registration is a FIRST-ROUND convenience only: before any
        // item exists for this session, a call that carries the item's full text
        // is taken as its publication, so a caller that forgot `register` is not
        // dead on arrival. Once the session holds any item, a new C-number must
        // go through the explicit `register` action — otherwise a resolve call
        // could re-publish an id it invented and walk straight past the
        // ALREADY_RESOLVED refusal.
        if (ledger.size() === 0
          && ledger.get(itemId) === undefined
          && typeof args.original_confirmation === 'string' && args.original_confirmation.trim() !== ''
          && typeof args.current_state === 'string' && args.current_state.trim() !== '') {
          ledger.register(itemId, {
            originalConfirmation: args.original_confirmation,
            currentState: args.current_state,
            userGoal: args.user_goal,
          })
        }

        const verdict = ledger.guard(itemId)
        if (!verdict.ok) {
          return Promise.resolve(notApplicableValue({
            confirmationId: itemId,
            currentState: args.current_state ?? '',
            originalConfirmation: args.original_confirmation ?? '',
            userReply: args.user_reply ?? '',
            code: verdict.code,
            reason: verdict.reason,
          }))
        }

        const value = decide(args)
        // Only an executable decision closes the item. INSUFFICIENT_CONTEXT keeps
        // it PENDING (02 §13), so the caller can retry with the missing context.
        if (value.status === STATUS.READY) ledger.resolve(itemId)
        return Promise.resolve(value)
      } catch (error) {
        // Ledger bookkeeping must never turn a decision into a crash. Surface the
        // failure as INSUFFICIENT_CONTEXT so the item stays PENDING.
        return Promise.resolve(insufficientFromError(error, args))
      }
    },
  }))
}

/** Read the calling session id, or explain why the guard cannot run. */
function requireSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('confirmation_resolution requires a calling agent session (exec.agent.id was unavailable)')
  }
  return sessionId
}

/** The `action: 'register'` acknowledgement. */
function registeredValue({ itemId, state, ledger, currentState, originalConfirmation, userReply }) {
  return {
    confirmation_id: itemId,
    action: 'KEEP_CURRENT',
    quality_impact: 'NONE',
    user_impact_if_unchanged: 'NONE',
    user_goal: NOT_IDENTIFIED_GOAL,
    selected_solution: 'NONE',
    execution_scope: 'NONE',
    do_not_change: currentState ?? 'current state',
    side_effect_risk: 'NONE',
    status: STATUS.NOT_APPLICABLE,
    missing_information: 'NONE',
    current_state: currentState ?? '',
    original_confirmation: originalConfirmation ?? '',
    user_reply: userReply ?? '',
    confirmation_state: state,
    execution_required: false,
    quality_evidence: 'not evaluated (registration only)',
    user_impact_evidence: 'not evaluated (registration only)',
    selection_reason: `registered ${itemId} in the session ledger`,
    notes: `Ledger for this session now holds: ${ledger.snapshot().map((item) => `${item.id}=${item.state}`).join(', ')}. No decision was made; call again with action="resolve" when the user replies to ${itemId}.`,
  }
}

/** Turn a guard failure into a safe, non-executable decision. */
function insufficientFromError(error, args) {
  return {
    confirmation_id: typeof args?.confirmation_id === 'string' ? args.confirmation_id : '',
    action: 'KEEP_CURRENT',
    quality_impact: 'NONE',
    user_impact_if_unchanged: 'NONE',
    user_goal: NOT_IDENTIFIED_GOAL,
    selected_solution: 'NONE',
    execution_scope: 'NONE',
    do_not_change: typeof args?.current_state === 'string' && args.current_state !== '' ? args.current_state : 'current state',
    side_effect_risk: 'NONE',
    status: STATUS.INSUFFICIENT,
    missing_information: 'confirming session ledger unavailable',
    current_state: typeof args?.current_state === 'string' ? args.current_state : '',
    original_confirmation: typeof args?.original_confirmation === 'string' ? args.original_confirmation : '',
    user_reply: typeof args?.user_reply === 'string' ? args.user_reply : '',
    confirmation_state: 'PENDING',
    execution_required: false,
    quality_evidence: 'not evaluated',
    user_impact_evidence: 'not evaluated',
    selection_reason: 'the session ledger could not be reached, so no solution is selected',
    notes: `Ledger guard failed: ${error instanceof Error ? error.message : String(error)}. Nothing may be executed for this item.`,
  }
}

// `ledgers` is exported so tests can inspect and reset the session store; it is
// not part of the plugin's public contract and no other row should touch it.
export { Config, apply, ledgers }
