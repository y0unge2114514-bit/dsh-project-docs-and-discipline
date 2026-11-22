/**
 * Host half of the 项目文档 (project-docs) bundle.
 *
 * Owns the on-disk store, exposes it on same-origin JSON routes for the Client
 * panel, and registers two agent tools over the same functions:
 *
 *   project_docs         read: projects, docs, boards, tool library
 *   project_docs_write   write: docs (compare-and-set), boards (append-only),
 *                        tool registrations, project creation
 *
 * @module @local/dsh-project-docs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import * as store from './store.js'
import { activeOnly, claimDecision, projectForContext } from './claims-guard.js'
import { describeDuration, requestedTimeoutMs, timeoutDecision } from './timeout-policy.js'
import {
  assistantText,
  evidenceVerdict,
  findClaims,
  missingEvidenceMessage,
  normalizeForClaim,
} from './evidence-policy.js'
import {
  classifyWrite,
  failureFingerprint,
  isNegativeFeedback,
  isReadOnlyCommand,
  linkDecision,
  linkWarning,
  readOnlyCommandReason,
} from './link-policy.js'
import {
  emptyState as emptyBreakerState,
  isWriteBlocked,
  recordFailure,
  traceModeMessage,
  traceModeReminder,
  tryClear,
} from './circuit-breaker.js'
import { diffTrees, integrityReport } from './bundle-integrity.js'
import * as kb from './kb.js'
import { renderMessageBlock, selectMessages } from './session-bus.js'
import { buildBrief, renderBrief } from './handoff-brief.js'
import { docNeed, docNeedMessage } from './doc-need.js'
import { estimateVerdict, looksLikePlan, looksWaiting } from './estimate-policy.js'
import { sleepVerdict } from './sleep-policy.js'
import { askVerdict } from './ask-policy.js'
import { WORKFLOW_PROMPT, PLAN_GATE_MESSAGE } from './workflow.js'
import {
  RUNNER_TOOLS,
  WRITE_TOOLS,
  carriesRunEvidence,
  createFailureTracker,
  isCodeFile,
  isTestFile,
  looksLikeCheck,
  planThreshold,
  stopMessage,
  weakensTest,
} from './skill-gate.js'

/**
 * Build one plugin-authored user-role notice.
 *
 * The agent loop reads `message.source.kind` on every message it admits
 * (`dsh-agent-loop` preStep/step). A context carrying only
 * `{ role, content }` therefore throws
 * `Cannot read properties of undefined (reading 'kind')` and kills the whole
 * turn — which is exactly the silent stop this helper exists to prevent.
 * Every injected context must be stamped with a producer `kind`, matching the
 * harness convention documented on `REMINDER_SOURCE` in
 * `@deepseek-ai/dsh-repeat-tool-reminder`: an unlabeled context would also
 * render as a user prompt in derived history.
 *
 * @param {string} text - notice body shown to the model.
 * @param {string} kind - producer identity, e.g. 'link-guard'.
 * @param {string} [summary] - one-line account kept on the durable log.
 * @returns {{ role: 'user', content: Array<{ type: 'text', text: string }>, source: object }}
 */
function userNotice(text, kind, summary = '') {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind,
      form: 'notice',
      ...(summary === '' ? {} : { summary: String(summary).slice(0, 120) }),
    },
  }
}

export const name = 'project-docs'

export const inject = ['webServer', 'tools']

const ROUTE_PATH = '/project-docs'
const ACTION_HEADER = 'x-project-docs'
const MAX_BODY = 1024 * 1024

const DOC_KIND_LABELS = { project: '项目文档', collab: '合作文档', credential: '凭证区' }
const BOARD_LABELS = { human: '人类留言板', agent: 'Agent 留言板' }

function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function sendJson(response, status, payload) {
  const body = `${JSON.stringify(payload)}\n`
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}

async function readBody(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new store.StoreError('invalid_input', '请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new store.StoreError('invalid_input', '请求体必须是 JSON 对象')
  }
  return parsed
}

function fail(response, error) {
  if (error instanceof store.ConflictError) {
    sendJson(response, 409, {
      ok: false,
      error: error.code,
      message: error.message,
      ...(error.details ?? {}),
    })
    return
  }
  if (error instanceof store.NotFoundError) {
    sendJson(response, 404, { ok: false, error: error.code, message: error.message })
    return
  }
  if (error instanceof store.StoreError) {
    sendJson(response, 400, { ok: false, error: error.code, message: error.message })
    return
  }
  sendJson(response, 500, { ok: false, error: 'internal', message: describe(error) })
}

function required(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new store.StoreError('invalid_input', `缺少 ${what}`)
  }
  return value.trim()
}

function messageOf(error) {
  if (error instanceof store.ConflictError) return `${error.message}（当前 hash ${error.details?.current?.hash ?? '?'}）`
  if (error instanceof kb.KbError) return `${error.message}`
  return describe(error)
}

/* ------------------------------------------------------------------ tools */

/**
 * The unified base sits beside the per-project docs, not inside them: a shared
 * port, cache quota or systemd unit has exactly one owner of record, and every
 * change to it is appended with an author and a reason. Project docs describe
 * what a project does; the unified base describes what the world it consumes
 * currently looks like and who changed it last.
 */
const KB_ACTIONS = [
  'status',
  'list',
  'get',
  'history',
  'view',
  'create_resource',
  'record_change',
  'audit',
  'gate',
  'refresh_views',
]

const KB_TOOL_DESCRIPTION =
  '统一信息库（跨项目共享事实，带版本控制与强制留痕）：所有项目共用的服务器、端口、缓存配额、磁盘、隧道、计划任务、版本基线、环境红线都只在这里有一份权威值。开工前用 view / list / get 读当前值，改完共享资源后用 record_change 更新并把原因和受影响项目写清楚（旧值会原样留档，CHANGELOG 自动生成）。每完成一个小阶段必须 audit 一次：把这一阶段确认过的条目登记为「已核对」，否则 gate 会拒绝你继续写。create_resource 只用于新建条目；已存在的条目一律用 record_change。当两个项目文档对同一个数字说法不一致时，list 出来的是库里的裁决值或「待人工裁定」标记——不要自行择一，报给人类。'

const KB_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      description: `操作：${KB_ACTIONS.join(' / ')}`,
      enum: KB_ACTIONS,
    },
    key: {
      type: 'string',
      description: '资源 key，点分层级，如 port.example-8080 / cache.example.disk',
    },
    project: {
      type: 'string',
      description: '项目 id（view 必填；list / gate / audit 可用它限定范围；create_resource 时作为 owner_project）',
    },
    query: { type: 'string', description: 'list 的模糊搜索（匹配 key / 标题 / 值 / 备注 / 标签）' },
    kind: {
      type: 'string',
      description: `资源类别：${kb.KB_KINDS.join(' / ')}`,
      enum: kb.KB_KINDS,
    },
    risk: {
      type: 'string',
      description: `风险等级：${kb.KB_RISK.join(' / ')}`,
      enum: kb.KB_RISK,
    },
    status: {
      type: 'string',
      description: `状态：${kb.KB_STATUS.join(' / ')}`,
      enum: kb.KB_STATUS,
    },
    title: { type: 'string', description: 'create_resource：一句话标题' },
    value: { type: 'string', description: '资源当前值。record_change 时写成「剩下的样子」，例如「35G 已分配，其中 B 项目 5GB」' },
    notes: { type: 'string', description: '给下一个人看的补充说明：谁依赖它、改动会伤到什么' },
    sources: {
      type: 'array',
      items: { type: 'string' },
      description: '来源：「项目 / 文档名: 原文摘录」。没来源的共享事实不可信，别建条目',
    },
    projects: {
      type: 'array',
      items: { type: 'string' },
      description: '受这次改动影响的项目 id 列表（缺席也可，但保守起见要写全）',
    },
    tags: { type: 'array', items: { type: 'string' }, description: '标签，便于跨项目检索' },
    author: { type: 'string', description: '你的 agent 标识（与认领的 agent 一致），用于留痕与门禁判定' },
    reason: { type: 'string', description: '变更原因，至少 8 字：说清为什么改、影响谁。这是强制项' },
    expect_revision: {
      type: 'number',
      description: '可选乐观锁：你基于的修订号。填了但库已是别的修订号时会被拒绝，避免覆盖别人的改动',
    },
    keys: {
      type: 'array',
      items: { type: 'string' },
      description: 'audit / gate：要核对 / 判定的条目 key 列表。省略时按 project 自动取该项目相关条目',
    },
    stage: { type: 'string', description: 'audit：这一阶段的说明，如「阶段三：接入插件工具完成」' },
    note: { type: 'string', description: 'audit：核对结论或新发现' },
    limit: { type: 'number', description: 'history：最多返回多少条修订（默认 20）' },
    projects_list: {
      type: 'array',
      items: { type: 'string' },
      description: 'refresh_views：只刷新这些项目视图；省略则全部',
    },
    project_list: {
      type: 'array',
      items: { type: 'string' },
      description: 'refresh_views：只刷新这些项目视图；省略则全部',
    },
  },
}

const READ_ACTIONS = ['list_projects', 'list_docs', 'read_doc', 'search_docs', 'list_messages', 'find_tools', 'list_claims']
const WRITE_ACTIONS = [
  'write_doc',
  'append_doc',
  'post_message',
  'register_tool',
  'create_project',
  'claim_work',
  'release_claim',
  'verify_deliverable',
  'trace_report',
  'bundle_check',
]

const READ_TOOL_DESCRIPTION =
  'Read the shared 项目文档 hub: the project list, per-project 项目文档 and 合作文档, the 人类留言板 and Agent 留言板, the cross-project 公共工具库, and the active work claims of a project. Read 项目文档 first for context, then 合作文档 for the rules to follow before changing anything, then list_claims to see whether another agent is already working on this project. Use it before touching a project another agent may be working on, to pick up the human\'s notes, or to find an existing tool instead of rewriting one. Read-only.'

const WRITE_TOOL_DESCRIPTION =
  'Write into the shared 项目文档 hub. Documents use compare-and-set: pass base_hash from project_docs read_doc when overwriting an existing document, or the write is refused with the current content. Message boards are append-only, so concurrent posts never overwrite each other; only the Agent board accepts agent posts. claim_work / release_claim take and release an expiring work claim so parallel agents see each other before they start instead of discovering the collision at push time; claim_work with claim_id updates that claim\'s progress / next_step and renews the lease, and post_message with `to` addresses a peer agent — claims are a coordination channel: agents sharing a project must publish progress and confirm the next step instead of each holding a zone and never talking again. verify_deliverable records the proof behind a completion claim: paste real `curl -i` output, a real directory listing with sizes, and a local-vs-remote md5/timestamp match, or the claim is refused. bundle_check compares the source tree against the produced archive so a pack cannot silently drop `assets/` or `kubejs/`.'

const READ_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: READ_ACTIONS,
      description: 'list_projects: all projects with counts and active claims. list_docs: every document of one project, 项目文档 first then 合作文档, plus the 凭证区. read_doc: one document\'s content and hash (also reports the project\'s active claims). search_docs: keyword search over current AND archived documents across projects — use it BEFORE re-investigating an old bug or rewriting an existing tool, because archived docs are still in the library. list_messages: newest entries of one board. find_tools: search the cross-project tool library. list_claims: active work claims of one project, each with the peer\'s scope / progress / next step — use it to coordinate with another agent working in the same project.',
    },
    project: {
      type: 'string',
      description: 'Project id from list_projects. Required by every action except list_projects and find_tools.',
    },
    kind: {
      type: 'string',
      enum: ['project', 'collab', 'credential'],
      description: 'Document category for list_docs and read_doc: project (项目文档), collab (合作文档, read before changing a shared project), or credential (凭证区: local-only connection parameters and secrets). Defaults to project.',
    },
    doc_name: {
      type: 'string',
      description: 'Document file name for read_doc, e.g. "PROJECT.md"; .md is appended when omitted.',
    },
    board: {
      type: 'string',
      enum: ['human', 'agent'],
      description: 'Message board for list_messages: human (the user\'s notes to agents) or agent (agent handoffs, claims and warnings). Defaults to agent.',
    },
    query: {
      type: 'string',
      description: 'Keyword for find_tools (case-insensitive match over tool name, summary, command, usage, tags and project) or for search_docs (case-insensitive content/name match over current and archived documents; required by search_docs).',
    },
    include_archived: {
      type: 'boolean',
      description: 'search_docs only: include archived documents (default true). Archived docs are still in the library — they hold old investigations and closed bugs.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Maximum rows for list_messages (1-100, defaults to 30) and for search_docs (1-50, defaults to 20).',
    },
  },
}

const WRITE_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: WRITE_ACTIONS,
      description: 'write_doc: create or replace one document. append_doc: append one dated entry to an existing document (use it for WORKLOG progress lines; creates the document when absent). post_message: append one board entry (use `to` to address a peer agent). register_tool: add or update one 公共工具库 entry. create_project: create (or update) a project entry with starter documents. claim_work: register an expiring claim before starting shared work, or update it (claim_id + progress + next_step) so peers see your progress. release_claim: release your claims when done. verify_deliverable: record real end-to-end proof (request / file / env) before you report 已完成 — a completion claim without it is refused. trace_report: submit a consumer-side trace to clear a tripped circuit breaker. bundle_check: compare a source tree against a produced archive and catch a pack that silently dropped whole folders.',
    },
    project: {
      type: 'string',
      description: 'Project id from project_docs list_projects. Required for every action except create_project.',
    },
    kind: {
      type: 'string',
      enum: ['project', 'collab', 'credential'],
      description: 'Document category for write_doc: project (项目文档), collab (合作文档), or credential (凭证区, only for rotating a local secret). Defaults to project.',
    },
    doc_name: {
      type: 'string',
      description: 'Document file name for write_doc, e.g. "HANDOFF.md"; .md is appended when omitted.',
    },
    content: {
      type: 'string',
      description: 'Complete new document body for write_doc, replacing the old one. Preserve sections you did not mean to remove.',
    },
    base_hash: {
      type: 'string',
      description: 'Hash returned by read_doc for the exact content being replaced. Required when the document already exists; omit only for a new document.',
    },
    text: {
      type: 'string',
      description: 'Message body for post_message. Plain text or Markdown; it is stored as one immutable entry.',
    },
    message_kind: {
      type: 'string',
      enum: ['note', 'question', 'warning', 'handoff', 'claim', 'reply'],
      description: 'Message label for post_message. Defaults to note; use claim before starting shared work and handoff when stopping.',
    },
    author: {
      type: 'string',
      description: 'Author name for post_message, so other agents know who wrote it. Defaults to "agent".',
    },
    tool_name: {
      type: 'string',
      description: 'Short tool name for register_tool, e.g. "sop-selfcheck".',
    },
    tool_summary: {
      type: 'string',
      description: 'One-sentence purpose of the tool for register_tool: what problem it solves.',
    },
    tool_command: {
      type: 'string',
      description: 'Path or command to run it for register_tool, e.g. "node scripts/sop-selfcheck.js".',
    },
    tool_usage: {
      type: 'string',
      description: 'Optional usage notes for register_tool: arguments, prerequisites, pitfalls.',
    },
    tool_tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional short search tags for register_tool, e.g. ["windows", "selfcheck"].',
    },
    title: {
      type: 'string',
      description: 'Project display title for create_project.',
    },
    id: {
      type: 'string',
      description: 'create_project only: stable project id (letters, digits, CJK, - and _) used by every later tool call and by the panel. Derived from the title when omitted, so pass it explicitly for non-ASCII titles.',
    },
    root: {
      type: 'string',
      description: 'Absolute project directory on disk for create_project, so agents know where the project lives.',
    },
    summary: {
      type: 'string',
      description: 'One-line project summary for create_project, or the delivery conclusion for verify_deliverable (e.g. "VPS 前端已发布，客户端取到新版本").',
    },
    seed: {
      type: 'boolean',
      description: 'create_project only: write starter 项目文档/合作文档 templates. Defaults to true for a new project; existing documents are never overwritten.',
    },
    agent: {
      type: 'string',
      description: 'claim_work / release_claim: who is taking (or releasing) the claim, e.g. "netdisk-pusher-a". Required for both.',
    },
    scope: {
      type: 'string',
      description: 'claim_work: what exactly you will touch, e.g. "某项目批量推送 2026-10 批次，只动 outbox/". Another agent must be able to tell from this line whether the scopes overlap.',
    },
    note: {
      type: 'string',
      description: 'claim_work: optional extra context (expected duration, files, coordination plan).',
    },
    progress: {
      type: 'string',
      description: 'claim_work (with claim_id): what you have finished so far, e.g. "已推送 120/500 个文件". Parallel agents read this line to coordinate; publish it at every milestone instead of keeping progress only in your own chat.',
    },
    next_step: {
      type: 'string',
      description: 'claim_work (with claim_id): what you will do next, e.g. "下一批从 121 开始，先跑 dry-run". Peers use it to avoid overwriting each other; update it together with progress.',
    },
    to: {
      type: 'string',
      description: 'post_message only: the peer agent this message is addressed to (e.g. "netdisk-pusher-b"). Use it for coordination messages so the target sees it is addressed to them.',
    },
    ttl_minutes: {
      type: 'integer',
      minimum: 5,
      maximum: 720,
      description: 'claim_work: how long the claim stays valid if you never release it. Defaults to 120; clamped to 5-720. Long batches should renew by updating the claim (claim_id) instead of creating a second one.',
    },
    claim_id: {
      type: 'string',
      description: 'claim_work: update this existing claim of yours (records progress / next_step, renews the lease) instead of creating a new one. release_claim: release only this claim id (from list_claims).',
    },
    summary: {
      type: 'string',
      description: 'One-line project summary for create_project, or the delivery conclusion for verify_deliverable (e.g. "VPS 前端已发布，客户端取到新版本").',
    },
    evidence: {
      type: 'string',
      description: 'verify_deliverable / trace_report: the actual raw output you observed — not a promise. Paste the real `curl -i` response lines, `ls -l` / Get-ChildItem listing with file sizes, and the local vs remote md5/timestamp comparison. For trace_report: the consumer-side 「文件:行号」 call stack plus the log/packet evidence.',
    },
    dimensions: {
      type: 'array',
      items: { type: 'string', enum: ['request', 'file', 'env'] },
      description: 'verify_deliverable: which evidence dimensions this submission proves. Defaults to all three; the submission is refused when one is missing from both this list and the evidence text.',
    },
    target: {
      type: 'string',
      description: 'verify_deliverable / bundle_check: what is being delivered, e.g. "https://host/assets/app.js" or "整合包 v1.4 zip".',
    },
    source_tree: {
      type: 'array',
      items: { type: 'string' },
      description: 'bundle_check: relative paths present in the source tree (from find / Get-ChildItem -Recurse -Name, one per entry).',
    },
    archive_tree: {
      type: 'array',
      items: { type: 'string' },
      description: 'bundle_check: relative paths present inside the produced archive (list the zip/tar contents, not the zip itself).',
    },
    required_categories: {
      type: 'array',
      items: { type: 'string' },
      description: 'bundle_check: top-level folders that MUST appear in both trees, e.g. ["config","assets","kubejs"]. A missing one fails the check even if it is empty.',
    },
    ignore_case: {
      type: 'boolean',
      description: 'bundle_check: compare paths case-insensitively (true for Windows-produced paths). Defaults to true.',
    },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    action: { type: 'string' },
    store_dir: { type: 'string' },
  },
}

