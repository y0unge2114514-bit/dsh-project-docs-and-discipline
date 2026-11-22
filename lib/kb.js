/**
 * Shared-knowledge base (统一信息库) for the 项目文档 bundle.
 *
 * ## Why this file exists
 *
 * Project documents are per project. Shared physical resources are not: one VPS,
 * one disk, one set of ports is used by many projects at once. When each project
 * records them in its own doc, two agents can each "allocate" the same resource
 * and both stay locally consistent — A sets the server cache to 40G, B carves
 * 5GB out of it, and nothing anywhere records that only 35G is left, or why.
 *
 * This store gives shared facts one home with the same guarantees the rest of
 * the library already has, plus the two things a shared fact needs:
 *
 *   1. **Immutable revisions.** Every version of every resource is kept as its
 *      own file under `rev/`; the current value is a pointer. Nothing is ever
 *      lost, so "what was it before, and who changed it" is answerable.
 *   2. **Mandatory change log.** A value write cannot happen without an author,
 *      a reason and touched projects. A read-only "audit" pass in place proves
 *      an agent looked at the relevant slice of the base; the plugin turns that
 *      into a gate, so "I updated the unified doc after this stage" is enforced
 *      rather than requested.
 *
 * ## Layout
 *
 *   kb/
 *     RESOURCES.json                    索引：key → 摘要 / 当前值 / 修订号 / 风险等级
 *     CHANGELOG.md                      给人读的变更流水（与 changes/ 同步生成）
 *     rev/<key>/<revision>-<hash>.json  不可变修订（含 before / after / 原因 / 涉及项目）
 *     changes/<stamp>-<key>-<rev>.json  不可变变更记录（append-only，跨 key 时间线）
 *     LOCK.json                         写入锁（owner / token / 过期时间）
 *     views/<project>.json              按项目生成的消费视图（含被引用值）
 *
 * ## Concurrency
 *
 * Compare-and-set on a per-resource revision number (`expect_revision`) catches
 * stale intent; an O_EXCL lock file serialises the read-modify-write of the
 * index between processes; revision files are written exclusively, so two
 * writers can never produce two different contents for the same revision.
 * A stale lock (crashed agent) expires instead of blocking everyone forever.
 *
 * @module @local/dsh-project-docs/kb
 */
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const KB_KINDS = [
  'host',
  'port',
  'disk',
  'cache',
  'process',
  'tunnel',
  'proxy',
  'schedule',
  'database',
  'domain',
  'env',
  'version',
  'network',
  'toolchain',
  'other',
]

/** Resource criticality. `high` resources demand a reason-free proof only when
 * they change; `critical` ones are additionally flagged in every project view. */
export const KB_RISK = ['low', 'medium', 'high', 'critical']

export const KB_STATUS = ['active', 'deprecated', 'reserved']

const LIMITS = {
  keyLength: 96,
  titleLength: 120,
  valueLength: 4000,
  reasonLength: 2000,
  sourceLength: 300,
  authorLength: 60,
  tagLength: 40,
  tags: 12,
  sources: 20,
  notes: 24,
  historyDefault: 20,
  searchDefault: 30,
}

const REASON_MIN = 8

const LOCK_STALE_MS = 30_000

export class KbError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'KbError'
    this.code = code
    this.details = details
  }
}

function hash16(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
}

function isoNow() {
  return new Date().toISOString()
}

function stamp(at) {
  return `${at.slice(0, 10).replace(/-/g, '')}T${at.slice(11, 23).replace(/[:.]/g, '')}`
}

function clip(text, max) {
  const value = typeof text === 'string' ? text : ''
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function textField(raw, what, max, { required = true } = {}) {
  if (raw === undefined || raw === null) {
    if (required) throw new KbError('invalid_input', `${what} 不能为空`)
    return ''
  }
  if (typeof raw !== 'string') throw new KbError('invalid_input', `${what} 必须是文本`)
  const value = raw.trim()
  if (required && value === '') throw new KbError('invalid_input', `${what} 不能为空`)
  if (value.length > max) throw new KbError('invalid_input', `${what} 超过 ${max} 字符`)
  return value
}

/**
 * Resource keys are dotted identifiers: `port.example-9000`, `cache.example.hls`,
 * `disk.g.40g`. They must be stable, because revisions hang off them.
 */
function resourceKey(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new KbError('invalid_input', '缺少资源 key')
  const value = raw.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{1,95}$/.test(value)) {
    throw new KbError('invalid_name', '资源 key 只能是小写字母、数字、点、下划线和短横线（2-96 位），例如 port.example-9000')
  }
  return value
}

