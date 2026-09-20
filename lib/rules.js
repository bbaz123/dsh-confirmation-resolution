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

1. 识别 user_goal（用户真实目标）——**ACTION = MODIFY 时必填**；缺失时插件返回 INSUFFICIENT_CONTEXT（USER_GOAL_REQUIRED_FOR_MODIFY），因为要在候选方案里做选择就必须先知道目标。KEEP_CURRENT 不需要 user_goal，因为它不选方案；
2. 判断 quality_impact（或给出 quality_dimensions 证据）；
3. 在 quality_impact !== NONE 时判断 user_impact_if_unchanged（或给出 user_impact_dimensions / preference_only）；
4. 对可能落到 ACTION = MODIFY 的确认项，生成 2–3 个 candidate_solutions 供插件淘汰与排序；未提供时插件返回 INSUFFICIENT_CONTEXT，不会自行创造方案。

## 三个动作与状态机

每一步的状态变更都必须经过插件，DSH 不得在插件之外自行标记确认项状态：

    DSH 输出 C1
        ↓ 1. register(C1)                     → STATUS = REGISTERED，状态 PENDING
    C1 = PENDING
        ↓ 用户回复 C1
        ↓ 2. decide(C1)                       → STATUS = READY_TO_EXECUTE
        ├── ACTION = KEEP_CURRENT  → 无修改可执行，decide 直接返回 C1 = RESOLVED
        └── ACTION = MODIFY        → 状态 = AWAITING_EXECUTION（等待执行）
                                        ↓ DSH 实际执行修改
                                        ├── 执行成功
                                        │     ↓ 3. complete(C1)  → C1 = RESOLVED
                                        └── 执行失败
                                              不调用 complete → 保持 AWAITING_EXECUTION，可重新 decide

- **MODIFY 决策不等于执行**：decide 返回后状态是 **AWAITING_EXECUTION**，既不是 PENDING 也不是 RESOLVED。只有 DSH 真正执行成功并调用 complete，该项才变成 RESOLVED。
- **complete 必须证明之前有 MODIFY 裁决**：插件只在状态为 AWAITING_EXECUTION 时接受 complete。register 之后直接 complete 会被拒绝（ITEM_NOT_AWAITING_EXECUTION），因此无法跳过 decide。
- **执行失败时不要调用 complete**：保持 AWAITING_EXECUTION，修正后重新 decide，或重试执行。绝不能因为"已经决策过"就把该项当作已解决。
- **KEEP_CURRENT 立即 RESOLVED**：不修改这件事在决策那一刻就已经完成，不需要额外的 complete。
- **没有任何隐式登记**：必须先用 register 登记编号，之后 decide 才可能通过守卫。

## 确认项的三种状态与两个编号复用规则

- PENDING：已发布、等用户回复或等决策。
- AWAITING_EXECUTION：已有 MODIFY 裁决，等 DSH 执行并回报 complete。
- RESOLVED：已执行完成（或 KEEP_CURRENT 已完成）。

编号复用：同一个会话里完成一个任务后开始第二个任务时，**可以重新从 C1 开始编号**，用户仍然只看到 C1。
规则是——用**新的确认内容** register 时，该编号开启新一轮并回到 PENDING；用**完全相同的内容**重复
register 已 RESOLVED 的编号则会被拒绝（不会复活已结束的项）。新一轮必须重新走 decide，上一轮的裁决
不会授权新一轮的 complete。

## 代码级守卫与 NOT_APPLICABLE

插件的触发保护是两层的：本节规则（软保护）+ 插件内的会话账本（硬保护）。以下情况插件会直接拒绝并返回 STATUS = NOT_APPLICABLE：

- 该 confirmation_id 在当前会话从未被 register 过；
- 该确认项已经 RESOLVED，且没有被用新的文本重新发布。

收到 NOT_APPLICABLE 时：不得重试该调用，不得执行任何修改，改按普通 DSH 规则处理用户消息。守卫是"拒绝非法调用"，不是"阻止合法调用"。

## 四种 STATUS 的语义

| STATUS | 含义 | 应当怎么做 |
| --- | --- | --- |
| REGISTERED | 账本写入成功（register 登记，或 complete 关闭） | 按 notes 继续；这不是拒绝 |
| READY_TO_EXECUTE | 决策完成，等 DSH 执行 | 执行 SELECTED_SOLUTION；成功后调用 action="complete" |
| INSUFFICIENT_CONTEXT | 信息不足，未做决策 | 补齐 MISSING_INFORMATION 后重新 decide；该项保持 PENDING |
| NOT_APPLICABLE | 守卫拒绝，属非法调用 | 不重试、不执行，改走正常 DSH 流程 |