function renderProjectLine(project) {
  const counts = project.counts ?? {}
  const parts = [
    `项目文档 ${counts.project ?? 0}`,
    `合作文档 ${counts.collab ?? 0}`,
    ...(counts.credential > 0 ? [`凭证 ${counts.credential}`] : []),
    `人类留言 ${counts.human ?? 0}`,
    `Agent 留言 ${counts.agent ?? 0}`,
    `工具 ${counts.tools ?? 0}`,
  ]
  const root = project.root ? ` · ${project.root}` : ''
  const claims = Array.isArray(project.claims) ? project.claims : []
  const claimLine = claims.length === 0
    ? ''
    : `\n  ⚠ 活跃认领 ${claims.length}：${claims.map((claim) => `${claim.agent} → ${claim.scope}`).join('；')}`
  return `- ${project.id} · ${project.title} — ${parts.join(' / ')}${root}${claimLine}`
}

function renderClaimLine(claim) {
  const note = claim.note ? ` · ${claim.note}` : ''
  const progress = claim.progress ? ` · 进度：${claim.progress}` : ''
  const next = claim.nextStep ? ` · 下一步：${claim.nextStep}` : ''
  return `- #${claim.id} · ${claim.agent} → ${claim.scope}${note}${progress}${next} · 至 ${claim.expiresAt}`
}

function renderClaimsWarning(claims) {
  if (!Array.isArray(claims) || claims.length === 0) return []
  return [
    `⚠ 本项目有 ${claims.length} 个活跃认领——先确认你的范围是否与别人重叠，重叠就先留言协商，不要直接动手：`,
    ...claims.map((claim) => `  ${renderClaimLine(claim).slice(2)}`),
  ]
}

function renderDocLine(doc) {
  return `- ${doc.name} · ${doc.title} · ${doc.bytes} B · 更新 ${doc.updatedAt} · hash ${doc.hash}`
}

function renderMessage(entry) {
  const text = String(entry.text ?? '').trim()
  const to = entry.to ? ` → ${entry.to}` : ''
  return `[${entry.at}] ${entry.author || '?'}${to} (${entry.kind})${entry.id ? ` #${entry.id}` : ''}\n${text}`
}

function renderReadOutput(value) {
  const lines = []
  if (value.action === 'list_projects') {
    lines.push(`项目文档库：${value.store_dir}`)
    if (value.projects.length === 0) lines.push('（还没有项目；用 project_docs_write create_project 建一个）')
    for (const project of value.projects) lines.push(renderProjectLine(project))
    return lines.join('\n')
  }
  if (value.action === 'list_docs') {
    lines.push(`项目 ${value.project} 文档（${value.store_dir}）`)
    for (const kind of ['project', 'collab', 'credential']) {
      const docs = value.docs?.[kind] ?? []
      lines.push(`${DOC_KIND_LABELS[kind]}（${docs.length}）`)
      if (docs.length === 0) lines.push('- （空）')
      for (const doc of docs) lines.push(renderDocLine(doc))
    }
    return lines.join('\n')
  }
  if (value.action === 'read_doc') {
    lines.push(`${value.project} · ${DOC_KIND_LABELS[value.doc.kind]} · ${value.doc.name}`)
    lines.push(`hash ${value.doc.hash} · ${value.doc.bytes} B · 更新 ${value.doc.updatedAt}`)
    const warning = renderClaimsWarning(value.claims)
    if (warning.length > 0) {
      lines.push('')
      lines.push(...warning)
    }
    lines.push('')
    lines.push(value.doc.content)
    return lines.join('\n')
  }
  if (value.action === 'search_docs') {
    lines.push(`文档检索「${value.query}」${value.project ? `（项目 ${value.project}）` : '（全部项目）'}：命中 ${value.total}${value.total > value.hits.length ? `，显示 ${value.hits.length}` : ''}`)
    if (value.hits.length === 0) {
      lines.push('（没有命中——说明库里没有现成结论；可以放心从头研究，研究完把结论回写进项目文档）')
    }
    for (const hit of value.hits) {
      const tag = hit.archived ? ' [已归档]' : ''
      lines.push(`- ${hit.project} · ${hit.kind}${tag} · ${hit.name}（${hit.bytes} B）`)
      if (hit.snippet) lines.push(`  …${hit.snippet}…`)
    }
    return lines.join('\n')
  }
  if (value.action === 'list_claims') {
    lines.push(`项目 ${value.project} 的活跃认领（${value.claims.length}）`)
    if (value.claims.length === 0) lines.push('（没有活跃认领——开工前用 claim_work 登记一条，别人才看得到你）')
    for (const claim of value.claims) lines.push(renderClaimLine(claim))
    if (value.claims.length > 1) {
      lines.push('')
      lines.push(
        '⚠ 多个 agent 正在同一项目上：这就是你的协作对象，不是各占一块地。' +
          '用 claim_work（claim_id + progress + next_step）更新自己的进度与下一步，' +
          '并用 post_message（to: 对方 agent）同步约定；对方进度变了就先确认，不要直接覆盖。',
      )
    }
    return lines.join('\n')
  }
  if (value.action === 'list_messages') {
    lines.push(`${value.project} · ${BOARD_LABELS[value.board]}（显示最新 ${value.entries.length} / 共 ${value.total}）`)
    if (value.entries.length === 0) lines.push('（空）')
    for (const entry of value.entries) lines.push(renderMessage(entry))
    return lines.join('\n')
  }
  if (value.action === 'find_tools') {
    lines.push(`公共工具库${value.query ? `（查询：${value.query}）` : ''}：${value.tools.length} 条`)
    if (value.tools.length === 0) lines.push('（没有匹配的工具；可用 project_docs_write register_tool 登记）')
    for (const tool of value.tools) {
      lines.push(`- [${tool.project}] ${tool.name} — ${tool.summary}`)
      lines.push(`  运行：${tool.command}`)
      if (tool.usage) lines.push(`  用法：${tool.usage.split('\n')[0]}`)
      if (tool.tags.length > 0) lines.push(`  标签：${tool.tags.join(', ')}`)
    }
    return lines.join('\n')
  }
  return JSON.stringify(value, null, 2)
}

function renderWriteOutput(value) {
  if (value.action === 'write_doc' || value.action === 'append_doc') {
    return `${value.created ? '已创建' : '已更新'} ${value.project} · ${DOC_KIND_LABELS[value.doc.kind]} · ${value.doc.name}\n新 hash ${value.doc.hash} · ${value.doc.bytes} B · 更新 ${value.doc.updatedAt}`
  }
  if (value.action === 'post_message') {
    return `已在 ${value.project} 的 ${BOARD_LABELS[value.entry.board]} 留言（${value.entry.kind}，${value.entry.author}）：\n${value.entry.text}`
  }
  if (value.action === 'register_tool') {
    return `已登记工具 ${value.tool.name}（${value.project}）：${value.tool.summary}\n运行：${value.tool.command}`
  }
  if (value.action === 'claim_work') {
    const claim = value.claim
    const progress = claim.progress ? `\n进度：${claim.progress}` : ''
    const next = claim.nextStep ? `\n下一步：${claim.nextStep}` : ''
    const updated = value.claim.updated === true ? '已更新' : '已认领'
    const peers = Array.isArray(value.peers) ? value.peers : []
    const peerBlock = peers.length === 0
      ? ''
      : '\n\n⚠ 本项目还有 ' + peers.length + ' 个 agent 也在动：' +
        peers.map((peer) => `\n- ${peer.agent} → ${peer.scope}${peer.progress ? ` · 进度：${peer.progress}` : ''}${peer.nextStep ? ` · 下一步：${peer.nextStep}` : ''}`).join('') +
        '\n这就是协作对象。请立刻：1) 用 post_message（to: 对方 agent，message_kind: "claim"）同步你负责的块与下一步；' +
        '2) 每完成一个里程碑用 claim_work（claim_id: ' + claim.id + ' + progress + next_step）更新进度；' +
        '3) 对方进度变了先看 list_claims 再动，不要互相覆盖。'
    return `${updated} ${value.project} · ${claim.agent} → ${claim.scope}${progress}${next}\n认领号 #${claim.id} · 到期 ${claim.expiresAt}（用 claim_work + claim_id 续租并更新进度；收工请 release_claim）${peerBlock}`
  }
  if (value.action === 'release_claim') {
    const released = value.released ?? []
    return `已释放 ${value.project} 的 ${released.length} 条认领（剩 ${value.remaining} 条活跃）\n${released.map((claim) => `- #${claim.id} · ${claim.agent} → ${claim.scope}`).join('\n')}`
  }
  if (value.action === 'create_project') {
    return `${value.created ? '已创建' : '已更新'}项目 ${value.project.id} · ${value.project.title}${value.project.root ? `\n路径：${value.project.root}` : ''}`
  }
  if (value.action === 'verify_deliverable') {
    const record = value.verification ?? {}
    const dims = Array.isArray(record.dimensions) ? record.dimensions.join(' / ') : ''
    return (
      `已登记交付验证 ${value.project}${record.target ? ` · ${record.target}` : ''}\n` +
      `结论：${record.summary ?? ''}\n` +
      `证据维度：${dims}（hash ${record.hash ?? '?'}）\n` +
      `本轮可以据实汇报「已完成」了——但只报这条证据覆盖的范围。`
    )
  }
  if (value.action === 'trace_report') {
    const markers = Array.isArray(value.markers) ? value.markers.join('、') : ''
    return `已提交消费端追踪（${value.project}），断路器已解锁——可以继续改代码。\n识别到的证据类型：${markers}`
  }
  if (value.action === 'bundle_check') {
    const head = value.target ? `${value.project} · ${value.target}\n` : `${value.project}\n`
    return `${head}${value.report ?? ''}`
  }
  return JSON.stringify(value, null, 2)
}

const KB_RISK_MARK = { low: '·', medium: '▲', high: '▲▲', critical: '⛔' }

function renderKbRow(row) {
  const mark = KB_RISK_MARK[row.risk] ?? '·'
  const owner = row.owner_project ? ` · 归属 ${row.owner_project}` : ''
  return `- ${mark} \`${row.key}\` r${row.revision} · ${row.title}${owner}`
}

/**
 * Renders the base for a human reading a transcript. The value line matters
 * more than the metadata: the whole point is that a stale 40G in one project's
 * notes loses to the live number here.
 */
function renderKbOutput(value) {
  const lines = []
  if (value.action === 'status') {
    const count = value.resources
    lines.push(`统一信息库：${typeof count === 'number' ? count : '?'} 条资源 · ${value.changes ?? 0} 条变更记录 · 更新于 ${value.updated_at ?? '?'}`)
    if (value.by_kind !== null && typeof value.by_kind === 'object') {
      lines.push(`类别：${Object.entries(value.by_kind).map(([kind, n]) => `${kind} ${n}`).join(' / ')}`)
    }
    if (value.by_project !== null && typeof value.by_project === 'object') {
      const top = Object.entries(value.by_project).sort((left, right) => right[1] - left[1]).slice(0, 8)
      if (top.length > 0) lines.push(`涉及项目最多的几个：${top.map(([id, n]) => `${id}(${n})`).join('、')}`)
    }
    if (Array.isArray(value.projects) && value.projects.length > 0) {
      lines.push(`共涉及 ${value.projects.length} 个项目：${value.projects.join('、')}`)
    }
    if (value.store_dir) lines.push(`存储：${value.store_dir}`)
    return lines.join('\n')
  }
  if (value.action === 'list') {
    lines.push(`统一信息库 · 命中 ${value.total} 条${value.total === 0 ? '（试试 kb action="status" 看全貌）' : ''}`)
    for (const row of value.resources) {
      lines.push(renderKbRow(row))
      if (row.value) lines.push(`  当前值：${String(row.value).replace(/\n/g, ' ').slice(0, 200)}`)
    }
    return lines.join('\n')
  }
  if (value.action === 'get' || value.action === 'history') {
    const entry = value.resource
    lines.push(`${entry.title}（\`${entry.key}\` r${entry.revision}）`)
    lines.push(`当前值：${entry.value}`)
    if (entry.notes) lines.push(`备注：${entry.notes}`)
    lines.push(`风险：${entry.risk} · 状态：${entry.status}${entry.owner_project ? ` · 归属 ${entry.owner_project}` : ''}`)
    if ((entry.projects ?? []).length > 0) lines.push(`涉及项目：${entry.projects.join('、')}`)
    for (const source of entry.sources ?? []) lines.push(`来源：${source}`)
    lines.push(`最后一次改动：${entry.updated_at} by ${entry.updated_by} —— ${entry.reason}`)
    const revisions = value.revisions ?? []
    if (revisions.length > 0) {
      lines.push('')
      lines.push(`历史（最近 ${revisions.length} 条，旧的在前）：`)
      for (const rev of revisions.slice().reverse()) {
        lines.push(`  r${rev.revision} · ${rev.at} · ${rev.author} · ${rev.reason}`)
        lines.push(`    ${String(rev.before_value ?? '—').replace(/\n/g, ' ')} → ${String(rev.after_value ?? '').replace(/\n/g, ' ')}`)
      }
    }
    return lines.join('\n')
  }
  if (value.action === 'view') {
    lines.push(`项目 ${value.project} 在统一信息库里的相关条目（${value.mine.length} 条）`)
    if (value.mine.length === 0) lines.push('（没有直接相关的条目）')
    for (const row of value.mine) {
      lines.push(renderKbRow(row))
      if (row.value) lines.push(`  当前值：${String(row.value).replace(/\n/g, ' ')}`)
      if (row.notes) lines.push(`  为什么相关：${String(row.notes).slice(0, 220)}`)
    }
    const elsewhere = value.critical_elsewhere ?? []
    if (elsewhere.length > 0) {
      lines.push('')
      lines.push(`别处的 critical 资源（${elsewhere.length} 条，你动到它们会伤到别人）：`)
      for (const row of elsewhere) lines.push(renderKbRow(row))
    }
    return lines.join('\n')
  }
  if (value.action === 'record_change' || value.action === 'create_resource') {
    const entry = value.resource
    const before = value.before ?? null
    lines.push(`已记录 ${entry.title}（\`${entry.key}\`）→ r${entry.revision}`)
    if (before !== null && before !== undefined && typeof before.value === 'string') {
      lines.push(`变更前：${before.value}`)
    }
    lines.push(`变更后：${entry.value}`)
    lines.push(`作者：${entry.updated_by} · 涉及项目：${(entry.projects ?? []).join('、') || '（未标注）'}`)
    lines.push(`原因：${entry.reason}`)
    lines.push('已写入不可变修订与 CHANGELOG.md，其他项目下次读到的就是这个值。')
    return lines.join('\n')
  }
  if (value.action === 'audit') {
    lines.push(`已登记核对（${value.at}）：${value.stage}`)
    lines.push(`覆盖 ${value.covered.length} 条：${value.covered.join('、')}`)
    if (value.note) lines.push(`结论：${value.note}`)
    lines.push(`凭据 #${value.audit_id}——门禁现在认这条记录。`)
    return lines.join('\n')
  }
  if (value.action === 'gate') {
    if (value.ok) {
      return `门禁通过：${value.author} 已覆盖 ${value.covered.length} 条条目的最新修订。`
    }
    const blocked = [`门禁未通过：${value.author} 还有 ${value.uncovered.length} 条没核对到最新修订。`]
    for (const item of value.uncovered) blocked.push(`- \`${item.key}\` r${item.revision} · ${item.title}`)
    if ((value.missing ?? []).length > 0) blocked.push(`库里不存在：${value.missing.join('、')}`)
    blocked.push('先 kb action="get" 读这些条目，再用 kb action="audit"（author + project + stage）登记核对。')
    return blocked.join('\n')
  }
  if (value.action === 'refresh_views') {
    return `已刷新项目视图 ${value.count ?? (value.written ?? []).length} 个`
  }
  return JSON.stringify(value, null, 2)
}