function stringList(raw, what, max) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new KbError('invalid_input', `${what} 必须是数组`)
  return raw
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => clip(item.trim(), LIMITS.sourceLength))
    .slice(0, max)
}

function nowIso(value) {
  return typeof value === 'string' && value !== '' ? value : ''
}

/**
 * Resolve the document-store root into an absolute path.
 *
 * WHY THIS EXISTS: a Windows path only survives if every hop keeps its
 * backslashes. When one is lost — a `\\` collapsed to `\` on its way through a
 * script heredoc, a JSON value, or an argv string — `D:\work\docs` degrades into
 * `D:work.docs`, which Windows reads as "drive D:, relative path" and Node then
 * resolves against the *process cwd*. The knowledge base lands in
 * `some-repo/work.docs/kb` instead of the document store, and every later read
 * reports 0 resources. A leading `D:name` with no separator is the tell-tale
 * sign, so repair it here once instead of trusting every caller.
 */
function normalizeStoreDir(storeDir) {
  const raw = typeof storeDir === 'string' ? storeDir.trim() : ''
  if (raw === '') throw new KbError('invalid_input', '缺少 storeDir')
  let repaired = raw
  const driveRelative = /^([A-Za-z]):([^\\/].*)$/.exec(repaired)
  if (driveRelative !== null) repaired = `${driveRelative[1]}:\\${driveRelative[2]}`
  if (!path.isAbsolute(repaired)) repaired = path.resolve(repaired)
  return repaired
}

export function kbPaths(storeDir) {
  const base = normalizeStoreDir(storeDir)
  const root = path.join(base, 'kb')
  return {
    root,
    index: path.join(root, 'RESOURCES.json'),
    lock: path.join(root, 'LOCK.json'),
    changelog: path.join(root, 'CHANGELOG.md'),
    rev: path.join(root, 'rev'),
    changes: path.join(root, 'changes'),
    views: path.join(root, 'views'),
  }
}

