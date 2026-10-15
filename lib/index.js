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
import { ACTION, NOT_IDENTIFIED_GOAL, STATUS, decide, formatDecision, notApplicableValue } from './decide.js'
import {
  LIFECYCLE,
  OUTCOME,
  SCHEMA_VERSION,
  decideV2,
  ledgerValueV2,
  notApplicableV2,
} from './decision-v2.js'
import { ConfirmationLedgers, ITEM_STATE, ITEM_VERSION, REJECTION } from './ledger.js'
import { RULES, RULES_V2 } from './rules.js'

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

/**
 * The V2 prompt section name and its default offset from the V1 section. V2 is a
 * SEPARATE section that only exists when V2 is enabled, so the default profile
 * never carries a rule about a tool it cannot call.
 */
const DEFAULT_V2_SECTION_NAME = 'confirmation:policy.v2'
const DEFAULT_V2_SECTION_OFFSET = 1

/** Composition configuration for this row; every field carries a working default. */
const Config = z.object({
  sectionName: z.string().default(DEFAULT_SECTION_NAME),
  order: z.number().default(DEFAULT_SECTION_ORDER),
  /**
   * Gray release (方案 §8 PR-3): V1 stays the default. Setting this to true
   * registers the versioned V2 tool `confirmation_resolution_v2` alongside it;
   * `decisionV2Sessions` then narrows it to specific sessions.
   */
  enableDecisionV2: z.boolean().default(false),
  /** Session ids allowed to use V2; empty means every session once V2 is on. */
  decisionV2Sessions: z.array(z.string()).default([]),
  /** Prompt-section name of the V2 rules; only registered when V2 is on. */
  v2SectionName: z.string().default(DEFAULT_V2_SECTION_NAME),
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

  // ── V2 gray release (方案 §8 PR-3) ────────────────────────────────────────
  // V1 is the default and is never replaced. V2 adds a second prompt section and
  // a second, versioned tool, and only when the composition asks for it.
  const enableV2 = config?.enableDecisionV2 === true
  const v2Sessions = Array.isArray(config?.decisionV2Sessions)
    ? config.decisionV2Sessions
      .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      .map((entry) => entry.trim())
    : []
  if (enableV2) {
    const v2SectionName = typeof config?.v2SectionName === 'string' && config.v2SectionName.trim() !== ''
      ? config.v2SectionName.trim()
      : DEFAULT_V2_SECTION_NAME
    ctx.effect(
      () => ctx.systemPrompt.section({ name: v2SectionName, order: order + DEFAULT_V2_SECTION_OFFSET, text: RULES_V2 }),
      'confirmation-resolution: v2 prompt section',
    )
  }

  ctx.tools.register(defineTool({
    name: 'confirmation_resolution',
    description: [
      '待确认事项决策：对 DSH 已输出、且用户刚刚回复的**一个**确认事项做出判断并返回执行指令。',
      '',
      '只在同时满足以下条件时调用：DSH 已完成当前主任务；DSH 已输出尚未解决的待确认事项；用户当前消息正在回复其中至少一个事项。',
      '禁止在首次任务、普通修改、普通新需求、无关 follow-up、已解决事项、或正常任务执行阶段调用。',
      '一次调用只处理一个确认事项；同一条消息里回复了多个确认项时，逐个调用。',
      '',
      '**状态机（三个动作，缺一不可）**：',
      '1. 输出确认项后立刻 register 每个编号 → STATUS = REGISTERED，状态 PENDING；',
      '2. 用户回复某项后用 decide 决策 → MODIFY 返回 STATUS = READY_TO_EXECUTE，状态进入 AWAITING_EXECUTION；',
      '3. DSH 真正执行成功后用 complete 关闭该项 → 状态 RESOLVED。',
      'KEEP_CURRENT 不需要 complete：不修改本身在决策时就已完成，decide 会直接把它标为 RESOLVED。',
      '**MODIFY 决策不等于执行**：执行失败时不要调用 complete，该项保持 AWAITING_EXECUTION，可以重新 decide 或重试执行。',
      '',
      '本工具带有**会话级代码守卫**，且**没有任何隐式登记**：未先 register 的编号、或已经 RESOLVED 的编号，都会返回 STATUS = NOT_APPLICABLE 并拒绝。收到 NOT_APPLICABLE 时不得重试，改按普通 DSH 规则处理用户消息。',
      '合法登记/完成返回 STATUS = REGISTERED，与 NOT_APPLICABLE 语义不同：前者是成功的账本写入，后者才是拒绝。',
      '',
      '调用方（DSH）在调用前必须完成四项语义工作，本工具不做自然语言推断：',
      '1. 识别 user_goal（用户真实目标）——**ACTION = MODIFY 时必填**，缺失会返回 INSUFFICIENT_CONTEXT（USER_GOAL_REQUIRED_FOR_MODIFY）；KEEP_CURRENT 不需要；',
      '2. 判断 quality_impact（或给出 quality_dimensions 证据）；',
      '3. 在 quality_impact !== NONE 时判断 user_impact_if_unchanged（或给出 user_impact_dimensions / preference_only）；',
      '4. 为 ACTION = MODIFY 的情形生成 2–3 个 candidate_solutions 供淘汰与排序（未提供时本工具返回 INSUFFICIENT_CONTEXT，不会自行创造方案）。',
      '本工具据此执行固定决策：质量不受损 → MODIFY；质量受损但保持现状不影响实际使用 → KEEP_CURRENT；质量受损且保持现状影响实际使用 → MODIFY，并在候选方案中按 02 §8 优先级选择方案。',
      '用户提出的具体做法只是候选方案之一，不自动获得优先级；若它触发硬性淘汰条件，返回的方案不是用户的原话。',
      '信息确实不足以可靠判断时才返回 INSUFFICIENT_CONTEXT，否则必须直接决策。',
      '',
      '本工具不修改页面、代码、文件或项目结构；实际执行由 DSH 按返回的 SELECTED_SOLUTION / EXECUTION_SCOPE / DO_NOT_CHANGE 完成，执行成功后必须回报 complete。',
      '',
      '**调用纪律（防止工具参数 JSON 被宿主判为不合法而整轮失败）**：',
      '一次只调用一个确认项，同一条消息里有多个确认项时按编号顺序逐个调用，不要并发；候选方案只写真正有证据的字段，不要复述原题或粘贴整段上下文。',
      'JSON 写法保持最简结构：键与值之间只用一个冒号（不要双冒号）；字符串内部的英文双引号用 \\" 转义；不要输出重复的键组或为凑字段反复粘贴同一组默认值。',
      '若调用返回"工具输入 JSON 不合法"，说明本次调用没有执行、账本状态未变，直接重发；连续失败就拆成单项判定，或只传必填字段。',
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
        // Conditionally required, enforced per action in execute(): `register`
        // runs right after DSH publishes the item, when no reply exists yet, and
        // `complete` reports an execution, not a reply. Only `decide` needs it.
        description: '用户针对该确认项的实际回复。action="decide" 时必填；register / complete 不需要。',
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
        enum: ['register', 'decide', 'complete'],
        description: [
          'register：把本轮发布给用户的确认项编号登记进会话账本（输出确认项后立刻做，每个编号一次）。',
          'decide（默认）：对该项做决策。MODIFY 决策不会关闭该项，而是进入 AWAITING_EXECUTION。',
          'complete：DSH 真正执行成功后调用，才把该项标记 RESOLVED。',
          '没有任何隐式登记：未先 register 的编号会被守卫拒绝。',
        ].join(' '),
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
          status: { type: 'string', enum: ['READY_TO_EXECUTE', 'INSUFFICIENT_CONTEXT', 'REGISTERED', 'NOT_APPLICABLE'] },
          missing_information: { type: 'string' },
          current_state: { type: 'string' },
          original_confirmation: { type: 'string' },
          user_reply: { type: 'string' },
          confirmation_state: { type: 'string', enum: ['PENDING', 'AWAITING_EXECUTION', 'RESOLVED', 'UNCHANGED'] },
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
     * The code-level half of the trigger guard, and the only writer of ledger state.
     *
     * 01's activation scope lives in the System Prompt, which is a request, not an
     * enforcement point. Before any decision is computed this checks the session
     * ledger, and the three actions move one confirmation item through the state
     * machine without ever resolving it early:
     *
     *   register → records the published C-number. Nothing is decided.
     *   decide   → guard, then `decide()`. A MODIFY leaves the item PENDING: the
     *              decision is not the execution, so a later failure must not find
     *              the item already closed. INSUFFICIENT_CONTEXT also stays
     *              PENDING. Only KEEP_CURRENT closes here, because "do not change
     *              anything" is already complete the moment it is decided.
     *   complete → called after DSH actually executed, resolves the item. This is
     *              the ONLY path that closes a MODIFY.
     *
     * There is deliberately no implicit registration: a call for a number this
     * session never published is refused, with no back door that would let a call
     * carrying its own text walk past the guard.
     *
     * @param args - validated tool arguments.
     * @param exec - the run context; `exec.agent.id` is the live SessionId.
     * @returns the decision, the ledger acknowledgement, or the refusal.
     */
    execute(args, exec) {
      const sessionId = exec?.agent?.id
      try {
        const ledger = ledgers.for(requireSessionId(sessionId))
        const itemId = typeof args.confirmation_id === 'string' ? args.confirmation_id.trim() : ''
        const action = typeof args.action === 'string' && args.action.trim() !== '' ? args.action.trim() : 'decide'

        if (action === 'register') return Promise.resolve(registerItem(ledger, itemId, args))
        if (action === 'complete') return Promise.resolve(completeItem(ledger, itemId, args))

        // `resolve` was the pre-state-machine name for this action; it stays an
        // accepted alias so an older caller cannot silently fall through.
        if (action !== 'decide' && action !== 'resolve') {
          return Promise.resolve(notApplicableValue({
            confirmationId: itemId,
            currentState: args.current_state ?? '',
            originalConfirmation: args.original_confirmation ?? '',
            userReply: args.user_reply ?? '',
            code: 'UNKNOWN_ACTION',
            reason: `unknown action "${action}" (expected register, decide, or complete)`,
          }))
        }

        // `user_reply` is conditionally required; the schema cannot express that
        // (no discriminated union), so it is enforced here per action.
        if (String(args.user_reply ?? '').trim() === '') {
          return Promise.resolve(missingUserReplyValue(itemId, args))
        }

        // V1 drives V1 items only: a number opened by the V2 contract is refused
        // rather than re-interpreted under the old vocabulary (方案 §7 ledger row).
        const verdict = ledger.guard(itemId, { version: ITEM_VERSION.V1 })
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

        // A new decide call supersedes any previous outstanding MODIFY decision.
        // If this is a retry after a failed execution, the old authorisation is
        // invalidated BEFORE the new decision is computed — otherwise an
        // INSUFFICIENT_CONTEXT result would leave a stale MODIFY authorisation
        // alive and `complete` could still close the item.
        ledger.beginDecision(itemId)

        const value = decide(args)
        // Record the decision before reporting it: a MODIFY moves the item to
        // AWAITING_EXECUTION, which is the *only* state `complete` accepts. This
        // is what makes `register → decide → execute → complete` a code-level
        // contract rather than a prompt-level request.
        if (value.status === STATUS.READY) {
          ledger.markDecided(itemId, value.action)
          // KEEP_CURRENT is self-completing: there is nothing left to execute,
          // so nothing is left to authorise either.
          if (value.action === ACTION.KEEP_CURRENT) ledger.resolve(itemId)
        }
        return Promise.resolve({ ...value, confirmation_state: ledger.get(itemId).state })
      } catch (error) {
        // Ledger bookkeeping must never turn a decision into a crash. Surface the
        // failure as INSUFFICIENT_CONTEXT so the item stays PENDING.
        return Promise.resolve(insufficientFromError(error, args))
      }
    },
  }))

  // The versioned V2 entry point. It is a SECOND tool, not a change to the
  // first one: the V1 schema, action enum and status vocabulary are untouched,
  // so an existing caller (and every existing test) keeps its exact contract.
  if (enableV2) ctx.tools.register(defineTool(defineV2Tool(v2Sessions)))
}

/**
 * The `confirmation_resolution_v2` tool definition (方案 §5).
 *
 * Version dispatch lives here and NOT in `decision-v2.js`: the core stays a pure
 * function, while this closure owns the ledger, the session allow-list and the
 * translation of a decision into a state transition.
 *
 * @param sessions - session ids allowed to use V2; empty means all of them.
 * @returns the tool definition passed to `defineTool`.
 */
function defineV2Tool(sessions) {
  return {
    name: 'confirmation_resolution_v2',
    description: [
      '待确认事项决策 V2（综合评判）：对 DSH 已输出、且用户刚刚回复的**一个**确认事项做出多维裁决。',
      '',
      '触发条件与 V1 完全相同；本工具不扩大触发范围，也不处理普通任务。只在会话启用了 V2 时可见。',
      '一次只调用一个确认项；同一条消息里回复了多个确认项时，按编号顺序逐个调用。',
      '',
      '**动作**：',
      '- register：登记本轮发布的编号 → outcome=REGISTERED，状态 PENDING；',
      '- decide（默认）：账本校验 → 多维裁决。MODIFY 返回 READY_TO_EXECUTE 与 decision_revision；',
      '  KEEP_CURRENT 决策即完成；REQUEST_APPROVAL 进入 AWAITING_APPROVAL；INSUFFICIENT_CONTEXT / REJECT 保持 PENDING。',
      '- complete：DSH 真正执行成功后调用，**必须带 decide 返回的 decision_revision**，否则拒绝；',
      '- approve：当前宿主没有可核验的审批来源，一律返回 NOT_APPLICABLE（NO_VERIFIABLE_APPROVAL_SOURCE）。',
      '  用户答复后请发起新的 decide，并带上 authorization.user_decision 与 authorization.source。',
      '',
      '**五个 outcome**：MODIFY（按 selected_solution + execution_scope 执行）/ KEEP_CURRENT（不改，已 RESOLVED）/',
      'REQUEST_APPROVAL（不是执行授权，先问用户）/ INSUFFICIENT_CONTEXT（按 missing_information 补证据后重判，不得回落用户原方案）/',
      'REJECT（请求被硬门禁挡住，不等于 KEEP_CURRENT，必须解释原因）。',
      '后三种结果都不携带可执行许可。',
      '',
      '**evidence_state 的含义**：候选的 PASS 表示门禁证据（是否真的解决用户问题、是否越界、是否违反约束、是否有权限、是否安全）已核实；',
      '任何缺失都按 UNKNOWN 处理并拦住执行——UNKNOWN 不等于 PASS。goal_fit 与 impact_risk 必须给出。',
      '不确定就当 UNKNOWN，不要用乐观默认值充当通过。',
      '',
      '本工具不修改页面、代码、文件或项目结构；实际执行由 DSH 完成，执行成功后才调用 complete。',
      '',
      '**调用纪律**：一次只调用一个确认项；候选只写真正有证据的字段，不复述原题；',
      'JSON 只用一个冒号，字符串内部引号必须转义，不要输出重复键组。',
    ].join('\n'),
    parameters: {
      schema_version: {
        type: 'string',
        required: true,
        enum: [SCHEMA_VERSION],
        description: 'V2 契约版本，必须是 2.0。',
      },
      operation: {
        type: 'string',
        enum: ['register', 'decide', 'complete', 'approve'],
        description: 'register 登记；decide（默认）裁决；complete 执行成功后关闭；approve 当前一律拒绝。',
      },
      confirmation_id: {
        type: 'string',
        required: true,
        description: '稳定确认项编号，例如 C1。必须与已输出给用户的编号一致。',
      },
      current_state: {
        type: 'string',
        description: '该确认事项当前已存在的状态。',
      },
      original_confirmation: {
        type: 'string',
        description: 'DSH 原先提出的确认事项原文（register 时必填）。',
      },
      user_reply: {
        type: 'string',
        description: '用户针对该确认项的实际回复。decide 时必填；register / complete 不需要。',
      },
      context: {
        type: 'json',
        description: '本次判断的场景与目标：{scenario, user_goal, goal_source, constraints, do_not_change, baseline}。scenario 决定比较权重；goal_source 取 USER_STATED 或 DSH_INFERRED。',
      },
      authorization: {
        type: 'json',
        description: '权限上下文：{verification, permitted_scope, source, user_decision}。verification 取 PASS / FAIL / UNKNOWN，缺失按 UNKNOWN 处理并拦住执行；仅当 source=USER_REPLY 且 user_decision=APPROVED（用户真的在同一条回复里同意）才算已获用户同意，模型自填的 approved 布尔值一律不算。',
      },
      candidates: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: '候选列表，至少含一个 KEEP_CURRENT 基线。每个候选可带：id / kind（MODIFY 或 KEEP_CURRENT）/ approach / scope / reversibility / goal_fit / user_value / output_quality / impact_risk / execution_cost / long_term_value / evidence_state / within_permitted_scope / violates_constraints / expands_beyond_necessity / addresses_root_cause / external_effect / irreversible_effect / approval_required / scale / scale_unit / scale_verified / user_proposed。等级用 NONE / LOW / MEDIUM / HIGH。',
      },
      decision_revision: {
        type: 'number',
        description: '仅 complete 需要：上一次 decide 返回的 decision_revision。版本不匹配会被拒绝，防止旧授权关闭新决策。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          schema_version: { type: 'string' },
          confirmation_id: { type: 'string' },
          outcome: {
            type: 'string',
            enum: [OUTCOME.MODIFY, OUTCOME.KEEP_CURRENT, OUTCOME.REQUEST_APPROVAL, OUTCOME.INSUFFICIENT_CONTEXT, OUTCOME.REJECT, OUTCOME.REGISTERED, OUTCOME.NOT_APPLICABLE],
          },
          lifecycle_status: {
            type: 'string',
            enum: [LIFECYCLE.READY_TO_EXECUTE, LIFECYCLE.AWAITING_EXECUTION, LIFECYCLE.AWAITING_APPROVAL, LIFECYCLE.PENDING, LIFECYCLE.RESOLVED, LIFECYCLE.UNCHANGED],
          },
          selected_solution_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          selected_solution: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          approval_required: { type: 'boolean' },
          approval_question: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          execution_scope: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          do_not_change: { type: 'array', items: { type: 'string' } },
          executable: { type: 'boolean' },
          reason_codes: { type: 'array', items: { type: 'string' } },
          missing_information: { type: 'array', items: { type: 'string' } },
          rejected_candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string' },
                reason_code: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
          decision_revision: { type: 'integer' },
          // Any lossless JSON value, including null for a refusal that made no decision.
          decision_trace: { type: 'json' },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `OUTCOME: ${value.outcome}`,
          `CONFIRMATION_ID: ${value.confirmation_id}`,
          `LIFECYCLE_STATUS: ${value.lifecycle_status}`,
          `DECISION_REVISION: ${value.decision_revision}`,
          `SELECTED_SOLUTION: ${value.selected_solution_id ?? 'NONE'}`,
          `EXECUTION_SCOPE: ${value.execution_scope ?? 'NONE'}`,
          `DO_NOT_CHANGE: ${value.do_not_change.length > 0 ? value.do_not_change.join(' | ') : 'NONE'}`,
          `APPROVAL_REQUIRED: ${value.approval_required === true ? 'YES' : 'NO'}`,
          `APPROVAL_QUESTION: ${value.approval_question ?? 'NONE'}`,
          `EXECUTABLE: ${value.executable === true ? 'YES' : 'NO'}`,
          `REASON_CODES: ${value.reason_codes.join(', ') || 'NONE'}`,
          `MISSING_INFORMATION: ${value.missing_information.join(' | ') || 'NONE'}`,
          `REJECTED_CANDIDATES: ${value.rejected_candidates.length > 0 ? value.rejected_candidates.map((entry) => `${entry.id}(${entry.reason_code})`).join(' | ') : 'NONE'}`,
          `NOTES: ${value.notes.join(' ') || 'NONE'}`,
        ].join('\n'),
      }],
    },
    /**
     * The V2 half of the code-level guard, and the only writer of V2 ledger
     * state. The order matters: the session allow-list, then the version gate,
     * then the ledger guard, and only then is a decision computed — a decision
     * must never be reachable for an item this session never published.
     */
    execute(args, exec) {
      try {
        const sessionId = requireSessionId(exec?.agent?.id)
        const itemId = typeof args?.confirmation_id === 'string' ? args.confirmation_id.trim() : ''
        if (sessions.length > 0 && !sessions.includes(sessionId)) {
          return Promise.resolve(notApplicableV2({
            confirmationId: itemId,
            code: REJECTION.SESSION_NOT_ENABLED,
            reason: 'V2 decisions are enabled only for the sessions listed in decisionV2Sessions',
          }))
        }
        const declared = typeof args?.schema_version === 'string' ? args.schema_version.trim() : ''
        if (declared !== '' && declared !== SCHEMA_VERSION) {
          return Promise.resolve(notApplicableV2({
            confirmationId: itemId,
            code: 'UNSUPPORTED_SCHEMA_VERSION',
            reason: `confirmation_resolution_v2 speaks schema_version ${SCHEMA_VERSION}; received ${declared}`,
          }))
        }
        const ledger = ledgers.for(sessionId)
        const operation = typeof args?.operation === 'string' && args.operation.trim() !== ''
          ? args.operation.trim()
          : 'decide'

        if (operation === 'register') return Promise.resolve(registerItemV2(ledger, itemId, args))
        if (operation === 'complete') return Promise.resolve(completeItemV2(ledger, itemId, args))
        if (operation === 'approve') {
          return Promise.resolve(notApplicableV2({
            confirmationId: itemId,
            code: REJECTION.NO_VERIFIABLE_APPROVAL,
            reason: 'approve requires a host-verifiable user confirmation event, which this host does not expose to a tool body; only the approval suggestion is returned',
          }))
        }
        if (operation !== 'decide') {
          return Promise.resolve(notApplicableV2({
            confirmationId: itemId,
            code: 'UNKNOWN_OPERATION',
            reason: `unknown operation "${operation}" (expected register, decide, complete, or approve)`,
          }))
        }

        // `user_reply` is conditionally required; the schema cannot express that,
        // so it is enforced here per operation, before the ledger is touched.
        if (String(args?.user_reply ?? '').trim() === '') {
          return Promise.resolve(missingUserReplyV2(args))
        }

        const verdict = ledger.guard(itemId, { version: ITEM_VERSION.V2 })
        if (!verdict.ok) {
          return Promise.resolve(notApplicableV2({
            confirmationId: itemId,
            code: verdict.code,
            reason: verdict.reason,
            decisionRevision: ledger.decisionOf(itemId)?.revision ?? 0,
          }))
        }

        // Every attempt bumps the revision and clears the previous authorisation
        // BEFORE the decision is computed, so an INSUFFICIENT_CONTEXT result
        // cannot leave a stale MODIFY authorisation alive (方案 §6.2 rule 1).
        const { revision } = ledger.beginDecisionV2(itemId)
        const value = decideV2({ ...args, decision_revision: revision })
        ledger.markDecidedV2(itemId, value.outcome)
        const item = ledger.get(itemId)
        return Promise.resolve({
          ...value,
          lifecycle_status: item.state,
          approval_required: item.approval?.required === true,
          decision_revision: revision,
        })
      } catch (error) {
        return Promise.resolve(insufficientV2FromError(error, args))
      }
    },
  }
}

