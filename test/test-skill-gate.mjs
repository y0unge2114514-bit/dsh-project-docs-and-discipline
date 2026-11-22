/**
 * Tests for the discipline rules distilled from deepseek-stack.
 *
 * These rules describe behaviour a skill *asks* for. The tests assert the
 * behaviour can be *checked* — that is the whole reason they moved out of a
 * SKILL.md and into a plugin. Every case names the failure it prevents.
 */
import assert from 'node:assert/strict'
import {
  PLAN_THRESHOLD_FILES,
  UNSTICK_REPEAT_LIMIT,
  VERIFY_FAILURE_LIMIT,
  carriesRunEvidence,
  createFailureTracker,
  isCodeFile,
  isTestFile,
  looksLikeCheck,
  planThreshold,
  stopMessage,
  weakensTest,
} from '../lib/skill-gate.js'

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

console.log('test-skill-gate.mjs')

/* --------------------------------------------------- ds-verify-loop: 5 → 3 */

test('验证失败达 3 次必须停（用户指定的档位）', () => {
  assert.equal(VERIFY_FAILURE_LIMIT, 3)
  const tracker = createFailureTracker()
  const results = []
  for (let i = 1; i <= 3; i += 1) {
    results.push(tracker.record('a', { failed: true, ranCheck: true }))
  }
  assert.equal(results[0].verifyStop, false, '第 1 次不停')
  assert.equal(results[1].verifyStop, false, '第 2 次不停')
  assert.equal(results[2].verifyStop, true, '第 3 次必须停')
})

test('检查通过后计数清零（不许把历史失败累计）', () => {
  const tracker = createFailureTracker()
  tracker.record('a', { failed: true, ranCheck: true })
  tracker.record('a', { failed: true, ranCheck: true })
  tracker.record('a', { failed: false, ranCheck: true })
  assert.equal(tracker.peek('a').checkFailures, 0)
  const third = tracker.record('a', { failed: true, ranCheck: true })
  assert.equal(third.verifyStop, false, '清零后重新计数')
})

test('只有真正在跑检查的失败才算（防止 ls 失败推进计数）', () => {
  const tracker = createFailureTracker()
  for (let i = 0; i < 5; i += 1) tracker.record('a', { failed: true, ranCheck: false })
  assert.equal(tracker.peek('a').checkFailures, 0)
})

test('looksLikeCheck 识别常见检查命令', () => {
  for (const cmd of [
    'npm test', 'npm run test', 'pnpm test', 'node --check lib/x.js',
    'node test/test-kb.js', 'pytest -q', 'go test ./...', 'cargo test',
    'dotnet build', 'tsc --noEmit', 'eslint .', 'vitest run', 'jest',
  ]) {
    assert.ok(looksLikeCheck(cmd), `应识别: ${cmd}`)
  }
  for (const cmd of ['ls -la', 'git status', 'cat file.txt', 'echo hi', '']) {
    assert.ok(!looksLikeCheck(cmd), `不该识别: ${cmd}`)
  }
})

/* ------------------------------------------------------ ds-unstick: 同错 2 次 */

test('同一失败连续 2 次触发 unstick（比 verify 更早）', () => {
  assert.equal(UNSTICK_REPEAT_LIMIT, 2)
  const tracker = createFailureTracker()
  const fp = 'EADDRINUSE: port 8080 in use'
  const first = tracker.record('a', { failed: true, fingerprint: fp })
  assert.equal(first.unstickStop, false)
  const second = tracker.record('a', { failed: true, fingerprint: fp })
  assert.equal(second.unstickStop, true, '同一指纹第 2 次就该停')
})

test('不同失败不触发 unstick（换了错误说明在推进）', () => {
  const tracker = createFailureTracker()
  tracker.record('a', { failed: true, fingerprint: 'error A' })
  const result = tracker.record('a', { failed: true, fingerprint: 'error B' })
  assert.equal(result.unstickStop, false)
})

