/**
 * Plan-by-size discipline — "how much ceremony does this task deserve?".
 *
 * THE PROBLEM
 * -----------
 * Two failure modes bracket the same mistake, and both are expensive:
 *
 *   - A two-minute edit gets a full plan, an approval wait and three
 *     confirmations. The user pays in latency for ceremony they did not want.
 *   - A two-hour migration starts without a word. The user finds out what the
 *     agent intended when it is already half done.
 *
 * The right behaviour is proportional, and it turns entirely on one number: the
 * expected duration. Deep PTC states the bands explicitly (≤5 min: just do it;
 * 5–20 min: say the plan and proceed; >20 min: show the plan and wait). That is
 * a good rule, and it maps onto this plugin because the plugin already reads the
 * assistant's own text at the turn boundary.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It does not estimate anything. Estimation from natural language would be a
 * guess dressed up as a measurement. It only *classifies a number the agent
 * already stated* ("预计 30 分钟", "about 2 hours"), and tells the caller which
 * band that number falls into. An agent that states no estimate gets no nag —
 * the gate has nothing to check against, and inventing one would be worse than
 * silence.
 *
 * @module @local/dsh-project-docs/estimate-policy
 */

/** Band boundaries in minutes. Deep PTC uses 5 and 20; same numbers here. */
export const BANDS = { inline: 5, announce: 20 }

/**
 * Duration units, in minutes. Chinese and English, because the agent writes in
 * whichever the conversation uses.
 */
const UNITS = [
  { pattern: /(秒|seconds?|secs?|s)\b/i, minutes: 1 / 60, chinese: /秒/ },
  { pattern: /(分钟|分|minutes?|mins?|m)\b/i, minutes: 1, chinese: /分钟|分/ },
  { pattern: /(小时|钟头|hours?|hrs?|h)\b/i, minutes: 60, chinese: /小时|钟头/ },
  { pattern: /(天|days?|d)\b/i, minutes: 60 * 24, chinese: /天/ },
]

const CN_NUMBERS = {
  半: 0.5,
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十五: 15, 二十: 20, 三十: 30, 四十: 40, 五十: 50, 六十: 60,
}

/**
 * Pull every stated duration out of the text, in minutes.
 *
 * Deliberately loose about phrasing (`预计 30 分钟`, `约 2 小时`, `about 20 min`,
 * `半个 小时`, `1.5h`) and strict about what counts: a number must sit next to a
 * time unit. Bare numbers are ignored, because "3 files" is not an estimate.
 *
 * The filler class is load-bearing: Chinese inserts measure words between the
 * number and the unit ("半**个**小时", "两**个**小时"), and a first version that
 * did not allow them silently extracted nothing.
 *
 * @param {string} text
 * @returns {number[]} durations in minutes, in the order found
 */
