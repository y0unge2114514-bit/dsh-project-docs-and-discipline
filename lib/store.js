/**
 * Filesystem store for the 项目文档 (project-docs) bundle.
 *
 * Deliberately free of Cordis: the Host half wraps it with HTTP routes and
 * agent tools, and `test-store.mjs` drives it directly with plain Node.
 *
 * Layout under `storeDir`:
 *
 *   projects/<projectId>/project.json            project metadata
 *   projects/<projectId>/docs/project/*.md       项目文档
 *   projects/<projectId>/docs/collab/*.md        合作文档
 *   projects/<projectId>/board/human/*.json      人类留言（每贴一个不可变文件）
 *   projects/<projectId>/board/agent/*.json      Agent 留言（每贴一个不可变文件）
 *   projects/<projectId>/tools/*.json            公共工具库登记（跨项目检索）
 *
 * Boards are append-only by construction: one immutable file per entry, so two
 * agents posting at the same time never overwrite each other. Documents are
 * mutable but writes are compare-and-set on a content hash.
 *
 * @module @local/dsh-project-docs/store
 */
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const DOC_KINDS = ['project', 'collab', 'credential']
export const BOARDS = ['human', 'agent']
export const MESSAGE_KINDS = ['note', 'question', 'warning', 'handoff', 'claim', 'reply']
/** Dimensions of a delivery proof (see `evidence-policy.js`). */
export const EVIDENCE_DIMENSIONS = ['request', 'file', 'env']

const LIMITS = {
  docBytes: 512 * 1024,
  messageBytes: 32 * 1024,
  toolField: 4000,
  nameLength: 80,
  titleLength: 120,
  summaryLength: 400,
  authorLength: 60,
  tags: 12,
  tagLength: 40,
  limitDefault: 30,
  limitMax: 100,
}

/**
 * How long a stale lock is considered abandoned.
 *
 * A process that dies while holding the lock must not block every other writer
 * forever. Thirty seconds is comfortably longer than any write this store does
 * (a few milliseconds of fsync) and short enough that a crashed agent is
 * noticed within one retry cycle.
 */
const LOCK_STALE_MS = 30_000

/**
 * Serialise read-modify-write on a document.
 *
 * WHY THIS EXISTS
 * ---------------
 * `writeDoc` compares `base_hash` against the file on disk and then writes. That
 * is check-then-act: two agents that both read revision N pass the comparison
 * before either writes, and the second write silently replaces the first. The
 * `writeAtomic` temp+rename guarantees each file is *whole*, not that the update
 * was *serialised* — so a concurrent edit loses one side's work with no error.
 *
 * The knowledge base (`kb.js`) had the same bug and it was fixed with an
 * `O_EXCL` lock; the document store never got one. This is that lock, kept local
 * to the file being written (a lock per document, not per library) so unrelated
 * documents never contend.
 *
 * Releasing compares the owner token: a holder that overran the stale window
 * must not delete a lock another writer legitimately took over.
 */
async function withDocLock(target, owner, fn) {
  const lockPath = `${target}.lock`
  const token = randomBytes(6).toString('hex')
  const deadline = Date.now() + 8000
  let handle
  for (;;) {
    try {
      handle = await fs.open(lockPath, 'wx')
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const held = await readJson(lockPath)
      if (held === undefined) {
        // Created but not yet written, or torn. Judge by the file's own age, not
        // by a parse failure: the winner writes its owner milliseconds later.
        let age = 0
        try {
          const stat = await fs.stat(lockPath)
          age = Date.now() - stat.mtimeMs
        } catch {
          continue
        }
        if (age > LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true })
          continue
        }
      } else {
        const since = typeof held.at === 'string' ? Date.parse(held.at) : NaN
        if (!Number.isFinite(since) || Date.now() - since > LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true })
          continue
        }
      }
      if (Date.now() > deadline) {
        throw new ConflictError(
          'doc_locked',
          `文档正被 ${held?.owner ?? '另一个 agent'} 写入（自 ${held?.at ?? '未知时间'}），请稍后重试`,
          { holder: held },
        )
      }
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
    let current
    try {
      current = await readJson(lockPath)
    } catch {
      current = undefined
    }
    if (current === undefined || current.token === token) {
      await fs.rm(lockPath, { force: true })
    }
  }
}

export class StoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.details = details
  }
}