/**
 * Record a published V2 confirmation item. The accepted cases mirror V1 exactly
 * — unknown id registers, an id still in use is refused, a resolved id needs new
 * text to open a new round — with V2's own acknowledgement shape.
 */
function registerItemV2(ledger, itemId, args) {
  if (itemId === '') {
    return notApplicableV2({
      confirmationId: '',
      code: REJECTION.EMPTY_ID,
      reason: 'confirmation_id is empty',
    })
  }
  const text = typeof args?.original_confirmation === 'string' ? args.original_confirmation.trim() : ''
  const existing = ledger.get(itemId)

  if (existing !== undefined && existing.state !== ITEM_STATE.RESOLVED) {
    return notApplicableV2({
      confirmationId: itemId,
      code: REJECTION.ITEM_STILL_OPEN,
      reason: `${itemId} is still ${existing.state}; finish the current confirmation item before reusing this id`,
      decisionRevision: existing.decisionRevision ?? 0,
    })
  }
  if (existing !== undefined
    && existing.state === ITEM_STATE.RESOLVED
    && text !== ''
    && existing.originalConfirmation === text) {
    return notApplicableV2({
      confirmationId: itemId,
      code: REJECTION.ALREADY_RESOLVED,
      reason: `${itemId} is already RESOLVED with the same text; only new confirmation text may open a new round`,
      decisionRevision: existing.decisionRevision ?? 0,
    })
  }

  const state = ledger.register(itemId, {
    originalConfirmation: args?.original_confirmation,
    currentState: args?.current_state,
    userGoal: args?.user_goal ?? args?.context?.user_goal,
    version: ITEM_VERSION.V2,
  })
  const info = ledger.decisionOf(itemId)
  const round = info?.round ?? 1
  return ledgerValueV2({
    confirmationId: itemId,
    lifecycle: state,
    reasonCode: 'REGISTERED',
    reason: existing === undefined
      ? `registered ${itemId} in the V2 session ledger`
      : `opened a new V2 confirmation round for ${itemId}`,
    notes: [
      `${itemId} is now ${state}${round > 1 ? ` (round ${round})` : ''}. No decision was made.`,
      'When the user replies, call again with schema_version 2.0 and operation="decide".',
    ],
    decisionRevision: info?.revision ?? 0,
  })
}

