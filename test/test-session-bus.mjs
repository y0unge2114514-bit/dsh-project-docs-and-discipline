/**
 * Tests for the cross-session message selection rules.
 *
 * Every case below is a bug that actually shipped, or a boundary right next to
 * one. The 81-message incident and the 30-minute cache incident are both
 * represented, because those are the two that reached a live prompt.
 */
import assert from 'node:assert/strict'
import { LOUD_KINDS, renderMessageBlock, selectMessages } from '../lib/session-bus.js'

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

/** Newest-first board, as store.listMessages returns it. */
function board(specs) {
  return specs
    .map(([id, to, author, kind, text]) => ({
      id,
      to: to ?? '',
      author: author ?? 'someone',
      kind: kind ?? 'note',
      text: text ?? 'body',
    }))
    .sort((a, b) => (a.id < b.id ? 1 : -1))
}

const ME = '主会话·proj·abc123'

console.log('session-bus.js')

test('回归：广播不再从每个项目涌进来（81 条事故）', () => {
  // The incident: cwd outside every project, 12 boards scanned, 81 lines shown.
  const entries = board([
    ['20261103T160000000-aaaaaa', '', 'lead', 'note', 'workspace broadcast'],
    ['20261103T155900000-bbbbbb', '', 'lead', 'handoff', 'another project broadcast'],
  ])
  const result = selectMessages({
    entries,
    label: ME,
    authorOfMe: ME,
    projectId: undefined,
    lastSeen: '20261103T150000000-000000',
  })
  assert.deepEqual(result.lines, [], 'cwd 不在项目内时，广播一条都不该进来')
})

test('cwd 在项目内时，本项目的广播可见', () => {
  const entries = board([['20261103T160000000-aaaaaa', '', 'other', 'note', 'broadcast here']])
  const result = selectMessages({
    entries,
    label: ME,
    authorOfMe: ME,
    projectId: 'proj',
    lastSeen: '20261103T150000000-000000',
  })
  assert.equal(result.lines.length, 1)
  assert.match(result.lines[0], /broadcast here/)
})

test('明确点名本会话的消息，即使 cwd 在项目外也可见', () => {
  const entries = board([['20261103T160000000-aaaaaa', ME, 'other', 'question', 'for you specifically']])
  const result = selectMessages({
    entries,
    label: ME,
    authorOfMe: ME,
    projectId: undefined,
    lastSeen: '20261103T150000000-000000',
  })
  assert.equal(result.lines.length, 1, '明确点名不能被 cwd 规则吞掉')
  assert.match(result.lines[0], /for you specifically/)
  assert.match(result.lines[0], /question/, 'warning/question 应当标出来')
})

test('发给别人（具体标签）的消息不可见', () => {
  const entries = board([['20261103T160000000-aaaaaa', '主会话·other·xxx', 'lead', 'claim', 'not for you']])
  const result = selectMessages({
    entries,
    label: ME,
    authorOfMe: ME,
    projectId: 'proj',
    lastSeen: '20261103T150000000-000000',
  })
  assert.deepEqual(result.lines, [])
})

test('自己发的消息不回声', () => {
  const entries = board([['20261103T160000000-aaaaaa', '', ME, 'handoff', 'I wrote this']])
  const result = selectMessages({
    entries,
    label: ME,
    authorOfMe: ME,
    projectId: 'proj',
    lastSeen: '20261103T150000000-000000',
  })
  assert.deepEqual(result.lines, [], '自己刚发的不该被当成别人给你的消息')
})

test('游标之后的消息才出现，游标推进到最新', () => {
  const entries = board([
    ['20261103T160000000-cccccc', '', 'other', 'note', 'NEW-2'],
    ['20261103T155900000-bbbbbb', '', 'other', 'note', 'NEW-1'],
    ['20261103T155800000-aaaaaa', '', 'other', 'note', 'OLD'],
  ])
  const result = selectMessages({
    entries,
    label: ME,
    authorOfMe: ME,
    projectId: 'proj',
    lastSeen: '20261103T155800000-aaaaaa',
  })
  assert.equal(result.lines.length, 2, 'OLD 已经读过了')
  assert.equal(result.cursor, '20261103T160000000-cccccc')
})