export class NotFoundError extends StoreError {
  constructor(message) {
    super('not_found', message)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends StoreError {
  constructor(code, message, details) {
    super(code, message, details)
    this.name = 'ConflictError'
  }
}

export function normalizeOptions(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const storeDir = typeof source.storeDir === 'string' && source.storeDir.trim() !== ''
    ? path.resolve(source.storeDir.trim())
    : path.resolve(process.env.DSH_HOME ?? process.cwd(), 'project-docs')
  return { storeDir }
}

function hash16(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
}

function isoNow() {
  return new Date().toISOString()
}

/** Compact, lexicographically sortable UTC stamp for message file names. */
function stamp(at) {
  const date = at.slice(0, 10).replace(/-/g, '')
  const time = at.slice(11, 23).replace(/[:.]/g, '')
  return `${date}T${time}`
}

function clip(text, max) {
  const value = typeof text === 'string' ? text : ''
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function textField(raw, what, max, { required = true } = {}) {
  if (raw === undefined || raw === null) {
    if (required) throw new StoreError('invalid_input', `${what} 不能为空`)
    return ''
  }
  if (typeof raw !== 'string') throw new StoreError('invalid_input', `${what} 必须是文本`)
  const value = raw.trim()
  if (required && value === '') throw new StoreError('invalid_input', `${what} 不能为空`)
  if (value.length > max) throw new StoreError('invalid_input', `${what} 超过 ${max} 字符`)
  return value
}

/** Reject anything that could escape the store directory or break Windows names. */
function safeSegment(raw, what, max = LIMITS.nameLength) {
  const value = textField(raw, what, max)
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(value)) {
    throw new StoreError('invalid_name', `${what} 不能包含 \\ / : * ? " < > | 或控制字符`)
  }
  if (value === '.' || value === '..' || value.startsWith('.') || /[. ]$/.test(value)) {
    throw new StoreError('invalid_name', `${what} 不能以点开头或以点/空格结尾`)
  }
  return value
}

function projectIdFrom(title) {
  const base = String(title ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .slice(0, 40)
  return base === '' ? `p-${randomBytes(3).toString('hex')}` : base
}

function validateProjectId(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new StoreError('invalid_input', '缺少项目 id')
  const value = raw.trim()
  if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(value)) {
    throw new StoreError('invalid_name', '项目 id 只能包含字母、数字、汉字、_ 和 -，最长 40')
  }
  return value
}

function docFileName(raw) {
  const base = safeSegment(raw, '文档名')
  return /\.md$/i.test(base) ? base : `${base}.md`
}

function docTitle(content, name) {
  const match = /^\uFEFF?#\s+(.+)$/m.exec(content)
  if (match !== null && match[1].trim() !== '') return match[1].trim()
  return name.replace(/\.md$/i, '')
}

export function projectPaths(storeDir, id) {
  const root = path.join(storeDir, 'projects', id)
  return {
    root,
    meta: path.join(root, 'project.json'),
    docs: {
      project: path.join(root, 'docs', 'project'),
      collab: path.join(root, 'docs', 'collab'),
      credential: path.join(root, 'docs', 'credential'),
    },
    boards: {
      human: path.join(root, 'board', 'human'),
      agent: path.join(root, 'board', 'agent'),
    },
    tools: path.join(root, 'tools'),
    claims: path.join(root, 'claims'),
    archive: path.join(root, 'archive'),
    evidence: path.join(root, 'evidence'),
  }
}

async function readJson(file) {
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  // A torn write (unclean shutdown) can leave NUL padding or half a document;
  // treat it as absent instead of failing every later operation.
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8')
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
    // Flush before the rename: an unclean shutdown otherwise leaves the
    // published file as NUL bytes even though the name exists.
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temp, file)
}

async function listFiles(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

export async function ensureProjectDirs(storeDir, id) {
  const paths = projectPaths(storeDir, id)
  await fs.mkdir(paths.docs.project, { recursive: true })
  await fs.mkdir(paths.docs.collab, { recursive: true })
  await fs.mkdir(paths.docs.credential, { recursive: true })
  await fs.mkdir(paths.boards.human, { recursive: true })
  await fs.mkdir(paths.boards.agent, { recursive: true })
  await fs.mkdir(paths.tools, { recursive: true })
  await fs.mkdir(paths.claims, { recursive: true })
  await fs.mkdir(paths.evidence, { recursive: true })
  return paths
}

async function projectMeta(storeDir, id) {
  const paths = projectPaths(storeDir, id)
  const meta = await readJson(paths.meta)
  if (meta === undefined) {
    // Do not hide a project whose metadata was torn: its documents and boards
    // are still on disk and must stay reachable.
    try {
      const stat = await fs.stat(paths.root)
      if (!stat.isDirectory()) return undefined
    } catch {
      return undefined
    }
    return { id, title: id, root: '', summary: '', createdAt: '', updatedAt: '', corrupt: true }
  }
  return {
    id,
    title: typeof meta.title === 'string' && meta.title !== '' ? meta.title : id,
    root: typeof meta.root === 'string' ? meta.root : '',
    summary: typeof meta.summary === 'string' ? meta.summary : '',
    createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : '',
    updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : '',
  }
}

async function requireProject(storeDir, id) {
  const project = await projectMeta(storeDir, id)
  if (project === undefined) throw new NotFoundError(`项目 ${id} 不存在`)
  return project
}

/**
 * Bump a project's `updatedAt`.
 *
 * This is metadata, not content: concurrent callers may stamp the same file at
 * once, and on Windows two overlapping temp+rename pairs onto one target raise
 * `EPERM` mid-rename (observed under the concurrent-write test). Losing a
 * timestamp is harmless; failing the write that triggered it is not. So a
 * metadata touch never throws — it is best effort, and it retries once.
 */
async function touchProject(storeDir, id) {
  const paths = projectPaths(storeDir, id)
  const meta = await readJson(paths.meta)
  if (meta === undefined) return
  meta.updatedAt = isoNow()
  const payload = `${JSON.stringify(meta, null, 2)}\n`
  try {
    await writeAtomic(paths.meta, payload)
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EBUSY' && error.code !== 'ENOENT') throw error
    // Another writer is renaming into the same target right now; try once more
    // after a short beat, then give up rather than failing the caller.
    await new Promise((resolve) => setTimeout(resolve, 30))
    try {
      await writeAtomic(paths.meta, payload)
    } catch {
      // Metadata only. A stale `updatedAt` never justifies losing a document.
    }
  }
}

async function messageCount(dir) {
  const entries = await listFiles(dir)
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length
}

async function latestMessage(dir) {
  const entries = await listFiles(dir)
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
    .reverse()
  const newest = files[0]
  if (newest === undefined) return undefined
  const entry = await readJson(path.join(dir, newest))
  if (entry === undefined) return undefined
  return {
    at: typeof entry.at === 'string' ? entry.at : '',
    author: typeof entry.author === 'string' ? entry.author : '',
    kind: typeof entry.kind === 'string' ? entry.kind : 'note',
    preview: clip(typeof entry.text === 'string' ? entry.text.replace(/\s+/g, ' ') : '', 80),
  }
}

async function listDocsIn(storeDir, id, kind) {
  if (!DOC_KINDS.includes(kind)) throw new StoreError('invalid_input', `未知文档分类 ${kind}`)
  const dir = projectPaths(storeDir, id).docs[kind]
  const entries = await listFiles(dir)
  const docs = []
  for (const entry of entries) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
    const file = path.join(dir, entry.name)
    const content = await readText(file)
    if (content === undefined) continue
    const stat = await fs.stat(file)
    docs.push({
      name: entry.name,
      title: docTitle(content, entry.name),
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
      hash: hash16(content),
    })
  }
  docs.sort((left, right) => left.title.localeCompare(right.title, 'zh-Hans-CN'))
  return docs
}

export async function listDocs(storeDir, id, kind) {
  await requireProject(storeDir, id)
  return listDocsIn(storeDir, id, kind)
}

export async function readDoc(storeDir, id, kind, name) {
  await requireProject(storeDir, id)
  if (!DOC_KINDS.includes(kind)) throw new StoreError('invalid_input', `未知文档分类 ${kind}`)
  const fileName = docFileName(name)
  const file = path.join(projectPaths(storeDir, id).docs[kind], fileName)
  const content = await readText(file)
  if (content === undefined) throw new NotFoundError(`文档 ${fileName} 不存在`)
  const stat = await fs.stat(file)
  return {
    kind,
    name: fileName,
    title: docTitle(content, fileName),
    content,
    hash: hash16(content),
    bytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
  }
}

/**
 * Keyword search across current AND archived documents.
 *
 * Archived documents stay inside the library (just out of the reading flow), so
 * "did we already investigate this?" must search them too — otherwise an agent
 * re-derives an old conclusion and burns tokens rediscovering an answer that is
 * already on disk.
 */
export async function searchDocs(storeDir, query, input = {}) {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (needle === '') throw new StoreError('invalid_input', '搜索关键词不能为空')
  const options = input !== null && typeof input === 'object' ? input : {}
  const projectId = typeof options.project === 'string' ? options.project.trim() : ''
  const rawLimit = Number(options.limit)
  const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20, 50))
  const includeArchived = options.include_archived !== false
  const ids = projectId === '' ? (await listProjects(storeDir)).map((project) => project.id) : [projectId]

  const hits = []
  const scan = async (id, dir, archived) => {
    if (archived && !includeArchived) return
    const entries = await listFiles(dir)
    for (const entry of entries) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
      const file = path.join(dir, entry.name)
      const content = await readText(file)
      if (content === undefined) continue
      const lower = content.toLowerCase()
      const index = lower.indexOf(needle)
      if (index < 0 && !entry.name.toLowerCase().includes(needle)) continue
      const start = Math.max(0, index - 40)
      const snippet = index < 0
        ? ''
        : content.slice(start, Math.min(content.length, index + needle.length + 120)).replace(/\s+/g, ' ').trim()
      const stat = await fs.stat(file)
      hits.push({
        project: id,
        kind: archived ? 'archived' : (entry.name.includes('__') ? entry.name.split('__')[0] : 'project'),
        name: entry.name,
        title: docTitle(content, entry.name),
        archived,
        bytes: stat.size,
        snippet,
      })
    }
  }
  for (const id of ids) {
    const paths = projectPaths(storeDir, id)
    for (const kind of DOC_KINDS) await scan(id, paths.docs[kind], false)
    await scan(id, paths.archive, true)
    if (hits.length >= limit) break
  }
  // Current docs before archived ones: a live conclusion outranks history.
  hits.sort((left, right) => Number(left.archived) - Number(right.archived))
  return { query, project: projectId, hits: hits.slice(0, limit), total: hits.length }
}

