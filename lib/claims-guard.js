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

/** Normalize a Windows path for prefix / substring comparison. */
export function normalizePath(value) {
  return String(value ?? '')
    .replace(/\//g, '\\')
    .replace(/\\+/g, '\\')
    .replace(/[\\\s]+$/, '')
    .toLowerCase()
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? '')
  } catch {
    return ''
  }
}

/** Longest matching project root wins, so nested projects beat their parent. */
export function projectForContext(roots, cwd, args) {
  if (!Array.isArray(roots) || roots.length === 0) return undefined
  const haystack = `${normalizePath(cwd)}\n${normalizePath(safeJson(args))}`
  if (haystack.trim() === '') return undefined
  let best
  let bestLength = -1
  for (const entry of roots) {
    const root = normalizePath(entry?.root)
    if (root === '' || !haystack.includes(root)) continue
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