/* -------------------------------------------------------------------- host */

/**
 * Always-on discipline note. It is the compact, per-session half of
 * `workspace/DISCIPLINE.md`: it makes every new Agent check the project-doc
 * hub before touching a project, and write back before finishing.
 */
const DISCIPLINE_PROMPT = `## 项目文档纪律（DSH）

每个项目都有跨会话的「项目文档库」，开工前：
1. \`project_docs\` → \`list_projects\`，按当前工作目录找到项目条目；没有就 \`project_docs_write\` → \`create_project\`（id / title / root）建库，并补全 PROJECT.md。
2. 先读该项目「项目文档」（是什么 / 入口 / 现状），再读「合作文档」（红线 / 占用 / 不要回退的修复），然后才动手；需要连接参数或密钥时才读「凭证区」（kind: "credential"），读完不外发。
3. 多 Agent 并行（强制，最容易出事的一步）：动手前先 \`project_docs\` → \`list_claims\` 看这个项目有没有别人正在干；有重叠就先在 Agent 留言板留言协商，不要直接开工。确认没人撞车后，用 \`project_docs_write\` → \`claim_work\`（agent / scope / ttl_minutes）登记「谁 / 做什么 / 只动哪里」，再动手；收工 \`release_claim\`，并在 Agent 留言板写 handoff。只发留言不登记认领不算数——另一个 agent 不会去读你的聊天上下文。
3b. 认领不是分地盘（强制）：同项目有两个以上认领时，你和对方就是协作关系。claim_work 后立刻用 \`post_message\`（to: 对方 agent，message_kind: "claim"）同步你负责的块与下一步；每完成一个里程碑用 \`claim_work\`（claim_id + progress + next_step）更新进度和下一步；对方进度变了先 \`list_claims\` 看清再动，绝不覆盖对方的改动。各自占一块、老死不相往来 = 事故。

收尾：把验证命令与结果写回项目文档；可复用脚本用 register_tool 登记；带日期的进度 / 交接 / 日志属时效内容，按 workspace 的 DISCIPLINE.md 归档，不要堆进 docs；写已有文档先 read_doc 取 base_hash（CAS），不要盲覆盖。
先查历史，别重复发明轮子（强制，省 token 最快的一步）：在重新分析一个旧 bug、旧问题，或重写一个疑似已经存在的脚本 / 工具之前，先 \`project_docs\` → \`search_docs\`（关键词，含已归档文档）和 \`find_tools\` 查一遍——归档文档仍在库里，里面常常就是上次的结论。命中就先读那份文档；没命中再从头研究，研究完把结论回写进项目文档。反复重提已归档 / 已解决的问题等于白烧 token。
长任务（迁移 / 批量运维 / 数据处理）：用 append_doc 往该项目的合作文档 WORKLOG.md 追加进度，开跑 / 里程碑 / 中断 / 收工各一条；「当前进度」以最新一条为准。
跨会话协作（强制）：你的会话身份标签（如「主会话·dsh-project-docs·a3f1c9」）会自动注入系统提示，请在协作时引用自己的标签。① 收到其他会话通过留言板发来的消息时，先 read 对方项目文档确认上下文，再回复。② 在 Agent 留言板 post_message 时用 to 指定收件人会话标签，确保对方能在 supervisor 文本中看到你的消息。③ 协作提醒里显示的「对方会话」标签用于区分不同会话的认领，不要混淆同名 agent。
不要问文档里已有的东西（强制）：项目文档（PROJECT.md / COLLAB.md）里写好了网络环境（校园网内网 / 公网）、限速与端口策略、目录结构、部署方式、红线和不要回退的修复。**在问用户「网络环境是什么 / 端口是多少 / 部署在哪」之前，先读这两个文件**；开场就用记忆断言端口号、路径、IP、版本号同样会被插件拦下——那些最可能是错的。插件会在回复发出前检查：本会话没读过文档却问了已写明的背景，或开场陈述了项目事实，会把这轮打回一次并告诉你该读哪个文件。读一份即放行；如果读完发现文档确实没写，那时再问用户才有意义。
统一信息库（强制，跨项目共享资源只有一个真相源）：服务器、端口、缓存配额、磁盘、隧道、计划任务、版本基线、环境红线这些「多个项目共用的东西」不在各项目文档里各写一份，而是统一登记在 \`kb\` 工具里。① 动手前用 \`kb\` → \`view\`（本项目相关条目 + 别处的 critical 资源）或 \`list\` / \`get\` 读当前值——项目文档里写的数字可能已经过时（典型：A 把缓存设成 40G，B 划走 5GB 后只剩 35G，只看 A 的文档就会按 40G 规划）。② 改动共享资源必须用 \`kb\` → \`record_change\`（key + value + author + reason ≥ 8 字 + projects），旧值原样留档、CHANGELOG 自动生成；**没有 author/reason 的改动路径不存在**。③ 每完成一个小阶段，必须 \`kb\` → \`audit\`（author + project + stage）把这一阶段确认过的条目登记为「已核对」；没核对就 \`kb\` → \`gate\` 会被拒——这就是「更新信息是强制性的」的落地方式。④ 两个项目文档对同一个数字说法不一致时，用 \`kb\` → \`list\` 看库里的裁决值或「待人工裁定」标记，**不要自行择一闭嘴继续**，报给人类。
效率优先（强制）：不要用分钟级超时去「稳」一个操作。调用前先判断它会不会慢，按这个顺序决策：① 能不能并发（同一轮独立调用一起发、或用 subagent / workflow 并行）；② 有没有更快的等价做法（缩小范围、只取需要的片段、换镜像 / 换接口、加 --depth 1 / -q / 分页 / 条件重试）；③ 都行不通才等，且超时压到够用为止（秒级），长任务改后台 job 并继续做别的。**一个操作如果大概率要等几分钟，那它本身就是设计错误**——先改做法再重试。插件会拒绝第一次超大超时（默认 > 120 秒）并在慢调用后提醒，重发即放行。
思考收束（强制）：每次思考结束、发起工具调用之前，先在可见文本第一行写一句加粗的「接下来做什么」（格式 \`**下一步：…**\`，≤20 字，可带一句依据）；一次思考只推进一步，不要一次推演整条链路。同一轮要连发多个工具时，先写一行 \`**本批：…**\` 说明这批要达成什么（例：\`**本批：读 3 个文件确认接口**\`），再逐条调用。这两行是给人看的进度锚点，必须写。
交付要证据（强制）：说「已完成 / 已修复 / 已就绪」之前，本轮必须先调 \`project_docs_write\` → \`verify_deliverable\`（summary + evidence），证据要覆盖三个维度：客户端视角的真实请求（\`curl -i\` 的响应行、ETag、实际字节数）、物理文件存在与大小（解包后的目录清单，不要只报 zip 大小）、部署环境一致性（远端与本机的 md5 / 时间戳对照）。没证据就写「未实测」；插件会拦截没有证据的完成宣告。
别假设改动会自己生效（强制）：改了部署源（/var/www、dist、插件目录）、打包产物（zip/apk/exe/dll）、或穿过缓存层（CDN、proxy_cache、Service Worker）时，必须显式部署 / 打包 / 刷缓存，再回答「链路三问」：谁在消费它、消费者去哪里找它、中间隔了几道环节。改了本地就报「VPS 已更新」= 事故。
同一个坑不许撞两次（强制）：同一个失败连续出现 2 次（同样的报错，或用户说「还是黑的 / 根本没更新」），就停下来进入 Trace Mode：不要再写补丁，先读消费端真实源码、抓 access.log / error.log / 真实请求，写出「文件:行号 → 它做了什么 → 为什么导致当前结果」，用 \`trace_report\` 登记后才恢复写权限。
打包交付要核验完整性（强制）：打 zip / 整合包 / 分发目录之后，用 \`bundle_check\`（source_tree + archive_tree）比对源目录与包内清单——文件数一致不等于内容完整，整块目录漏掉是最常见的失败。缺项要么补进去，要么明确说明为什么不需要。
按任务规模决定计划（强制）：自己估一下要多久，按档位来决定要不要展示计划——**≤5 分钟**内部想一下直接做，不要单独告知；**5–20 分钟**先把计划展示出来（动什么文件、什么顺序、怎么验证），然后不等批准直接执行；**>20 分钟**先给完整计划并**等用户批准**再动手，计划里写明分几步、每步怎么验证、失败怎么回退。估高了要升档时重新说明计划；显式 plan mode 的规则优先。插件会在回复发出前读你写的时长：写了「约 10 分钟」却没给计划会被打回一次，写了「2 小时」却没等批准也会被打回一次。
等待不是推进（强制）：不要在命令里写长时间暂停（\`sleep 30\`、\`Start-Sleep -Seconds 20\`、\`timeout /t 15\`、\`ping -n 30\`）来「等服务好」。前台暂停超过 5 秒会被插件拒绝一次并给出替代：① **轮询代替等待**——先启动，再查一次状态，没到就去做别的；② **转后台**——命令加 \`run_in_background\`，你继续下一步；③ 确实必须等就压到 5 秒内，多次短等而不是一次长等。
提问要让用户好答（强制）：提问前先想「这能不能自己查」——文件位置、当前配置、版本、端口这类**可检查的事实自己查**，只把**需要用户决定**的事（要哪个方案、要不要删、优先级）留给用户。真要问就：一次 **1–3 个**问题、每个问题带 **2–4 个选项**、推荐项放**第一个**并在 label 里写「（推荐）」。没有选项的问题会被插件打回——用户要打字才能答，成本比你自己查还高。
完整纪律与自我完善流程：\`project_docs read_doc(project: "workspace", doc_name: "DISCIPLINE.md")\`。`

