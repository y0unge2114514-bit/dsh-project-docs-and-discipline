#!/usr/bin/env node
// 发布命令行外壳。
//
// 用法：
//   node scripts/release.mjs                  # 只打印计划（默认 dry-run）
//   node scripts/release.mjs --yes            # 真发布，需要 GITHUB_TOKEN
//   node scripts/release.mjs --version 0.3.3  # 覆盖版本号
//   node scripts/release.mjs --help
//
// 设计取舍：
//   - 默认 dry-run。发布是不可逆动作，手滑一次就要花半小时收拾。
//   - token 只从环境变量读，不接受命令行参数——命令行参数会进 shell 历史。
//   - 任何一步失败立刻停，并把已执行的步骤打出来，方便判断停在哪。
import { release, parseArgs, PLUGIN_ROOT, REPOSITORY } from './release-lib.mjs'

const HELP = `
用法：node scripts/release.mjs [选项]

  （无参数）        只打印发布计划，一条命令都不执行
  --yes, -y         真发布（推 main、推 tag、建 Release、回读核对）
  --dry-run         即使前面写了 --yes 也只打印计划
  --version <x.y.z> 覆盖要发布的版本号（默认读 package.json）
  --root <dir>      插件仓库根目录（默认脚本所在仓库）
  --remote <url>    git 远端（默认指向本插件仓库 ${REPOSITORY}）
  --help, -h        显示这段说明

环境变量：
  GITHUB_TOKEN      fine-grained PAT，需要 Contents: Read and write
                    （93 位；只读 token 会在 push 时被 GitHub 拒绝）

发布前会自动检查：
  工作区必须干净 · 远端不能已有同名 tag · Release 正文必须是字符串
`.trim()

const options = parseArgs(process.argv.slice(2))

if (options.help) {
  console.log(HELP)
  process.exit(0)
}

const root = options.root || PLUGIN_ROOT
const token = process.env.GITHUB_TOKEN || ''

if (!options.dryRun && !token) {
  console.error('缺少 GITHUB_TOKEN 环境变量。')
  console.error('真发布会推送到远端，必须有可写的 fine-grained PAT；')
  console.error('匿名推送会被 GitHub 拒绝，也不会退化成 SSH（本机 sshd 占着 22 端口）。')
  console.error('如果只想看计划，去掉 --yes 直接跑。')
  process.exit(2)
}

const result = await release({
  root,
  dryRun: options.dryRun,
  yes: options.yes,
  version: options.version,
  pat: token,
  remote: options.remote || undefined,
  log: (line) => console.log(line),
})

if (result.dryRun) {
  console.log(`\n计划（版本 ${result.version}，tag ${result.tag}）：`)
  for (const step of result.plan) {
    console.log(`  · ${step.title}`)
    console.log(`    ${step.command}`)
  }
  console.log('\n这是 dry-run，什么都没执行。确认无误后加 --yes 真发布。')
  process.exit(0)
}

if (!result.ok) {
  console.error(`\n发布失败：${result.error}`)
  if (result.hint) console.error(`  ${result.hint}`)
  if (Array.isArray(result.dirty) && result.dirty.length > 0) {
    console.error('  未提交的改动：')
    for (const file of result.dirty) console.error(`    ${file}`)
  }
  if (Array.isArray(result.steps) && result.steps.length > 0) {
    console.error('  已执行的步骤：')
    for (const step of result.steps) {
      console.error(`    ${step.ok ? '✓' : '✗'} ${step.id}${step.stderr ? ` — ${step.stderr.split('\n')[0]}` : ''}`)
    }
  }
  process.exit(1)
}

console.log(`\n发布完成：${result.tag}`)
if (result.url) console.log(`  ${result.url}`)
console.log(`  正文 ${result.bodyChars} 字符`)
for (const step of result.steps) {
  console.log(`  ${step.ok ? '✓' : '✗'} ${step.id}`)
}
process.exit(0)
