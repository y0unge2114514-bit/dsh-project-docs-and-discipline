/**
 * Proof-of-verification policy (pure functions, no Cordis, no I/O).
 *
 * The failure this targets: a model says "已修复 / 已完成 / 已就绪" without ever
 * having sent a real request, listed the real output directory, or shown that
 * the deployed copy matches what it edited. The Host half uses these helpers to
 * decide whether a turn may close with a completion claim.
 *
 * Three evidence dimensions (each claim may require a subset):
 *   request  客户端视角：真实请求的原始输出（curl -i 的状态行、ETag、字节数…）
 *   file     物理文件：解包/部署后的目录与关键文件真实大小（不是只有一个 zip）
 *   env      环境一致：目标执行环境的 md5 / 时间戳与本地一致
 *
 * @module @local/dsh-project-docs/evidence-policy
 */

/** Words a model uses to declare work finished. Ordered by specificity. */
const CLAIM_PATTERNS = [
  { kind: 'fixed', label: '已修复', pattern: /已(?:经)?(?:修复|修好|修正|解决|搞定)|修好了|修复完成/g },
  { kind: 'done', label: '已完成', pattern: /已(?:经)?(?:完成|做完|实现|上线|发布|部署完成)|完成了|做完了/g },
  { kind: 'ready', label: '已就绪', pattern: /已(?:经)?(?:就绪|可用|生效|准备好)|可以(?:交付|使用|上线)了/g },
]

/**
 * Lines that talk about the claim instead of making one: negations, plans,
 * questions, and the discipline text itself. A UI label or a quoted rule must
 * never trip the gate.
 */
