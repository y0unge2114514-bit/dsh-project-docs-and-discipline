/**
 * Regression tests for the privacy scanner.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A reviewer's summary of three review rounds: the scanner reported "0 hits"
 * while a person's real name sat in a UI placeholder, and later while genuine
 * blind spots remained (private keys, tokens, IPv6, repo URLs, Chinese names).
 *
 * The scanner is a security control that protects a one-way door: once a secret
 * is pushed to a public repo it must be considered compromised. So its rules get
 * tests in BOTH directions — every sample that must be caught, and every
 * placeholder that must stay quiet. A future `allowValue` that re-opens a hole
 * will fail this suite instead of failing a human reviewer.
 */
import assert from 'node:assert/strict'
import { scanText } from '../scripts/privacy-scan.mjs'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`FAIL  ${name}`)
    console.log(`      ${error.message.split('\n')[0]}`)
  }
}

/** Does scanning this text report at least one finding of the given category? */
function reports(text, category) {
  const findings = scanText(text)
  return category === undefined ? findings.length > 0 : findings.some((f) => f.category === category)
}

console.log('test-privacy-scan.mjs')

/* ---------------------------------------------------------------- must catch */

test('私钥与证书（最该拦的一类）', () => {
  assert.ok(reports('-----BEGIN RSA PRIVATE KEY-----', 'private-key'))
  assert.ok(reports('-----BEGIN OPENSSH PRIVATE KEY-----', 'private-key'))
  assert.ok(reports('-----BEGIN CERTIFICATE-----', 'private-key'))
})

test('明文密码赋值（含 .env 无引号写法）', () => {
  assert.ok(reports('DB_PASSWORD=Sup3rS3cret!', 'password-assignment'), '.env 无引号')
  assert.ok(reports("password: 'Sup3rS3cret!'", 'password-assignment'), '带引号')
  assert.ok(reports('API_KEY=abcd1234efgh5678', 'password-assignment'))
})

test('代码表达式不算明文密钥（避免把变量赋值当泄漏）', () => {
  // These are how a value is *computed*, not how a secret is *stored*. Flagging
  // them made the report useless: every file that reads config had hits.
  assert.equal(reports('token = randomBytes(6).toString("hex")'), false)
  assert.equal(reports('const token = match[0]'), false)
  assert.equal(reports('password: process.env.PW'), false)
  assert.equal(reports('apiKey = loadKey()'), false)
})

test('JWT 令牌', () => {
  assert.ok(reports('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop', 'jwt'))
})

test('SSH 公钥', () => {
  assert.ok(reports('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ user@host', 'ssh-public-key'))
  assert.ok(reports('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI user@host', 'ssh-public-key'))
})

test('私网地址+端口（暴露内部拓扑）', () => {
  assert.ok(reports('10.0.0.9:3306', 'ipv4-private-port'), '10.0.0.x 四段')
  assert.ok(reports('192.168.1.1:8080', 'ipv4-private-port'))
  assert.ok(reports('172.16.0.5:5432', 'ipv4-private-port'))
})

test('数据库连接串（内嵌口令）', () => {
  assert.ok(reports('postgres://user:pass@db.internal.example:5432/main', 'conn-string'))
  assert.ok(reports('redis://:secret@cache:6379', 'conn-string'))
  assert.ok(reports('mongodb+srv://u:p@cluster.example/do', 'conn-string'))
})

test('各类 API 令牌', () => {
  assert.ok(reports('ghp_abcdefghijklmnopqrstuvwxyz123456', 'secret-token'), 'GitHub PAT')
  assert.ok(reports('gho_abcdefghijklmnopqrstuvwxyz123456', 'secret-token'), 'GitHub OAuth')
  assert.ok(reports('github_pat_11ABCDEFG0abcdefghijklmnop', 'secret-token'), 'fine-grained PAT')
  assert.ok(reports('sk-proj-abcdefghijklmnopqrstuvwx', 'secret-token'), 'OpenAI key')
  assert.ok(reports('AKIAIOSFODNN7EXAMPLE', 'secret-token'), 'AWS key')
  assert.ok(reports('AIzaSyA1234567890abcdefghijklmnopqrstu', 'secret-token'), 'Google key')
  assert.ok(reports('xoxb-1234567890-abcdefghij', 'secret-token'), 'Slack token')
})

