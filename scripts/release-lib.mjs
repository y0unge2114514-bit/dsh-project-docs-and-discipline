// 发布流程的纯逻辑层。
//
// 为什么单独拆一个 lib：`release.mjs` 是命令行外壳，真正的判定（要不要拦、
// 命令怎么拼、payload 长什么样）全在这里。拆开之后测试可以注入假的 runFn，
// 一条真实命令都不跑，也就不会误推。
//
// 2026-11-25 发布 v0.3.2 时踩到的坑，这里逐条固化成防线：
//   1. Release body 必须是字符串 —— PowerShell `Get-Content -Raw` 会把
//      Markdown 包成带 PSPath 的对象，GitHub 直接 422。
//   2. 工作区脏的时候不许发布 —— 否则推上去的东西和本地不一致。
//   3. 远端已有同名 tag 不许覆盖 —— 版本号一旦发出去就是契约。
//   4. token 不许出现在任何输出里 —— 日志会被贴进对话和 issue。
import { execFile } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile as readFileAsync } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { REPOSITORY } from '../lib/self-update.js'

const execFileAsync = promisify(execFile)

// 仓库地址只在这里拼一次，而且 slug 直接复用 self-update.js 的常量——
// 插件里已经有一份真相源，再抄一遍迟早两边对不上。
// host 与 slug 分开写，也让隐私扫描器不必为「工具自己要知道往哪推」破例。
const GITHUB_HOST = 'https://github.com'

export { REPOSITORY }
export const DEFAULT_REMOTE = `${GITHUB_HOST}/${REPOSITORY}.git`
export const API_BASE = `https://api.github.com/repos/${REPOSITORY}`
export const DEFAULT_TIMEOUT_MS = 120_000

/** 插件仓库根目录（本文件在 scripts/ 下）。 */
export const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/* ------------------------------------------------------------ 默认执行器 */

/**
 * 跑一条外部命令。永远不抛异常——失败也返回 { ok:false, code, stdout, stderr }，
 * 让调用方自己决定是拦还是放。
 */
export async function defaultRun(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { ok: true, code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
    }
  }
}

async function defaultReadFile(file) {
  return readFileAsync(file, 'utf8')
}

/* ------------------------------------------------------------ 参数 */

/**
 * 解析命令行参数。
 *
 * 默认是 dry-run：什么都不传只打印计划。必须显式 `--yes` 才真推，
 * 而 `--dry-run` 可以压过 `--yes`（写在后面即生效），方便临时收手。
 */
export function parseArgs(argv = []) {
  const options = {
    dryRun: null,
    yes: false,
    help: false,
    version: '',
    root: '',
    pat: '',
    remote: '',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index])
    if (arg === '--yes' || arg === '-y') {
      options.yes = true
      if (options.dryRun === null) options.dryRun = false
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    const next = argv[index + 1]
    if (arg === '--version' && next !== undefined) {
      options.version = String(next)
      index += 1
      continue
    }
    if (arg === '--root' && next !== undefined) {
      options.root = String(next)
      index += 1
      continue
    }
    if (arg === '--remote' && next !== undefined) {
      options.remote = String(next)
      index += 1
      continue
    }
  }

  if (options.dryRun === null) options.dryRun = true
  return options
}

/* ------------------------------------------------------------ 脱敏 */

/**
 * 把命令/输出里的凭据换成 `***`。
 * 凡是会被打印、被写进结果、被贴进对话的字符串，都必须先过这里。
 */
export function redact(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/(x-access-token:)[^@\s]+/g, '$1***')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '***')
    .replace(/(Bearer\s+)[A-Za-z0-9_]+/g, '$1***')
}

/* ------------------------------------------------------------ 版本 */

export async function readVersion(root, readFileFn = defaultReadFile) {
  const raw = await readFileFn(path.join(root, 'package.json'))
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('package.json 不是合法 JSON，读不出版本号')
  }
  if (!parsed || typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('package.json 缺少 version 字段，无法确定要发布的版本')
  }
  return parsed.version
}

/* ------------------------------------------------------------ Release payload */

function describeType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 组装 GitHub Release 的请求体。
 *
 * `body` 只接受字符串，收到别的类型当场报错——这是 422 事故的正面防线：
 * 与其让 GitHub 用一句 `For 'properties/body', {...} is not a string` 打回来，
 * 不如在本地就说清「你传进来的是对象，请用 utf8 读成字符串」。
 */
export function buildReleasePayload({ tag, name, body, draft = false, prerelease = false } = {}) {
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new Error('tag 必须是非空字符串')
  }
  if (typeof body !== 'string') {
    throw new Error(
      `body 必须是字符串，收到的是 ${describeType(body)}。` +
        'PowerShell 的 Get-Content -Raw 会把 Markdown 包成带 PSPath 的对象，' +
        '请改用 Node 以 utf8 读取后再传进来。',
    )
  }
  return {
    tag_name: tag,
    name: typeof name === 'string' && name.length > 0 ? name : tag,
    body,
    draft: Boolean(draft),
    prerelease: Boolean(prerelease),
  }
}