/**
 * Write a document. When it already exists, `baseHash` must equal the hash of
 * the content being replaced; otherwise the write is refused with the current
 * document attached, so concurrent editors cannot silently clobber each other.
 */
export async function writeDoc(storeDir, id, kind, name, content, baseHash) {
  await requireProject(storeDir, id)
  if (!DOC_KINDS.includes(kind)) throw new StoreError('invalid_input', `未知文档分类 ${kind}`)
  if (typeof content !== 'string') throw new StoreError('invalid_input', 'content 必须是文本')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > LIMITS.docBytes) throw new StoreError('invalid_input', `文档超过 ${Math.round(LIMITS.docBytes / 1024)} KB`)
  const fileName = docFileName(name)
  const file = path.join(projectPaths(storeDir, id).docs[kind], fileName)

  // Read-compare-write must be atomic per document, or two agents that both saw
  // revision N will both pass the check and the second silently wins. The lock
  // is per file, so writing one document never blocks another.
  return withDocLock(file, `${id}/${kind}/${fileName}`, async () => {
    const existing = await readText(file)
    if (existing !== undefined) {
      const currentHash = hash16(existing)
      const provided = typeof baseHash === 'string' ? baseHash.trim() : ''
      if (provided === '') {
        throw new ConflictError('doc_exists', `文档 ${fileName} 已存在：先读取它，再带上 base_hash 覆盖`, {
          current: { ...(await readDoc(storeDir, id, kind, fileName)) },
        })
      }
      if (provided !== currentHash) {
        throw new ConflictError('doc_conflict', `文档 ${fileName} 已被他人修改：请基于最新内容合并后重试`, {
          current: { ...(await readDoc(storeDir, id, kind, fileName)) },
        })
      }
    }
    await writeAtomic(file, content)
    await touchProject(storeDir, id)
    const doc = await readDoc(storeDir, id, kind, fileName)
    return { ...doc, created: existing === undefined }
  })
}