const NON_ASSERTION = [
  /(?:未|没有|还没|不再|尚未|不会|不能|无法|别|不要|禁止|避免)\s*(?:已)?(?:修复|完成|解决|就绪|生效|实现|上线|发布)/,
  /(?:待|尚未|尚未曾|计划|准备|将要|下一步|稍后|随后|即将)\s*(?:去)?(?:修复|完成|实现|上线|发布)/,
  /\?\s*$|？\s*$/,
  /^[#>*-]?\s*(?:例|例如|比如|如|格式|提示|原文|示例)[:：]/,
  /`[^`]*`/,
  /「[^」]*」/,
  /“[^”]*”/,
  /"[^"]*"/,
]

/**
 * Markers that make a raw text block count as request-side evidence. The list is
 * deliberately concrete: HTTP status lines, response headers, byte counts.
 */
const REQUEST_MARKERS = [
  /HTTP\/\d(?:\.\d)?\s+\d{3}/,
  /^\s*<\s*HTTP\/\d/m,
  /ETag\s*:|etag\s*:/,
  /content-length\s*:|Content-Length\s*:/,
  /last-modified\s*:|Last-Modified\s*:/,
  /\b(?:curl|wget)\s+-/,
  /\b(?:状态码|status(?:Code|_code)?)\s*[:=]\s*\d{3}\b/i,
  /\b\d{3}\s+(?:OK|Not Found|Forbidden|Internal Server Error|Moved Permanently|Unauthorized|Bad Gateway|Service Unavailable)\b/,
  /\b(?:下载|downloaded|received|接收)\b[^\n]{0,20}\b\d+(?:\.\d+)?\s*(?:B|KB|KiB|MB|MiB|GB)\b/i,
]

/** Markers for physical-file evidence: a real directory listing or size. */
const FILE_MARKERS = [
  /\b(?:drwx|drwxr-xr-x|-rw-r--r--|-rwxr-xr-x)\b/,
  /(?:^|\s)(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2})/,
  /\b(?:总计|total)\s+\d+\b/,
  /\.(?:zip|jar|exe|dll|so|apk|tar|gz|7z|js|css|html|json|bin|pak|jar|dat)\b[^\n]{0,40}?\d+(?:\.\d+)?\s*(?:B|KB|KiB|MB|MiB|GB|bytes?)/i,
  /(?:文件数|目录数|条目数|file count|entries)\s*[:=]\s*\d+/i,
  /(?:^|\n)\s*(?:[A-Za-z]:\\|\/)[^\n]{0,80}\n/,
]

/** Markers for environment-consistency evidence: hashes and timestamps. */
const ENV_MARKERS = [
  /\b(?:md5|sha1|sha256|sha-256|hash)\b[^\n]{0,40}[:=]\s*[0-9a-f]{8,}/i,
  /\b[0-9a-f]{32}\b/,
  /\b[0-9a-f]{64}\b/,
  /(?:\b|^)(?:remote|远端|目标|服务器|vps|vps:)[^\n]{0,30}\b[0-9a-f]{8,}\b/i,
  /(?:一致|相同|匹配|一致通过|matches?|consistent)/i,
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
]

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Split text into candidate assertion lines, dropping fenced code blocks (they
 * are quoted output, not claims) and lines that only talk about the claim.
 *
 * @param {string} text
 * @returns {{ kind: string, label: string, line: string }[]}
 */
export function findClaims(text) {
  const source = typeof text === 'string' ? text : ''
  if (source.trim() === '') return []
  const kept = []
  let inFence = false
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (NON_ASSERTION.some((pattern) => pattern.test(line))) continue
    kept.push(line)
  }
  const found = []
  for (const line of kept) {
    for (const group of CLAIM_PATTERNS) {
      const match = group.pattern.exec(line)
      group.pattern.lastIndex = 0
      if (match !== null) {
        found.push({ kind: group.kind, label: group.label, line: line.trim().slice(0, 160) })
      }
    }
  }
  return found
}

/** True when the assistant text carries any completion claim. */
export function hasClaim(text) {
  return findClaims(text).length > 0
}

/**
 * Which evidence dimensions a raw text block can satisfy.
 *
 * @param {string} text
 * @returns {{ request: boolean, file: boolean, env: boolean }}
 */
export function classifyEvidence(text) {
  const source = typeof text === 'string' ? text : ''
  return {
    request: REQUEST_MARKERS.some((pattern) => pattern.test(source)),
    file: FILE_MARKERS.some((pattern) => pattern.test(source)),
    env: ENV_MARKERS.some((pattern) => pattern.test(source)),
  }
}

const DIMENSION_LABELS = {
  request: '客户端视角（真实请求原始输出：状态行 / ETag / Content-Length / 实际下载字节数）',
  file: '物理文件（解包或部署后的目录与关键文件真实大小，不能只给 zip 大小）',
  env: '环境一致（目标环境与本地同 md5 / 同时间戳，证明部署确实到达）',
}

/**
 * Decide whether the collected evidence is enough.
 *
 * @param {object} input
 * @param {string} [input.text]     free-text evidence blob (usually tool output)
 * @param {Record<string, boolean>} [input.provided] explicit per-dimension flags
 * @param {string[]} [input.required] dimensions the caller must prove
 * @param {string[]} [input.distilled] human-readable digests of each evidence block
 * @returns {{ satisfied: boolean, missing: string[], dimensions: Record<string, boolean> }}
 */
export function evidenceVerdict(input = {}) {
  const required = Array.isArray(input.required) && input.required.length > 0 ? input.required : ['request', 'file', 'env']
  const fromText = classifyEvidence(input.text)
  const provided = input.provided !== null && typeof input.provided === 'object' ? input.provided : {}
  const dimensions = {
    request: fromText.request || provided.request === true,
    file: fromText.file || provided.file === true,
    env: fromText.env || provided.env === true,
  }
  const missing = []
  for (const key of required) {
    if (dimensions[key] !== true) missing.push(key)
  }
  return { satisfied: missing.length === 0, missing, dimensions }
}

/** The refusal text, listing exactly which dimensions are still missing. */
export function missingEvidenceMessage(missing, { projectId = '', claimKind = '' } = {}) {
  const where = projectId === '' ? '' : `（项目 ${projectId}）`
  const label = claimKind === '' ? '' : `你刚写了「${claimKind}」。`
  const list = missing.map((key) => `- ${DIMENSION_LABELS[key] ?? key}`).join('\n')
  return (
    `${label}未检测到物理端到端验证证据${where}。请执行真实请求并提供数据后再汇报，仍缺：\n${list}\n\n` +
    '收尾做法：把真实命令的原始输出贴进证据（例如 `curl -i` 的响应行、`ls -l` / `Get-ChildItem` 的目录与文件大小、远端与本地 md5 对照），' +
    '再调用 project_docs → verify_deliverable 登记；没有真实证据就把结论改写成「未实测」，不要写「已完成」。'
  )
}

/** Short digest so the evidence store stays small. */
export function digestEvidence(text, max = 400) {
  const source = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
  const joined = source.join('\n')
  if (joined.length <= max) return joined
  return `${joined.slice(0, max - 1)}…`
}

/** Extract the plain text of one assistant message's content blocks. */
export function assistantText(message) {
  if (message === null || message === undefined) return ''
  const blocks = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Strip markdown emphasis so `**已完成**` still matches the claim patterns. */
export function normalizeForClaim(text) {
  return String(text ?? '').replace(/[*_`]{1,3}/g, '')
}

export { CLAIM_PATTERNS, DIMENSION_LABELS, REQUEST_MARKERS, FILE_MARKERS, ENV_MARKERS, escapeRegExp }
