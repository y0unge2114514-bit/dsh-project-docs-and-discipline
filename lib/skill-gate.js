/**
 * Discipline gates distilled from the deepseek-stack skills.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * aicodeking/deepseek-stack ships 29 `SKILL.md` files that describe good agent
 * behaviour: plan before coding, prove a fix by running the real check, stop
 * after repeated failures, keep a progress file, never weaken a test to pass.
 *
 * They share one weakness: they are **read, not enforced**. A model can load
 * `ds-verify-loop`, skip step 4 (read the actual error) and step 9 (paste the
 * output), and nothing notices. The skill says "do not claim without output";
 * nothing checks. That is exactly the gap this plugin exists to close, so the
 * rules below take the *checkable* subset of each skill and turn it into a
 * predicate over real tool calls.
 *
 * WHAT IS NOT HERE, AND WHY
 * -------------------------
 * The PR skills (`ds-ship`, `ds-ready`, `ds-pr`, `ds-watch-pr`, `ds-adopt`,
 * `ds-revive`, `ds-pr-comments`) assume a `gh` CLI and a GitHub PR workflow.
 * This workspace ships by pushing to `main`, so those rules have nothing to
 * check. The orchestration skills (`ds-jury`, `ds-best-of-n`, `ds-swarm`) need
 * multiple models or subagents and belong to the runtime, not to a guard. The
 * writing skills (`ds-unslop`, `ds-explain`, `ds-sharpen`, `ds-design*`) are
 * judgement calls a regex cannot make. Decisions per skill are recorded in
 * `docs/UPSTREAM-SKILLS.md`.
 *
 * @module @local/dsh-project-docs/skill-gate
 */

/**
 * Consecutive failing checks after which editing must stop.
 *
 * The upstream skill says 5. The user asked for 3, and 3 is the better number
 * here for a concrete reason: this plugin already trips a circuit breaker on
 * the *same* failure twice, so by the third failing check the agent is either
 * making progress (the error changed) or looping (it did not). Waiting for 5
 * buys two more failed edits and no new information.
 */
export const VERIFY_FAILURE_LIMIT = 3

/** Identical failures after which the premise must be tested (ds-unstick). */
export const UNSTICK_REPEAT_LIMIT = 2

/**
 * Distinct production files that trigger "show a plan first" (ds-plan-loop).
 *
 * Two is the skill's own threshold: a one-file fix needs no plan, and anything
 * touching a second file has a coordination cost the model should state.
 */
export const PLAN_THRESHOLD_FILES = 2

/**
 * Files whose modification counts as touching a test.
 *
 * Three naming conventions, because a repo usually has more than one:
 *   - a `test/` or `tests/` directory: `test/a.mjs`
 *   - a `test-` prefix:                  `test-kb.js`
 *   - a `.test.` / `.spec.` infix:       `src/x.test.ts`
 *
 * The first version missed the directory case and the infix case, which is the
 * difference between "protects your tests" and "silently lets them be gutted".
 */
const TEST_FILE = /(?:^|[\\/])(?:tests?[\\/][^\\/]+|[^\\/]*\.(?:test|spec)\.[^\\/]+|test[-_][^\\/]*)$/i

/** Extensions that carry production code, for the "test first" rule. */
const CODE_FILE = /\.(?:mjs|js|cjs|ts|tsx|jsx|py|go|rs|java|cs|rb|php)$/

/** Shell tools that can run a check. */
export const RUNNER_TOOLS = new Set(['ops_bash', 'pwsh', 'bash'])

/** Tools that mutate the working tree. */
export const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch'])

/**
 * Assertions that got weaker. Comparing before/after text is the only honest
 * signal available without parsing: a test file that loses `assert` calls or
 * gains `.skip` is almost certainly being bent to pass.
 */
const WEAKENING = [
  // `xit(` / `xdescribe(` 需要一个「不是标识符字符、也不是点」的前界。少了它，
  // `process.exit(` 的末尾就是 `xit(` —— 本仓库每套测试都以
  // `process.exit(failed > 0 ? 1 : 0)` 收尾，于是任何新建测试文件都会被判
  // 「跳过测试」，新建测试在这套门禁下不可能。真实事故，2026-11-22。
  { re: /\b(?:describe|it|test)\.skip\b|(?:^|[^.\w])(?:xit|xdescribe)\(/i, why: '跳过测试' },
  // `false` 只作为 assert.ok 的第二参数（失败消息）时才是「恒真」。原正则用
  // `[^)]*` 把「被测表达式」与「期望值」混在一起，`assert.equal(x, false)`
  // —— 断言 x 等于 false，最严格的断言之一 —— 也被读成恒真。
  { re: /\bassert\s*\.\s*ok\s*\([^)]*,\s*false\s*\)/i, why: '把断言改成恒真' },
  { re: /\breturn\s*;?\s*\/\/\s*(?:skip|disable)|process\.exit\(0\)\s*;?\s*\/\/\s*(?:force|skip)/i, why: '提前退出' },
  { re: /expect\([^)]*\)\.toBe(?:Truthy)?\(\s*true\s*\)/, why: '放宽 matcher' },
]