test('IPv6 地址', () => {
  assert.ok(reports('2001:4860:4860::8888', 'ipv6'))
  assert.ok(reports('fe80::1%eth0 2001:0db8:85a3::8a2e:0370:7334', 'ipv6'))
})

test('公网 IPv4 与 host:port', () => {
  assert.ok(reports('49.233.195.67', 'ipv4-public'))
  assert.ok(reports('49.233.195.67:8443', 'host-port-public'))
})

test('邮箱与手机号', () => {
  assert.ok(reports('someone@realdomain.cn', 'email'))
  assert.ok(reports('13812345678', 'cn-mobile'))
})

test('微信 / QQ 账号', () => {
  assert.ok(reports('wxid_abc123def456', 'wechat-qq-id'))
  assert.ok(reports('qq: 12345678', 'wechat-qq-id'))
})

test('仓库 URL（含用户名与私库名）', () => {
  assert.ok(reports('https://github.com/someuser/private-repo', 'repo-url-private'))
  assert.ok(reports('https://gitlab.com/someuser/secret-project', 'repo-url-private'))
})

test('自建域名（无固定后缀表也需识别）', () => {
  assert.ok(reports('mycompany.com', 'domain-private'))
  assert.ok(reports('api.myservice.net', 'domain-private'))
})

test('中文人名（拉丁正则曾漏掉）', () => {
  assert.ok(reports("author: '张三'", 'person-name-position'))
  assert.ok(reports("placeholder: '李四'", 'person-name-position'))
})

test('拉丁人名（任意大小写，不限于 author 位置）', () => {
  assert.ok(reports("author: 'Elsa'", 'person-name-position'))
  assert.ok(reports('The developer elsa wrote this', 'person-name'))
  assert.ok(reports('ELSA was here', 'person-name'))
})

test('含人名的路径（白名单曾整行放过）', () => {
  assert.ok(reports('D:\\work\\Elsa\\notes', 'absolute-path'), '首段 work 不应整体豁免')
  assert.ok(reports('D:\\projects\\zhangsan\\data', 'absolute-path'))
})

test('绝对路径中的真实布局', () => {
  assert.ok(reports('D:\\DSHworkingArea\\dsh-project-docs', 'absolute-path'))
  assert.ok(reports('/home/alice/projects', 'posix-absolute-path'))
})

test('真实哈希', () => {
  assert.ok(reports('md5 8f4a2b1c9d3e7f60', 'real-digest'))
})

test('项目标识符（大小写不敏感）', () => {
  assert.ok(reports('see SheepVIllageSite for details', 'private-identifier'))
  assert.ok(reports('sheepvillage', 'private-identifier'))
})

test('中文业务词汇', () => {
  assert.ok(reports('羊村主站已上线', 'private-chinese-vocab'))
})

/* --------------------------------------------------------------- must allow */

test('文档示例地址不被误报', () => {
  assert.equal(reports('203.0.113.10'), false)
  assert.equal(reports('198.51.100.5'), false)
  assert.equal(reports('192.0.2.1'), false)
  assert.equal(reports('2001:db8::1'), false, 'RFC 3849 文档前缀')
})

test('回环与私有网段不被误报', () => {
  assert.equal(reports('127.0.0.1'), false)
  assert.equal(reports('127.0.0.1:8080'), false)
  assert.equal(reports('0.0.0.0'), false)
  assert.equal(reports('10.0.0.5'), false)
  assert.equal(reports('192.168.1.1'), false)
  assert.equal(reports('172.16.0.1'), false)
  assert.equal(reports('169.254.1.1'), false)
})

test('占位路径不被误报', () => {
  assert.equal(reports('D:\\path'), false)
  assert.equal(reports('D:\\work\\example-project'), false)
  assert.equal(reports('D:\\pack\\assets\\main.js'), false)
  assert.equal(reports('C:\\path\\to\\project'), false)
  assert.equal(reports('D:\\work'), false)
  assert.equal(reports('D:/A//B\\\\'), false)
})

