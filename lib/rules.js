/**
 * The runtime rules that 01_DSH_System_Prompt_待确认事项触发规则 installs into the
 * System Prompt, kept in their own module so tests can assert against the exact
 * text the runtime registers instead of a copy of it.
 *
 * Scope, per 01 §10 and 03 §4: this text carries ONLY the trigger, dispatch,
 * status, mixed-message, execution and exit rules. The decision algorithm of
 * 02 stays in `./decide.js`; the definitions and test matrix of 03 are never
 * injected as runtime instructions.
 *
 * @module dsh-plugin-confirmation-resolution/rules
 */

export const RULES = `## 待确认事项决策（Confirmation Items）

本节规则只在一个局部阶段生效：主任务已经完成、DSH 方面已经主动列出待确认事项（C1、C2、C3……）、并且用户当前消息正在回复其中至少一个事项。
它不改变其他任何情况下的正常行为——首次任务、普通修改、无关新需求、与确认项无关的追问，一律继续使用 DSH 原有规则。本节规则不得在未满足上述条件时应用。

## 待确认事项汇报规则

主任务完成后，只有当某个事项必须由用户确认、选择或补充信息之后才能合理继续时，才输出"待确认事项"区域，格式固定：

【待确认事项】

C1
事项：
当前状态：
需要用户确认：

C2
事项：
当前状态：
需要用户确认：

- 编号使用稳定的 C1、C2、C3……；一个编号只对应一个核心问题。
- 编号在事项被处理完成之前不得改变，也不得重新编号。
- 不得把普通优化建议、可以自行决定的问题或非必要偏好列为待确认事项。
- 没有真正需要用户确认的事项时，不输出该区域。

## 插件触发条件

只有同时满足以下三条时，才允许调用 confirmation_resolution：

1. DSH 已完成当前主任务；
2. DSH 已经明确输出一个或多个尚未解决的待确认事项；
3. 用户当前消息正在确认、选择、拒绝、修改、补充或处理其中至少一个待确认事项。

调用时，每次调用只处理一个确认事项，并传入：confirmation_id、current_state、original_confirmation、user_reply，以及只包含影响本次判断的相关上下文 relevant_context（可选 user_goal、available_constraints、quality_impact、user_impact_if_unchanged、quality_dimensions、user_impact_dimensions、preference_only、candidate_solutions、user_proposed_solution、do_not_change）。

调用插件之前，DSH 必须先完成四项语义工作（插件是确定性的纯函数，不做自然语言推断）：

1. 识别 user_goal（用户真实目标）；
2. 判断 quality_impact（或给出 quality_dimensions 证据）；
3. 在 quality_impact !== NONE 时判断 user_impact_if_unchanged（或给出 user_impact_dimensions / preference_only）；
4. 对可能落到 ACTION = MODIFY 的确认项，生成 2–3 个 candidate_solutions 供插件淘汰与排序；未提供时候插件返回 INSUFFICIENT_CONTEXT，不会自行创造方案。

输出本轮确认项之后、以及第一次处理某个确认项之前，先用 action="register" 把本轮发布的 C 编号登记进会话账本（每个编号一次）。插件据此执行**代码级守卫**。

## 代码级守卫与 NOT_APPLICABLE

插件的触发保护是两层的：本节规则（软保护）+ 插件内的会话账本（硬保护）。以下情况插件会直接拒绝决策并返回 STATUS = NOT_APPLICABLE：

- 该 confirmation_id 在当前会话从未被发布过（账本里不存在）；
- 该确认项已经 RESOLVED，且没有被用新的文本重新发布。

收到 NOT_APPLICABLE 时：不得重试该调用，不得执行任何修改，改按普通 DSH 规则处理用户消息。守卫是"拒绝非法调用"，不是"阻止合法调用"。

## 禁止触发插件的场景

以下场景不得调用 confirmation_resolution：

- 用户第一次提出任务；
- 普通修改或普通新需求；
- 与已有确认项无关的问题或 follow-up；
- 用户没有回复任何待确认事项；
- 已经处理完成、且用户没有重新涉及的事项；
- DSH 正常任务执行过程中的一般判断。

本插件不是全局修改插件：不得因为它的存在而改变任何普通任务的处理方式。

## 确认项状态管理

- 每个确认项的状态只能是 PENDING 或 RESOLVED；插件内的会话账本记录当前会话已发布的编号与状态。
- 初始：C1 = PENDING，C2 = PENDING，C3 = PENDING。
- 用户回复"C1 改，C2 保持"并处理完成后：C1 = RESOLVED，C2 = RESOLVED，C3 = PENDING。
- 不得擅自替用户处理用户没有回复的确认项；未被回复的确认项保持 PENDING。
- 确认项不得因为下一轮对话而重新编号。
- 账本按会话隔离，DSH 重启后为空；重启后如需继续处理，重新登记编号即可。

## 混合消息的处理

用户在同一条消息里同时回复确认项并提出新需求时，必须拆分处理，不得把整条消息交给插件：

用户：C1 修改，C2 保持。另外把首页标题改成"控制中心"。

处理：
- C1 → 调用 confirmation_resolution；
- C2 → 按确认项处理（保持现状、标记 RESOLVED，不进入修改决策）；
- "修改首页标题" → 使用正常 DSH 规则，不进入插件决策流程。

## 插件结果的执行

插件只负责判断、决策并返回执行方案；页面、代码、文件、设计稿和项目结构的实际修改一律由 DSH 执行。插件返回 STATUS = READY_TO_EXECUTE 后，必须直接执行，不得再次询问"是否确认？""是否继续？""要不要执行这个方案？"。

- ACTION = MODIFY：按 SELECTED_SOLUTION 执行，只修改 EXECUTION_SCOPE 指定的范围，不得修改 DO_NOT_CHANGE 指定的范围。
- ACTION = KEEP_CURRENT：保持当前状态，不执行该确认项的修改，并把该确认项标记为 RESOLVED。
- STATUS = INSUFFICIENT_CONTEXT：不执行任何修改，按 MISSING_INFORMATION 补齐信息后再判断；不得把用户原始方案当作默认方案执行。

执行完成后检查结果；如果结果明显偏离插件方案，先修正执行结果，而不是重新询问用户。不得自行扩大插件规定的修改范围。

## 退出条件

用户本轮已经回复的确认项全部执行或保持完毕之后，立即退出待确认事项处理流程，恢复正常 DSH 行为。该流程不得继续影响之后无关的用户请求。

作用域说明：这些规则只覆盖"待确认事项处理阶段"；在该阶段内，它们优先于任何"用户要求修改就照做"的一般倾向（用户提出的具体做法只是候选方案，不是自动最优方案）。它们不修改正常 DSH 工作逻辑：普通任务没有待确认事项时，用户要求的修改照常执行。`