test('游标停住时不再重复输出（30 分钟缓存事故的等价断言）', () => {
  const entries = board([['20261103T160000000-aaaaaa', '', 'other', 'note', 'once only']])
  const first = selectMessages({
    entries,
    label: ME,
    authorOfMe: ME,
    projectId: 'proj',
    lastSeen: '20261103T150000000-000000',
  })
  assert.equal(first.lines.length, 1)
  const second = selectMessages({
    entries,
    label: ME,
    authorOfMe: ME,
    projectId: 'proj',
    lastSeen: first.cursor,
  })
  assert.deepEqual(second.lines, [], '同一条消息第二次必须消失')
})

test('首次接入不倒历史，只给出积压条数', () => {
  const entries = board([
    ['20261103T160000000-dddddd', '', 'other', 'note', 'h4'],
    ['20261103T150000000-cccccc', '', 'other', 'note', 'h3'],
    ['20261103T140000000-bbbbbb', '', 'other', 'note', 'h2'],
    ['20261103T130000000-aaaaaa', '', 'other', 'note', 'h1'],
  ])
  const result = selectMessages({
    entries,
    label: ME,
    authorOfMe: ME,
    projectId: 'proj',
    lastSeen: '',
  })
  assert.equal(result.firstSight, true)
  assert.deepEqual(result.lines, [], '首次不该把历史全文倒进开场提示')
  assert.equal(result.backlog, 4)
  assert.equal(result.cursor, '20261103T160000000-dddddd', '游标要跳到最新，历史才算已读')
})

test('首次接入的积压也排除自己的消息', () => {
  const entries = board([
    ['20261103T160000000-bbbbbb', '', ME, 'note', 'mine'],
    ['20261103T150000000-aaaaaa', '', 'other', 'note', 'theirs'],
  ])
  const result = selectMessages({
    entries,
    label: ME,
    authorOfMe: ME,
    projectId: 'proj',
    lastSeen: '',
  })
  assert.equal(result.backlog, 1, '只数别人的')
})

test('超过 5 条时截断并告知剩余数', () => {
  const specs = []
  for (let i = 1; i <= 8; i += 1) {
    specs.push([`20261103T16000${i}0000-aaaaa${i}`, '', 'other', 'note', `m${i}`])
  }
  const entries = board(specs)
  const result = selectMessages({
    entries,
    label: ME,
    authorOfMe: ME,
    projectId: 'proj',
    lastSeen: '20261103T150000000-000000',
  })
  assert.equal(result.lines.length, 8, '选择层全部返回')
  const block = renderMessageBlock(result.lines, 0)
  assert.match(block, /8 条新/)
  assert.match(block, /另有 3 条/, '渲染层截断到 5 条')
})

test('渲染：空则空串，只有积压时给一行提示', () => {
  assert.equal(renderMessageBlock([], 0), '')
  const backlogOnly = renderMessageBlock([], 12)
  assert.match(backlogOnly, /12 条历史消息/)
  assert.doesNotMatch(backlogOnly, /条新/)
})

test('渲染：urgent 类别在行内标出', () => {
  const entries = board([['20261103T160000000-aaaaaa', ME, 'other', 'warning', 'cache full']])
  const result = selectMessages({
    entries,
    label: ME,
    authorOfMe: ME,
    projectId: undefined,
    lastSeen: '20261103T150000000-000000',
  })
  const block = renderMessageBlock(result.lines, 0)
  assert.match(block, /warning/)
  assert.ok(LOUD_KINDS.includes('warning'))
})

test('空 board 不崩溃，游标保持原值', () => {
  const result = selectMessages({
    entries: [],
    label: ME,
    authorOfMe: ME,
    projectId: 'proj',
    lastSeen: '20261103T150000000-000000',
  })
  assert.deepEqual(result.lines, [])
  assert.equal(result.cursor, '20261103T150000000-000000')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) {
    console.error(`\n--- ${failure.name} ---`)
    console.error(failure.error)
  }
  process.exitCode = 1
}
