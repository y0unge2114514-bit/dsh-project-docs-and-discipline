/**
 * Tests for the handoff brief.
 *
 * The brief exists to stop a fresh session from re-doing or un-doing what the
 * previous one finished, so the cases below are the ways that actually goes
 * wrong: the brief is too noisy to read, it echoes the reader's own note back,
 * it advertises a claim that already expired, or it buries the "do not revert"
 * line where nobody sees it.
 */
import assert from 'node:assert/strict'
import { buildBrief, CAUTION, renderBrief, STALE_AFTER_MS } from '../lib/handoff-brief.js'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`FAIL  ${name}`)
    console.log(`      ${error.message.split('\n')[0]}`)
  }
}

const NOW = Date.parse('2026-11-04T12:00:00Z')
const iso = (offsetMs) => new Date(NOW - offsetMs).toISOString()
const HOUR = 3600_000
const DAY = 24 * HOUR

function msg(kind, text, offsetMs, author = 'previous-session') {
  return { id: `m${offsetMs}`, at: iso(offsetMs), kind, author, text }
}

console.log('handoff-brief.js')

test('没有历史时为空，不占提示词', () => {
  const result = buildBrief({ projectId: 'p', messages: [], claims: [], selfLabel: 'me', now: NOW })
  assert.equal(result.empty, true)
  assert.equal(renderBrief(result), '')
})

test('最近的交接被摘要出来', () => {
  const result = buildBrief({
    projectId: 'proj-netdisk',
    messages: [msg('handoff', '历史总表已合并上线，只读你的数据没改你', 2 * HOUR)],
    claims: [],
    selfLabel: '主会话·netdisk·abc',
    now: NOW,
  })
  assert.equal(result.empty, false)
  const text = renderBrief(result)
  assert.match(text, /接手状态：proj-netdisk/)
  assert.match(text, /2 小时前/)
  assert.match(text, /历史总表已合并上线/)
})

test('不回显自己刚写的交接', () => {
  const result = buildBrief({
    projectId: 'p',
    messages: [msg('handoff', '我自己刚收工', HOUR, '主会话·x·me')],
    claims: [],
    selfLabel: '主会话·x·me',
    now: NOW,
  })
  assert.equal(result.empty, true, '自己写的收工交接不该当成"别人留的"')
})

test('他人交接仍显示，即使自己也在同一项目', () => {
  const result = buildBrief({
    projectId: 'p',
    messages: [
      msg('handoff', '我的活干完了', HOUR, '主会话·x·me'),
      msg('handoff', '别人的活也干完了', 5 * HOUR, '主会话·x·other'),
    ],
    claims: [],
    selfLabel: '主会话·x·me',
    now: NOW,
  })
  const text = renderBrief(result)
  assert.match(text, /别人的活也干完了/)
  assert.doesNotMatch(text, /我的活干完了/)
})

test('超过两周的交接标为可能过时，但仍然提示', () => {
  const result = buildBrief({
    projectId: 'p',
    messages: [msg('handoff', '很久以前的交接', STALE_AFTER_MS + DAY)],
    claims: [],
    selfLabel: 'me',
    now: NOW,
  })
  const text = renderBrief(result)
  assert.match(text, /已超两周，可能过时/)
})

test('未释放的认领被标出来，含范围', () => {
  const result = buildBrief({
    projectId: 'p',
    messages: [],
    claims: [{
      agent: 'other-agent',
      scope: '只动 scripts/lib-quark-*.js',
      expiresAt: new Date(NOW + 30 * 60_000).toISOString(),
    }],
    selfLabel: 'me',
    now: NOW,
  })
  const text = renderBrief(result)
  assert.match(text, /other-agent 的未释放认领/)
  assert.match(text, /只动 scripts\/lib-quark/)
  assert.match(text, /还剩 30 分钟到期/)
})

test('自己的认领措辞不同（你要接着的）', () => {
  const result = buildBrief({
    projectId: 'p',
    messages: [],
    claims: [{
      agent: '主会话·x·me',
      scope: '只动 web/',
      expiresAt: new Date(NOW + 20 * 60_000).toISOString(),
    }],
    selfLabel: '主会话·x·me',
    now: NOW,
  })
  assert.match(renderBrief(result), /你要接着的认领/)
})

test('即将过期的认领不宣传', () => {
  const result = buildBrief({
    projectId: 'p',
    messages: [],
    claims: [{
      agent: 'gone',
      scope: '只动 x',
      expiresAt: new Date(NOW + 10_000).toISOString(),
    }],
    selfLabel: 'me',
    now: NOW,
  })
  assert.equal(result.empty, true, '10 秒后过期的认领等于没了')
})

test('已过期的认领不出现', () => {
  const result = buildBrief({
    projectId: 'p',
    messages: [],
    claims: [{ agent: 'gone', scope: 'sc', expiresAt: new Date(NOW - HOUR).toISOString() }],
    selfLabel: 'me',
    now: NOW,
  })
  assert.equal(result.empty, true)
})