/**
 * Close a V2 item after DSH actually executed its decision.
 *
 * Only AWAITING_EXECUTION items with the CURRENT decision_revision may be
 * completed. A missing revision is refused rather than treated as "any
 * revision", because that leniency is exactly what lets a stale authorisation
 * close a newer decision.
 */
function completeItemV2(ledger, itemId, args) {
  const existing = ledger.get(itemId)
  if (existing !== undefined && existing.state === ITEM_STATE.RESOLVED) {
    return ledgerValueV2({
      confirmationId: itemId,
      lifecycle: ITEM_STATE.RESOLVED,
      reasonCode: 'ALREADY_RESOLVED',
      reason: `${itemId} was already RESOLVED`,
      notes: [`${itemId} is RESOLVED. Nothing further is required for this item.`],
      decisionRevision: existing.decisionRevision ?? 0,
    })
  }
  const revision = Number.isInteger(args?.decision_revision) ? args.decision_revision : undefined
  if (revision === undefined) {
    return notApplicableV2({
      confirmationId: itemId,
      code: 'MISSING_DECISION_REVISION',
      reason: 'complete for the V2 contract must carry the decision_revision returned by the deciding call',
      decisionRevision: existing?.decisionRevision ?? 0,
    })
  }
  const verdict = ledger.guardComplete(itemId, { version: ITEM_VERSION.V2, revision })
  if (!verdict.ok) {
    return notApplicableV2({
      confirmationId: itemId,
      code: verdict.code,
      reason: verdict.reason,
      decisionRevision: existing?.decisionRevision ?? 0,
    })
  }
  const state = ledger.resolve(itemId)
  return ledgerValueV2({
    confirmationId: itemId,
    lifecycle: state,
    reasonCode: 'COMPLETED',
    reason: `completed ${itemId} after successful execution`,
    notes: [`${itemId} is now ${state}. Only report it as done when the change really succeeded.`],
    decisionRevision: revision,
  })
}

