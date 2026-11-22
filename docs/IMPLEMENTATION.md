# 实现与验证记录

本文件保存 README 曾经承载的**开发者视角记录**：逐项实测过程、历史事故、实现细节。
面向使用者的说明在 [README](../README.md)；纪律全文在 [DISCIPLINE.md](DISCIPLINE.md)。

内容按日期组织，越靠后越新。

---

## 验证清单（人工与子代理实测）

以下每条都是真实执行过的验证，保留原始观察结论以便日后回归。

### 1. 面板与工具注册

- 侧边栏出现「项目文档」图标，点开是整页面板。
- `cordis_inspect_query`（client / Slots，root=`sidebar.panellist`）能看到 `project-docs` 占用者；`main` 能看到同名 key。
- 新会话里工具表出现 `project_docs` 与 `project_docs_write`。

### 2. 存储层与守卫纯函数

`node test-store.mjs` 覆盖 CAS、append-only、凭证分区、跨项目工具检索、路径穿越拒绝、
撕裂元信息自愈、占用认领的登记 / 可见 / 按 agent 释放 / 过期自动清理 / 用 claim_id 更新进度并续租 /
不传 ttl 保留剩余租期 / 禁止改他人认领 / 双 agent 互相可见，`projectForContext` 的嵌套项目优先与
参数路径定位、`claimDecision` 判定矩阵、`searchDocs` 的现役命中 / 归档检索与排序 / 项目过滤 /
关闭归档 / 空关键词拒绝、`postMessage` 的 `to` 收件人、`timeout-policy` 的多种超时键与
秒/毫秒识别 / 判定矩阵 / 时长措辞。

### 3. 纪律生效（2026-10-18 起）

- 新会话的系统提示里能看到「项目文档纪律」段落。
- 新 Agent 第一次工具调用就被守卫拦住、提示一次后放行
  （实测：第 1 步 write 被拒且未落盘，第 2 步 list_projects 成功，第 3 步 write 成功，无残留）。
- 2026-10-19 把拦截点从「首次写文件」提前到「首次工具调用」并持久化守卫状态。

### 4. 认领门禁（2026-10-19 手工实测）

他人活跃认领时 `write` 与 `ops_bash` 均被拒、提示里带对方 agent 与 scope；
`release_claim` 后重新被拦；本会话自己 `claim_work` 后放行；认领清空后第一次写提示、第二次放行。

### 5. 文档监督（2026-10-19 子代理实测）

新子代理在没读文档时用 `ops_bash` 写文件被拒，提示以「项目文档门禁：动 X 之前先读它的文档…」开头；
`read_doc` 读 `PROJECT.md` 后同一条命令立刻成功；该子代理的运行时上下文里确实出现
「**文档监督：本会话还没查项目文档**」一行。

### 6. `search_docs`（2026-10-19 子代理实测）

同一会话里按关键词检索能返回现役与 `[已归档]` 文档，归档命中排后；
零命中给出「库里没有现成结论，可以放心从头研究并回写」提示；`project` 过滤生效；空关键词被拒。

### 7. 认领即协作（2026-10-19 子代理实测）

`claim_work` 返回里出现「⚠ 本项目还有 N 个 agent 也在动」+ 对方 scope / 进度 / 下一步 + 三步协作要求；
用 `claim_id` 更新后返回「已更新」并带 progress / next_step（不传 ttl 时租期保留）；
`post_message` 的 `to` 在留言板显示 `agent-a → agent-b`；`list_claims` 多条时给出「这就是你的协作对象」提示。

### 8. 协作提醒注入（2026-10-19 子代理实测）

agent 认领后**下一次模型组装**的 system prompt 里出现
`**协作提醒：项目 X 上你和 agent-a、agent-b… 同时有认领**`（带对方 scope / 进度 / 下一步）。

> 早期用 `systemPrompt.context` 注册时该提醒不会在运行中刷新，改为作用域
> `system-prompt/assemble` waterfall 后才实测通过。

### 9. 超时守卫（2026-10-21 子代理实测）

首次 `ops_bash` + `timeoutMs: 300000` 被拒，错误以「超时纪律：这次调用要求等 5.0 分钟…」开头，
并列出「并发 → 更快的等价做法 → 才等待」三步；完全相同的第二次调用放行；`timeoutMs: 5000` 不拦。

