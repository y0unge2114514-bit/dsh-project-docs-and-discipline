/**
 * Build one condensed "packet" per project for shared-fact extraction.
 *
 * Every project gets its own file under `kb-packets/<id>.md`, so analysts can
 * work in parallel without each of them reading the whole library. Packets keep
 * the parts of a document that carry shared infrastructure facts (headings,
 * tables, code fences, and lines containing resource words) and drop prose that
 * only describes product behaviour.
 *
 * Usage: node scripts/make-kb-packets.mjs [storeDir] [outDir]
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

const storeDir = path.resolve(process.argv[2] ?? process.env.DSH_DOCS_STORE ?? '')
const outDir = path.resolve(process.argv[3] ?? 'kb-packets')

const KEEP = /(\d+\s*(GB|MB|TB|G|M)\b|端口|port\b|:\d{4,5}\b|127\.0\.0\.1|localhost|IPv4|VPS|服务器|主机|nginx|systemd|计划任务|ssh|隧道|反向代理|缓存|磁盘|分区|内存|CPU|进程|pid|路径|目录|启动|命令|systemctl|docker|数据库|sqlite|实例|账号|用户|权限|管理员|防火墙|cdn|域名|证书|备份|任务队列|组网|radmin|easytier|拓扑|限速|带宽|并发|配额|token|api|密钥|key\b|环境变量|版本|\bnode\b|\bpython\b|java|开机|自启|守护|看门狗|健康|自检)/i
const MAX_PER_DOC = 120

async function listMd(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const out = []
    for (const entry of entries) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
      const file = path.join(dir, entry.name)
      out.push({ name: entry.name, text: await fs.readFile(file, 'utf8') })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

function condense(text) {
  const lines = text.split(/\r?\n/)
  const kept = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      kept.push(line)
      continue
    }
    if (inFence) {
      kept.push(line)
      continue
    }
    if (/^#{1,6}\s/.test(line)) {
      kept.push(line)
      continue
    }
    if (/\|/.test(line) && line.trim().length > 2) {
      kept.push(line)
      continue
    }
    if (KEEP.test(line)) kept.push(line)
    if (kept.length >= MAX_PER_DOC) {
      kept.push('…（已截断）')
      break
    }
  }
  return kept.join('\n')
}

async function main() {
  await fs.mkdir(outDir, { recursive: true })
  const projectsRoot = path.join(storeDir, 'projects')
  const projects = (await fs.readdir(projectsRoot, { withFileTypes: true })).filter((e) => e.isDirectory())
  const index = []
  for (const project of projects) {
    const id = project.name
    const meta = JSON.parse(await fs.readFile(path.join(projectsRoot, id, 'project.json'), 'utf8').catch(() => '{}'))
    const docs = [
      ...(await listMd(path.join(projectsRoot, id, 'docs', 'project'))).map((d) => ({ ...d, kind: '项目文档' })),
      ...(await listMd(path.join(projectsRoot, id, 'docs', 'collab'))).map((d) => ({ ...d, kind: '合作文档' })),
    ]
    const parts = [
      `# 项目 ${id}（${meta.title ?? id}）`,
      '',
      `- root: ${meta.root ?? ''}`,
      `- summary: ${meta.summary ?? ''}`,
      '',
    ]
    for (const doc of docs) {
      const body = condense(doc.text)
      if (body.trim() === '') continue
      parts.push(`## [${doc.kind}] ${doc.name}`, '', body, '')
    }
    const out = path.join(outDir, `${id}.md`)
    await fs.writeFile(out, parts.join('\n'), 'utf8')
    index.push(`${id}\t${docs.length} 篇\t${parts.join('\n').length} 字节`)
  }
  console.log(`wrote ${projects.length} packets to ${outDir}`)
  for (const row of index) console.log(row)
}

await main()
