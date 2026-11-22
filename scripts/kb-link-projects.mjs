#!/usr/bin/env node
/**
 * Insert a pointer to the unified knowledge base into every project's
 * COLLAB.md, right after the H1.
 *
 * Why after the H1 and not at the end: an agent reads the top of COLLAB.md and
 * then starts working. A pointer at the bottom is a pointer nobody sees. Why
 * one generated block instead of hand-written prose per project: the text is
 * about a mechanism, not about any one project, and identical wording means an
 * agent recognises it as the same rule everywhere.
 *
 * Idempotent: the block is fenced by marker comments, so re-running rewrites
 * it in place instead of stacking copies.
 */
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_STORE = process.env.DSH_DOCS_STORE || ''

const BEGIN = '<!-- kb-pointer:begin -->'
const END = '<!-- kb-pointer:end -->'

function parseArgs(argv) {
  const options = { store: DEFAULT_STORE, write: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--store') {
      options.store = path.resolve(String(argv[++i] ?? '').replace(/^([A-Za-z]):([^\\/].*)$/, `$1:${B}$2`))
    } else if (arg === '--write') {
      options.write = true
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        '用法：node scripts/kb-link-projects.mjs [--store <文档库根>] [--write]\n' +
          '  给每个项目的 COLLAB.md 顶部插入统一信息库指针（默认只预览）。\n' +
          '  --write  真正写入\n',
      )
      process.exit(0)
    }
  }
  return options
}

function pointerBlock(projectId, hasView) {
  const viewHint = hasView
    ? `本项目视图：\`.dsh-docs/kb/views/${projectId}.json\``
    : `本项目暂无视图（视图只对迁移时登记过的项目生成）`
  return [
    BEGIN,
    '> **统一信息库（跨项目共享资源）**：VPS、端口、缓存上限、磁盘配额、隧道池、计划任务这类资源**只有一个真相源**，',
    '> 不在本项目文档里，在 `.dsh-docs/kb/`。动手改任何共享资源之前先 `kb` → `view`（看本项目视角）或 `get`（看单条当前值）；',
    `> 改完必须 \`kb\` → \`record_change\`（带 author + reason ≥ 8 字 + projects）；每完成一个阶段必须 \`kb\` → \`audit\`，否则 \`gate\` 不放行。`,
    '> 两个项目说法不一致时**不要自行择一**，那是待人工裁定的条目，报给人类。',
    `> ${viewHint}`,
    END,
  ].join('\n')
}

function upsert(text, block) {
  const start = text.indexOf(BEGIN)
  if (start !== -1) {
    const stop = text.indexOf(END, start)
    if (stop !== -1) {
      return { text: `${text.slice(0, start)}${block}${text.slice(stop + END.length)}`, mode: 'updated' }
    }
  }
  // Insert after the first H1 line; fall back to the very top.
  const lines = text.split('\n')
  const h1 = lines.findIndex((line) => /^#\s+/.test(line))
  if (h1 === -1) return { text: `${block}\n\n${text}`, mode: 'prepended' }
  const before = lines.slice(0, h1 + 1).join('\n')
  const after = lines.slice(h1 + 1).join('\n')
  return { text: `${before}\n\n${block}\n${after}`, mode: 'inserted' }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const projectsDir = path.join(options.store, 'projects')
  if (!fs.existsSync(projectsDir)) {
    process.stderr.write(`没有项目目录：${projectsDir}\n`)
    process.exit(2)
  }
  const viewDir = path.join(options.store, 'kb', 'views')
  const views = fs.existsSync(viewDir) ? new Set(fs.readdirSync(viewDir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5))) : new Set()

  const report = []
  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const id = entry.name
    const file = path.join(projectsDir, id, 'docs', 'collab', 'COLLAB.md')
    const block = pointerBlock(id, views.has(id))
    if (!fs.existsSync(file)) {
      report.push({ id, mode: 'no-collab', created: false })
      if (!options.write) continue
      // A project without COLLAB.md is exactly the project whose agents read
      // nothing before acting, so create the file with the pointer rather than
      // leaving it out of the loop.
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `# ${id} 合作文档\n\n${block}\n`, 'utf8')
      report[report.length - 1] = { id, mode: 'created', created: true }
      continue
    }
    const original = fs.readFileSync(file, 'utf8')
    const { text, mode } = upsert(original, block)
    if (text === original) {
      report.push({ id, mode: 'unchanged' })
      continue
    }
    if (options.write) {
      // Write via temp + rename (the same durability rule the plugin follows),
      // so a crash mid-write cannot truncate an existing COLLAB.md.
      const tmp = `${file}.kb-tmp-${process.pid}`
      fs.writeFileSync(tmp, text, 'utf8')
      fs.renameSync(tmp, file)
    }
    report.push({ id, mode, created: false })
  }

  const label = options.write ? '已写入' : '预览（未写盘，加 --write 生效）'
  process.stdout.write(`统一信息库指针 · ${label}\n`)
  for (const row of report) process.stdout.write(`  ${row.id.padEnd(24)} ${row.mode}\n`)
  const changed = report.filter((row) => row.mode !== 'unchanged').length
  process.stdout.write(`\n共 ${report.length} 个项目，${changed} 个需要变更。\n`)
}

main()