REGISTERED 与 NOT_APPLICABLE 都是"账本相关"的结果，但语义相反：前者是成功写入，后者是拒绝。不得把二者混用。

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

- 每个确认项的运行状态只能是 PENDING、AWAITING_EXECUTION 或 RESOLVED；插件内的会话账本记录当前会话已发布的编号、轮次与状态。
- 初始：C1 = PENDING，C2 = PENDING，C3 = PENDING。
- 用户回复"C1 改，C2 保持"并处理完成后：C1 = RESOLVED（C1 是 MODIFY，需先执行成功再 complete），C2 = RESOLVED（KEEP_CURRENT 在决策时即完成），C3 = PENDING。
- **正在处理中的编号不得重新 register**：PENDING 与 AWAITING_EXECUTION 都属于"仍在使用"，此时 register 会被拒绝（CONFIRMATION_ID_STILL_OPEN）。要复用编号，必须先让它走到 RESOLVED，并且用**新的确认内容**开启新一轮。
- **状态变更只能通过插件**：不得在插件之外自行把某个确认项当作 RESOLVED；"用户说了保持"不等于账本已关闭，仍要经过 decide（KEEP_CURRENT 会立即 RESOLVED）。这样账本与 DSH 的认知始终一致。
- 不得擅自替用户处理用户没有回复的确认项；未被回复的确认项保持 PENDING。
- 确认项不得因为下一轮对话而重新编号。
- 账本按会话隔离，DSH 重启后为空；重启后如需继续处理，重新 register 登记编号即可。

## 混合消息的处理

用户在同一条消息里同时回复确认项并提出新需求时，必须拆分处理，不得把整条消息交给插件：

用户：C1 修改，C2 保持。另外把首页标题改成"控制中心"。

处理：
- C1 → 调用 confirmation_resolution（decide），执行成功后 complete；
- C2 → 调用 confirmation_resolution（decide）：插件返回 KEEP_CURRENT 并立即 RESOLVED；
- "修改首页标题" → 使用正常 DSH 规则，不进入插件决策流程。

## 插件结果的执行

插件只负责判断、决策并返回执行方案；页面、代码、文件、设计稿和项目结构的实际修改一律由 DSH 执行。插件返回 STATUS = READY_TO_EXECUTE 后，必须直接执行，不得再次询问"是否确认？""是否继续？""要不要执行这个方案？"。

- ACTION = MODIFY：按 SELECTED_SOLUTION 执行，只修改 EXECUTION_SCOPE 指定的范围，不得修改 DO_NOT_CHANGE 指定的范围。执行成功后调用 action="complete" 关闭该项；执行失败则不调用 complete，该项保持 AWAITING_EXECUTION，可修正后重新 decide 或重新执行。
- **重新 decide 会先废除上一份尚未执行的授权**：每次 decide 都在重新计算之前撤销旧的 MODIFY 授权。因此如果这一次的结果是 INSUFFICIENT_CONTEXT，该项会回到 PENDING，此前的授权不再能让 complete 关闭它。不存在"最新判断是信息不足、旧 MODIFY 却仍可完成"的状态。
- ACTION = KEEP_CURRENT：保持当前状态，不执行修改；插件已在决策时把该项标为 RESOLVED，无需再 complete。
- STATUS = INSUFFICIENT_CONTEXT：不执行任何修改，按 MISSING_INFORMATION 补齐信息后重新 decide；该项保持 PENDING，不得把用户原始方案当作默认方案执行。

执行完成后检查结果；如果结果明显偏离插件方案，先修正执行结果，而不是重新询问用户。不得自行扩大插件规定的修改范围。

## 退出条件

用户本轮已经回复的确认项全部执行或保持完毕之后，立即退出待确认事项处理流程，恢复正常 DSH 行为。该流程不得继续影响之后无关的用户请求。

作用域说明：这些规则只覆盖"待确认事项处理阶段"；在该阶段内，它们优先于任何"用户要求修改就照做"的一般倾向（用户提出的具体做法只是候选方案，不是自动最优方案）。它们不修改正常 DSH 工作逻辑：普通任务没有待确认事项时，用户要求的修改照常执行。`
