/**
 * Bundle integrity policy (pure functions, no Cordis, no I/O).
 *
 * The failure this targets: a distribution pack ships `config` but silently
 * drops `assets/` and `kubejs/`, or the zip contains only directory entries.
 * Source tree and archive tree are compared entry by entry; every missing
 * category is printed instead of a single "打包完成".
 *
 * @module @local/dsh-project-docs/bundle-integrity
 */

/** Directories that never belong in a comparison (VCS, caches, OS junk). */
const IGNORED_SEGMENTS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.idea', '.vscode',
  '.gradle', '.cache', '.venv', 'venv', '.pytest_cache', '.mypy_cache', 'dist-info',
])

const IGNORED_FILES = [
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
  /^desktop\.ini$/i,
  /\.(?:pyc|pyo|log|tmp|swp)$/i,
]

/**
 * Normalize a relative path for comparison: forward slashes, no leading `./`,
 * lower-cased only when the caller asks (Windows paths are case-insensitive).
 *
 * @param {string} raw
 * @param {boolean} [lowerCase]
 * @returns {string}
 */
export function normalizePath(raw, lowerCase = false) {
  let value = String(raw ?? '').trim().replace(/\\/g, '/')
  value = value.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '')
  return lowerCase ? value.toLowerCase() : value
}

/** Should this path be ignored when comparing trees? */
export function isIgnoredPath(raw) {
  const value = normalizePath(raw)
  if (value === '') return true
  const segments = value.split('/')
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment.toLowerCase()))) return true
  const base = segments[segments.length - 1]
  return IGNORED_FILES.some((pattern) => pattern.test(base))
}

/** Top-level category of a path — the unit the report groups misses by. */
export function categoryOf(raw) {
  const value = normalizePath(raw)
  const slash = value.indexOf('/')
  return slash === -1 ? '（根文件）' : value.slice(0, slash)
}

/**
 * Parse a directory listing (one entry per line) into a set of relative paths.
 *
 * Accepts the shapes produced by real tooling rather than one fixed format:
 *   - `ls -l` / `Get-ChildItem` style: `drwxr-xr-x 2 root root 4096 Jan 1 12:00 assets`
 *   - `find` style: `./assets/kubejs/main.js`
 *   - plain `dir /s /b` style: `D:\pack\assets\kubejs\main.js`
 * Directory entries end with `/` after normalization and are kept as directories.
 *
 * @param {string} listing
 * @returns {{ files: string[], dirs: string[] }}
 */
