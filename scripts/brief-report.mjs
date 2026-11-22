#!/usr/bin/env node
/**
 * Render the handoff brief against the REAL document store.
 *
 * A unit test proves the rules; this proves the rules meet actual data. The
 * projects below are read-only — nothing is written, no claim is taken. If a
 * brief looks wrong here, it would look wrong in the first prompt of a session.
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildBrief, renderBrief } from '../lib/handoff-brief.js'

const STORE = process.env.DSH_DOCS_STORE || ''
const PROJECTS = path.join(STORE, 'projects')

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function listEntries(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .map((name) => readJson(path.join(dir, name)))
    .filter((entry) => entry !== undefined)
}

function activeClaims(projectId) {
  const now = Date.now()
  return listEntries(path.join(PROJECTS, projectId, 'claims'))
    .filter((claim) => Number.isFinite(Date.parse(claim.expiresAt ?? '')) && Date.parse(claim.expiresAt) > now)
}

const now = Date.now()
const rows = []

for (const projectId of fs.readdirSync(PROJECTS).sort()) {
  const stat = fs.statSync(path.join(PROJECTS, projectId))
  if (!stat.isDirectory()) continue
  const messages = listEntries(path.join(PROJECTS, projectId, 'board', 'agent')).slice(0, 20)
  const claims = activeClaims(projectId)
  const rendered = renderBrief(
    buildBrief({ projectId, messages, claims, selfLabel: '(新会话)', now }),
  )
  if (rendered !== '') rows.push({ projectId, rendered })
}

console.log(`真实文档库：${STORE}`)
console.log(`有接手状态的项目：${rows.length} / ${fs.readdirSync(PROJECTS).length}\n`)

for (const row of rows) {
  console.log('─'.repeat(70))
  console.log(row.rendered)
  console.log(`  [字符数 ${row.rendered.length}]`)
}

const empty = fs.readdirSync(PROJECTS).filter((id) => {
  const stat = fs.statSync(path.join(PROJECTS, id))
  if (!stat.isDirectory()) return false
  return !rows.some((row) => row.projectId === id)
})
if (empty.length > 0) {
  console.log('\n没有接手状态（新项目 / 无历史）：')
  console.log('  ' + empty.join('、'))
}

const total = rows.reduce((sum, row) => sum + row.rendered.length, 0)
console.log(`\n合计 ${total} 字符。单个项目最长 ${Math.max(0, ...rows.map((r) => r.rendered.length))} 字符。`)
