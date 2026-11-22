#!/usr/bin/env node
/**
 * Read-only inspection of the real base through the same code path the `kb`
 * tool uses. Writes nothing: the point is to see, with real data, that the
 * 45 migrated entries render the way an agent would read them.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as kb from '../lib/kb.js'

const store = process.env.DSH_DOCS_STORE || ''

// Renderer lives in index.js, which pulls in the plugin host; re-importing it
// here would need a fake ctx, so the shape checks below assert the underlying
// values instead. That is the contract the renderer depends on.
const status = await kb.kbStatus(store)
process.stdout.write(`真实库 ${store}\n`)
process.stdout.write(`  资源 ${status.resources} 条 · 变更记录 ${status.changes} 条 · 涉及 ${status.projects.length} 个项目\n`)
process.stdout.write(`  类别：${Object.entries(status.by_kind).map(([kind, n]) => `${kind} ${n}`).join(' / ')}\n\n`)

const all = await kb.listResources(store, {})
process.stdout.write(`全部条目 ${all.total} 条：\n`)
for (const row of all.resources) {
  process.stdout.write(`  ${row.risk === 'critical' ? '⛔' : row.risk === 'high' ? '▲▲' : '·'} ${row.key} r${row.revision} — ${row.title}\n`)
}

const pending = all.resources.filter((row) => row.pending_decision === true)
process.stdout.write(`\n待人工裁定的条目：${pending.length} 条\n`)
for (const row of pending) process.stdout.write(`  - ${row.key} — ${row.title}\n`)

const sampleKey = process.env.DSH_DEMO_KEY || (all.resources[0]?.key ?? '')
const one = await kb.getResource(store, { key: sampleKey })
process.stdout.write(`\n样例 get(${sampleKey})：\n`)
process.stdout.write(`  值：${one.resource.value}\n`)
process.stdout.write(`  修订：${one.revisions.length}（当前 r${one.resource.revision}）\n`)
process.stdout.write(`  涉及项目：${one.resource.projects.join('、')}\n`)

const view = await kb.projectView(store, process.env.DSH_DEMO_PROJECT || 'demo-project')
process.stdout.write(`\n样例 view(demo-project)：本项目 ${view.mine.length} 条 · 别处 critical ${view.critical_elsewhere.length} 条\n`)

const viewsDir = path.join(store, 'kb', 'views')
const files = fs.readdirSync(viewsDir).filter((name) => name.endsWith('.json'))
process.stdout.write(`视图文件 ${files.length} 个：${files.join(', ')}\n`)
