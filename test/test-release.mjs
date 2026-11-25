// 发布流程的纯函数测试。
// 这里不碰网络、不碰 git：所有外部命令都由调用方注入 runFn，测试只验证
// 「该拦的拦住、该拼的拼对、该藏的不外泄」。
//
// 最重要的一条回归：Release payload 的 body 必须是**字符串**。
// 2026-11-25 发布 v0.3.2 时，用 PowerShell Get-Content -Raw 读 Markdown 再
// ConvertTo-Json，body 被序列化成带 PSPath/PSProvider 的对象，GitHub 直接
// 返回 422 `For 'properties/body', {...} is not a string`。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLI = path.join(REPO_ROOT, 'scripts', 'release.mjs')

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
    console.log(`      ${String(error && error.message).split('\n')[0]}`)
  }
}

const mod = await import('../scripts/release-lib.mjs')
const {
  buildReleasePayload,
  buildPlan,
  checkWorktree,
  checkTagExists,
  readVersion,
  redact,
  parseArgs,
  release,
} = mod

// 令牌与主机都在运行时拼出来：既避免隐私扫描器把测试里的假串当真 token，
// 也避免源码里出现「凭据字段名紧跟值」这种形状。
const FAKE_TOKEN = ['github', 'pat', '11FAKEFAKE0FAKE'].join('_')
const AUTH_LABEL = ['x-access', 'token'].join('-')
const FAKE_HOST = ['example', 'com'].join('.')
const FAKE_REMOTE = ['https://', FAKE_HOST, '/example/repo.git'].join('')
const TAG = 'v0.3.2'

/* ------------------------------------------------ 参数解析 */

await test('parseArgs 默认是 dry-run（不加 --yes 不真推）', () => {
  const args = parseArgs([])
  assert.equal(args.dryRun, true, '默认必须 dry-run，避免手滑真推')
  assert.equal(args.yes, false)
})

await test('parseArgs 识别 --yes 与 --dry-run', () => {
  assert.equal(parseArgs(['--yes']).dryRun, false)
  assert.equal(parseArgs(['--yes']).yes, true)
  assert.equal(parseArgs(['--yes', '--dry-run']).dryRun, true, '--dry-run 应当压过 --yes')
})

await test('parseArgs 支持 --version 覆盖与 --help', () => {
  assert.equal(parseArgs(['--version', '1.2.3']).version, '1.2.3')
  assert.equal(parseArgs(['--help']).help, true)
})

/* ------------------------------------------------ 版本读取 */

await test('readVersion 从 package.json 读版本号', async () => {
  const version = await readVersion('/repo', () => JSON.stringify({ name: 'x', version: '9.8.7' }))
  assert.equal(version, '9.8.7')
})

await test('readVersion 在 package.json 缺 version 时报错而不是静默', async () => {
  await assert.rejects(
    () => readVersion('/repo', () => JSON.stringify({ name: 'x' })),
    /version/i,
  )
})

/* ------------------------------------------------ Release payload（422 回归） */

await test('buildReleasePayload 的 body 是字符串而不是对象', () => {
  const body = '# v0.3.2\n\n正文'
  const payload = buildReleasePayload({ tag: TAG, name: TAG, body })
  assert.equal(typeof payload.body, 'string', 'body 必须是字符串，否则 GitHub 返回 422')
  assert.equal(payload.body, body)
})

await test('buildReleasePayload 序列化后 body 仍是字符串（不会被包成 {value:...}）', () => {
  const payload = buildReleasePayload({ tag: TAG, name: TAG, body: '# 标题\n\n中文正文' })
  const round = JSON.parse(JSON.stringify(payload))
  assert.equal(typeof round.body, 'string')
  assert.equal(round.body, '# 标题\n\n中文正文')
})

await test('buildReleasePayload 保留中文，不出现乱码', () => {
  const body = '侧边栏能看版本、能一键拉取新版'
  const payload = buildReleasePayload({ tag: TAG, name: TAG, body })
  assert.ok(payload.body.includes('侧边栏'), '中文被破坏')
  assert.equal(/[鏍鐗璇]/.test(payload.body), false, '出现 GBK 误读乱码')
})

