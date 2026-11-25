/**
 * 插件自身的版本信息与更新检查。
 *
 * 这个模块只做三件事：
 *   1. 把版本字符串解析成可比较的数字数组；
 *   2. 说出本地版本、远端最新版本，以及两者的关系；
 *   3. 在用户明确确认后执行一次 fast-forward 拉取。
 *
 * 刻意不做的事：
 *   - 不导入任何 Cordis / DSH 依赖，纯 Node，便于直接测试；
 *   - 不在检查阶段做任何写操作；
 *   - 远端不可达时返回「未检查」而不是抛错（校园网环境下 GitHub 经常不通）。
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件仓库（owner/repo）。改这里就等于改「向哪里检查更新」。 */
export const REPOSITORY = 'y0unge2114514-bit/dsh-project-docs-and-discipline'

/** 版本检查的原始数据地址。走 raw.githubusercontent 是因为本机 hosts 把 github.com 指到了 127.0.0.1。 */
export const RAW_PACKAGE_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main/package.json`

/** 检查结果最多缓存这么久，避免面板每次渲染都打一次网络。 */
export const CHECK_TTL_MS = 60_000

const VERSION_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i

/** 插件根目录：lib/ 的上一级。 */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 把 `0.3.1` / `v0.3.2-beta.1` 解析成 `[0,3,1]`。
 * 解析不出来就返回 null —— 调用方必须能区分「版本是 0」和「没有版本」。
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = VERSION_PATTERN.exec(value.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

/** 比较两个版本字符串：a<b 返回 -1，a>b 返回 1，相等返回 0，无法解析返回 null。 */
export function compareVersion(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null
  for (let index = 0; index < 3; index += 1) {
    const l = left[index] ?? 0
    const r = right[index] ?? 0
    if (l < r) return -1
    if (l > r) return 1
  }
  return 0
}

/** 远端是否严格新于本地。远端无法解析时返回 false —— 不能把「不知道」当成「有新版」。 */
export function isNewer(local, remote) {
  return compareVersion(local, remote) === -1
}

/** 给人看的一句话结论。 */
export function summarizeUpdate(info) {
  const local = info !== null && typeof info === 'object' && typeof info.local === 'string' ? info.local : '未知'
  if (info === null || typeof info !== 'object') return `当前版本 ${local}`
  if (info.remote === null || info.remote === undefined) {
    return `当前版本 ${local} · 未检查到远端版本（${info.error ?? '原因未知'}）`
  }
  if (info.behind === true) return `当前版本 ${local} · 远端有新版本 ${info.remote}`
  return `当前版本 ${local} · 已是最新`
}

/** 从 GitHub raw 读 package.json 的 version。任何失败都降级为 null + 原因。 */
export async function fetchRemoteVersion({
  url = RAW_PACKAGE_URL,
  timeoutMs = 4000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') return { version: null, error: '当前运行时没有 fetch' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) return { version: null, error: `HTTP ${response.status}` }
    const text = await response.text()
    const parsed = JSON.parse(text)
    const version = parsed !== null && typeof parsed === 'object' && typeof parsed.version === 'string' ? parsed.version : null
    return version === null ? { version: null, error: 'package.json 里没有 version' } : { version, error: null }
  } catch (error) {
    return { version: null, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 用系统 curl 读同一个地址。
 *
 * 为什么需要这条路：Node 只信任自己打包的 144 个根证书，不读 Windows 根证书库；
 * 而这台机器（校园网出口 + 系统级 HTTPS 审计）会换掉证书链，于是 fetch 每次都
 * `unable to verify the first certificate`，版本徽章就永远是「未知」。
 * curl 走 schannel，用的是系统信任链 —— 校验照做，只是换了个更懂本机的执行者。
 * 绝不能靠 `rejectUnauthorized: false` 绕过：那会同时放过真证书错误。
 */
export async function fetchRemoteVersionViaCurl({ url = RAW_PACKAGE_URL, runImpl = run, timeoutMs = 8000 } = {}) {
  const result = await runImpl(
    'curl',
    [
      '--silent',
      '--show-error',
      '--location',
      '--ssl-no-revoke',
      '--max-time',
      String(Math.max(1, Math.round(timeoutMs / 1000))),
      url,
    ],
    process.cwd(),
  )
  if (!result.ok) return { version: null, error: `curl 失败：${result.stderr || `exit ${result.code}`}` }
  try {
    const parsed = JSON.parse(result.stdout)
    const version = parsed !== null && typeof parsed === 'object' && typeof parsed.version === 'string' ? parsed.version : null
    return version === null ? { version: null, error: 'package.json 里没有 version' } : { version, error: null }
  } catch {
    return { version: null, error: 'curl 返回的不是 JSON' }
  }
}

/** 读本地 package.json 的版本。 */
export async function readLocalVersion(root = PLUGIN_ROOT) {
  const text = await readFile(path.join(root, 'package.json'), 'utf8')
  const parsed = JSON.parse(text)
  return typeof parsed.version === 'string' ? parsed.version : null
}

function run(command, args, cwd) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        code: error !== null && typeof error.code === 'number' ? error.code : 0,
        stdout: String(stdout ?? '').trim(),
        stderr: String(stderr ?? '').trim() === '' ? (error === null ? '' : String(error.message)) : String(stderr).trim(),
      })
    })
  })
}

/** 本地 git HEAD 短哈希；不是 git 仓库时返回 null。 */
export async function readLocalHead(root = PLUGIN_ROOT) {
  const result = await run('git', ['rev-parse', '--short', 'HEAD'], root)
  return result.ok ? result.stdout : null
}

/** 组装面板与接口要的完整状态。永不抛错：网络问题只体现为 remote=null。 */
export async function versionInfo({
  root = PLUGIN_ROOT,
  fetchImpl = globalThis.fetch,
  runImpl = run,
  timeoutMs = 4000,
} = {}) {
  const local = await readLocalVersion(root).catch(() => null)
  const head = await readLocalHead(root).catch(() => null)
  let remoteResult = await fetchRemoteVersion({ fetchImpl, timeoutMs })
  let via = remoteResult.version === null ? null : 'fetch'
  if (remoteResult.version === null) {
    // fetch 失败时换 curl 再试一次：本机证书被换成自签证书，Node 的根证书库不认，
    // 而 curl 用系统信任链。两条都失败才真的报告「未检查」。
    const fallback = await fetchRemoteVersionViaCurl({ runImpl })
    if (fallback.version !== null) {
      remoteResult = fallback
      via = 'curl'
    } else if (typeof remoteResult.error === 'string' && remoteResult.error !== '') {
      // 保留首次失败的原因，同时带上回退尝试的结果，免得排查时被误导。
      remoteResult = { version: null, error: `${remoteResult.error}；${fallback.error}` }
    } else {
      remoteResult = fallback
    }
  }
  const behind = remoteResult.version === null ? null : compareVersion(local, remoteResult.version) === -1
  return {
    repository: REPOSITORY,
    local,
    remote: remoteResult.version,
    behind,
    head,
    via,
    error: remoteResult.error,
    summary: summarizeUpdate({ local, remote: remoteResult.version, behind, error: remoteResult.error }),
    checkedAt: new Date().toISOString(),
  }
}

/**
 * 拉取新版：git fetch + fast-forward，绝不 force。
 * 工作区有未提交改动时直接拒绝 —— 那可能正是别人正在改的修复。
 */
export async function pullUpdate({ root = PLUGIN_ROOT } = {}) {
  const status = await run('git', ['status', '--porcelain'], root)
  if (!status.ok) return { ok: false, reason: 'not_a_repository', message: status.stderr }
  if (status.stdout !== '') return { ok: false, reason: 'dirty_worktree', message: status.stdout }
  const fetch = await run('git', ['fetch', '--depth', '1', 'origin', 'main'], root)
  if (!fetch.ok) return { ok: false, reason: 'fetch_failed', message: fetch.stderr }
  const merge = await run('git', ['merge', '--ff-only', 'FETCH_HEAD'], root)
  if (!merge.ok) return { ok: false, reason: 'not_fast_forward', message: merge.stderr }
  const head = await readLocalHead(root)
  return { ok: true, reason: 'updated', head, message: merge.stdout }
}
