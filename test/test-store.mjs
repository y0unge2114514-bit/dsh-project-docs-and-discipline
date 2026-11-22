/**
 * Plain-Node verification for store.js. Run: node test-store.mjs
 * Uses an owned temp directory under the workspace and removes it afterwards.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import * as store from '../lib/store.js'
import { activeOnly, claimDecision, normalizePath, projectForContext } from '../lib/claims-guard.js'
import { describeDuration, requestedTimeoutMs, timeoutDecision } from '../lib/timeout-policy.js'
import { findClaims, hasClaim, classifyEvidence, evidenceVerdict, missingEvidenceMessage } from '../lib/evidence-policy.js'
import { classifyWrite, linkDecision, linkWarning, failureFingerprint, isNegativeFeedback } from '../lib/link-policy.js'
import { emptyState, recordFailure, isWriteBlocked, tryClear, traceModeMessage } from '../lib/circuit-breaker.js'
import { diffTrees, integrityReport, parseListing, isIgnoredPath } from '../lib/bundle-integrity.js'

const root = path.resolve('.tmp-project-docs-test')
await fs.rm(root, { recursive: true, force: true })
const storeDir = path.join(root, 'store')

const passed = []
const failedCases = []
async function check(name, run) {
  try {
    await run()
    passed.push(name)
  } catch (error) {
    failedCases.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function expectReject(run, code) {
  try {
    await run()
  } catch (error) {
    assert.equal(error.code, code, `expected code ${code}, got ${error.code} (${error.message})`)
    return error
  }
  throw new Error(`expected rejection with ${code}`)
}

await check('empty store state', async () => {
  const state = await store.state(storeDir)
  assert.equal(state.projects.length, 0)
  assert.ok(state.storeDir.endsWith('store'))
})

await check('createProject validates title', async () => {
  await expectReject(() => store.createProject(storeDir, { title: '   ' }), 'invalid_input')
})

await check('createProject seeds both doc categories', async () => {
  const created = await store.createProject(storeDir, {
    title: 'demo-app',
    root: 'D:\\work\\example-project',
    summary: '私人demo-app',
  })
  assert.equal(created.created, true)
  assert.equal(created.project.id, 'demo-app')
  assert.equal(created.project.root, 'D:\\work\\example-project')
  assert.equal((await store.listDocs(storeDir, 'demo-app', 'project'))[0].name, 'PROJECT.md')
  assert.equal((await store.listDocs(storeDir, 'demo-app', 'collab'))[0].name, 'COLLAB.md')
})

await check('readDoc rejects a missing document', async () => {
  await expectReject(() => store.readDoc(storeDir, 'demo-app', 'project', 'HANDOFF'), 'not_found')
})

await check('writeDoc creates, returns a hash, and reads back', async () => {
  const written = await store.writeDoc(storeDir, 'demo-app', 'project', 'HANDOFF', '# 交接\n\n第一版\n')
  assert.equal(written.created, true)
  assert.equal(written.name, 'HANDOFF.md')
  assert.equal(written.title, '交接')
  assert.equal(written.hash.length, 16)
  const read = await store.readDoc(storeDir, 'demo-app', 'project', 'HANDOFF.md')
  assert.equal(read.content, '# 交接\n\n第一版\n')
  assert.equal(read.hash, written.hash)
})

await check('writeDoc refuses silent overwrite without base_hash', async () => {
  const error = await expectReject(
    () => store.writeDoc(storeDir, 'demo-app', 'project', 'HANDOFF.md', '# 交接\n\n被别人改了\n'),
    'doc_exists',
  )
  assert.equal(error.details.current.hash.length, 16)
  const current = await store.readDoc(storeDir, 'demo-app', 'project', 'HANDOFF.md')
  assert.match(current.content, /第一版/)
})

await check('writeDoc compare-and-set accepts the fresh hash and rejects a stale one', async () => {
  const before = await store.readDoc(storeDir, 'demo-app', 'project', 'HANDOFF.md')
  const updated = await store.writeDoc(storeDir, 'demo-app', 'project', 'HANDOFF.md', '# 交接\n\n第二版\n', before.hash)
  assert.equal(updated.created, false)
  assert.notEqual(updated.hash, before.hash)
  const error = await expectReject(
    () => store.writeDoc(storeDir, 'demo-app', 'project', 'HANDOFF.md', '# 交接\n\n并发覆盖\n', before.hash),
    'doc_conflict',
  )
  assert.equal(error.details.current.hash, updated.hash)
})

await check('writeDoc rejects path traversal and unsafe names', async () => {
  await expectReject(() => store.writeDoc(storeDir, 'demo-app', 'project', '../evil', 'x'), 'invalid_name')
  await expectReject(() => store.writeDoc(storeDir, 'demo-app', 'project', 'a/b', 'x'), 'invalid_name')
  await expectReject(() => store.writeDoc(storeDir, 'demo-app', 'project', '.hidden', 'x'), 'invalid_name')
})

await check('postMessage appends immutable entries to both boards', async () => {
  const first = await store.postMessage(storeDir, 'demo-app', 'human', { text: '先别重启服务', author: 'human', kind: 'warning' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await store.postMessage(storeDir, 'demo-app', 'human', { text: '收到', author: 'human' })
  const third = await store.postMessage(storeDir, 'demo-app', 'agent', { text: '已认领示例工作项', author: 'lead', kind: 'claim' })
  const human = await store.listMessages(storeDir, 'demo-app', 'human', 10)
  assert.equal(human.total, 2)
  assert.equal(human.hasMore, false)
  assert.deepEqual(human.entries.map((entry) => entry.text), ['收到', '先别重启服务'])
  assert.equal(human.entries[1].kind, 'warning')
  const agent = await store.listMessages(storeDir, 'demo-app', 'agent', 10)
  assert.equal(agent.entries[0].id, third.id)
  assert.equal(agent.entries[0].author, 'lead')
  const files = await fs.readdir(path.join(storeDir, 'projects', 'demo-app', 'board', 'human'))
  assert.equal(files.length, 2)
  assert.ok(!files.includes(first.id + '.json') === false)
  assert.notEqual(first.id, second.id)
})

await check('postMessage rejects empty text and unknown board', async () => {
  await expectReject(() => store.postMessage(storeDir, 'demo-app', 'human', { text: '   ' }), 'invalid_input')
  await expectReject(() => store.postMessage(storeDir, 'demo-app', 'other', { text: 'x' }), 'invalid_input')
})

await check('registerTool registers, merges and searches across projects', async () => {
  const tool = await store.registerTool(storeDir, 'demo-app', {
    name: 'sop-selfcheck',
    summary: '一键自检 25 项',
    command: 'node scripts/sop-selfcheck.js',
    usage: '加 --no-vps 跳过公网',
    tags: ['selfcheck', 'windows'],
  })
  assert.equal(tool.id, 'sop-selfcheck')
  await store.registerTool(storeDir, 'demo-app', {
    name: 'sop-selfcheck',
    summary: '一键自检 25 项（更新）',
    command: 'node scripts/sop-selfcheck.js --json',
    tags: ['selfcheck'],
  })
  const tools = await store.listTools(storeDir, 'demo-app', '')
  assert.equal(tools.length, 1)
  assert.match(tools[0].summary, /更新/)
  assert.equal(tools[0].tags.length, 1)

  await store.createProject(storeDir, { title: '网关', seed: false })
  await store.registerTool(storeDir, '网关', { name: 'gateway-restart', summary: '平滑重载网关', command: 'curl -X POST http://127.0.0.1:8080/api/control/restart' })
  const all = await store.listTools(storeDir, 'all', '')
  assert.equal(all.length, 2)
  const filtered = await store.listTools(storeDir, 'all', 'restart')
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].project, '网关')
})

await check('createProject on an existing id updates metadata without touching docs', async () => {
  const before = await store.readDoc(storeDir, 'demo-app', 'project', 'HANDOFF.md')
  const updated = await store.createProject(storeDir, { id: 'demo-app', title: 'demo-app（改名）', summary: '新简介' })
  assert.equal(updated.created, false)
  assert.equal(updated.project.title, 'demo-app（改名）')
  assert.equal(updated.project.summary, '新简介')
  assert.equal((await store.readDoc(storeDir, 'demo-app', 'project', 'HANDOFF.md')).content, before.content)
})

await check('state aggregates counts and latest message per board', async () => {
  const state = await store.state(storeDir)
  assert.equal(state.projects.length, 2)
  const netdisk = state.projects.find((project) => project.id === 'demo-app')
  assert.equal(netdisk.counts.project, 2)
  assert.equal(netdisk.counts.collab, 1)
  assert.equal(netdisk.counts.human, 2)
  assert.equal(netdisk.counts.agent, 1)
  assert.equal(netdisk.counts.tools, 1)
  assert.equal(netdisk.latest.agent.author, 'lead')
})

await check('projectDetail returns docs, boards and tools', async () => {
  const detail = await store.projectDetail(storeDir, 'demo-app')
  assert.equal(detail.project.id, 'demo-app')
  assert.ok(detail.docs.project.length >= 2)
  assert.equal(detail.boards.agent.total, 1)
  assert.equal(detail.tools.length, 1)
})

await check('torn project.json does not hide documents and is repairable', async () => {
  const metaFile = path.join(storeDir, 'projects', '网关', 'project.json')
  const real = await fs.readFile(metaFile)
  await fs.writeFile(metaFile, Buffer.alloc(real.length)) // NUL padding, like an unclean shutdown
  const state = await store.state(storeDir)
  const gateway = state.projects.find((project) => project.id === '网关')
  assert.ok(gateway !== undefined, 'project must stay listed')
  assert.equal(gateway.title, '网关')
  assert.equal(gateway.corrupt, true)
  const repaired = await store.createProject(storeDir, { id: '网关', title: '网关（修复）', seed: false })
  assert.equal(repaired.project.title, '网关（修复）')
  assert.equal(repaired.project.corrupt, undefined)
  assert.equal((await store.listDocs(storeDir, '网关', 'project')).length, 0)
})

await check('unknown project is not found', async () => {
  await expectReject(() => store.listDocs(storeDir, 'no-such-project', 'project'), 'not_found')
})

await check('project ids reject traversal', async () => {
  await expectReject(() => store.createProject(storeDir, { id: '../evil', title: 'x' }), 'invalid_name')
})

await check('credential documents stay in their own category', async () => {
  await store.writeDoc(storeDir, '网关', 'credential', 'demo', 'key=secret-value-for-test')
  const credentials = await store.listDocs(storeDir, '网关', 'credential')
  assert.equal(credentials.length, 1)
  assert.equal(credentials[0].name, 'demo.md')
  assert.equal((await store.readDoc(storeDir, '网关', 'credential', 'demo.md')).content, 'key=secret-value-for-test')
  assert.equal((await store.listDocs(storeDir, '网关', 'project')).length, 0)
  assert.equal((await store.listDocs(storeDir, '网关', 'collab')).length, 0)
})

await check('claims are visible to other agents and releasable', async () => {
  const claim = await store.claimWork(storeDir, '网关', { agent: 'pusher-a', scope: '只动 outbox/ 批次 2026-10', ttl_minutes: 30 })
  assert.ok(claim.id !== '')
  assert.ok(claim.expiresAt > claim.startedAt)
  const listed = await store.state(storeDir)
  const gateway = listed.projects.find((project) => project.id === '网关')
  assert.equal(gateway.claims.length, 1)
  assert.equal(gateway.claims[0].agent, 'pusher-a')
  assert.equal((await store.activeClaims(storeDir, '网关')).length, 1)
  const detail = await store.projectDetail(storeDir, '网关')
  assert.equal(detail.claims.length, 1)
  const released = await store.releaseClaim(storeDir, '网关', { agent: 'pusher-a' })
  assert.equal(released.released.length, 1)
  assert.equal(released.remaining, 0)
  assert.equal((await store.activeClaims(storeDir, '网关')).length, 0)
})

await check('claims by another agent are not released by mistake', async () => {
  await store.claimWork(storeDir, '网关', { agent: 'pusher-a', scope: '批次 A' })
  const mine = await store.claimWork(storeDir, '网关', { agent: 'pusher-b', scope: '批次 B' })
  const wrong = await store.releaseClaim(storeDir, '网关', { agent: 'pusher-b', claim_id: 'not-this-one' })
  assert.equal(wrong.released.length, 0)
  const remaining = await store.activeClaims(storeDir, '网关')
  assert.equal(remaining.length, 2)
  await store.releaseClaim(storeDir, '网关', { agent: 'pusher-b', claim_id: mine.id })
  const after = await store.activeClaims(storeDir, '网关')
  assert.equal(after.length, 1)
  assert.equal(after[0].agent, 'pusher-a')
  await store.releaseClaim(storeDir, '网关', { agent: 'pusher-a' })
})

await check('expired claims drop out on read', async () => {
  const dir = path.join(storeDir, 'projects', '网关', 'claims')
  await fs.mkdir(dir, { recursive: true })
  const stale = {
    id: '20260101-000000-dead01',
    project: '网关',
    agent: 'gone-agent',
    scope: '早就死了的批次',
    note: '',
    startedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T01:00:00.000Z',
    sessionId: '',
  }
  await fs.writeFile(path.join(dir, `${stale.id}.json`), JSON.stringify(stale))
  const claims = await store.activeClaims(storeDir, '网关')
  assert.equal(claims.length, 0)
  const names = await fs.readdir(dir)
  assert.equal(names.includes(`${stale.id}.json`), false)
})

await check('claim_work requires an agent and a scope', async () => {
  await expectReject(() => store.claimWork(storeDir, '网关', { scope: 'x' }), 'invalid_input')
  await expectReject(() => store.claimWork(storeDir, '网关', { agent: 'a' }), 'invalid_input')
})

await check('guard: normalizePath folds slashes, runs and trailing separators', async () => {
  assert.equal(normalizePath('D:/A//B\\'), 'd:\\a\\b')
  assert.equal(normalizePath(''), '')
  assert.equal(normalizePath(undefined), '')
})

await check('guard: nested project root wins over its parent', async () => {
  const roots = [
    { id: 'workspace', root: 'D:\\work' },
    { id: 'netdisk', root: 'D:\\work\\proj-netdisk' },
  ]
  assert.equal(projectForContext(roots, 'D:\\work\\proj-netdisk\\outbox', {}), 'netdisk')
  assert.equal(projectForContext(roots, 'D:\\work\\other', {}), 'workspace')
  assert.equal(projectForContext(roots, 'D:\\Elsewhere', {}), undefined)
})

await check('guard: an absolute path inside tool arguments locates the project', async () => {
  const roots = [{ id: 'netdisk', root: 'D:\\work\\proj-netdisk' }]
  const args = { command: 'node push.mjs "D:/work/proj-netdisk/outbox/batch-1"' }
  assert.equal(projectForContext(roots, 'D:\\work', args), 'netdisk')
})

await check('guard: activeOnly drops expired claims', async () => {
  const now = Date.parse('2026-10-19T00:00:00.000Z')
  const claims = [
    { id: 'a', expiresAt: '2026-10-18T23:59:00.000Z' },
    { id: 'b', expiresAt: '2026-10-19T01:00:00.000Z' },
    { id: 'c' },
  ]
  assert.deepEqual(activeOnly(claims, now).map((claim) => claim.id), ['b'])
})

await check('guard: decision matrix (claimed / others / warned)', async () => {
  const claim = [{ agent: 'other-agent', scope: 'batch' }]
  assert.equal(claimDecision({ claimed: true, warned: false, others: claim }), 'allow')
  assert.equal(claimDecision({ claimed: false, warned: false, others: claim }), 'block')
  assert.equal(claimDecision({ claimed: false, warned: true, others: claim }), 'block')
  assert.equal(claimDecision({ claimed: false, warned: false, others: [] }), 'prompt')
  assert.equal(claimDecision({ claimed: false, warned: true, others: [] }), 'allow')
})

await check('search: finds keyword in a current document', async () => {
  await store.createProject(storeDir, { id: 'search-proj', title: 'Search', root: 'D:\\Search' })
  await store.writeDoc(storeDir, 'search-proj', 'collab', 'NOTES.md', '# 网络环境\n\n本机所有流量都走校园网内网，改 TCP 参数前先看这里。\n')
  const found = await store.searchDocs(storeDir, '校园网')
  assert.ok(found.hits.length >= 1)
  assert.equal(found.hits[0].project, 'search-proj')
  assert.equal(found.hits[0].archived, false)
  assert.ok(found.hits[0].snippet.includes('校园网'))
})

await check('search: archived documents are searched but ranked last', async () => {
  const id = 'search-proj'
  const paths = store.projectPaths(storeDir, id)
  await fs.mkdir(paths.archive, { recursive: true })
  const archived = path.join(paths.archive, 'collab__OLD-HANDOFF.md')
  await fs.writeFile(archived, '# 旧交接\n\n校园网限速问题已研究过：结论是不要动窗口缩放。\n', 'utf8')
  const found = await store.searchDocs(storeDir, '校园网')
  const archivedHits = found.hits.filter((hit) => hit.archived)
  assert.equal(archivedHits.length, 1)
  assert.equal(archivedHits[0].name, 'collab__OLD-HANDOFF.md')
  assert.equal(found.hits.at(-1).archived, true)
})

await check('search: project filter, name match and archived toggle', async () => {
  await store.createProject(storeDir, { id: 'search-other', title: 'Other', root: 'D:\\Other' })
  await store.writeDoc(storeDir, 'search-other', 'collab', 'NOTES.md', '# 无关\n\n这里不提前面的关键词。\n')
  const scoped = await store.searchDocs(storeDir, '校园网', { project: 'search-other' })
  assert.equal(scoped.hits.length, 0)
  const byName = await store.searchDocs(storeDir, 'OLD-HANDOFF')
  assert.ok(byName.hits.some((hit) => hit.name === 'collab__OLD-HANDOFF.md'))
  const noArchived = await store.searchDocs(storeDir, '校园网', { include_archived: false })
  assert.equal(noArchived.hits.filter((hit) => hit.archived).length, 0)
})

await check('search: empty query is rejected', async () => {
  await expectReject(() => store.searchDocs(storeDir, '   '), 'invalid_input')
})

await check('claim: updating a claim records progress and renews the lease', async () => {
  await store.createProject(storeDir, { id: 'collab-proj', title: 'Collab', root: 'D:\\Collab' })
  const first = await store.claimWork(storeDir, 'collab-proj', {
    agent: 'agent-a',
    scope: '只动 outbox/',
    ttl_minutes: 5,
  })
  assert.equal(first.updated, false)
  assert.equal(first.progress, '')
  const earlier = first.expiresAt
  await new Promise((resolve) => setTimeout(resolve, 20))
  const renewed = await store.claimWork(storeDir, 'collab-proj', {
    agent: 'agent-a',
    claim_id: first.id,
    progress: '已推送 180/500',
    next_step: '下一批从 121 开始，先 dry-run',
    ttl_minutes: 60,
  })
  assert.equal(renewed.updated, true)
  assert.equal(renewed.id, first.id)
  assert.equal(renewed.progress, '已推送 180/500')
  assert.equal(renewed.nextStep, '下一批从 121 开始，先 dry-run')
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(earlier))
  const active = await store.activeClaims(storeDir, 'collab-proj')
  assert.equal(active.length, 1)
  assert.equal(active[0].progress, '已推送 180/500')
  assert.ok(active[0].updatedAt !== '')
})

await check('claim: updating without ttl_minutes keeps the remaining lease', async () => {
  const before = (await store.activeClaims(storeDir, 'collab-proj')).find((claim) => claim.agent === 'agent-a')
  const touched = await store.claimWork(storeDir, 'collab-proj', {
    agent: 'agent-a',
    claim_id: before.id,
    progress: '已推送 180/500',
    next_step: '下一批从 181 开始',
  })
  assert.equal(touched.expiresAt, before.expiresAt)
  assert.equal(touched.progress, '已推送 180/500')
  assert.equal(touched.nextStep, '下一批从 181 开始')
})

await check('claim: another agent cannot update your claim', async () => {
  const [mine] = await store.activeClaims(storeDir, 'collab-proj')
  await expectReject(
    () => store.claimWork(storeDir, 'collab-proj', { agent: 'agent-b', claim_id: mine.id, progress: '偷改' }),
    'not_found',
  )
  const active = await store.activeClaims(storeDir, 'collab-proj')
  assert.equal(active[0].progress, '已推送 180/500')
})

await check('claim: two agents coordinate through progress and next step', async () => {
  const peer = await store.claimWork(storeDir, 'collab-proj', {
    agent: 'agent-b',
    scope: '只动 inbox/',
    progress: '0/80',
    next_step: '先清空 inbox 旧批次',
  })
  const active = await store.activeClaims(storeDir, 'collab-proj')
  assert.equal(active.length, 2)
  const peerView = active.find((claim) => claim.agent === 'agent-b')
  assert.equal(peerView.scope, '只动 inbox/')
  assert.equal(peerView.progress, '0/80')
  assert.equal(peerView.nextStep, '先清空 inbox 旧批次')
  const mine = active.find((claim) => claim.agent === 'agent-a')
  assert.equal(mine.progress, '已推送 180/500')
  assert.equal(peer.id === mine.id, false)
})

await check('message: `to` addresses a peer agent and is listed back', async () => {
  const entry = await store.postMessage(storeDir, 'collab-proj', 'agent', {
    text: 'agent-b：我在推 121-500，你清 inbox 时别动 outbox/。',
    author: 'agent-a',
    kind: 'claim',
    to: 'agent-b',
  })
  assert.equal(entry.to, 'agent-b')
  const page = await store.listMessages(storeDir, 'collab-proj', 'agent', 5)
  assert.equal(page.entries[0].to, 'agent-b')
  assert.equal(page.entries[0].kind, 'claim')
})

await check('timeout: extracts the largest caller-chosen timeout in ms', async () => {
  assert.equal(requestedTimeoutMs({ timeoutMs: 300_000 }).ms, 300_000)
  assert.equal(requestedTimeoutMs({ timeout_ms: 45_000 }).ms, 45_000)
  assert.equal(requestedTimeoutMs({ timeout_seconds: 5 }).ms, 5000)
  assert.equal(requestedTimeoutMs({ timeout: 30 }).ms, 30_000)
  assert.equal(requestedTimeoutMs({ timeout: 900 }).ms, 900)
  assert.equal(requestedTimeoutMs({ timeoutMs: 10_000, waitMs: 90_000 }).ms, 90_000)
  assert.equal(requestedTimeoutMs({ command: 'ls' }), undefined)
  assert.equal(requestedTimeoutMs(null), undefined)
  assert.equal(requestedTimeoutMs({ timeoutMs: -5 }), undefined)
})

await check('timeout: only oversized un-warned requests are refused', async () => {
  const limit = 120_000
  const big = { key: 'timeoutMs', ms: 300_000 }
  const small = { key: 'timeoutMs', ms: 30_000 }
  assert.equal(timeoutDecision({ requested: big, limit }), 'warn')
  assert.equal(timeoutDecision({ requested: big, limit, warned: true }), 'allow')
  assert.equal(timeoutDecision({ requested: small, limit }), 'allow')
  assert.equal(timeoutDecision({ requested: undefined, limit }), 'allow')
  assert.equal(timeoutDecision({ requested: big, limit: 0 }), 'allow')
})

await check('timeout: durations read naturally', async () => {
  assert.equal(describeDuration(800), '800 毫秒')
  assert.equal(describeDuration(4500), '4.5 秒')
  assert.equal(describeDuration(60_000), '60 秒')
  assert.equal(describeDuration(89_000), '89 秒')
  assert.equal(describeDuration(300_000), '5.0 分钟')
  assert.equal(describeDuration(undefined), '未知')
})

// ---------------------------------------------------------------- evidence
await check('evidence: completion claims are found, hedges are not', async () => {
  assert.equal(findClaims('已修复，可以重新下载了。')[0].kind, 'fixed')
  assert.equal(findClaims('两个问题都已完成。')[0].kind, 'done')
  assert.equal(findClaims('服务已就绪，端口 8080。')[0].kind, 'ready')
  assert.equal(hasClaim('还没修复，正在看日志。'), false)
  assert.equal(hasClaim('下一步会修复这个问题。'), false)
  assert.equal(hasClaim('未修复：仍然 502。'), false)
  assert.equal(hasClaim('```\n# 已修复\n```'), false)
  assert.equal(hasClaim('这一行不是结论。'), false)
})

await check('evidence: the three dimensions are classified separately', async () => {
  const request = classifyEvidence('HTTP/2 200\netag: "abc123"\ncontent-length: 1048576')
  assert.equal(request.request, true)
  assert.equal(request.file, false)
  const file = classifyEvidence('解包后：drwxr-xr-x  12 root root 4096 Oct 20 10:00 assets\n-rw-r--r-- 1 root root 5242880 main.js')
  assert.equal(file.file, true)
  const env = classifyEvidence('远端 sha256: 9f86d081884c7d65 与本机一致')
  assert.equal(env.env, true)
})

await check('evidence: a claim needs all three dimensions by default', async () => {
  const verdict = evidenceVerdict({ text: 'HTTP/2 200\netag: "abc"', claimed: true })
  assert.equal(verdict.satisfied, false)
  assert.deepEqual(verdict.missing.sort(), ['env', 'file'])
  const full = evidenceVerdict({
    text: 'curl -i 返回 HTTP/2 200，etag "abc"，解包后 main.js 5242880 字节，远端 md5 d41d8cd98f00b204 与本机一致',
    claimed: true,
  })
  assert.equal(full.satisfied, true)
  const message = missingEvidenceMessage(verdict.missing, { projectId: 'proj-netdisk', claimKind: '已修复' })
  assert.match(message, /未检测到物理端到端验证证据/)
  assert.match(message, /proj-netdisk/)
})

// -------------------------------------------------------------------- link
await check('link: deploy targets, cache layers and archives are recognised', async () => {
  const deploy = classifyWrite({ toolName: 'ops_bash', args: { command: 'scp dist/app.min.js root@vps:/var/www/html/' } })
  assert.equal(deploy.isWrite, true)
  assert.equal(deploy.isDeploySource, true)
  const verdict = linkDecision(deploy)
  assert.equal(verdict.warn, true)
  assert.ok(verdict.hops.length >= 2)

  const local = classifyWrite({ toolName: 'edit', args: { file_path: 'src/lib/format.js', new_string: 'x' } })
  assert.equal(linkDecision(local).warn, false)

  const archive = classifyWrite({ toolName: 'ops_bash', args: { command: 'powershell Compress-Archive -Path build/out/* -DestinationPath release.zip' } })
  assert.equal(archive.isBinaryArtifact, true)

  const read = classifyWrite({ toolName: 'read', args: { file_path: 'src/lib/format.js' } })
  assert.equal(read.isWrite, false)

  const warning = linkWarning({ target: 'dist/app.js', hops: verdict.hops, consumer: deploy.consumer })
  assert.match(warning, /不会自动生效/)
})

await check('link: failure fingerprints collapse volatile parts', async () => {
  const a = failureFingerprint('Error: connect ETIMEDOUT 10.0.0.5:8600 after 30000ms (pid 12345)')
  const b = failureFingerprint('Error: connect ETIMEDOUT 10.0.0.5:8600 after 30000ms (pid 54321)')
  assert.equal(a, b)
  assert.notEqual(failureFingerprint('Error: 502 Bad Gateway'), a)
  assert.equal(failureFingerprint('一切正常'), '')
  assert.equal(isNegativeFeedback('还是黑的，根本没有更新'), true)
  assert.equal(isNegativeFeedback('依然打不开'), true)
  assert.equal(isNegativeFeedback('好的，谢谢'), false)
})

// ----------------------------------------------------------------- breaker
await check('breaker: two identical failures trip it and only a trace clears it', async () => {
  let state = emptyState()
  const sample = 'Error: connect ETIMEDOUT 10.0.0.1:443 after 30000ms (pid 111)'
  const first = recordFailure(state, { fingerprint: failureFingerprint(sample), at: 1 })
  state = first.state
  assert.equal(first.tripped, false)
  assert.equal(isWriteBlocked(state), false)
  const second = recordFailure(state, { fingerprint: failureFingerprint(sample), at: 2 })
  state = second.state
  assert.equal(second.tripped, true)
  assert.equal(isWriteBlocked(state), true)
  const message = traceModeMessage(state.tripped, [])
  assert.match(message, /死循环断路器已触发/)
  assert.match(message, /禁止继续写补丁/)

  const wrong = tryClear(state, '我又改了一下代码，应该好了', 3)
  assert.equal(wrong.cleared, false)
  assert.equal(isWriteBlocked(wrong.state), true)

  const right = tryClear(state, 'Program.cs:2841 只读 configs.zip，而当前 zip 内缺 assets/kubejs 目录', 4)
  assert.equal(right.cleared, true)
  assert.equal(isWriteBlocked(right.state), false)
})

await check('breaker: a different failure resets the streak', async () => {
  let state = emptyState()
  state = recordFailure(state, { fingerprint: failureFingerprint('Error: 502 Bad Gateway'), at: 1 }).state
  const other = recordFailure(state, { fingerprint: failureFingerprint('Error: ENOENT no such file config.json'), at: 2 })
  assert.equal(other.tripped, false)
  const again = recordFailure(other.state, { fingerprint: failureFingerprint('Error: ENOENT no such file config.json'), at: 3 })
  assert.equal(again.tripped, true)
})

// --------------------------------------------------------------- integrity
await check('integrity: listings from ls -l and find are parsed', async () => {
  const ls = parseListing(
    [
      'total 12',
      'drwxr-xr-x  3 root root  4096 Oct 20 10:00 config/',
      '-rw-r--r--  1 root root  1234 Oct 20 10:00 config/app.yml',
      'drwxr-xr-x  3 root root  4096 Oct 20 10:00 assets/',
      '-rw-r--r--  1 root root  5678 Oct 20 10:00 assets/main.js',
    ].join('\n'),
  )
  assert.ok(ls.files.includes('config/app.yml'))
  assert.ok(ls.files.includes('assets/main.js'))
  assert.deepEqual(ls.dirs.sort(), ['assets', 'config'])

  const find = parseListing('./config/app.yml\n./assets/kubejs/main.js\n./.git/HEAD')
  assert.deepEqual(find.files.sort(), ['assets/kubejs/main.js', 'config/app.yml', '.git/HEAD'].sort())
  assert.equal(isIgnoredPath('.git/HEAD'), true)
})

await check('integrity: dropped folders are reported, not just file counts', async () => {
  const diff = diffTrees({
    source: ['config/app.yml', 'assets/kubejs/main.js', 'assets/textures/a.png', '.git/HEAD'],
    archive: ['config/app.yml'],
    ignoreCase: true,
  })
  assert.equal(diff.ok, false)
  assert.equal(diff.missing.length, 2)
  assert.deepEqual(diff.emptyCategories, ['assets'])
  const report = integrityReport(diff, { source: '源目录', archive: 'release.zip' })
  assert.match(report, /assets/)
  assert.match(report, /缺/)
})

await check('integrity: an identical tree passes', async () => {
  const diff = diffTrees({ source: ['a/b.js', 'a/c.css'], archive: ['a/b.js', 'a/c.css'] })
  assert.equal(diff.ok, true)
  assert.match(integrityReport(diff), /打包完整性核验通过/)
})

// ------------------------------------------------- store-level verification
await check('store: recorded verification is readable back per project', async () => {
  const health = path.join(storeDir, 'verify-project')
  await store.createProject(health, { id: 'verify-project', title: 'Verify', seed: false })
  const record = await store.recordVerification(health, 'verify-project', {
    summary: 'curl -i 返回 200，解包后文件齐全，远端 md5 一致',
    dimensions: ['request', 'file', 'env'],
    evidence: 'HTTP/2 200\netag: "abc"\nassets/main.js 5242880 字节\nmd5 d41d8cd98f00b204 一致',
    agent: 'lead',
  })
  assert.equal(record.project, 'verify-project')
  assert.deepEqual([...record.dimensions].sort(), ['env', 'file', 'request'])
  const list = await store.listVerifications(health, 'verify-project')
  assert.equal(list.length, 1)
  assert.match(list[0].summary, /curl -i/)
  await expectReject(
    () => store.recordVerification(health, 'verify-project', { summary: 'x', evidence: '' }),
    'invalid_input',
  )
})

await check('writeDoc 并发写同一 base_hash 时只有一个成功', async () => {
  // The CAS used to be check-then-act: two writers that both read revision N
  // passed the comparison before either wrote, and the second silently replaced
  // the first — one side's edit lost with no error. The per-document lock makes
  // the read-compare-write atomic, so exactly one writer may proceed and the
  // loser must get `doc_conflict`.
  await store.createProject(root, { id: 'race-proj', title: 'Race', root: '/tmp/race' })
  const docName = 'RACE.md'
  const base = await store.writeDoc(root, 'race-proj', 'project', docName, 'v0', undefined)
  const writers = ['w1', 'w2', 'w3', 'w4', 'w5']
  const results = await Promise.allSettled(
    writers.map((author) =>
      store.writeDoc(root, 'race-proj', 'project', docName, `from ${author}`, base.hash),
    ),
  )
  const ok = results.filter((item) => item.status === 'fulfilled')
  const rejected = results.filter((item) => item.status === 'rejected')
  assert.equal(ok.length, 1, `应只有一个写入成功，实际 ${ok.length}`)
  assert.equal(rejected.length, writers.length - 1)
  for (const item of rejected) {
    const code = item.reason?.code
    assert.ok(
      code === 'doc_conflict' || code === 'doc_locked',
      `失败的写入只应是冲突或锁，实际是 ${code}: ${item.reason?.message}`,
    )
  }
  const finalDoc = await store.readDoc(root, 'race-proj', 'project', docName)
  assert.match(finalDoc.content, /^from w[1-5]$/, `内容被撕裂：${JSON.stringify(finalDoc.content)}`)
  await assert.doesNotReject(
    () => store.writeDoc(root, 'race-proj', 'project', docName, 'after race', finalDoc.hash),
    '锁未释放',
  )
})

await check('writeDoc 的锁不阻塞其它文档', async () => {
  // A per-library lock would serialise unrelated documents; this lock is per
  // file precisely so two agents editing different documents never wait.
  const start = Date.now()
  await Promise.all([
    store.writeDoc(root, 'race-proj', 'project', 'A.md', 'a', undefined),
    store.writeDoc(root, 'race-proj', 'project', 'B.md', 'b', undefined),
    store.writeDoc(root, 'race-proj', 'project', 'C.md', 'c', undefined),
    store.writeDoc(root, 'race-proj', 'project', 'D.md', 'd', undefined),
  ])
  const elapsed = Date.now() - start
  assert.ok(elapsed < 3000, `四个不同文档并发写用了 ${elapsed}ms，锁粒度可能过粗`)
  for (const name of ['A.md', 'B.md', 'C.md', 'D.md']) {
    const doc = await store.readDoc(root, 'race-proj', 'project', name)
    assert.equal(doc.content, name[0].toLowerCase())
  }
})

await fs.rm(root, { recursive: true, force: true })

for (const name of passed) console.log(`PASS ${name}`)
for (const name of failedCases) console.log(`FAIL ${name}`)
console.log(`\n${passed.length} passed, ${failedCases.length} failed`)
if (failedCases.length > 0) process.exitCode = 1
