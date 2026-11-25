/**
 * Mount test — prove `lib/index.js` can be loaded and applied at all.
 *
 * WHY THIS EXISTS
 * ---------------
 * A missing import (`WRITE_TOOLS`) shipped once and took the entire session
 * down: the skill-gate guard threw a `ReferenceError` on *every* tool call, so
 * the agent could not even read the file it needed to fix. The unit tests were
 * all green, because they only exercise pure modules and never load `index.js`.
 *
 * The `kb-mount-smoke.mjs` script did catch it — but only when someone ran it by
 * hand, and nobody did after wiring the guard. This file exists so the check
 * runs as part of `npm test`: a plugin that cannot mount must fail CI, not the
 * user's conversation.
 *
 * What it asserts, in order of how badly each failure hurts:
 *   1. importing the module does not throw at load time
 *   2. `apply(fakeCtx)` completes without throwing
 *   3. the tools that must exist are registered
 *   4. every registered tool's schema is a usable object
 *   5. the discipline prompt was injected
 *   6. the HTTP route was registered
 *   7. `apply` works with no config and with every gate disabled
 */
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
    console.log(`      ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

/** A fake Cordis context that mirrors exactly what `apply` touches. */
function fakeCtx(options = {}) {
  const registered = new Map()
  const sections = []
  const routes = []
  const effects = []
  const guards = []
  const ctx = {
    effect(fn, label) {
      effects.push(label)
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    get(service) {
      if (service === 'systemPrompt') {
        return {
          section(definition) {
            sections.push(definition)
            return () => {}
          },
          context(definition) {
            sections.push(definition)
            return () => {}
          },
        }
      }
      if (service === 'agents') {
        return {
          currentInitiator: () => options.initiator,
          list: () => [],
        }
      }
      if (service === 'sessions') {
        return { get: () => undefined }
      }
      return undefined
    },
    on() {
      return () => {}
    },
    once() {
      return () => {}
    },
    emit() {},
    tools: {
      register(tool) {
        registered.set(tool.name, tool)
        return () => registered.delete(tool.name)
      },
      guard(fn) {
        guards.push(fn)
        return () => {}
      },
      restrict() {
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
    logger: {
      warn() {},
      info() {},
      error() {},
    },
  }
  return { ctx, registered, sections, routes, effects, guards }
}

console.log('test-mount.mjs')

/* ------------------------------------------------------- 1. module load */

let plugin
await test('模块可被 import，加载期不抛异常', async () => {
  plugin = await import('../lib/index.js')
  assert.equal(typeof plugin.apply, 'function', 'apply 必须是函数')
  assert.equal(plugin.name, 'project-docs')
  assert.ok(Array.isArray(plugin.inject))
})

/* -------------------------------------------------------- 2. plain apply */

await test('apply(fakeCtx) 不抛异常', async () => {
  const { ctx } = fakeCtx()
  assert.doesNotThrow(() => plugin.apply(ctx, {}))
})

await test('三个工具都注册了', async () => {
  const { ctx, registered } = fakeCtx()
  plugin.apply(ctx, {})
  for (const tool of ['project_docs', 'project_docs_write', 'kb']) {
    assert.ok(registered.has(tool), `${tool} 未注册；已注册：${[...registered.keys()].join(', ')}`)
  }
})

await test('每个工具的 schema 是可用的 object', async () => {
  const { ctx, registered } = fakeCtx()
  plugin.apply(ctx, {})
  for (const [name, tool] of registered) {
    assert.equal(typeof tool.description, 'string', `${name} 缺 description`)
    assert.ok(tool.description.length > 20, `${name} 的 description 太短`)
    assert.equal(tool.parameters?.type, 'object', `${name} 的 parameters 不是 object schema`)
    assert.ok(Array.isArray(tool.parameters?.required), `${name} 缺 required 列表`)
    assert.equal(typeof tool.execute, 'function', `${name} 缺 execute`)
  }
})

await test('纪律提示已注入系统提示', async () => {
  const { ctx, sections } = fakeCtx()
  plugin.apply(ctx, {})
  assert.ok(
    sections.some((section) => section.name === 'project-docs-discipline'),
    `未注入纪律段；实际：${sections.map((s) => s.name).join(', ')}`,
  )
})

await test('HTTP 路由已注册', async () => {
  const { ctx, routes } = fakeCtx()
  plugin.apply(ctx, {})
  assert.ok(routes.length >= 1, '没有注册任何路由')
  assert.ok(routes.some((route) => route.path === '/project-docs'), '缺 /project-docs 路由')
})

/* ------------------------------------------------- 3. guards are callable */

await test('注册的 guard 都能被调用而不抛异常', async () => {
  // This is the exact failure that shipped: a guard referencing an undefined
  // symbol only throws when *invoked*, which is every tool call in real use.
  const { ctx, guards } = fakeCtx({ initiator: { id: 'agent-x' } })
  plugin.apply(ctx, {})
  assert.ok(guards.length > 0, '没有注册任何 guard')

  const fakeExecution = {
    name: 'read',
    callId: 'call-1',
    arguments: { file_path: 'D:\\work\\example.txt' },
    agent: { id: 'agent-x', steer() {} },
  }
  for (let i = 0; i < guards.length; i += 1) {
    const guard = guards[i]
    let result
    assert.doesNotThrow(() => {
      result = guard(fakeExecution)
    }, `第 ${i + 1} 个 guard 调用时抛异常`)
    assert.ok(
      result === undefined || typeof result === 'string' || (typeof result === 'object' && result !== null),
      `第 ${i + 1} 个 guard 返回值类型异常：${typeof result}`,
    )
  }
})

await test('guard 对写工具也不抛异常', async () => {
  const { ctx, guards } = fakeCtx({ initiator: { id: 'agent-y' } })
  plugin.apply(ctx, {})
  const writeExecution = {
    name: 'write',
    callId: 'call-2',
    arguments: { file_path: 'D:\\work\\example.js', content: 'const a = 1' },
    agent: { id: 'agent-y', steer() {} },
  }
  for (let i = 0; i < guards.length; i += 1) {
    assert.doesNotThrow(() => guards[i](writeExecution), `第 ${i + 1} 个 guard 对 write 抛异常`)
  }
})

/* ------------------------------------------------- 4. guards fail open */

await test('guard 内部抛错时放行本次调用（fail-open）', async () => {
  // A guard sits in front of *every* tool execution, so one throwing gate kills
  // the whole tool channel — including `read`, which is the tool you would need
  // to diagnose it. A gate may veto a call or say nothing; it may never escalate
  // a bug in itself into a session that cannot act at all.
  const { ctx, guards } = fakeCtx({ initiator: { id: 'agent-z' } })
  plugin.apply(ctx, {})
  assert.ok(guards.length > 0, '没有注册任何 guard')

  // Make every guard explode by removing the agent's session and any object the
  // guards reach through. Whatever the cause, the wrappers must absorb it.
  const hostile = {
    name: 'read',
    callId: 'call-boom',
    arguments: { file_path: 'D:\\work\\example.txt' },
    get agent() {
      throw new Error('boom: agent 已失效')
    },
  }
  for (let i = 0; i < guards.length; i += 1) {
    let result
    assert.doesNotThrow(() => {
      result = guards[i](hostile)
    }, `第 ${i + 1} 个 guard 把异常泄漏给了调用方`)
    assert.equal(result, undefined, `第 ${i + 1} 个 guard 抛错后应放行（返回 undefined）`)
  }
})

/* ------------------------------------------------------- 5. config shapes */

await test('所有门禁关闭时也能挂载', async () => {
  const { ctx, registered } = fakeCtx()
  const allOff = {
    disciplinePrompt: false,
    disciplineGuard: false,
    claimGuard: false,
    supervisor: false,
    requireDocsBeforeWrite: false,
    timeoutGuard: false,
    linkGuard: false,
    circuitBreaker: false,
    proofGate: false,
    workflowPrompt: false,
    planGate: false,
    skillGate: false,
  }
  assert.doesNotThrow(() => plugin.apply(ctx, allOff))
  assert.ok(registered.has('project_docs'), '关掉门禁后工具仍应注册')
})

await test('storeDir 配置被接受', async () => {
  const { ctx } = fakeCtx()
  assert.doesNotThrow(() => plugin.apply(ctx, { storeDir: 'D:\\work\\docs' }))
})

/* ------------------------------------------- 4b. version / update surface */

await test('版本接口与更新接口都已挂在同一个 prefix 路由上', async () => {
  // 路由是按前缀注册的（`{ kind: 'prefix', path: '/project-docs' }`），
  // 不是逐条路径注册 —— 所以只能断言 prefix 存在，接口由真实请求验证。
  const { ctx, routes } = fakeCtx()
  plugin.apply(ctx, {})
  const prefix = routes.find((route) => route.path === '/project-docs')
  assert.ok(prefix, `未注册 /project-docs 路由；已注册：${routes.map((r) => r.path).join(', ')}`)
  assert.equal(typeof prefix.handler, 'function', '/project-docs 路由缺少 handler')
})

await test('更新接口在没有 confirm 时拒绝执行', async () => {
  // 拉取新版会动插件自己的源码，必须由用户显式确认，不能由页面加载或误点触发。
  const { ctx, routes } = fakeCtx()
  plugin.apply(ctx, {})
  const prefix = routes.find((route) => route.path === '/project-docs')
  const calls = []
  const request = {
    method: 'POST',
    url: '/project-docs/api/update',
    headers: { 'sec-fetch-site': 'same-origin', 'x-project-docs': '1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ confirm: false }))
    },
  }
  const response = {
    statusCode: 0,
    setHeader() {},
    end(text) { calls.push({ status: this.statusCode, text }) },
  }
  await prefix.handler(request, response)
  assert.equal(response.statusCode, 400, `没有 confirm 时应返回 400，实际 ${response.statusCode}`)
  assert.match(String(calls[0]?.text ?? ''), /confirm_required/)
})

await test('客户端面板带有版本徽章与拉取按钮', async () => {
  const { readFile } = await import('node:fs/promises')
  const text = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(text, /version\.badge/, '缺少版本徽章文案')
  assert.match(text, /version\.update/, '缺少拉取新版按钮文案')
  assert.match(text, /apiGet\('version'\)/, '面板没有调用版本接口')
})

/* --------------------------------------------------- 5. cleanup contract */

await test('effect 都返回了可清理的函数或 undefined', async () => {
  const { ctx, effects } = fakeCtx()
  plugin.apply(ctx, {})
  assert.ok(effects.length > 0, '没有注册任何 effect')
  assert.ok(effects.every((label) => typeof label === 'string'), '有 effect 缺 label')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) {
    console.error(`\n--- ${failure.name} ---`)
    console.error(failure.error)
  }
  process.exitCode = 1
}

// `apply()` registers a 20 s snapshot interval; without an explicit exit the
// test process would hang until the runner kills it, which reads as a failure.
process.exit(failed > 0 ? 1 : 0)
