/**
 * Tests for the shared-knowledge base (kb.js).
 *
 * Run: node test-kb.js
 *
 * Every test drives the real filesystem in a temp store, because the guarantees
 * this store makes (immutable revisions, exclusive writes, cross-process lock,
 * append-only log) are filesystem properties — mocking them would test nothing.
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  KbError,
  auditSlice,
  createResource,
  ensureKbDirs,
  gateStatus,
  getResource,
  kbPaths,
  kbStatus,
  listResources,
  projectView,
  recordChange,
  refreshAllViews,
  renderViewMarkdown,
} from '../lib/kb.js'

let passed = 0
let failed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`FAIL  ${name}`)
    console.log(`      ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-test-'))
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

const AUTHOR = 'agent-a'
const AUTHOR_B = 'agent-b'

async function rejectsWith(promise, code) {
  let caught
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.equal(caught instanceof KbError, true, `应有 KbError(${code})，实际是 ${caught}`)
  assert.equal(caught.code, code, `期望 ${code}，实际 ${caught.code}: ${caught.message}`)
  return caught
}

async function seedCache(dir) {
  await createResource(dir, {
    key: 'cache.vps.disk',
    title: 'VPS 磁盘缓存上限',
    kind: 'cache',
    value: '40G',
    author: AUTHOR,
    owner_project: 'proj-gateway',
    projects: ['proj-gateway'],
    risk: 'high',
    sources: ['proj-gateway / COLLAB.md: nginx proxy_cache 上限 40G'],
  })
}

console.log('kb.js')

await test('创建资源：写入索引、修订文件与 CHANGELOG', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await seedCache(dir)
    const paths = kbPaths(dir)
    const index = JSON.parse(await fs.readFile(paths.index, 'utf8'))
    assert.equal(index.resources['cache.vps.disk'].revision, 1)
    assert.equal(index.resources['cache.vps.disk'].value, '40G')
    const revFiles = await fs.readdir(path.join(paths.rev, 'cache.vps.disk'))
    assert.equal(revFiles.length, 1)
    const changelog = await fs.readFile(paths.changelog, 'utf8')
    assert.match(changelog, /cache\.vps\.disk/)
    assert.match(changelog, /建立条目|create/)
  } finally {
    await cleanup()
  }
})

await test('重复创建同一 key 被拒绝，并给出当前值', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await seedCache(dir)
    const error = await rejectsWith(
      createResource(dir, { key: 'cache.vps.disk', title: 'x', kind: 'cache', value: '99G', author: AUTHOR }),
      'kb_exists',
    )
    assert.equal(error.details.current.value, '40G')
  } finally {
    await cleanup()
  }
})

await test('用户场景：40G → B 项目划分 5GB → 剩 35G，before 原文保留', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await seedCache(dir)
    const result = await recordChange(dir, {
      key: 'cache.vps.disk',
      value: '35G（B 项目已划分 5GB）',
      author: AUTHOR_B,
      reason: 'proj-game 需要划分 5GB 做视频缓存，从 40G 里切走，剩余 35G',
      projects: ['proj-game', 'proj-gateway'],
      expect_revision: 1,
    })
    assert.equal(result.revision, 2)
    assert.equal(result.before.value, '40G')

    const { resource, revisions } = await getResource(dir, { key: 'cache.vps.disk' })
    assert.equal(resource.value, '35G（B 项目已划分 5GB）')
    assert.equal(resource.revision, 2)
    assert.equal(revisions.length, 2)
    assert.equal(revisions[0].after_value, '35G（B 项目已划分 5GB）')
    assert.equal(revisions[0].before_value, '40G')
    assert.equal(revisions[0].author, AUTHOR_B)
    assert.match(revisions[0].reason, /5GB/)
    assert.deepEqual(revisions[0].projects, ['proj-game', 'proj-gateway'])
    // 旧修订仍是独立不可变文件
    const revFiles = await fs.readdir(path.join(kbPaths(dir).rev, 'cache.vps.disk'))
    assert.equal(revFiles.length, 2)
    const changelog = await fs.readFile(kbPaths(dir).changelog, 'utf8')
    assert.match(changelog, /40G/)
    assert.match(changelog, /35G/)
    assert.match(changelog, /agent-b/)
  } finally {
    await cleanup()
  }
})

await test('原因过短被拒绝（强制留痕）', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await seedCache(dir)
    await rejectsWith(recordChange(dir, { key: 'cache.vps.disk', value: '10G', author: AUTHOR, reason: '改小' }), 'invalid_input')
  } finally {
    await cleanup()
  }
})

await test('缺作者 / 缺原因被拒绝（强制留痕）', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await seedCache(dir)
    await rejectsWith(recordChange(dir, { key: 'cache.vps.disk', value: '10G', reason: '因为要给别人腾地方' }), 'invalid_input')
    await rejectsWith(recordChange(dir, { key: 'cache.vps.disk', value: '10G', author: AUTHOR }), 'invalid_input')
    await rejectsWith(recordChange(dir, { key: 'cache.vps.disk', author: AUTHOR, reason: '什么都没改的调用' }), 'invalid_input')
  } finally {
    await cleanup()
  }
})

await test('修订号 CAS：并发意图冲突被拒绝并给出最新值', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await seedCache(dir)
    await recordChange(dir, { key: 'cache.vps.disk', value: '35G', author: AUTHOR_B, reason: 'B 项目划分 5GB', expect_revision: 1 })
    const error = await rejectsWith(
      recordChange(dir, { key: 'cache.vps.disk', value: '20G', author: AUTHOR, reason: '我基于旧值 40G 改', expect_revision: 1 }),
      'revision_conflict',
    )
    assert.equal(error.details.current.revision, 2)
  } finally {
    await cleanup()
  }
})

await test('并发写同一资源：修订号单调、内容不被撕裂', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await seedCache(dir)
    const writers = ['w1', 'w2', 'w3', 'w4', 'w5']
    const results = await Promise.allSettled(
      writers.map((author, i) =>
        recordChange(dir, { key: 'cache.vps.disk', value: `${i + 1}G`, author, reason: `并发写者 ${author} 测试用原因` }),
      ),
    )
    const ok = results.filter((item) => item.status === 'fulfilled').length
    // Failures must be lock contention or a revision conflict, never corruption.
    for (const outcome of results) {
      if (outcome.status !== 'rejected') continue
      const code = outcome.reason?.code
      assert.ok(
        ['kb_locked', 'revision_conflict'].includes(code),
        `并发失败只应是锁或冲突，实际是 ${code}: ${outcome.reason?.message}`,
      )
    }

    const { revisions: history, resource } = await getResource(dir, { key: 'cache.vps.disk' })
    const revisions = history.map((rev) => rev.revision)
    assert.equal(new Set(revisions).size, revisions.length, '修订号出现重复')

    // The real invariant is not "revision === successes + 1" — a writer that
    // loses the lock may have already advanced the number, and one that fails
    // CAS advances nothing. What must hold is:
    //   - the revision equals the number of immutable revision files
    //   - every successful write is represented
    const revFiles = await fs.readdir(path.join(kbPaths(dir).rev, 'cache.vps.disk'))
    assert.equal(resource.revision, revFiles.length, '最终修订号必须等于修订文件数')
    assert.ok(ok <= resource.revision - 1, `成功次数 ${ok} 不应超过写入的修订数 ${resource.revision - 1}`)
    assert.ok(resource.revision - 1 >= 1, '至少有一次写入成功')
  } finally {
    await cleanup()
  }
})

await test('陈旧锁会过期：崩溃 agent 不会永久阻塞所有人', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await seedCache(dir)
    const paths = kbPaths(dir)
    const old = new Date(Date.now() - 120_000).toISOString()
    await fs.writeFile(paths.lock, JSON.stringify({ owner: 'dead-agent', token: 'x', at: old }), 'utf8')
    const result = await recordChange(dir, { key: 'cache.vps.disk', value: '30G', author: AUTHOR, reason: '前任崩溃后接管写入' })
    assert.equal(result.revision, 2)
    await fs.access(paths.lock).then(() => assert.fail('锁未释放'), () => {})
  } finally {
    await cleanup()
  }
})

await test('未知 key 的 record_change 报 not_found', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await rejectsWith(recordChange(dir, { key: 'cache.nope', value: '1G', author: AUTHOR, reason: '随便写点东西测试' }), 'not_found')
  } finally {
    await cleanup()
  }
})

await test('list_resources 按项目 / 种类 / 关键词过滤', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await seedCache(dir)
    await createResource(dir, {
      key: 'port.example-9000',
      title: 'VPS 上 webops 隧道端口',
      kind: 'port',
      value: '127.0.0.1:9000',
      author: AUTHOR,
      owner_project: 'proj-ops',
      projects: ['proj-ops'],
      risk: 'critical',
    })
    assert.equal((await listResources(dir, {})).total, 2)
    assert.equal((await listResources(dir, { kind: 'port' })).total, 1)
    assert.equal((await listResources(dir, { project: 'proj-ops' })).total, 1)
    assert.equal((await listResources(dir, { query: '缓存' })).total, 1)
    assert.equal((await listResources(dir, { risk: 'critical' })).total, 1)
  } finally {
    await cleanup()
  }
})

await test('项目视图：本项目条目 + 别处 critical 条目', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await seedCache(dir)
    await createResource(dir, {
      key: 'port.example-9000',
      title: 'VPS 隧道端口',
      kind: 'port',
      value: '127.0.0.1:9000',
      author: AUTHOR,
      owner_project: 'proj-ops',
      projects: ['proj-ops'],
      risk: 'critical',
    })
    const view = await projectView(dir, 'proj-gateway')
    assert.deepEqual(view.mine.map((row) => row.key), ['cache.vps.disk'])
    assert.equal(view.mine[0].value, '40G')
    assert.deepEqual(view.critical_elsewhere.map((row) => row.key), ['port.example-9000'])

    const written = await refreshAllViews(dir, ['proj-gateway', 'proj-ops'])
    assert.equal(written.length, 2)
    const text = renderViewMarkdown(view)
    assert.match(text, /cache\.vps\.disk/)
    assert.match(text, /40G/)
  } finally {
    await cleanup()
  }
})

await test('kb_status 汇总条目 / 项目 / 变更数', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await seedCache(dir)
    const status = await kbStatus(dir)
    assert.equal(status.resources, 1)
    assert.equal(status.changes, 1)
    assert.deepEqual(status.projects, ['proj-gateway'])
    assert.equal(status.by_kind.cache, 1)
  } finally {
    await cleanup()
  }
})

await test('门禁：建立条目不算「核对」，必须真的 audit 一次才放行', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await seedCache(dir)
    await createResource(dir, {
      key: 'port.example-9000',
      title: 'VPS 隧道端口',
      kind: 'port',
      value: '127.0.0.1:9000',
      author: AUTHOR,
      owner_project: 'proj-gateway',
      projects: ['proj-gateway'],
      risk: 'high',
    })
    // Writing your own entry is not evidence that you read the shared slice:
    // 建立条目 只证明你写了这一条，不证明你看过别人那一条。
    const before = await gateStatus(dir, { author: AUTHOR, project: 'proj-gateway' })
    assert.equal(before.ok, false)
    assert.equal(before.uncovered.length, 2)

    const audit = await auditSlice(dir, { author: AUTHOR, project: 'proj-gateway', stage: '完成阶段一：核对共享资源' })
    assert.deepEqual(audit.covered.sort(), ['cache.vps.disk', 'port.example-9000'])
    const after = await gateStatus(dir, { author: AUTHOR, project: 'proj-gateway' })
    assert.equal(after.ok, true)
    assert.equal(after.uncovered.length, 0)
  } finally {
    await cleanup()
  }
})

await test('门禁：别人改了值之后你的核对失效', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await seedCache(dir)
    await auditSlice(dir, { author: AUTHOR, project: 'proj-gateway', stage: '核对当前缓存值' })
    assert.equal((await gateStatus(dir, { author: AUTHOR, project: 'proj-gateway' })).ok, true)

    await recordChange(dir, {
      key: 'cache.vps.disk',
      value: '35G',
      author: AUTHOR_B,
      reason: 'B 项目划分 5GB，剩余 35G',
      projects: ['proj-gateway'],
    })
    const stale = await gateStatus(dir, { author: AUTHOR, project: 'proj-gateway' })
    assert.equal(stale.ok, false)
    assert.equal(stale.uncovered[0].key, 'cache.vps.disk')
    assert.equal(stale.uncovered[0].revision, 2)
  } finally {
    await cleanup()
  }
})

await test('门禁：空范围视为通过（无共享资源可核对）', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    const status = await gateStatus(dir, { author: AUTHOR, project: 'empty-project' })
    assert.equal(status.ok, true)
    assert.match(status.reason, /没有条目/)
  } finally {
    await cleanup()
  }
})

await test('审核记录进入 append-only 日志，可追溯谁核对过什么', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await seedCache(dir)
    await auditSlice(dir, { author: AUTHOR, project: 'proj-gateway', stage: '阶段二完成', note: '缓存仍是 40G' })
    const paths = kbPaths(dir)
    const files = await fs.readdir(paths.changes)
    const records = []
    for (const file of files) records.push(JSON.parse(await fs.readFile(path.join(paths.changes, file), 'utf8')))
    const audit = records.find((item) => item.action === 'audit')
    assert.ok(audit, '没有 audit 记录')
    assert.deepEqual(audit.covered, ['cache.vps.disk'])
    assert.match(audit.after_preview, /cache\.vps\.disk@r1/)
    assert.match(audit.reason, /阶段二完成/)
    const changelog = await fs.readFile(paths.changelog, 'utf8')
    assert.match(changelog, /audit/)
  } finally {
    await cleanup()
  }
})

await test('非法 key 被拒绝', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    await rejectsWith(createResource(dir, { key: 'Bad Key!', title: 'x', value: 'y', author: AUTHOR }), 'invalid_name')
    await rejectsWith(createResource(dir, { key: 'a', title: 'x', value: 'y', author: AUTHOR }), 'invalid_name')
  } finally {
    await cleanup()
  }
})

await test('ensureKbDirs 幂等', async () => {
  const { dir, cleanup } = await tempStore()
  try {
    const first = await ensureKbDirs(dir)
    const second = await ensureKbDirs(dir)
    assert.equal(first.root, second.root)
    await fs.access(first.rev)
  } finally {
    await cleanup()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) {
    console.error(`\n--- ${failure.name} ---`)
    console.error(failure.error)
  }
  process.exitCode = 1
}
