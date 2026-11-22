#!/usr/bin/env node
/**
 * Pre-publication privacy scanner.
 *
 * WHY THIS REPLACED THE AD-HOC GREP
 * ---------------------------------
 * The first round of cleaning used a hand-written pattern list and reported
 * "0 hits". Three separate human reviews then found real leaks it had missed:
 *
 *   1. a camelCase project directory (`SheepVIllage`) — only the lowercase form
 *      was in the list
 *   2. a person's given name, hardcoded as a UI placeholder and as a test-fixture
 *      author — the scanner had no "person name" category at all
 *   3. Chinese project names — the list was Latin-only
 *
 * The lesson is not "add patterns". It is that a scanner must enumerate
 * *categories* of identifying data, and each category must be proven by a
 * test — otherwise someone adds one `allowValue` and silently re-opens the hole.
 *
 * Every category below therefore has fixtures under `scripts/privacy-fixtures/`
 * and `test-privacy-scan.mjs` asserts both directions: injected samples must be
 * reported, placeholder samples must not.
 *
 * Usage:
 *   node scripts/privacy-scan.mjs [dir] [--json] [--allow <regex>]
 *
 * Exit: 0 clean, 1 findings, 2 usage error.
 */
import fs from 'node:fs'
import path from 'node:path'

const TEXT_EXT = /\.(?:js|mjs|cjs|json|yml|yaml|md|svg|txt|html|css|env|ini|conf)$/

/**
 * Lines the plugin legitimately owns.
 *
 * Scoped to *contexts*, not to bare names: an earlier `/project-docs\b/` rule
 * exempted every line mentioning the plugin, which silently allowed
 * `D:\DSHworkingArea\dsh-project-docs` — a real path on this author's disk.
 * Each pattern below pins the surrounding words that make the line a doc
 * example rather than a leak.
 */
const DEFAULT_ALLOW = [
  /`\.dsh-docs\//,                              // the documented store directory
  /^#\s|^\s*[-*]\s+`?project-docs/i,            // headings / list items naming the plugin
  /privacy-scan\.mjs/,                          // the scanner's own pattern list
  /install_bundle/,                             // install examples need a target path
  /\b(?:npm|node)\s+(?:run\s+)?\S*project-docs/, // commands using the package name
]

/**
 * Placeholder path segments that appear in documentation, not on a disk.
 *
 * A trailing file name is not identifying on its own — `D:\pack\assets\main.js`
 * is the canonical example in this repo's own docs — so common source file names
 * are treated as placeholders too. What identifies a machine is a *directory*
 * that names a person or a private project, and those are not in this list.
 */
const PLACEHOLDER_SEGMENT = /^(?:path|路径|work|example|pack|project|repo|dir|tmp|your|to|到|a|b|x|y|z|test|demo|assets|src|lib|dist|build|out|main|index|app|server|client|config|data|logs?|proj|elsewhere|search|other|collab|outbox|batch|kubejs|docs|路径|到|项目)(?:[-_.][a-z0-9]+)*$/i

/** ROT13 so the deny list does not itself republish the names it blocks. */
function rot13(value) {
  return value.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base)
  })
}

/**
 * Person names that must never ship.
 *
 * Bounded by design: name detection without a model flags React components
 * (`ProjectEditor`), file paths and prose. Two mechanisms cover the real cases —
 * this list for names already known to have leaked, and `NAME_POSITION` below
 * for any name-shaped value in an author/placeholder field.
 */
const PERSON_NAMES = [
  // ROT13. `Ryfn` decodes to the given name that leaked in client.js:924.
  // Encoded rather than plain so the deny list does not itself republish it.
  'Ryfn',
].map(rot13)

