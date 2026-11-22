/**
 * Client half of the 项目文档 (project-docs) bundle.
 *
 * Registers a first-class sidebar panel (icon + `main` page) that reads and
 * writes the Host half's same-origin routes. Plain JavaScript, no JSX, no
 * imports beyond the browser module table's React.
 * @module @local/dsh-project-docs
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-project-docs',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'project-docs'
    const PANEL_ID = 'project-docs'
    const API = '/project-docs/api'

    /** Simplified Chinese copy; the key set is the source of truth. */
    const zh = {
      'panel': '项目文档',
      'panel.subtitle': '多 Agent 协作中心 · {dir}',
      'action.refresh': '刷新',
      'action.newProject': '新建项目',
      'action.cancel': '取消',
      'action.save': '保存',
      'action.create': '创建',
      'action.edit': '编辑',
      'action.copy': '复制',
      'action.copied': '已复制',
      'action.post': '发布',
      'action.register': '登记',
      'action.reload': '载入最新',
      'loading': '加载中…',
      'empty.projects': '还没有项目',
      'empty.projects.hint': '点右上角「新建项目」建立第一个项目条目。',
      'empty.docs': '这个分类还没有文档',
      'empty.docs.hint': '点左栏的「新建」写第一份。',
      'empty.board': '还没有留言',
      'empty.tools': '工具库还是空的',
      'empty.tools.hint': '把项目里好用的脚本登记进来，其他项目就能直接复用。',
      'project.root': '路径',
      'project.summary': '简介',
      'project.noSummary': '暂无简介',
      'project.edit': '编辑项目信息',
      'project.title': '项目标题',
      'project.id': '项目 id（可选，留空自动生成）',
      'project.root.placeholder': 'D:\\路径\\到\\项目',
      'project.summary.placeholder': '一句话说明这个项目',
      'tab.docs': '文档',
      'group.project': '项目文档（先读）',
      'group.collab': '合作文档（动手前按此执行）',
      'groupShort.project': '项目文档',
      'groupShort.collab': '合作文档',
      'docs.readingOrder': '先读项目文档了解全貌，再按合作文档的约定动手',
      'tab.credential': '凭证区',
      'group.credential': '凭证（本机 Agent 按需读取）',
      'groupShort.credential': '凭证',
      'credential.hint': '本机 Agent 专用：需要连机器 / 调接口时再读；不要外发，不要贴进聊天或提交。',
      'tab.human': '人类留言板',
      'tab.agent': 'Agent 留言板',
      'tab.tools': '公共工具库',
      'docs.list': '文档',
      'docs.new': '新建',
      'docs.name': '文档名',
      'docs.name.placeholder': '例如 HANDOFF.md',
      'docs.content': '正文（Markdown）',
      'docs.hash': 'hash {hash}',
      'docs.updated': '更新 {time}',
      'docs.edit': '编辑',
      'docs.conflict': '保存被拒绝：这份文档在你编辑期间已被别人改过。',
      'docs.conflict.hint': '「载入最新」会用最新内容替换编辑框；先想清楚是否要覆盖别人的改动。',
      'board.human.hint': '这是你写给 Agent 的留言；Agent 只读，回复会出现在 Agent 留言板。',
      'board.agent.hint': 'Agent 之间交接、认领与警示的公开记录；Append-only，谁写都不会覆盖别人。',
      'board.author': '署名',
      'board.kind': '类型',
      'board.text': '内容（Markdown）',
      'board.text.placeholder': '写清楚：谁、在做什么、下一步、注意事项。',
      'board.total': '共 {count} 条，显示最新 {shown} 条',
      'kind.note': '留言',
      'kind.question': '问题',
      'kind.warning': '警示',
      'kind.handoff': '交接',
      'kind.claim': '认领',
      'kind.reply': '回复',
      'tools.search': '搜索',
      'tools.search.placeholder': '按名称、用途、命令、标签搜索全部项目',
      'tools.name': '工具名',
      'tools.name.placeholder': '例如 sop-selfcheck',
      'tools.summary': '一句话用途',
      'tools.summary.placeholder': '它解决什么问题',
      'tools.command': '路径或命令',
      'tools.command.placeholder': 'node scripts/sop-selfcheck.js',
      'tools.usage': '用法 / 坑（可选）',
      'tools.usage.placeholder': '参数、前置条件、已知坑',
      'tools.tags': '标签（逗号分隔，可选）',
      'tools.registerTitle': '登记一个工具',
      'tools.added': '已登记 / 已更新',
      'tools.noCommand': '未填命令',
      'tools.saveFailed': '登记失败：{error}',
      'error.load': '加载失败：{error}',
      'error.save': '保存失败：{error}',
      'error.post': '发布失败：{error}',
      'meta.counts': '{project} 项目文档 · {collab} 合作文档 · {human} 人类留言 · {agent} Agent 留言 · {tools} 工具',
      'meta.claims': '⚠ 认领 {n}',
      'claims.warning': '{n} 个活跃认领——范围重叠时先协商再动手：',
      'claims.expires': '至 {at}',
      'store.label': '存储目录',
      'panel.loading': '读取项目文档库…',
    }

    /** English copy; same key set. */
    const en = {
      'panel': 'Project Docs',
      'panel.subtitle': 'Multi-agent hub · {dir}',
      'action.refresh': 'Refresh',
      'action.newProject': 'New project',
      'action.cancel': 'Cancel',
      'action.save': 'Save',
      'action.create': 'Create',
      'action.edit': 'Edit',
      'action.copy': 'Copy',
      'action.copied': 'Copied',
      'action.post': 'Post',
      'action.register': 'Register',
      'action.reload': 'Load latest',
      'loading': 'Loading…',
      'empty.projects': 'No projects yet',
      'empty.projects.hint': 'Use “New project” to create the first entry.',
      'empty.docs': 'No documents in this category',
      'empty.docs.hint': 'Use “New” in the left column to write the first one.',
      'empty.board': 'No messages yet',
      'empty.tools': 'The tool library is empty',
      'empty.tools.hint': 'Register a useful script here so other projects can reuse it.',
      'project.root': 'Path',
      'project.summary': 'Summary',
      'project.noSummary': 'No summary yet',
      'project.edit': 'Edit project info',
      'project.title': 'Project title',
      'project.id': 'Project id (optional, generated when empty)',
      'project.root.placeholder': 'D:\\path\\to\\project',
      'project.summary.placeholder': 'One sentence about this project',
      'tab.docs': 'Docs',
      'group.project': 'Project docs (read first)',
      'group.collab': 'Collaboration docs (rules to follow)',
      'groupShort.project': 'Project docs',
      'groupShort.collab': 'Collaboration docs',
      'docs.readingOrder': 'Read the project docs first, then follow the collaboration docs',
      'tab.credential': 'Credentials',
      'group.credential': 'Credentials (local agents read on demand)',
      'groupShort.credential': 'Credentials',
      'credential.hint': 'Local-agent only: read when you need to reach a host or call an API; never send it out, paste it into chat, or commit it.',
      'tab.human': 'Human board',
      'tab.agent': 'Agent board',
      'tab.tools': 'Tool library',
      'docs.list': 'Documents',
      'docs.new': 'New',
      'docs.name': 'Document name',
      'docs.name.placeholder': 'e.g. HANDOFF.md',
      'docs.content': 'Body (Markdown)',
      'docs.hash': 'hash {hash}',
      'docs.updated': 'updated {time}',
      'docs.edit': 'Edit',
      'docs.conflict': 'Save refused: this document changed while you were editing it.',
      'docs.conflict.hint': '“Load latest” replaces your editor with the newest content — decide whether overwriting it is intended.',
      'board.human.hint': 'Your notes for the agents. Agents only read this board; their replies appear on the agent board.',
      'board.agent.hint': 'Public handoffs, claims and warnings between agents. Append-only, so nobody overwrites anyone.',
      'board.author': 'Author',
      'board.kind': 'Type',
      'board.text': 'Content (Markdown)',
      'board.text.placeholder': 'Who is doing what, next step, and anything to avoid.',
      'board.total': '{count} total, showing newest {shown}',
      'kind.note': 'Note',
      'kind.question': 'Question',
      'kind.warning': 'Warning',
      'kind.handoff': 'Handoff',
      'kind.claim': 'Claim',
      'kind.reply': 'Reply',
      'tools.search': 'Search',
      'tools.search.placeholder': 'Search every project by name, purpose, command or tag',
      'tools.name': 'Tool name',
      'tools.name.placeholder': 'e.g. sop-selfcheck',
      'tools.summary': 'One-line purpose',
      'tools.summary.placeholder': 'What problem it solves',
      'tools.command': 'Path or command',
      'tools.command.placeholder': 'node scripts/sop-selfcheck.js',
      'tools.usage': 'Usage / pitfalls (optional)',
      'tools.usage.placeholder': 'Arguments, prerequisites, known pitfalls',
      'tools.tags': 'Tags (comma separated, optional)',
      'tools.registerTitle': 'Register a tool',
      'tools.added': 'Registered / updated',
      'tools.noCommand': 'no command',
      'tools.saveFailed': 'Register failed: {error}',
      'error.load': 'Load failed: {error}',
      'error.save': 'Save failed: {error}',
      'error.post': 'Post failed: {error}',
      'meta.counts': '{project} docs · {collab} collaboration · {human} human notes · {agent} agent notes · {tools} tools',
      'meta.claims': '⚠ {n} claimed',
      'claims.warning': '{n} active claim(s) — coordinate before overlapping:',
      'claims.expires': 'until {at}',
      'store.label': 'Store',
      'panel.loading': 'Reading the project-docs store…',
    }

    const MESSAGE_KINDS = ['note', 'question', 'warning', 'handoff', 'claim', 'reply']

    /* ------------------------------------------------------------ transport */

    function errorText(error) {
      return error instanceof Error ? error.message : String(error)
    }

    async function requestJson(url, init) {
      const response = await fetch(url, init)
      const body = await response.json().catch(() => null)
      if (!response.ok || body === null || body.ok === false) {
        const message = body !== null && typeof body === 'object' ? body.message || body.error : null
        const error = new Error(message || `HTTP ${response.status}`)
        error.status = response.status
        error.payload = body
        throw error
      }
      return body
    }

    function apiGet(path, params) {
      const url = new URL(`${API}/${path}`, window.location.origin)
      if (params !== undefined && params !== null) {
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(key, String(value))
        }
      }
      return requestJson(url.href, { headers: { accept: 'application/json' }, cache: 'no-store' })
    }

    function apiPost(path, body) {
      return requestJson(new URL(`${API}/${path}`, window.location.origin).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-project-docs': '1' },
        body: JSON.stringify(body ?? {}),
      })
    }

    /* -------------------------------------------------------------- helpers */

    function pad(value) {
      return String(value).padStart(2, '0')
    }

    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function safeHref(raw) {
      const value = String(raw ?? '').trim()
      if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) return value
      return null
    }

    function renderInline(text) {
      const nodes = []
      const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g
      let last = 0
      let index = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        const token = match[0]
        const key = `i${index}`
        index += 1
        if (token.startsWith('`')) {
          nodes.push(h('code', { key, className: 'pd-inline-code' }, token.slice(1, -1)))
        } else if (token.startsWith('**')) {
          nodes.push(h('strong', { key }, token.slice(2, -2)))
        } else {
          const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
          const href = link === null ? null : safeHref(link[2])
          if (href === null) nodes.push(token)
          else nodes.push(h('a', { key, href, target: '_blank', rel: 'noreferrer' }, link[1]))
        }
        last = match.index + token.length
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes.length === 0 ? null : nodes
    }

    /** Small Markdown subset: headings, lists, quotes, rules, fences, inline spans. */
    function Markdown({ text }) {
      const lines = String(text ?? '').split(/\r?\n/)
      const blocks = []
      let i = 0
      const push = (node) => {
        if (node !== null && node !== undefined) blocks.push(node)
      }
      const keyOf = () => `b${blocks.length}`
      while (i < lines.length) {
        const line = lines[i]
        if (/^\s*```/.test(line)) {
          const body = []
          i += 1
          while (i < lines.length && !/^\s*```/.test(lines[i])) {
            body.push(lines[i])
            i += 1
          }
          i += 1
          push(h('pre', { key: keyOf(), className: 'pd-code' }, h('code', null, body.join('\n'))))
          continue
        }
        if (/^\s*$/.test(line)) {
          i += 1
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          push(h('div', { key: keyOf(), className: `pd-h pd-h${heading[1].length}` }, renderInline(heading[2])))
          i += 1
          continue
        }
        if (/^[-*+]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^[-*+]\s+/, ''))
            i += 1
          }
          push(h('ul', { key: keyOf(), className: 'pd-ul' }, items.map((item, index) => h('li', { key: `li${index}` }, renderInline(item)))))
          continue
        }
        if (/^\d+[.)]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\d+[.)]\s+/, ''))
            i += 1
          }
          push(h('ol', { key: keyOf(), className: 'pd-ol' }, items.map((item, index) => h('li', { key: `li${index}` }, renderInline(item)))))
          continue
        }
        if (/^>\s?/.test(line)) {
          const quoted = []
          while (i < lines.length && /^>\s?/.test(lines[i])) {
            quoted.push(lines[i].replace(/^>\s?/, ''))
            i += 1
          }
          push(h('blockquote', { key: keyOf(), className: 'pd-quote' }, renderInline(quoted.join('\n'))))
          continue
        }
        if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
          push(h('hr', { key: keyOf(), className: 'pd-hr' }))
          i += 1
          continue
        }
        const paragraph = []
        while (
          i < lines.length &&
          !/^\s*$/.test(lines[i]) &&
          !/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?|```)/.test(lines[i]) &&
          !/^(-{3,}|\*{3,})$/.test(lines[i].trim())
        ) {
          paragraph.push(lines[i])
          i += 1
        }
        push(h('p', { key: keyOf(), className: 'pd-p' }, renderInline(paragraph.join('\n'))))
      }
      if (blocks.length === 0) return h('div', { className: 'pd-md pd-empty-md' }, '—')
      return h('div', { className: 'pd-md' }, blocks)
    }

    /* ---------------------------------------------------- progress anchors */

    /**
     * Turn the bold-only progress anchors the discipline asks models to write —
     * `**下一步：…**` and `**本批：…**` — into standalone chips above the tool
     * calls, instead of letting them read as ordinary body text.
     *
     * The Chat text is model output, not a Slot the shipped conversation hands
     * out, so this decorates the rendered Markdown (a line whose whole content is
     * one `<strong>`) and keeps the text untouched. Streaming, re-renders, and
     * restored sessions are covered by the observer; a node that already has the
     * class is never rewritten, so the decoration converges instead of looping.
     */
    const CHIP_CSS = `
.pd-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  margin: 2px 0 10px;
  padding: 1px 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .3));
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .12));
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-size: 12px;
  line-height: 1.9;
  letter-spacing: 0;
}
.pd-chip::before {
  content: '';
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--dsw-alias-state-business-primary, #4d6bfe);
  opacity: .75;
}
.pd-chip--batch { color: var(--dsw-alias-label-tertiary, #9ca3af); }
.pd-chip--batch::before { background: currentColor; opacity: .55; }
.pd-chip strong { color: inherit; font-size: 12px; font-weight: 600; }
`

    const CHIP_MARKER = /^(?:下一步|本批)\s*[：:]\s*\S/

    /** Decorate one `<strong>` that occupies a whole line; safe to call repeatedly. */
    function markProgressChip(strong) {
      if (!strong || strong.nodeType !== 1 || strong.tagName !== 'STRONG') return
      const text = (strong.textContent || '').trim()
      if (text === '' || !CHIP_MARKER.test(text)) return
      const line = strong.parentElement
      if (!line || (line.textContent || '').trim() !== text) return
      if (line.classList.contains('pd-chip')) return
      line.classList.add('pd-chip', text.startsWith('本批') ? 'pd-chip--batch' : 'pd-chip--next')
    }

    /** Decorate every anchor inside `root` (inclusive when `root` is one). */
    function scanProgressChips(root) {
      const scope = root && root.nodeType === 1 ? root : document
      markProgressChip(scope)
      const found = scope.querySelectorAll ? scope.querySelectorAll('strong') : []
      for (const strong of found) markProgressChip(strong)
    }

    /** Install the decorations plus a stylesheet that lives as long as the plugin. */
    function installProgressChips() {
      if (typeof document === 'undefined') return () => {}
      // The plugin may apply before <body> exists; wait for the document instead
      // of silently giving up on the whole decoration.
      if (!document.body) {
        let inner = null
        const onReady = () => {
          inner = installProgressChips()
        }
        document.addEventListener('DOMContentLoaded', onReady, { once: true })
        return () => {
          document.removeEventListener('DOMContentLoaded', onReady)
          if (inner !== null) inner()
        }
      }
      const style = document.createElement('style')
      style.textContent = CHIP_CSS
      document.head.appendChild(style)

      scanProgressChips(document)
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'characterData') {
            scanProgressChips(record.target.parentElement)
            continue
          }
          if (record.type === 'attributes') {
            scanProgressChips(record.target)
            continue
          }
          for (const node of record.addedNodes) {
            scanProgressChips(node.nodeType === 1 ? node : node.parentElement)
          }
        }
      })
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class'],
      })
      return () => {
        observer.disconnect()
        style.remove()
      }
    }

    /* ---------------------------------------------------------------- style */

    const CSS = `
.pd-root { height: 100%; display: flex; flex-direction: column; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 14px; }
.pd-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 18px 22px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.pd-title { margin: 0; font-size: 1.18em; font-weight: 600; }
.pd-sub { margin-top: 4px; font-size: .76em; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.pd-head-actions { display: flex; gap: 8px; flex: none; }
.pd-body { flex: 1; display: flex; min-height: 0; }
.pd-side { width: 244px; flex: none; border-right: 1px solid var(--dsw-alias-border-l1); overflow: auto; padding: 10px; }
.pd-side-title { font-size: .72em; letter-spacing: .04em; color: var(--dsw-alias-label-secondary); padding: 4px 8px 8px; }
.pd-proj { display: block; width: 100%; text-align: left; border: 1px solid transparent; border-radius: 9px; background: transparent; color: inherit; font: inherit; padding: 8px 10px; cursor: pointer; margin-bottom: 2px; }
.pd-proj:hover { background: var(--dsw-alias-bg-layer-2); }
.pd-proj[data-active="true"] { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.pd-proj-name { display: block; font-size: .88em; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pd-proj-meta { display: block; margin-top: 3px; font-size: .7em; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.pd-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.pd-project { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.pd-project-head { padding: 14px 20px 0; }
.pd-project-title { margin: 0; font-size: 1.04em; font-weight: 600; }
.pd-project-lines { margin-top: 4px; font-size: .76em; color: var(--dsw-alias-label-secondary); display: flex; flex-direction: column; gap: 2px; word-break: break-all; }
.pd-project-actions { display: flex; gap: 8px; margin-top: 8px; }
.pd-tabs { display: flex; gap: 2px; padding: 10px 20px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); flex: none; }
.pd-tab { border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: .82em; padding: 7px 11px; cursor: pointer; }
.pd-tab:hover { color: var(--dsw-alias-label-primary); }
.pd-tab[data-active="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
.pd-tab-count { margin-left: 5px; font-size: .85em; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.pd-content { flex: 1; min-height: 0; display: flex; overflow: hidden; }
.pd-scroll { flex: 1; min-width: 0; overflow: auto; padding: 16px 20px 28px; }
.pd-docpane { display: flex; width: 100%; min-height: 0; }
.pd-doclist { width: 236px; flex: none; border-right: 1px solid var(--dsw-alias-border-l1); overflow: auto; padding: 10px; }
.pd-doclist-head { padding: 2px 6px 8px; font-size: .7em; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
.pd-docgroup { margin-bottom: 2px; }
.pd-docgroup-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 8px 6px 4px; font-size: .7em; color: var(--dsw-alias-label-secondary); border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 4px; }
.pd-docgroup:first-child .pd-docgroup-head { border-top: 0; margin-top: 0; }
.pd-docgroup-empty { padding: 2px 8px 6px; font-size: .72em; color: var(--dsw-alias-label-secondary); }
.pd-docitem { display: block; width: 100%; text-align: left; border: 1px solid transparent; border-radius: 8px; background: transparent; color: inherit; font: inherit; padding: 7px 9px; cursor: pointer; margin-bottom: 2px; }
.pd-docitem:hover { background: var(--dsw-alias-bg-layer-2); }
.pd-docitem[data-active="true"] { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.pd-docitem-name { display: block; font-size: .84em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pd-docitem-meta { display: block; margin-top: 2px; font-size: .68em; color: var(--dsw-alias-label-secondary); }
.pd-docview { flex: 1; min-width: 0; overflow: auto; padding: 16px 22px 28px; }
.pd-docview-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.pd-docview-title { margin: 0; font-size: 1.02em; font-weight: 600; word-break: break-all; }
.pd-meta { margin-top: 4px; font-size: .72em; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; word-break: break-all; }
.pd-btn { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: .78em; padding: 5px 11px; cursor: pointer; white-space: nowrap; }
.pd-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.pd-btn:disabled { opacity: .5; cursor: default; }
.pd-btn-primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.pd-btn-small { font-size: .72em; padding: 3px 8px; }
.pd-input, .pd-textarea, .pd-select { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-base); color: inherit; font: inherit; font-size: .84em; padding: 6px 9px; }
.pd-textarea { min-height: 120px; resize: vertical; line-height: 1.55; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .8em; }
.pd-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.pd-label { font-size: .72em; color: var(--dsw-alias-label-secondary); }
.pd-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.pd-row-end { display: flex; gap: 8px; justify-content: flex-end; }
.pd-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 11px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; margin-bottom: 12px; }
.pd-banner { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; font-size: .8em; line-height: 1.5; }
.pd-banner strong { color: var(--dsw-alias-state-error-primary); }
.pd-banner-warn { border-color: var(--dsw-alias-state-warn-primary); }
.pd-banner-warn strong { color: var(--dsw-alias-state-warn-primary); }
.pd-banner-slim { margin-bottom: 10px; }
.pd-note { font-size: .74em; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.pd-empty { padding: 28px 10px; text-align: center; font-size: .84em; color: var(--dsw-alias-label-secondary); }
.pd-badge { display: inline-block; font-size: .68em; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.pd-badge-brand { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.pd-badge-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.pd-badge-claim { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.pd-md { line-height: 1.62; font-size: .9em; }
.pd-md .pd-h { font-weight: 600; margin: 16px 0 8px; }
.pd-md .pd-h1 { font-size: 1.24em; }
.pd-md .pd-h2 { font-size: 1.12em; }
.pd-md .pd-h3 { font-size: 1.02em; }
.pd-md .pd-h4, .pd-md .pd-h5, .pd-md .pd-h6 { font-size: .96em; }
.pd-md .pd-p { margin: 0 0 10px; white-space: pre-wrap; }
.pd-md .pd-ul, .pd-md .pd-ol { margin: 0 0 10px; padding-left: 22px; }
.pd-md .pd-ul li, .pd-md .pd-ol li { margin-bottom: 3px; }
.pd-md .pd-quote { margin: 0 0 10px; padding: 2px 0 2px 12px; border-left: 3px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); white-space: pre-wrap; }
.pd-md .pd-code { margin: 0 0 10px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); overflow: auto; font-size: .92em; }
.pd-md .pd-inline-code { padding: 1px 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); font-size: .92em; }
.pd-md .pd-hr { border: 0; border-top: 1px solid var(--dsw-alias-border-l1); margin: 14px 0; }
.pd-md a { color: var(--dsw-alias-brand-primary); }
.pd-entries { display: flex; flex-direction: column; gap: 10px; }
.pd-entry-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; font-size: .76em; color: var(--dsw-alias-label-secondary); }
.pd-entry-author { color: var(--dsw-alias-label-primary); font-weight: 500; }
.pd-entry-text { font-size: .88em; }
.pd-tool-card-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.pd-tool-name { font-size: .92em; font-weight: 600; }
.pd-tool-summary { margin-top: 5px; font-size: .82em; }
.pd-tool-line { margin-top: 6px; display: flex; gap: 8px; align-items: flex-start; font-size: .76em; color: var(--dsw-alias-label-secondary); }
.pd-tool-code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: var(--dsw-alias-bg-layer-2); border-radius: 5px; padding: 2px 6px; word-break: break-all; color: var(--dsw-alias-label-primary); }
.pd-tool-usage { margin-top: 6px; font-size: .76em; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; }
.pd-side-form { border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 8px; padding-top: 10px; }
.pd-footer-hint { margin-top: 10px; font-size: .7em; color: var(--dsw-alias-label-secondary); }
.pd-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); flex: none; }
`

    /* ----------------------------------------------------------- components */

    function Icon({ size, active }) {
      return h(
        'span',
        { style: { display: 'inline-flex', opacity: active === true ? 1 : 0.82 } },
        h(
          'svg',
          { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, style: { display: 'block' } },
          h('rect', {
            x: 4.5,
            y: 4,
            width: 11,
            height: 16.5,
            rx: 2,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
          }),
          h('path', {
            d: 'M7.4 8.4h6M7.4 11.6h6M7.4 14.8h3.4',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            opacity: 0.7,
          }),
          h('circle', { cx: 17.6, cy: 16.6, r: 2.3, fill: 'currentColor' }),
          h('circle', { cx: 20.4, cy: 13.4, r: 1.4, fill: 'currentColor', opacity: 0.6 }),
          h('path', { d: 'M18.9 15.2l.9-.7', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        ),
      )
    }

    function Field({ label, children }) {
      return h('label', { className: 'pd-field' }, h('span', { className: 'pd-label' }, label), children)
    }

    function CountsLine({ t, counts }) {
      if (counts === undefined || counts === null) return null
      return h(
        'span',
        null,
        t('meta.counts', {
          project: counts.project ?? 0,
          collab: counts.collab ?? 0,
          human: counts.human ?? 0,
          agent: counts.agent ?? 0,
          tools: counts.tools ?? 0,
        }),
      )
    }

    /**
     * One window for both categories: 项目文档 (read first, to understand the
     * project) above 合作文档 (the rules to follow before changing anything).
     */
    function DocTab({ t, projectId, groups, onChanged, hint }) {
      const [selected, setSelected] = React.useState(null)
      const [doc, setDoc] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [editor, setEditor] = React.useState(null)
      const [conflict, setConflict] = React.useState(null)
      const [saving, setSaving] = React.useState(false)

      const allDocs = React.useMemo(() => {
        const flat = []
        for (const group of groups) for (const item of group.docs) flat.push({ ...item, kind: group.kind })
        return flat
      }, [groups])

      const openDoc = React.useCallback(
        async (kind, name) => {
          setEditor(null)
          setConflict(null)
          setSelected({ kind, name })
          setLoading(true)
          setError(null)
          try {
            const body = await apiGet('doc', { id: projectId, kind, name })
            setDoc(body.doc)
          } catch (failure) {
            setDoc(null)
            setError(errorText(failure))
          } finally {
            setLoading(false)
          }
        },
        [projectId],
      )

      React.useEffect(() => {
        if (editor !== null) return
        if (selected !== null || allDocs.length === 0) return
        const first = allDocs[0]
        void openDoc(first.kind, first.name)
      }, [allDocs, selected, editor, openDoc])

      async function save(kind, name, content, baseHash) {
        setSaving(true)
        setError(null)
        setConflict(null)
        try {
          const body = await apiPost('doc', { project: projectId, kind, doc_name: name, content, base_hash: baseHash ?? undefined })
          setDoc(body.doc)
          setSelected({ kind, name: body.doc.name })
          setEditor(null)
          if (typeof onChanged === 'function') onChanged()
        } catch (failure) {
          if (failure.status === 409 && failure.payload !== null && failure.payload.current !== undefined) {
            setConflict(failure.payload.current)
          } else {
            setError(t('error.save', { error: errorText(failure) }))
          }
        } finally {
          setSaving(false)
        }
      }

      const list = h(
        'div',
        { className: 'pd-doclist' },
        h('div', { className: 'pd-doclist-head' }, hint ?? t('docs.readingOrder')),
        groups.map((group) =>
          h(
            'div',
            { key: group.kind, className: 'pd-docgroup' },
            h(
              'div',
              { className: 'pd-docgroup-head' },
              h('span', null, t(`group.${group.kind}`)),
              h(
                'button',
                {
                  type: 'button',
                  className: 'pd-btn pd-btn-small',
                  onClick: () => {
                    setEditor({ mode: 'new', kind: group.kind, name: '', content: '' })
                    setConflict(null)
                    setSelected(null)
                    setDoc(null)
                  },
                },
                t('docs.new'),
              ),
            ),
            group.docs.length === 0
              ? h('div', { className: 'pd-docgroup-empty' }, t('empty.docs'))
              : group.docs.map((item) =>
                  h(
                    'button',
                    {
                      key: `${group.kind}/${item.name}`,
                      type: 'button',
                      className: 'pd-docitem',
                      'data-active':
                        editor === null && selected !== null && selected.kind === group.kind && selected.name === item.name
                          ? 'true'
                          : 'false',
                      onClick: () => void openDoc(group.kind, item.name),
                    },
                    h('span', { className: 'pd-docitem-name' }, item.title),
                    h('span', { className: 'pd-docitem-meta' }, formatTime(item.updatedAt)),
                  ),
                ),
          ),
        ),
      )

      let body
      if (editor !== null) {
        body = h(DocEditor, {
          t,
          kind: editor.kind,
          initial: editor,
          saving,
          conflict,
          onCancel: () => {
            setEditor(null)
            setConflict(null)
            if (selected !== null) void openDoc(selected.kind, selected.name)
          },
          onReload: () => {
            if (conflict !== null) {
              setEditor({ mode: 'edit', kind: conflict.kind, name: conflict.name, content: conflict.content, hash: conflict.hash })
              setConflict(null)
            }
          },
          onSave: (name, content, baseHash) => void save(editor.kind, name, content, baseHash),
        })
      } else if (loading) {
        body = h('div', { className: 'pd-empty' }, t('loading'))
      } else if (doc !== null) {
        body = h(
          'div',
          { className: 'pd-docview' },
          h(
            'div',
            { className: 'pd-docview-head' },
            h(
              'div',
              null,
              h('h2', { className: 'pd-docview-title' }, doc.title),
              h(
                'div',
                { className: 'pd-meta' },
                `${t(`groupShort.${doc.kind}`)} · ${doc.name} · ${t('docs.hash', { hash: doc.hash })} · ${t('docs.updated', { time: formatTime(doc.updatedAt) })}`,
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'pd-btn',
                onClick: () => {
                  setEditor({ mode: 'edit', kind: doc.kind, name: doc.name, content: doc.content, hash: doc.hash })
                  setConflict(null)
                },
              },
              t('docs.edit'),
            ),
          ),
          h(Markdown, { text: doc.content }),
        )
      } else if (error !== null) {
        body = h('div', { className: 'pd-empty' }, error)
      } else {
        body = h(
          'div',
          { className: 'pd-empty' },
          h('div', null, t('empty.docs')),
          h('div', { className: 'pd-footer-hint' }, t('empty.docs.hint')),
        )
      }

      return h('div', { className: 'pd-docpane' }, list, body)
    }

    function DocEditor({ t, kind, initial, saving, conflict, onCancel, onReload, onSave }) {
      const [name, setName] = React.useState(initial.mode === 'new' ? '' : initial.name)
      const [content, setContent] = React.useState(initial.content)
      const isNew = initial.mode === 'new'
      return h(
        'div',
        { className: 'pd-docview' },
        conflict !== null
          ? h(
              'div',
              { className: 'pd-banner pd-banner-slim' },
              h('strong', null, t('docs.conflict')),
              h('div', null, t('docs.conflict.hint')),
              h(
                'button',
                { type: 'button', className: 'pd-btn pd-btn-small', onClick: onReload },
                t('action.reload'),
              ),
            )
          : null,
        isNew
          ? h(
              Field,
              { label: t('docs.name') },
              h('input', {
                className: 'pd-input',
                value: name,
                placeholder: t('docs.name.placeholder'),
                onChange: (event) => setName(event.target.value),
              }),
            )
          : h('h2', { className: 'pd-docview-title' }, initial.name),
        h(Field, { label: t('docs.content') }, h('textarea', {
          className: 'pd-textarea',
          value: content,
          onChange: (event) => setContent(event.target.value),
        })),
        h(
          'div',
          { className: 'pd-row-end' },
          h('button', { type: 'button', className: 'pd-btn', onClick: onCancel, disabled: saving }, t('action.cancel')),
          h(
            'button',
            {
              type: 'button',
              className: 'pd-btn pd-btn-primary',
              disabled: saving || (isNew && name.trim() === ''),
              onClick: () => onSave(isNew ? name.trim() : initial.name, content, isNew ? undefined : initial.hash),
            },
            saving ? t('loading') : t('action.save'),
          ),
        ),
        h('div', { className: 'pd-footer-hint' }, t(`groupShort.${kind}`)),
      )
    }

    function BoardTab({ t, projectId, board, page, onChanged }) {
      const [author, setAuthor] = React.useState(() => {
        try {
          return window.localStorage.getItem('project-docs.author') ?? ''
        } catch {
          return ''
        }
      })
      const [kind, setKind] = React.useState('note')
      const [text, setText] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      async function post() {
        if (text.trim() === '') return
        setBusy(true)
        setError(null)
        try {
          const name = author.trim() === '' ? (board === 'agent' ? 'agent' : 'human') : author.trim()
          await apiPost('message', { project: projectId, board, author: name, message_kind: kind, text })
          try {
            window.localStorage.setItem('project-docs.author', name)
          } catch {
            /* private mode */
          }
          setText('')
          if (typeof onChanged === 'function') await onChanged()
        } catch (failure) {
          setError(t('error.post', { error: errorText(failure) }))
        } finally {
          setBusy(false)
        }
      }

      const entries = page !== undefined && page !== null && Array.isArray(page.entries) ? page.entries : []
      return h(
        'div',
        { className: 'pd-scroll' },
        h('div', { className: 'pd-note', style: { marginBottom: 10 } }, board === 'human' ? t('board.human.hint') : t('board.agent.hint')),
        h(
          'div',
          { className: 'pd-card' },
          h(
            'div',
            { className: 'pd-row' },
            h(
              'div',
              { style: { width: 150 } },
              h(Field, { label: t('board.author') }, h('input', {
                className: 'pd-input',
                value: author,
                placeholder: board === 'agent' ? 'agent' : 'human',
                onChange: (event) => setAuthor(event.target.value),
              })),
            ),
            h(
              'div',
              { style: { width: 132 } },
              h(
                Field,
                { label: t('board.kind') },
                h(
                  'select',
                  { className: 'pd-select', value: kind, onChange: (event) => setKind(event.target.value) },
                  MESSAGE_KINDS.map((value) => h('option', { key: value, value }, t(`kind.${value}`))),
                ),
              ),
            ),
          ),
          h(Field, { label: t('board.text') }, h('textarea', {
            className: 'pd-textarea',
            value: text,
            placeholder: t('board.text.placeholder'),
            onChange: (event) => setText(event.target.value),
          })),
          error !== null ? h('div', { className: 'pd-banner' }, h('strong', null, '!'), h('div', null, error)) : null,
          h(
            'div',
            { className: 'pd-row-end' },
            h(
              'button',
              { type: 'button', className: 'pd-btn pd-btn-primary', disabled: busy || text.trim() === '', onClick: () => void post() },
              busy ? t('loading') : t('action.post'),
            ),
          ),
        ),
        page !== undefined && page !== null && page.total > 0
          ? h('div', { className: 'pd-note', style: { margin: '4px 0 10px' } }, t('board.total', { count: page.total, shown: entries.length }))
          : null,
        entries.length === 0
          ? h('div', { className: 'pd-empty' }, t('empty.board'))
          : h(
              'div',
              { className: 'pd-entries' },
              entries.map((entry) =>
                h(
                  'div',
                  { key: entry.id, className: 'pd-card' },
                  h(
                    'div',
                    { className: 'pd-entry-head' },
                    h('span', { className: 'pd-entry-author' }, entry.author || '?'),
                    h('span', { className: `pd-badge${entry.kind === 'claim' ? ' pd-badge-claim' : entry.kind === 'warning' ? ' pd-badge-warn' : ''}` }, t(`kind.${entry.kind}`)),
                    h('span', null, formatTime(entry.at)),
                  ),
                  h('div', { className: 'pd-entry-text' }, h(Markdown, { text: entry.text })),
                ),
              ),
            ),
      )
    }

    function ToolsTab({ t, projectId, projects, onChanged }) {
      const [query, setQuery] = React.useState('')
      const [tools, setTools] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [form, setForm] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [copied, setCopied] = React.useState(null)

      const load = React.useCallback(
        async (needle) => {
          setLoading(true)
          setError(null)
          try {
            const body = await apiGet('tools', { project: 'all', query: needle ?? '' })
            setTools(body.tools)
          } catch (failure) {
            setError(t('error.load', { error: errorText(failure) }))
          } finally {
            setLoading(false)
          }
        },
        [t],
      )

      React.useEffect(() => {
        void load('')
      }, [load])

      async function submit() {
        if (form === null) return
        setBusy(true)
        setError(null)
        try {
          await apiPost('tool', {
            project: form.project,
            tool_name: form.name,
            tool_summary: form.summary,
            tool_command: form.command,
            tool_usage: form.usage,
            tool_tags: form.tags
              .split(',')
              .map((tag) => tag.trim())
              .filter((tag) => tag !== ''),
          })
          setNotice(t('tools.added'))
          setForm(null)
          await load(query)
          if (typeof onChanged === 'function') onChanged()
        } catch (failure) {
          setError(t('tools.saveFailed', { error: errorText(failure) }))
        } finally {
          setBusy(false)
        }
      }

      function copy(text) {
        try {
          void navigator.clipboard.writeText(text)
          setCopied(text)
          window.setTimeout(() => setCopied(null), 1500)
        } catch {
          setCopied(null)
        }
      }

      const rows = tools ?? []
      return h(
        'div',
        { className: 'pd-scroll' },
        h(
          'div',
          { className: 'pd-row', style: { marginBottom: 12 } },
          h('input', {
            className: 'pd-input',
            style: { flex: 1, minWidth: 200 },
            value: query,
            placeholder: t('tools.search.placeholder'),
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void load(query)
            },
          }),
          h('button', { type: 'button', className: 'pd-btn', onClick: () => void load(query), disabled: loading }, t('tools.search')),
          h(
            'button',
            {
              type: 'button',
              className: 'pd-btn pd-btn-primary',
              onClick: () =>
                setForm({
                  project: projectId,
                  name: '',
                  summary: '',
                  command: '',
                  usage: '',
                  tags: '',
                }),
            },
            t('action.register'),
          ),
        ),
        notice !== null ? h('div', { className: 'pd-note', style: { marginBottom: 10 } }, notice) : null,
        error !== null ? h('div', { className: 'pd-banner' }, h('strong', null, '!'), h('div', null, error)) : null,
        form !== null
          ? h(
              'div',
              { className: 'pd-card' },
              h('div', { className: 'pd-label', style: { marginBottom: 8 } }, t('tools.registerTitle')),
              h(
                'div',
                { className: 'pd-row' },
                h(
                  'div',
                  { style: { flex: 1, minWidth: 150 } },
                  h(Field, { label: t('tools.name') }, h('input', {
                    className: 'pd-input',
                    value: form.name,
                    placeholder: t('tools.name.placeholder'),
                    onChange: (event) => setForm({ ...form, name: event.target.value }),
                  })),
                ),
                h(
                  'div',
                  { style: { width: 170 } },
                  h(
                    Field,
                    { label: t('project.title') },
                    h(
                      'select',
                      {
                        className: 'pd-select',
                        value: form.project,
                        onChange: (event) => setForm({ ...form, project: event.target.value }),
                      },
                      projects.map((project) => h('option', { key: project.id, value: project.id }, project.title)),
                    ),
                  ),
                ),
              ),
              h(Field, { label: t('tools.summary') }, h('input', {
                className: 'pd-input',
                value: form.summary,
                placeholder: t('tools.summary.placeholder'),
                onChange: (event) => setForm({ ...form, summary: event.target.value }),
              })),
              h(Field, { label: t('tools.command') }, h('input', {
                className: 'pd-input',
                value: form.command,
                placeholder: t('tools.command.placeholder'),
                onChange: (event) => setForm({ ...form, command: event.target.value }),
              })),
              h(Field, { label: t('tools.usage') }, h('textarea', {
                className: 'pd-textarea',
                style: { minHeight: 64 },
                value: form.usage,
                placeholder: t('tools.usage.placeholder'),
                onChange: (event) => setForm({ ...form, usage: event.target.value }),
              })),
              h(Field, { label: t('tools.tags') }, h('input', {
                className: 'pd-input',
                value: form.tags,
                onChange: (event) => setForm({ ...form, tags: event.target.value }),
              })),
              h(
                'div',
                { className: 'pd-row-end' },
                h('button', { type: 'button', className: 'pd-btn', onClick: () => setForm(null), disabled: busy }, t('action.cancel')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'pd-btn pd-btn-primary',
                    disabled: busy || form.name.trim() === '' || form.summary.trim() === '' || form.command.trim() === '',
                    onClick: () => void submit(),
                  },
                  busy ? t('loading') : t('action.register'),
                ),
              ),
            )
          : null,
        rows.length === 0 && !loading
          ? h('div', { className: 'pd-empty' }, h('div', null, t('empty.tools')), h('div', { className: 'pd-footer-hint' }, t('empty.tools.hint')))
          : null,
        rows.map((tool) =>
          h(
            'div',
            { key: `${tool.project}/${tool.id}`, className: 'pd-card' },
            h(
              'div',
              { className: 'pd-tool-card-head' },
              h('span', { className: 'pd-tool-name' }, tool.name),
              h('span', { className: 'pd-badge pd-badge-brand' }, tool.project),
              tool.tags.map((tag) => h('span', { key: tag, className: 'pd-badge' }, tag)),
            ),
            h('div', { className: 'pd-tool-summary' }, tool.summary),
            h(
              'div',
              { className: 'pd-tool-line' },
              h('span', null, h('code', { className: 'pd-tool-code' }, tool.command || t('tools.noCommand'))),
              h(
                'button',
                { type: 'button', className: 'pd-btn pd-btn-small', onClick: () => copy(tool.command) },
                copied === tool.command ? t('action.copied') : t('action.copy'),
              ),
            ),
            tool.usage ? h('div', { className: 'pd-tool-usage' }, tool.usage) : null,
          ),
        ),
      )
    }

    function NewProjectForm({ t, onCreated, onCancel }) {
      const [title, setTitle] = React.useState('')
      const [id, setId] = React.useState('')
      const [root, setRoot] = React.useState('')
      const [summary, setSummary] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      async function create() {
        setBusy(true)
        setError(null)
        try {
          const body = await apiPost('project', { title, id: id.trim() === '' ? undefined : id.trim(), root, summary })
          onCreated(body.project)
        } catch (failure) {
          setError(t('error.save', { error: errorText(failure) }))
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'pd-side-form' },
        h(Field, { label: t('project.title') }, h('input', {
          className: 'pd-input',
          value: title,
          onChange: (event) => setTitle(event.target.value),
        })),
        h(Field, { label: t('project.id') }, h('input', {
          className: 'pd-input',
          value: id,
          onChange: (event) => setId(event.target.value),
        })),
        h(Field, { label: t('project.root') }, h('input', {
          className: 'pd-input',
          value: root,
          placeholder: t('project.root.placeholder'),
          onChange: (event) => setRoot(event.target.value),
        })),
        h(Field, { label: t('project.summary') }, h('input', {
          className: 'pd-input',
          value: summary,
          placeholder: t('project.summary.placeholder'),
          onChange: (event) => setSummary(event.target.value),
        })),
        error !== null ? h('div', { className: 'pd-banner' }, h('strong', null, '!'), h('div', null, error)) : null,
        h(
          'div',
          { className: 'pd-row-end' },
          h('button', { type: 'button', className: 'pd-btn pd-btn-small', onClick: onCancel, disabled: busy }, t('action.cancel')),
          h(
            'button',
            { type: 'button', className: 'pd-btn pd-btn-small pd-btn-primary', disabled: busy || title.trim() === '', onClick: () => void create() },
            busy ? t('loading') : t('action.create'),
          ),
        ),
      )
    }

    function ProjectEditor({ t, project, onSaved, onCancel }) {
      const [title, setTitle] = React.useState(project.title)
      const [root, setRoot] = React.useState(project.root ?? '')
      const [summary, setSummary] = React.useState(project.summary ?? '')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      async function save() {
        setBusy(true)
        setError(null)
        try {
          await apiPost('project', { id: project.id, title, root, summary, seed: false })
          onSaved()
        } catch (failure) {
          setError(t('error.save', { error: errorText(failure) }))
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'pd-card' },
        h(Field, { label: t('project.title') }, h('input', { className: 'pd-input', value: title, onChange: (event) => setTitle(event.target.value) })),
        h(Field, { label: t('project.root') }, h('input', { className: 'pd-input', value: root, placeholder: t('project.root.placeholder'), onChange: (event) => setRoot(event.target.value) })),
        h(Field, { label: t('project.summary') }, h('input', { className: 'pd-input', value: summary, placeholder: t('project.summary.placeholder'), onChange: (event) => setSummary(event.target.value) })),
        error !== null ? h('div', { className: 'pd-banner' }, h('strong', null, '!'), h('div', null, error)) : null,
        h(
          'div',
          { className: 'pd-row-end' },
          h('button', { type: 'button', className: 'pd-btn pd-btn-small', onClick: onCancel, disabled: busy }, t('action.cancel')),
          h('button', { type: 'button', className: 'pd-btn pd-btn-small pd-btn-primary', disabled: busy || title.trim() === '', onClick: () => void save() }, t('action.save')),
        ),
      )
    }

    function Panel({ t }) {
      const [boot, setBoot] = React.useState({ loading: true, error: null, data: null })
      const [selectedId, setSelectedId] = React.useState(null)
      const [detail, setDetail] = React.useState({ loading: false, error: null, data: null })
      const [tick, setTick] = React.useState(0)
      const [tab, setTab] = React.useState('project')
      const [creating, setCreating] = React.useState(false)
      const [editing, setEditing] = React.useState(false)

      const reloadState = React.useCallback(async (preferId) => {
        setBoot((current) => ({ ...current, loading: true, error: null }))
        try {
          const body = await apiGet('state')
          setBoot({ loading: false, error: null, data: body })
          setSelectedId((current) => {
            if (preferId !== undefined && body.projects.some((project) => project.id === preferId)) return preferId
            if (current !== null && body.projects.some((project) => project.id === current)) return current
            return body.projects.length > 0 ? body.projects[0].id : null
          })
        } catch (failure) {
          setBoot({ loading: false, error: t('error.load', { error: errorText(failure) }), data: null })
        }
      }, [t])

      React.useEffect(() => {
        void reloadState()
      }, [reloadState])

      React.useEffect(() => {
        if (selectedId === null) {
          setDetail({ loading: false, error: null, data: null })
          return undefined
        }
        let cancelled = false
        setDetail((current) => ({ ...current, loading: true, error: null }))
        apiGet('project', { id: selectedId })
          .then((body) => {
            if (!cancelled) setDetail({ loading: false, error: null, data: body })
          })
          .catch((failure) => {
            if (!cancelled) setDetail({ loading: false, error: t('error.load', { error: errorText(failure) }), data: null })
          })
        return () => {
          cancelled = true
        }
      }, [selectedId, tick, t])

      const refresh = React.useCallback(() => {
        setTick((value) => value + 1)
        void reloadState(selectedId ?? undefined)
      }, [reloadState, selectedId])

      const projects = boot.data !== null ? boot.data.projects : []
      const current = projects.find((project) => project.id === selectedId) ?? null
      const data = detail.data
      const counts = current !== null ? current.counts : undefined

      const tabs = [
        ['docs', t('tab.docs'), current !== null ? current.counts.project + current.counts.collab : 0],
        ['human', t('tab.human'), current !== null ? current.counts.human : 0],
        ['agent', t('tab.agent'), current !== null ? current.counts.agent : 0],
        ['tools', t('tab.tools'), current !== null ? current.counts.tools : 0],
      ]
      if (current !== null && current.counts.credential > 0) {
        tabs.push(['credential', t('tab.credential'), current.counts.credential])
      }

      let content = null
      if (data !== null && current !== null) {
        if (tab === 'docs') {
          content = h(DocTab, {
            key: current.id,
            t,
            projectId: current.id,
            groups: [
              { kind: 'project', docs: data.docs.project ?? [] },
              { kind: 'collab', docs: data.docs.collab ?? [] },
            ],
            onChanged: refresh,
          })
        } else if (tab === 'credential') {
          content = h(DocTab, {
            key: `${current.id}:credential`,
            t,
            projectId: current.id,
            groups: [{ kind: 'credential', docs: data.docs.credential ?? [] }],
            hint: t('credential.hint'),
            onChanged: refresh,
          })
        } else if (tab === 'human' || tab === 'agent') {
          content = h(BoardTab, {
            key: `${current.id}:${tab}`,
            t,
            projectId: current.id,
            board: tab,
            page: data.boards[tab],
            onChanged: async () => {
              refresh()
            },
          })
        } else {
          content = h(ToolsTab, { t, projectId: current.id, projects, onChanged: refresh })
        }
      }

      return h(
        'div',
        { className: 'pd-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h(
          'div',
          { className: 'pd-head' },
          h(
            'div',
            { style: { minWidth: 0 } },
            h('h1', { className: 'pd-title' }, t('panel')),
            h('div', { className: 'pd-sub' }, t('panel.subtitle', { dir: boot.data !== null ? boot.data.storeDir : '' })),
          ),
          h(
            'div',
            { className: 'pd-head-actions' },
            h('button', { type: 'button', className: 'pd-btn', onClick: refresh }, t('action.refresh')),
            h(
              'button',
              {
                type: 'button',
                className: 'pd-btn pd-btn-primary',
                onClick: () => {
                  setCreating((value) => !value)
                },
              },
              t('action.newProject'),
            ),
          ),
        ),
        boot.error !== null
          ? h(
              'div',
              { className: 'pd-scroll' },
              h('div', { className: 'pd-banner' }, h('strong', null, '!'), h('div', null, boot.error)),
            )
          : h(
              'div',
              { className: 'pd-body' },
              h(
                'aside',
                { className: 'pd-side' },
                h('div', { className: 'pd-side-title' }, t('panel')),
                projects.length === 0 ? h('div', { className: 'pd-note', style: { padding: '0 8px' } }, t('empty.projects')) : null,
                projects.map((project) =>
                  h(
                    'button',
                    {
                      key: project.id,
                      type: 'button',
                      className: 'pd-proj',
                      'data-active': project.id === selectedId ? 'true' : 'false',
                      onClick: () => {
                        setSelectedId(project.id)
                        setEditing(false)
                      },
                    },
                    h('span', { className: 'pd-proj-name' }, project.title),
                    h(
                      'span',
                      { className: 'pd-proj-meta' },
                      `${project.counts.project + project.counts.collab} 文档${project.counts.credential > 0 ? ` · ${project.counts.credential} 凭证` : ''} · ${project.counts.human + project.counts.agent} 留言 · ${project.counts.tools} 工具${Array.isArray(project.claims) && project.claims.length > 0 ? ` · ${t('meta.claims', { n: project.claims.length })}` : ''}`,
                    ),
                  ),
                ),
                creating
                  ? h(NewProjectForm, {
                      t,
                      onCreated: (project) => {
                        setCreating(false)
                        setSelectedId(project.id)
                        void reloadState(project.id)
                      },
                      onCancel: () => setCreating(false),
                    })
                  : null,
                h('div', { className: 'pd-footer-hint' }, t('empty.projects.hint')),
              ),
              h(
                'main',
                { className: 'pd-main' },
                boot.loading && boot.data === null
                  ? h('div', { className: 'pd-empty' }, t('panel.loading'))
                  : current === null
                    ? h(
                        'div',
                        { className: 'pd-empty' },
                        h('div', null, t('empty.projects')),
                        h('div', { className: 'pd-footer-hint' }, t('empty.projects.hint')),
                      )
                    : h(
                        'div',
                        { className: 'pd-project' },
                        h(
                          'div',
                          { className: 'pd-project-head' },
                          h('h2', { className: 'pd-project-title' }, current.title),
                          h(
                            'div',
                            { className: 'pd-project-lines' },
                            h('span', null, current.root ? `${current.root}` : ''),
                            h('span', null, current.summary !== '' ? current.summary : t('project.noSummary')),
                            h('span', { className: 'pd-note' }, h(CountsLine, { t, counts })),
                          ),
                          h(
                            'div',
                            { className: 'pd-project-actions' },
                            h(
                              'button',
                              { type: 'button', className: 'pd-btn pd-btn-small', onClick: () => setEditing((value) => !value) },
                              t('project.edit'),
                            ),
                          ),
                        ),
                        editing
                          ? h(
                              'div',
                              { style: { padding: '10px 20px 0' } },
                              h(ProjectEditor, {
                                t,
                                project: current,
                                onSaved: () => {
                                  setEditing(false)
                                  refresh()
                                },
                                onCancel: () => setEditing(false),
                              }),
                            )
                          : null,
                        data !== null && Array.isArray(data.claims) && data.claims.length > 0
                          ? h(
                              'div',
                              { style: { padding: '0 20px' } },
                              h(
                                'div',
                                { className: 'pd-banner pd-banner-warn pd-banner-slim' },
                                h('strong', null, '⚠'),
                                h(
                                  'div',
                                  null,
                                  h('div', null, t('claims.warning', { n: data.claims.length })),
                                  data.claims.map((claim) =>
                                    h(
                                      'div',
                                      { key: claim.id },
                                      `${claim.agent} → ${claim.scope} · ${t('claims.expires', { at: claim.expiresAt })}`,
                                    ),
                                  ),
                                ),
                              ),
                            )
                          : null,
                        h(
                          'div',
                          { className: 'pd-tabs' },
                          tabs.map(([value, label, count]) =>
                            h(
                              'button',
                              {
                                key: value,
                                type: 'button',
                                className: 'pd-tab',
                                'data-active': tab === value ? 'true' : 'false',
                                onClick: () => setTab(value),
                              },
                              label,
                              h('span', { className: 'pd-tab-count' }, String(count ?? 0)),
                            ),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'pd-content' },
                          detail.error !== null
                            ? h('div', { className: 'pd-scroll' }, h('div', { className: 'pd-banner' }, h('strong', null, '!'), h('div', null, detail.error)))
                            : detail.loading && data === null
                              ? h('div', { className: 'pd-empty' }, t('loading'))
                              : content,
                        ),
                      ),
              ),
            ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'project-docs: dictionaries')
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 40,
                  locale: NS,
                  label: () => t('panel'),
                },
                Icon,
              ),
            ),
          'project-docs: sidebar entry',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('main', () =>
              ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Panel),
            ),
          'project-docs: main panel',
        )
        ctx.effect(installProgressChips, 'project-docs: progress chips')
      },
    }
  },
})