async function readJson(file) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function writeAtomic(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomBytes(3).toString('hex')}.tmp`
  const handle = await fs.open(temp, 'w')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temp, file)
}

/** Write a file that must not already exist: the revision-file invariant. */
async function writeExclusive(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const handle = await fs.open(file, 'wx')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function listFiles(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

const EMPTY_INDEX = { version: 1, resources: {}, updatedAt: '' }

async function readIndex(storeDir) {
  const paths = kbPaths(storeDir)
  const raw = await readJson(paths.index)
  if (raw === undefined) return { ...EMPTY_INDEX, resources: {} }
  const resources = raw !== null && typeof raw.resources === 'object' && raw.resources !== null ? raw.resources : {}
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    resources,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  }
}

export async function ensureKbDirs(storeDir) {
  const paths = kbPaths(storeDir)
  await fs.mkdir(paths.rev, { recursive: true })
  await fs.mkdir(paths.changes, { recursive: true })
  await fs.mkdir(paths.views, { recursive: true })
  return paths
}

/**
 * Serialise index mutations between processes.
 *
 * `O_EXCL` create is the mutex; a crash leaves the lock behind, so a lock older
 * than `LOCK_STALE_MS` is broken rather than blocking the whole workspace.
 */
async function withLock(storeDir, owner, fn) {
  const paths = await ensureKbDirs(storeDir)
  const token = randomBytes(6).toString('hex')
  const deadline = Date.now() + 8000
  let handle
  for (;;) {
    try {
      handle = await fs.open(paths.lock, 'wx')
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const held = await readJson(paths.lock)
      // A lock file that exists but cannot be parsed is *not* automatically
      // stale: the winner creates the file with O_EXCL, then writes its owner
      // into it. Between those two steps the file is empty, so a reader that
      // treats "unparseable" as "stale" deletes the live lock and lets a second
      // writer in. That is a real race, and it produced duplicate revision
      // numbers (observed under 5 concurrent writers).
      //
      // Distinguish "empty, just created" from "torn, abandoned": use the
      // file's own mtime. Only a lock that has been unreadable for longer than
      // the write window is broken.
      if (held === undefined) {
        let age = 0
        try {
          const stat = await fs.stat(paths.lock)
          age = Date.now() - stat.mtimeMs
        } catch {
          // It vanished between read and stat: retry immediately.
          continue
        }
        // The owner write happens within a few milliseconds of creation; give
        // it a generous window before deciding the lock is abandoned.
        if (age > LOCK_STALE_MS) {
          await fs.rm(paths.lock, { force: true })
          continue
        }
      } else {
        const since = typeof held.at === 'string' ? Date.parse(held.at) : NaN
        if (!Number.isFinite(since) || Date.now() - since > LOCK_STALE_MS) {
          await fs.rm(paths.lock, { force: true })
          continue
        }
      }
      if (Date.now() > deadline) {
        throw new KbError(
          'kb_locked',
          `统一信息库正被 ${held?.owner ?? '另一个 agent'} 写入（自 ${held?.at ?? '未知时间'}），请稍后重试`,
          { holder: held },
        )
      }
      // Jitter the retry: identical sleeps make all waiters wake together and
      // collide again on the next attempt.
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 40)))
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ owner, token, at: isoNow() }, null, 2), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    return await fn()
  } finally {
    // Only release a lock we still own. If this holder overran the stale
    // window, another writer may have legitimately broken the lock and taken
    // it; deleting unconditionally would then remove *their* lock and let a
    // third writer in, which is how duplicate revisions happen.
    let current
    try {
      current = await readJson(paths.lock)
    } catch {
      current = undefined
    }
    if (current === undefined || current.token === token) {
      await fs.rm(paths.lock, { force: true })
    }
  }
}

function indexPath(paths, key) {
  return path.join(paths.rev, key)
}

function revisionFileName(revision, valueHash) {
  return `${String(revision).padStart(4, '0')}-${valueHash}.json`
}

async function listRevisions(storeDir, key) {
  const paths = kbPaths(storeDir)
  const entries = await listFiles(indexPath(paths, key))
  const revisions = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const rev = await readJson(path.join(indexPath(paths, key), entry.name))
    if (rev === undefined) continue
    revisions.push(rev)
  }
  revisions.sort((left, right) => Number(right.revision) - Number(left.revision))
  return revisions
}

function summaryOf(entry) {
  return {
    key: entry.key,
    kind: entry.kind,
    title: entry.title,
    risk: entry.risk,
    status: entry.status,
    revision: entry.revision,
    value_hash: entry.value_hash,
    // The value travels with the summary: a list where the number is missing
    // forces a second round trip per row, and the whole point of this base is
    // that the live number is what the reader came for.
    value: entry.value ?? '',
    owner_project: entry.owner_project,
    projects: entry.projects ?? [],
    updated_at: entry.updated_at,
    updated_by: entry.updated_by,
    summary_reason: clip(entry.reason ?? '', 160),
    tags: entry.tags ?? [],
    // Unresolved conflicts are marked in-band so a reader can tell "this is the
    // answer" from "two projects disagree and nobody has decided yet".
    pending_decision: Array.isArray(entry.tags) && entry.tags.includes('待裁定'),
  }
}

function normalizeProjects(raw) {
  return stringList(raw, '涉及项目 projects', LIMITS.notes)
    .map((item) => item.trim())
    .filter((item, index, all) => all.indexOf(item) === index)
}

function normalizeEntry(entry) {
  return {
    ...summaryOf(entry),
    value: typeof entry.value === 'string' ? entry.value : '',
    notes: typeof entry.notes === 'string' ? entry.notes : '',
    sources: Array.isArray(entry.sources) ? entry.sources : [],
    created_at: nowIso(entry.created_at),
    created_by: typeof entry.created_by === 'string' ? entry.created_by : '',
    reason: typeof entry.reason === 'string' ? entry.reason : '',
  }
}

/**
 * Register a resource and its first value.
 *
 * Creation is the one write that may omit `reason` only in the sense that the
 * stored reason defaults to `建立条目`; callers are still required to pass an
 * author, because an unattributed shared fact is exactly what this store is
 * meant to end.
 */
export async function createResource(storeDir, input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const key = resourceKey(source.key)
  const title = textField(source.title, '资源标题', LIMITS.titleLength)
  const kind = KB_KINDS.includes(source.kind) ? source.kind : 'other'
  const value = textField(source.value, '资源值', LIMITS.valueLength)
  const author = textField(source.author, '作者 author', LIMITS.authorLength)
  const risk = KB_RISK.includes(source.risk) ? source.risk : 'medium'
  const status = KB_STATUS.includes(source.status) ? source.status : 'active'
  const ownerProject = textField(source.owner_project, '归属项目 owner_project', LIMITS.authorLength, { required: false })
  const reason = textField(source.reason, '变更原因 reason', LIMITS.reasonLength, { required: false }) || '建立条目'
  const notes = textField(source.notes, '备注 notes', LIMITS.valueLength, { required: false })
  const sources = stringList(source.sources, '来源 sources', LIMITS.sources)
  const projects = normalizeProjects(source.projects)
  const tags = stringList(source.tags, '标签 tags', LIMITS.tags).map((tag) => clip(tag, LIMITS.tagLength))

  return withLock(storeDir, author, async () => {
    const paths = kbPaths(storeDir)
    const index = await readIndex(storeDir)
    if (index.resources[key] !== undefined) {
      throw new KbError('kb_exists', `资源 ${key} 已存在（当前修订 r${index.resources[key].revision}）：改用 record_change 更新值`, {
        current: normalizeEntry(await readCurrentRevision(storeDir, key)),
      })
    }
    const at = isoNow()
    const valueHash = hash16(value)
    const entry = {
      key,
      kind,
      title,
      risk,
      status,
      revision: 1,
      value_hash: valueHash,
      value,
      notes,
      sources,
      projects,
      owner_project: ownerProject,
      tags,
      reason,
      created_at: at,
      created_by: author,
      updated_at: at,
      updated_by: author,
    }
    const file = path.join(indexPath(paths, key), revisionFileName(1, valueHash))
    await writeExclusive(
      file,
      `${JSON.stringify(
        {
          key,
          revision: 1,
          at,
          author,
          reason,
          kind,
          title,
          risk,
          status,
          value,
          notes,
          sources,
          projects,
          owner_project: ownerProject,
          tags,
          value_hash: valueHash,
          before: null,
        },
        null,
        2,
      )}\n`,
    )
    index.resources[key] = entry
    index.updatedAt = at
    await writeAtomic(paths.index, `${JSON.stringify(index, null, 2)}\n`)
    await appendChangeLog(storeDir, {
      at,
      key,
      revision: 1,
      action: 'create',
      author,
      reason,
      projects,
      before_preview: '',
      after_preview: clip(value, 200),
    })
    return { created: true, resource: normalizeEntry(entry), revision: 1 }
  })
}

async function readCurrentRevision(storeDir, key) {
  const index = await readIndex(storeDir)
  const entry = index.resources[key]
  if (entry === undefined) throw new KbError('not_found', `资源 ${key} 不在统一信息库里`)
  return entry
}

/**
 * Record a new value for an existing resource.
 *
 * This is the operation the "强制留痕" rule hangs off: there is no code path
 * that changes a shared value without an author, a reason and the projects it
 * affects, and the previous value is preserved verbatim as a `before` snapshot.
 */
export async function recordChange(storeDir, input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const key = resourceKey(source.key)
  const author = textField(source.author, '作者 author', LIMITS.authorLength)
  const reason = textField(source.reason, '变更原因 reason', LIMITS.reasonLength)
  if (reason.length < REASON_MIN) {
    throw new KbError('invalid_input', `变更原因太短（至少 ${REASON_MIN} 字）：别人要能看懂为什么改，例如「B 项目需要划分 5GB，剩余 35GB」`)
  }
  const projects = normalizeProjects(source.projects)
  const hasValue = typeof source.value === 'string'

  return withLock(storeDir, author, async () => {
    const paths = kbPaths(storeDir)
    const index = await readIndex(storeDir)
    const current = index.resources[key]
    if (current === undefined) {
      throw new KbError('not_found', `资源 ${key} 不存在：先用 create_resource 建条目`)
    }
    const expected = source.expect_revision
    if (expected !== undefined && expected !== null) {
      const want = Number(expected)
      if (!Number.isFinite(want) || Math.floor(want) !== Number(current.revision)) {
        throw new KbError(
          'revision_conflict',
          `修订号不匹配：资源 ${key} 已是 r${current.revision}，你基于 r${expected}。先 kb_get 读最新值再合并`,
          { current: normalizeEntry(await readCurrentRevision(storeDir, key)) },
        )
      }
    }
    const nextValue = hasValue ? textField(source.value, '资源值', LIMITS.valueLength) : (current.value ?? '')
    if (!hasValue && source.notes === undefined && source.status === undefined && source.risk === undefined) {
      throw new KbError('invalid_input', 'record_change 至少要改一样东西：value（值）/ notes（备注）/ status（状态）/ risk（风险等级）')
    }
    // `projects` is the set of projects that *depend on* this resource, so a
    // change accumulates rather than replaces: if B drew 5GB out of the cache
    // and C later draws another 5GB, B must still appear in B's own view. The
    // replace-only version silently dropped B, which is exactly the "my number
    // moved and nobody told me" failure this base exists to prevent.
    const touched = projects.length > 0
      ? [...new Set([...(current.projects ?? []), ...projects])].sort()
      : (current.projects ?? [])

    const at = isoNow()
    const revision = Number(current.revision) + 1
    const valueHash = hash16(nextValue)
    const before = {
      value: current.value ?? '',
      notes: current.notes ?? '',
      sources: current.sources ?? [],
      status: current.status ?? 'active',
      risk: current.risk ?? 'medium',
      projects: current.projects ?? [],
    }
    const entry = {
      ...current,
      value: nextValue,
      value_hash: valueHash,
      notes: source.notes !== undefined ? textField(source.notes, '备注 notes', LIMITS.valueLength, { required: false }) : current.notes,
      sources: source.sources !== undefined ? stringList(source.sources, '来源 sources', LIMITS.sources) : current.sources,
      status: KB_STATUS.includes(source.status) ? source.status : current.status,
      risk: KB_RISK.includes(source.risk) ? source.risk : current.risk,
      projects: touched,
      revision,
      reason,
      updated_at: at,
      updated_by: author,
    }
    if (source.title !== undefined) entry.title = textField(source.title, '资源标题', LIMITS.titleLength)
    if (source.kind !== undefined && KB_KINDS.includes(source.kind)) entry.kind = source.kind

    const file = path.join(indexPath(paths, key), revisionFileName(revision, valueHash))
    await writeExclusive(
      file,
      `${JSON.stringify(
        { key, revision, at, author, reason, value: nextValue, notes: entry.notes, sources: entry.sources, projects: touched, status: entry.status, risk: entry.risk, value_hash: valueHash, before },
        null,
        2,
      )}\n`,
    )
    index.resources[key] = entry
    index.updatedAt = at
    await writeAtomic(paths.index, `${JSON.stringify(index, null, 2)}\n`)
    await appendChangeLog(storeDir, {
      at,
      key,
      revision,
      action: 'change',
      author,
      reason,
      projects: touched,
      before_preview: clip(before.value, 200),
      after_preview: clip(nextValue, 200),
    })
    return { created: false, resource: normalizeEntry(entry), revision, before }
  })
}

/**
 * A filesystem-safe slug for a change-log record id.
 *
 * Audit records cover a *scope*, not one key (`*（project）` or `*（全库）`), and
 * those characters are illegal or awkward in Windows filenames — the record is
 * written with O_EXCL, so a bad name is not a mystery failure, it is ENOENT.
 */
function slugForId(key) {
  const cleaned = String(key ?? '')
    .replace(/[()（）*\s]+/g, '-')
    .replace(/[^a-z0-9._-]/gi, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned === '' ? 'all' : cleaned.toLowerCase()
}

async function appendChangeLog(storeDir, change) {
  const paths = await ensureKbDirs(storeDir)
  const id = `${stamp(change.at)}-${slugForId(change.key)}-r${String(change.revision).padStart(4, '0')}`
  const file = path.join(paths.changes, `${id}.json`)
  await writeExclusive(file, `${JSON.stringify({ id, ...change }, null, 2)}\n`)
  await rewriteChangelog(storeDir)
  return id
}

function renderChangelog(changes) {
  const lines = [
    '# 统一信息库 · 变更流水（CHANGELOG）',
    '',
    '> 本文件由统一信息库自动生成，**不要手工编辑**：每次 `kb_record_change` / `kb_create_resource` / `kb_audit`',
    '> 都会追加一条不可变记录并重写此表。历史真相在 `kb/changes/*.json` 与 `kb/rev/<key>/*.json`。',
    '>',
    '> 回到上一个值：`kb_record_change`（key + value: 旧值 + reason: 回退原因 + author）。',
    '',
    '| 时间 (UTC) | 资源 | 修订 | 变更类型 | 作者 | 涉及项目 | 原因 | 变更前 → 变更后 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const change of changes) {
    const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
    const delta = change.action === 'audit'
      ? `${cell(change.after_preview) || '—'}（核对无变化）`
      : `${cell(change.before_preview) || '—'} → ${cell(change.after_preview) || '—'}`
    lines.push(
      `| ${change.at} | \`${cell(change.key)}\` | r${change.revision} | ${cell(change.action)} | ${cell(change.author)} | ${cell((change.projects ?? []).join(', '))} | ${cell(change.reason)} | ${delta} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

async function rewriteChangelog(storeDir) {
  const paths = await ensureKbDirs(storeDir)
  const entries = await listFiles(paths.changes)
  const changes = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const change = await readJson(path.join(paths.changes, entry.name))
    if (change === undefined) continue
    changes.push(change)
  }
  changes.sort((left, right) => String(left.at).localeCompare(String(right.at)))
  await writeAtomic(paths.changelog, renderChangelog(changes))
  return changes.length
}

/**
 * Read one resource with its full revision history.
 *
 * `include_history: false` exists for the hot path (a gate check on every
 * write), where only the revision number matters.
 */