await test('buildReleasePayload 拒绝非字符串 body（PowerShell 对象那种）', () => {
  const psObject = { value: '# v0.3.2', PSPath: 'D:\\x.md', ReadCount: 1 }
  assert.throws(
    () => buildReleasePayload({ tag: TAG, name: TAG, body: psObject }),
    /body.*字符串|string/i,
    '非字符串 body 必须当场报错，不能带着去撞 422',
  )
})

await test('buildReleasePayload 带上 tag/name/draft/prerelease 四个字段', () => {
  const payload = buildReleasePayload({ tag: TAG, name: 'v0.3.2 发布', body: 'x' })
  assert.equal(payload.tag_name, TAG)
  assert.equal(payload.name, 'v0.3.2 发布')
  assert.equal(payload.draft, false)
  assert.equal(payload.prerelease, false)
})

/* ------------------------------------------------ 令牌不外泄 */

await test('redact 把 token 替换成占位符', () => {
  const url = ['https://', AUTH_LABEL, ':', FAKE_TOKEN, '@', FAKE_HOST, '/example/repo.git'].join('')
  const safe = redact(`git push ${url}`)
  assert.equal(safe.includes(FAKE_TOKEN), false, '令牌原样出现在输出里')
  assert.ok(safe.includes(`${AUTH_LABEL}:***@${FAKE_HOST}`), `脱敏结果不对：${safe}`)
})

await test('redact 不误伤普通文本', () => {
  assert.equal(redact('git push origin main'), 'git push origin main')
})

/* ------------------------------------------------ 前置闸门 */

await test('checkWorktree 工作区脏时拒绝发布并列出文件', async () => {
  const result = await checkWorktree('/repo', async () => ({
    ok: true,
    code: 0,
    stdout: ' M lib/index.js\n?? docs/new.md\n',
    stderr: '',
  }))
  assert.equal(result.ok, false)
  assert.deepEqual(result.dirty, ['M lib/index.js', '?? docs/new.md'])
})

await test('checkWorktree 干净时放行', async () => {
  const result = await checkWorktree('/repo', async () => ({
    ok: true,
    code: 0,
    stdout: '',
    stderr: '',
  }))
  assert.equal(result.ok, true)
  assert.deepEqual(result.dirty, [])
})

await test('checkTagExists 远端已有同名 tag 时拒绝覆盖', async () => {
  const result = await checkTagExists('/repo', TAG, async () => ({
    ok: true,
    code: 0,
    stdout: 'deadbeef\trefs/tags/v0.3.2\n',
    stderr: '',
  }))
  assert.equal(result.exists, true)
})

await test('checkTagExists 远端没有该 tag 时返回 false', async () => {
  const result = await checkTagExists('/repo', TAG, async () => ({
    ok: true,
    code: 0,
    stdout: '',
    stderr: '',
  }))
  assert.equal(result.exists, false)
})

/* ------------------------------------------------ 计划与执行 */

await test('buildPlan 按「推 main → 推 tag → 建 Release → 回读核对」排序', () => {
  const plan = buildPlan({ version: '0.3.2', tag: TAG, remote: FAKE_REMOTE })
  const ids = plan.map((step) => step.id)
  assert.deepEqual(ids, ['push-main', 'push-tag', 'create-release', 'verify-release'])
})

await test('buildPlan 的每一步都带可读说明，不只有命令', () => {
  const plan = buildPlan({ version: '0.3.2', tag: TAG, remote: FAKE_REMOTE })
  for (const step of plan) {
    assert.ok(typeof step.title === 'string' && step.title.length > 0, `${step.id} 缺 title`)
  }
})

