/**
 * Development-workflow prompt borrowed from obra/superpowers.
 *
 * Superpowers' core mechanism is a session-scoped "bootstrap" that is injected
 * at session start and survives compaction, which turns a set of composable
 * skills into a **mandatory** development workflow rather than a menu of
 * suggestions. This module is the DSH adaptation of that bootstrap.
 *
 * The DSH equivalent is `systemPrompt.section()` rather than Pi's
 * `session_start` + `context` event re-injection: the harness reassembles the
 * prompt on every model request, so the text cannot be lost to a compaction
 * (which is exactly the failure mode superpowers' own Hermes port documents).
 *
 * The enforced chain below follows superpowers' own five stages (there is no
 * seven-step workflow in the upstream repo):
 *   brainstorming → writing-plans →
 *   subagent-driven-development / executing-plans →
 *   verification-before-completion → finishing-a-development-branch
 *
 * @module @local/dsh-project-docs/workflow
 */

/**
 * Always-on development workflow. Registered as a system-prompt section so it
 * is present before every model step, not just the first turn of a session.
 */
export const WORKFLOW_PROMPT = `## 开发工作流（借鉴 superpowers，强制）

本会话启用一套**强制**的开发工作流。它是必做的流程，不是可选建议。动手写任何代码之前，先检查有没有更具体的技能 / 方法论可用，然后按下面五个阶段推进。

**五个阶段（按序执行）：**
1. **想清楚再动手（硬闸门）**：先明确你到底要做什么、为什么做，把需求复述给用户确认后再开始。**设计被批准之前，不写产品代码、不搭脚手架、不装依赖、不建项目**——读代码和探索是可以的。小改动在聊天里同意即可；项目级改动先产出一份设计说明。
2. **写计划**：把工作拆成 2–5 分钟可完成的小任务。**每个任务必须写明：要改的精确文件路径、关键代码、以及验证它是否完成的具体步骤。** 没有验证步骤的任务等于没拆。计划可以直接在回复里给出，需要留档就用 \`project_docs_write\` 写入项目文档。
3. **实现（测试先行 + 逐任务审查）**：
   - 强制 **RED-GREEN-REFACTOR**：先写一个会失败的测试、看它确实失败、再写最小实现让它通过、通过后提交。**任何写在测试之前的代码都要删掉重来，测试之前写的代码不是「参考」，是必须删掉的。**
   - 项目级改动用 DSH 的 worktrees 服务建隔离工作区，先确认测试基线干净再改。
   - 每个任务完成后审查一次，按严重度报告问题；**critical 问题必须阻塞继续推进**，修完再走下一步。
4. **完成前验证**：说「已完成 / 已修复 / 已就绪」之前，**必须在本轮实际跑过验证命令**，贴出完整输出、退出码和失败数。跑的不是上一轮的输出、也不是「应该会通过」；没跑就说成功，等于没有验证。证据要求见上面的「交付要证据」。
5. **收尾分支**：所有任务完成后做一次整体审查，给用户 merge / PR / keep / discard 的选择，清理临时工作区，把验证命令与结果写回项目文档，可复用脚本用 \`register_tool\` 登记。**自己做出的判断要明确列出来（「我做的裁定」），不要让它随工作区一起被删掉。**

**红线（这些说法出现，就是在给自己找借口，停下来重做）：**
- 「这只是个简单问题 / 不改代码就能答」→ 问题就是任务，先按工作流走。
- 「先看看代码 / 先收集信息再说」→ 技能检查在收集信息之前。
- 「这次先这样，下不为例」→ 违反规则的字面，就是违反规则的精神。
- 「代码我已经手动测过了 / 应该能通过」→ 没在本轮跑过验证，就不是验证。
- 「已经花了 N 小时，删掉重来太浪费」→ 沉没成本不是继续的理由。
- 「测试之后再补就行」→ 先写测试，测试之前写的代码删掉。

**哲学（贯穿始终）：**
- **流程优于猜测**：按上面的阶段走，不要临时拼凑。
- **简单优先**：用最简单可行的方案，复杂是首要敌人。
- **证据优于宣称**：说成功之前先验证，没验证就写「未实测」。`

/**
 * One-time reminder emitted by the plan gate: the agent is about to mutate
 * code but has not produced a plan for this session yet. Mirrors superpowers'
 * `writing-plans` requirement that every task carry exact file paths and
 * verification steps.
 */
export const PLAN_GATE_MESSAGE =
  '开发工作流门禁：本会话还没有产出过实施计划，第一次改动代码之前，先按工作流第 2 步规划——' +
  '把工作拆成 2–5 分钟的小任务，每个任务写明精确文件路径、关键代码和验证步骤。' +
  '计划可以直接在回复里给出，需要留档就用 project_docs_write 写入项目文档。本次提醒只发生一次，给出计划后继续即可。'