export async function postMessage(storeDir, id, board, input) {
  await requireProject(storeDir, id)
  if (!BOARDS.includes(board)) throw new StoreError('invalid_input', `未知留言板 ${board}`)
  const source = input !== null && typeof input === 'object' ? input : {}
  const text = typeof source.text === 'string' ? source.text : ''
  if (text.trim() === '') throw new StoreError('invalid_input', '留言内容不能为空')
  if (Buffer.byteLength(text, 'utf8') > LIMITS.messageBytes) {
    throw new StoreError('invalid_input', `留言超过 ${Math.round(LIMITS.messageBytes / 1024)} KB`)
  }
  const author = source.author === undefined ? (board === 'agent' ? 'agent' : 'human') : textField(source.author, '作者', LIMITS.authorLength)
  const kind = MESSAGE_KINDS.includes(source.kind) ? source.kind : 'note'
  const to = typeof source.to === 'string' && source.to.trim() !== ''
    ? textField(source.to, '收件 agent', LIMITS.authorLength)
    : ''
  const at = isoNow()
  const entry = {
    id: `${stamp(at)}-${randomBytes(3).toString('hex')}`,
    at,
    board,
    author,
    kind,
    to,
    text,
  }
  const file = path.join(projectPaths(storeDir, id).boards[board], `${entry.id}.json`)
  await writeAtomic(file, `${JSON.stringify(entry, null, 2)}\n`)
  await touchProject(storeDir, id)
  return entry
}

