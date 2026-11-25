/**
 * claims-guard 的路径归属判定。
 *
 * 这一套存在的理由：原实现把路径统一成 `\` 并小写，再用子串匹配判断
 * 「这次调用属于哪个项目」。在 Windows 上勉强够用，但它有两个真问题：
 *
 *   1. 子串匹配没有边界：项目根 `/srv/app/lib` 会命中 `/srv/app/library/x`，
 *      于是**另一个项目**的写操作被算到本项目头上，认领门禁直接失效。
 *   2. 全小写比较在 Linux 上是错的：`/srv/App` 和 `/srv/app` 是两个目录。
 *
 * 所以这里要的是：按平台决定是否折叠大小写，按路径边界判断包含关系。
 */
import assert from 'node:assert/strict'
import { normalizePath, projectForContext, activeOnly, claimDecision } from '../lib/claims-guard.js'

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
    console.log(`      ${String(error && error.message).split('\n')[0]}`)
  }
}

const POSIX = 'linux'
const WIN = 'win32'

// ---------------------------------------------------------------- normalizePath

test('POSIX：反斜杠不当作分隔符，保留大小写', () => {
  assert.equal(normalizePath('/srv/App/lib/', POSIX), '/srv/App/lib')
})

test('POSIX：连续斜杠折叠，末尾斜杠去掉', () => {
  assert.equal(normalizePath('//srv///app//', POSIX), '/srv/app')
})

test('Windows：正斜杠转反斜杠', () => {
  assert.equal(normalizePath('D:/work/proj', WIN), 'd:\\work\\proj')
})

test('Windows：大小写折叠', () => {
  assert.equal(normalizePath('D:\\WORK\\Proj', WIN), 'd:\\work\\proj')
})

test('Windows：末尾斜杠与空白去掉', () => {
  assert.equal(normalizePath('D:\\work\\proj\\  ', WIN), 'd:\\work\\proj')
})

test('空值归一为空串', () => {
  assert.equal(normalizePath(undefined, WIN), '')
  assert.equal(normalizePath(null, POSIX), '')
})

// ------------------------------------------------------------ 路径边界匹配

test('边界：项目根 /srv/app/lib 不命中另一个项目的 /srv/app/library/x', () => {
  const roots = [{ id: 'lib', root: '/srv/app/lib' }]
  assert.equal(projectForContext(roots, '/srv/app/library/x', {}, POSIX), undefined)
})

test('边界：项目根本身命中', () => {
  const roots = [{ id: 'lib', root: '/srv/app/lib' }]
  assert.equal(projectForContext(roots, '/srv/app/lib', {}, POSIX), 'lib')
})

test('边界：子目录命中', () => {
  const roots = [{ id: 'lib', root: '/srv/app/lib' }]
  assert.equal(projectForContext(roots, '/srv/app/lib/src/a.js', {}, POSIX), 'lib')
})

test('POSIX 大小写敏感：/srv/App 与 /srv/app 是两个项目', () => {
  const roots = [{ id: 'upper', root: '/srv/App' }]
  assert.equal(projectForContext(roots, '/srv/app/x', {}, POSIX), undefined)
})

test('Windows 大小写不敏感：D:\\Work 命中 d:\\work\\x', () => {
  const roots = [{ id: 'w', root: 'D:\\Work' }]
  assert.equal(projectForContext(roots, 'd:/work/x', {}, WIN), 'w')
})

test('嵌套项目：最长根优先', () => {
  const roots = [
    { id: 'outer', root: '/srv/app' },
    { id: 'inner', root: '/srv/app/lib' },
  ]
  assert.equal(projectForContext(roots, '/srv/app/lib/x', {}, POSIX), 'inner')
})

test('工具参数里的绝对路径也能定位项目', () => {
  const roots = [{ id: 'p', root: '/srv/app' }]
  assert.equal(projectForContext(roots, '/tmp', { file_path: '/srv/app/README.md' }, POSIX), 'p')
})

test('参数里的路径同样遵守边界，不做子串匹配', () => {
  const roots = [{ id: 'p', root: '/srv/app' }]
  assert.equal(projectForContext(roots, '/tmp', { file_path: '/srv/application/x' }, POSIX), undefined)
})

test('无根或无上下文时返回 undefined', () => {
  assert.equal(projectForContext([], '/srv/app', {}, POSIX), undefined)
  assert.equal(projectForContext([{ id: 'p', root: '/srv/app' }], '', {}, POSIX), undefined)
})

// ------------------------------------------------------------- 既有行为保持

test('activeOnly 只保留未过期的认领', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z')
  const claims = [
    { id: 'a', expiresAt: '2026-01-01T00:00:01.000Z' },
    { id: 'b', expiresAt: '2025-12-31T23:59:59.000Z' },
    { id: 'c', expiresAt: 'not-a-date' },
  ]
  assert.deepEqual(activeOnly(claims, now).map((claim) => claim.id), ['a'])
})

test('claimDecision：自己持认领则放行', () => {
  assert.equal(claimDecision({ claimed: true }), 'allow')
})

test('claimDecision：别人持认领则拦截', () => {
  assert.equal(claimDecision({ claimed: false, others: [{ agent: 'x' }] }), 'block')
})

test('claimDecision：无人认领时先提示一次，提示后放行', () => {
  assert.equal(claimDecision({ claimed: false, others: [] }), 'prompt')
  assert.equal(claimDecision({ claimed: false, warned: true }), 'allow')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
