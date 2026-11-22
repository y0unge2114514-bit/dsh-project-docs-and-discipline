#!/usr/bin/env node
/**
 * Snapshot and verify — catches the class of damage that bulk edits cause.
 *
 * WHY THIS EXISTS
 * ---------------
 * Twice now, a "simple" bulk replacement silently destroyed source files: a
 * PowerShell `.Replace()` pass turned `const` into `oonst`, `docs` into `doos`
 * and `function` into `funotion` across five scripts. Nothing complained until
 * `node --check` was run, and by then the originals were gone.
 *
 * The failure mode is always the same shape: a text transformation that is not
 * a parser, applied to many files at once, with no verification step. It does
 * not look like an edit — it looks like success.
 *
 * So this tool makes the transformation *checkable*:
 *
 *   snapshot   record every file's size and hash before touching anything
 *   verify     after the edit, prove that (a) every file still parses and
 *              (b) only the files you intended to change actually changed
 *
 * Usage:
 *   node scripts/verify-integrity.mjs snapshot [--out <file>]
 *   node scripts/verify-integrity.mjs verify   [--manifest <file>] [--changed a.js,b.js]
 *
 * Exit codes: 0 all good, 1 damage found, 2 usage error.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const DEFAULT_MANIFEST = path.join(repoRoot, '.integrity-manifest.json')

/** Only these are source; the manifest must never absorb generated output. */
const SOURCE_EXT = /\.(?:js|mjs|cjs|json|yml|md|svg)$/

function listSources() {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!SOURCE_EXT.test(entry.name)) continue
      if (entry.name === '.integrity-manifest.json') continue
      out.push(full)
    }
  }
  walk(repoRoot)
  return out.sort()
}

function digest(file) {
  const bytes = fs.readFileSync(file)
  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
  }
}

function parseArgs(argv) {
  const out = { command: argv[0] ?? '', manifest: DEFAULT_MANIFEST, changed: [] }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--out' || arg === '--manifest') {
      out.manifest = path.resolve(argv[++i] ?? '')
    } else if (arg === '--changed') {
      out.changed = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    }
  }
  return out
}

function snapshot(options) {
  const files = listSources()
  const entries = {}
  for (const file of files) {
    entries[path.relative(repoRoot, file).replace(/\\/g, '/')] = digest(file)
  }
  const manifest = { at: new Date().toISOString(), root: repoRoot, files: entries }
  fs.writeFileSync(options.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`已快照 ${files.length} 个源文件 → ${options.manifest}`)
  return 0
}

/** Does this file still parse? Only JS-like files can be checked this way. */
function parses(file) {
  if (!/\.(?:js|mjs|cjs)$/.test(file)) return { ok: true }
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    return { ok: true }
  } catch (error) {
    const stderr = error.stderr === undefined ? '' : String(error.stderr).split('\n').slice(0, 3).join(' ')
    return { ok: false, reason: stderr.trim() }
  }
}

function verify(options) {
  if (!fs.existsSync(options.manifest)) {
    console.error(`没有快照文件：${options.manifest}\n先运行 node scripts/verify-integrity.mjs snapshot`)
    return 2
  }
  const manifest = JSON.parse(fs.readFileSync(options.manifest, 'utf8'))
  const before = manifest.files ?? {}
  const current = {}
  for (const file of listSources()) {
    current[path.relative(repoRoot, file).replace(/\\/g, '/')] = digest(file)
  }

  const problems = []

  // 1. A file that changed but was not declared is an unintended edit — the
  //    exact signature of a bulk replacement going wider than intended.
  const changed = []
  for (const [rel, info] of Object.entries(current)) {
    const old = before[rel]
    if (old === undefined) {
      changed.push(rel)
      if (!options.changed.includes(rel)) problems.push(`新增但未声明: ${rel}`)
      continue
    }
    if (old.sha256 !== info.sha256) {
      changed.push(rel)
      if (!options.changed.includes(rel)) problems.push(`被改动但未声明: ${rel}`)
    }
  }

  // 2. A file that vanished is always a problem.
  for (const rel of Object.keys(before)) {
    if (current[rel] === undefined) problems.push(`丢失: ${rel}`)
  }

  // 3. Every source file must still parse, changed or not. This is the check
  //    that would have caught `const` → `oonst` immediately.
  for (const rel of Object.keys(current)) {
    const verdict = parses(path.join(repoRoot, rel))
    if (!verdict.ok) problems.push(`语法损坏: ${rel}\n    ${verdict.reason}`)
  }

  console.log(`快照时间: ${manifest.at}`)
  console.log(`文件数: 快照 ${Object.keys(before).length} → 现在 ${Object.keys(current).length}`)
  console.log(`变动的文件: ${changed.length === 0 ? '（无）' : changed.join(', ')}`)

  if (problems.length === 0) {
    console.log('\n✓ 完整性校验通过：声明范围内改动，且全部文件可解析')
    return 0
  }
  console.log(`\n✗ 发现 ${problems.length} 个问题：`)
  for (const problem of problems) console.log(`  - ${problem}`)
  return 1
}

const options = parseArgs(process.argv.slice(2))
if (options.command === 'snapshot') {
  process.exit(snapshot(options))
} else if (options.command === 'verify') {
  process.exit(verify(options))
} else {
  console.error('用法:\n  node scripts/verify-integrity.mjs snapshot [--out <file>]\n  node scripts/verify-integrity.mjs verify [--manifest <file>] [--changed a.js,b.js]')
  process.exit(2)
}