export async function getResource(storeDir, input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const key = resourceKey(source.key)
  const entry = await readCurrentRevision(storeDir, key)
  const includeHistory = source.include_history !== false
  const limit = Number.isFinite(Number(source.history_limit))
    ? Math.max(1, Math.min(100, Math.floor(Number(source.history_limit))))
    : LIMITS.historyDefault
  const revisions = includeHistory ? (await listRevisions(storeDir, key)).slice(0, limit) : []
  return {
    resource: normalizeEntry(entry),
    revisions: revisions.map((rev) => ({
      revision: rev.revision,
      at: rev.at,
      author: rev.author,
      reason: rev.reason,
      projects: rev.projects ?? [],
      value_hash: rev.value_hash,
      before_value: rev.before === null || rev.before === undefined ? null : (rev.before.value ?? ''),
      after_value: rev.value ?? '',
    })),
  }
}

export async function listResources(storeDir, input = {}) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const index = await readIndex(storeDir)
  const needle = typeof source.query === 'string' ? source.query.trim().toLowerCase() : ''
  const project = typeof source.project === 'string' ? source.project.trim() : ''
  const kind = KB_KINDS.includes(source.kind) ? source.kind : ''
  const risk = KB_RISK.includes(source.risk) ? source.risk : ''
  const status = KB_STATUS.includes(source.status) ? source.status : ''
  const rows = []
  for (const entry of Object.values(index.resources)) {
    if (kind !== '' && entry.kind !== kind) continue
    if (risk !== '' && entry.risk !== risk) continue
    if (status !== '' && entry.status !== status) continue
    if (project !== '' && !(entry.projects ?? []).includes(project) && entry.owner_project !== project) continue
    if (needle !== '') {
      const haystack = `${entry.key} ${entry.title} ${entry.value} ${entry.notes ?? ''} ${(entry.tags ?? []).join(' ')}`.toLowerCase()
      if (!haystack.includes(needle)) continue
    }
    rows.push(summaryOf(entry))
  }
  rows.sort((left, right) => left.key.localeCompare(right.key))
  return { resources: rows, total: rows.length, updated_at: index.updatedAt }
}

