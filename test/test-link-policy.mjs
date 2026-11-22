/**
 * Tests for lib/link-policy.js.
 *
 * 这个模块此前完全没有测试覆盖，而它管的正是「什么时候算同一个失败」——
 * 断路器就靠它计数。2026-11-22 那次会话被锁死在自己的工具之外，根因就在
 * 这里：指纹只回答「文本像不像错误」，从不回答「这次失败是不是我的锅」。
 *
 * 另附 readOnlyCommand —— Trace Mode 要求「读消费端源码、抓真实日志、抓真实
 * 网络包」，这些动作全要过 shell；一边禁 shell 一边要求 shell 取证就是死锁。
 * 所以侦察类命令必须放行，只有真正会改东西的才拦。
 */
import assert from 'node:assert/strict'
import {
  failureFingerprint,
  isReadOnlyCommand,
  readOnlyCommandReason,
  threeQuestions,
} from '../lib/link-policy.js'

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

console.log('link-policy.js')

/* ------------------------------------------------- failureFingerprint */

test('failureFingerprint: 非错误文本返回空串', () => {
  assert.equal(failureFingerprint(''), '')
  assert.equal(failureFingerprint('构建完成，一切正常'), '')
  assert.equal(failureFingerprint(undefined), '')
})

test('failureFingerprint: 同一错误去掉数字后归一', () => {
  const a = failureFingerprint('Error: cannot open port 8080 after 3000 ms')
  const b = failureFingerprint('Error: cannot open port 9090 after 1200 ms')
  assert.equal(a, b)
})

test('failureFingerprint: 十六进制地址被抹平', () => {
  const a = failureFingerprint('fatal: segfault at 0x7ffd1234abcd')
  const b = failureFingerprint('fatal: segfault at 0x55aa99887766')
  assert.equal(a, b)
  assert.ok(!a.includes('0x'), `不该残留十六进制：${a}`)
})

test('failureFingerprint: 不同错误得到不同指纹', () => {
  const a = failureFingerprint('Error: cannot find module')
  const b = failureFingerprint('Error: permission denied')
  assert.notEqual(a, b)
})

test('failureFingerprint: 长度截断到 160', () => {
  const long = `Error: ${'a'.repeat(400)}`
  assert.ok(failureFingerprint(long).length <= 160)
})

/* ---------------------------------------- readOnlyCommand (Trace Mode) */

// 这些正是 Trace Mode 要求模型去跑的命令。拦住它们，断路器就成了单向门。
const INSPECTION = [
  'Get-Content app.log',
  'Get-Content -Tail 100 /var/log/nginx/error.log',
  'Select-String -Path lib/index.js -Pattern "guard"',
  'Get-ChildItem test',
  'Test-Path ./dist',
  'grep -rn "WRITE_TOOLS" lib/',
  'cat /var/log/nginx/access.log',
  'tail -n 50 error.log',
  'head -20 package.json',
  'ls -la',
  'find . -name "*.log"',
  'wc -l lib/index.js',
  'git log --oneline -5',
  'git status --short',
  'git diff --stat',
  'netstat -tnp',
  'ss -tnp',
  'ps aux',
  'docker logs myapp',
  'curl -i http://127.0.0.1:8080/health',
  'node --check lib/index.js',
]

const MUTATING = [
  'Set-Content -Path f.txt -Value x',
  'Add-Content f.txt "x"',
  'Out-File -FilePath f.txt',
  'New-Item -ItemType File f.txt',
  'Remove-Item -Recurse dist',
  'Move-Item a b',
  'Copy-Item a b',
  'echo x > f.txt',
  'echo x >> f.txt',
  'rm -rf dist',
  'mv a b',
  'cp a b',
  'mkdir newdir',
  'touch f.txt',
  'sed -i "s/a/b/" f.txt',
  'git add -A',
  'git commit -m "x"',
  'git push origin main',
  'git reset --hard HEAD~1',
  'npm install',
  'npm test',
  'pnpm add lodash',
  'node scripts/build.mjs',
  'python setup.py install',
  'curl -o out.bin http://example.com/x',
  'wget http://example.com/x',
  'scp a.host:f .',
  'rsync -av a/ b/',
  'tee out.log',
  'dd if=/dev/zero of=f bs=1M count=1',
]