export async function listMessages(storeDir, id, board, limit) {
  await requireProject(storeDir, id)
  if (!BOARDS.includes(board)) throw new StoreError('invalid_input', `未知留言板 ${board}`)
  const requested = Number.isFinite(limit) ? Math.floor(limit) : LIMITS.limitDefault
  const count = Math.min(LIMITS.limitMax, Math.max(1, requested))
  const dir = projectPaths(storeDir, id).boards[board]
  const entries = await listFiles(dir)
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
    .reverse()
  const total = files.length
  const page = []
  for (const name of files.slice(0, count)) {
    const entry = await readJson(path.join(dir, name))
    if (entry === undefined) continue
    page.push({
      id: typeof entry.id === 'string' ? entry.id : name.replace(/\.json$/, ''),
      at: typeof entry.at === 'string' ? entry.at : '',
      board,
      author: typeof entry.author === 'string' ? entry.author : '',
      kind: typeof entry.kind === 'string' ? entry.kind : 'note',
      to: typeof entry.to === 'string' ? entry.to : '',
      text: typeof entry.text === 'string' ? entry.text : '',
    })
  }
  return { board, entries: page, total, hasMore: total > page.length }
}

/* ------------------------------------------------------------------ claims */

const CLAIM_DEFAULT_TTL_MIN = 120
const CLAIM_MIN_TTL_MIN = 5
const CLAIM_MAX_TTL_MIN = 720

function claimOf(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const expiresAt = typeof raw.expiresAt === 'string' ? raw.expiresAt : ''
  if (expiresAt === '') return undefined
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    project: typeof raw.project === 'string' ? raw.project : '',
    agent: typeof raw.agent === 'string' ? raw.agent : '',
    scope: typeof raw.scope === 'string' ? raw.scope : '',
    note: typeof raw.note === 'string' ? raw.note : '',
    progress: typeof raw.progress === 'string' ? raw.progress : '',
    nextStep: typeof raw.nextStep === 'string' ? raw.nextStep : '',
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    expiresAt,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
  }
}

/**
 * Active (unexpired) claims of one project, newest first. Claims are leases:
 * each one carries an expiry, so an Agent that dies mid-task cannot block the
 * project forever.
 */
export async function activeClaims(storeDir, id) {
  const dir = projectPaths(storeDir, id).claims
  const entries = await listFiles(dir)
  const now = Date.now()
  const claims = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = path.join(dir, entry.name)
    const claim = claimOf(await readJson(file))
    if (claim === undefined) continue
    if (!(Date.parse(claim.expiresAt) > now)) {
      // Expired: tidy up, but never fail a read because of it.
      await fs.rm(file, { force: true }).catch(() => {})
      continue
    }
    claims.push(claim)
  }
  claims.sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
  return claims
}

function claimTtlMinutes(raw) {
  const requested = Number(raw)
  return Number.isFinite(requested)
    ? Math.max(CLAIM_MIN_TTL_MIN, Math.min(CLAIM_MAX_TTL_MIN, Math.floor(requested)))
    : CLAIM_DEFAULT_TTL_MIN
}

function optionalClaimField(raw, what) {
  return typeof raw === 'string' && raw.trim() !== '' ? textField(raw, what, LIMITS.toolField) : ''
}

/**
 * Register a claim, or update an existing one of the same agent.
 *
 * Updating (`claim_id`) records `progress` / `next_step` and renews the lease:
 * a claim is a coordination channel between parallel agents, not a one-shot
 * fence — peers need to see what the other side is doing and what comes next.
 */