/** Distinct project ids referenced anywhere in the base (owners + touched). */
export function projectsOf(entries) {
  const set = new Set()
  for (const entry of entries) {
    if (entry.owner_project) set.add(entry.owner_project)
    for (const project of entry.projects ?? []) set.add(project)
  }
  return [...set].sort()
}

/**
 * A per-project view of the shared base.
 *
 * A project that only reads `PROJECT.md` never learns that the 40G cache it
 * depends on was cut to 35G. This renders the slice that mentions the project,
 * including live values, so the surprising numbers are in front of the reader.
 */
export async function projectView(storeDir, projectId, input = {}) {
  const id = typeof projectId === 'string' ? projectId.trim() : ''
  if (id === '') throw new KbError('invalid_input', '缺少 projectId')
  const source = input !== null && typeof input === 'object' ? input : {}
  const index = await readIndex(storeDir)
  const mine = []
  const shared = []
  for (const entry of Object.values(index.resources)) {
    const touched = (entry.projects ?? []).includes(id)
    if (entry.owner_project === id || touched) mine.push(summaryOf(entry))
    else if (entry.risk === 'critical') shared.push(summaryOf(entry))
  }
  mine.sort((left, right) => left.key.localeCompare(right.key))
  shared.sort((left, right) => left.key.localeCompare(right.key))
  if (source.include_values !== false) {
    for (const row of mine) {
      const entry = index.resources[row.key]
      row.value = entry.value
      row.sources = entry.sources ?? []
      row.notes = entry.notes ?? ''
    }
  }
  return { project: id, mine, critical_elsewhere: shared, updated_at: index.updatedAt }
}