test('readOnlyCommand: 侦察类命令被放行', () => {
  for (const command of INSPECTION) {
    assert.equal(isReadOnlyCommand(command), true, `应放行：${command}`)
  }
})

test('readOnlyCommand: 会改东西的命令被拒绝', () => {
  for (const command of MUTATING) {
    assert.equal(isReadOnlyCommand(command), false, `应拒绝：${command}`)
  }
})

test('readOnlyCommand: 空命令不算写入', () => {
  assert.equal(isReadOnlyCommand(''), true)
  assert.equal(isReadOnlyCommand('   '), true)
  assert.equal(isReadOnlyCommand(undefined), true)
})

test('readOnlyCommand: 管道里只要有一环写入就拒绝', () => {
  // 管道正是「读」变成「写」的常见路径，整行必须干净。
  assert.equal(isReadOnlyCommand('Get-Content a.log | Select-String "error"'), true)
  assert.equal(isReadOnlyCommand('Get-Content a.log | Set-Content b.log'), false)
  assert.equal(isReadOnlyCommand('cat a | tee b'), false)
  assert.equal(isReadOnlyCommand('grep x f | head -3 > out.txt'), false)
})

test('readOnlyCommand: 命令链里只要有一环写入就拒绝', () => {
  assert.equal(isReadOnlyCommand('Get-ChildItem && Get-Content a.log'), true)
  assert.equal(isReadOnlyCommand('Get-Content a.log; Remove-Item b'), false)
  assert.equal(isReadOnlyCommand('ls && rm -rf dist'), false)
})

test('readOnlyCommand: 比较运算符不被误判为输出重定向', () => {
  // `-gt`、`=>`、`->` 都不是重定向。把 `>` 一律当写入，会拦掉无辜的侦察命令，
  // 让放行名单形同虚设。
  assert.equal(isReadOnlyCommand('Get-ChildItem | Where-Object { $_.Length -gt 1024 }'), true)
  assert.equal(isReadOnlyCommand('grep -n "a=>b" f.js'), true)
  assert.equal(isReadOnlyCommand('Select-String -Pattern "x->y" f.js'), true)
})

test('readOnlyCommandReason: 放行时无理由', () => {
  assert.equal(readOnlyCommandReason('Get-Content a.log'), '')
})

test('readOnlyCommandReason: 拒绝时指出命中的命令', () => {
  const reason = readOnlyCommandReason('Set-Content -Path f.txt -Value x')
  assert.ok(reason.length > 0, '应给出拒绝理由')
  assert.ok(reason.includes('Set-Content'), `理由应指出命中的命令：${reason}`)
})

test('readOnlyCommandReason: 拒绝理由指出重定向', () => {
  const reason = readOnlyCommandReason('echo x > f.txt')
  assert.ok(reason.includes('重定向'), `理由应指出重定向：${reason}`)
})

/* ------------------------------------------------------- threeQuestions */

test('threeQuestions: 列出部署链路三问', () => {
  const text = threeQuestions({ target: 'dist/app.js', hops: ['nginx'], consumer: 'CDN' })
  assert.ok(text.includes('谁在消费你改的这个东西'))
  assert.ok(text.includes('消费者去哪里找它'))
  assert.ok(text.includes('隔着几道环节'))
  assert.ok(text.includes('dist/app.js'))
})

test('threeQuestions: 缺少中间层时要求自查', () => {
  const text = threeQuestions({})
  assert.ok(text.includes('自己判断'))
})

/* -------------------------------------------------------------- 汇总 */

console.log(`\n${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  console.log('\n失败详情：')
  for (const { name, error } of failures) {
    console.log(`\n${name}\n${error.message}`)
  }
}
process.exit(failed > 0 ? 1 : 0)