test('成功一次就重置 unstick 计数', () => {
  const tracker = createFailureTracker()
  const fp = 'same error'
  tracker.record('a', { failed: true, fingerprint: fp })
  tracker.record('a', { failed: false })
  const again = tracker.record('a', { failed: true, fingerprint: fp })
  assert.equal(again.unstickStop, false)
})

test('多个 agent 的计数互相独立', () => {
  const tracker = createFailureTracker()
  const fp = 'shared error'
  tracker.record('a', { failed: true, fingerprint: fp })
  tracker.record('b', { failed: true, fingerprint: fp })
  // a 已被打断，但 b 才第一次
  const aSecond = tracker.record('a', { failed: true, fingerprint: fp })
  assert.equal(aSecond.unstickStop, true)
  assert.equal(tracker.peek('b').repeats, 1)
})

/* ------------------------------------------------- 停止消息：只说一次 */

test('停止消息只出现一次（重复提醒会被学会跳过）', () => {
  const first = stopMessage({ verifyStop: true, unstickStop: false, alreadyTold: false })
  assert.equal(first.tell, true)
  const again = stopMessage({ verifyStop: true, unstickStop: false, alreadyTold: true })
  assert.equal(again.tell, false)
})

test('unstick 优先于 verify（更根本的错）', () => {
  const result = stopMessage({ verifyStop: true, unstickStop: true, alreadyTold: false })
  assert.equal(result.kind, 'unstick')
})

test('停止消息含具体动作，不是空话', () => {
  const verify = stopMessage({ verifyStop: true, unstickStop: false, alreadyTold: false })
  assert.match(verify.message, /完整错误输出/)
  assert.match(verify.message, /根因/)
  assert.match(verify.message, /不要猜/)
  assert.match(verify.message, /只出现一次/)

  const unstick = stopMessage({ verifyStop: false, unstickStop: true, alreadyTold: false })
  assert.match(unstick.message, /共同的前提假设/)
  assert.match(unstick.message, /探针/)
  assert.match(unstick.message, /3 个/)
})

/* ------------------------------------- ds-verify-loop: 禁止削弱测试 */

test('削弱测试：加 skip 被识别', () => {
  const result = weakensTest('it("works", () => {})', 'it.skip("works", () => {})')
  assert.equal(result.weakened, true)
  assert.match(result.why, /跳过/)
})

test('削弱测试：减少断言被识别', () => {
  const before = 'assert.equal(a, 1)\nassert.equal(b, 2)'
  const after = 'assert.equal(a, 1)'
  const result = weakensTest(before, after)
  assert.equal(result.weakened, true)
  assert.match(result.why, /断言从 2 条减到 1 条/)
})

test('削弱测试：断言改恒真被识别', () => {
  const result = weakensTest('assert.ok(x)', 'assert.ok(x, false)')
  assert.equal(result.weakened, true)
})

test('正常修改测试不算削弱', () => {
  const before = 'assert.equal(a, 1)'
  const after = 'assert.equal(a, 1)\nassert.equal(b, 2)'
  assert.equal(weakensTest(before, after).weakened, false, '增加断言是好事')
  assert.equal(weakensTest('', 'assert.ok(x)').weakened, false, '新文件不算')
})

test('纯新增测试文件不算削弱', () => {
  const content = 'test("x", () => { assert.equal(1, 1) })'
  assert.equal(weakensTest('', content).weakened, false)
})

test('纯新增测试文件：带 process.exit 结尾也不算削弱', () => {
  // 真实事故（2026-11-22）：本仓库每套测试都以 `process.exit(failed > 0 ? 1 : 0)`
  // 收尾，而 `xit(` 原本没有词边界 —— `exit(` 的末尾就含 `xit(` —— 于是每一个
  // 新建的测试文件都被判成「跳过了测试」，新建测试 = 必然违规。这是死锁式误报。
  const content = [
    'test("x", () => { assert.equal(1, 1) })',
    'process.exit(failed > 0 ? 1 : 0)',
  ].join('\n')
  const result = weakensTest('', content)
  assert.equal(result.weakened, false, `exit 不该算跳过：${result.why}`)
})