test('安装示例路径不被误报（DEFAULT_ALLOW 对所有类别生效）', () => {
  // An install snippet must show a target path; flagging it meant every README
  // with `install_bundle` reported one false positive forever.
  assert.equal(reports('plugin_manager({ action: "install_bundle", target: "C:\\\\path\\\\to\\\\dsh-project-docs" })'), false)
})

test('DEFAULT_ALLOW 不会放行真实路径', () => {
  // The exemption is line-scoped and keyword-scoped: a real path on a line that
  // merely mentions the plugin still gets reported.
  assert.ok(reports('D:\\DSHworkingArea\\dsh-project-docs', 'absolute-path'))
  assert.ok(reports('D:\\\\work\\\\Elsa\\\\notes', 'absolute-path'))
})

test('占位家目录不被误报', () => {
  assert.equal(reports('/home/user/example-project'), false)
  assert.equal(reports('/Users/example/projects'), false)
})

test('知名公共域名不被误报', () => {
  assert.equal(reports('https://github.com/deepseek-ai/deepseek-harness'), false)
  assert.equal(reports('user@example.com'), false)
  assert.equal(reports('see npmjs.com for details'), false)
  assert.equal(reports('nodejs.org'), false)
})

test('流传甚广的空串/测试哈希不被误报', () => {
  assert.equal(reports('md5 d41d8cd98f00b204'), false, 'md5("")')
  assert.equal(reports('sha256 9f86d081884c7d65'), false, 'sha256("test")')
})

test('角色名不被当成人名', () => {
  for (const role of ['agent', 'human', 'user', 'lead', 'owner', 'admin', 'tester', 'system']) {
    assert.equal(reports(`author: '${role}'`), false, `${role} 是角色不是人名`)
  }
})

test('普通中文文本不被误报', () => {
  assert.equal(reports('这是一段普通的中文说明文字。'), false)
  assert.equal(reports('端口 8080 已就绪'), false)
})

test('代码标识符不被当成人名', () => {
  assert.equal(reports('placeholder: <port>'), false)
  assert.equal(reports('author: author'), false)
  assert.equal(reports('user: user'), false)
})

/* ------------------------------------------------------------- both ways */

test('同一文件的干净行与脏行只有脏行被报', () => {
  // Note the path is a *bare placeholder*, and the local address is loopback;
  // the token is the only finding that should survive.
  const text = [
    'const root = "D:\\\\path\\\\to\\\\project"',
    'const secret = "AKIAIOSFODNN7EXAMPLE"',
    'const local = "127.0.0.1:8080"',
  ].join('\n')
  const findings = scanText(text)
  // A single value may legitimately match more than one category (a token can
  // also look like a password assignment). The assertion is that exactly one
  // *line* is implicated, and that it is the token line.
  const lines = [...new Set(findings.map((f) => f.line))]
  assert.deepEqual(lines, [2], `应只报第 2 行，实际 ${JSON.stringify(lines)}：${JSON.stringify(findings.map((f) => f.category + ':' + f.value))}`)
  assert.ok(findings.every((f) => f.category === 'secret-token' || f.category === 'password-assignment'))
})

test('findings 带行号与上下文，便于定位', () => {
  const findings = scanText('line one\n\nAKIAIOSFODNN7EXAMPLE here')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].line, 3)
  assert.ok(findings[0].context.includes('AKIA'))
  assert.ok(findings[0].hint.length > 0)
})

test('空输入与正常代码不产生噪声', () => {
  assert.equal(scanText('').length, 0)
  assert.equal(scanText('import fs from "node:fs"').length, 0)
  assert.equal(scanText('export function scanText(text) { return [] }').length, 0)
})

test('扫描器源码自身被跳过（依赖入口行为）', () => {
  // scanText 不负责跳过（那是 CLI 的事），但名字不得出现在扫描结果里，
  // 否则发布包会被自己的名单污染。
  const findings = scanText('const PERSON_NAMES = []')
  assert.equal(findings.length, 0)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) {
    console.error(`\n--- ${failure.name} ---`)
    console.error(failure.error)
  }
  process.exitCode = 1
}