/** `operation: "decide"` with no reply to decide on. */
function missingUserReplyV2(args) {
  const value = decideV2(args)
  return {
    ...value,
    missing_information: ['user_reply: REQUIRED_FOR_DECIDE — operation="decide" needs the user\u2019s actual reply'],
    notes: [
      ...value.notes,
      'Pass the user reply in user_reply. register / complete / approve do not need it. The item stays PENDING.',
    ],
  }
}

/** Turn a ledger failure into a safe, non-executable V2 result. */
function insufficientV2FromError(error, args) {
  return {
    schema_version: SCHEMA_VERSION,
    confirmation_id: typeof args?.confirmation_id === 'string' ? args.confirmation_id : '',
    outcome: OUTCOME.INSUFFICIENT_CONTEXT,
    lifecycle_status: LIFECYCLE.PENDING,
    selected_solution_id: null,
    selected_solution: null,
    approval_required: false,
    approval_question: null,
    execution_scope: null,
    do_not_change: [],
    executable: false,
    reason_codes: ['LEDGER_UNAVAILABLE'],
    missing_information: ['session ledger unavailable'],
    rejected_candidates: [],
    decision_revision: 0,
    decision_trace: null,
    notes: [`Ledger guard failed: ${error instanceof Error ? error.message : String(error)}. Nothing may be executed for this item.`],
  }
}