export async function claimWork(storeDir, id, input) {
  await requireProject(storeDir, id)
  const source = input !== null && typeof input === 'object' ? input : {}
  const agent = textField(source.agent, '认领人（agent）', LIMITS.authorLength)
  const wanted = typeof source.claim_id === 'string' ? source.claim_id.trim() : ''
  const progress = optionalClaimField(source.progress, '进度')
  const nextStep = optionalClaimField(source.next_step, '下一步')
  const note = optionalClaimField(source.note, '备注')
  const ttl = claimTtlMinutes(source.ttl_minutes)
  const nowIso = isoNow()
  const expiresAt = new Date(Date.parse(nowIso) + ttl * 60_000).toISOString()
  const dir = projectPaths(storeDir, id).claims
  const sessionId = typeof source.session_id === 'string' ? clip(source.session_id, 80) : ''

  if (wanted !== '') {
    const entries = await listFiles(dir)
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const file = path.join(dir, entry.name)
      const existing = claimOf(await readJson(file))
      if (existing === undefined || existing.agent !== agent || existing.id !== wanted) continue
      const updated = {
        ...existing,
        scope: typeof source.scope === 'string' && source.scope.trim() !== ''
          ? textField(source.scope, '认领范围（scope）', LIMITS.summaryLength)
          : existing.scope,
        note: note !== '' ? note : existing.note,
        progress: progress !== '' ? progress : existing.progress,
        nextStep: nextStep !== '' ? nextStep : existing.nextStep,
        updatedAt: nowIso,
        expiresAt: Number.isFinite(Number(source.ttl_minutes)) ? expiresAt : existing.expiresAt,
        sessionId: sessionId !== '' ? sessionId : existing.sessionId,
      }
      await writeAtomic(file, `${JSON.stringify(updated, null, 2)}\n`)
      await touchProject(storeDir, id)
      return { ...updated, updated: true }
    }
    throw new NotFoundError(`认领 #${wanted} 不存在或不属于 ${agent}；用 list_claims 确认认领号`)
  }

  const scope = textField(source.scope, '认领范围（scope）', LIMITS.summaryLength)
  const claim = {
    id: `${stamp(nowIso)}-${randomBytes(3).toString('hex')}`,
    project: id,
    agent,
    scope,
    note,
    progress,
    nextStep,
    startedAt: nowIso,
    updatedAt: nowIso,
    expiresAt,
    sessionId,
  }
  const file = path.join(dir, `${claim.id}.json`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeAtomic(file, `${JSON.stringify(claim, null, 2)}\n`)
  await touchProject(storeDir, id)
  return { ...claim, updated: false }
}

/** Release the caller's own claims; a specific one when `claim_id` is given. */
export async function releaseClaim(storeDir, id, input) {
  await requireProject(storeDir, id)
  const source = input !== null && typeof input === 'object' ? input : {}
  const agent = textField(source.agent, '认领人（agent）', LIMITS.authorLength)
  const wanted = typeof source.claim_id === 'string' ? source.claim_id.trim() : ''
  const dir = projectPaths(storeDir, id).claims
  const entries = await listFiles(dir)
  const released = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = path.join(dir, entry.name)
    const claim = claimOf(await readJson(file))
    if (claim === undefined) continue
    if (claim.agent !== agent) continue
    if (wanted !== '' && claim.id !== wanted) continue
    await fs.rm(file, { force: true })
    released.push(claim)
  }
  if (released.length > 0) await touchProject(storeDir, id)
  return { project: id, released, remaining: (await activeClaims(storeDir, id)).length }
}

function toolIdFrom(name) {
  const base = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .slice(0, 48)
  return base === '' ? `tool-${randomBytes(3).toString('hex')}` : base
}

export async function registerTool(storeDir, id, input) {
  await requireProject(storeDir, id)
  const source = input !== null && typeof input === 'object' ? input : {}
  const name = safeSegment(source.name, '工具名', LIMITS.nameLength)
  const summary = textField(source.summary, '一句话用途', LIMITS.summaryLength)
  const command = textField(source.command, '路径或命令', LIMITS.toolField)
  const usage = textField(source.usage, '用法示例', LIMITS.toolField, { required: false })
  const tags = Array.isArray(source.tags)
    ? source.tags
        .filter((tag) => typeof tag === 'string' && tag.trim() !== '')
        .map((tag) => clip(tag.trim(), LIMITS.tagLength))
        .slice(0, LIMITS.tags)
    : []
  const toolId = toolIdFrom(source.id ?? name)
  const file = path.join(projectPaths(storeDir, id).tools, `${toolId}.json`)
  const existing = await readJson(file)
  const at = isoNow()
  const entry = {
    id: toolId,
    project: id,
    name,
    summary,
    command,
    usage,
    tags,
    createdAt: existing !== undefined && typeof existing.createdAt === 'string' ? existing.createdAt : at,
    updatedAt: at,
  }
  await writeAtomic(file, `${JSON.stringify(entry, null, 2)}\n`)
  await touchProject(storeDir, id)
  return entry
}

async function toolsOf(storeDir, id) {
  const dir = projectPaths(storeDir, id).tools
  const entries = await listFiles(dir)
  const tools = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const tool = await readJson(path.join(dir, entry.name))
    if (tool === undefined) continue
    tools.push({
      id: typeof tool.id === 'string' ? tool.id : entry.name.replace(/\.json$/, ''),
      project: id,
      name: typeof tool.name === 'string' ? tool.name : entry.name,
      summary: typeof tool.summary === 'string' ? tool.summary : '',
      command: typeof tool.command === 'string' ? tool.command : '',
      usage: typeof tool.usage === 'string' ? tool.usage : '',
      tags: Array.isArray(tool.tags) ? tool.tags.filter((tag) => typeof tag === 'string') : [],
      createdAt: typeof tool.createdAt === 'string' ? tool.createdAt : '',
      updatedAt: typeof tool.updatedAt === 'string' ? tool.updatedAt : '',
    })
  }
  return tools
}