test('警告优先于普通交接，且触发 caution', () => {
  const result = buildBrief({
    projectId: 'p',
    messages: [
      msg('handoff', '普通收工', HOUR),
      msg('warning', '不要回退 2026-09-13 的修复', 2 * HOUR),
    ],
    claims: [],
    selfLabel: 'me',
    now: NOW,
  })
  const text = renderBrief(result)
  assert.match(text, /⚠/)
  assert.match(text, /不要回退/)
  assert.equal(result.caution, true)
  // A warning is already an instruction; the pointer sentence is only for
  // handoffs that mention a caution in passing.
  assert.equal(result.cautionNeedsPointer, false)
})

test('CAUTION 正则命中"不能回退"类表述', () => {
  for (const phrase of ['不要回退这个修复', '禁止回退', '别动 stream-server', '这里踩过坑', '已回滚过一次']) {
    assert.ok(CAUTION.test(phrase), `应命中：${phrase}`)
  }
  for (const phrase of ['已完成构建', '测试全绿', '已上线']) {
    assert.ok(!CAUTION.test(phrase), `不该命中：${phrase}`)
  }
})

test('警告本身已是行动指令，不再追加重复提示', () => {
  // The first version appended "读一遍 COLLAB.md" after every warning. Since
  // most projects have a warning, that sentence appeared in every brief and
  // became the thing readers skip — the opposite of its purpose.
  const result = buildBrief({
    projectId: 'p',
    messages: [msg('warning', '不要回退 2026-09-13 的修复', 2 * HOUR)],
    claims: [],
    selfLabel: 'me',
    now: NOW,
  })
  const text = renderBrief(result)
  assert.equal(result.caution, true)
  assert.equal(result.cautionNeedsPointer, false)
  assert.doesNotMatch(text, /动手前先读一遍 COLLAB\.md/, '警告已自带指令，不要重复')
})

test('交接里提到"不要回退"时，才补一句指向 COLLAB.md', () => {
  const result = buildBrief({
    projectId: 'p',
    messages: [msg('handoff', '顺手一提：不要回退 WebRTC 那段改动', 2 * HOUR)],
    claims: [],
    selfLabel: 'me',
    now: NOW,
  })
  const text = renderBrief(result)
  assert.equal(result.cautionNeedsPointer, true)
  assert.match(text, /动手前先读一遍 COLLAB\.md/)
  const lines = text.split('\n')
  assert.match(lines[lines.length - 1], /COLLAB\.md/, 'caution 提示仍是最后一行')
})

test('认领 + 交接 + 警告可以同时出现', () => {
  const result = buildBrief({
    projectId: 'p',
    messages: [
      msg('handoff', '收工交接', 3 * HOUR),
      msg('warning', '不要回退 WebRTC 改动', 30 * HOUR),
    ],
    claims: [{ agent: 'x', scope: '只动 a/', expiresAt: new Date(NOW + 60 * 60_000).toISOString() }],
    selfLabel: 'me',
    now: NOW,
  })
  const text = renderBrief(result)
  assert.match(text, /未释放认领/)
  assert.match(text, /收工交接/)
  assert.match(text, /不要回退 WebRTC/)
})

test('长文本被截断，不撑爆提示词', () => {
  const long = 'x'.repeat(500)
  const result = buildBrief({
    projectId: 'p',
    messages: [msg('handoff', long, HOUR)],
    claims: [],
    selfLabel: 'me',
    now: NOW,
  })
  const text = renderBrief(result)
  assert.ok(text.length < 400, `摘要总长应受控，实际 ${text.length}`)
  assert.match(text, /…/)
  for (const line of text.split('\n')) assert.ok(line.length < 220, `单行过长：${line.length}`)
})

test('时间缺失时不崩溃', () => {
  const result = buildBrief({
    projectId: 'p',
    messages: [{ id: 'm1', at: '', kind: 'handoff', author: 'someone', text: '没有时间戳' }],
    claims: [],
    selfLabel: 'me',
    now: NOW,
  })
  assert.match(renderBrief(result), /时间未知/)
})

test('大量认领只列前 3 条', () => {
  const claims = []
  for (let i = 1; i <= 6; i += 1) {
    claims.push({ agent: `a${i}`, scope: `scope-${i}`, expiresAt: new Date(NOW + 60 * 60_000).toISOString() })
  }
  const result = buildBrief({ projectId: 'p', messages: [], claims, selfLabel: 'me', now: NOW })
  const text = renderBrief(result)
  assert.match(text, /scope-1/)
  assert.match(text, /scope-3/)
  assert.doesNotMatch(text, /scope-4/, '不应把 6 条认领全列出来')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) {
    console.error(`\n--- ${failure.name} ---`)
    console.error(failure.error)
  }
  process.exitCode = 1
}