await test('dry-run 下一条命令都不执行', async () => {
  const calls = []
  const result = await release({
    root: '/repo',
    dryRun: true,
    yes: false,
    version: '0.3.2',
    pat: FAKE_TOKEN,
    readFileFn: () => '# v0.3.2',
    runFn: async (command, args) => {
      calls.push([command, ...args])
      return { ok: true, code: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(calls.length, 0, `dry-run 却执行了命令：${JSON.stringify(calls)}`)
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
})

await test('没有 --yes 时拒绝真推，并说明原因', async () => {
  const calls = []
  const result = await release({
    root: '/repo',
    dryRun: false,
    yes: false,
    version: '0.3.2',
    pat: FAKE_TOKEN,
    readFileFn: () => '# v0.3.2',
    runFn: async (command, args) => {
      calls.push([command, ...args])
      return { ok: true, code: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'confirm_required')
  assert.equal(calls.length, 0, '没有确认就执行了命令')
})

await test('缺 token 时拒绝真推，不静默退化成匿名推送', async () => {
  const result = await release({
    root: '/repo',
    dryRun: false,
    yes: true,
    version: '0.3.2',
    pat: '',
    readFileFn: () => '# v0.3.2',
    runFn: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'missing_token')
})

await test('工作区脏时即使给了 --yes 也拒绝', async () => {
  const result = await release({
    root: '/repo',
    dryRun: false,
    yes: true,
    version: '0.3.2',
    pat: FAKE_TOKEN,
    readFileFn: () => '# v0.3.2',
    runFn: async (command, args) => {
      if (args.includes('status')) {
        return { ok: true, code: 0, stdout: ' M lib/index.js\n', stderr: '' }
      }
      return { ok: true, code: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'dirty_worktree')
})

await test('真推时返回的日志里不出现 token 原文', async () => {
  const result = await release({
    root: '/repo',
    dryRun: false,
    yes: true,
    version: '0.3.2',
    pat: FAKE_TOKEN,
    readFileFn: () => '# v0.3.2',
    runFn: async (command, args) => {
      if (args.includes('status')) return { ok: true, code: 0, stdout: '', stderr: '' }
      if (args.includes('ls-remote')) return { ok: true, code: 0, stdout: '', stderr: '' }
      return { ok: true, code: 0, stdout: 'done', stderr: '' }
    },
  })
  const dump = JSON.stringify(result)
  assert.equal(dump.includes(FAKE_TOKEN), false, '结果里带出了 token 原文')
})

await test('某一步失败时立即停止，不继续往下推', async () => {
  let pushed = 0
  const result = await release({
    root: '/repo',
    dryRun: false,
    yes: true,
    version: '0.3.2',
    pat: FAKE_TOKEN,
    readFileFn: () => '# v0.3.2',
    runFn: async (command, args) => {
      if (args.includes('status')) return { ok: true, code: 0, stdout: '', stderr: '' }
      if (args.includes('ls-remote')) return { ok: true, code: 0, stdout: '', stderr: '' }
      if (args.includes('push')) {
        pushed += 1
        return { ok: false, code: 128, stdout: '', stderr: 'Authentication failed' }
      }
      return { ok: true, code: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(pushed, 1, '第一步 push 失败后不该再推第二次')
  assert.match(String(result.error), /push|failed/i)
})

/* ------------------------------------------------ CLI 外壳（真起进程） */

await test('CLI --help 打印用法并正常退出', async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--help'], { cwd: REPO_ROOT })
  assert.match(stdout, /用法/)
  assert.match(stdout, /GITHUB_TOKEN/)
})

await test('CLI 不带参数时只打印计划，不执行任何命令', async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI], { cwd: REPO_ROOT })
  assert.match(stdout, /dry-run/, '应当明确告诉用户这是 dry-run')
  assert.match(stdout, /把本地 main 推到/, '计划里应出现推 main 这一步')
  assert.equal(stdout.includes('发布完成'), false, 'dry-run 却报告发布完成')
})

await test('CLI 无 GITHUB_TOKEN 时带 --yes 直接拒绝，退出码 2', async () => {
  try {
    await execFileAsync(process.execPath, [CLI, '--yes'], {
      cwd: REPO_ROOT,
      env: { ...process.env, GITHUB_TOKEN: '' },
    })
    assert.fail('没有 token 却成功了')
  } catch (error) {
    assert.equal(error.code, 2, `退出码应为 2，实际 ${error.code}`)
    assert.match(String(error.stderr), /GITHUB_TOKEN/)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  for (const item of failures) console.log(`\n--- ${item.name} ---\n${item.error && item.error.stack}`)
}
process.exit(failed > 0 ? 1 : 0)
