/**
 * Refuse long foreground sleeps — "waiting is not progress".
 *
 * WHY THIS EXISTS
 * ---------------
 * The timeout guard already catches a *tool parameter* like `timeoutMs: 300000`.
 * It cannot catch the same intent written inside the command itself:
 *
 *   sleep 60 && curl ...           (the agent decided to wait a minute)
 *   Start-Sleep -Seconds 30        (PowerShell spelling)
 *   timeout /t 20                  (cmd spelling)
 *   ping -n 30 127.0.0.1 >nul      (the classic Windows sleep, no unit anywhere)
 *
 * An agent that writes one of these has decided to block, and no parameter-level
 * check sees it. The block is also usually pointless: the thing being waited for
 * could be polled, or the command could run in the background and the agent could
 * do something else.
 *
 * So: a foreground command whose *only* purpose is a long pause is refused once,
 * with the alternative spelled out. A short pause is fine (readiness loops need
 * them), and anything explicitly backgrounded is fine too.
 *
 * @module @local/dsh-project-docs/sleep-policy
 */

/** A foreground pause longer than this is not "readiness", it is waiting. */
export const MAX_FOREGROUND_SLEEP_SECONDS = 5

/**
 * Pull every pause out of a command string, in seconds.
 *
 * Handles the four spellings that actually appear on this platform. Comments and
 * quoted strings are not stripped, which can over-match — acceptable here
 * because the consequence is one refused call with an explanation, not data
 * loss, and the agent can rerun it in the background.
 *
 * @param {string} command
 * @returns {number[]} seconds, in the order found
 */
export function extractSleeps(command) {
  const source = typeof command === 'string' ? command : ''
  if (source.trim() === '') return []
  const found = []

  // sleep 60 / sleep 1.5s / sleep 2m
  const unix = /\bsleep\s+(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\b/gi
  let match
  while ((match = unix.exec(source)) !== null) {
    const value = Number(match[1])
    if (!Number.isFinite(value)) continue
    const unit = (match[2] ?? 's').toLowerCase()
    found.push({ index: match.index, seconds: unit === 'ms' ? value / 1000 : unit === 'm' ? value * 60 : unit === 'h' ? value * 3600 : value })
  }

  // Start-Sleep -Seconds 30 / -Milliseconds 500 / -s 30
  const powershell = /\bStart-Sleep\b[^\n]*?-(?:Seconds|s)\s+(\d+(?:\.\d+)?)|\bStart-Sleep\b[^\n]*?-(?:Milliseconds|ms)\s+(\d+(?:\.\d+)?)/gi
  while ((match = powershell.exec(source)) !== null) {
    const isMs = match[2] !== undefined
    const value = Number(isMs ? match[2] : match[1])
    if (!Number.isFinite(value)) continue
    found.push({ index: match.index, seconds: isMs ? value / 1000 : value })
  }

  // timeout /t 20 (cmd). `timeout /t 20` waits 20 seconds; without /t it is not
  // a sleep at all, it is a kill.
  const cmdTimeout = /\btimeout\s+\/t\s+(\d+)/gi
  while ((match = cmdTimeout.exec(source)) !== null) {
    found.push({ index: match.index, seconds: Number(match[1]) })
  }

  // ping -n 30 127.0.0.1 >nul — the Windows sleep idiom. -n counts replies, so
  // the pause is roughly (n-1) seconds.
  const ping = /\bping\b[^\n]*?-n\s+(\d+)/gi
  while ((match = ping.exec(source)) !== null) {
    const count = Number(match[1])
    if (!Number.isFinite(count) || count <= 1) continue
    found.push({ index: match.index, seconds: count - 1 })
  }

  return found.sort((a, b) => a.index - b.index).map((item) => item.seconds)
}

/**
 * Decide whether a command should be refused for being a long foreground pause.
 *
 * @param {object} input
 * @param {string} input.toolName   which shell tool ran
 * @param {object} input.args       its arguments
 * @returns {{ seconds: number, message: string }|null}  null means "let it run"
 */
export function sleepVerdict({ toolName, args }) {
  const source = args !== null && typeof args === 'object' ? args : {}
  // Clearly backgrounded work is not blocking anyone: that is the recommended
  // alternative, not the mistake.
  if (source.run_in_background === true || source.runInBackground === true) return null

  const command = typeof source.command === 'string'
    ? source.command
    : typeof source.script === 'string'
      ? source.script
      : typeof source.script_path === 'string'
        ? source.script_path
        : ''
  const sleeps = extractSleeps(command)
  if (sleeps.length === 0) return null

  const longest = Math.max(...sleeps)
  if (longest <= MAX_FOREGROUND_SLEEP_SECONDS) return null

  const shell = typeof toolName === 'string' && toolName !== '' ? toolName : 'shell'
  return {
    seconds: longest,
    message:
      `等待纪律：这条 ${shell} 命令里有 ${describeSeconds(longest)} 的暂停，已拒绝一次。\n` +
      '阻塞等待不是推进。按这个顺序换做法：\n' +
      '1) **轮询代替等待**——先启动，再用 job_output / 状态接口查一次，没到就去做别的；\n' +
      '2) **转后台**——`run_in_background: true`（或 PowerShell `Start-Job`），命令照跑，你继续别的步骤；\n' +
      '3) **缩短等待**——确实必须等就压到 5 秒内，多用几次短等而不是一次长等。\n' +
      '如果你是在等服务就绪，改成「起服务 → 立刻返回 → 下一步再探活」。重发这条命令即可（本条只拦截一次）。',
  }
}

/** Wording for a pause length. */
export function describeSeconds(seconds) {
  if (!Number.isFinite(seconds)) return '未知时长'
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  const minutes = seconds / 60
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} 分钟`
}