export function parseListing(listing) {
  const files = []
  const dirs = []
  for (const rawLine of String(listing ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    let candidate = line
    // `ls -l` style: permission bits, then columns, last field is the name.
    const isLong = /^[-dlpscbD][rwxsStT-]{9}/.test(line)
    if (isLong) {
      const parts = line.split(/\s+/)
      candidate = parts[parts.length - 1]
      if (candidate === '' || candidate === '.' || candidate === '..') continue
      if (candidate.endsWith('/')) {
        dirs.push(normalizePath(candidate))
        continue
      }
      files.push(normalizePath(candidate))
      continue
    }
    if (/^(?:total|总计)\s+\d+$/i.test(line)) continue
    // Windows absolute paths: keep only the part after the last drive root.
    candidate = candidate.replace(/^[A-Za-z]:[\\/]/, '')
    const normalized = normalizePath(candidate)
    if (normalized === '' || normalized === '.' || normalized === '..') continue
    if (normalized.endsWith('/')) {
      dirs.push(normalized.replace(/\/$/, ''))
      continue
    }
    files.push(normalized)
  }
  return { files, dirs }
}

function toSet(list, lowerCase) {
  const set = new Set()
  for (const entry of list) {
    if (isIgnoredPath(entry)) continue
    set.add(normalizePath(entry, lowerCase))
  }
  return set
}

/**
 * Compare source tree against archive tree.
 *
 * @param {object} input
 * @param {string[]} input.source       relative paths present in the source tree
 * @param {string[]} input.archive      relative paths present in the produced archive
 * @param {boolean} [input.ignoreCase]  true on Windows-style paths
 * @param {string[]} [input.requiredCategories] categories that must be non-empty
 * @returns {{ ok: boolean, missing: string[], extra: string[], missingCount: number,
 *            sourceCount: number, archiveCount: number, byCategory: Record<string, string[]>,
 *            emptyCategories: string[], verdict: string }}
 */
export function diffTrees(input = {}) {
  const ignoreCase = input.ignoreCase === true
  const source = toSet(Array.isArray(input.source) ? input.source : [], ignoreCase)
  const archive = toSet(Array.isArray(input.archive) ? input.archive : [], ignoreCase)
  const missing = []
  for (const entry of source) {
    if (!archive.has(entry)) missing.push(entry)
  }
  const extra = []
  for (const entry of archive) {
    if (!source.has(entry)) extra.push(entry)
  }
  missing.sort()
  extra.sort()

  const byCategory = {}
  for (const entry of missing) {
    const category = categoryOf(entry)
    byCategory[category] = byCategory[category] ?? []
    byCategory[category].push(entry)
  }

  // A category present in the source but with zero surviving entries in the
  // archive is the exact "只打了 config，assets/kubejs 全漏" failure.
  const sourceCategories = new Set()
  for (const entry of source) sourceCategories.add(categoryOf(entry))
  const archiveCategories = new Set()
  for (const entry of archive) archiveCategories.add(categoryOf(entry))
  const emptyCategories = []
  for (const category of sourceCategories) {
    if (!archiveCategories.has(category)) emptyCategories.push(category)
  }
  emptyCategories.sort()

  const required = Array.isArray(input.requiredCategories) ? input.requiredCategories : []
  for (const category of required) {
    const wanted = ignoreCase ? category.toLowerCase() : category
    if (!sourceCategories.has(wanted)) emptyCategories.push(wanted)
  }

  const ok = missing.length === 0 && emptyCategories.length === 0
  return {
    ok,
    missing,
    extra,
    missingCount: missing.length,
    sourceCount: source.size,
    archiveCount: archive.size,
    byCategory,
    emptyCategories: [...new Set(emptyCategories)].sort(),
    verdict: ok ? '一致' : `缺 ${missing.length} 个条目、${emptyCategories.length} 个分类为空`,
  }
}

/** Human-readable report; the failure case leads with the category list. */
export function integrityReport(result = {}, { source = '源目录', archive = '压缩包' } = {}) {
  const missing = Array.isArray(result.missing) ? result.missing : []
  const emptyCategories = Array.isArray(result.emptyCategories) ? result.emptyCategories : []
  const lines = []
  if (result.ok === true) {
    lines.push(`**打包完整性核验通过**：${source} ${result.sourceCount} 项 → ${archive} ${result.archiveCount} 项，逐条一致。`)
    if (Array.isArray(result.extra) && result.extra.length > 0) {
      lines.push(`（压缩包里多出 ${result.extra.length} 项，通常是构建产物，可忽略）`)
    }
    return lines.join('\n')
  }
  lines.push(`**打包完整性核验失败**：${source} ${result.sourceCount} 项，${archive} ${result.archiveCount} 项，缺 ${missing.length} 个条目。`)
  if (emptyCategories.length > 0) {
    lines.push(`分类为空（整块漏掉）：${emptyCategories.join('、')}`)
  }
  const byCategory = result.byCategory !== null && typeof result.byCategory === 'object' ? result.byCategory : {}
  const categories = Object.keys(byCategory).sort((left, right) => byCategory[right].length - byCategory[left].length)
  for (const category of categories.slice(0, 10)) {
    const entries = byCategory[category]
    const head = entries.slice(0, 5).join('、')
    const more = entries.length > 5 ? ` …等 ${entries.length} 项` : ''
    lines.push(`- ${category}：${head}${more}`)
  }
  if (categories.length > 10) lines.push(`- …另有 ${categories.length - 10} 个分类也缺条目`)
  lines.push('处理：要么把缺失项补进包，要么明确说明为什么不需要它们（写进交付说明），不要就这样交付。')
  return lines.join('\n')
}
