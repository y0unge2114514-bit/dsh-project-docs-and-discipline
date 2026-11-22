/**
 * Tests for the "did you read the docs?" decision.
 *
 * The bar for adding these rules is high: a gate that fires on legitimate
 * questions gets turned off, and then it protects nobody. So every allow-case
 * below is a question an agent should genuinely be allowed to ask, and every
 * block-case is a phrasing the user actually complained about.
 */
import assert from 'node:assert/strict'
import { docNeed, docNeedMessage, FACT_ASSERTION, REQUIRED_DOCS } from '../lib/doc-need.js'

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

const unread = { readAny: false, isFirstTurn: true }
const read = { readAny: true, isFirstTurn: true }

console.log('doc-need.js')

test('已读文档后不再拦截任何内容', () => {
  const result = docNeed('请问网络环境是什么？端口是多少？127.0.0.1:8080', read)
  assert.equal(result.needsDocs, false)
})

test('回归：询问网络环境被拦（用户投诉的原话场景）', () => {
  for (const text of [
    '请问这个项目的网络环境是什么？',
    '我需要确认一下服务器部署在哪里',
    '你们那边环境是怎么配的？',
    '是不是校园网内网？',
    '端口是多少？',
  ]) {
    const result = docNeed(text, unread)
    assert.equal(result.needsDocs, true, `应拦截：${text}`)
  }
})

test('回归：开场就断言具体事实被拦（基础知识错误）', () => {
  for (const text of [
    '服务运行在 127.0.0.1:8080 上，走的是内网。',
    '你的项目在 D 盘 example-app 目录下。',
    'VPS 的 IP 是 203.0.113.10。',
    '用的是 Node v20.11.1。',
    '端口 8000 是主站。',
  ]) {
    const result = docNeed(text, unread)
    assert.equal(result.needsDocs, true, `应拦截：${text}`)
  }
})

test('放行：与项目文档无关的正常提问', () => {
  for (const text of [
    '要我删掉旧备份吗？',
    '这个功能你希望放在首页还是设置页？',
    '我可以先跑一遍测试再改吗？',
    '需要我同时更新 README 吗？',
    '这两种方案你倾向哪个？',
    '好的，我先看一下代码。',
  ]) {
    const result = docNeed(text, unread)
    assert.equal(result.needsDocs, false, `不该拦：${text}`)
  }
})

test('放行：空消息与无内容', () => {
  assert.equal(docNeed('', unread).needsDocs, false)
  assert.equal(docNeed('   ', unread).needsDocs, false)
  assert.equal(docNeed(undefined, unread).needsDocs, false)
})

test('非首轮不再因"断言事实"被拦（可能已从工具结果得知）', () => {
  const later = { readAny: false, isFirstTurn: false }
  assert.equal(docNeed('端口 8001 是主站。', later).needsDocs, false)
})

test('但非首轮仍会因"问已写明的背景"被拦', () => {
  const later = { readAny: false, isFirstTurn: false }
  assert.equal(docNeed('请问网络环境是什么？', later).needsDocs, true, '问背景跟第几轮无关')
})

test('FACT_ASSERTION 命中各类具体事实', () => {
  for (const text of ['端口 8080', '监听 127.0.0.1:3000', '192.168.1.1', 'v20.11.1']) {
    assert.ok(FACT_ASSERTION.test(text), `应命中：${text}`)
  }
  for (const text of ['我建议先跑测试', '这个功能可以拆成两步', '好的']) {
    assert.ok(!FACT_ASSERTION.test(text), `不该命中：${text}`)
  }
})

test('门禁消息含项目名、要读的文件、放行条件', () => {
  const message = docNeedMessage('proj-netdisk', 'asking for background that PROJECT.md / COLLAB.md already states')
  assert.match(message, /proj-netdisk/)
  for (const doc of REQUIRED_DOCS) assert.ok(message.includes(doc), `应提到 ${doc}`)
  assert.match(message, /读一份即可继续/, '必须说明如何解禁，否则 agent 会跟门禁吵架')
})

test('门禁消息对两种原因措辞不同', () => {
  const a = docNeedMessage('p', 'asking for background that PROJECT.md / COLLAB.md already states')
  const b = docNeedMessage('p', 'stating project-specific facts before reading the project docs')
  assert.match(a, /询问的背景信息/)
  assert.match(b, /陈述的项目事实/)
  assert.notEqual(a, b)
})

test('环境类提问确实会命中（明确的设计决定，非意外）', () => {
  const result = docNeed('你希望在哪个环境里预览？本地还是线上？', unread)
  assert.equal(result.needsDocs, true, '环境类问题优先读文档，读不到再问')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) {
    console.error(`\n--- ${failure.name} ---`)
    console.error(failure.error)
  }
  process.exitCode = 1
}
