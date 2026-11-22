/**
 * Circuit breaker for repeated failed attempts (pure functions, no Cordis, no I/O).
 *
 * The failure this targets: a model keeps patching the same symptom (黑屏 / 没更新
 * / 下载慢) in the same wrong direction dozens of times, never reading the code
 * that actually consumes the artifact. After two identical failure fingerprints
 * the breaker trips into **Trace Mode**: writes are refused until the model
 * produces evidence that it traced the real consumer path.
 *
 * @module @local/dsh-project-docs/circuit-breaker
 */

/** The two ways a failure gets reported: user feedback, or a failing command. */
export const FAILURE_SOURCES = ['feedback', 'command']

/** How many identical fingerprints before the breaker trips. */
export const TRIP_THRESHOLD = 2

/** Evidence that counts as "I traced the real consumer". */
const TRACE_MARKERS = [
  { pattern: /\b[A-Za-z0-9_\-./\\]+\.(?:cs|ts|js|tsx|jsx|py|java|kt|go|rs|php|rb|cshtml|lua|sh|ps1)\s*:\s*\d+/,
    label: '真实消费端源码的「文件:行号」' },
  { pattern: /(?:\b|^)(?:access\.log|error\.log|npm-debug|stderr)\b/i, label: '真实日志（access.log / error.log）' },
  { pattern: /\b(?:tcpdump|wireshark|curl\s+-i|ss\s+-tnp|netstat)\b/i, label: '真实网络包 / 真实请求' },
  { pattern: /\bstack(?:\s|-)?trace\b|调用栈|回溯|Traceback \(most recent call last\)/i, label: '真实调用栈' },
]

/**
 * Empty breaker state.
 * @returns {{ failures: Record<string, {count: number, firstAt: string, lastAt: string}>,
 *             tripped: null | { fingerprint: string, count: number, at: string },
 *             traceSubmitted: boolean }}
 */
export function emptyState() {
  return { failures: {}, tripped: null, traceSubmitted: false }
}

/**
 * Record one failure observation and advance the state machine.
 *
 * @param {object} state previous state (see emptyState)
 * @param {object} input
 * @param {string} input.fingerprint normalized fingerprint ('' = ignore)
 * @param {string} input.at ISO timestamp
 * @param {string} [input.source] 'feedback' | 'command'
 * @returns {{ state: object, tripped: boolean, justTripped: boolean, count: number }}
 */
export function recordFailure(state, { fingerprint = '', at = new Date().toISOString(), source = 'command' } = {}) {
  const current = normalizeState(state)
  if (fingerprint === '') return { state: current, tripped: current.tripped !== null, justTripped: false, count: 0 }
  const previous = current.failures[fingerprint]
  const count = (previous?.count ?? 0) + 1
  const next = {
    failures: { ...current.failures, [fingerprint]: { count, firstAt: previous?.firstAt ?? at, lastAt: at, source } },
    tripped: current.tripped,
    traceSubmitted: current.traceSubmitted,
  }
  let justTripped = false
  if (next.tripped === null && count >= TRIP_THRESHOLD) {
    next.tripped = { fingerprint, count, at }
    next.traceSubmitted = false
    justTripped = true
  }
  return { state: next, tripped: next.tripped !== null, justTripped, count }
}

function normalizeState(state) {
  const source = state !== null && typeof state === 'object' ? state : {}
  const failures = source.failures !== null && typeof source.failures === 'object' ? { ...source.failures } : {}
  return {
    failures,
    tripped: source.tripped !== null && typeof source.tripped === 'object' ? { ...source.tripped } : null,
    traceSubmitted: source.traceSubmitted === true,
  }
}

/** True when writes must be refused right now. */
export function isWriteBlocked(state) {
  const current = normalizeState(state)
  return current.tripped !== null && current.traceSubmitted !== true
}

/**
 * Does this text look like a real trace of the consumer path?
 *
 * @param {string} text
 * @returns {{ ok: boolean, markers: string[] }}
 */
export function traceEvidence(text) {
  const source = String(text ?? '')
  const markers = TRACE_MARKERS.filter((entry) => entry.pattern.test(source)).map((entry) => entry.label)
  return { ok: markers.length > 0, markers }
}

/**
 * Try to clear a tripped breaker with a trace submission.
 *
 * @param {object} state
 * @param {string} text the trace submission
 * @param {string} [at]
 * @returns {{ state: object, cleared: boolean, markers: string[] }}
 */
export function tryClear(state, text, at = new Date().toISOString()) {
  const current = normalizeState(state)
  const evidence = traceEvidence(text)
  if (!evidence.ok) return { state: current, cleared: false, markers: [] }
  return {
    state: { failures: {}, tripped: null, traceSubmitted: true, clearedAt: at },
    cleared: true,
    markers: evidence.markers,
  }
}

/** Refusal text shown when a write is attempted inside Trace Mode. */
export function traceModeMessage(tripped = {}, markers = []) {
  const fingerprint = typeof tripped.fingerprint === 'string' ? tripped.fingerprint.slice(0, 100) : '（同一失败）'
  const count = Number.isFinite(tripped.count) ? tripped.count : TRIP_THRESHOLD
  const evidenceList = TRACE_MARKERS.map((entry) => `- ${entry.label}`).join('\n')
  const known = markers.length === 0 ? '' : `\n（已识别到的证据类型：${markers.join('、')}——还不够，必须同时给出「文件:行号」级别的消费端逻辑。）`
  return (
    `**死循环断路器已触发：同一失败已经出现 ${count} 次**，失败特征：${fingerprint}${known}\n\n` +
    '现在**禁止继续写补丁**。请先进入「源码与数据流对齐模式（Trace Mode）」，按顺序做完：\n' +
    '1) 读**消费端真实源码**：真正读取/执行这个文件的那段代码（例如 Program.cs、启动器入口、Nginx 实际路由、前端加载器）。不要猜，要打开看。\n' +
    '2) 抓**真实数据**：access.log / error.log / 真实网络包 / 真实请求响应，证明失败发生在哪一层。\n' +
    '3) 写出**消费端逻辑调用栈**，格式必须是「文件:行号 → 它做了什么 → 为什么导致当前结果」，例如：`Program.cs:2841 只读 configs.zip，而当前 zip 内缺少 assets/kubejs → 资源缺失 → 黑屏`。\n\n' +
    `可接受的证据类型：\n${evidenceList}\n\n` +
    '完成后调用 `project_docs_write → trace_report`（`evidence:` 里贴上面三类证据），断路器会自动解锁，你才能继续改代码。'
  )
}

/** Reminder injected into the runtime context while the breaker is tripped. */
export function traceModeReminder(tripped = {}) {
  const count = Number.isFinite(tripped.count) ? tripped.count : TRIP_THRESHOLD
  return (
    `**死循环断路：同一失败已第 ${count} 次** — 你现在处于 Trace Mode，写操作会被拒绝。` +
    '不要再改代码；先读消费端真实源码、抓真实日志/网络包，然后用 `project_docs_write → trace_report` 交出「文件:行号」级的调用栈。'
  )
}
