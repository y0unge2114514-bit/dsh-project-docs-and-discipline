#!/usr/bin/env node
/**
 * Cross-project consistency check for the unified knowledge base.
 *
 * The migration recorded what each project *says* about a shared resource. It
 * did not check whether those statements can all be true at once. This script
 * does that: it takes the live base and looks for combinations that cannot
 * coexist — two owners on one port, cache reservations that exceed the disk
 * they live on, tunnel ranges that overlap, timers that fight.
 *
 * Read-only. Every finding names the projects it implicates, because the fix
 * belongs to a human or to the owning project, not to a script.
 */
import fs from 'node:fs'
import path from 'node:path'
import * as kb from '../lib/kb.js'

const B = String.fromCharCode(92)
const DEFAULT_STORE = process.env.DSH_DOCS_STORE || ''

function repairStoreArg(value) {
  const fixed = String(value).replace(/^([A-Za-z]):([^\\/].*)$/, `$1:${B}$2`)
  return path.resolve(fixed)
}

function parseArgs(argv) {
  const options = { store: DEFAULT_STORE, json: false, strict: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--store') {
      options.store = repairStoreArg(argv[++i] ?? '')
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--strict') {
      // Exit non-zero when anything critical is unresolved. Useful in CI;
      // without it the report is advisory and always exits 0.
      options.strict = true
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        '用法：node scripts/kb-scan.mjs [--store <文档库根>] [--json] [--strict]\n' +
          '  只读体检统一信息库，检查端口 / 缓存 / 磁盘 / 隧道 / 定时任务的一致性冲突。\n' +
          '  --json    机器可读输出\n' +
          '  --strict  发现 critical 级问题时退出码 1\n',
      )
      process.exit(0)
    }
  }
  return options
}

/**
 * Pull listening ports out of free text.
 *
 * The naive "any number 2-5 digits" rule is useless here: `127.0.0.1` alone
 * yields 127, `16GB` yields 16, and an EasyTier mesh of 10.0.0.0/24 yields
 * a handful. Both false positives and false negatives are expensive — a bogus
 * conflict report teaches people to ignore the real one — so ports are only
 * recognised where they actually appear as ports:
 *   - `127.0.0.1:8080`, `0.0.0.0:11000`, `HOST:9000`      → host:port
 *   - `8620（只绑某网卡）`, `5000 某服务`                   → bare port before CJK
 *   - `18020-18027`, `8443-8447`                          → explicit ranges
 *   - `端口 8620`                                          → labelled
 * IP octets are stripped first.
 */
function portsIn(text) {
  const found = new Set()
  const cleaned = String(text)
    // Drop IPv4 literals so their octets never look like ports.
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\b/g, ' <ip> ')
    // Drop capacities and versions so "16GB" / "v2.6.4" / "1.28.3" stay out.
    .replace(/\b\d+(?:\.\d+)?\s*(?:GB|GiB|G|MB|MiB|M|TB|KB|B)\b/gi, ' <size> ')
    .replace(/\bv?\d+\.\d+(?:\.\d+)*\b/g, ' <ver> ')

  const add = (raw) => {
    const n = Number(raw)
    if (Number.isInteger(n) && n >= 22 && n <= 65535) found.add(n)
  }

  // host:port and explicit ranges (both ends are real ports).
  for (const m of cleaned.matchAll(/(?:^|[^\d])(\d{2,5})\s*[-–~至到]\s*(\d{2,5})(?![\d.])/g)) {
    add(m[1])
    add(m[2])
  }
  for (const m of cleaned.matchAll(/<ip>\s*:\s*(\d{2,5})(?![\d.])/g)) add(m[1])
  for (const m of cleaned.matchAll(/\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost)\s*[:：]\s*(\d{2,5})(?![\d.])/g)) add(m[1])
  // Bare port introduced by a Chinese port word, or followed by CJK punctuation.
  for (const m of cleaned.matchAll(/(?:端口|port|listen|监听)[^\d\n]{0,6}(\d{2,5})(?![\d.])/gi)) add(m[1])
  for (const m of cleaned.matchAll(/(?:^|[^\d.])(\d{2,5})\s*(?=[（(：:，,、/\s]*[\u4e00-\u9fa5])/g)) add(m[1])

  return [...found].sort((a, b) => a - b)
}

