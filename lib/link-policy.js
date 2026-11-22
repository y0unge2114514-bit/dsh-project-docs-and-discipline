/**
 * Link interrogation policy (pure functions, no Cordis, no I/O).
 *
 * The failure this targets: a model edits a local file and assumes the change is
 * live for the real consumer — a C# helper that reads a zip, a browser hitting
 * /var/www behind Nginx, a client that unpacks an archive. Nothing is "auto
 * effective" once there is a distribution hop in between.
 *
 * @module @local/dsh-project-docs/link-policy
 */

/** Filesystem targets that imply a deploy hop (a remote/runtime copy exists). */
const DEPLOY_TARGETS = [
  { pattern: /\/var\/www\//i, label: '/var/www（VPS 站点根）' },
  { pattern: /\/usr\/share\/nginx\/|\/etc\/nginx\//i, label: 'nginx 配置目录' },
  { pattern: /\bplugins?\/|\/plugins\//i, label: '插件目录' },
  { pattern: /\bwwwroot\b/i, label: 'wwwroot（发布根）' },
  { pattern: /\bdist\/|\/dist\b/i, label: '构建产物目录 dist/' },
  { pattern: /\bbuild\/outputs\//i, label: '构建产物目录 build/outputs/' },
  { pattern: /\bpublic\/|\/public\b/i, label: '静态发布目录 public/' },
  { pattern: /\.(?:min\.js|bundle\.js|\.css)$/i, label: '打包/压缩后的前端产物' },
  { pattern: /\.(?:zip|7z|tar|gz|jar|apk|exe|dll|so|dylib)$/i, label: '分发包 / 二进制产物' },
  { pattern: /scp|rsync|ssh\s+\S+\s+'/i, label: '远程复制命令（scp/rsync/ssh）' },
]

/** Cache layers that keep serving the old bytes after a deploy. */
const CACHE_LAYERS = [
  { pattern: /\b(?:proxy_cache|cache-control|max-age|s-maxage|expires)\b/i, label: 'HTTP 缓存头 / proxy_cache' },
  { pattern: /\bcdn\b|\bcloudflare\b|\bjsdelivr\b|\bunpkg\b/i, label: 'CDN 边缘缓存' },
  { pattern: /service[-_ ]?worker|\bsw\.js\b/i, label: 'Service Worker（客户端离线缓存）' },
  { pattern: /\betag\b|\bif-none-match\b/i, label: 'ETag / If-None-Match 条件缓存' },
  { pattern: /\b(?:cacheBuster|versionHash|\?v=)\b/i, label: '前端缓存击穿参数（?v=）' },
]

/** Client-side unpacking: the artifact is consumed only after extraction. */
const EXTRACT_LAYERS = [
  { pattern: /\bunzip\b|\bextract\b|\b解压\b|\b解包\b/i, label: '客户端解压（zip/压缩包）' },
  { pattern: /\bcopy into\b|\b复制到\b|\b覆盖到\b/i, label: '手工复制进游戏/运行时目录' },
  { pattern: /\bGodot|Minecraft|KubeJS|assets\/|\bkubejs\b/i, label: '运行时资源目录（整合包 assets/kubejs）' },
]

/** Runtime/consumer kinds, keyed by the words that reveal them in a command. */
const CONSUMER_HINTS = [
  { pattern: /Program\.cs|\bC#|\.csproj|\bwinform\b|\bWPF\b/i, label: 'C# 启动器/助手进程（会自己读压缩包与配置）' },
  { pattern: /\bnginx\b|\bapache\b|\bvps\b|\b服务器\b/i, label: 'VPS 上的 Web 服务器' },
  { pattern: /\bbrowser\b|\b浏览器\b|\bjs\b|\bhtml\b|\bfrontend\b|\b前端\b/i, label: '浏览器里的前端页面' },
  { pattern: /\bpython\b|\bserver\.js\b|\bnode\b|\bapi\b|\b后端\b/i, label: '服务端进程 / API' },
  { pattern: /\bandroid\b|\bapk\b|\b手机\b/i, label: 'Android 客户端（需重新安装才生效）' },
  { pattern: /\bbot\b|\bqq\b|\bastrbot\b/i, label: 'QQ Bot 运行时' },
]

function labelOf(list, text) {
  const hit = list.find((entry) => entry.pattern.test(text))
  return hit === undefined ? '' : hit.label
}

function allOf(list, text) {
  return list.filter((entry) => entry.pattern.test(text)).map((entry) => entry.label)
}

/**
 * Classify what a write operation touched.
 *
 * @param {object} input
 * @param {string} [input.toolName]
 * @param {object} [input.args]   tool arguments (path / command / content …)
 * @returns {{ isWrite: boolean, isDeploySource: boolean, isBinaryArtifact: boolean,
 *            hops: string[], labels: string[], consumer: string, targets: string[] }}
 */
export function classifyWrite(input = {}) {
  const toolName = String(input.toolName ?? '')
  const args = input.args !== null && typeof input.args === 'object' ? input.args : {}
  const blob = [args.path, args.file_path, args.command, args.script_path, args.cwd, args.content]
    .filter((value) => typeof value === 'string')
    .join('\n')
  const isWrite = /^(?:write|edit|multi_edit|apply_patch)$/.test(toolName) || /^(?:ops_bash|pwsh|bash)$/.test(toolName)
  const deployTargets = allOf(DEPLOY_TARGETS, blob)
  const caches = allOf(CACHE_LAYERS, blob)
  const extracts = allOf(EXTRACT_LAYERS, blob)
  const hops = [...deployTargets, ...caches, ...extracts]
  const isBinaryArtifact = /\.(?:zip|7z|tar|gz|jar|apk|exe|dll|so|dylib)$/i.test(blob)
  return {
    isWrite,
    isDeploySource: deployTargets.length > 0,
    isBinaryArtifact,
    hops,
    labels: hops,
    consumer: labelOf(CONSUMER_HINTS, blob),
    targets: Array.isArray(args.paths) ? args.paths.map(String) : [args.path, args.file_path, args.command].filter((v) => typeof v === 'string'),
  }
}

/**
 * Whether a write must trigger the link warning.
 *
 * A local edit with no distribution hop keeps working as before; an edit that
 * lands in a deploy source, a package artifact, or behind a cache/extract layer
 * must be treated as "not live until you deploy and prove it".
 *
 * @param {object} classification result of classifyWrite
 * @returns {{ warn: boolean, hops: string[] }}
 */
export function linkDecision(classification = {}) {
  const hops = Array.isArray(classification.hops) ? classification.hops : []
  const warn = classification.isDeploySource === true || classification.isBinaryArtifact === true || hops.length > 0
  return { warn, hops }
}

/**
 * The three questions the model must answer before assuming a change is live.
 *
 * @param {object} input
 * @param {string} [input.target] what was written
 * @param {string[]} [input.hops]
 * @param {string} [input.consumer]
 * @returns {string}
 */
export function threeQuestions({ target = '', hops = [], consumer = '' } = {}) {
  const who = consumer === '' ? '（自己判断：是浏览器？C# 助手？服务端内部？手机客户端？）' : consumer
  const where = hops.length === 0
    ? '本地相对路径，还是走 HTTP API / 远程路径？如是 HTTP，具体是哪个 URL、哪个参数？'
    : `中间隔着：${hops.join('、')}。具体落到哪个 URL / 目录 / 包内路径？`
  const chain = hops.length === 0
    ? '本地代码 → 构建/打包 → 部署 → 缓存 → 客户端'
    : `本地代码 → ${hops.join(' → ')}`
  return (
    '**链路三问（改了就要答，答不出说明还没搞清）**\n' +
    `1) 谁在消费你改的这个东西？${who}\n` +
    `2) 消费者去哪里找它？${where}\n` +
    `3) ${target === '' ? '这个修改' : `「${target}」`}到达最终消费者隔着几道环节？${chain}\n` +
    '只要链路上有 VPS/var/www、边缘缓存、客户端解压中的任意一层，**禁止假设它自动生效**：必须显式部署/打包/刷缓存，再拿真实证据（HTTP 状态行、线上文件 md5、解包后文件清单）证明。'
  )
}

/**
 * Warning text injected after a write that touches a distribution hop.
 *
 * @param {object} input
 * @param {string} [input.target]
 * @param {string[]} [input.hops]
 * @param {string} [input.consumer]
 * @returns {string}
 */
export function linkWarning({ target = '', hops = [], consumer = '' } = {}) {
  const hopText = hops.length === 0 ? '（本条写入未识别出中间层，仍请自查）' : hops.join('、')
  return (
    `**部署链路提醒：你改动的东西不会自动生效**${target === '' ? '' : `（${target}）`}\n` +
    `识别到的中间层：${hopText}\n\n` +
    `${threeQuestions({ target, hops, consumer })}`
  )
}

/**
 * Fingerprint a failure so repeated identical failures can be counted.
 *
 * @param {string} text
 * @returns {string} normalized fingerprint ('' when the text carries no error)
 */
export function failureFingerprint(text) {
  const source = String(text ?? '').toLowerCase()
  if (source.trim() === '') return ''
  const hasError = /error|exception|失败|错误|traceback|fatal|cannot|not found|denied|超时|timeout|refused|黑屏|白屏/.test(source)
  if (!hasError) return ''
  const normalized = source
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\b[0-9a-f]{16,}\b/g, '<hash>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/[^\p{L}\p{N}<>]+/gu, ' ')
    .trim()
  return normalized.slice(0, 160)
}

/** User negatives that mean "your last fix did not work". */
const NEGATIVE_FEEDBACK = [
  /还是(?:黑|白|没|不|一样|老样子|原样)/,
  /(?:根本|完全)?没(?:有)?(?:更新|生效|反应|变化|动)/,
  /依然(?:打不开|不行|失败|黑|白|没)/,
  /(?:打不开|加载不出|转圈|卡住|黑屏|白屏)/,
  /(?:还是|仍然|依旧)/,
]

/** True when a user message reads as negative feedback on the last attempt. */
export function isNegativeFeedback(text) {
  const source = String(text ?? '')
  if (source.trim() === '') return false
  return NEGATIVE_FEEDBACK.some((pattern) => pattern.test(source))
}

export { DEPLOY_TARGETS, CACHE_LAYERS, EXTRACT_LAYERS, CONSUMER_HINTS, NEGATIVE_FEEDBACK }
