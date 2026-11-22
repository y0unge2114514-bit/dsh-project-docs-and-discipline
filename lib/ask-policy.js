/**
 * Make the agent ask better questions, not fewer.
 *
 * WHY THIS EXISTS
 * ---------------
 * Deep PTC's second rule is "ask instead of guessing intent" — meaning belongs
 * to the user, facts belong to tools. That rule is right, and this plugin should
 * not punish asking. What it should punish is asking *badly*, because that is
 * what the user actually experiences as friction:
 *
 *   - a question with no options, so answering it means typing an essay
 *   - six questions at once, so answering them is a form to fill in
 *   - a question whose answer is sitting in PROJECT.md
 *   - the recommended answer buried last, so the user has to read all of it
 *
 * That last point is not cosmetic. A question with options is answerable with
 * one click; without options it is a paragraph of work. The difference decides
 * whether the agent gets an answer in five seconds or five minutes.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It cannot change how long `ask_user_question` blocks. That wait is owned by
 * the host tool, not by a plugin guard. Deep PTC can time it out because it
 * wraps the tool at the preset layer; a host plugin cannot. Claiming otherwise
 * would be a lie, so the refusal text below never promises a timeout.
 *
 * @module @local/dsh-project-docs/ask-policy
 */

/** More questions than this at once turns a conversation into a form. */
export const MAX_QUESTIONS = 3

/**
 * Check one question's shape.
 *
 * @param {object} question
 * @returns {string|null} a problem description, or null when it is fine
 */
function problemOf(question) {
  if (question === null || typeof question !== 'object') return '问题格式无效'
  const options = Array.isArray(question.options) ? question.options : []
  if (options.length === 0) {
    return '没有给出选项——带选项的问题用户点一下就能答，没有选项就得打字解释'
  }
  if (options.length === 1) {
    return '只有一个选项，这不是提问而是通知；要么给两个以上选项，要么直接做'
  }
  const blank = options.find((option) => option === null || typeof option !== 'object' || typeof option.label !== 'string' || option.label.trim() === '')
  if (blank !== undefined) return '有选项缺少 label'
  return null
}

/**
 * Decide whether a batch of questions should be sent back for a rewrite.
 *
 * @param {object} args  the tool arguments as the model supplied them
 * @returns {{ message: string }|null}  null means "let it through"
 */
export function askVerdict(args) {
  const source = args !== null && typeof args === 'object' ? args : {}
  const questions = Array.isArray(source.questions) ? source.questions : []
  if (questions.length === 0) return null

  if (questions.length > MAX_QUESTIONS) {
    return {
      message:
        `提问纪律：一次问了 ${questions.length} 个问题，超过 ${MAX_QUESTIONS} 个。\n` +
        '一次问太多，用户要读完再逐条回答，成本比你自己查更高。\n' +
        `请挑出真正卡住你的 1–${MAX_QUESTIONS} 个，其余的自己查：文件、配置、日志、` +
        '`project_docs` 里的项目文档都能回答「可检查的事实」。\n' +
        '只把**需要用户决定**的事留给用户（要哪个方案、要不要删、优先级）。',
    }
  }

  const problems = []
  for (let i = 0; i < questions.length; i += 1) {
    const problem = problemOf(questions[i])
    if (problem !== null) problems.push(`第 ${i + 1} 个问题：${problem}`)
  }
  if (problems.length === 0) return null

  return {
    message:
      '提问纪律：这次提问会被打回一次，原因：\n' +
      problems.map((item) => `- ${item}`).join('\n') +
      '\n\n请改成**带选项**的形式，1–3 个问题，每个 2–4 个选项，' +
      '把推荐的那一项放在**第一个**并在 label 里注明「（推荐）」。\n' +
      '用户在选项里点一下就能回答，比打字快一个数量级。\n' +
      '如果这个问题其实能自己查（文件位置、当前配置、版本、端口），就别问，自己查。',
  }
}
