/**
 * Migrate the shared facts found across the 18 project document sets into the
 * unified knowledge base, and register every unresolved contradiction as its own
 * resource so that no agent inherits one side of it by accident.
 *
 * Contract of this script:
 *   - IDEMPOTENT: re-running never overwrites a resource that already exists and
 *     has a history. It reports `skipped` for those. Re-running after a human has
 *     edited a value in the base must NOT clobber that edit — that is the whole
 *     point of "版本控制 + 留痕".
 *   - LOUD: prints how many were created / skipped / conflicting / errored, and
 *     exits non-zero on any error so CI-style checks notice.
 *   - TRACEABLE: every write carries author `kb-migrate` and a reason naming this
 *     migration, so the CHANGELOG shows where the initial value came from.
 *
 * Usage:
 *   node scripts/kb-migrate.mjs                # against the real document store
 *   node scripts/kb-migrate.mjs --dry-run      # report only, write nothing
 *   node scripts/kb-migrate.mjs --store <dir>  # explicit store root
 */

import path from 'node:path'
import process from 'node:process'
import {
  ensureKbDirs,
  createResource,
  getResource,
  listResources,
  refreshAllViews,
  kbPaths,
} from '../lib/kb.js'
import { RESOURCES, CONFLICTS, MIGRATION_AUTHOR } from './kb-seed.mjs'

const B = String.fromCharCode(92)

/**
 * Build the default document-store root without depending on backslash escaping.
 *
 * Three separate debugging rounds were lost to this: a literal Windows path
 * arrives at runtime in the "drive-relative" form (`D:dir\\sub`), gets resolved
 * against the process cwd — and the migration reports success while writing
 * nowhere visible. The store now comes from the environment, and the repair
 * helper below still guards a caller-supplied path that lost its separators.
 */
const DEFAULT_STORE = process.env.DSH_DOCS_STORE || ''

function parseArgs(argv) {
  const out = { dryRun: false, store: DEFAULT_STORE }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--store') {
      out.store = argv[i + 1]
      i += 1
    } else if (a === '--help' || a === '-h') {
      out.help = true
    }
  }
  return out
}

const USAGE = `kb-migrate — 把 18 个项目文档里的共享事实灌入统一信息库

  node scripts/kb-migrate.mjs [--dry-run] [--store <文档库根>]

默认文档库根：${DEFAULT_STORE}
--dry-run 只报告不写盘
`

/**
 * Repair a Windows path that lost its backslashes.
 *
 * `path.resolve('D:work.docs')` does NOT fail loudly: Windows reads
 * `D:foo` as "drive D:, relative path foo", so Node resolves it against the
 * process cwd and the whole knowledge base lands somewhere invisible.
 * This bit the migration once already; the repair is one regex, so do it always.
 */
function repairStoreArg(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') throw new Error('缺少文档库根（--store）')
  const driveRelative = /^([A-Za-z]):([^\\/].*)$/.exec(raw)
  return driveRelative === null ? raw : `${driveRelative[1]}:${B}${driveRelative[2]}`
}

/** Turn a conflict record into a resource entry whose value is deliberately "未裁定". */
function conflictToResource(c) {
  return {
    key: c.key,
    kind: 'other',
    title: c.title,
    value: `【冲突未裁定·待人工裁定】${c.summary}`,
    risk: 'high',
    status: 'active',
    owner_project: (c.projects && c.projects[0]) || 'workspace',
    projects: c.projects || [],
    notes:
      '这条不是「某个值」，而是「两份项目文档互相矛盾且无人裁定」。'
      + '统一库里保留冲突本身，是为了让读到它的 agent 知道不能凭运气选一边。'
      + '裁定方式：确认真相后 kb_record_change 把 value 改成确定值，reason 里写清依据哪个来源，本条即从冲突转为事实。',
    sources: c.sources || [],
    tags: ['conflict', '待裁定'],
  }
}