/** Tools of one project (`id`), or of every project when `id` is empty / `all`. */
export async function listTools(storeDir, id, query) {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  const projects = id === undefined || id === null || id === '' || id === 'all'
    ? (await listProjects(storeDir)).map((project) => project.id)
    : [validateProjectId(id)]
  const collected = []
  for (const projectId of projects) {
    for (const tool of await toolsOf(storeDir, projectId)) {
      if (needle !== '') {
        const haystack = `${tool.name} ${tool.summary} ${tool.command} ${tool.usage} ${tool.tags.join(' ')} ${tool.project}`.toLowerCase()
        if (!haystack.includes(needle)) continue
      }
      collected.push(tool)
    }
  }
  collected.sort((left, right) => {
    if (left.project !== right.project) return left.project.localeCompare(right.project)
    return left.name.localeCompare(right.name, 'zh-Hans-CN')
  })
  return collected
}

export async function listProjects(storeDir) {
  const dir = path.join(storeDir, 'projects')
  const entries = await listFiles(dir)
  const projects = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let meta
    try {
      meta = await projectMeta(storeDir, entry.name)
    } catch {
      continue
    }
    if (meta === undefined) continue
    const paths = projectPaths(storeDir, entry.name)
    const counts = {
      project: (await listDocsIn(storeDir, entry.name, 'project')).length,
      collab: (await listDocsIn(storeDir, entry.name, 'collab')).length,
      credential: (await listDocsIn(storeDir, entry.name, 'credential')).length,
      human: await messageCount(paths.boards.human),
      agent: await messageCount(paths.boards.agent),
      tools: (await listFiles(paths.tools)).filter((item) => item.isFile() && item.name.endsWith('.json')).length,
    }
    projects.push({
      ...meta,
      counts,
      claims: await activeClaims(storeDir, entry.name),
      latest: {
        human: (await latestMessage(paths.boards.human)) ?? null,
        agent: (await latestMessage(paths.boards.agent)) ?? null,
      },
    })
  }
  projects.sort((left, right) => left.title.localeCompare(right.title, 'zh-Hans-CN'))
  return projects
}

export async function state(storeDir) {
  await fs.mkdir(path.join(storeDir, 'projects'), { recursive: true })
  return {
    storeDir,
    projects: await listProjects(storeDir),
    at: isoNow(),
  }
}

export async function projectDetail(storeDir, id) {
  const project = await requireProject(storeDir, id)
  const paths = projectPaths(storeDir, id)
  return {
    project,
    docs: {
      project: await listDocsIn(storeDir, id, 'project'),
      collab: await listDocsIn(storeDir, id, 'collab'),
      credential: await listDocsIn(storeDir, id, 'credential'),
    },
    boards: {
      human: await listMessages(storeDir, id, 'human', 20),
      agent: await listMessages(storeDir, id, 'agent', 20),
    },
    tools: await toolsOf(storeDir, id),
    claims: await activeClaims(storeDir, id),
    storeDir,
    dir: paths.root,
  }
}

const PROJECT_TEMPLATE = `# 项目文档

一句话说明这个项目是什么、为谁服务、当前状态。

## 入口

- 主目录：
- 启动 / 构建命令：
- 关键文档：

## 当前状态

- 已验证：
- 未验证 / 待办：

## 边界

- 不做的事：

## 交接

- 接手先读 \`COLLAB.md\` 与 \`workspace\` 的 \`DISCIPLINE.md\`；开工 / 收尾在 Agent 留言板留痕。
`

const COLLAB_TEMPLATE = `# 合作文档

动这个项目之前先读这一页；多 Agent / 多人并行时，先认领再动手。

> 纪律：本项目属于 DSH 项目文档库，开工 / 收尾按 \`workspace\` 项目的 \`DISCIPLINE.md\` 执行
> （\`project_docs read_doc(project: "workspace", doc_name: "DISCIPLINE.md")\`）。确认凭证走「凭证区」，不外发。

## 硬性红线

- 不要碰：
- 改动前必须备份的文件：

## 占用与分工

> 动手前先 \`list_claims\`；确认没人撞车后用 \`claim_work\`（agent / scope / ttl_minutes）登记，
> 收工 \`release_claim\`。只发留言不登记认领不算数——别的 Agent 不会读你的聊天上下文。

| 时间 | 谁 | 在做什么 | 状态 |
| --- | --- | --- | --- |
|  |  |  |  |

## 约定

- 共享资源只追加不重写。
- 完成一项就在 Agent 留言板留一条记录。
`

