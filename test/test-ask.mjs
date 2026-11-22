/**
 * Tests for the question-shape policy.
 *
 * The whole point of this guard is to make asking cheaper for the user, so the
 * allow-cases matter as much as the block-cases: a good question — two options,
 * recommendation first — must sail through untouched.
 */
import assert from 'node:assert/strict'
import { MAX_QUESTIONS, askVerdict } from '../lib/ask-policy.js'

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

function q(options, label = '问题') {
  return { question: label, options: options.map((text) => ({ label: text, description: '' })) }
}

console.log('ask-policy.js')

test('好问题放行：2 个选项，推荐项在前', () => {
  const verdict = askVerdict({
    questions: [q(['方案 A（推荐）', '方案 B'], '用哪个方案？')],
  })
  assert.equal(verdict, null)
})

test('好问题放行：3 个问题 + 带选项', () => {
  const verdict = askVerdict({
    questions: [q(['是（推荐）', '否']), q(['a', 'b']), q(['x', 'y', 'z'])],
  })
  assert.equal(verdict, null, '3 个是上限，应放行')
})

test('没有选项被拒（用户要打字才能答）', () => {
  const verdict = askVerdict({ questions: [{ question: '你的网络环境是什么？', options: [] }] })
  assert.ok(verdict !== null)
  assert.match(verdict.message, /没有给出选项/)
})

test('只有一个选项被拒（那是通知不是提问）', () => {
  const verdict = askVerdict({ questions: [q(['只有这个'])] })
  assert.ok(verdict !== null)
  assert.match(verdict.message, /只有一个选项/)
})

test('超过 3 个问题被拒（对话变表格）', () => {
  const questions = [q(['a', 'b']), q(['c', 'd']), q(['e', 'f']), q(['g', 'h'])]
  const verdict = askVerdict({ questions })
  assert.ok(verdict !== null)
  assert.match(verdict.message, /一次问了 4 个问题/)
  assert.match(verdict.message, /1–3 个/)
})

test('选项缺 label 被拒', () => {
  const verdict = askVerdict({
    questions: [{ question: '选哪个？', options: [{ label: 'A' }, { description: '没有 label' }] }],
  })
  assert.ok(verdict !== null)
  assert.match(verdict.message, /缺少 label/)
})

test('多个问题各有毛病时逐条列出', () => {
  const verdict = askVerdict({
    questions: [{ question: 'q1', options: [] }, { question: 'q2', options: [{ label: 'only' }] }],
  })
  assert.ok(verdict !== null)
  assert.match(verdict.message, /第 1 个问题/)
  assert.match(verdict.message, /第 2 个问题/)
})

test('拒绝消息说明如何改好 + 提及先自查', () => {
  const verdict = askVerdict({ questions: [{ question: 'q', options: [] }] })
  assert.ok(verdict !== null)
  assert.match(verdict.message, /带选项/)
  assert.match(verdict.message, /推荐的那一项放在\*\*第一个\*\*/)
  assert.match(verdict.message, /自己查/)
})

test('不在拒绝消息里承诺超时（插件做不到）', () => {
  // Deep PTC can time-box ask_user_question because it wraps the tool at the
  // preset layer. A host plugin cannot, so promising a timeout would be a lie.
  const verdict = askVerdict({ questions: [{ question: 'q', options: [] }] })
  assert.doesNotMatch(verdict.message, /超时|timeout|等待\s*\d+\s*秒/)
})

test('空问题列表放行（没什么可拦）', () => {
  assert.equal(askVerdict({ questions: [] }), null)
  assert.equal(askVerdict({}), null)
  assert.equal(askVerdict(null), null)
})

test('异常选项结构不崩溃', () => {
  assert.equal(askVerdict({ questions: [null] }) !== null, true)
  assert.equal(askVerdict({ questions: [{}] }) !== null, true)
})

test('MAX_QUESTIONS 常量为 3', () => {
  assert.equal(MAX_QUESTIONS, 3)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) {
    console.error(`\n--- ${failure.name} ---`)
    console.error(failure.error)
  }
  process.exitCode = 1
}
