#!/usr/bin/env node
/**
 * Mount `index.js` against a fake Cordis context and exercise the `kb` tool.
 *
 * `node --check` only proves the file parses; the failure this catches is the
 * usual one — a tool that is defined but never registered, or registered with a
 * schema that throws on the first real call. The fake context mirrors the shape
 * `apply` actually touches (tools.register / systemPrompt.section / webServer),
 * so a registration bug shows up here instead of in the user's session.
 */
import * as plugin from '../lib/index.js'

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    process.stdout.write(`  ✓ ${name}\n`)
  } else {
    failed += 1
    process.stdout.write(`  ✗ ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
  }
}

const registered = new Map()
const sections = []
const effects = []
const routes = []

const ctx = {
  effect(fn, label) {
    effects.push(label)
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  // The real context is an event emitter; `apply` subscribes to agent lifecycle
  // events for the discipline guard. Returning a disposer is all it needs.
  on() {
    return () => {}
  },
  once() {
    return () => {}
  },
  emit() {},
  get(service) {
    if (service === 'systemPrompt') {
      return {
        section(options) {
          sections.push(options)
          return () => {}
        },
      }
    }
    return undefined
  },
  tools: {
    register(tool) {
      registered.set(tool.name, tool)
      return () => registered.delete(tool.name)
    },
    // The real registry exposes a guard hook for the discipline / evidence
    // gates. This harness does not exercise gating, so it only needs to accept
    // the subscription.
    guard() {
      return () => {}
    },
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
    getOrigin() {
      return 'http://127.0.0.1:0'
    },
  },
}

const storeDir = process.env.KB_TEST_STORE || undefined

plugin.apply(ctx, storeDir === undefined ? {} : { storeDir })

process.stdout.write('插件挂载冒烟\n\n')
check('project_docs 已注册', registered.has('project_docs'))
check('project_docs_write 已注册', registered.has('project_docs_write'))
check('kb 已注册', registered.has('kb'), [...registered.keys()].join(', '))

const kbTool = registered.get('kb')
if (kbTool !== undefined) {
  check('kb 有 description', typeof kbTool.description === 'string' && kbTool.description.length > 40)
  check('kb parameters 是 object schema', kbTool.parameters && kbTool.parameters.type === 'object')
  check(
    'kb parameters 声明了全部 action',
    Array.isArray(kbTool.parameters.properties?.action?.enum) && kbTool.parameters.properties.action.enum.length >= 10,
    String(kbTool.parameters.properties?.action?.enum?.length),
  )
}

check(
  '纪律提示已注入系统提示',
  sections.some((section) => section.name === 'project-docs-discipline'),
  sections.map((section) => section.name).join(', '),
)
const discipline = sections.find((section) => section.name === 'project-docs-discipline')
check(
  '纪律提示包含统一信息库条款',
  discipline !== undefined && discipline.text.includes('统一信息库') && discipline.text.includes('record_change'),
)
check('HTTP 路由已注册', routes.length >= 1, String(routes.length))

process.stdout.write(`\n结果：${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
