/**
 * Pure helpers for the "no claim, no mutation" guard.
 *
 * The guard has two jobs:
 *  1. work out which project an execution belongs to, from the session cwd and
 *     the tool arguments (an agent may `cd` elsewhere or pass absolute paths);
 *  2. decide what to do: allow / prompt once / block because someone else holds
 *     an active claim.
 *
 * Identity is per session: a claim taken through `project_docs_write →
 * claim_work` is remembered for the session id that issued it.
 */

/**
 * Normalize a path for prefix comparison on the platform that produced it.
 *
 * Why the platform matters:
 *   - On Windows both separators are real, and the filesystem is
 *     case-insensitive, so folding to `\` + lowercase is correct there.
 *   - On macOS the filesystem is case-insensitive too (by default).
 *   - On Linux neither is true: `\` is a legal filename character and
 *     `/srv/App` is a different directory from `/srv/app`. Folding case there
 *     would make two distinct projects collide.
 */
export function normalizePath(value, platform = process.platform) {
  const raw = String(value ?? '')
  const foldCase = platform === 'win32' || platform === 'darwin'
  let text = foldCase ? raw.replace(/[\\/]+/g, '\\') : raw.replace(/\/+/g, '/')
  // Trailing whitespace and separators both go: `D:\work\proj\  ` is the same
  // directory as `D:\work\proj`, and a trailing blank comes from copy-paste.
  text = text.replace(/[\\/\s]+$/, '')
  return foldCase ? text.toLowerCase() : text
}

function separatorOf(platform) {
  return platform === 'win32' || platform === 'darwin' ? '\\' : '/'
}

/**
 * True when `haystack` contains `needle` as a whole path component run.
 *
 * Substring matching is what made the old version wrong: project root
 * `/srv/app/lib` matched `/srv/app/library/x`, so a write into a *different*
 * project was attributed to this one and the claim guard silently passed it.
 * Require the match to start at a separator (or index 0) and to end at a
 * separator (or end of string).
 */
function containsPath(haystack, needle, platform) {
  const sep = separatorOf(platform)
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return false
    const before = at === 0 ? sep : haystack[at - 1]
    const afterIndex = at + needle.length
    const after = afterIndex >= haystack.length ? sep : haystack[afterIndex]
    const startOk = before === sep || before === '\n' || before === '"' || before === ' '
    const endOk = after === sep || after === '"' || after === '\n' || after === ',' || after === ' '
    if (startOk && endOk) return true
    from = at + 1
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? '')
  } catch {
    return ''
  }
}

/** Longest matching project root wins, so nested projects beat their parent. */
export function projectForContext(roots, cwd, args, platform = process.platform) {
  if (!Array.isArray(roots) || roots.length === 0) return undefined
  const haystack = `${normalizePath(cwd, platform)}\n${normalizePath(safeJson(args), platform)}`
  if (haystack.trim() === '') return undefined
  let best
  let bestLength = -1
  for (const entry of roots) {
    const root = normalizePath(entry?.root, platform)
    if (root === '' || !containsPath(haystack, root, platform)) continue
    if (root.length > bestLength) {
      best = entry
      bestLength = root.length
    }
  }
  return best === undefined ? undefined : best.id
}

/** Drop claims that already expired (the store does this too, but caches age). */
export function activeOnly(claims, now = Date.now()) {
  if (!Array.isArray(claims)) return []
  return claims.filter((claim) => Number.isFinite(Date.parse(claim?.expiresAt)) && Date.parse(claim.expiresAt) > now)
}

/**
 * @returns {'allow' | 'prompt' | 'block'}
 *   allow  — this session already holds a live claim on the project;
 *   block  — another agent holds a live claim and this session holds none;
 *   prompt — nobody holds a claim yet: warn once, then allow.
 */
export function claimDecision({ claimed = false, warned = false, others = [] } = {}) {
  if (claimed) return 'allow'
  if (Array.isArray(others) && others.length > 0) return 'block'
  if (warned) return 'allow'
  return 'prompt'
}