/** Was this path a test file? */
export function isTestFile(filePath) {
  return typeof filePath === 'string' && TEST_FILE.test(filePath)
}

/** Was this path production code? */
export function isCodeFile(filePath) {
  return typeof filePath === 'string' && CODE_FILE.test(filePath)
}

/**
 * Did a test-file edit make the suite weaker?
 *
 * @param {string} before  file content before the edit ('' when new)
 * @param {string} after   file content after the edit
 * @returns {{ weakened: boolean, why: string }}
 */
export function weakensTest(before, after) {
  const prev = typeof before === 'string' ? before : ''
  const next = typeof after === 'string' ? after : ''
  const count = (text, re) => (text.match(re) ?? []).length

  // 没有基准就谈不上「削弱」。新建测试文件（before 为空）本身就是在增加覆盖，
  // 无论它里面写了 process.exit 还是反向断言。
  if (prev.trim() === '') return { weakened: false, why: '' }

  for (const rule of WEAKENING) {
    if (count(next, rule.re) > count(prev, rule.re)) {
      return { weakened: true, why: rule.why }
    }
  }
  // Losing assertions is the subtler half of the same mistake.
  const assertionsBefore = count(prev, /\bassert(?:ion)?\s*\./g)
  const assertionsAfter = count(next, /\bassert(?:ion)?\s*\./g)
  if (assertionsBefore > 0 && assertionsAfter < assertionsBefore) {
    return {
      weakened: true,
      why: `断言从 ${assertionsBefore} 条减到 ${assertionsAfter} 条`,
    }
  }
  return { weakened: false, why: '' }
}

/**
 * Track failure counters per agent and decide when a run must stop.
 *
 * One instance per agent, held by the plugin. `record` is called on every tool
 * result; `shouldStop` is what the guard asks.
 */
export function createFailureTracker() {
  /** @type {Map<string, { checkFailures: number, lastFingerprint: string, repeats: number }>} */
  const byAgent = new Map()

  const stateOf = (agentId) => {
    let state = byAgent.get(agentId)
    if (state === undefined) {
      state = { checkFailures: 0, lastFingerprint: '', repeats: 0, lastStopAt: 0 }
      byAgent.set(agentId, state)
    }
    return state
  }

  return {
    /**
     * Record one finished tool call.
     *
     * @param {string} agentId
     * @param {{ failed: boolean, fingerprint?: string, ranCheck?: boolean }} outcome
     * @returns {{ verifyStop: boolean, unstickStop: boolean }}
     */
    record(agentId, outcome) {
      const state = stateOf(agentId)
      if (outcome.failed === true && outcome.ranCheck === true) {
        state.checkFailures += 1
      } else if (outcome.failed !== true && outcome.ranCheck === true) {
        state.checkFailures = 0
      }

      const fingerprint = typeof outcome.fingerprint === 'string' ? outcome.fingerprint : ''
      if (outcome.failed === true && fingerprint !== '') {
        if (fingerprint === state.lastFingerprint) state.repeats += 1
        else {
          state.lastFingerprint = fingerprint
          state.repeats = 1
        }
      } else if (outcome.failed !== true) {
        state.lastFingerprint = ''
        state.repeats = 0
      }

      return {
        verifyStop: state.checkFailures >= VERIFY_FAILURE_LIMIT,
        unstickStop: state.repeats >= UNSTICK_REPEAT_LIMIT,
      }
    },

    /** Read the counters without changing them. */
    peek(agentId) {
      const state = stateOf(agentId)
      return { checkFailures: state.checkFailures, repeats: state.repeats }
    },

    /** Clear after the agent has acknowledged (e.g. via trace_report). */
    reset(agentId) {
      byAgent.delete(agentId)
    },

    drop(agentId) {
      byAgent.delete(agentId)
    },
  }
}