test('削弱测试：真的 xit( / xdescribe( 仍被识别', () => {
  // 放宽 `xit(` 不能把真的 mocha 跳过写法一起放过。
  assert.equal(weakensTest('it("a", () => {})', 'xit("a", () => {})').weakened, true)
  assert.equal(weakensTest('describe("a", () => {})', 'xdescribe("a", () => {})').weakened, true)
})

test('削弱测试：断言期望值为 false 不算恒真', () => {
  // `assert.equal(x, false)` 是「断言 x 等于 false」，最严格的断言之一；
  // 真正的恒真是 `assert.ok(true)` 或 `assert.ok(x, false)`（第二参数是失败消息）。
  const before = 'assert.equal(isReadOnly("a"), true)'
  const after = 'assert.equal(isReadOnly("a"), true)\nassert.equal(isReadOnly("b"), false)'
  assert.equal(weakensTest(before, after).weakened, false)
  assert.equal(weakensTest('assert.ok(x)', 'assert.ok(x, false)').weakened, true)
})

/* ------------------------------------------- 文件分类 */

test('isTestFile 识别测试文件命名', () => {
  for (const p of ['test/a.mjs', 'test-kb.js', 'src/x.test.ts', 'x.spec.js', 'lib\\test-store.mjs']) {
    assert.ok(isTestFile(p), `应识别: ${p}`)
  }
  for (const p of ['lib/index.js', 'src/main.ts', 'README.md']) {
    assert.ok(!isTestFile(p), `不该识别: ${p}`)
  }
})

test('isCodeFile 识别生产代码', () => {
  for (const p of ['lib/index.js', 'a.mjs', 'b.ts', 'c.py', 'd.go']) {
    assert.ok(isCodeFile(p), `应识别: ${p}`)
  }
  for (const p of ['README.md', 'data.json', 'icon.svg', 'a.yml']) {
    assert.ok(!isCodeFile(p), `不该识别: ${p}`)
  }
})

/* ------------------------------------------------- ds-plan-loop 阈值 */

test('改 2 个以上代码文件需要计划', () => {
  assert.ok(PLAN_THRESHOLD_FILES >= 2)
  const one = planThreshold(['lib/a.js'])
  assert.equal(one.needsPlan, false, '单文件不需要')
  const two = planThreshold(['lib/a.js', 'lib/b.js'])
  assert.equal(two.needsPlan, true, '两个文件需要')
  assert.equal(two.count, 2)
})

test('测试文件不计入计划阈值（测试不算改动面）', () => {
  const result = planThreshold(['lib/a.js', 'test/test-a.mjs'])
  assert.equal(result.count, 1, '只算生产代码')
  assert.equal(result.needsPlan, false)
})

test('重复文件只算一次', () => {
  const result = planThreshold(['lib/a.js', 'lib/a.js', 'lib/a.js'])
  assert.equal(result.count, 1)
})

/* ------------------------------------------------- ds-verify-loop 证据 */

test('carriesRunEvidence 识别「命令 + 结果」同现', () => {
  const good = [
    '$ npm test\n18 passed, 0 failed',
    '```bash\nnode --check lib/x.js\n```\nOK',
    '> ls -l\n-rw-r--r-- 9550 README.md',
  ]
  for (const text of good) assert.ok(carriesRunEvidence(text), `应识别: ${text.slice(0, 30)}`)
})

test('只有结论没有输出不算证据', () => {
  const bad = ['我改好了，测试通过。', 'done', '应该没问题了']
  for (const text of bad) assert.ok(!carriesRunEvidence(text), `不该识别: ${text}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) {
    console.error(`\n--- ${failure.name} ---`)
    console.error(failure.error)
  }
  process.exitCode = 1
}