export async function kbStatus(storeDir) {
  const index = await readIndex(storeDir)
  const entries = Object.values(index.resources)
  const paths = kbPaths(storeDir)
  const changes = await listFiles(paths.changes)
  const byProject = {}
  for (const entry of entries) {
    for (const project of entry.projects ?? []) {
      byProject[project] = (byProject[project] ?? 0) + 1
    }
  }
  const kinds = {}
  for (const entry of entries) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1
  return {
    store_dir: storeDir,
    resources: entries.length,
    changes: changes.filter((item) => item.isFile() && item.name.endsWith('.json')).length,
    projects: projectsOf(entries),
    by_project: byProject,
    by_kind: kinds,
    updated_at: index.updatedAt,
  }
}

/* ------------------------------------------------------------------ *
 * Gating: "更新信息是强制性的，每次完成一个小阶段必须更新信息"
 * ------------------------------------------------------------------ */

/**
 * Prove an agent looked at the slice of the base that its current work touches.
 *
 * This is deliberately *not* a value write: most stages do not change a shared
 * resource, and forcing a fake change would poison the history. Instead the
 * check costs one read-shaped call whose result is recorded in the same
 * append-only change log (action `audit`), with the list it covered. The gate
 * then asks "did this author read this slice since its last change", which is
 * answerable, cheap, and leaves a trail of who looked at what and when.
 */
