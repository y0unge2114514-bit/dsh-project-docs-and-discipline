/**
 * Cross-session message selection — the pure decision layer.
 *
 * WHY THIS IS NOT INLINE IN index.js
 * ----------------------------------
 * The filtering rules here were wrong twice in a row, and both times the only
 * way to notice was staring at a live system prompt:
 *
 *   1. A fresh restart injected 81 unrelated messages, because the filter let
 *      `to === ''` (broadcast) pass from every project.
 *   2. A 30-minute cache meant a message sent one second after session start
 *      stayed invisible for half an hour.
 *
 * Bugs found by eyeballing a live screen are bugs that come back. The rules are
 * therefore stated once, here, as a function with no I/O — so they can be
 * asserted on directly.
 *
 * @module @local/dsh-project-docs/session-bus
 */

/** Message categories worth interrupting for; everything else only gets counted. */
export const LOUD_KINDS = ['warning', 'question']

/**
 * Decide which board entries a session should be shown, and where the cursor
 * should move to afterwards.
 *
 * @param {object} input
 * @param {Array<object>} input.entries   board entries, newest first
 * @param {string} input.label            this session's label, e.g. 主会话·x·abc123
 * @param {string} input.authorOfMe       the author string this session writes as
 * @param {string|undefined} input.projectId  project the session's cwd sits in
 * @param {string} input.lastSeen         id of the newest entry already shown
 * @returns {{ lines: string[], cursor: string, firstSight: boolean, backlog: number }}
 */
export function selectMessages({ entries, label, authorOfMe, projectId, lastSeen }) {
  const list = Array.isArray(entries) ? entries : []
  const lines = []
  const newestId = list.length > 0 ? String(list[0].id ?? '') : ''
  const firstSight = lastSeen === ''

  const relevant = list.filter((entry) => {
    const to = typeof entry.to === 'string' ? entry.to.trim() : ''
    // Addressed to some other session by name → not mine.
    if (to !== '' && to !== label && to !== 'lead' && to !== 'agent') return false
    // Outside my own project, only an explicit label match is unambiguously mine.
    if (projectId === undefined && to !== label) return false
    // My own message echoed back is pure noise.
    return entry.author !== authorOfMe
  })

  // First sight: do not dump weeks of history into the opening prompt. A block
  // that size is exactly what teaches an agent to skip the message section.
  if (firstSight) {
    return { lines: [], cursor: newestId, firstSight: true, backlog: relevant.length }
  }

  for (const entry of relevant) {
    const id = String(entry.id ?? '')
    if (id <= lastSeen) continue
    const to = typeof entry.to === 'string' ? entry.to.trim() : ''
    const kind = typeof entry.kind === 'string' ? entry.kind : 'note'
    const text = typeof entry.text === 'string' ? entry.text : ''
    const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text
    const urgent = LOUD_KINDS.includes(kind) ? `（${kind}）` : ''
    lines.push(`- ${entry.author || 'unknown'} → ${to || '(广播)'}${urgent}：${preview}`)
  }

  const cursor = newestId !== '' && newestId > lastSeen ? newestId : lastSeen
  return { lines, cursor, firstSight: false, backlog: 0 }
}

/**
 * Fold selected lines into one prompt block.
 *
 * The count is stated even when nothing is expanded, so a session can tell
 * "there is nothing" apart from "there is something I chose not to paste".
 */
export function renderMessageBlock(lines, backlog) {
  if (lines.length === 0 && backlog === 0) return ''
  if (lines.length === 0 && backlog > 0) {
    return `**跨会话消息** — 本会话首次接入，已有 ${backlog} 条历史消息标记为已读；需要时用 project_docs → list_messages 翻。`
  }
  const shown = lines.slice(0, 5)
  const rest = lines.length - shown.length
  return (
    `**跨会话消息（${lines.length} 条新）** — 其他会话给你留了消息：\n` +
    shown.join('\n') +
    (rest > 0 ? `\n（另有 ${rest} 条，用 project_docs → list_messages 查看）` : '')
  )
}
