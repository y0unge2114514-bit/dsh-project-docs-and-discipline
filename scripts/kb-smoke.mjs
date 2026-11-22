#!/usr/bin/env node
/**
 * Smoke-test the unified base against the real store (read-only by default).
 *
 * The migration already proved that `kb.js` writes; this script proves that the
 * same calls the `kb` tool makes return what the renderer expects. It runs in a
 * throwaway temp store so a smoke run can never touch the real base — the one
 * thing worse than a broken tool is a test that silently rewrites production
 * history.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as kb from '../lib/kb.js'

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    process.stdout.write(`  ✓ ${name}\n`)
  } else {
    failed += 1
    process.stdout.write(`  ✗ ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
  }
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-smoke-'))

try {
  process.stdout.write('统一信息库 · 工具层冒烟（临时库，不碰真实数据）\n\n')

  await kb.ensureKbDirs(temp)

  // 1. The example from the brief: A sets the cache to 40G, B claims 5GB.
  process.stdout.write('[用户案例] A 设 40G → B 划 5GB → 库里应只剩 35G 且留痕\n')
  const created = await kb.createResource(temp, {
    key: 'cache.vps.shared',
    title: 'VPS 共享缓存上限',
    kind: 'cache',
    value: '40G',
    risk: 'critical',
    owner_project: 'A',
    author: 'agent-a',
    reason: 'A 项目建立共享缓存基线 40G',
    sources: ['A / DEPLOY.md: cache 40G'],
    projects: ['A'],
    tags: ['缓存'],
  })
  check('create_resource 返回 r1', created.revision === 1, JSON.stringify(created.revision))

  const changed = await kb.recordChange(temp, {
    key: 'cache.vps.shared',
    value: '35G 已分配，其中 B 项目 5GB',
    author: 'agent-b',
    reason: 'B 项目需要划分 5GB 缓存，剩余 35GB 归公共池',
    projects: ['B'],
    expect_revision: 1,
  })
  check('record_change 升到 r2', changed.revision === 2, JSON.stringify(changed.revision))
  check('before 原样保留 40G', changed.before && changed.before.value === '40G', JSON.stringify(changed.before))

  const read = await kb.getResource(temp, { key: 'cache.vps.shared' })
  check('当前值已变成 35G', read.resource.value.includes('35G'), read.resource.value)
  check('历史有 2 条修订', read.revisions.length === 2, String(read.revisions.length))
  check('作者留痕是 agent-b', read.resource.updated_by === 'agent-b', read.resource.updated_by)

  // 2. The reason rule is the whole enforcement mechanism; it must be harsh.
  process.stdout.write('\n[强制留痕] 缺作者 / 原因过短 / 无改动 都必须被拒\n')
  let rejected = ''
  try {
    await kb.recordChange(temp, { key: 'cache.vps.shared', value: '30G', author: 'agent-c', reason: '改小', projects: ['C'] })
  } catch (error) {
    rejected = error.code ?? error.message
  }
  check('原因过短被拒', rejected === 'invalid_input', rejected)

  rejected = ''
  try {
    await kb.recordChange(temp, { key: 'cache.vps.shared', author: 'agent-c', reason: '只是想写条备注但什么都没改' })
  } catch (error) {
    rejected = error.code ?? error.message
  }
  check('无任何字段变化被拒', rejected === 'invalid_input', rejected)

  // 3. Optimistic locking: a stale revision must not silently win.
  process.stdout.write('\n[并发] 过期修订号必须被拒绝\n')
  rejected = ''
  try {
    await kb.recordChange(temp, {
      key: 'cache.vps.shared',
      value: '20G',
      author: 'agent-d',
      reason: '基于旧修订号覆盖，应该被拦住',
      expect_revision: 1,
    })
  } catch (error) {
    rejected = error.code ?? error.message
  }
  check('修订号不匹配被拒', rejected === 'revision_conflict', rejected)

  // 4. The gate: an agent that never looked at the slice is refused.
  process.stdout.write('\n[强制阶段更新] 未核对 → 门禁拒绝；核对后 → 放行\n')
  const beforeGate = await kb.gateStatus(temp, { author: 'agent-e' })
  check('没核对时门禁不通过', beforeGate.ok === false, JSON.stringify(beforeGate.ok))

  await kb.auditSlice(temp, { author: 'agent-e', stage: '阶段一：读完共享缓存与端口约定' })
  const afterGate = await kb.gateStatus(temp, { author: 'agent-e' })
  check('核对后门禁通过', afterGate.ok === true, JSON.stringify(afterGate.uncovered))

  // 5. Someone else changing the value invalidates an existing audit — this is
  //    the "40G is now stale" protection, so it has to be tested explicitly.
  process.stdout.write('\n[失效] 别人改了值之后，先前的核对必须失效\n')
  await kb.recordChange(temp, {
    key: 'cache.vps.shared',
    value: '30G 已分配，其中 C 项目 5GB',
    author: 'agent-c',
    reason: 'C 项目再划 5GB，剩余 30GB',
    projects: ['C'],
  })
  const staleGate = await kb.gateStatus(temp, { author: 'agent-e' })
  check('旧核对已失效', staleGate.ok === false, JSON.stringify(staleGate.ok))

  // 6. Listing and per-project views are what agents actually read.
  process.stdout.write('\n[读取] list / view 要能按项目与关键词命中\n')
  const listed = await kb.listResources(temp, { query: '缓存' })
  check('按关键词命中', listed.total >= 1, String(listed.total))
  const viewB = await kb.projectView(temp, 'B')
  check('B 视图能看到缓存条目', viewB.mine.some((row) => row.key === 'cache.vps.shared'), String(viewB.mine.length))
  check('B 视图带上当前值', viewB.mine[0] && typeof viewB.mine[0].value === 'string')

  const written = await kb.refreshAllViews(temp, ['A', 'B'])
  check('视图文件已落盘', written.length === 2 && fs.existsSync(written[0]), String(written.length))

  const status = await kb.kbStatus(temp)
  check('status 有资源计数', status.resources === 1, String(status.resources))
  check('status 有变更记录计数', status.changes >= 4, String(status.changes))

  process.stdout.write(`\n结果：${passed} passed, ${failed} failed\n`)
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}

process.exit(failed === 0 ? 0 : 1)
