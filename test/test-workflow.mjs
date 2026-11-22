#!/usr/bin/env node
/**
 * test-workflow.mjs — 开发工作流（借鉴 obra/superpowers）专项验证
 *
 * 覆盖 2026-11-21 新增的两件事：
 * 1. workflowPrompt：默认给 systemPrompt 注册 project-docs-workflow 段（order 800），
 *    配 false 时不注册；文本与 WORKFLOW_PROMPT 一致。
 * 2. planGate：无计划的 agent 首次改动文件/命令时被拦一次并返回 PLAN_GATE_MESSAGE；
 *    已警告/已规划/只读工具/子代理都放行；计划可来自 tools/result 或会话日志重放。
 *
 * 用法：node test-workflow.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(__dirname, '..')
const tempStore = path.join(pluginDir, '.workflow-test-store')

let passed = 0
let failed = 0
function ok(name, cond) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`)
  }
}

function cleanup() {
  try {
    fs.rmSync(tempStore, { recursive: true, force: true })
  } catch {}
}

const { apply } = await import('../lib/index.js')
const { WORKFLOW_PROMPT, PLAN_GATE_MESSAGE } = await import('../lib/workflow.js')

/**
 * Build a fake ctx that records everything the two new mechanisms touch.
 */
function makeCtx({ storeDir, agents = [], sessions = {} }) {
  const events = new Map()
  const effectFns = []
  const sections = []
  const guards = []
  const on = (name, fn) => {
    if (!events.has(name)) events.set(name, [])
    events.get(name).push(fn)
  }
  const ctx = {
    get: (name) => {
      if (name === 'projectDocs') return { storeDir, config: {} }
      if (name === 'agents') return { list: () => agents, currentInitiator: () => ({ id: 'lead' }) }
      if (name === 'sessions') return { get: (id) => sessions[id] }
      if (name === 'systemPrompt') return { section: (s) => sections.push(s) }
      return undefined
    },
    on,
    effect: (fn) => {
      effectFns.push(fn)
    },
    tools: {
      register: () => {},
      guard: (fn) => {
        guards.push(fn)
      },
    },
    webServer: { register: () => {} },
    getOrigin: () => 'http://127.0.0.1:0',
  }
  return { ctx, events, effectFns, sections, guards }
}

/** Config that turns every other gate off so only the new mechanisms are observed. */
const BASE_CONFIG = {
  disciplineGuard: false,
  disciplineGuardMode: 'early',
  claimGuard: false,
  supervisor: false,
  requireDocsBeforeWrite: false,
  timeoutGuard: false,
  linkGuard: false,
  circuitBreaker: false,
  proofGate: false,
}

function runScenario(name, config, setup) {
  const env = setup()
  const { ctx, events, effectFns, sections, guards } = makeCtx(env)
  apply(ctx, { ...config, storeDir: env.storeDir })
  for (const fn of effectFns) {
    try {
      fn()
    } catch (e) {
      console.error(`  [${name}] effect error: ${e.message}`)
    }
  }
  return { sections, guards, events }
}

// ---------------------------------------------------------------- scenario A
// 默认：workflowPrompt 与 planGate 都开
const a = runScenario(
  'A',
  BASE_CONFIG,
  () => ({
    storeDir: tempStore,
    agents: [],
    sessions: {
      'agent-main': { header: { origin: 'main' }, ownEvents: () => [] },
      'agent-sub': { header: { origin: 'subagent' }, ownEvents: () => [] },
      'agent-hist': {
        header: { origin: 'main' },
        ownEvents: () => [
          {
            type: 'tool/call',
            data: { name: 'project_docs_write', arguments: { action: 'write_doc', project: 'demo' } },
          },
        ],
      },
    },
  }),
)

const workflowSection = a.sections.find((s) => s.name === 'project-docs-workflow')
ok('workflowPrompt 注册了 project-docs-workflow 段', workflowSection !== undefined)
ok('workflow 段 order 为 800（先于纪律段 900）', workflowSection?.order === 800)
ok('workflow 段文本与 WORKFLOW_PROMPT 一致', workflowSection?.text === WORKFLOW_PROMPT)
ok('WORKFLOW_PROMPT 含七步工作流关键词', /规划|测试先行|完成前验证/.test(WORKFLOW_PROMPT))

const guards = a.guards
ok('planGate 注册了 tools.guard', guards.length > 0)

const planGuard = guards.find((fn) => fn({ agent: { id: 'agent-main' }, name: 'write' }) === PLAN_GATE_MESSAGE)
ok('planGate 在无计划时拦截首次改动', planGuard !== undefined)

if (planGuard) {
  ok('planGate 同一 agent 只提醒一次（第二次放行）', planGuard({ agent: { id: 'agent-main' }, name: 'write' }) === undefined)
  ok('planGate 放行只读工具', planGuard({ agent: { id: 'agent-main' }, name: 'read' }) === undefined)
  ok('planGate 放行子代理', planGuard({ agent: { id: 'agent-sub' }, name: 'write' }) === undefined)
  ok('planGate 会话日志里已有计划则放行', planGuard({ agent: { id: 'agent-hist' }, name: 'write' }) === undefined)
} else {
  ok('planGate 行为（无守卫，跳过）', false)
  ok('planGate 只提醒一次', false)
  ok('planGate 放行只读工具', false)
  ok('planGate 放行子代理', false)
  ok('planGate 日志有计划放行', false)
}

// planGate 通过 tools/result 观测到计划
const resultHandlers = a.events.get('tools/result') || []
ok('planGate 挂载了 tools/result 观测', resultHandlers.length > 0)
for (const handler of resultHandlers) {
  try {
    handler(
      { agent: { id: 'agent-observed' }, name: 'project_docs_write', arguments: { action: 'append_doc', project: 'demo' } },
      { isError: false },
    )
  } catch (e) {
    console.error(`  [A] tools/result handler error: ${e.message}`)
  }
}
const afterObserve = guards.find((fn) => fn({ agent: { id: 'agent-observed' }, name: 'write' }) === PLAN_GATE_MESSAGE)
ok('planGate 观测到计划后不再拦截', afterObserve === undefined)

// ---------------------------------------------------------------- scenario B
// workflowPrompt: false
const b = runScenario('B', { ...BASE_CONFIG, workflowPrompt: false }, () => ({ storeDir: tempStore, agents: [], sessions: {} }))
ok('workflowPrompt:false 时不注册工作流段', !b.sections.some((s) => s.name === 'project-docs-workflow'))

// ---------------------------------------------------------------- scenario C
// planGate: false
const c = runScenario('C', { ...BASE_CONFIG, planGate: false }, () => ({ storeDir: tempStore, agents: [], sessions: {} }))
ok(
  'planGate:false 时不返回计划提醒',
  !c.guards.some((fn) => fn({ agent: { id: 'agent-x' }, name: 'write' }) === PLAN_GATE_MESSAGE),
)

cleanup()
console.log(`\n${passed} passed, ${failed} failed`)
// apply() 会注册定时器，强制退出避免挂住
process.exit(failed > 0 ? 1 : 0)
