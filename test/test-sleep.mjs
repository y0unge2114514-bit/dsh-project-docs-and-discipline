/**
 * Tests for the long-sleep refusal.
 *
 * The risk here is false positives: a readiness loop that legitimately sleeps
 * one second must keep working, and a backgrounded command must never be
 * touched. Both are asserted below, because a guard that misfires gets disabled.
 */
import assert from 'node:assert/strict'
import {
  MAX_FOREGROUND_SLEEP_SECONDS,
  describeSeconds,
  extractSleeps,
  sleepVerdict,
} from '../lib/sleep-policy.js'

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

console.log('sleep-policy.js')

test('提取 bash sleep：秒 / 分钟 / 毫秒', () => {
  assert.deepEqual(extractSleeps('sleep 60'), [60])
  assert.deepEqual(extractSleeps('sleep 1.5s'), [1.5])
  assert.deepEqual(extractSleeps('sleep 2m'), [120])
  assert.deepEqual(extractSleeps('sleep 500ms'), [0.5])
  assert.deepEqual(extractSleeps('cd /tmp && sleep 30 && curl x'), [30])
})

test('提取 PowerShell Start-Sleep 两种写法', () => {
  assert.deepEqual(extractSleeps('Start-Sleep -Seconds 30'), [30])
  assert.deepEqual(extractSleeps('Start-Sleep -s 45'), [45])
  assert.deepEqual(extractSleeps('Start-Sleep -Milliseconds 800'), [0.8])
})

test('提取 cmd timeout /t', () => {
  assert.deepEqual(extractSleeps('timeout /t 20'), [20])
  assert.deepEqual(extractSleeps('timeout /t 20 /nobreak'), [20])
})

test('提取 ping -n 长等（Windows 常用写法）', () => {
  assert.deepEqual(extractSleeps('ping -n 30 127.0.0.1 >nul'), [29])
  assert.deepEqual(extractSleeps('ping -n 2 127.0.0.1 >nul'), [1])
})

test('多个暂停取最长', () => {
  const sleeps = extractSleeps('sleep 10 && sleep 45')
  assert.deepEqual(sleeps, [10, 45])
})

test('没有暂停的命令：不拦', () => {
  for (const cmd of ['ls -la', 'node test.js', 'git status', 'curl -s http://x/', '']) {
    assert.equal(sleepVerdict({ toolName: 'ops_bash', args: { command: cmd } }), null, `不该拦：${cmd}`)
  }
})

test('5 秒以内的暂停放行（就绪轮询需要它）', () => {
  for (const cmd of ['sleep 1', 'sleep 3', 'sleep 5', 'Start-Sleep -s 2', 'timeout /t 4']) {
    assert.equal(sleepVerdict({ toolName: 'ops_bash', args: { command: cmd } }), null, `不该拦：${cmd}`)
  }
})

test('超过 5 秒的前台暂停被拒绝', () => {
  for (const cmd of ['sleep 60', 'sleep 30 && echo done', 'Start-Sleep -Seconds 30', 'timeout /t 20', 'ping -n 30 127.0.0.1 >nul']) {
    const verdict = sleepVerdict({ toolName: 'ops_bash', args: { command: cmd } })
    assert.ok(verdict !== null, `应拦截：${cmd}`)
  }
})

test('拒绝消息给出三条替代做法', () => {
  const verdict = sleepVerdict({ toolName: 'ops_bash', args: { command: 'sleep 60' } })
  assert.ok(verdict !== null)
  assert.equal(verdict.seconds, 60)
  assert.match(verdict.message, /轮询代替等待/)
  assert.match(verdict.message, /转后台|run_in_background/)
  assert.match(verdict.message, /缩短等待/)
  assert.match(verdict.message, /只拦截一次/, '必须说明如何解禁')
})

test('run_in_background 的命令一律放行（那正是推荐做法）', () => {
  const verdict = sleepVerdict({
    toolName: 'ops_bash',
    args: { command: 'sleep 300', run_in_background: true },
  })
  assert.equal(verdict, null, '后台任务里的等待不影响任何人')
})

test('runInBackground 驼峰写法同样放行', () => {
  const verdict = sleepVerdict({ toolName: 'pwsh', args: { command: 'sleep 300', runInBackground: true } })
  assert.equal(verdict, null)
})

test('script / script_path 形态也能检查', () => {
  assert.ok(sleepVerdict({ toolName: 'ops_bash', args: { script: 'sleep 120' } }) !== null)
  assert.ok(sleepVerdict({ toolName: 'ops_bash', args: { script_path: 'sleep 120' } }) !== null)
})

test('参数缺失不崩溃', () => {
  assert.equal(sleepVerdict({}), null)
  assert.equal(sleepVerdict({ args: null }), null)
  assert.equal(sleepVerdict({ args: { command: 123 } }), null)
  assert.equal(sleepVerdict({ toolName: 'ops_bash', args: {} }), null)
})

test('timeout 不带 /t 不算暂停（那是杀进程）', () => {
  assert.deepEqual(extractSleeps('timeout --kill-after 5 curl x'), [])
})

test('describeSeconds 措辞', () => {
  assert.equal(describeSeconds(30), '30 秒')
  assert.equal(describeSeconds(60), '1 分钟')
  assert.equal(describeSeconds(90), '1.5 分钟')
})

test('阈值常量与文档一致', () => {
  assert.equal(MAX_FOREGROUND_SLEEP_SECONDS, 5)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) {
    console.error(`\n--- ${failure.name} ---`)
    console.error(failure.error)
  }
  process.exitCode = 1
}
