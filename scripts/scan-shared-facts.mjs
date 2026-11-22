/**
 * Scan a project-docs store for shared-infrastructure evidence.
 *
 * Read-only inventory helper: walks every project's documents and counts how
 * often resource-bearing terms appear, so a unified knowledge base can be built
 * from real occurrences instead of guesses.
 *
 * The store location and the term list both come from the caller: this file is
 * published, so it must not carry anyone's real hosts, ports or IPs.
 *
 * Usage:
 *   node scripts/scan-shared-facts.mjs <storeDir> [termsFile]
 *
 * `termsFile` is an optional JSON array of strings to count. Without it the
 * script uses a generic list below that contains no deployment-specific values.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

const storeDir = process.argv[2] === undefined ? '' : path.resolve(process.argv[2])
if (storeDir === '') {
  process.stderr.write('用法: node scripts/scan-shared-facts.mjs <storeDir> [termsFile]\n')
  process.exit(2)
}

/** Generic resource words. No hostnames, no port numbers, no site names. */
const DEFAULT_TERMS = [
  '端口', '127.0.0.1', 'localhost', 'VPS', '服务器', '主机',
  '缓存', '磁盘', '内存', '空间',
  '计划任务', 'systemd', 'cron', '定时',
  '隧道', 'ssh -R', 'nginx', '反代', '反向代理',
  '组网', '数据库', 'sqlite', '环境变量', '版本',
]

const termsFile = process.argv[3]
const TERMS = termsFile === undefined
  ? DEFAULT_TERMS
  : JSON.parse(await fs.readFile(path.resolve(termsFile), 'utf8'))

async function listMd(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const out = []
    for (const entry of entries) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
      const file = path.join(dir, entry.name)
      out.push({ name: entry.name, file, text: await fs.readFile(file, 'utf8') })
    }
    return out
  } catch {
    return []
  }
}

async function main() {
  const projectsRoot = path.join(storeDir, 'projects')
  const projects = (await fs.readdir(projectsRoot, { withFileTypes: true })).filter((e) => e.isDirectory())
  const perProject = new Map()
  const termProjects = new Map(TERMS.map((t) => [t, new Set()]))
  const termHits = new Map(TERMS.map((t) => [t, 0]))

  for (const project of projects) {
    const id = project.name
    const docs = [
      ...(await listMd(path.join(projectsRoot, id, 'docs', 'project'))),
      ...(await listMd(path.join(projectsRoot, id, 'docs', 'collab'))),
    ]
    perProject.set(id, docs.length)
    for (const doc of docs) {
      for (const term of TERMS) {
        const count = doc.text.split(term).length - 1
        if (count > 0) {
          termHits.set(term, termHits.get(term) + count)
          termProjects.get(term).add(id)
        }
      }
    }
  }

  const rows = TERMS.map((term) => ({
    term,
    hits: termHits.get(term),
    projects: termProjects.get(term).size,
    which: [...termProjects.get(term)].sort().join(', '),
  }))
    .filter((row) => row.hits > 0)
    .sort((a, b) => b.projects - a.projects || b.hits - a.hits)

  console.log(`storeDir: ${storeDir}`)
  console.log(`projects: ${projects.length}, docs scanned: ${[...perProject.values()].reduce((a, b) => a + b, 0)}`)
  console.log('')
  console.log('term\tprojects\thits\twhere')
  for (const row of rows) console.log(`${row.term}\t${row.projects}\t${row.hits}\t${row.which}`)
}

await main()
