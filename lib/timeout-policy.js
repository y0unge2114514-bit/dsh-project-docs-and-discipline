/**
 * Pure helpers for the "stop waiting, start parallelising" policy.
 *
 * Agents habitually pass multi-minute timeouts and then block on them. The
 * plugin cannot make a slow command fast, but it can (a) refuse the first
 * oversized timeout request with an explanation, and (b) remind the agent after
 * a slow call that the next attempt should look for concurrency or a cheaper
 * approach first.
 *
 * Kept free of Cordis so `test-store.mjs` can drive it directly.
 */

/** Tool-argument keys that express a caller-chosen timeout, in any casing style. */
const TIMEOUT_KEYS = [
  'timeoutMs',
  'timeout_ms',
  'timeoutMS',
  'timeout',
  'timeoutSeconds',
  'timeout_seconds',
  'waitMs',
  'wait_ms',
  'maxWaitMs',
]

function asMilliseconds(key, value) {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (/seconds/i.test(key)) return value * 1000
  // A bare `timeout` of 5 or 30 is almost certainly seconds, not milliseconds.
  if (key === 'timeout' && value <= 600) return value * 1000
  return value
}

/**
 * Largest caller-chosen timeout in one tool call, in milliseconds.
 * @returns {{ key: string, ms: number } | undefined}
 */
export function requestedTimeoutMs(args) {
  if (args === null || typeof args !== 'object') return undefined
  let best
  for (const key of TIMEOUT_KEYS) {
    const ms = asMilliseconds(key, Number(args[key]))
    if (ms === undefined) continue
    if (best === undefined || ms > best.ms) best = { key, ms }
  }
  return best
}

/**
 * @returns {'allow' | 'warn'} `warn` means: refuse this one call and explain,
 *   because the requested wait is far beyond what a well-shaped attempt needs.
 *   The caller decides whether it already warned this agent.
 */
export function timeoutDecision({ requested, limit, warned = false } = {}) {
  if (warned) return 'allow'
  if (requested === undefined || requested === null) return 'allow'
  if (!Number.isFinite(limit) || limit <= 0) return 'allow'
  return requested.ms > limit ? 'warn' : 'allow'
}

/** Human wording for a duration, used by the reminders. */
export function describeDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  const seconds = ms / 1000
  if (seconds < 90) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} 秒`
  const minutes = seconds / 60
  return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} 分钟`
}