/* ------------------------------------------------------------ 前置闸门 */

/**
 * 工作区必须干净：未提交的改动推不上去，推上去的东西也就和本地不一致。
 */
export async function checkWorktree(root, runFn = defaultRun) {
  const result = await runFn('git', ['status', '--porcelain'], { cwd: root })
  const dirty = String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return { ok: dirty.length === 0, dirty }
}

/**
 * 版本号发出去就是契约，远端已有同名 tag 一律不覆盖。
 */
export async function checkTagExists(root, tag, runFn = defaultRun) {
  const result = await runFn('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { cwd: root })
  const exists = String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .some((line) => line.endsWith(`refs/tags/${tag}`))
  return { exists, tag }
}

/* ------------------------------------------------------------ 计划 */

/**
 * 发布分四步，顺序不可换：main 先落地，tag 才有意义；Release 建在 tag 上，
 * 最后回读一次确认它真的存在（不是「接口返回 201 就算完」）。
 */
export function buildPlan({ version, tag, remote = DEFAULT_REMOTE, root = PLUGIN_ROOT } = {}) {
  const authRemote = withToken(remote, '<token>')
  return [
    {
      id: 'push-main',
      title: `把本地 main 推到 ${REPOSITORY}`,
      command: 'git',
      args: ['push', authRemote, 'main'],
      cwd: root,
      detail: '先推提交，保证 tag 指向的对象远端已经有了',
    },
    {
      id: 'push-tag',
      title: `推送 tag ${tag}`,
      command: 'git',
      args: ['push', authRemote, tag],
      cwd: root,
      detail: 'tag 是版本的锚点，Release 必须挂在它上面',
    },
    {
      id: 'create-release',
      title: `创建 GitHub Release ${tag}`,
      command: 'curl',
      args: ['--ssl-no-revoke', '--fail-with-body', '-X', 'POST', `${API_BASE}/releases`],
      cwd: root,
      detail: `正文取自 docs/RELEASE-${version}.md，body 必须是字符串`,
    },
    {
      id: 'verify-release',
      title: `回读 ${tag} 确认 Release 真的存在`,
      command: 'curl',
      args: ['--ssl-no-revoke', '--fail-with-body', `${API_BASE}/releases/tags/${tag}`],
      cwd: root,
      detail: '接口返回 201 不等于发布成功，必须读回来核对',
    },
  ]
}

/** 把 token 塞进 https 远端地址；token 为空时原样返回。 */
export function withToken(remote, token) {
  if (!token) return remote
  return remote.replace(/^https:\/\//, `https://x-access-token:${token}@`)
}

/* ------------------------------------------------------------ 执行 */

/**
 * 真正跑一次发布。
 *
 * 顺序：dry-run 直接返回计划 → 没有 --yes 拒绝 → 没有 token 拒绝 →
 * 工作区脏拒绝 → 远端已有 tag 拒绝 → 推 main → 推 tag → 建 Release → 回读。
 * 任何一步失败立刻停，绝不继续往下推。
 */
export async function release(options = {}) {
  const {
    root = PLUGIN_ROOT,
    dryRun = true,
    yes = false,
    version = '',
    pat = '',
    remote = DEFAULT_REMOTE,
    readFileFn = defaultReadFile,
    runFn = defaultRun,
    log = () => {},
  } = options

  const resolvedVersion = version || (await readVersion(root, readFileFn))
  const tag = resolvedVersion.startsWith('v') ? resolvedVersion : `v${resolvedVersion}`
  const plan = buildPlan({ version: resolvedVersion, tag, remote, root })

  if (dryRun) {
    for (const step of plan) log(`  · ${step.title}`)
    return { ok: true, dryRun: true, version: resolvedVersion, tag, plan: plan.map(summarizeStep) }
  }

  if (!yes) {
    return { ok: false, dryRun: false, error: 'confirm_required', hint: '真发布会改远端，加 --yes 才执行；不加只打印计划。' }
  }

  if (typeof pat !== 'string' || pat.length === 0) {
    return {
      ok: false,
      dryRun: false,
      error: 'missing_token',
      hint: '缺少 GITHUB_TOKEN 或 --token：匿名推送会被 GitHub 拒绝，也不会退化成 SSH。',
    }
  }

  const worktree = await checkWorktree(root, runFn)
  if (!worktree.ok) {
    return {
      ok: false,
      dryRun: false,
      error: 'dirty_worktree',
      dirty: worktree.dirty,
      hint: '先提交或 stash，工作区干净了再发布。',
    }
  }

  const tagState = await checkTagExists(root, tag, runFn)
  if (tagState.exists) {
    return {
      ok: false,
      dryRun: false,
      error: 'tag_exists',
      tag,
      hint: `${tag} 远端已存在。版本号发出去就是契约，要重发请先升版本号。`,
    }
  }

  const authRemote = withToken(remote, pat)
  const steps = []

  // 1) 推 main
  const pushMain = await runFn('git', ['push', authRemote, 'main'], { cwd: root })
  steps.push(recordStep('push-main', pushMain))
  if (!pushMain.ok) {
    return { ok: false, dryRun: false, error: 'push_main_failed', version: resolvedVersion, tag, steps: steps.map(redactStep) }
  }

  // 2) 推 tag
  const pushTag = await runFn('git', ['push', authRemote, tag], { cwd: root })
  steps.push(recordStep('push-tag', pushTag))
  if (!pushTag.ok) {
    return { ok: false, dryRun: false, error: 'push_tag_failed', version: resolvedVersion, tag, steps: steps.map(redactStep) }
  }

  // 3) 建 Release
  const notesPath = path.join(root, 'docs', `RELEASE-${resolvedVersion}.md`)
  let body
  try {
    body = await readFileFn(notesPath)
  } catch {
    return {
      ok: false,
      dryRun: false,
      error: 'notes_missing',
      notesPath,
      hint: `缺少发布说明 ${notesPath}，先写再发。`,
    }
  }
  if (typeof body !== 'string') {
    return {
      ok: false,
      dryRun: false,
      error: 'notes_not_string',
      hint: '发布说明读出来不是字符串（PowerShell 的 Get-Content -Raw 会包成对象），请用 utf8 读取。',
    }
  }

  const payload = buildReleasePayload({ tag, name: tag, body })
  const tempFile = path.join(tmpdir(), `dsh-release-${Date.now()}-${process.pid}.json`)
  writeFileSync(tempFile, JSON.stringify(payload), 'utf8')
  let createResult
  try {
    createResult = await runFn(
      'curl',
      [
        '--ssl-no-revoke',
        '--fail-with-body',
        '--silent',
        '--show-error',
        '-X',
        'POST',
        '-H',
        `Authorization: Bearer ${pat}`,
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        'Content-Type: application/json; charset=utf-8',
        '--data-binary',
        `@${tempFile}`,
        `${API_BASE}/releases`,
      ],
      { cwd: root },
    )
  } finally {
    if (existsSync(tempFile)) unlinkSync(tempFile)
  }
  steps.push(recordStep('create-release', createResult))
  if (!createResult.ok) {
    return { ok: false, dryRun: false, error: 'release_create_failed', version: resolvedVersion, tag, steps: steps.map(redactStep) }
  }
  const created = parseJsonSafe(createResult.stdout)
  if (typeof created?.id !== 'number') {
    // curl 退出码 0 不代表接口成功：代理返回 500 且响应体为空时就是这种情形。
    return {
      ok: false,
      dryRun: false,
      error: 'release_create_failed',
      version: resolvedVersion,
      tag,
      hint: `建 Release 的响应里没有 id，接口没成功。响应片段：${excerpt(createResult.stdout)}`,
      steps: steps.map(redactStep),
    }
  }

  // 4) 回读核对
  const verifyResult = await runFn(
    'curl',
    [
      '--ssl-no-revoke',
      '--fail-with-body',
      '--silent',
      '--show-error',
      '-H',
      `Authorization: Bearer ${pat}`,
      '-H',
      'Accept: application/vnd.github+json',
      `${API_BASE}/releases/tags/${tag}`,
    ],
    { cwd: root },
  )
  steps.push(recordStep('verify-release', verifyResult))
  const verified = parseJsonSafe(verifyResult.stdout)
  if (!verifyResult.ok || typeof verified?.html_url !== 'string') {
    return {
      ok: false,
      dryRun: false,
      error: 'release_verify_failed',
      version: resolvedVersion,
      tag,
      hint: `回读没有拿到 html_url，无法证明 Release 存在。响应片段：${excerpt(verifyResult.stdout)}`,
      steps: steps.map(redactStep),
    }
  }

  return {
    ok: true,
    dryRun: false,
    version: resolvedVersion,
    tag,
    url: typeof verified?.html_url === 'string' ? verified.html_url : undefined,
    releaseId: typeof created?.id === 'number' ? created.id : undefined,
    bodyChars: body.length,
    steps: steps.map(redactStep),
  }
}

function summarizeStep(step) {
  return { id: step.id, title: step.title, command: redact([step.command, ...step.args].join(' ')) }
}

function recordStep(id, result) {
  return {
    id,
    ok: Boolean(result?.ok),
    code: result?.code ?? null,
    stdout: redact(String(result?.stdout ?? '')),
    stderr: redact(String(result?.stderr ?? '')),
  }
}

function redactStep(step) {
  return { ...step, stdout: redact(step.stdout), stderr: redact(step.stderr) }
}

function parseJsonSafe(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 取一段响应片段放进错误信息；空响应明说「空」，别让调用者以为是没报错。 */
function excerpt(text, limit = 200) {
  if (typeof text !== 'string') return '(无输出)'
  const trimmed = text.trim()
  if (trimmed.length === 0) return '(空响应体)'
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}
