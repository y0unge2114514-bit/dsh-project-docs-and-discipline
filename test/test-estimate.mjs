/**
 * Tests for the plan-by-size policy.
 *
 * Two things matter here and both are asserted below:
 *   1. It reads durations the agent actually wrote — Chinese and English.
 *   2. It stays silent when there is nothing to check. A gate that fires on
 *      every message ("I'll take a look") is a gate the agent learns to ignore.
 */
import assert from 'node:assert/strict'
import {
  BANDS,
  bandOf,
  describeMinutes,
  estimateVerdict,
  extractEstimates,
  looksLikePlan,
  looksWaiting,
} from '../lib/estimate-policy.js'

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

console.log('estimate-policy.js')

test('档位边界：5 分钟和 20 分钟', () => {
  assert.equal(bandOf(1), 'inline')
  assert.equal(bandOf(5), 'inline', '5 分钟是 inline 的上界')
  assert.equal(bandOf(5.1), 'announce')
  assert.equal(bandOf(20), 'announce', '20 分钟是 announce 的上界')
  assert.equal(bandOf(20.1), 'approve')
  assert.equal(bandOf(120), 'approve')
})

test('提取中文估算：分钟 / 小时 / 天', () => {
  assert.deepEqual(extractEstimates('预计 30 分钟'), [30])
  assert.deepEqual(extractEstimates('大约 2 小时'), [120])
  assert.deepEqual(extractEstimates('可能需要 3 天'), [4320])
  assert.deepEqual(extractEstimates('半个小时就够'), [30])
  assert.deepEqual(extractEstimates('两小时'), [120])
  assert.deepEqual(extractEstimates('二十分钟'), [20])
})

test('提取英文估算', () => {
  assert.deepEqual(extractEstimates('about 20 min'), [20])
  assert.deepEqual(extractEstimates('roughly 2 hours'), [120])
  assert.deepEqual(extractEstimates('1.5h'), [90])
  assert.deepEqual(extractEstimates('30 minutes'), [30])
})

test('裸数字不算估算（"3 个文件"不是时间）', () => {
  assert.deepEqual(extractEstimates('改了 3 个文件'), [])
  assert.deepEqual(extractEstimates('涉及 12 处调用'), [])
  assert.deepEqual(extractEstimates('端口 8080'), [])
})

test('多段估算取最大值', () => {
  const verdict = estimateVerdict('第一步 2 分钟，整件事大约 45 分钟')
  assert.ok(verdict !== null)
  assert.equal(verdict.minutes, 45, '整件事的时长才是档位依据')
  assert.equal(verdict.band, 'approve')
})

test('≤5 分钟：不提示（该闷头做）', () => {
  assert.equal(estimateVerdict('这个大概 3 分钟，我直接改。'), null)
})

test('5–20 分钟：没给计划就提示', () => {
  const verdict = estimateVerdict('这活大约 10 分钟。')
  assert.ok(verdict !== null)
  assert.equal(verdict.band, 'announce')
  assert.match(verdict.message, /5–20 分钟/)
  assert.match(verdict.message, /先把计划展示出来/)
})

test('5–20 分钟：已给计划则不提示', () => {
  const text = '约 10 分钟。\n1. 改 index.js\n2. 跑测试验证\n3. 备份回滚点'
  assert.equal(estimateVerdict(text, { planVisible: true }), null)
})

test('>20 分钟：没等批准就提示', () => {
  const verdict = estimateVerdict('这个迁移预计要 2 小时。')
  assert.ok(verdict !== null)
  assert.equal(verdict.band, 'approve')
  assert.match(verdict.message, /超过 20 分钟/)
  assert.match(verdict.message, /等用户批准/)
})

test('>20 分钟：已声明在等批准则不提示', () => {
  const verdict = estimateVerdict('迁移预计 2 小时，计划如上，等你确认后我再开始。', { waiting: true })
  assert.equal(verdict, null)
})

test('没有时间估算的普通回复：完全静默', () => {
  for (const text of ['我改好了。', '测试全部通过。', '要删掉旧备份吗？', '好的，先看一眼代码。', '']) {
    assert.equal(estimateVerdict(text), null, `不该提示：${text}`)
  }
})

test('looksLikePlan：编号列表 + 具体产物才算计划', () => {
  assert.ok(looksLikePlan('1. 改 index.js\n2. 跑 test-kb.js 验证'))
  assert.ok(looksLikePlan('- 修改 scripts/a.mjs\n- 备份再改'))
  assert.ok(!looksLikePlan('我会修好的。'), '一句话不是计划')
  assert.ok(!looksLikePlan('1. 看看\n2. 想想'), '没有具体产物')
})

test('looksWaiting：识别等批准的措辞', () => {
  for (const text of ['等你确认后我再开始', '请确认', '需要你拍板', '你同意后我再动']) {
    assert.ok(looksWaiting(text), `应识别：${text}`)
  }
  for (const text of ['我已经改好了', '测试通过']) {
    assert.ok(!looksWaiting(text), `不该识别：${text}`)
  }
})

test('describeMinutes 措辞自然', () => {
  assert.equal(describeMinutes(0.5), '30 秒')
  assert.equal(describeMinutes(30), '30 分钟')
  assert.equal(describeMinutes(60), '1 小时')
  assert.equal(describeMinutes(90), '1.5 小时')
})

test('BANDS 常量与文档一致', () => {
  assert.equal(BANDS.inline, 5)
  assert.equal(BANDS.announce, 20)
})

test('异常输入不崩溃', () => {
  assert.deepEqual(extractEstimates(''), [])
  assert.deepEqual(extractEstimates(undefined), [])
  assert.deepEqual(extractEstimates(null), [])
  assert.equal(bandOf(NaN), 'inline')
  assert.equal(bandOf(-5), 'inline')
  assert.equal(estimateVerdict(undefined), null)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) {
    console.error(`\n--- ${failure.name} ---`)
    console.error(failure.error)
  }
  process.exitCode = 1
}