export async function auditSlice(storeDir, input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const author = textField(source.author, '作者 author', LIMITS.authorLength)
  const project = textField(source.project, '项目 project', LIMITS.authorLength, { required: false })
  const keys = stringList(source.keys, '核对条目 keys', 100).map((key) => resourceKey(key))
  const stage = textField(source.stage, '阶段说明 stage', LIMITS.reasonLength)
  const note = textField(source.note, '核对结论 note', LIMITS.reasonLength, { required: false })

  const index = await readIndex(storeDir)
  const covered = keys.length > 0 ? keys : Object.values(index.resources)
    .filter((entry) => project === '' || entry.owner_project === project || (entry.projects ?? []).includes(project))
    .map((entry) => entry.key)
  if (covered.length === 0) {
    throw new KbError('invalid_input', `没有可核对的条目${project === '' ? '' : `（项目 ${project} 在统一信息库里没有任何条目）`}`)
  }
  const missing = covered.filter((key) => index.resources[key] === undefined)
  if (missing.length > 0) {
    throw new KbError('not_found', `这些 key 不在库里：${missing.join(', ')}`)
  }
  const at = isoNow()
  const digest = covered
    .map((key) => `${key}@r${index.resources[key].revision}`)
    .sort()
    .join(' | ')
  const id = await withLock(storeDir, author, async () =>
    appendChangeLog(storeDir, {
      at,
      key: project === '' ? '*（全库）' : `*（${project}）`,
      revision: 0,
      action: 'audit',
      author,
      reason: note === '' ? stage : `${stage}｜${note}`,
      projects: project === '' ? [] : [project],
      before_preview: '',
      after_preview: digest,
      covered,
    }),
  )
  return { audit_id: id, at, author, project, covered, digest, stage, note }
}

/**
 * Gate: does `author` have a recorded audit (or a change) covering `keys` that
 * is at least as new as every listed resource's latest revision?
 *
 * "Latest revision" is the honest bar: if someone changed the cache size after
 * your audit, your audit no longer describes the world you are claiming.
 */