function makeReason(entry, origin) {
  const src = (entry.sources || []).slice(0, 3).join('；')
  return (
    `统一信息库迁移（${origin}）：从项目文档抽取共享事实并归档，避免各项目重复记录同一资源。来源：${src || '项目文档汇总'}`
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const store = repairStoreArg(args.store)
  const paths = kbPaths(store)
  process.stdout.write(`文档库根：${store}\n知识库目录：${paths.root}\n`)
  if (args.dryRun) process.stdout.write('模式：DRY RUN（不写盘）\n')
  process.stdout.write('\n')

  if (!args.dryRun) ensureKbDirs(store)

  const existing = new Set()
  try {
    const listed = await listResources(store, { limit: 5000 })
    // kb.js returns `{ resources: [...] }`; reading `.items` here silently yielded
    // an empty set, so every re-run tried to re-create every key and reported 45
    // failures while the first run's data was already correct on disk.
    const items = Array.isArray(listed) ? listed : (listed && listed.resources) || []
    for (const it of items) existing.add(it.key)
  } catch {
    /* 空库 */
  }
  process.stdout.write(`已有条目：${existing.size}\n\n`)

  const report = { created: [], skipped: [], conflictCreated: [], conflictSkipped: [], errors: [] }

  /**
   * Shared write path for both lists.
   *
   * `await` on createResource is load-bearing: without it the loop fires 23
   * concurrent O_EXCL lock acquisitions and one write removes another's lock —
   * the run then prints "已创建" for every entry while the store stays empty.
   */
  const walk = async (entries, origin, bucketCreated, bucketSkipped) => {
    for (const entry of entries) {
      const label = `${entry.key}  ${entry.title || ''}`
      if (existing.has(entry.key)) {
        bucketSkipped.push(entry.key)
        process.stdout.write(`  跳过（已存在，保留现有人工修订）  ${label}\n`)
        continue
      }
      if (args.dryRun) {
        bucketCreated.push(entry.key)
        process.stdout.write(`  将创建  ${label}\n`)
        continue
      }
      try {
        await createResource(store, {
          ...entry,
          author: MIGRATION_AUTHOR,
          reason: makeReason(entry, origin),
        })
        bucketCreated.push(entry.key)
        process.stdout.write(`  已创建  ${label}\n`)
      } catch (error) {
        report.errors.push({ key: entry.key, message: error && error.message ? error.message : String(error) })
        process.stdout.write(`  ✗ 失败  ${label}  → ${error && error.message}\n`)
      }
    }
  }

  process.stdout.write(`== 共享资源（${RESOURCES.length} 条）==\n`)
  await walk(RESOURCES, '共享资源', report.created, report.skipped)

  process.stdout.write(`\n== 未裁定冲突（${CONFLICTS.length} 条，按「冲突即事实」入库）==\n`)
  await walk(CONFLICTS.map(conflictToResource), '冲突登记', report.conflictCreated, report.conflictSkipped)

  let viewReport = null
  if (!args.dryRun) {
    // Views let each project read "my stuff + everything critical that is not mine"
    // without having to know the key namespace.
    try {
      const projects = new Set()
      for (const r of RESOURCES) for (const p of r.projects || []) projects.add(p)
      for (const c of CONFLICTS) for (const p of c.projects || []) projects.add(p)
      viewReport = await refreshAllViews(store, [...projects].sort())
    } catch (error) {
      report.errors.push({ key: '<views>', message: error && error.message ? error.message : String(error) })
    }
  }

  process.stdout.write('\n== 迁移报告 ==\n')
  process.stdout.write(`  共享资源  新建 ${report.created.length} / 跳过 ${report.skipped.length}\n`)
  process.stdout.write(`  冲突登记  新建 ${report.conflictCreated.length} / 跳过 ${report.conflictSkipped.length}\n`)
  if (viewReport) {
    const wrote = Array.isArray(viewReport) ? viewReport.length : (viewReport.written || []).length || 0
    process.stdout.write(`  项目视图  已刷新 ${wrote} 个\n`)
  }
  if (report.errors.length) {
    process.stdout.write(`  ✗ 错误 ${report.errors.length} 条：\n`)
    for (const e of report.errors) process.stdout.write(`      ${e.key}: ${e.message}\n`)
    return 1
  }
  process.stdout.write('\n下一步：node scripts/kb-scan.mjs 做跨项目一致性体检；README 见知识库工具说明。\n')
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`迁移失败：${error && error.stack ? error.stack : error}\n`)
    process.exit(1)
  })
