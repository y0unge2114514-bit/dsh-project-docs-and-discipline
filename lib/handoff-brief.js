/**
 * Handoff brief — "what did the previous session leave here?".
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The usual working pattern is one agent at a time: finish a piece of work,
 * close the session, come back hours or days later and start a fresh one. The
 * fresh session has no idea that a previous session left a handoff, still holds
 * a claim, or already reverted a fix once. So it re-reads the whole project,
 * re-asks questions, and sometimes undoes a deliberate decision.
 *
 * The data to prevent that already exists — `board/agent/*.json` holds the
 * handoffs, `claims/` holds the outstanding reservations. Nobody ever joined
 * them up, so the first prompt of every new session started from zero.
 *
 * This module is the join, as a pure function, for the same reason
 * `session-bus.js` is: the last two attempts at prompt-shaping were wrong in
 * ways only visible on a live screen. Rules that matter get asserted on.
 *
 * @module @local/dsh-project-docs/handoff-brief
 */

/** Handoffs older than this are history, not a handoff. */
export const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000

/** Claims expiring in less than this are effectively gone; do not advertise them. */
export const CLAIM_MIN_REMAINING_MS = 60 * 1000

/**
 * Words that mark a handoff as "there is something you must not undo", which
 * matters far more to a fresh session than what was finished.
 */
export const CAUTION = /不要回退|别回退|禁止回退|已回滚|勿改|红线|不要动|别动|踩过|坑|回退会/

function ago(ms) {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  return `${days} 天前`
}

function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Build the brief.
 *
 * @param {object} input
 * @param {string} input.projectId
 * @param {Array<object>} input.messages   board entries, newest first
 * @param {Array<object>} input.claims     active claims for this project
 * @param {string} input.selfLabel         this session's own label
 * @param {number} input.now               epoch ms
 * @returns {{ lines: string[], empty: boolean, caution: boolean }}
 */
export function buildBrief({ projectId, messages, claims, selfLabel, now }) {
  const list = Array.isArray(messages) ? messages : []
  const claimList = Array.isArray(claims) ? claims : []
  const lines = []
  let caution = false
  let cautionNeedsPointer = false

  // 1. Claims still held. A live claim is the single most actionable fact: it
  //    says "someone told the others they own this area, and never released it".
  const live = claimList.filter((claim) => {
    const at = Date.parse(claim?.expiresAt ?? '')
    return Number.isFinite(at) && at - now > CLAIM_MIN_REMAINING_MS
  })
  for (const claim of live.slice(0, 3)) {
    const agent = typeof claim.agent === 'string' && claim.agent !== '' ? claim.agent : '(未署名)'
    const mine = selfLabel !== '' && agent === selfLabel
    const who = mine ? '你要接着的认领' : `${agent} 的未释放认领`
    const leftMinutes = Math.max(1, Math.round((Date.parse(claim.expiresAt) - now) / 60_000))
    const scope = oneLine(claim.scope, 90)
    const next = claim.nextStep ? ` · 下一步：${oneLine(claim.nextStep, 60)}` : ''
    lines.push(`- ${who}：${scope}（还剩 ${leftMinutes} 分钟到期）${next}`)
  }

  // 2. The most recent handoff that was not written by this very session.
  //    Echoing your own closing note back at you is noise.
  const handoffs = list.filter(
    (entry) => entry.kind === 'handoff' && (selfLabel === '' || entry.author !== selfLabel),
  )
  const newest = handoffs[0]
  if (newest !== undefined) {
    const at = Date.parse(newest.at ?? '')
    const when = Number.isFinite(at) ? ago(Math.max(0, now - at)) : '时间未知'
    if (Number.isFinite(at) && now - at > STALE_AFTER_MS) {
      lines.push(`- ${when}有过一次收工交接（已超两周，可能过时）：${oneLine(newest.text, 100)}`)
    } else {
      const author = newest.author ? ` · ${newest.author}` : ''
      lines.push(`- ${when}${author} 留了收工交接：${oneLine(newest.text, 120)}`)
      if (CAUTION.test(newest.text)) {
        caution = true
        // Only this path needs the pointer: the handoff itself may have said
        // "don't revert X" in passing, so the reader is told where the detail is.
        cautionNeedsPointer = true
      }
    }
  }

  // 3. A warning on the board outranks a handoff: it usually means "this broke
  //    before and will break again".
  const warning = list.find((entry) => entry.kind === 'warning')
  if (warning !== undefined) {
    const at = Date.parse(warning.at ?? '')
    const when = Number.isFinite(at) ? ago(Math.max(0, now - at)) : '时间未知'
    lines.push(`- ⚠ ${when}有一条警告：${oneLine(warning.text, 110)}`)
    caution = true
  }

  if (lines.length === 0) return { lines: [], empty: true, caution: false, cautionNeedsPointer: false }
  return {
    lines: [`**接手状态：${projectId}** — 这个项目在你之前还有人动过：`, ...lines],
    empty: false,
    caution,
    cautionNeedsPointer,
  }
}

/**
 * Render the brief, or '' when there is nothing a new session needs to know.
 *
 * The caution call-to-action only appears when the caution came from a handoff
 * rather than from an explicit warning line. A warning is already phrased as an
 * instruction ("不要回退 X"), so appending a second sentence about it just
 * repeats itself in every project and trains the reader to skip the block.
 */
export function renderBrief(result) {
  if (result === undefined || result === null || result.empty === true) return ''
  const block = result.lines.join('\n')
  return result.caution && result.cautionNeedsPointer === true
    ? `${block}\n- 其中提到「不要回退 / 不要动」的地方，动手前先读一遍 COLLAB.md 再改。`
    : block
}