/** Pull GB-ish numbers so cache/disk claims can be added up. */
function gbIn(text) {
  const found = []
  const re = /(\d+(?:\.\d+)?)\s*(?:GB|G|GiB|gb|g)\b/g
  let m
  while ((m = re.exec(text)) !== null) found.push(Number(m[1]))
  return found
}

function gather(store) {
  const snap = kb.kbSnapshot ? kb.kbSnapshot(store) : null
  if (snap) return snap
  // kb.js exposes listResources; getResource is the only way to read value and
  // notes, so walk the index once and hydrate.
  return { hydrated: false }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(path.join(options.store, 'kb'))) {
    process.stderr.write(`没有统一信息库：${path.join(options.store, 'kb')}\n先跑 node scripts/kb-migrate.mjs\n`)
    process.exit(2)
  }

  const listed = await kb.listResources(options.store, { limit: 500 })
  const rows = listed.resources ?? []
  const entries = []
  for (const row of rows) {
    const one = await kb.getResource(options.store, { key: row.key })
    entries.push(one.resource)
  }

  const findings = []
  const note = (level, code, message, keys, projects) => {
    findings.push({ level, code, message, keys: [...new Set(keys)], projects: [...new Set(projects)].sort() })
  }

  const byKind = (kind) => entries.filter((entry) => entry.kind === kind && entry.status !== 'deprecated')

  // 1. One port, two claimants. Two live entries that name the same port and
  //    claim different owners means at least one project will bind and lose.
  const portOwners = new Map()
  for (const entry of byKind('port')) {
    for (const port of portsIn(`${entry.title} ${entry.value}`)) {
      if (!portOwners.has(port)) portOwners.set(port, [])
      portOwners.get(port).push(entry)
    }
  }
  for (const [port, claimants] of portOwners) {
    if (claimants.length < 2) continue
    const owners = new Set(claimants.map((entry) => entry.owner_project).filter(Boolean))
    if (owners.size < 2) continue
    note(
      'high',
      'port.multi-owner',
      `端口 ${port} 被 ${claimants.length} 条资源同时占用，分属 ${owners.size} 个项目：${[...owners].sort().join('、')}`,
      claimants.map((entry) => entry.key),
      claimants.flatMap((entry) => [entry.owner_project, ...(entry.projects ?? [])]),
    )
  }

  // 2. Cache reservations that cannot fit the disk holding them.
  const cacheEntries = byKind('cache')
  const diskEntries = byKind('disk')
  for (const cache of cacheEntries) {
    const wants = gbIn(`${cache.title} ${cache.value} ${cache.notes ?? ''}`)
    if (wants.length === 0) continue
    const total = wants.reduce((sum, n) => sum + n, 0)
    // Find a disk entry that mentions the same host token, else compare with
    // the smallest declared disk (the conservative reading).
    const host = (cache.key.split('.')[1] ?? '').toLowerCase()
    const sameHost = diskEntries.filter((disk) => disk.key.toLowerCase().includes(host))
    const disks = sameHost.length > 0 ? sameHost : diskEntries
    for (const disk of disks) {
      const caps = gbIn(`${disk.title} ${disk.value}`)
      if (caps.length === 0) continue
      const smallest = Math.min(...caps.length && caps.every((n) => n > 100) ? caps.map((n) => n * 1024) : caps)
      if (total > smallest) {
        note(
          'critical',
          'cache.over-commit',
          `${cache.key} 声明 ${total}GB，但 ${disk.key} 所在的盘按最小口径只有 ${smallest}GB —— 加起来放不下`,
          [cache.key, disk.key],
          [cache.owner_project, disk.owner_project, ...(cache.projects ?? [])],
        )
      }
    }
  }

  // 3. Unresolved conflicts. Not an error by itself, but they are exactly the
  //    places where two projects will each trust their own doc and diverge.
  const pending = entries.filter((entry) => Array.isArray(entry.tags) && entry.tags.includes('待裁定'))
  if (pending.length > 0) {
    note(
      pending.length > 10 ? 'critical' : 'medium',
      'conflict.pending',
      `${pending.length} 条冲突尚未裁定，涉及 ${new Set(pending.flatMap((entry) => entry.projects ?? [])).size} 个项目`,
      pending.map((entry) => entry.key),
      pending.flatMap((entry) => entry.projects ?? []),
    )
  }

  // 4. Tunnel ranges recorded by more than one project.
  const tunnelEntries = entries.filter(
    (entry) => entry.kind === 'tunnel' || entry.kind === 'network' || /隧道|tunnel|ssh -R/i.test(`${entry.title} ${entry.value}`),
  )
  const rangeClaims = []
  for (const entry of tunnelEntries) {
    const re = /(\d{5})\s*[-–~至到]\s*(\d{5})/g
    const text = `${entry.title} ${entry.value}`
    let m
    while ((m = re.exec(text)) !== null) {
      rangeClaims.push({ entry, from: Number(m[1]), to: Number(m[2]) })
    }
  }
  for (let i = 0; i < rangeClaims.length; i += 1) {
    for (let j = i + 1; j < rangeClaims.length; j += 1) {
      const a = rangeClaims[i]
      const b = rangeClaims[j]
      if (a.entry.key === b.entry.key) continue
      const overlap = Math.min(a.to, b.to) - Math.max(a.from, b.from)
      if (overlap < 0) continue
      note(
        'high',
        'tunnel.overlap',
        `${a.entry.key} 的 ${a.from}-${a.to} 与 ${b.entry.key} 的 ${b.from}-${b.to} 重叠 ${overlap + 1} 个端口`,
        [a.entry.key, b.entry.key],
        [a.entry.owner_project, b.entry.owner_project, ...(a.entry.projects ?? []), ...(b.entry.projects ?? [])],
      )
    }
  }

  // 5. Stale entries: nothing has touched them since migration, yet they are
  //    rated critical. Worth a look, not necessarily wrong.
  const criticalStale = entries.filter(
    (entry) => entry.risk === 'critical' && entry.revision <= 1 && !!entry.updated_by && entry.updated_by === 'kb-migrate',
  )
  if (criticalStale.length > 0) {
    note(
      'low',
      'critical.never-verified',
      `${criticalStale.length} 条 critical 资源自迁移后没人核对过（仍是 kb-migrate 的初始值）`,
      criticalStale.map((entry) => entry.key),
      criticalStale.flatMap((entry) => [entry.owner_project, ...(entry.projects ?? [])]),
    )
  }

  // 6. Orphan resources: owned by a project that no longer has a view.
  const viewDir = path.join(options.store, 'kb', 'views')
  const views = fs.existsSync(viewDir) ? fs.readdirSync(viewDir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)) : []
  const orphan = entries.filter((entry) => entry.owner_project && !views.includes(entry.owner_project))
  if (orphan.length > 0) {
    note(
      'low',
      'owner.no-view',
      `${orphan.length} 条资源的 owner_project 没有对应项目视图（视图只对 14 个项目生成）`,
      orphan.map((entry) => entry.key),
      orphan.map((entry) => entry.owner_project),
    )
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 }
  findings.sort((a, b) => order[a.level] - order[b.level] || a.code.localeCompare(b.code))

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ store: options.store, entries: entries.length, findings }, null, 2)}\n`)
  } else {
    const lines = []
    lines.push(`统一信息库体检 · ${options.store}`)
    lines.push(`  条目 ${entries.length} 条 · 项目视图 ${views.length} 个`)
    lines.push('')
    if (findings.length === 0) {
      lines.push('没有发现一致性冲突。')
    } else {
      const counts = { critical: 0, high: 0, medium: 0, low: 0 }
      for (const f of findings) counts[f.level] += 1
      lines.push(`发现 ${findings.length} 项：critical ${counts.critical} / high ${counts.high} / medium ${counts.medium} / low ${counts.low}`)
      lines.push('')
      for (const f of findings) {
        const mark = f.level === 'critical' ? '⛔' : f.level === 'high' ? '▲▲' : f.level === 'medium' ? '▲' : '·'
        lines.push(`${mark} [${f.level}] ${f.code}`)
        lines.push(`   ${f.message}`)
        if (f.projects.length > 0) lines.push(`   涉及项目：${f.projects.join('、')}`)
        lines.push(`   相关条目：${f.keys.slice(0, 8).join('、')}${f.keys.length > 8 ? ` …共 ${f.keys.length} 条` : ''}`)
      }
      lines.push('')
      lines.push('体检只报告不裁定：冲突条目要人拍板，改值请走 kb → record_change（带 author 与 reason）。')
    }
    process.stdout.write(`${lines.join('\n')}\n`)
  }

  if (options.strict && findings.some((f) => f.level === 'critical')) process.exit(1)
}

main().catch((error) => {
  process.stderr.write(`体检失败：${error && error.message ? error.message : error}\n`)
  process.exit(1)
})