export function apply(ctx, config) {
  const options = store.normalizeOptions(config)
  const storeDir = options.storeDir
  const disciplinePrompt = !(config !== null && typeof config === 'object' && config.disciplinePrompt === false)

  function isTrustedConnection(request, response) {
    const connection = ctx.get('connection')
    if (connection === undefined || typeof connection.authorizeIndex !== 'function') return true
    return connection.authorizeIndex(request, response)
  }

  function sameOriginOnly(request) {
    const site = typeof request.headers['sec-fetch-site'] === 'string' ? request.headers['sec-fetch-site'] : ''
    if (site !== '' && site !== 'same-origin' && site !== 'none') return false
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : ''
    if (origin === '') return true
    try {
      return origin === ctx.webServer.getOrigin()
    } catch {
      return false
    }
  }

  async function route(request, response) {
    const url = new URL(request.url ?? '/', 'http://dsh.invalid')
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    const method = request.method ?? 'GET'
    const isGet = method === 'GET' || method === 'HEAD'

    if (pathname === `${ROUTE_PATH}/api/health`) {
      sendJson(response, 200, { ok: true, storeDir })
      return
    }
    if (method !== 'GET' && request.headers[ACTION_HEADER] !== '1') {
      sendJson(response, 400, { ok: false, error: 'missing_action_header' })
      return
    }
    if (method !== 'GET' && !sameOriginOnly(request)) {
      sendJson(response, 403, { ok: false, error: 'cross_origin_action_refused' })
      return
    }

    if (pathname === `${ROUTE_PATH}/api/state` && isGet) {
      sendJson(response, 200, { ok: true, ...(await store.state(storeDir)) })
      return
    }
    if (pathname === `${ROUTE_PATH}/api/project` && isGet) {
      const id = required(url.searchParams.get('id'), '项目 id')
      sendJson(response, 200, { ok: true, ...(await store.projectDetail(storeDir, id)) })
      return
    }
    if (pathname === `${ROUTE_PATH}/api/doc` && isGet) {
      const id = required(url.searchParams.get('id'), '项目 id')
      const kind = url.searchParams.get('kind') ?? 'project'
      const name = required(url.searchParams.get('name'), '文档名')
      sendJson(response, 200, { ok: true, doc: await store.readDoc(storeDir, id, kind, name) })
      return
    }
    if (pathname === `${ROUTE_PATH}/api/messages` && isGet) {
      const id = required(url.searchParams.get('id'), '项目 id')
      const board = url.searchParams.get('board') ?? 'agent'
      const limit = Number(url.searchParams.get('limit') ?? '30')
      sendJson(response, 200, { ok: true, project: id, ...(await store.listMessages(storeDir, id, board, limit)) })
      return
    }
    if (pathname === `${ROUTE_PATH}/api/tools` && isGet) {
      const project = url.searchParams.get('project') ?? 'all'
      const query = url.searchParams.get('query') ?? ''
      sendJson(response, 200, { ok: true, project, query, tools: await store.listTools(storeDir, project, query) })
      return
    }
    if (pathname === `${ROUTE_PATH}/api/doc` && method === 'POST') {
      const body = await readBody(request, MAX_BODY)
      const id = required(body.project, '项目 id')
      const kind = typeof body.kind === 'string' && body.kind !== '' ? body.kind : 'project'
      const name = required(body.doc_name ?? body.name, '文档名')
      const doc = await store.writeDoc(storeDir, id, kind, name, body.content, body.base_hash ?? body.baseHash)
      sendJson(response, 200, { ok: true, project: id, created: doc.created, doc })
      return
    }
    if (pathname === `${ROUTE_PATH}/api/message` && method === 'POST') {
      const body = await readBody(request, MAX_BODY)
      const id = required(body.project, '项目 id')
      const board = typeof body.board === 'string' && body.board !== '' ? body.board : 'agent'
      const entry = await store.postMessage(storeDir, id, board, {
        text: body.text,
        author: body.author,
        kind: body.message_kind ?? body.kind,
      })
      sendJson(response, 200, { ok: true, project: id, entry })
      return
    }
    if (pathname === `${ROUTE_PATH}/api/tool` && method === 'POST') {
      const body = await readBody(request, MAX_BODY)
      const id = required(body.project, '项目 id')
      const tool = await store.registerTool(storeDir, id, {
        id: body.tool_id,
        name: body.tool_name ?? body.name,
        summary: body.tool_summary ?? body.summary,
        command: body.tool_command ?? body.command,
        usage: body.tool_usage ?? body.usage,
        tags: body.tool_tags ?? body.tags,
      })
      sendJson(response, 200, { ok: true, project: id, tool })
      return
    }
    if (pathname === `${ROUTE_PATH}/api/project` && method === 'POST') {
      const body = await readBody(request, MAX_BODY)
      const result = await store.createProject(storeDir, {
        id: body.id,
        title: body.title,
        root: body.root,
        summary: body.summary,
        seed: body.seed,
      })
      sendJson(response, 200, { ok: true, ...result })
      return
    }
    sendJson(response, 404, { ok: false, error: 'not_found' })
  }

  async function handleRequest(request, response) {
    if (!isTrustedConnection(request, response)) return
    try {
      await route(request, response)
    } catch (error) {
      fail(response, error)
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler: handleRequest }),
    'project-docs: routes',
  )

  const readTool = {
    name: 'project_docs',
    description: READ_TOOL_DESCRIPTION,
    parameters: READ_TOOL_PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: renderReadOutput(value) }]
      },
    },
    isConcurrencySafe() {
      return true
    },
    presentCall(args) {
      const action = args !== null && typeof args === 'object' ? args.action : undefined
      return { card: 'generic', title: `读取项目文档 · ${action ?? ''}`, kind: 'read' }
    },
    async execute(args) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const action = READ_ACTIONS.includes(input.action) ? input.action : undefined
      if (action === undefined) throw new Error(`未知 action：${input.action}`)
      try {
        if (action === 'list_projects') {
          const current = await store.state(storeDir)
          return { action, store_dir: storeDir, projects: current.projects }
        }
        if (action === 'list_docs') {
          const id = required(input.project, 'project')
          const docs = {
            project: await store.listDocs(storeDir, id, 'project'),
            collab: await store.listDocs(storeDir, id, 'collab'),
            credential: await store.listDocs(storeDir, id, 'credential'),
          }
          return { action, project: id, store_dir: storeDir, docs }
        }
        if (action === 'read_doc') {
          const id = required(input.project, 'project')
          const kind = input.kind === 'collab' ? 'collab' : input.kind === 'credential' ? 'credential' : 'project'
          const doc = await store.readDoc(storeDir, id, kind, required(input.doc_name, 'doc_name'))
          const claims = await store.activeClaims(storeDir, id)
          return { action, project: id, store_dir: storeDir, doc, claims }
        }
        if (action === 'search_docs') {
          const query = required(input.query, 'query')
          const projectId = typeof input.project === 'string' ? input.project.trim() : ''
          const found = await store.searchDocs(storeDir, query, {
            project: projectId,
            limit: input.limit,
            include_archived: input.include_archived !== false,
          })
          return { action, store_dir: storeDir, ...found }
        }
        if (action === 'list_claims') {
          const id = required(input.project, 'project')
          const claims = await store.activeClaims(storeDir, id)
          return { action, project: id, store_dir: storeDir, claims }
        }
        if (action === 'list_messages') {
          const id = required(input.project, 'project')
          const board = input.board === 'human' ? 'human' : 'agent'
          const page = await store.listMessages(storeDir, id, board, input.limit)
          return { action, project: id, store_dir: storeDir, ...page }
        }
        const tools = await store.listTools(storeDir, 'all', typeof input.query === 'string' ? input.query : '')
        const limited = tools.slice(0, Number.isFinite(input.limit) ? Math.max(1, Math.min(100, Math.floor(input.limit))) : 60)
        return {
          action: 'find_tools',
          store_dir: storeDir,
          query: typeof input.query === 'string' ? input.query : '',
          tools: limited,
          matched: tools.length,
        }
      } catch (error) {
        throw new Error(`project_docs ${action} 失败：${messageOf(error)}`)
      }
    },
  }

  /* ---------------------------------------- delivery proof & breaker state */

  /**
   * Which agent is running this tool call. The tool runtime installs the calling
   * agent as the initiator, so this is the reliable way to attribute a
   * verification or a trace to a session.
   */
  function currentAgentId() {
    try {
      const agents = ctx.get('agents')
      if (agents === undefined || typeof agents.currentInitiator !== 'function') return undefined
      const agent = agents.currentInitiator()
      return agent === undefined || agent === null ? undefined : agent.id
    } catch {
      return undefined
    }
  }

  /** agentId -> [{ project, at, record }] proofs submitted in this session. */
  const proofs = new Map()
  function proofLogOf(agentId) {
    let log = proofs.get(agentId)
    if (log === undefined) {
      log = []
      proofs.set(agentId, log)
    }
    return log
  }

  /** agentId -> { state, file } circuit-breaker state, persisted per agent. */
  const breakers = new Map()
  const breakerDir = path.join(storeDir, '.breakers')
  function breakerOf(agentId) {
    let entry = breakers.get(agentId)
    if (entry === undefined) {
      const file = path.join(breakerDir, `${String(agentId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
      let state = emptyBreakerState()
      try {
        const raw = fs.readFileSync(file, 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object') state = { ...state, ...parsed }
      } catch {
        // Absent or torn: start clean rather than block on a corrupt file.
      }
      entry = { state, file }
      breakers.set(agentId, entry)
    }
    return entry
  }
  function persistBreaker(agentId) {
    const entry = breakers.get(agentId)
    if (entry === undefined) return
    try {
      fs.mkdirSync(breakerDir, { recursive: true })
      fs.writeFileSync(entry.file, `${JSON.stringify(entry.state, null, 2)}\n`, 'utf8')
    } catch {
      // A breaker that cannot be persisted still works for this process.
    }
  }

  /** Record a failure observation and return the resulting breaker state. */
  function noteFailure(agentId, text, source) {
    const fingerprint = failureFingerprint(text)
    if (fingerprint === '') return undefined
    const entry = breakerOf(agentId)
    const outcome = recordFailure(entry.state, { fingerprint, source })
    entry.state = outcome.state
    if (outcome.justTripped) persistBreaker(agentId)
    return outcome
  }

  function recordVerificationFor(dir, projectId, input) {
    return store.recordVerification(dir, projectId, input)
  }

  /**
   * Did this tool call actually fail?
   *
   * Tool results do not share one failure flag. Builtin tools set `isError`,
   * but shell tools (ops_bash / pwsh / bash) report success even on a non-zero
   * exit and bury the real status inside the JSON payload of `value`. Reading
   * only `isError` therefore made the circuit breaker silently never trip —
   * which is worse than not having one, because the safety net lies.
   */
  function toolFailed(result) {
    if (result === null || result === undefined) return false
    if (result.isError === true) return true
    const candidates = [result, result.value]
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined) continue
      let payload = candidate
      // Shell results arrive as a JSON string, sometimes double-encoded.
      for (let depth = 0; depth < 3 && typeof payload === 'string'; depth += 1) {
        try {
          payload = JSON.parse(payload)
        } catch {
          break
        }
      }
      if (payload === null || typeof payload !== 'object') continue
      if (payload.isError === true) return true
      if (payload.status === 'failed' || payload.status === 'error' || payload.status === 'timed_out') return true
      if (typeof payload.exitCode === 'number' && payload.exitCode !== 0) return true
      if (typeof payload.exit_code === 'number' && payload.exit_code !== 0) return true
    }
    return false
  }

  /** Flatten a tool result into text (error text is what the breaker reads). */
  function resultText(result) {
    if (result === null || result === undefined) return ''
    if (typeof result.content === 'string') return result.content
    if (Array.isArray(result.content)) {
      return result.content
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
        .map((block) => String(block.text ?? ''))
        .join('\n')
    }
    for (const key of ['error', 'message', 'output', 'text']) {
      const value = result[key]
      if (typeof value === 'string' && value !== '') return value
    }
    try {
      return JSON.stringify(result)
    } catch {
      return ''
    }
  }

  /** The newest assistant message in a session log. */
  function lastAssistantMessage(messages) {
    if (!Array.isArray(messages)) return undefined
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message !== null && typeof message === 'object' && message.role === 'assistant') return message
    }
    return undefined
  }

  /**
   * A proof counts when it was recorded after the last user message, so an old
   * verification cannot license a brand-new "已完成" claim.
   *
   * `recordVerification` stores `at` as an ISO string while `lastUserAt` answers
   * in epoch milliseconds; comparing them raw parses the ISO string to NaN, so
   * `entry.at < cutoff` would silently be false and every stale proof would pass
   * the gate. Both sides are normalized here.
   */
  function toEpochMs(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      return Number.isNaN(parsed) ? undefined : parsed
    }
    return undefined
  }

  function latestProofFor(agentId, projectId, assistantMessage) {
    const log = proofs.get(agentId) ?? []
    if (log.length === 0) return undefined
    const cutoff = lastUserAt(agentId, assistantMessage)
    for (let index = log.length - 1; index >= 0; index -= 1) {
      const entry = log[index]
      if (projectId !== undefined && entry.project !== projectId) continue
      if (cutoff !== undefined) {
        const at = toEpochMs(entry.at)
        if (at !== undefined && at < cutoff) continue
      }
      return entry
    }
    return undefined
  }

  /** Timestamp of the newest user message in the session, when available. */
  function lastUserAt(agentId) {
    const session = sessionOf(agentId)
    if (session === undefined || typeof session.ownEvents !== 'function') return undefined
    try {
      let latest
      for (const event of session.ownEvents()) {
        if (event.type === 'user/message' || event.type === 'message/user') latest = event.at ?? event.time
      }
      return typeof latest === 'number' ? latest : (typeof latest === 'string' ? Date.parse(latest) : undefined)
    } catch {
      return undefined
    }
  }

  const writeTool = {
    name: 'project_docs_write',
    description: WRITE_TOOL_DESCRIPTION,
    parameters: WRITE_TOOL_PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: renderWriteOutput(value) }]
      },
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      const action = args !== null && typeof args === 'object' ? args.action : undefined
      return { card: 'generic', title: `写入项目文档 · ${action ?? ''}`, kind: 'write' }
    },
    async execute(args) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const action = WRITE_ACTIONS.includes(input.action) ? input.action : undefined
      if (action === undefined) throw new Error(`未知 action：${input.action}`)
      try {
        if (action === 'write_doc') {
          const id = required(input.project, 'project')
          const kind = input.kind === 'collab' ? 'collab' : input.kind === 'credential' ? 'credential' : 'project'
          const doc = await store.writeDoc(
            storeDir,
            id,
            kind,
            required(input.doc_name, 'doc_name'),
            typeof input.content === 'string' ? input.content : '',
            input.base_hash,
          )
          return { action, project: id, store_dir: storeDir, created: doc.created, doc }
        }
        if (action === 'append_doc') {
          const id = required(input.project, 'project')
          const kind = input.kind === 'collab' ? 'collab' : input.kind === 'credential' ? 'credential' : 'project'
          const name = required(input.doc_name, 'doc_name')
          const entry = typeof input.content === 'string' ? input.content : ''
          if (entry.trim() === '') throw new store.StoreError('invalid_input', 'content 不能为空')
          const existing = await store.readDoc(storeDir, id, kind, name).catch(() => undefined)
          const next = existing === undefined ? `${entry}\n` : `${existing.content.replace(/\s*$/, '')}\n\n${entry}\n`
          const doc = await store.writeDoc(storeDir, id, kind, name, next, existing?.hash)
          return { action, project: id, store_dir: storeDir, created: doc.created, doc }
        }
        if (action === 'post_message') {
          const id = required(input.project, 'project')
          const entry = await store.postMessage(storeDir, id, 'agent', {
            text: input.text,
            author: input.author,
            kind: input.message_kind,
            to: input.to,
          })
          return { action, project: id, store_dir: storeDir, entry }
        }
        if (action === 'claim_work') {
          const id = required(input.project, 'project')
          const claim = await store.claimWork(storeDir, id, {
            agent: input.agent,
            scope: input.scope,
            note: input.note,
            progress: input.progress,
            next_step: input.next_step,
            ttl_minutes: input.ttl_minutes,
            session_id: input.session_id,
            claim_id: input.claim_id,
          })
          const others = (await store.activeClaims(storeDir, id)).filter((peer) => peer.agent !== claim.agent)
          return { action, project: id, store_dir: storeDir, claim, peers: others }
        }
        if (action === 'release_claim') {
          const id = required(input.project, 'project')
          const result = await store.releaseClaim(storeDir, id, {
            agent: input.agent,
            claim_id: input.claim_id,
          })
          return { action, store_dir: storeDir, ...result }
        }
        if (action === 'verify_deliverable') {
          // `required` is the module-level validator, so the local list needs another name.
          const id = required(input.project, 'project')
          const evidence = required(input.evidence, 'evidence')
          const wanted = Array.isArray(input.dimensions) && input.dimensions.length > 0
            ? input.dimensions
            : ['request', 'file', 'env']
          const verdict = evidenceVerdict({ text: evidence, provided: {}, required: wanted })
          if (!verdict.satisfied) {
            throw new store.StoreError('invalid_input', missingEvidenceMessage(verdict.missing, { projectId: id, claimKind: '已交付' }))
          }
          const record = await recordVerificationFor(storeDir, id, {
            summary: input.summary,
            evidence,
            dimensions: verdict.dimensions,
            agent: input.agent,
            target: input.target,
          })
          const agentId = currentAgentId()
          if (agentId !== undefined) proofLogOf(agentId).push({ project: id, at: Date.now(), record })
          return { action, project: id, store_dir: storeDir, verification: record }
        }
        if (action === 'trace_report') {
          const id = required(input.project, 'project')
          const evidence = required(input.evidence, 'evidence')
          const agentId = currentAgentId()
          if (agentId === undefined) throw new store.StoreError('invalid_input', 'trace_report 需要当前 Agent 上下文')
          const result = tryClear(breakerOf(agentId).state, evidence)
          if (!result.cleared) {
            throw new store.StoreError(
              'invalid_input',
              'trace_report 未通过：证据里没有「文件:行号」级别的消费端逻辑（也没有真实日志 / 抓包 / 调用栈）。' +
              '请打开真正读取这个文件的那段源码，写出「文件:行号 → 它做了什么 → 为什么导致当前结果」。',
            )
          }
          breakerOf(agentId).state = result.state
          persistBreaker(agentId)
          return { action, project: id, store_dir: storeDir, cleared: true, markers: result.markers }
        }
        if (action === 'bundle_check') {
          const id = required(input.project, 'project')
          const sourceTree = Array.isArray(input.source_tree) ? input.source_tree.map(String) : []
          const archiveTree = Array.isArray(input.archive_tree) ? input.archive_tree.map(String) : []
          if (sourceTree.length === 0) throw new store.StoreError('invalid_input', 'source_tree 不能为空（先列出源目录的条目）')
          if (archiveTree.length === 0) throw new store.StoreError('invalid_input', 'archive_tree 不能为空（列出压缩包内的条目，不是 zip 文件本身）')
          const requiredCategories = Array.isArray(input.required_categories) ? input.required_categories.map(String) : []
          const result = diffTrees({
            source: sourceTree,
            archive: archiveTree,
            ignoreCase: input.ignore_case !== false,
            requiredCategories,
          })
          return {
            action,
            project: id,
            store_dir: storeDir,
            target: typeof input.target === 'string' ? input.target : '',
            integrity: result,
            report: integrityReport(result, { source: '源目录', archive: '压缩包' }),
          }
        }
        if (action === 'register_tool') {
          const id = required(input.project, 'project')
          const tool = await store.registerTool(storeDir, id, {
            name: input.tool_name,
            summary: input.tool_summary,
            command: input.tool_command,
            usage: input.tool_usage,
            tags: input.tool_tags,
          })
          return { action, project: id, store_dir: storeDir, tool }
        }
        const result = await store.createProject(storeDir, {
          id: input.id,
          title: input.title,
          root: input.root,
          summary: input.summary,
          seed: input.seed,
        })
        return { action, store_dir: storeDir, ...result }
      } catch (error) {
        throw new Error(`project_docs_write ${action} 失败：${messageOf(error)}`)
      }
    },
  }

  const kbTool = {
    name: 'kb',
    description: KB_TOOL_DESCRIPTION,
    parameters: KB_TOOL_PARAMETERS,
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: renderKbOutput(value) }]
      },
    },
    isConcurrencySafe() {
      return true
    },
    presentCall(args) {
      const action = args !== null && typeof args === 'object' ? args.action : undefined
      return { card: 'generic', title: `统一信息库 · ${action ?? ''}`, kind: 'read' }
    },
    async execute(args) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const action = KB_ACTIONS.includes(input.action) ? input.action : undefined
      if (action === undefined) throw new Error(`未知 action：${input.action}（可用：${KB_ACTIONS.join(' / ')}）`)
      try {
        if (action === 'status') {
          return { action, ...(await kb.kbStatus(storeDir)) }
        }
        if (action === 'list') {
          const listed = await kb.listResources(storeDir, {
            query: input.query,
            project: input.project,
            kind: input.kind,
            risk: input.risk,
            status: input.status,
          })
          return { action, ...listed }
        }
        if (action === 'get') {
          return { action, ...(await kb.getResource(storeDir, { key: required(input.key, 'key') })) }
        }
        if (action === 'history') {
          return {
            action,
            ...(await kb.getResource(storeDir, {
              key: required(input.key, 'key'),
              history_limit: input.limit,
            })),
          }
        }
        if (action === 'view') {
          return { action, ...(await kb.projectView(storeDir, required(input.project, 'project'))) }
        }
        if (action === 'create_resource') {
          const result = await kb.createResource(storeDir, {
            key: required(input.key, 'key'),
            title: required(input.title, 'title'),
            kind: input.kind,
            value: required(input.value, 'value'),
            risk: input.risk,
            status: input.status,
            owner_project: input.project,
            reason: input.reason,
            notes: input.notes,
            sources: input.sources,
            projects: input.projects,
            tags: input.tags,
            author: required(input.author, 'author'),
          })
          await kb.refreshAllViews(storeDir)
          return { action, ...result }
        }
        if (action === 'record_change') {
          const result = await kb.recordChange(storeDir, {
            key: required(input.key, 'key'),
            author: required(input.author, 'author'),
            reason: required(input.reason, 'reason'),
            value: input.value,
            notes: input.notes,
            sources: input.sources,
            status: input.status,
            risk: input.risk,
            projects: input.projects,
            expect_revision: input.expect_revision,
          })
          await kb.refreshAllViews(storeDir)
          return { action, ...result }
        }
        if (action === 'audit') {
          const author = required(input.author, 'author')
          const target = typeof input.project === 'string' ? input.project.trim() : ''
          const result = await kb.auditSlice(storeDir, {
            author,
            project: target,
            keys: input.keys,
            stage: required(input.stage, 'stage'),
            note: input.note,
          })
          // Refresh the audited project's consumer view so the doc on disk shows
          // what the agent actually read against.
          if (target !== '') await kb.writeView(storeDir, target)
          return { action, ...result }
        }
        if (action === 'gate') {
          return {
            action,
            ...(await kb.gateStatus(storeDir, {
              author: required(input.author, 'author'),
              project: input.project,
              keys: input.keys,
            })),
          }
        }
        if (action === 'refresh_views') {
          const wanted = Array.isArray(input.project_list) ? input.project_list : []
          const projects = wanted.length > 0
            ? wanted
            : (await store.state(storeDir)).projects.map((project) => project.id)
          const written = await kb.refreshAllViews(storeDir, projects)
          return { action, written, count: written.length }
        }
        return { action }
      } catch (error) {
        throw new Error(`kb ${action} 失败：${messageOf(error)}`)
      }
    },
  }

  ctx.effect(() => ctx.tools.register(readTool), 'project-docs: read tool')
  ctx.effect(() => ctx.tools.register(writeTool), 'project-docs: write tool')
  ctx.effect(() => ctx.tools.register(kbTool), 'project-docs: unified kb tool')

  if (disciplinePrompt) {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
      ctx.effect(
        () => systemPrompt.section({ name: 'project-docs-discipline', order: 900, text: DISCIPLINE_PROMPT }),
        'project-docs: discipline prompt',
      )
    }
  }

  /* ------------------------------- development workflow (superpowers) */
  // Superpowers' bootstrap is a session-scoped mandate to follow a composable
  // workflow. DSH has no SessionStart hook, so the equivalent persistent
  // channel is a system-prompt section: the harness reassembles it before
  // every model request, which also makes it immune to compaction.
  const workflowPrompt = !(config !== null && typeof config === 'object' && config.workflowPrompt === false)
  if (workflowPrompt) {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
      ctx.effect(
        () => systemPrompt.section({ name: 'project-docs-workflow', order: 800, text: WORKFLOW_PROMPT }),
        'project-docs: workflow prompt',
      )
    }
  }

  /* ------------------------------------------------- discipline guard */
  /**
   * Guard failures that have already been reported, so a broken gate logs once
   * per site instead of on every tool call.
   */
  const reportedGuardFailures = new Set()
  /**
   * Register a gate that fails open.
   *
   * A guard runs in front of every tool execution: when one throws, the throw
   * propagates as the tool's own failure and the whole tool channel dies — you
   * lose the ability to even read the file you would need to fix it. A gate
   * exists to veto *one* call, so "could not form an opinion" must mean "allow",
   * never "deny". Losing one check is a downgrade; losing every tool is a dead
   * session.
   *
   * @param {string} label identifies the site in the warning log
   * @param {(execution: unknown) => unknown} guard
   */
  const safeGuard = (label, guard) => ctx.tools.guard((execution) => {
    try {
      return guard(execution)
    } catch (error) {
      if (!reportedGuardFailures.has(label)) {
        reportedGuardFailures.add(label)
        const detail = error instanceof Error ? error.message : String(error)
        console.warn(`project-docs: 门禁「${label}」抛出异常，已放行本次调用：${detail}`)
      }
      return undefined
    }
  })
  const disciplineGuard = !(config !== null && typeof config === 'object' && config.disciplineGuard === false)
  if (disciplineGuard) {
    // 'early' intercepts the first tool call of a fresh agent, i.e. before any
    // exploration or file mutation; 'write' keeps the older behaviour of
    // intercepting only write/edit.
    const guardMode = config !== null && typeof config === 'object' && config.disciplineGuardMode === 'write' ? 'write' : 'early'
    const GUARDED_TOOLS = ['write', 'edit']
    const stateFile = path.join(storeDir, '.discipline-guard.json')
    const MAX_TRACKED = 500
    /** agentId -> { consulted, warned } — at most one interception per agent. */
    const agentState = new Map()

    const persist = () => {
      try {
        const out = {}
        for (const [id, state] of [...agentState.entries()].slice(-MAX_TRACKED)) {
          out[id] = { consulted: state.consulted === true, warned: state.warned === true }
        }
        const tmp = `${stateFile}.tmp`
        const handle = fs.openSync(tmp, 'w')
        fs.writeFileSync(handle, JSON.stringify(out, null, 2))
        fs.fsyncSync(handle)
        fs.closeSync(handle)
        fs.renameSync(tmp, stateFile)
      } catch {
        // Best effort only: an unwritable store must never break tool calls.
      }
    }

    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (raw !== null && typeof raw === 'object') {
        for (const [id, value] of Object.entries(raw)) {
          if (value === null || typeof value !== 'object') continue
          agentState.set(id, { consulted: value.consulted === true, warned: value.warned === true })
        }
      }
    } catch {
      // No persisted state yet.
    }

    const sessions = ctx.get('sessions')
    const sessionOf = (agentId) => {
      if (sessions === undefined || typeof sessions.get !== 'function') return undefined
      try {
        return sessions.get(agentId)
      } catch {
        return undefined
      }
    }
    // Subagents inherit direction from their parent; warning each of them would
    // turn one fan-out into a burst of pointless document lookups.
    const isSubagent = (agentId) => {
      const session = sessionOf(agentId)
      return session !== undefined && session.header !== undefined && session.header.origin === 'subagent'
    }
    // An HMR reload loses the in-memory map, so also believe the session log:
    // an agent that already used project_docs earlier in its life is consulted.
    const consultedInHistory = (agentId) => {
      const session = sessionOf(agentId)
      if (session === undefined || typeof session.ownEvents !== 'function') return false
      try {
        for (const event of session.ownEvents()) {
          if (event.type !== 'tool/call') continue
          const name = event.data?.name
          if (typeof name === 'string' && name.startsWith('project_docs')) return true
        }
      } catch {
        return false
      }
      return false
    }
    const stateOf = (agentId) => {
      let state = agentState.get(agentId)
      if (state === undefined) {
        state = { consulted: false, warned: false }
        agentState.set(agentId, state)
      }
      return state
    }

    // Sessions that were already live when this plugin registered keep their
    // current turn uninterrupted instead of getting a surprise interception.
    const liveAgents = ctx.get('agents')
    if (liveAgents !== undefined && typeof liveAgents.list === 'function') {
      try {
        for (const agent of liveAgents.list()) {
          if (!agentState.has(agent.id)) agentState.set(agent.id, { consulted: true, warned: true })
        }
      } catch {
        // A list failure only costs the exemption, never correctness.
      }
    }

    const GUARD_MESSAGE =
      '项目文档纪律：本会话第一次调用工具前，先调用 project_docs → list_projects 找到当前项目（没有就 create_project 建库），' +
      '再读该项目的「项目文档」和「合作文档」，并用 list_claims 看有没有别的 agent 正在做同一件事；' +
      '要动手就先用 project_docs_write → claim_work 登记「谁 / 做什么 / 只动哪里」。本次拦截只发生一次，完成上述一步后继续即可。'

    ctx.effect(
      () =>
        ctx.on('agent/created', (payload) => {
          if (payload === null || payload === undefined || payload.agent === undefined) return
          if (!agentState.has(payload.agent.id)) agentState.set(payload.agent.id, { consulted: false, warned: false })
        }),
      'project-docs: discipline guard agent init',
    )
    ctx.effect(
      () =>
        ctx.on('agent/disposed', (payload) => {
          if (payload === null || payload === undefined || payload.agent === undefined) return
          const state = agentState.get(payload.agent.id)
          // Keep consulted agents recorded so a reload never nags them twice.
          if (state !== undefined && state.consulted !== true) agentState.delete(payload.agent.id)
          persist()
        }),
      'project-docs: discipline guard agent cleanup',
    )
    ctx.effect(
      () =>
        ctx.on('tools/result', (execution, result) => {
          if (execution === null || execution === undefined) return
          if (execution.agent === undefined) return
          if (typeof execution.name !== 'string' || !execution.name.startsWith('project_docs')) return
          if (result !== null && result !== undefined && result.isError === true) return
          const state = stateOf(execution.agent.id)
          if (state.consulted !== true) {
            state.consulted = true
            persist()
          }
        }),
      'project-docs: discipline guard observation',
    )
    ctx.effect(
      () =>
        safeGuard('discipline guard', (execution) => {
          const agent = execution.agent
          if (agent === undefined) return undefined
          const name = typeof execution.name === 'string' ? execution.name : ''
          if (name.startsWith('project_docs')) return undefined
          if (guardMode === 'write' && !GUARDED_TOOLS.includes(name)) return undefined
          const state = stateOf(agent.id)
          if (state.consulted === true || state.warned === true) return undefined
          if (isSubagent(agent.id)) return undefined
          if (state.checkedHistory !== true) {
            state.checkedHistory = true
            if (consultedInHistory(agent.id)) {
              state.consulted = true
              persist()
              return undefined
            }
          }
          state.warned = true
          persist()
          return GUARD_MESSAGE
        }),
      'project-docs: discipline guard',
    )
  }

  /* ------------------------------- shared project snapshot & tool sets */
  const MUTATING_TOOLS = ['write', 'edit', 'multi_edit', 'apply_patch', 'ops_bash', 'pwsh', 'bash']
  /** Members of MUTATING_TOOLS that take a `command` argument and may be read-only. */
  const SHELL_TOOLS = ['ops_bash', 'pwsh', 'bash']
  /**
   * Pull the shell command out of an execution without assuming one tool shape.
   * Returns '' when the call carries no recognisable command.
   */
  const shellCommandOf = (execution) => {
    const args =
      execution !== null && typeof execution === 'object' ? execution.arguments : undefined
    if (args === null || typeof args !== 'object') return ''
    for (const key of ['command', 'cmd', 'script']) {
      const value = args[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    return ''
  }
  const sessionsSvc = ctx.get('sessions')
  const sessionOf = (agentId) => {
    if (sessionsSvc === undefined || typeof sessionsSvc.get !== 'function') return undefined
    try {
      return sessionsSvc.get(agentId)
    } catch {
      return undefined
    }
  }
  const isSubagent = (agentId) => {
    const session = sessionOf(agentId)
    return session !== undefined && session.header !== undefined && session.header.origin === 'subagent'
  }
  /** Stable session label: origin + cwd basename + 6-char hash of (cwd + origin). */
  const sessionLabel = (agentId) => {
    const session = sessionOf(agentId)
    if (session === undefined || session.header === undefined) return ''
    const origin = session.header.origin === 'subagent' ? 'subagent' : '主会话'
    const cwd = typeof session.header.cwd === 'string' ? session.header.cwd : ''
    const basename = cwd !== '' ? path.basename(cwd) : 'root'
    const digest = createHash('sha256').update(cwd + '\0' + origin).digest('hex').slice(0, 6)
    return `${origin}·${basename}·${digest}`
  }
  /** Cached [{ id, root, claims }] snapshot; refreshed in the background. */
  let projectSnapshot = []
  const refreshProjects = async () => {
    try {
      const snapshot = await store.state(storeDir)
      projectSnapshot = snapshot.projects.map((project) => ({
        id: project.id,
        root: typeof project.root === 'string' ? project.root : '',
        claims: Array.isArray(project.claims) ? project.claims : [],
      }))
    } catch {
      // Keep the last good snapshot; a stale cache only weakens the guards.
    }
  }
  ctx.effect(() => {
    void refreshProjects()
    const timer = setInterval(() => {
      void refreshProjects()
    }, 20_000)
    return () => clearInterval(timer)
  }, 'project-docs: project snapshot')

  /**
   * Replay the session log to recover the claims this agent still holds, with
   * the agent names it registered under. Used when the in-memory claim registry
   * is empty (fresh plugin, reload) — the supervisor's collaboration reminder
   * must not silently disappear after a reload.
   */
  const claimedAgentsFromHistory = (agentId) => {
    const out = new Map()
    const session = sessionOf(agentId)
    if (session === undefined || typeof session.ownEvents !== 'function') return out
    try {
      for (const event of session.ownEvents()) {
        if (event.type !== 'tool/call') continue
        const data = event.data
        if (data === undefined || data.name !== 'project_docs_write') continue
        const args = data.arguments !== null && typeof data.arguments === 'object' ? data.arguments : undefined
        if (args === undefined) continue
        const action = typeof args.action === 'string' ? args.action : ''
        const projectId = typeof args.project === 'string' ? args.project : ''
        if (projectId === '') continue
        if (action === 'claim_work') out.set(projectId, typeof args.agent === 'string' ? args.agent : '')
        else if (action === 'release_claim') out.delete(projectId)
      }
    } catch {
      // A damaged session log only degrades the reminder, never the tools.
    }
    return out
  }

  /* ------------------------------------------------------- plan gate */
  // Superpowers treats `writing-plans` as mandatory: every task carries exact
  // file paths and verification steps. This gate is the one-time nudge that
  // turns that mandate into something the agent cannot skip — before the first
  // mutating tool call of an agent, unless a plan has already been produced for
  // this session.
  //
  // The gate is registered *after* the discipline guard, so on a session whose
  // very first mutation is a write/edit the discipline reminder (which wins the
  // single rejection `tools.checkGuards` can return) takes that call; this
  // reminder then lands on the agent's next mutating call. Both are one-time.
  const planGate = !(config !== null && typeof config === 'object' && config.planGate === false)
  if (planGate) {
    const stateFile = path.join(storeDir, '.plan-gate.json')
    const MAX_TRACKED = 500
    /** agentId -> { planned, warned, checkedHistory } — at most one reminder per agent. */
    const agentState = new Map()

    const persist = () => {
      try {
        const out = {}
        for (const [id, state] of [...agentState.entries()].slice(-MAX_TRACKED)) {
          out[id] = {
            planned: state.planned === true,
            warned: state.warned === true,
            checkedHistory: state.checkedHistory === true,
          }
        }
        const tmp = `${stateFile}.tmp`
        const handle = fs.openSync(tmp, 'w')
        fs.writeFileSync(handle, JSON.stringify(out, null, 2))
        fs.fsyncSync(handle)
        fs.closeSync(handle)
        fs.renameSync(tmp, stateFile)
      } catch {
        // Best effort only: an unwritable store must never break tool calls.
      }
    }

    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (raw !== null && typeof raw === 'object') {
        for (const [id, value] of Object.entries(raw)) {
          if (value === null || typeof value !== 'object') continue
          agentState.set(id, {
            planned: value.planned === true,
            warned: value.warned === true,
            checkedHistory: value.checkedHistory === true,
          })
        }
      }
    } catch {
      // No persisted state yet.
    }

    const stateOf = (agentId) => {
      let state = agentState.get(agentId)
      if (state === undefined) {
        state = { planned: false, warned: false, checkedHistory: false }
        agentState.set(agentId, state)
      }
      return state
    }

    // An HMR reload loses the in-memory map, so also believe the session log:
    // an agent that already wrote a plan doc earlier in its life is planned.
    const plannedInHistory = (agentId) => {
      const session = sessionOf(agentId)
      if (session === undefined || typeof session.ownEvents !== 'function') return false
      try {
        for (const event of session.ownEvents()) {
          if (event.type !== 'tool/call') continue
          const data = event.data
          if (data === undefined || data.name !== 'project_docs_write') continue
          const args = data.arguments !== null && typeof data.arguments === 'object' ? data.arguments : undefined
          if (args === undefined) continue
          const action = typeof args.action === 'string' ? args.action : ''
          if (action !== 'write_doc' && action !== 'append_doc') continue
          if (typeof args.project === 'string' && args.project !== '') return true
        }
      } catch {
        return false
      }
      return false
    }

    // Sessions already live when the plugin registered keep their current turn
    // uninterrupted instead of getting a surprise interception.
    const liveAgents = ctx.get('agents')
    if (liveAgents !== undefined && typeof liveAgents.list === 'function') {
      try {
        for (const agent of liveAgents.list()) {
          if (!agentState.has(agent.id)) agentState.set(agent.id, { planned: true, warned: true, checkedHistory: true })
        }
      } catch {
        // A list failure only costs the exemption, never correctness.
      }
    }

    ctx.effect(
      () =>
        ctx.on('agent/created', (payload) => {
          if (payload === null || payload === undefined || payload.agent === undefined) return
          if (!agentState.has(payload.agent.id)) {
            agentState.set(payload.agent.id, { planned: false, warned: false, checkedHistory: false })
          }
        }),
      'project-docs: plan gate agent init',
    )
    ctx.effect(
      () =>
        ctx.on('agent/disposed', (payload) => {
          if (payload === null || payload === undefined || payload.agent === undefined) return
          const state = agentState.get(payload.agent.id)
          // Keep planned agents recorded so a reload never nags them twice.
          if (state !== undefined && state.planned !== true) agentState.delete(payload.agent.id)
          persist()
        }),
      'project-docs: plan gate agent cleanup',
    )
    ctx.effect(
      () =>
        ctx.on('tools/result', (execution, result) => {
          if (execution === null || execution === undefined) return
          if (execution.agent === undefined) return
          if (typeof execution.name !== 'string' || execution.name !== 'project_docs_write') return
          if (result !== null && result !== undefined && result.isError === true) return
          const args = execution.arguments
          if (args === null || typeof args !== 'object') return
          const action = typeof args.action === 'string' ? args.action : ''
          if (action !== 'write_doc' && action !== 'append_doc') return
          const state = stateOf(execution.agent.id)
          if (state.planned !== true) {
            state.planned = true
            persist()
          }
        }),
      'project-docs: plan gate observation',
    )
    ctx.effect(
      () =>
        safeGuard('plan gate', (execution) => {
          const agent = execution.agent
          if (agent === undefined) return undefined
          const name = typeof execution.name === 'string' ? execution.name : ''
          if (!MUTATING_TOOLS.includes(name)) return undefined
          const state = stateOf(agent.id)
          if (state.planned === true || state.warned === true) return undefined
          if (isSubagent(agent.id)) return undefined
          if (state.checkedHistory !== true) {
            state.checkedHistory = true
            if (plannedInHistory(agent.id)) {
              state.planned = true
              persist()
              return undefined
            }
          }
          state.warned = true
          persist()
          return PLAN_GATE_MESSAGE
        }),
      'project-docs: plan gate',
    )
  }

  /* ------------------------------------------------------- claim guard */
  // Second line of defence for parallel agents: once a project has an active
  // claim, a session that holds none may not run mutating tools there. This is
  // the "two netdisk agents found each other at push time" incident turned into
  // a hard stop: the blocker names the other agent and its scope.
  //
  // The same registry feeds the supervisor's collaboration reminder, so it lives
  // outside the claimGuard block.
  /** agentId -> Map(projectId -> { expiresAt, agent, sessionLabel }) */
  const heldClaims = new Map()
  /** Live session registry: agentId -> { label, cwd, origin, createdAt, lastSeen } */
  const sessionRegistry = new Map()
  /** `${sessionId}\0${projectId}` prompted once */
  const prompted = new Set()
  const claimGuard = !(config !== null && typeof config === 'object' && config.claimGuard === false)
  if (claimGuard) {
    const CLAIM_TTL_FALLBACK_MS = 120 * 60_000

    const keyFor = (agentId, projectId) => `${agentId}\u0000${projectId}`
    const heldExpiry = (agentId, projectId) => {
      const mine = heldClaims.get(agentId)
      if (mine === undefined) return undefined
      const entry = mine.get(projectId)
      if (entry === undefined) return undefined
      if (entry.expiresAt > Date.now()) return entry.expiresAt
      mine.delete(projectId)
      return undefined
    }
    const heldAgent = (agentId, projectId) => {
      const mine = heldClaims.get(agentId)
      const entry = mine?.get(projectId)
      if (entry === undefined || entry.expiresAt <= Date.now()) return undefined
      return typeof entry.agent === 'string' && entry.agent !== '' ? entry.agent : undefined
    }
    // Replay the session log in order: a later release_claim invalidates an
    // earlier claim_work, so "claimed at some point" is not enough.
    const claimedInHistory = (agentId, projectId) => {
      const session = sessionOf(agentId)
      if (session === undefined || typeof session.ownEvents !== 'function') return false
      let claimed = false
      try {
        for (const event of session.ownEvents()) {
          if (event.type !== 'tool/call') continue
          const data = event.data
          if (data === undefined || data.name !== 'project_docs_write') continue
          const text = JSON.stringify(data)
          if (!text.includes(projectId)) continue
          const args = data.arguments !== null && typeof data.arguments === 'object' ? data.arguments : undefined
          const action = typeof args?.action === 'string' ? args.action : ''
          if (action === 'claim_work') claimed = true
          else if (action === 'release_claim') claimed = false
        }
      } catch {
        return claimed
      }
      return claimed
    }
    const rememberClaim = (agentId, projectId, expiresAt, agentName) => {
      let mine = heldClaims.get(agentId)
      if (mine === undefined) {
        mine = new Map()
        heldClaims.set(agentId, mine)
      }
      mine.set(projectId, {
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + CLAIM_TTL_FALLBACK_MS,
        agent: typeof agentName === 'string' ? agentName : '',
        sessionLabel: sessionLabel(agentId) || '',
      })
    }

    ctx.effect(
      () =>
        ctx.on('tools/result', (execution, result) => {
          if (execution === null || execution === undefined || execution.agent === undefined) return
          if (execution.name !== 'project_docs_write') return
          if (result !== null && result !== undefined && result.isError === true) return
          const args = execution.arguments
          if (args === null || typeof args !== 'object') return
          const projectId = typeof args.project === 'string' ? args.project : ''
          if (projectId === '') return
          if (args.action === 'claim_work') {
            const claim = result?.value?.claim ?? result?.claim
            const agentName = typeof claim?.agent === 'string' && claim.agent !== ''
              ? claim.agent
              : (typeof args.agent === 'string' ? args.agent : '')
            rememberClaim(execution.agent.id, projectId, Date.parse(claim?.expiresAt), agentName)
            void refreshProjects()
            return
          }
          // Releasing is the one operation that must clear the in-memory record:
          // otherwise this session would keep writing as if still covered.
          if (args.action === 'release_claim') {
            const mine = heldClaims.get(execution.agent.id)
            if (mine !== undefined) mine.delete(projectId)
            void refreshProjects()
          }
        }),
      'project-docs: claim guard recording',
    )
    ctx.effect(
      () =>
        ctx.on('agent/disposed', (payload) => {
          if (payload === null || payload === undefined || payload.agent === undefined) return
          heldClaims.delete(payload.agent.id)
          for (const key of [...prompted]) {
            if (key.startsWith(`${payload.agent.id}\u0000`)) prompted.delete(key)
          }
        }),
      'project-docs: claim guard cleanup',
    )

    const blockMessage = (projectId, claims) => {
      const scope = claims.map((claim) => `${claim.agent} → ${claim.scope}`).join('；')
      return `占用认领拦截：项目 ${projectId} 正被其他 Agent 认领——${scope}。` +
        '先用 project_docs → list_claims 看清范围；确认与你不重叠后，用 project_docs_write → claim_work 登记你自己的 scope 再动手；' +
        '重叠就先 post_message（message_kind: "claim"）协商。只发留言不登记认领不算数。' +
        '认领不是分地盘：同项目并行时要 post_message（to: 对方 agent）同步你动哪一块，并用 claim_work（claim_id + progress + next_step）更新进度，别各干各的。'
    }
    const promptMessage = (projectId) =>
      `占用认领提示：项目 ${projectId} 还没有任何活跃认领。动手前先 project_docs → list_claims 确认没人撞车，` +
      '再用 project_docs_write → claim_work（agent / scope / ttl_minutes）登记「谁 / 做什么 / 只动哪里」；本次提示只出现一次。' +
      '登记后用 claim_work（claim_id + progress + next_step）持续更新进度与下一步，必要时 post_message（to: 对方 agent）同步。'

    ctx.effect(
      () =>
        safeGuard('claim guard', (execution) => {
          const agent = execution.agent
          if (agent === undefined) return undefined
          const name = typeof execution.name === 'string' ? execution.name : ''
          if (name.startsWith('project_docs')) return undefined
          if (!MUTATING_TOOLS.includes(name)) return undefined
          if (isSubagent(agent.id)) return undefined
          const session = sessionOf(agent.id)
          if (session === undefined || session.header === undefined) return undefined
          const cwd = typeof session.header.cwd === 'string' ? session.header.cwd : ''
          const projectId = projectForContext(projectSnapshot, cwd, execution.arguments)
          if (projectId === undefined) return undefined
          const project = projectSnapshot.find((entry) => entry.id === projectId)
          const claims = activeOnly(project === undefined ? [] : project.claims)
          const claimed = heldExpiry(agent.id, projectId) !== undefined || claimedInHistory(agent.id, projectId)
          const warned = prompted.has(keyFor(agent.id, projectId))
          const verdict = claimDecision({ claimed, warned, others: claims })
          if (verdict === 'prompt') {
            prompted.add(keyFor(agent.id, projectId))
            return promptMessage(projectId)
          }
          if (verdict === 'block') return blockMessage(projectId, claims)
          return undefined
        }),
      'project-docs: claim guard',
    )
  }

  /* ------------------------------- docs supervisor (periodic review) */
  // A fresh agent that never reads the project docs does not know the project's
  // operating background (for example that everything here sits behind a campus
  // LAN). The supervisor keeps that fact in front of every agent: a per-agent
  // dynamic prompt context re-evaluated before each model step, plus a hard gate
  // on the first mutation of a project in a session.
  const supervisorOn = !(config !== null && typeof config === 'object' && config.supervisor === false)
  if (supervisorOn) {
    const SUPERVISOR_CONTEXT = 'project-docs-supervisor'
    const numberSetting = (key, fallback, min, max) => {
      const raw = config !== null && typeof config === 'object' ? config[key] : undefined
      const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
      return Math.min(max, Math.max(min, value))
    }
    const REVIEW_MINUTES = numberSetting('supervisorReviewMinutes', 25, 5, 240)
    const CURATION_MINUTES = numberSetting('supervisorCurationMinutes', 120, 30, 720)
    const COLLAB_MINUTES = numberSetting('supervisorCollabMinutes', 20, 5, 120)
    const REVIEW_MS = REVIEW_MINUTES * 60_000
    const CURATION_MS = CURATION_MINUTES * 60_000
    const COLLAB_MS = COLLAB_MINUTES * 60_000
    /** A repeated link warning about the same hop stays quiet for this long. */
    const LINK_REPEAT_MS = 5 * 60_000
    const requireDocs = !(config !== null && typeof config === 'object' && config.requireDocsBeforeWrite === false)
    // Latency discipline: refuse the first oversized caller-chosen timeout, and
    // remind after any slow call (see `timeout-policy.js`).
    const timeoutGuardOn = !(config !== null && typeof config === 'object' && config.timeoutGuard === false)
    const SLOW_MIN_MS = numberSetting('slowCallWarnSeconds', 20, 3, 300) * 1000
    const TIMEOUT_LIMIT_MS = numberSetting('timeoutWarnAboveSeconds', 120, 10, 3600) * 1000
    /** A slow-call nudge stays visible for this long after the call. */
    const SLOW_CALL_WINDOW_MS = 10 * 60_000
    /** agentId -> { createdAt, consultedAt, curationAt, collabAt, reads: Map(projectId -> Set<'project'|'collab'>) } */
    const supervision = new Map()

    const supervisionOf = (agentId) => {
      let state = supervision.get(agentId)
      if (state === undefined) {
        state = {
          createdAt: Date.now(),
          consultedAt: undefined,
          curationAt: undefined,
          collabAt: undefined,
          reads: new Map(),
          timeoutWarned: false,
          slowCallAt: 0,
          slowCallMs: 0,
        }
        supervision.set(agentId, state)
      }
      return state
    }
    const noteDocRead = (agentId, projectId, kind) => {
      const state = supervisionOf(agentId)
      let flags = state.reads.get(projectId)
      if (flags === undefined) {
        flags = new Set()
        state.reads.set(projectId, flags)
      }
      flags.add(kind)
    }
    // Reads that happened before a reload are recovered from the session log so a
    // reload never blocks a project the session already studied.
    const readsFromHistory = (agentId, projectId) => {
      const flags = new Set()
      const session = sessionOf(agentId)
      if (session === undefined || typeof session.ownEvents !== 'function') return flags
      try {
        for (const event of session.ownEvents()) {
          if (event.type !== 'tool/call') continue
          const data = event.data
          if (data === undefined || data.name !== 'project_docs') continue
          let args
          try {
            args = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '')
          } catch {
            continue
          }
          if (args === null || args === undefined || args.action !== 'read_doc') continue
          if (args.project !== projectId) continue
          const kind = typeof args.kind === 'string' ? args.kind : 'project'
          const docName = typeof args.doc_name === 'string' ? args.doc_name : ''
          if (kind === 'project' || docName === 'PROJECT.md') flags.add('project')
          if (kind === 'collab' || docName === 'COLLAB.md') flags.add('collab')
        }
      } catch {
        return flags
      }
      return flags
    }
    const readsFor = (agentId, projectId) => {
      const flags = readsFromHistory(agentId, projectId)
      const memory = supervision.get(agentId)?.reads.get(projectId)
      if (memory !== undefined) {
        for (const kind of memory) flags.add(kind)
      }
      return flags
    }
    /**
     * Parallel agents on the same project must talk to each other, not just
     * carve out separate zones and never meet again. When this agent holds a
     * claim and a peer also holds one in the same project, remind it to publish
     * its progress / next step and to check the peer's, throttled to one line per
     * COLLAB_MS.
     */
    const collabReminder = (agentId, state, now) => {
      const pairs = new Map()
      const held = heldClaims.get(agentId)
      if (held !== undefined) {
        for (const [projectId, entry] of held) {
          if (entry.expiresAt > now) pairs.set(projectId, { agent: entry.agent, sessionLabel: entry.sessionLabel || '' })
        }
      }
      if (pairs.size === 0) {
        for (const [projectId, agentName] of claimedAgentsFromHistory(agentId)) pairs.set(projectId, { agent: agentName, sessionLabel: '' })
      }
      if (pairs.size === 0) return ''
      if (state.collabAt !== undefined && now - state.collabAt < COLLAB_MS) return ''
      const lines = []
      for (const [projectId, entry] of pairs) {
        if (typeof entry.agent !== 'string' || entry.agent === '') continue
        const project = projectSnapshot.find((candidate) => candidate.id === projectId)
        const claims = activeOnly(project === undefined ? [] : project.claims)
        const peers = claims.filter((claim) => claim.agent !== entry.agent)
        if (peers.length === 0) continue
        const who = peers.map((claim) => `${claim.agent}（${claim.scope}${claim.nextStep ? ` · 下一步：${claim.nextStep}` : ''}）`).join('；')
        const peerSession = entry.sessionLabel !== '' ? ` · 会话：${entry.sessionLabel}` : ''
        lines.push(
          `**协作提醒：项目 ${projectId} 上你和 ${peers.map((claim) => claim.agent).join('、')} 同时有认领** — ` +
            `对方现在：${who}${peerSession}。` +
            '用 project_docs → list_claims 看对方进度，然后用 project_docs_write → claim_work（claim_id + progress + next_step）更新你自己的进度与下一步；' +
            '并在 Agent 留言板 post_message（to: 对方 agent，message_kind: "claim"）同步约定——确认各自动哪一块、下一步谁先动，避免互相覆盖。' +
            '认领不是分地盘：同项目并行的 agent 必须互相通报进展，直到一方 release_claim。',
        )
      }
      if (lines.length === 0) return ''
      state.collabAt = now
      return lines.join('\n')
    }
    /**
     * How often to re-scan the boards.
     *
     * The read cursor already guarantees nothing is shown twice, so this is now
     * purely a "how fresh is the prompt" knob rather than a noise-suppression
     * one. It was 30 minutes, which meant a message sent right after a session
     * started stayed invisible for half an hour — the cursor is written once at
     * startup, and the cache then held that empty result. 30 seconds is cheap
     * (one small directory listing per board) and makes delivery feel immediate.
     */
    const MESSAGE_CHECK_MS = 30_000
    /** agentId -> { at, lines } cached unread-message summary. */
    const messageCache = new Map()
    /**
     * Read cursor: `${agentId}` -> `{ [projectId]: lastSeenMessageId }`.
     *
     * Without this the same history is re-injected on every throttle window,
     * which is worse than injecting nothing: an agent that sees the same block
     * of stale messages twice learns to skip that whole section of its prompt.
     */
    const seenFileOf = (agentId) =>
      path.join(storeDir, '.supervisor-seen', `${String(agentId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
    const readCursor = (agentId) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(seenFileOf(agentId), 'utf8'))
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }
    const writeCursor = (agentId, cursor) => {
      try {
        fs.mkdirSync(path.dirname(seenFileOf(agentId)), { recursive: true })
        fs.writeFileSync(seenFileOf(agentId), JSON.stringify(cursor, null, 2))
      } catch {
        // A cursor write failure only costs a repeat, never correctness.
      }
    }
    /**
     * Messages left by OTHER sessions that this session should see.
     *
     * Three filters, each answering a failure observed in a real session
     * (2026-11-03, a fresh restart injected 81 unreleased messages):
     *
     *  1. **Only the project this session works in.** Scanning all twelve
     *     projects' boards meant a session in one project received every other
     *     project's broadcasts.
     *  2. **Never echo my own messages.** The board does not distinguish
     *     "someone wrote to me" from "I wrote this" — only `author` does.
     *  3. **Never repeat.** The read cursor advances past what has been shown.
     *
     * A session that is not inside any project still sees messages addressed to
     * its exact label — an explicit "I am talking to you" must not be lost just
     * because the cwd is outside the project tree.
     */
    const crossSessionMessages = async (agentId, now) => {
      const cached = messageCache.get(agentId)
      if (cached !== undefined && now - cached.at < MESSAGE_CHECK_MS) {
        return { lines: cached.lines, backlog: cached.backlog ?? 0, brief: cached.brief ?? '' }
      }
      const label = sessionLabel(agentId)
      const lines = []
      let backlog = 0
      let brief = ''
      const cursor = readCursor(agentId)
      try {
        const session = sessionOf(agentId)
        const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
        const projectId = projectForContext(projectSnapshot, cwd, {})
        // The handoff brief only makes sense inside a project: it answers "what
        // did the previous session leave *here*". Computed once per project.
        if (projectId !== undefined) {
          try {
            const [board, claims] = await Promise.all([
              store.listMessages(storeDir, projectId, 'agent', 20),
              store.activeClaims(storeDir, projectId),
            ])
            brief = renderBrief(
              buildBrief({
                projectId,
                messages: board.entries,
                claims,
                selfLabel: label,
                now,
              }),
            )
          } catch {
            // A brief failure must never cost the messages themselves.
          }
        }
        const boards = projectId === undefined ? projectSnapshot.map((p) => p.id) : [projectId]
        for (const id of boards) {
          if (id === '') continue
          const board = await store.listMessages(storeDir, id, 'agent', 30)
          const last = typeof cursor[id] === 'string' ? cursor[id] : ''
          // The selection rules live in session-bus.js as a pure function so they
          // can be asserted on. They were wrong twice while inline here, and both
          // times the only detector was a human reading a live system prompt.
          const picked = selectMessages({
            entries: board.entries,
            label,
            authorOfMe: label,
            projectId,
            lastSeen: last,
          })
          if (picked.cursor !== last && picked.cursor !== '') {
            cursor[id] = picked.cursor
            writeCursor(agentId, cursor)
          }
          if (picked.firstSight && picked.backlog > 0) {
            backlog += picked.backlog
          }
          for (const line of picked.lines) lines.push(line)
        }
      } catch {
        // A board read failure only costs this reminder, never correctness.
      }
      messageCache.set(agentId, { at: now, lines, backlog, brief })
      return { lines, backlog, brief }
    }
    // Evaluated before each model step: empty while the docs are fresh, so the
    // normal case costs no prompt text.
    const supervisorText = async (agentId) => {
      const state = supervisionOf(agentId)
      const now = Date.now()
      const parts = []
      // Session identity: every agent knows which session it is, so that
      // cross-session messages and claims can be attributed correctly.
      const label = sessionLabel(agentId)
      if (label !== '') {
        parts.push(`**会话身份：${label}** — 你是 ${label}，不是别的会话。`)
      }
      if (state.consultedAt === undefined) {
        const idleMinutes = Math.round((now - state.createdAt) / 60_000)
        const when = idleMinutes >= 1 ? `本会话已 ${idleMinutes} 分钟没查项目文档` : '本会话还没查项目文档'
        parts.push(
          `**文档监督：${when}** — 先用 project_docs → list_projects 定位项目，` +
            '读 PROJECT.md（是什么 / 入口 / 现状）和 COLLAB.md（红线 / 开发背景，例如网络环境是不是校园网内网、限速与端口策略），再动手。' +
            '在重提旧 bug、重写现成脚本之前先 search_docs / find_tools 查一遍：归档文档仍在库里，读文档比重新推一遍省 token。',
        )
      } else {
        const staleMinutes = Math.round((now - state.consultedAt) / 60_000)
        if (now - state.consultedAt >= REVIEW_MS) {
          parts.push(
            `**文档监督：已 ${staleMinutes} 分钟未复查文档** — 动手前确认 PROJECT.md / COLLAB.md 写的开发背景（网络环境：校园网内网等）仍然成立；` +
              '发现与现状不符或有了新结论，用 project_docs_write → write_doc / append_doc 回写，别只留在会话里。' +
              '如果正在重新分析一个旧问题，先 search_docs 查有没有现成结论——重复发明轮子是最贵的浪费。',
          )
        }
        const curationBase = Math.max(state.curationAt ?? 0, state.consultedAt)
        if (now - curationBase >= CURATION_MS) {
          state.curationAt = now
          parts.push(
            '**文档监督：该整理文档了** — 扫一眼本项目文档：过时的进度报告 / 交接 / 一次性日志按 DISCIPLINE 的归档规则移进 archive，' +
              '被取代的旧稿删掉；还在做的事写进 COLLAB.md 的 WORKLOG。',
          )
        }
      }
      const collab = collabReminder(agentId, state, now)
      if (collab !== '') parts.push(collab)
      // Cross-session messages: another session may have left a message on a
      // project's agent board. Injecting it here means the agent sees it without
      // polling — it arrives with the next system-prompt assembly.
      const picked = await crossSessionMessages(agentId, now)
      // The handoff brief goes first: "who was here before me and what did they
      // leave" is the question a fresh session needs answered before anything
      // else, including any new messages.
      if (picked.brief !== '') parts.push(picked.brief)
      const messageBlock = renderMessageBlock(picked.lines, picked.backlog)
      if (messageBlock !== '') parts.push(messageBlock)
      if (state.slowCallAt !== 0 && now - state.slowCallAt <= SLOW_CALL_WINDOW_MS) {
        parts.push(
          `**效率监督：上一次调用花了 ${describeDuration(state.slowCallMs ?? 0)}** — 下一次别再盯着一件事等完：` +
            '先想能不能**并发**（同一轮的独立调用一起发、或用 subagent/workflow 并行）、有没有**更省的做法**（缩小范围、换镜像、只取需要的片段、加 `--depth 1`/`-q`/分页）；' +
            '实在只能等，就把超时压到够用为止（分钟级超时是最后手段，且要考虑放后台 job 而不是阻塞），不要用长超时来「稳」。',
        )
      }
      // A tripped breaker is the one thing that must be impossible to ignore.
      const breaker = breakerOf(agentId).state
      if (isWriteBlocked(breaker)) parts.push(traceModeReminder(breaker.tripped ?? {}))
      return parts.join('\n')
    }

    // Track document reads/writes so the reminder knows when docs were last touched.
    /** Call start times, so a finished call can report how long it blocked. */
    const callStartedAt = new Map()

    // Link discipline: a write that lands on a deploy source / package artifact /
    // cache layer must not be assumed live. The warning rides back on the same
    // tool result, right where the model is about to reason about it.
    const linkOn = !(config !== null && typeof config === 'object' && config.linkGuard === false)
    const pendingLinks = new Map()
    if (linkOn) {
      ctx.effect(
        () =>
          ctx.on('tools/post-execute', async (execution, result, next) => {
            const decision = await next()
            if (decision === null || decision === undefined || decision.kind !== 'accept') return decision
            try {
              const agent = execution === null || execution === undefined ? undefined : execution.agent
              if (agent === undefined || agent === null) return decision
              const name = typeof execution.name === 'string' ? execution.name : ''
              if (name.startsWith('project_docs')) return decision
              const classification = classifyWrite({ toolName: name, args: execution.arguments })
              if (!classification.isWrite) return decision
              const verdict = linkDecision(classification)
              const isError = result !== null && result !== undefined && result.isError === true
              if (!verdict.warn || isError) {
                // A write that failed changed nothing, and a write with no
                // distribution hop stays local — neither needs the reminder.
                pendingLinks.delete(execution.callId)
                return decision
              }
              const state = supervisionOf(agent.id)
              if (state.lastLinkKey === verdict.hops.join('|') && Date.now() - (state.lastLinkAt ?? 0) < LINK_REPEAT_MS) {
                return decision
              }
              state.lastLinkKey = verdict.hops.join('|')
              state.lastLinkAt = Date.now()
              const text = linkWarning({
                target: classification.targets.filter((entry) => entry.length < 120).slice(0, 2).join(' · '),
                hops: verdict.hops,
                consumer: classification.consumer,
              })
              const contexts = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
              const nextDecision = {
                ...decision,
                additionalContexts: [...contexts, userNotice(text, 'link-guard', verdict.hops.join('、'))],
              }
              pendingLinks.set(execution.callId, { at: Date.now(), hops: verdict.hops })
              if (config !== null && typeof config === 'object' && config.breakerDebug === true) {
                try {
                  fs.appendFileSync(
                    path.join(storeDir, '.link-trace.jsonl'),
                    `${JSON.stringify({ at: new Date().toISOString(), agentId: agent.id, name, hops: verdict.hops, text: text.slice(0, 300) })}\n`,
                  )
                } catch {
                  // Trace is diagnostic only.
                }
              }
              return nextDecision
            } catch {
              // Never break a tool call over a reminder.
              return decision
            }
          }),
        'project-docs: link guard',
      )
    }

    // Track document reads/writes so the reminder knows when docs were last touched,
    // and note slow calls so the next step can favour concurrency over waiting.
    ctx.effect(
      () =>
        ctx.on('tools/pre-execute', async (execution, next) => {
          if (execution !== null && execution !== undefined && execution.agent !== undefined) {
            callStartedAt.set(execution.callId, Date.now())
          }
          return next()
        }),
      'project-docs: slow call start',
    )
    ctx.effect(
      () =>
        ctx.on('tools/result', (execution, result) => {
          if (execution === null || execution === undefined || execution.agent === undefined) return
          const startedAt = callStartedAt.get(execution.callId)
          if (startedAt !== undefined) {
            callStartedAt.delete(execution.callId)
            const elapsed = Date.now() - startedAt
            if (elapsed >= SLOW_MIN_MS) {
              const state = supervisionOf(execution.agent.id)
              state.slowCallAt = Date.now()
              state.slowCallMs = elapsed
            }
          }
          if (result !== null && result !== undefined && result.isError === true) return
          const name = typeof execution.name === 'string' ? execution.name : ''
          if (!name.startsWith('project_docs')) return
          const state = supervisionOf(execution.agent.id)
          state.consultedAt = Date.now()
          const args = execution.arguments
          if (args === null || typeof args !== 'object' || args.action !== 'read_doc') return
          const projectId = typeof args.project === 'string' ? args.project : ''
          if (projectId === '') return
          const kind = typeof args.kind === 'string' ? args.kind : 'project'
          const docName = typeof args.doc_name === 'string' ? args.doc_name : ''
          if (kind === 'project' || docName === 'PROJECT.md') noteDocRead(execution.agent.id, projectId, 'project')
          if (kind === 'collab' || docName === 'COLLAB.md') noteDocRead(execution.agent.id, projectId, 'collab')
        }),
      'project-docs: supervisor tracking',
    )

    // ------------------------------- skill-derived gates (deepseek-stack)
    // Each rule below comes from an aicodeking/deepseek-stack SKILL.md, reduced
    // to the part a program can actually check. The skills state good behaviour;
    // without this, a model can load one and skip half its steps unnoticed.
    // Per-skill decisions live in docs/UPSTREAM-SKILLS.md.
    const skillGateOn = !(config !== null && typeof config === 'object' && config.skillGate === false)
    const skillTracker = skillGateOn ? createFailureTracker() : undefined
    /** agentId -> whether the stop message has already been shown. */
    const skillStopTold = new Set()
    /** agentId -> Set of production files written this turn (ds-plan-loop). */
    const filesTouched = new Map()
    /** agentId -> whether the "plan first" reminder has been shown. */
    const planTold = new Set()

    const noteSkillFailure = (agentId, execution, result) => {
      if (skillTracker === undefined) return
      const name = typeof execution?.name === 'string' ? execution.name : ''
      const args = execution?.arguments !== null && typeof execution?.arguments === 'object' ? execution.arguments : {}
      const command = typeof args.command === 'string' ? args.command : typeof args.script === 'string' ? args.script : ''
      const ranCheck = RUNNER_TOOLS.has(name) && looksLikeCheck(command)
      const outcome = skillTracker.record(agentId, {
        failed: toolFailed(result),
        ranCheck,
        fingerprint: failureFingerprint(resultText(result)),
      })
      const verdict = stopMessage({
        verifyStop: outcome.verifyStop,
        unstickStop: outcome.unstickStop,
        alreadyTold: skillStopTold.has(agentId),
      })
      if (verdict.tell !== true) return
      skillStopTold.add(agentId)
      const agent = execution.agent
      if (agent !== undefined && agent !== null && typeof agent.steer === 'function') {
        agent.steer(userNotice(verdict.message, `skill-gate-${verdict.kind}`, verdict.kind))
      }
    }

    if (skillGateOn) {
      // ds-verify-loop rule: never weaken a test to make the check pass. The
      // guard fires *before* the write lands, so a gutted assertion never
      // reaches disk — a check after the fact would have to revert it, which is
      // a much worse experience and leaves the mutation in git history.
      ctx.effect(
        () =>
          safeGuard('test integrity gate', (execution) => {
            const agent = execution === undefined ? undefined : execution.agent
            if (agent === undefined || agent === null) return undefined
            const name = typeof execution.name === 'string' ? execution.name : ''
            if (!WRITE_TOOLS.has(name)) return undefined
            const args = execution.arguments !== null && typeof execution.arguments === 'object' ? execution.arguments : {}
            const filePath = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : ''
            if (!isTestFile(filePath)) return undefined

            // Reconstruct what the file will look like after this call.
            let before = ''
            try {
              before = fs.readFileSync(filePath, 'utf8')
            } catch {
              before = ''
            }
            let after = before
            if (name === 'write' && typeof args.content === 'string') after = args.content
            else if (name === 'edit' && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
              after = before.replace(args.old_string, args.new_string)
            } else {
              // multi_edit / apply_patch: cannot reconstruct reliably, so fall
              // back to asking once rather than guessing.
              return undefined
            }
            const verdict = weakensTest(before, after)
            if (verdict.weakened !== true) return undefined
            return (
              `测试完整性门禁：这次改动会削弱 ${filePath.split(/[\\/]/).pop()} —— ${verdict.why}。\n` +
              '（来自 ds-verify-loop：绝不通过削弱、跳过或删除测试 / 断言 / 类型 / lint 规则来让检查通过。）\n' +
              '怎么办：\n' +
              '1) 如果**实现**错了 → 改实现，测试不动；\n' +
              '2) 如果**测试**写错了 → 说明为什么错、依据什么（文件:行号 / 文档 / 真实输出），再改；\n' +
              '3) 确实要停用某个用例 → 保留原断言，加 `skip` 并写明原因与解除条件，不要删断言。\n' +
              '本条只拦一次；确认有意义地重发即可通过。'
            )
          }),
        'project-docs: test integrity gate',
      )

      // ds-plan-loop step 1: "for work that touches more than one file, write a
      // numbered plan".  Counted from real writes, not from what the model says
      // it will do.
      ctx.effect(
        () =>
          ctx.on('tools/result', (execution, result) => {
            try {
              const agent = execution === null || execution === undefined ? undefined : execution.agent
              if (agent === undefined || agent === null) return
              const name = typeof execution.name === 'string' ? execution.name : ''
              if (!WRITE_TOOLS.has(name)) return
              if (result !== null && result !== undefined && result.isError === true) return
              const args = execution.arguments !== null && typeof execution.arguments === 'object' ? execution.arguments : {}
              const filePath = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : ''
              if (!isCodeFile(filePath) || isTestFile(filePath)) return
              let touched = filesTouched.get(agent.id)
              if (touched === undefined) {
                touched = new Set()
                filesTouched.set(agent.id, touched)
              }
              touched.add(filePath)
              const threshold = planThreshold(touched)
              if (threshold.needsPlan !== true || planTold.has(agent.id)) return
              planTold.add(agent.id)
              if (typeof agent.steer === 'function') {
                agent.steer(
                  userNotice(
                    `计划纪律：本轮你已经改了 ${threshold.count} 个生产代码文件（来自 ds-plan-loop：改动跨文件时先给编号计划）。\n` +
                      '在继续之前，用一两句话说明：要动哪些文件、按什么顺序、每步怎么验证、失败怎么回退。\n' +
                      '不需要等批准，说清楚即可继续。（本条只出现一次。）',
                    'skill-gate-plan',
                    'plan',
                  ),
                )
              }
            } catch {
              // Observation must never break a call.
            }
          }),
        'project-docs: plan threshold observe',
      )

      ctx.effect(
        () =>
          ctx.on('agent/disposed', (payload) => {
            const agent = payload === null || payload === undefined ? undefined : payload.agent
            if (agent === undefined || agent === null) return
            skillTracker?.drop(agent.id)
            skillStopTold.delete(agent.id)
            filesTouched.delete(agent.id)
            planTold.delete(agent.id)
          }),
        'project-docs: skill gate cleanup',
      )
    }

    // --------------------------------------------- circuit breaker
    // Two identical failures in a row mean the current approach is wrong, not
    // unlucky. The breaker trips into Trace Mode: writes are refused until the
    // model hands back a consumer-side trace instead of another patch.
    const breakerOn = !(config !== null && typeof config === 'object' && config.circuitBreaker === false)
    if (breakerOn) {
      // Observe failing commands (real error text, from the tool result).
      ctx.effect(
        () =>
          ctx.on('tools/result', (execution, result) => {
            try {
              const agent = execution === null || execution === undefined ? undefined : execution.agent
              if (agent === undefined || agent === null) return
              const name = typeof execution.name === 'string' ? execution.name : ''
              // The breaker's own escape hatch must never feed the breaker.
              if (name === 'project_docs_write') {
                const args = execution.arguments
                if (args !== null && typeof args === 'object' && (args.action === 'trace_report' || args.action === 'verify_deliverable')) return
              }
              if (result === null || result === undefined) return
              // Unconditional trace so "the listener never fired" and "the
              // listener fired but saw no failure flag" stay distinguishable.
              if (config !== null && typeof config === 'object' && config.breakerDebug === true) {
                try {
                  fs.appendFileSync(
                    path.join(storeDir, '.breaker-trace.jsonl'),
                    `${JSON.stringify({ at: new Date().toISOString(), agentId: String(agent.id ?? ''), name, isError: result.isError, failed: toolFailed(result), text: String(resultText(result)).slice(0, 400) })}\n`,
                  )
                } catch {
                  // Diagnosis must never break a call.
                }
              }
              if (!toolFailed(result)) return
              noteFailure(agent.id, resultText(result), 'command')
              // Skill-derived counters (ds-verify-loop / ds-unstick). They ride
              // the same observation instead of a second listener, so the two
              // gates can never disagree about what counted as a failure.
              if (skillGateOn) noteSkillFailure(agent.id, execution, result)
            } catch {
              // Observation must never break a call.
            }
          }),
        'project-docs: breaker observe',
      )
      // Observe user negative feedback ("还是黑的", "根本没更新") on the agent's inbox.
      ctx.effect(
        () =>
          ctx.on('agent/pre-step', async (payload, next) => {
            try {
              const agent = payload === null || payload === undefined ? undefined : payload.agent
              const messages = Array.isArray(payload?.messages) ? payload.messages : []
              if (agent !== undefined && agent !== null) {
                for (const message of messages) {
                  const blocks = Array.isArray(message?.content) ? message.content : []
                  const text = blocks
                    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
                    .map((block) => String(block.text ?? ''))
                    .join('\n')
                  if (text !== '' && isNegativeFeedback(text)) noteFailure(agent.id, text, 'feedback')
                }
              }
            } catch {
              // Never fail a step over the breaker.
            }
            return next()
          }),
        'project-docs: breaker feedback',
      )
      // Refuse writes while the breaker is tripped.
      ctx.effect(
        () =>
          safeGuard('breaker guard', (execution) => {
            const agent = execution.agent
            if (agent === undefined || agent === null) return undefined
            const name = typeof execution.name === 'string' ? execution.name : ''
            if (name.startsWith('project_docs')) return undefined
            if (!MUTATING_TOOLS.includes(name)) return undefined
            // Trace Mode asks for exactly the work that needs a shell — "read the
            // consumer source, grab the real logs, capture the real packets" — and
            // then refuses every shell command. That is a one-way door: the agent
            // cannot gather the evidence that would unlock it. Inspection stays
            // allowed; only commands that mutate something are refused.
            if (SHELL_TOOLS.includes(name)) {
              const command = shellCommandOf(execution)
              if (command !== '' && isReadOnlyCommand(command)) return undefined
            }
            const state = breakerOf(agent.id).state
            if (!isWriteBlocked(state)) return undefined
            // Say *why* the command counted as a write — otherwise the agent just
            // reformulates the same command and hits the same wall.
            const why = SHELL_TOOLS.includes(name) ? readOnlyCommandReason(shellCommandOf(execution)) : ''
            const message = traceModeMessage(state.tripped ?? {})
            return why === '' ? message : `${message}\n\n判定为写入的原因：${why}`
          }),
        'project-docs: breaker guard',
      )
    }

    // ------------------------------------------- proof of verification gate
    // A turn may not close on "已完成 / 已修复 / 已就绪" unless this session has
    // recorded real end-to-end evidence for that project.
    const proofGateOn = !(config !== null && typeof config === 'object' && config.proofGate === false)
    if (proofGateOn) {
      ctx.effect(
        () =>
          ctx.on('agent/turn-stopping', async (payload) => {
            try {
              const agent = payload === null || payload === undefined ? undefined : payload.agent
              if (agent === undefined || agent === null) return
              const session = sessionOf(agent.id)
              if (session === undefined || typeof session.deriveMessages !== 'function') return
              const messages = session.deriveMessages()
              const last = lastAssistantMessage(messages)
              if (last === undefined) return
              const text = normalizeForClaim(assistantText(last))
              const claims = findClaims(text)
              if (claims.length === 0) return
              const cwd = typeof session.header?.cwd === 'string' ? session.header.cwd : ''
              const projectId = projectForContext(projectSnapshot, cwd, {}) ?? projectForContext(projectSnapshot, cwd)
              const proof = latestProofFor(agent.id, projectId, last)
              if (proof !== undefined) return
              const missing = ['request', 'file', 'env']
              const feedback =
                `未检测到物理端到端验证证据${projectId === undefined ? '' : `（项目 ${projectId}）`}：` +
                `你在本轮回复里写了「${claims[0].label}」，但这一轮没有登记任何真实交付验证。\n` +
                `${missingEvidenceMessage(missing, { projectId: projectId ?? '', claimKind: claims[0].label })}\n` +
                '（本条是插件拦截，不是用户说的话。要么补证据，要么把结论改成「未实测」。）'
              if (typeof agent.steer === 'function') {
                agent.steer(userNotice(feedback, 'proof-gate', claims[0].label))
              }
              if (config !== null && typeof config === 'object' && config.breakerDebug === true) {
                try {
                  fs.appendFileSync(
                    path.join(storeDir, '.proof-trace.jsonl'),
                    `${JSON.stringify({ at: new Date().toISOString(), agentId: agent.id, projectId: projectId ?? '', claim: claims[0].label, line: claims[0].line, steered: typeof agent.steer === 'function', feedback: feedback.slice(0, 240) })}\n`,
                  )
                } catch {
                  // Trace is diagnostic only.
                }
              }
            } catch {
              // Never fail a turn boundary over the gate.
            }
          }),
        'project-docs: proof gate',
      )
    }

    // ------------------------------------------- does it need the docs first
    // The write-gate above only fires on write/edit/bash. An agent that never
    // writes — it just asks the user what the network environment is, or recites
    // a wrong port from memory — passes straight through it. That is the failure
    // the user reported: "反复询问我基础背景信息，反复出现基础知识错误".
    //
    // This gate reads the assistant's own message at the turn boundary. If it is
    // asking for background the docs already state, or asserting project facts on
    // a turn where nothing was read, it is sent back once with the actual file to
    // open. One steer per agent per turn is enough: the point is to redirect, not
    // to punish.
    const docNeedOn = !(config !== null && typeof config === 'object' && config.docNeedGate === false)
    if (docNeedOn) {
      /** agentId -> how many times this gate has fired, so it cannot loop forever. */
      const docNeedFired = new Map()
      const DOC_NEED_MAX = 3
      ctx.effect(
        () =>
          ctx.on('agent/turn-stopping', async (payload) => {
            try {
              const agent = payload === null || payload === undefined ? undefined : payload.agent
              if (agent === undefined || agent === null) return
              const fired = docNeedFired.get(agent.id) ?? 0
              if (fired >= DOC_NEED_MAX) return
              const session = sessionOf(agent.id)
              if (session === undefined || typeof session.deriveMessages !== 'function') return
              if (session.header?.origin === 'subagent') return
              const cwd = typeof session.header?.cwd === 'string' ? session.header.cwd : ''
              const projectId = projectForContext(projectSnapshot, cwd, {})
              // Only meaningful inside a project: with no project there is no
              // documented background to have missed.
              if (projectId === undefined) return
              const reads = readsFor(agent.id, projectId)
              const messages = session.deriveMessages()
              const last = lastAssistantMessage(messages)
              if (last === undefined) return
              const text = assistantText(last)
              // The opening turn is the one that recites facts from memory; later
              // turns may legitimately have learned them from a tool result.
              const assistantTurns = messages.filter((message) => message.role === 'assistant').length
              const verdict = docNeed(text, {
                readAny: reads.size > 0,
                isFirstTurn: assistantTurns <= 1,
              })
              if (!verdict.needsDocs) return
              docNeedFired.set(agent.id, fired + 1)
              const feedback = docNeedMessage(projectId, verdict.reason)
              if (typeof agent.steer === 'function') {
                agent.steer(userNotice(feedback, 'doc-need-gate', projectId))
              }
              if (config !== null && typeof config === 'object' && config.breakerDebug === true) {
                try {
                  fs.appendFileSync(
                    path.join(storeDir, '.doc-need-trace.jsonl'),
                    `${JSON.stringify({ at: new Date().toISOString(), agentId: agent.id, projectId, reason: verdict.reason, steered: typeof agent.steer === 'function', head: text.slice(0, 160) })}\n`,
                  )
                } catch {
                  // Trace is diagnostic only.
                }
              }
            } catch {
              // Never fail a turn boundary over this gate.
            }
          }),
        'project-docs: doc need gate',
      )
      ctx.effect(
        () =>
          ctx.on('agent/disposed', (payload) => {
            const agent = payload === null || payload === undefined ? undefined : payload.agent
            if (agent === undefined || agent === null) return
            docNeedFired.delete(agent.id)
          }),
        'project-docs: doc need cleanup',
      )
    }

    // ------------------------------------------- plan by expected size
    // The discipline asks for a plan proportional to the task, but "proportional"
    // only works if the agent states the size. When it does, the band decides
    // the ceremony: ≤5 min just do it, 5–20 min show the plan and proceed,
    // >20 min show the plan and wait for approval.
    //
    // Only fires on a duration the agent wrote itself. Guessing a size from
    // natural language would be a measurement-shaped opinion, and firing on
    // messages with no estimate would just be noise.
    const estimateOn = !(config !== null && typeof config === 'object' && config.estimateGate === false)
    if (estimateOn) {
      /** agentId -> times fired, so the gate cannot loop. */
      const estimateFired = new Map()
      const ESTIMATE_MAX = 2
      ctx.effect(
        () =>
          ctx.on('agent/turn-stopping', async (payload) => {
            try {
              const agent = payload === null || payload === undefined ? undefined : payload.agent
              if (agent === undefined || agent === null) return
              if ((estimateFired.get(agent.id) ?? 0) >= ESTIMATE_MAX) return
              const session = sessionOf(agent.id)
              if (session === undefined || typeof session.deriveMessages !== 'function') return
              if (session.header?.origin === 'subagent') return
              const messages = session.deriveMessages()
              const last = lastAssistantMessage(messages)
              if (last === undefined) return
              const text = assistantText(last)
              const verdict = estimateVerdict(text, {
                planVisible: looksLikePlan(text),
                waiting: looksWaiting(text),
              })
              if (verdict === null) return
              estimateFired.set(agent.id, (estimateFired.get(agent.id) ?? 0) + 1)
              if (typeof agent.steer === 'function') {
                agent.steer(userNotice(verdict.message, 'estimate-gate', verdict.band))
              }
            } catch {
              // Never fail a turn boundary over this gate.
            }
          }),
        'project-docs: estimate gate',
      )
      ctx.effect(
        () =>
          ctx.on('agent/disposed', (payload) => {
            const agent = payload === null || payload === undefined ? undefined : payload.agent
            if (agent === undefined || agent === null) return
            estimateFired.delete(agent.id)
          }),
        'project-docs: estimate cleanup',
      )
    }

    // Register one dynamic context per live agent. Registrations are owned by the
    // agent context, so they disappear with the agent.
    const installSupervisorContext = (agent) => {
      try {
        const agentCtx = agent.ctx
        const api = typeof agentCtx?.get === 'function' ? agentCtx.get('systemPrompt') : agent.systemPrompt
        if (api === undefined) return
        // Scope-filtered waterfall: registered through the agent's own Context, so
        // this listener sees only this agent's assemblies. It recomputes the
        // reminder on every assembly, which a cached PromptContext text provider
        // does not guarantee once the session is already running.
        const sync = async (assembly) => {
          const text = await supervisorText(agent.id)
          const contexts = Array.isArray(assembly.contexts) ? assembly.contexts : []
          assembly.contexts = contexts.filter((entry) => entry.name !== SUPERVISOR_CONTEXT)
          if (text !== '') {
            assembly.contexts.push({ name: SUPERVISOR_CONTEXT, text, interpolate: false })
          }
        }
        const register = () => {
          if (typeof agentCtx.on !== 'function') return
          agentCtx.on('system-prompt/assemble', async (assembly, _context, next) => {
            const result = await next()
            try {
              await sync(result)
            } catch {
              // Never fail a prompt assembly over a reminder.
            }
            return result
          })
        }
        if (typeof agentCtx?.effect === 'function') agentCtx.effect(register, 'project-docs: supervisor context')
        else register()
      } catch {
        // A prompt reminder is best effort: never fail agent creation over it.
      }
    }
    ctx.effect(
      () =>
        ctx.on('agent/created', (payload) => {
          const agent = payload === null || payload === undefined ? undefined : payload.agent
          if (agent === undefined || agent === null) return
          supervisionOf(agent.id)
          // Register this agent's session identity so cross-session messages
          // and claims can be attributed to a specific session.
          try {
            const session = sessionOf(agent.id)
            if (session !== undefined && session.header !== undefined) {
              const label = sessionLabel(agent.id)
              if (label !== '') {
                sessionRegistry.set(agent.id, {
                  label,
                  cwd: typeof session.header.cwd === 'string' ? session.header.cwd : '',
                  origin: typeof session.header.origin === 'string' ? session.header.origin : '',
                  createdAt: Date.now(),
                  lastSeen: Date.now(),
                })
              }
            }
          } catch {
            // Session registration is best effort.
          }
          installSupervisorContext(agent)
        }),
      'project-docs: supervisor init',
    )
    ctx.effect(
      () =>
        ctx.on('agent/disposed', (payload) => {
          const agent = payload === null || payload === undefined ? undefined : payload.agent
          if (agent === undefined || agent === null) return
          supervision.delete(agent.id)
          sessionRegistry.delete(agent.id)
        }),
      'project-docs: supervisor cleanup',
    )

    if (requireDocs) {
      const docsGateMessage = (projectId) =>
        `项目文档门禁：动 ${projectId} 之前先读它的文档——project_docs → read_doc（先 kind: "project" 的 PROJECT.md，再 kind: "collab" 的 COLLAB.md）。` +
        '里面写着这个项目的开发背景（网络环境：校园网内网、限速与端口策略等）、红线和不要回退的修复。' +
        '刚有 agent 在不知道项目跑在校园网里的情况下改 TCP 参数，就是漏了这一步；读一份即可继续。'
      ctx.effect(
        () =>
          safeGuard('docs gate', (execution) => {
            const agent = execution.agent
            if (agent === undefined) return undefined
            const name = typeof execution.name === 'string' ? execution.name : ''
            if (name.startsWith('project_docs')) return undefined
            if (!MUTATING_TOOLS.includes(name)) return undefined
            const session = sessionOf(agent.id)
            if (session === undefined || session.header === undefined) return undefined
            const cwd = typeof session.header.cwd === 'string' ? session.header.cwd : ''
            const projectId = projectForContext(projectSnapshot, cwd, execution.arguments)
            if (projectId === undefined) return undefined
            if (readsFor(agent.id, projectId).size > 0) return undefined
            return docsGateMessage(projectId)
          }),
        'project-docs: docs gate',
      )
    }

    // Latency discipline: refuse the first oversized timeout request per agent,
    // so the agent re-plans (concurrency / cheaper path / smaller scope) instead
    // of settling into a multi-minute block.
    if (timeoutGuardOn) {
      const timeoutMessage = (requested) =>
        `超时纪律：这次调用要求等 ${describeDuration(requested.ms)}（${requested.key}），已拒绝一次。` +
        '长等待是最后手段，不是「稳」的手段。请先按这个顺序想一遍：' +
        '1) 能不能**并发**——同一轮里独立的调用一起发，或用 subagent / workflow 并行分担；' +
        '2) 有没有**更快的等价做法**——缩小范围、只取需要的片段、换镜像/换接口、加 `--depth 1` / `-q` / 分页 / 条件重试；' +
        '3) 确实只能慢等，就把超时压到够用为止（`timeoutMs` 用秒级，不要分钟级），或改成后台 job 后继续做别的。' +
        '重发同一条调用即可（本条只拦截一次）。'
      ctx.effect(
        () =>
          safeGuard('timeout guard', (execution) => {
            const agent = execution.agent
            if (agent === undefined) return undefined
            const requested = requestedTimeoutMs(execution.arguments)
            if (requested === undefined) return undefined
            const state = supervisionOf(agent.id)
            const verdict = timeoutDecision({ requested, limit: TIMEOUT_LIMIT_MS, warned: state.timeoutWarned })
            if (verdict !== 'warn') return undefined
            state.timeoutWarned = true
            return timeoutMessage(requested)
          }),
        'project-docs: timeout guard',
      )
    }

    // Sleep discipline: the timeout guard above sees `timeoutMs` in the tool
    // arguments, but an agent that writes `sleep 60` inside the command has
    // decided to block in a way no parameter-level check can see. Refuse once,
    // pointing at polling / backgrounding instead.
    const sleepGuardOn = !(config !== null && typeof config === 'object' && config.sleepGuard === false)
    if (sleepGuardOn) {
      /** agentId -> already warned, so a repeated call goes through. */
      const sleepWarned = new Set()
      ctx.effect(
        () =>
          safeGuard('sleep guard', (execution) => {
            const agent = execution.agent
            if (agent === undefined) return undefined
            const name = typeof execution.name === 'string' ? execution.name : ''
            if (name.startsWith('project_docs')) return undefined
            if (agent.id !== undefined && sleepWarned.has(agent.id)) return undefined
            const verdict = sleepVerdict({ toolName: name, args: execution.arguments })
            if (verdict === null) return undefined
            if (agent.id !== undefined) sleepWarned.add(agent.id)
            return verdict.message
          }),
        'project-docs: sleep guard',
      )
      ctx.effect(
        () =>
          ctx.on('agent/disposed', (payload) => {
            const agent = payload === null || payload === undefined ? undefined : payload.agent
            if (agent === undefined || agent === null) return
            sleepWarned.delete(agent.id)
          }),
        'project-docs: sleep guard cleanup',
      )
    }

    // Question discipline: the guard cannot change how long ask_user_question
    // blocks — that wait is owned by the host tool — but it can make the
    // question cheaper to answer. A question with options costs one click; the
    // same question without options costs a paragraph of typing.
    const askGuardOn = !(config !== null && typeof config === 'object' && config.askGuard === false)
    if (askGuardOn) {
      /** agentId -> already warned, so a repeat attempt goes through. */
      const askWarned = new Set()
      ctx.effect(
        () =>
          safeGuard('ask guard', (execution) => {
            const agent = execution.agent
            if (agent === undefined) return undefined
            const name = typeof execution.name === 'string' ? execution.name : ''
            if (name !== 'ask_user_question') return undefined
            if (agent.id !== undefined && askWarned.has(agent.id)) return undefined
            const verdict = askVerdict(execution.arguments)
            if (verdict === null) return undefined
            if (agent.id !== undefined) askWarned.add(agent.id)
            return verdict.message
          }),
        'project-docs: ask guard',
      )
      ctx.effect(
        () =>
          ctx.on('agent/disposed', (payload) => {
            const agent = payload === null || payload === undefined ? undefined : payload.agent
            if (agent === undefined || agent === null) return
            askWarned.delete(agent.id)
          }),
        'project-docs: ask guard cleanup',
      )
    }
  }
}