### 10. 四条交付纪律（2026-11-01 实测）

- **`verify_deliverable`**：`evidence` 只有空话 → 拒，错误以「未检测到物理端到端验证证据…仍缺：」开头
  并列出客户端视角 / 物理文件 / 环境一致三维度；正例贴 `curl -sS -i` 的状态行 + `ls -l` 字节数 +
  `md5sum` 哈希 → 登记成功。
- **`bundle_check`**：源目录 3 项 vs 包内 1 项、必含 `config,assets` →
  「打包完整性核验失败…分类为空（整块漏掉）：assets」；`.git` / `node_modules` 被正确忽略。
- **断路器**：同一失败命令连两次 → `write` 被拦，报「死循环断路器已触发…现在禁止继续写补丁」+ Trace Mode
  三步；`trace_report` 负例（「我改了一下代码」）被拒，正例（真实文件:行号 + 真实日志两行 + 调用栈）→
  「断路器已解锁」；解锁后同路径 `write` 成功。
- **链路三问**：`write` 到部署源 → trace 记录注入原文
  「**部署链路提醒：你改动的东西不会自动生效**…」。注意 Windows 反斜杠路径不命中，需正斜杠。

### 11. 断路器修复前后对比（2026-11-01）

修复前 `.breakers/` 目录从未生成——`ops_bash` 失败时 `isError` 恒为 `false`，真实状态在
`result.value` 的 JSON 里；加 `toolFailed()` 后 trace 里出现 `"isError":false,"failed":true`，跳闸生效。

### 12. 开发工作流（借鉴 obra/superpowers，2026-11-21）

`node test-workflow.mjs` 覆盖 14 项：`workflowPrompt` 默认注册 `project-docs-workflow` 段
（`order: 800`），`workflowPrompt: false` 时不注册；`planGate` 在无计划时拦截首次 `write` 并返回
`PLAN_GATE_MESSAGE`、同一 agent 只提醒一次、只读工具 / 子代理 / 会话日志已有计划 /
`tools/result` 观测到计划后均放行、`planGate: false` 时不拦截。

> **注意**：插件是软链，代码改动要等 Harness 重载才在真实会话里生效；
> 真实会话系统提示里出现该段需在重载后开新会话确认。

---

## 统一信息库的并发锁缺陷（2026-11-22）

连续跑 `test-kb.js` 时约每 8–10 次出现一次「修订号出现重复」。这是真缺陷，会导致一条修订历史被覆盖。

**两处根因（`kb.js` 的 `withLock`）**

1. 锁文件用 `O_EXCL` 创建后、写入 owner 之前存在空窗期。此时 `readJson` 返回 `undefined`，
   旧判据 `!Number.isFinite(since)` 判为 stale，于是删除了**别人的**活动锁，第二个写者进入，
   两个写者拿到同一修订号。
2. `finally` 里无条件 `fs.rm(lock)`。若持有者超时后锁已被他人接管，这里会删掉他人的锁，
   放进第三个写者。

**修复**

- 空锁文件改用 mtime 判断年龄，超过 `LOCK_STALE_MS` 才判废弃
- 重试加 20–60ms 随机抖动，避免所有等待者同刻苏醒
- 释放前比对 token，只删自己持有的锁

**验证**：连续 18 次跑 `test-kb.js` → 0 失败。

---

## 进度锚点渲染（2026-10-19）

纪律要求模型在工具调用前写 `**下一步：…**` / `**本批：…**`。客户端半区（`client.js` 的
`installProgressChips`）把这两种「整行加粗」渲染成正文之外的**胶囊标签**：灰底、圆角、小圆点前缀。

- 实现：`MutationObserver` 监听会话 DOM；命中「内容恰好是一个 `<strong>`、且以 `下一步：` 或
  `本批：` 开头的段落」就加 `pd-chip` 类。不改文本、不改 React 树、不依赖私有 class 名，
  流式输出与历史会话重放都适用。
- 已带类的节点不再处理，观察自身写入不会形成循环；插件卸载时 observer 与 `<style>` 一起清理。
- 只影响观感，不构成约束：模型仍可能不写锚点，纪律本身仍是提示词级。
- 客户端改动需**刷新页面**生效（Host 半重载不够）。