/**
 * Does this command look like it runs a real check?
 *
 * The point of ds-verify-loop step 4 is "run the real command", so the tracker
 * only counts failures from commands that actually test something — otherwise a
 * failing `ls` would advance the stop counter.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function looksLikeCheck(command) {
  if (typeof command !== 'string' || command.trim() === '') return false
  return /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|check|lint|build|verify)|\bnode\s+--check\b|\bnode\s+\S*test|\bpytest\b|\bgo\s+test\b|\bcargo\s+(?:test|check|build)\b|\bdotnet\s+(?:test|build)\b|\btsc\b|\beslint\b|\bvitest\b|\bjest\b|\bmocha\b/i.test(command)
}

/**
 * Should this stop message be shown at all?
 *
 * Both stops are once-per-agent: repeating them every tool call turns a
 * discipline reminder into noise the model learns to skip.
 *
 * @param {object} input
 * @param {boolean} input.verifyStop
 * @param {boolean} input.unstickStop
 * @param {boolean} input.alreadyTold
 * @returns {{ tell: boolean, kind: 'verify'|'unstick'|null, message: string }}
 */
export function stopMessage({ verifyStop, unstickStop, alreadyTold }) {
  if (alreadyTold === true) return { tell: false, kind: null, message: '' }
  if (unstickStop === true) {
    return {
      tell: true,
      kind: 'unstick',
      message:
        `反馈循环纪律：同一个失败已经连续出现 ${UNSTICK_REPEAT_LIMIT} 次（来自 ds-unstick）。\n` +
        '现在停下来，不要再试同一思路的第三个变体。按这个顺序做：\n' +
        '1) 把每次尝试写成一行：改了什么 → 报错原文；\n' +
        '2) 写出这些尝试**共同的前提假设**（一句话）；\n' +
        '3) 用一个最便宜的探针直接验证那个假设（打印一行、grep 真实调用点、查版本），把结果贴出来；\n' +
        '4) 假设被证伪 → 真问题找到了，从新事实重新规划；假设成立 → 列 3 个**机制不同**的方案，各写一行成本与风险，选一个并说明理由；\n' +
        '5) 用 git 清掉失败尝试留下的残留，只应用选中的方案。\n' +
        '（本条只出现一次。）',
    }
  }
  if (verifyStop === true) {
    return {
      tell: true,
      kind: 'verify',
      message:
        `验证循环纪律：这个检查已经连续失败 ${VERIFY_FAILURE_LIMIT} 次（来自 ds-verify-loop）。\n` +
        '现在停止编辑，不要再改代码。要求：\n' +
        '1) 把最后一次的**完整错误输出**贴出来（第一条错误 + 文件行号 + 栈帧），不要只报最后一行；\n' +
        '2) 用一句话写出根因；写不出来就加一行 print/log 或去读失败的那段代码，然后重跑——**不要猜**；\n' +
        '3) 如果根因指向最初的设计假设，改用「先测假设」的流程（见 ds-unstick）；\n' +
        '4) 报告里说明：检查命令、失败轮数、当前卡在哪。\n' +
        '（本条只出现一次。）',
    }
  }
  return { tell: false, kind: null, message: '' }
}

/**
 * The "plan before you touch more than one file" rule (ds-plan-loop step 1).
 *
 * Deliberately narrow: only counts *distinct code files* the agent has written
 * in this turn. A single-file fix needs no plan; the moment a second file is in
 * play, the skill's own threshold is crossed.
 *
 * @param {Iterable<string>} files
 * @returns {{ needsPlan: boolean, count: number }}
 */
export function planThreshold(files) {
  const set = new Set()
  for (const file of files ?? []) {
    if (isCodeFile(file) && !isTestFile(file)) set.add(file)
  }
  return { needsPlan: set.size >= PLAN_THRESHOLD_FILES, count: set.size }
}

/**
 * Does this reply carry evidence, in the sense ds-verify-loop step 9 means?
 *
 * Not a general "did you paste output" check — that already exists as the
 * proof gate. This one is narrower: it looks for the *shape* of a command and
 * its result appearing together, which is what a verification claim needs.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function carriesRunEvidence(text) {
  const body = typeof text === 'string' ? text : ''
  if (body.trim() === '') return false
  const hasCommand = /(?:^|\n)\s*(?:[$>]|\$ )\s*\S+|```(?:bash|sh|powershell|pwsh|console)?/i.test(body)
  // "Result" means something a command actually produced: a pass/fail count, an
  // HTTP status, a byte size, a listing line, or an exit code. A directory
  // listing counts — `ls -l` output is as much evidence as "18 passed".
  const hasResult =
    /\b(?:passed|failed|ok\b|error|HTTP\/\d|exit\s+code|elapsed)\b/i.test(body) ||
    /\d+\s*(?:B|KB|KiB|MB|MiB|GB)\b/i.test(body) ||
    /(?:^|\n)\s*(?:-rw|drw|total\s+\d|total\s+\d+)/i.test(body)
  return hasCommand && hasResult
}