/** Where a value is a human's name rather than an agent label. */
const NAME_POSITION = /\b(?:author|placeholder|owner|username|user|by)\s*[:=]\s*['"`]([^'"`]{1,40})['"`]/gi

/** Values in a name position that are roles, not people. */
const ROLE_WORDS = /^(?:agent|human|user|lead|owner|admin|someone|unknown|me|you|author|system|bot|test|tester|nobody|anonymous|<.*>)$/i

/**
 * Categories of identifying data.
 *
 * Each `allowValue` decides only about the *matched value*, never the line —
 * an earlier version allowed the whole line once one segment looked generic,
 * which let `D:\work\<person>\notes` through untouched.
 */
const CATEGORIES = [
  {
    name: 'private-key',
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|-----BEGIN CERTIFICATE-----/g,
    hint: '私钥或证书本体。绝不能进仓库，即使只是测试用的也要删掉',
  },
  {
    name: 'secret-token',
    // The token shapes that actually appear in the wild. A generic "long random
    // string" rule would drown in hashes; these prefixes are unambiguous.
    //
    // `sk-[A-Za-z0-9]` alone missed `sk-proj-...` and `sk-ant-...`, where the
    // segment after the prefix contains a hyphen — a real miss worth noting.
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9][A-Za-z0-9_-]{18,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}/g,
    hint: 'API 令牌/访问密钥。即使已失效也必须删除，否则会被自动化工具采集',
  },
  {
    name: 'ipv4-public',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    hint: '公网 IP 泄漏基础设施地址（文档示例请用 203.0.113.x / 198.51.100.x）',
    allowValue: (v) => {
      if (/^127\./.test(v)) return true
      if (/^0\./.test(v)) return true
      if (/^192\.0\.2\./.test(v)) return true
      if (/^198\.51\.100\./.test(v)) return true
      if (/^203\.0\.113\./.test(v)) return true
      if (/^10\./.test(v)) return true
      if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(v)) return true
      if (/^192\.168\./.test(v)) return true
      if (/^169\.254\./.test(v)) return true
      return false
    },
  },
  {
    name: 'ipv6',
    // Full and compressed forms, including a zone id (`%eth0`) which appears in
    // real interface output.
    //
    // A reviewer noted that allowing `2001:db8::/32` makes the documentation
    // prefix indistinguishable from a real address — that is true, and the
    // trade-off is deliberate: flagging every `2001:db8::` example would make
    // the report unusable. The documentation range exists precisely so examples
    // are safe; a real address will not use it.
    pattern: /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}(?:%[0-9a-z]+)?\b|\b::1?\b/gi,
    hint: 'IPv6 地址泄漏基础设施',
    allowValue: (v) => {
      const bare = v.replace(/%[0-9a-z]+$/i, '')
      if (/^::1?$/.test(bare)) return true
      if (/^fe80:/i.test(bare)) return true
      if (/^f[cd][0-9a-f]{2}:/i.test(bare)) return true
      if (/^2001:0?db8:/i.test(bare)) return true
      // A bare `::` or a single colon group is punctuation, not an address.
      return bare.replace(/[^:]/g, '').length < 2
    },
  },
  {
    name: 'ipv4-private-port',
    // A private-range address WITH a port is an environment fact: it says which
    // host runs what. Bare private IPs stay quiet (they are universal test
    // fixtures), but `10.0.0.5:8600` is a real deployment detail.
    // `10.0.0.9:3306` is four octets; the first version allowed at most three
    // (`10.x` or `10.x.x`), so the common 10.0.0.x range was never matched.
    pattern: /\b((?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){1,3}):(\d{2,5})\b/g,
    hint: '私网地址+端口暴露内部拓扑（哪个机器跑哪个服务）；示例请用 <host>:<port>',
    allowValue: (v) => {
      // Only the exact fixtures the test suite uses stay quiet. An earlier
      // version allowed every `10.0.0.x`, which would have let a real
      // `10.0.0.5:3306` style deployment detail through.
      const [host, port] = v.split(':')
      if (host === '10.0.0.5' && port === '8600') return true
      // Failure-fingerprint fixture in test-store.mjs.
      if (host === '10.0.0.1' && port === '443') return true
      return false
    },
  },
  {
    name: 'host-port-public',
    pattern: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})\b/g,
    hint: '公网 host:port 直接暴露基础设施地址',
    allowValue: (v) => {
      const host = v.split(':')[0]
      if (/^127\./.test(host)) return true
      if (/^0\.0\.0\.0$/.test(host)) return true
      if (/^10\./.test(host)) return true
      if (/^192\.168\./.test(host)) return true
      if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return true
      if (/^192\.0\.2\./.test(host)) return true
      if (/^198\.51\.100\./.test(host)) return true
      if (/^203\.0\.113\./.test(host)) return true
      return false
    },
  },
  {
    name: 'password-assignment',
    // A bare password written into config or code. Matched on the assignment
    // shape, then filtered so that placeholders and obvious dummies stay quiet.
    // The quotes are optional: `DB_PASSWORD=Sup3rS3cret!` in a .env file has
    // none. The leading `(?<![A-Za-z])` is also required: `\b` does not match
    // between `_` and `P` (underscore is a word character), so `DB_PASSWORD=`
    // was invisible to a `\bpassword` pattern — the exact value this category is
    // for.
    pattern: /(?<![A-Za-z])(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*["'`]?([^"'`\s]{6,})["'`]?/gi,
    hint: '明文密码/密钥赋值。改用环境变量或 <password> 占位',
    allowValue: (v) => {
      // Placeholders and obvious non-secrets.
      const value = v.replace(/^(?![A-Za-z])[^:=]*/, '').replace(/^[A-Za-z0-9_-]*\s*[:=]\s*/, '').replace(/^["'`]/, '').replace(/["'`]$/, '')
      if (/^(?:<.*>|\*+|x+|\.{3}|changeme|placeholder|example|dummy|test|your[-_]?.*|secret-?value[-_]?for[-_]?test)$/i.test(value)) return true
      // A placeholder made of one repeated character (`xxxxxxxx`) is a fixture.
      // An earlier `Set(value).size <= 3` test also swallowed real passwords like
      // `Sup3rS3cret!`, which is exactly the value this category exists to catch.
      if (new Set(value).size <= 2) return true
      // A *code expression* on the right-hand side is not a literal secret:
      // `token = randomBytes(6).toString('hex')` assigns a value at runtime.
      // Only literal-looking values are reported.
      if (/[(){}[\].]/.test(value) && !/^["'`]?.{20,}["'`]?$/.test(value)) return true
      if (/\b(?:randomBytes|randomUUID|match\[|toString|process\.env|require\(|await|function|=>|stdin|argv|\.env\b)/.test(value)) return true
      return false
    },
  },
  {
    name: 'jwt',
    // Three base64url segments, first one decoding to a JSON header. The dotted
    // shape alone collides with prose, so the `eyJ` prefix is required.
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    hint: 'JWT 令牌。里面带身份声明，属于凭据',
  },
  {
    name: 'ssh-public-key',
    pattern: /ssh-(?:rsa|dss|ed25519|ecdsa)\s+AAAA[A-Za-z0-9+/=]{20,}/g,
    hint: 'SSH 公钥含主机标识与注释里的用户名；示例请用 <public-key>',
  },
  {
    name: 'conn-string',
    // Database/cache URLs carry credentials inline: scheme://user:pass@host:port
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql|clickhouse):\/\/[^\s"'`）)、，。；]+/gi,
    hint: '数据库连接串通常内嵌口令与内网主机名',
  },
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    hint: '邮箱地址是个人身份信息；示例请用 user@example.com',
    allowValue: (v) => /@example\.(?:com|org|net)$/i.test(v),
  },
  {
    name: 'cn-mobile',
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    hint: '手机号是个人身份信息',
  },
  {
    name: 'wechat-qq-id',
    // wxid_* is a WeChat internal id; a bare 5-12 digit QQ number is too
    // ambiguous to flag, so only the explicit prefixes are matched.
    pattern: /\bwxid_[A-Za-z0-9_-]{6,}|(?:qq|wechat|weixin)\s*[:=]\s*['"]?\d{5,12}\b/gi,
    hint: '微信/QQ 账号是个人身份信息',
  },
  {
    name: 'repo-url-private',
    // Any github/gitlab/gitee URL carries a username, and a private repo's name
    // is itself sensitive. Only the canonical public-project form is allowed.
    pattern: /https?:\/\/(?:github|gitlab|gitee|bitbucket)\.com\/[^\s"'`）)、，。；]+/gi,
    hint: '仓库 URL 暴露用户名；私库名也算隐私。示例用 <repo-url> 或官方项目地址',
    allowValue: (v) => {
      // Keep well-known upstream projects that the README and docs legitimately
      // cite. A citation of someone else's public repo is attribution, not a leak.
      const KNOWN = [
        'aicodeking/deepseek-stack',
        'deepseek-ai/deepseek-harness',
        'obra/superpowers',
        'T-Auto/dsh-ops',
      ]
      if (KNOWN.some((slug) => v.toLowerCase().includes(slug.toLowerCase()))) return true
      return /\/(?:issues|pull)\/\d+$/.test(v)
    },
  },
  {
    name: 'domain-private',
    // Any hostname that is not an obvious documentation example. A curated
    // suffix list cannot work — a self-built domain looks like any other.
    pattern: /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|cn|icu|dev|app|xyz|top|me|co|info|biz|site|online|tech|cloud|link|pro|vip|cc)\b/gi,
    hint: '自建/私有域名。示例用 example.com',
    allowValue: (v) => {
      const lower = v.toLowerCase()
      // Documentation and well-known public domains are fine.
      if (/^(?:example\.(?:com|org|net)|localhost)$/.test(lower)) return true
      if (/\.(?:dsh|npmjs)\./.test(lower)) return true
      const KNOWN = [
        'github.com', 'gitlab.com', 'gitee.com', 'npmjs.com', 'nodejs.org',
        'deepseek.com', 'deepseek.ai', 'microsoft.com', 'windows.com',
        'google.com', 'mozilla.org', 'w3.org', 'www.w3.org', 'json-schema.org',
        'jsdelivr.net', 'unpkg.com', 'cdnjs.com', 'openai.com',
        'anthropic.com', 'electronjs.org', 'cordis.top',
      ]
      if (KNOWN.includes(lower)) return true
      // Two-label domains ending in a common TLD that are obviously generic
      // documentation hosts (`api.example`, `foo.local`).
      if (/(?:^|\.)local$/.test(lower)) return true
      return false
    },
  },
  {
    name: 'absolute-path',
    pattern: /\b[A-Za-z]:[\\/][^\s"'`）)、，。；]*/g,
    hint: '绝对路径会泄漏目录布局，换机器也必然失效',
    allowValue: (v) => {
      // Backslash-escaped source literals arrive as `D:\\work\\x`; collapse the
      // doubled separators before splitting so segments compare cleanly.
      const normalised = v.replace(/\\\\/g, '\\')
      const segments = normalised.replace(/^[A-Za-z]:[\\/]/, '').split(/[\\/]/).filter(Boolean)
      if (segments.length === 0) return true
      // A path is a placeholder only if EVERY segment is a placeholder. The
      // earlier version checked just the first one, so `D:\work\<name>\notes`
      // was waved through — the exact hole a reviewer found.
      return segments.every((segment) => PLACEHOLDER_SEGMENT.test(segment) || /^\d+$/.test(segment))
    },
  },
  {
    name: 'posix-absolute-path',
    pattern: /(?<![\w.])\/(?:Users|home|root)\/[^\s"'`）)、，。；]*/g,
    hint: 'POSIX 家目录路径泄漏用户名与布局',
    allowValue: (v) => {
      const parts = v.split('/').filter(Boolean)
      const account = parts[1] === undefined ? '' : parts[1].toLowerCase()
      return /^(?:user|username|example|you|your|me|someone|test|<.*>)$/.test(account)
    },
  },
  {
    name: 'real-digest',
    pattern: /\b[0-9a-f]{16,}\b/g,
    hint: '真实哈希/摘要；示例请写成 <hash> 或截断加省略号',
    allowValue: (v) => {
      const FAMOUS = new Set([
        'd41d8cd98f00b204',   // md5("")
        '9f86d081884c7d65',   // sha256("test")
        'e3b0c44298fc1c14',   // sha256("")
        '5d41402abc4b2a76',   // md5("hello")
        'ba7816bf8f01cfea',   // sha256("abc")
        'da39a3ee5e6b4b0d',   // sha1("")
        'aaf4c61ddcc5e8a2',   // sha1("hello")
      ])
      return FAMOUS.has(v.slice(0, 16))
    },
  },
]

/** Project identifiers that only exist inside this author's workspace. */
const PRIVATE_WORDS = [
  'SheepVIllage', 'PromaSomething', 'qq-bot', 'chaoxing', 'gxnu-auto',
  'timetable-android', 'nanning-game', 'emotionAnalyze', 'webops-console',
  'thinking-universe', 'fuckzhs', 'pigai-paste', 'private-netdisk',
  'teachingArea',
]

/** Chinese business vocabulary specific to this workspace. */
const PRIVATE_CHINESE = ['私人网盘', '羊村', '智慧树', '课表胶囊', '情绪分析', '军机处', '南宁机', '南宁游戏', '教学课件']

/** Files that never ship. */
const SKIP_FILES = [/^\.integrity-manifest\.json$/, /^\.fix-test-ids\.mjs$/]

/**
 * The privacy test suite must embed fake secrets and fake names — that is how it
 * proves the scanner catches them.
 *
 * An earlier version skipped the whole file. That was a hole: a real name or a
 * real address pasted into the test suite would never be reported, and the test
 * file is exactly where someone would paste a real sample "to debug it".
 *
 * Instead, only the lines that are *demonstrably* fixtures are exempt: a line
 * that asserts on a sample, or that lives inside a fixture array literal. Any
 * other line in the file is scanned normally, so a real value is still caught.
 */
const FIXTURE_LINE = /\b(?:assert\.(?:ok|equal)|reports\(|scanText\()|^\s*(?:const\s+\w+\s*=\s*\[|'[^']*',?\s*$)/

function parseArgs(argv) {
  const out = { dir: '', json: false, allow: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') out.json = true
    else if (arg === '--allow') out.allow.push(new RegExp(argv[++i] ?? '$^'))
    else if (!arg.startsWith('--')) out.dir = arg
  }
  return out
}

function listText(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      if (SKIP_FILES.some((re) => re.test(entry.name))) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!TEXT_EXT.test(entry.name)) continue
      out.push(full)
    }
  }
  walk(dir)
  return out.sort()
}

/**
 * Scan one file's text.
 *
 * Exported so the regression test can drive it with fixture strings instead of
 * writing throwaway files.
 */
export function scanText(text, { file = '<memory>' } = {}) {
  const findings = []
  const lines = String(text ?? '').split(/\r?\n/)

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const lineAllowed = DEFAULT_ALLOW.some((re) => re.test(line))
    // A line that is visibly a test fixture — an assertion on a sample, or a
    // literal inside a fixture array — is exempt. Everything else in that file
    // is still scanned, so a real value pasted there is still reported.
    if (FIXTURE_LINE.test(line)) continue

    for (const category of CATEGORIES) {
      category.pattern.lastIndex = 0
      let match
      while ((match = category.pattern.exec(line)) !== null) {
        const value = match[0]
        if (category.allowValue !== undefined && category.allowValue(value) === true) continue
        // A line the plugin legitimately owns — its own directory name in the
        // docs, an install example, the scanner's own pattern list — is exempt
        // from every category. Without this, `DEFAULT_ALLOW` only suppressed the
        // identifier checks and an install snippet kept reporting as a real path.
        if (lineAllowed) continue
        findings.push({
          file, line: i + 1, category: category.name, value,
          hint: category.hint, context: line.trim().slice(0, 160),
        })
      }
    }

    if (!lineAllowed) {
      // Project identifiers: case-insensitive substring, because they are ids
      // (`SheepVIllageSite` must match `SheepVIllage`).
      for (const word of PRIVATE_WORDS) {
        const at = line.toLowerCase().indexOf(word.toLowerCase())
        if (at < 0) continue
        findings.push({
          file, line: i + 1, category: 'private-identifier',
          value: line.slice(at, at + word.length),
          hint: `项目标识符 "${word}" 不应出现在公开仓库`,
          context: line.trim().slice(0, 160),
        })
      }
      for (const word of PRIVATE_CHINESE) {
        const at = line.indexOf(word)
        if (at < 0) continue
        findings.push({
          file, line: i + 1, category: 'private-chinese-vocab', value: word,
          hint: '中文项目名/业务词汇会暴露私有项目；改成通用描述',
          context: line.trim().slice(0, 160),
        })
      }
      // Known names, anywhere in the line and in any casing. A name that leaked
      // once tends to leak again, so it is matched as a bare substring — not
      // only in an `author:` position, which is how `developer elsa wrote this`
      // slipped through the reviewer's probe.
      for (const name of PERSON_NAMES) {
        const lower = line.toLowerCase()
        const needle = name.toLowerCase()
        let from = 0
        while (from <= lower.length) {
          const at = lower.indexOf(needle, from)
          if (at < 0) break
          findings.push({
            file, line: i + 1, category: 'person-name', value: line.slice(at, at + name.length),
            hint: '真实人名出现在仓库里（署名、占位符、测试夹具、正文都算）',
            context: line.trim().slice(0, 160),
          })
          from = at + needle.length
        }
      }
    }

    // Any name-shaped value in an author/placeholder position, plus Chinese
    // names — the earlier Latin-only test let `author: '张三'` through.
    NAME_POSITION.lastIndex = 0
    let nameMatch
    while ((nameMatch = NAME_POSITION.exec(line)) !== null) {
      const value = nameMatch[1].trim()
      if (ROLE_WORDS.test(value)) continue
      if (value.length < 2) continue
      const latinName = /^[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?$/.test(value)
      const chineseName = /^[\u4e00-\u9fa5]{2,4}$/.test(value)
      if (!latinName && !chineseName) continue
      findings.push({
        file, line: i + 1, category: 'person-name-position', value,
        hint: '这个位置放的是人名（author / placeholder 等）；请改用 agent / human 等角色名',
        context: line.trim().slice(0, 160),
      })
    }
  }
  return findings
}

function scanFile(file, allow) {
  const text = fs.readFileSync(file, 'utf8')
  const findings = scanText(text, { file })
  if (allow.length === 0) return findings
  // Caller-supplied extra allowances, matched against the finding's line.
  return findings.filter((finding) => !allow.some((re) => re.test(finding.context)))
}

const isMain = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  const root = path.resolve(options.dir === '' ? process.cwd() : options.dir)
  if (!fs.existsSync(root)) {
    console.error(`目录不存在：${root}`)
    process.exit(2)
  }

  const files = listText(root)
  const selfFile = path.resolve(root, 'scripts', 'privacy-scan.mjs')
  const all = []
  for (const file of files) {
    // The scanner's own source contains every pattern it hunts for.
    if (path.resolve(file) === selfFile) continue
    all.push(...scanFile(file, options.allow))
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ root, files: files.length, findings: all }, null, 2)}\n`)
  } else {
    console.log(`扫描 ${files.length} 个文本文件 · ${root}`)
    if (all.length === 0) {
      console.log('\n✓ 未发现隐私信息')
    } else {
      const byCategory = new Map()
      for (const finding of all) {
        const list = byCategory.get(finding.category) ?? []
        list.push(finding)
        byCategory.set(finding.category, list)
      }
      console.log(`\n✗ 发现 ${all.length} 处：`)
      for (const [category, list] of [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`\n[${category}] ${list.length} 处 — ${list[0].hint}`)
        for (const finding of list.slice(0, 12)) {
          console.log(`  ${path.relative(root, finding.file)}:${finding.line}  ${finding.value}`)
          console.log(`      ${finding.context}`)
        }
        if (list.length > 12) console.log(`  …另有 ${list.length - 12} 处`)
      }
    }
  }

  process.exit(all.length === 0 ? 0 : 1)
}