export async function createProject(storeDir, input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const title = textField(source.title, '项目标题', LIMITS.titleLength)
  const id = source.id === undefined || source.id === null || String(source.id).trim() === ''
    ? projectIdFrom(title)
    : validateProjectId(source.id)
  const root = source.root === undefined || source.root === null ? '' : textField(source.root, '项目路径', 260, { required: false })
  const summary = source.summary === undefined || source.summary === null
    ? ''
    : textField(source.summary, '项目简介', LIMITS.summaryLength, { required: false })
  const seed = source.seed !== false
  const paths = await ensureProjectDirs(storeDir, id)
  const existing = await readJson(paths.meta)
  const at = isoNow()
  const meta = {
    id,
    title,
    root: root !== '' ? root : (typeof existing?.root === 'string' ? existing.root : ''),
    summary: summary !== '' ? summary : (typeof existing?.summary === 'string' ? existing.summary : ''),
    createdAt: typeof existing?.createdAt === 'string' ? existing.createdAt : at,
    updatedAt: at,
  }
  await writeAtomic(paths.meta, `${JSON.stringify(meta, null, 2)}\n`)
  if (existing === undefined && seed) {
    const projectDoc = path.join(paths.docs.project, 'PROJECT.md')
    const collabDoc = path.join(paths.docs.collab, 'COLLAB.md')
    if ((await readText(projectDoc)) === undefined) await writeAtomic(projectDoc, PROJECT_TEMPLATE)
    if ((await readText(collabDoc)) === undefined) await writeAtomic(collabDoc, COLLAB_TEMPLATE)
  }
  return {
    created: existing === undefined,
    project: await projectMeta(storeDir, id),
  }
}

/* --------------------------------------------------- verification evidence */

/**
 * Records of one delivery verification: the dimensions the caller proved, the
 * raw digest of the evidence, and who submitted it. Stored one file per record
 * (append-only), so a later submission never rewrites an earlier proof.
 *
 * @param {string} storeDir
 * @param {string} id
 * @param {object} input
 * @param {string} input.summary
 * @param {string[]} input.dimensions
 * @param {string} [input.evidence]
 * @param {string} [input.agent]
 * @param {string} [input.target]
 * @returns {Promise<object>}
 */
export async function recordVerification(storeDir, id, input = {}) {
  const paths = await ensureProjectDirs(storeDir, id)
  const summary = textField(input.summary, '验证结论', LIMITS.summaryLength)
  const evidence = typeof input.evidence === 'string' ? input.evidence : ''
  if (evidence.trim() === '') throw new StoreError('invalid_input', 'evidence 不能为空：把真实命令的原始输出贴进来')
  if (evidence.length > LIMITS.docBytes) {
    throw new StoreError('invalid_input', `evidence 超过 ${LIMITS.docBytes} 字符，只贴关键片段`)
  }
  const dimensions = Array.isArray(input.dimensions)
    ? input.dimensions.map((entry) => String(entry)).filter((entry) => EVIDENCE_DIMENSIONS.includes(entry))
    : []
  const at = isoNow()
  const record = {
    at,
    project: id,
    agent: textField(input.agent, '提交者', LIMITS.authorLength, { required: false }),
    target: textField(input.target, '交付目标', 260, { required: false }),
    summary,
    dimensions: [...new Set(dimensions)],
    digest: digestEvidence(evidence),
    hash: hash16(evidence),
  }
  const dir = paths.evidence
  await fs.mkdir(dir, { recursive: true })
  await writeAtomic(path.join(dir, `${stamp(at)}-${record.hash}.json`), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/** Newest verification records of one project (default 10). */
export async function listVerifications(storeDir, id, limit = 10) {
  const paths = await ensureProjectDirs(storeDir, id)
  let names
  try {
    names = await fs.readdir(paths.evidence)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const files = names.filter((name) => name.endsWith('.json')).sort().reverse()
  const records = []
  for (const name of files.slice(0, Math.max(1, Math.min(LIMITS.limitMax, limit)))) {
    const record = await readJson(path.join(paths.evidence, name))
    if (record !== undefined) records.push(record)
  }
  return records
}

/** Short, single-line digest used inside stored evidence records. */
function digestEvidence(text, max = 2000) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
  const joined = lines.join('\n')
  return joined.length <= max ? joined : `${joined.slice(0, max - 1)}…`
}
