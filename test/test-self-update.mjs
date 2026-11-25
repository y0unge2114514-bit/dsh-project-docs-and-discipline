// 版本信息与更新检查的纯函数测试。
// 这里不碰网络：所有远端响应都由调用方注入，测试只验证解析与判定逻辑。
import assert from 'node:assert/strict'

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

const mod = await import('../lib/self-update.js')
const {
  parseVersion,
  compareVersion,
  isNewer,
  summarizeUpdate,
  REPOSITORY,
} = mod

await test('parseVersion 解析 0.3.1', () => {
  assert.deepEqual(parseVersion('0.3.1'), [0, 3, 1])
})

await test('parseVersion 忽略 v 前缀与预发布后缀', () => {
  assert.deepEqual(parseVersion('v0.3.2-beta.1'), [0, 3, 2])
})

await test('parseVersion 对无法解析的值返回 null', () => {
  assert.equal(parseVersion('not-a-version'), null)
  assert.equal(parseVersion(undefined), null)
  assert.equal(parseVersion(''), null)
})

await test('compareVersion 比较主次修订', () => {
  assert.equal(compareVersion('0.3.1', '0.3.2'), -1)
  assert.equal(compareVersion('0.3.2', '0.3.1'), 1)
  assert.equal(compareVersion('0.3.1', '0.3.1'), 0)
  assert.equal(compareVersion('1.0.0', '0.9.9'), 1)
})

await test('compareVersion 补零比较（0.4 与 0.4.0 相等）', () => {
  assert.equal(compareVersion('0.4', '0.4.0'), 0)
})

await test('compareVersion 任一不可解析时返回 null', () => {
  assert.equal(compareVersion('x', '0.3.1'), null)
})

await test('isNewer 只在远端严格更新时为真', () => {
  assert.equal(isNewer('0.3.1', '0.3.2'), true)
  assert.equal(isNewer('0.3.1', '0.3.1'), false)
  assert.equal(isNewer('0.3.2', '0.3.1'), false)
  assert.equal(isNewer('0.3.1', 'garbage'), false)
})

await test('summarizeUpdate 说明有新版', () => {
  const text = summarizeUpdate({ local: '0.3.1', remote: '0.3.2', behind: true })
  assert.match(text, /0\.3\.1/)
  assert.match(text, /0\.3\.2/)
  assert.match(text, /新版/)
})

await test('summarizeUpdate 说明已是最新', () => {
  const text = summarizeUpdate({ local: '0.3.1', remote: '0.3.1', behind: false })
  assert.match(text, /最新/)
})

await test('summarizeUpdate 在远端不可达时说明未检查', () => {
  const text = summarizeUpdate({ local: '0.3.1', remote: null, behind: null, error: 'offline' })
  assert.match(text, /0\.3\.1/)
  assert.match(text, /未|失败|无法/)
})

await test('REPOSITORY 指向真实仓库而不是示例值', () => {
  assert.equal(typeof REPOSITORY, 'string')
  assert.match(REPOSITORY, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
})

/* ---------------------------------------------- 网络不可用时的降级路径 */
// 本机（校园网 + 系统级 HTTPS 审计代理）会把 TLS 证书换成自签证书，
// Node 的 fetch 不读 Windows 根证书库，于是每次检查都 `fetch failed`。
// 版本徽章不能因此永远显示「未知」——失败时回退到一次系统 curl 请求。

await test('fetch 报证书错误时，回退到系统 curl 读取远端版本', async () => {
  const calls = []
  const info = await mod.versionInfo({
    root: mod.PLUGIN_ROOT,
    fetchImpl: async () => {
      throw new Error('unable to verify the first certificate')
    },
    runImpl: async (command, args) => {
      calls.push([command, ...args])
      return { ok: true, code: 0, stdout: '{"name":"x","version":"9.9.9"}', stderr: '' }
    },
  })
  assert.equal(info.remote, '9.9.9', 'curl 回退没有生效')
  assert.equal(info.behind, true)
  assert.equal(info.error, null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'curl')
  assert.ok(
    calls[0].includes('--ssl-no-revoke'),
    `curl 缺少 --ssl-no-revoke：${calls[0].join(' ')}`,
  )
})

await test('fetch 成功时不会额外调用 curl', async () => {
  let ran = 0
  const info = await mod.versionInfo({
    root: mod.PLUGIN_ROOT,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return '{"version":"0.3.2"}'
      },
    }),
    runImpl: async () => {
      ran += 1
      return { ok: true, code: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(info.remote, '0.3.2')
  assert.equal(ran, 0, 'fetch 成功时不该再打 curl')
})

await test('curl 也失败时如实报告未检查，而不是假装已是最新', async () => {
  const info = await mod.versionInfo({
    root: mod.PLUGIN_ROOT,
    fetchImpl: async () => {
      throw new Error('unable to verify the first certificate')
    },
    runImpl: async () => ({ ok: false, code: 6, stdout: '', stderr: 'Could not resolve host' }),
  })
  assert.equal(info.remote, null)
  assert.equal(info.behind, null)
  assert.ok(typeof info.error === 'string' && info.error !== '')
  assert.match(info.summary, /未检查到远端版本/)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