export async function gateStatus(storeDir, input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const author = textField(source.author, '作者 author', LIMITS.authorLength)
  const project = textField(source.project, '项目 project', LIMITS.authorLength, { required: false })
  const keys = stringList(source.keys, '核对条目 keys', 100).map((key) => resourceKey(key))
  const index = await readIndex(storeDir)
  const relevant = keys.length > 0 ? keys : Object.values(index.resources)
    .filter((entry) => project === '' || entry.owner_project === project || (entry.projects ?? []).includes(project))
    .map((entry) => entry.key)
  if (relevant.length === 0) {
    return { ok: true, reason: '该范围在统一信息库里没有条目，无需核对', author, missing: [], covered: [] }
  }
  const missing = relevant.filter((key) => index.resources[key] === undefined)

  const paths = kbPaths(storeDir)
  const files = await listFiles(paths.changes)
  const records = []
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue
    const change = await readJson(path.join(paths.changes, file.name))
    if (change === undefined) continue
    if (change.author !== author) continue
    records.push(change)
  }
  records.sort((left, right) => String(right.at).localeCompare(String(left.at)))

  const latestRev = new Map(relevant.map((key) => [key, Number(index.resources[key]?.revision ?? 0)]))
  const uncovered = []
  for (const key of relevant) {
    const want = latestRev.get(key) ?? 0
    const hit = records.find((change) => {
      // An audit is a *promise about revisions*, so it is evaluated first: it is
      // the only record that can be invalidated by somebody else's later write.
      if (change.action === 'audit') {
        if (!Array.isArray(change.covered) || !change.covered.includes(key)) return false
        // The audit must have been taken at this very revision, else it is stale.
        const digest = String(change.after_preview ?? '')
          .split('|')
          .map((part) => part.trim())
        return digest.includes(`${key}@r${want}`)
      }
      if (change.action === 'change') {
        // Your own update of this very key is evidence you looked at it at this
        // revision. `create` deliberately does NOT count: adding a new entry
        // says nothing about whether you read the rest of the shared slice.
        return change.key === key && Number(change.revision) >= want
      }
      return false
    })
    if (hit === undefined) uncovered.push({ key, revision: want, title: index.resources[key]?.title ?? '' })
  }
  return {
    ok: uncovered.length === 0 && missing.length === 0,
    author,
    project: project === '' ? null : project,
    covered: relevant.filter((key) => !uncovered.some((item) => item.key === key)),
    uncovered,
    missing,
    checked_at: isoNow(),
  }
}

/**
 * Write a project's consumer view (`kb/views/<project>.json`), so a project's
 * side of the base is greppable from disk without going through the plugin.
 */
export async function writeView(storeDir, projectId) {
  const view = await projectView(storeDir, projectId, { include_values: true })
  const paths = kbPaths(storeDir)
  const file = path.join(paths.views, `${projectId}.json`)
  await writeAtomic(file, `${JSON.stringify({ ...view, generated_at: isoNow() }, null, 2)}\n`)
  return file
}

export async function refreshAllViews(storeDir, projects) {
  const paths = await ensureKbDirs(storeDir)
  const existing = await listFiles(paths.views)
  const written = []
  const wanted = new Set(projects)
  for (const entry of existing) {
    if (entry.isFile() && entry.name.endsWith('.json')) wanted.add(entry.name.replace(/\.json$/, ''))
  }
  for (const project of wanted) {
    written.push(await writeView(storeDir, project))
  }
  return written
}

export function renderViewMarkdown(view) {
  const lines = [
    `# 统一信息库 · ${view.project} 视图`,
    '',
    `> 生成时间 ${view.updated_at || '—'}。**只读视图**：值以 \`kb/RESOURCES.json\` 为准，修改请用 \`kb_record_change\`。`,
    '',
    '## 本项目涉及 / 归属的资源',
    '',
  ]
  if (view.mine.length === 0) {
    lines.push('_暂无。项目用到的共享资源请在 `kb_record_change` / `kb_create_resource` 的 projects 里登记。_')
  } else {
    lines.push('| 资源 | 类型 | 风险 | 当前值 | 修订 | 最近更新 |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const row of view.mine) {
      lines.push(
        `| \`${row.key}\` ${String(row.title ?? '').replace(/\|/g, '\\|')} | ${row.kind} | ${row.risk} | ${String(row.value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} | r${row.revision} | ${row.updated_at} · ${row.updated_by} |`,
      )
    }
  }
  lines.push('', '## 全库 critical 资源（即使不属于本项目改动了也会影响你）', '')
  if (view.critical_elsewhere.length === 0) lines.push('_暂无_')
  else {
    lines.push('| 资源 | 当前值 | 修订 | 最近更新 |')
    lines.push('| --- | --- | --- | --- |')
    for (const row of view.critical_elsewhere) {
      lines.push(`| \`${row.key}\` ${String(row.title ?? '').replace(/\|/g, '\\|')} | ${String(row.owner_project ?? '')} | r${row.revision} | ${row.updated_at} |`)
    }
  }
  lines.push('')
  return lines.join('\n')
}
