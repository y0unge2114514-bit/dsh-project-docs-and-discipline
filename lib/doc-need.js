/**
 * "Did you actually read the project docs?" — decided from the turn's text,
 * not from whether a file was written.
 *
 * WHY THIS EXISTS
 * ---------------
 * The existing gate (`requireDocsBeforeWrite`) only fires on `write`, `edit`,
 * `bash` and friends. That covers an agent that starts changing files, and it
 * covers nothing else. The failure the user actually reported is different and
 * worse to experience:
 *
 *   "反复询问我基础背景信息，反复出现基础知识错误。明显，根本就没看文档"
 *
 * An agent that never writes anything — it just asks the user what the network
 * environment is, or asserts a wrong port number — sails straight through a
 * write-only gate. Nothing was written, so nothing was checked. The user pays
 * for it in repeated questions they already answered in the docs.
 *
 * So this module looks at what the agent is ABOUT TO SAY and decides whether it
 * is the kind of statement that requires having read the docs first:
 *
 *   - asking the user for background that PROJECT.md / COLLAB.md already states
 *   - asserting a specific fact (port, path, host, version) without having read
 *
 * Both are cheap to detect and neither requires understanding the project.
 *
 * @module @local/dsh-project-docs/doc-need
 */

/**
 * Questions that the project docs almost always already answer.
 *
 * Kept deliberately narrow: only phrasings that are near-certainly answerable
 * from PROJECT.md / COLLAB.md. A broader net would punish legitimate questions
 * ("do you want me to delete the old backups?"), and a gate that misfires gets
 * switched off, which protects nobody.
 */
const BACKGROUND_QUESTIONS = [
  /(什么|哪个|哪几种|哪些).{0,12}(网络|环境|系统|版本|端口|路径|目录|服务器|机器|部署)/,
  /(网络|环境|系统|版本|端口|路径|目录|服务器|机器|部署).{0,12}(是什么|是哪个|是多少|怎么配|怎么设置)/,
  /(请问|能否告知|可以告诉我|你能告诉|需要你确认|需要确认一下).{0,20}(网络|环境|版本|端口|路径|部署|服务器)/,
  /(是不是|是否)(校园网|内网|公网|本地|远程|内网环境)/,
  /(校园网|内网|公网).{0,6}(吗|嘛|\?|？)/,
  /(你|您)(那边|这边|这里).{0,6}(环境|配置|情况|怎么样)/,
]

/**
 * Statements of a concrete technical fact. If a fresh agent asserts one of
 * these before reading, it is guessing — and a wrong guess is what the user
 * sees as "基础知识错误".
 */
/**
 * Statements of a concrete technical fact. If a fresh agent asserts one of
 * these before reading, it is guessing — and a wrong guess is what the user
 * sees as "基础知识错误".
 *
 * Covers both notations people actually use: `D:\path`, and the Chinese form
 * "D 盘 … 目录" — the latter was a real miss on the first pass, and it is the
 * more common way this gets written in conversation. The drive-letter branch
 * allows spaces inside the path ("D 盘 example-app 目录"), because the whole
 * point is catching a path being recited, not parsing it.
 */
const FACT_ASSERTION =
  /(\d{2,5})\s*(端口|port)|端口\s*(\d{2,5})|([A-Za-z]:\\[^\s，。；]+)|([A-Za-z]\s*盘[^\n，。；]{0,50}?(目录|文件|下|里))|(\d+\.\d+\.\d+\.\d+)|(127\.0\.0\.1:\d+)|(v?\d+\.\d+\.\d+)/

export { FACT_ASSERTION }

/** Reading these documents counts as " consulted". */
export const REQUIRED_DOCS = ['PROJECT.md', 'COLLAB.md']

/**
 * Does this assistant message look like it needs the project docs first?
 *
 * @param {string} text      assistant message about to be sent
 * @param {object} context
 * @param {boolean} context.readAny  has this agent read PROJECT.md or COLLAB.md
 * @param {boolean} context.isFirstTurn  is this still the opening turn
 * @returns {{ needsDocs: boolean, reason: string }}
 */
export function docNeed(text, { readAny, isFirstTurn }) {
  if (readAny === true) return { needsDocs: false, reason: '' }
  const body = typeof text === 'string' ? text : ''
  if (body.trim() === '') return { needsDocs: false, reason: '' }

  for (const pattern of BACKGROUND_QUESTIONS) {
    if (pattern.test(body)) {
      return {
        needsDocs: true,
        reason: 'asking for background that PROJECT.md / COLLAB.md already states',
      }
    }
  }

  // Asserting a concrete fact while never having read the docs. On the opening
  // turn this is the classic "recites the wrong port from memory" failure; later
  // turns are allowed more slack because the agent may have learned it from a
  // tool result in the meantime.
  if (FACT_ASSERTION.test(body) && isFirstTurn === true) {
    return {
      needsDocs: true,
      reason: 'stating project-specific facts before reading the project docs',
    }
  }

  return { needsDocs: false, reason: '' }
}

/**
 * The message shown when the gate fires.
 *
 * It names the project, says what to read, and — importantly — says the gate
 * opens after one read. A block with no stated exit is a block an agent tries
 * to argue with.
 */
export function docNeedMessage(projectId, reason) {
  const which = REQUIRED_DOCS.join(' 与 ')
  return (
    `项目文档门禁：你在 ${projectId} 里${reason === 'asking for background that PROJECT.md / COLLAB.md already states' ? '询问的背景信息' : '陈述的项目事实'}，` +
    `但本会话还没读过 ${which}。\n` +
    `这两个文件通常已经写好了：网络环境（校园网内网 / 公网）、限速与端口策略、目录结构、部署方式、红线和不要回退的修复。\n` +
    `先 \`project_docs\` → \`read_doc\`（kind: "project" 的 PROJECT.md，再 kind: "collab" 的 COLLAB.md），读一份即可继续。\n` +
    `如果文档里确实没写，读完再问用户——那时才知道哪些是真的文档没覆盖。`
  )
}