/**
 * Record a published confirmation item.
 *
 * The accepted cases are deliberately narrow:
 *
 *   id unknown                              → register it (round 1)
 *   id still open (PENDING/AWAITING_EXECUTION) → REFUSE: the live item and its
 *                                               outstanding decision must not be
 *                                               overwritten
 *   id RESOLVED with identical text          → REFUSE: not a new round, and a
 *                                               duplicate must not resurrect it
 *   id RESOLVED with new text                → a new round (round + 1)
 *
 * A user finishing a second task in one long session naturally numbers again from
 * C1, so the last case must work; the first three must not.
 */
function registerItem(ledger, itemId, args) {
  if (typeof itemId !== 'string' || itemId.trim() === '') {
    return notApplicableValue({
      confirmationId: '',
      currentState: args.current_state ?? '',
      originalConfirmation: args.original_confirmation ?? '',
      userReply: args.user_reply ?? '',
      code: REJECTION.EMPTY_ID,
      reason: 'confirmation_id is empty',
    })
  }

  const normalizedId = itemId.trim()
  const text = typeof args.original_confirmation === 'string' ? args.original_confirmation.trim() : ''
  const existing = ledger.get(normalizedId)

  // Case 2: the number is still in use, so registering again would discard a live
  // item (and, for AWAITING_EXECUTION, an execution that is still pending).
  if (existing !== undefined && existing.state !== ITEM_STATE.RESOLVED) {
    return notApplicableValue({
      confirmationId: normalizedId,
      currentState: args.current_state ?? '',
      originalConfirmation: args.original_confirmation ?? '',
      userReply: args.user_reply ?? '',
      code: REJECTION.ITEM_STILL_OPEN,
      reason: `${normalizedId} is still ${existing.state}; finish the current confirmation item before reusing this id`,
    })
  }

  // Case 3: closed, and the text is identical — a duplicate registration rather
  // than a new round, so the item stays closed.
  if (existing !== undefined
    && existing.state === ITEM_STATE.RESOLVED
    && text !== ''
    && existing.originalConfirmation === text) {
    return notApplicableValue({
      confirmationId: normalizedId,
      currentState: args.current_state ?? '',
      originalConfirmation: args.original_confirmation ?? '',
      userReply: args.user_reply ?? '',
      code: REJECTION.ALREADY_RESOLVED,
      reason: `${normalizedId} is already RESOLVED with the same text; only new confirmation text may open a new round`,
    })
  }

  // Case 4 (and case 1): unknown id, or closed id with new text.
  const state = ledger.register(normalizedId, {
    originalConfirmation: args.original_confirmation,
    currentState: args.current_state,
    userGoal: args.user_goal,
    version: ITEM_VERSION.V1,
  })
  const round = ledger.decisionOf(normalizedId)?.round ?? 1
  return ledgerValue({
    itemId: normalizedId,
    state,
    ledger,
    args,
    reason: existing === undefined
      ? `registered ${normalizedId} in the session ledger`
      : `opened a new confirmation round for ${normalizedId}`,
    notes: `Confirmed: ${normalizedId} is now ${state}${round > 1 ? ` (round ${round})` : ''}. No decision was made. When the user replies to it, call again with action="decide".`,
  })
}

