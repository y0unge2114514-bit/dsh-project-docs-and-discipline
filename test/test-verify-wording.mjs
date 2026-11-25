/**
 * 证据口径测试 —— 锁住「登记 ≠ 成立」这个说法，防止文案又漂回自证。
 *
 * WHY THIS EXISTS
 * ---------------
 * `verify_deliverable` 的实现里写死了 `provided: {}`，它只扫描你粘贴的证据
 * 文字里有没有出现 curl 响应行、文件大小、md5 这类**要素形状**，完全不核对
 * 内容真假。也就是说：一个把话说得漂亮但活没干的人，同样能登记通过。
 *
 * 这个短板不可能靠加正则修掉——合同可以伪造，机器判定不了。能做的只有
 * 两件事：把真实能力说清楚，并且别让输出替我宣布「可以汇报已完成了」。
 * 之前的渲染文案正是这么写的：「本轮可以据实汇报「已完成」了」。它把
 * 「我登记了证据」偷换成了「我被验证通过了」。
 *
 * 本测试断言四个面向都改成诚实的口径：
 *   1. 工具总描述（模型最先读到的地方）
 *   2. verify_deliverable 这个 action 的描述
 *   3. evidence 参数的描述
 *   4. execute 返回后的渲染文案（模型最容易照抄的一句）
 *   5. 纪律提示里的「交付要证据」条目
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

function fakeCtx() {
  const registered = new Map()
  const sections = []
  const routes = []
  return {
    ctx: {
      effect(fn) {
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
        if (service === 'agents') return { currentInitiator: () => undefined, list: () => [] }
        if (service === 'sessions') return { get: () => undefined }
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
        guard() {
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
      logger: { warn() {}, info() {}, error() {} },
    },
    registered,
    sections,
    routes,
  }
}

console.log('test-verify-wording.mjs')

const plugin = await import('../lib/index.js')

function writeToolOf() {
  const { ctx, registered } = fakeCtx()
  plugin.apply(ctx, {})
  const tool = registered.get('project_docs_write')
  assert.ok(tool, 'project_docs_write 未注册')
  return tool
}

/** 渲染一次 verify_deliverable 的返回值，拿到模型会看到的那段文字。 */
function renderVerification(tool) {
  const value = {
    action: 'verify_deliverable',
    project: 'demo',
    store_dir: 'D:/tmp/demo',
    verification: {
      target: 'https://example.test/app.js',
      summary: '示例交付',
      dimensions: ['request', 'file', 'env'],
      hash: 'hash-demo-1',
    },
  }
  const blocks = tool.output.render({}, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, 'render 必须返回非空数组')
  return blocks.map((block) => block.text ?? '').join('\n')
}

/* ------------------------------------------------- 1. 工具总描述 */

await test('工具总描述说明 verify_deliverable 只核对要素形状', async () => {
  const tool = writeToolOf()
  assert.ok(
    /registering evidence is not the same as proving|登记不等于|登记≠成立/i.test(tool.description),
    `工具描述仍把登记当成验证。当前描述片段：${tool.description.slice(0, 400)}`,
  )
  assert.ok(
    /shape|要素|形状/i.test(tool.description),
    '工具描述必须说明它只检查证据文字的「形状」，不核对真假',
  )
})

/* ------------------------------------- 2. action 与参数描述 */

await test('verify_deliverable 的 action 描述带「不等于成立」限定', async () => {
  const tool = writeToolOf()
  const actionDesc = String(tool.parameters.properties.action.description ?? '')
  assert.ok(
    /登记不等于|登记≠成立|not the same as proving/i.test(actionDesc),
    `action 描述缺限定语：${actionDesc.slice(0, 300)}`,
  )
})

await test('evidence 参数描述说明不校验真实性', async () => {
  const tool = writeToolOf()
  const evidenceDesc = String(tool.parameters.properties.evidence.description ?? '')
  assert.ok(
    /不校验|不核实|does not verify|cannot verify/i.test(evidenceDesc),
    `evidence 描述缺「不校验真实性」：${evidenceDesc.slice(0, 300)}`,
  )
})

/* --------------------------------------------------- 3. 渲染文案 */

await test('渲染文案不再替 Agent 宣布「可以汇报已完成」', async () => {
  const text = renderVerification(writeToolOf())
  assert.ok(
    text.includes('不等于证据成立'),
    `渲染文案缺「不等于证据成立」：${text}`,
  )
  assert.ok(
    !text.includes('可以据实汇报'),
    `渲染文案仍在替 Agent 宣布完成：${text}`,
  )
})

await test('渲染文案保留 examined 维度与 hash 便于追溯', async () => {
  const text = renderVerification(writeToolOf())
  assert.ok(text.includes('request') && text.includes('hash-demo-1'), `渲染丢了维度或 hash：${text}`)
})

/* ------------------------------------------------ 4. 纪律提示 */

await test('纪律提示的「交付要证据」条目带自陈限定', async () => {
  const { ctx, sections } = fakeCtx()
  plugin.apply(ctx, {})
  const discipline = sections.find((section) => section.name === 'project-docs-discipline')
  assert.ok(discipline, '纪律段未注入')
  const text = String(discipline.text ?? '')
  assert.ok(text.includes('登记不等于证据成立'), '纪律提示仍未说明登记不等于成立')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) {
    console.log(`\n${failure.name}\n${failure.error instanceof Error ? failure.error.stack : String(failure.error)}`)
  }
}

process.exit(failed > 0 ? 1 : 0)