export function extractEstimates(text) {
  const source = typeof text === 'string' ? text : ''
  if (source.trim() === '') return []
  const found = []
  const FILL = '[个多余整来]?'  // 半小时 / 半个小时 / 一个小时

  // Arabic numerals: 30 分钟 / 2 小时 / 20 min / 1.5h
  //
  // The trailing `\b` in the first version killed every Chinese match: `\b` is a
  // *word* boundary, and Chinese characters are not word characters in JS's
  // default (non-Unicode) regex, so "30 分钟" has no boundary after 分钟. The
  // unit alternation is written so that English units carry their own boundary
  // instead, and Chinese units need none.
  const arabic = new RegExp(
    `(\\d+(?:\\.\\d+)?)\\s*${FILL}\\s*(分钟|分|小时|钟头|天|(?:minutes?|mins?|hours?|hrs?|days?|h|d)\\b)`,
    'gi',
  )
  let match
  while ((match = arabic.exec(source)) !== null) {
    const value = Number(match[1])
    if (!Number.isFinite(value)) continue
    const unit = match[2].toLowerCase()
    let minutes
    if (unit.startsWith('分') || unit === 'm' || unit.startsWith('min')) minutes = value
    else if (unit.startsWith('小') || unit.startsWith('钟') || unit === 'h' || unit.startsWith('hour') || unit.startsWith('hr')) minutes = value * 60
    else minutes = value * 60 * 24
    found.push({ index: match.index, minutes })
  }

  // Chinese numerals: 半小时 / 半个小时 / 两小时 / 二十分钟 / 三天
  const chinese = new RegExp(`([半一二两三四五六七八九十]{1,2})\\s*${FILL}\\s*(分钟|分|小时|钟头|天)`, 'g')
  while ((match = chinese.exec(source)) !== null) {
    const raw = match[1]
    const value = CN_NUMBERS[raw]
    if (value === undefined) continue
    const unit = match[2]
    const minutes = unit === '天' ? value * 60 * 24 : unit === '分钟' || unit === '分' ? value : value * 60
    found.push({ index: match.index, minutes })
  }

  // Dedupe by position: both passes can match the same span ("2 小时" is only
  // Arabic, but a mixed string could match twice).
  const seen = new Set()
  const unique = []
  for (const item of found.sort((a, b) => a.index - b.index)) {
    const key = `${item.index}:${item.minutes}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item.minutes)
  }
  return unique
}

/**
 * Classify one estimate into a band.
 *
 * @param {number} minutes
 * @returns {'inline'|'announce'|'approve'}
 */
export function bandOf(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'inline'
  if (minutes <= BANDS.inline) return 'inline'
  if (minutes <= BANDS.announce) return 'announce'
  return 'approve'
}

/**
 * Decide what to tell the agent about its own stated plan.
 *
 * Returns `null` when there is nothing to say: no estimate, or an estimate
 * already handled correctly.
 *
 * @param {string} text      assistant message about to be sent
 * @param {object} options
 * @param {boolean} options.planVisible  did the message already show a plan
 * @param {boolean} options.waiting      is the message waiting for approval
 * @returns {{ band: string, minutes: number, message: string }|null}
 */
export function estimateVerdict(text, { planVisible = false, waiting = false } = {}) {
  const estimates = extractEstimates(text)
  if (estimates.length === 0) return null

  // The largest stated duration governs: "several steps, about an hour total"
  // is an hour-long task.
  const minutes = Math.max(...estimates)
  const band = bandOf(minutes)

  if (band === 'inline') return null
  if (band === 'announce') {
    if (planVisible) return null
    return {
      band,
      minutes,
      message:
        `计划可见性：你说这活大约 ${describeMinutes(minutes)}，落在「5–20 分钟」档。` +
        '这一档要求先把计划展示出来，然后直接开始执行，不要等批准。' +
        '请补上要动哪些文件、按什么顺序、怎么验证，再开始动手。',
    }
  }

  // band === 'approve'
  if (waiting) return null
  return {
    band,
    minutes,
    message:
      `计划可见性：你说这活大约 ${describeMinutes(minutes)}，落在「超过 20 分钟」档。` +
      '这一档要求先给计划并等用户批准再动手，不要直接开始改。' +
      '计划里请写明：要动什么、分几步、每步怎么验证、失败怎么回退。' +
      '如果你已经做了一部分，明确说明已经改了什么，并把剩余部分交回给用户确认。',
  }
}

/** Human wording for a duration, matching how the agent stated it. */
export function describeMinutes(minutes) {
  if (!Number.isFinite(minutes)) return '未知时长'
  if (minutes < 1) return `${Math.round(minutes * 60)} 秒`
  if (minutes < 60) return `${Math.round(minutes)} 分钟`
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`
}

/**
 * Does this message already look like a plan?
 *
 * Intentional heuristic: a numbered list plus at least one concrete artefact
 * reference. A single sentence "I will fix it" is not a plan, and pretending it
 * is would let the >20min band through unchecked.
 */
export function looksLikePlan(text) {
  const source = typeof text === 'string' ? text : ''
  const numbered = /(?:^|\n)\s*(?:\d+[.、)]|[-*]\s)/.test(source)
  const concrete = /(?:\.(?:js|mjs|ts|py|json|yml|md|sh|ps1)\b|src\/|scripts\/|test|测试|验证|回滚|备份)/i.test(source)
  return numbered && concrete
}

/** Does the message explicitly wait for the user before continuing? */
export function looksWaiting(text) {
  const source = typeof text === 'string' ? text : ''
  return /(?:等你|待你|请确认|需要你确认|approve|approval|批准|拍板|你同意后|确认后我再)/i.test(source)
}