/**
 * Close an item after DSH actually executed its decision.
 *
 * The guard is the point of this action: only an item with an outstanding MODIFY
 * decision (AWAITING_EXECUTION) may be completed. `register → complete` is
 * therefore refused, so the decision step cannot be skipped. Completing an
 * already-RESOLVED item stays idempotent — a repeated success report must not
 * become an error.
 */
function completeItem(ledger, itemId, args) {
  const existing = ledger.get(itemId)
  if (existing !== undefined && existing.state === ITEM_STATE.RESOLVED) {
    return ledgerValue({
      itemId,
      state: ITEM_STATE.RESOLVED,
      ledger,
      args,
      reason: `${itemId} was already RESOLVED`,
      notes: `${itemId} is RESOLVED. Nothing further is required for this item.`,
    })
  }
  const verdict = ledger.guardComplete(itemId, { version: ITEM_VERSION.V1 })
  if (!verdict.ok) {
    return notApplicableValue({
      confirmationId: itemId,
      currentState: args.current_state ?? '',
      originalConfirmation: args.original_confirmation ?? '',
      userReply: args.user_reply ?? '',
      code: verdict.code,
      reason: verdict.reason,
    })
  }
  const state = ledger.resolve(itemId)
  return ledgerValue({
    itemId,
    state,
    ledger,
    args,
    reason: `completed ${itemId} after successful execution`,
    notes: `Confirmed: ${itemId} is now ${state}. Only report it as done when the change really succeeded.`,
  })
}

/** The `register` / `complete` acknowledgement, shaped like every other result. */
function ledgerValue({ itemId, state, ledger, args, reason, notes }) {
  return {
    confirmation_id: itemId,
    action: ACTION.KEEP_CURRENT,
    quality_impact: 'NONE',
    user_impact_if_unchanged: 'NONE',
    user_goal: NOT_IDENTIFIED_GOAL,
    selected_solution: 'NONE',
    execution_scope: 'NONE',
    do_not_change: args.current_state ?? 'current state',
    side_effect_risk: 'NONE',
    status: STATUS.REGISTERED,
    missing_information: 'NONE',
    current_state: args.current_state ?? '',
    original_confirmation: args.original_confirmation ?? '',
    user_reply: args.user_reply ?? '',
    confirmation_state: state,
    execution_required: false,
    quality_evidence: 'not evaluated (ledger update only)',
    user_impact_evidence: 'not evaluated (ledger update only)',
    selection_reason: reason,
    notes: `${notes} Ledger for this session now holds: ${ledger.snapshot().map((item) => `${item.id}=${item.state}`).join(', ')}.`,
  }
}

/** Read the calling session id, or explain why the guard cannot run. */
function requireSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('confirmation_resolution requires a calling agent session (exec.agent.id was unavailable)')
  }
  return sessionId
}

/** `action: 'decide'` with no reply to decide on — a missing input, not a ledger failure. */
function missingUserReplyValue(itemId, args) {
  return {
    confirmation_id: itemId,
    action: ACTION.KEEP_CURRENT,
    quality_impact: 'NONE',
    user_impact_if_unchanged: 'NONE',
    user_goal: NOT_IDENTIFIED_GOAL,
    selected_solution: 'NONE',
    execution_scope: 'NONE',
    do_not_change: args.current_state ?? 'current state',
    side_effect_risk: 'NONE',
    status: STATUS.INSUFFICIENT,
    missing_information: 'user_reply: REQUIRED_FOR_DECIDE',
    current_state: args.current_state ?? '',
    original_confirmation: args.original_confirmation ?? '',
    user_reply: '',
    confirmation_state: 'PENDING',
    execution_required: false,
    quality_evidence: 'not evaluated',
    user_impact_evidence: 'not evaluated',
    selection_reason: 'action="decide" needs the user\u2019s reply; nothing was decided',
    notes: 'Pass the user\u2019s actual reply in user_reply. register and complete do not need it; only decide does. The item stays PENDING.', 
  }
}

/** Turn a guard failure into a safe, non-executable decision. */
function insufficientFromError(error, args) {
  return {    confirmation_id: typeof args?.confirmation_id === 'string' ? args.confirmation_id : '',
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
