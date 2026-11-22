# dsh-project-docs

多 Agent 协作文档中心，为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供**可验证的编程纪律**。

它解决一个具体问题：多个 Agent 并行改同一个工作区时，谁在读文档、谁在改哪块、结论有没有证据——全靠自觉。这个插件把这些变成流程里无法忽略的约束，而不是提示词里的一句建议。

## 特性

| 能力 | 说明 |
| --- | --- |
| **文档库** | 项目文档 / 合作文档 / 凭证区 / 双留言板 / 公共工具库，落在同一处，写入走 CAS 防覆盖 |
| **统一信息库** | 跨项目共享事实（端口、磁盘、缓存配额、计划任务）带版本控制与强制留痕 |
| **纪律门禁** | 写门禁、读文档门禁、证据门禁、断路器、等待与提问纪律，全部由代码强制执行 |
| **跨会话协作** | 会话身份标签、读游标、跨会话消息投递、接手摘要 |
| **自检工具** | 隐私扫描器（15 类）、完整性校验器（防批量编辑损坏）、9 套回归测试 |

## 安装

```js
// 通过插件管理器，指向本地目录或包名
plugin_manager({ action: "install_bundle", target: "C:\\path\\to\\dsh-project-docs" })
```

安装后重启 Harness。配置在 DSH profile 的 `cordis.patch.yml`：

```yaml
- id: project-docs
  name: '@local/dsh-project-docs'
  config:
    storeDir: ''          # 留空回退 <DSH_HOME>/project-docs；或设 DSH_DOCS_STORE
    disciplineGuard: true
    claimGuard: true
    proofGate: true
    docNeedGate: true
    sleepGuard: true
    askGuard: true
    estimateGate: true
```

完整配置项见 [配置](#配置)。卸载用插件管理器的 `remove_bundle`。

## 快速上手

**对人类**：装好后侧边栏出现「项目文档」图标，点开是整页面板。左侧项目列表，右侧按文档类别分页。

**对 Agent**：新会话会自动获得两个工具与一段纪律提示——

- `project_docs`（读）：`list_projects` / `list_docs` / `read_doc` / `search_docs` / `list_messages` / `find_tools` / `list_claims`
- `project_docs_write`（写）：`write_doc` / `append_doc` / `post_message` / `register_tool` / `create_project` / `claim_work` / `release_claim` / `verify_deliverable` / `trace_report` / `bundle_check`
- `kb`（统一信息库）：`status` / `list` / `get` / `history` / `view` / `create_resource` / `record_change` / `audit` / `gate` / `refresh_views`

## 数据布局

```
<storeDir>/
  projects/<id>/project.json            项目元信息
  projects/<id>/docs/project/*.md       项目文档（是什么 / 入口 / 现状）
  projects/<id>/docs/collab/*.md        合作文档（红线 / 占用 / 不要回退的修复）
  projects/<id>/docs/credential/*.md    凭证区（按需读取，不进常规阅读流）
  projects/<id>/archive/                已归档（不展示，可恢复）
  projects/<id>/board/{human,agent}/    留言板（每贴一个不可变文件）
  projects/<id>/tools/*.json            公共工具库登记
  projects/<id>/claims/                 活跃认领（带过期租约）
  kb/                                   统一信息库（见下）
```

两个防覆写机制：

1. **留言板 append-only** —— 每条留言是独立不可变 JSON 文件，并发发帖不会互相覆盖。
2. **文档 compare-and-set** —— 覆盖已有文档必须携带 `read_doc` 返回的 `base_hash`，不匹配则拒绝并回传当前内容。

## 统一信息库

项目文档按项目分开，但**共享资源只有一个**：同一台 VPS、同一批端口、同一块盘被多个项目同时依赖。各自记在各处，就会出现「A 把缓存设成 40G，B 划走 5GB，最后只剩 35G，而下一个 Agent 按 40G 去规划」。

`kb/` 是给这类资源的唯一真相源：

```
kb/
  RESOURCES.json                     当前值与索引
  rev/<key>/<rev>-<hash>.json        不可变修订（一次改动一个文件）
  changes/<time>-<key>-<rev>.json    变更流水（append-only）
  CHANGELOG.md                       自动生成，勿手改
  views/<projectId>.json             每个项目的消费视图
  LOCK.json                          跨进程写锁
```

四条强制约束：

1. **改动必须留痕** —— `record_change` 要求 `author` + `reason`（≥8 字）+ `projects`，缺一则拒绝；旧值原样存档。
2. **只追加** —— 修订文件用 `O_EXCL` 创建，同一修订号不可能写两份；`expect_revision` 不符则回传当前值并拒绝。
3. **阶段更新强制** —— 每完成一个阶段要 `audit` 登记核对，否则 `gate` 拒绝。别人在你之后改了值，你之前的核对自动失效。
4. **消费关系只增不减** —— B 划走 5GB 后，即使 C 后来写自己的配额，B 仍在依赖列表里。

冲突不自行裁定：两个项目文档说法不一致时，以「待人工裁定」入库并写明各方原话，由人拍板。

## 编程纪律

插件通过 `ctx.systemPrompt.section()` 给每个会话注入纪律段落，并通过 `tools.guard()` 与回合边界事件强制执行。要点：

- **动手前先读文档** —— 没读 `PROJECT.md` / `COLLAB.md` 就写文件会被拒
- **不要问文档里已有的东西** —— 询问已写明的背景，或开场断言项目事实，会被 steer 打回一次
- **并行先认领** —— 用 `claim_work` 登记「谁 / 做什么 / 只动哪里」，他人认领期间禁止写入
- **交付要证据** —— 说「已完成」前必须 `verify_deliverable` 登记真实请求 / 物理文件 / 环境一致三维度
- **同一个坑不许撞两次** —— 同种失败连续 2 次触发断路器，须用 `trace_report` 提交消费端调用栈才解锁
- **等待不是推进** —— 超时参数过大会被拒；命令内前台 `sleep` 超过 5 秒会被拒
- **按规模决定计划** —— ≤5 分钟直接做、5–20 分钟先展示计划、>20 分钟等批准
- **提问要好答** —— 必须带选项，一次 1–3 个，推荐项在前

完整纪律见 [DISCIPLINE.md](docs/DISCIPLINE.md)。

## 自检工具

```bash
npm test                  # 9 套测试，203 项
npm run privacy           # 隐私扫描器
npm run check             # privacy + test（prepublishOnly 也会跑）

node scripts/verify-integrity.mjs snapshot                       # 改前快照
node scripts/verify-integrity.mjs verify --changed "a.js,b.js"   # 改后校验
node scripts/kb-scan.mjs                                         # 跨项目一致性体检
```

**隐私扫描器**覆盖 15 类：绝对路径、公网 IP、IPv6、host:port、私有域名、仓库 URL、邮箱、手机号、微信/QQ 号、私钥、API 令牌、JWT、SSH 公钥、数据库连接串、明文密码。每类都有正反两向回归测试——加白名单导致漏报会让测试失败，而不是依赖人工复查。

**完整性校验器**针对批量编辑损坏：记录改前快照，改后检查「未声明改动 + 语法损坏」并指出行号。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `storeDir` | 空（回退 `<DSH_HOME>/project-docs`） | 文档库根目录 |
| `disciplinePrompt` | `true` | 是否注入纪律段落 |
| `disciplineGuard` | `true` | 新 Agent 首次工具调用拦截一次 |
| `disciplineGuardMode` | `early` | `write` 则只拦首次 `write`/`edit` |
| `claimGuard` | `true` | 他人认领期间拒绝本会话写入 |
| `supervisor` | `true` | 每 Agent 动态提示上下文 |
| `supervisorReviewMinutes` | `25` | 多久没碰文档提醒复查 |
| `supervisorCurationMinutes` | `120` | 多久提醒整理过时文档 |
| `supervisorCollabMinutes` | `20` | 同项目多认领时提醒同步 |
| `requireDocsBeforeWrite` | `true` | 没读文档不许写 |
| `docNeedGate` | `true` | 未读文档却问背景 / 断言事实时 steer |
| `timeoutGuard` | `true` | 拒绝超阈值超时参数一次 |
| `timeoutWarnAboveSeconds` | `120` | 超时阈值 |
| `sleepGuard` | `true` | 拒绝前台长暂停命令 |
| `askGuard` | `true` | 要求提问带选项 |
| `estimateGate` | `true` | 按时长档位检查计划 |
| `linkGuard` | `true` | 改部署源时提示链路三问 |
| `circuitBreaker` | `true` | 同种失败 2 次跳闸 |
| `proofGate` | `true` | 无证据不许说「已完成」 |
| `breakerDebug` | `false` | 把拦截详情写入 trace 文件 |

## 目录

```
index.js               Host 半：路由、工具注册、各类门禁
store.js               文档库存储层（纯 Node，无 Cordis 依赖）
kb.js                  统一信息库（版本控制 / 留痕 / 门禁）
client.js              侧边栏面板
session-bus.js         跨会话消息选择规则
handoff-brief.js       接手摘要
doc-need.js            「没读文档就问/断言」识别
estimate-policy.js     按规模决定计划
sleep-policy.js        长暂停拒绝
ask-policy.js          提问形状检查
timeout-policy.js      超时判定
evidence-policy.js     交付证据三维度
link-policy.js         部署链路检测
circuit-breaker.js     失败指纹与跳闸
workflow.js            开发工作流与计划门禁
bundle-integrity.js    打包完整性
claims-guard.js        认领归属判定
scripts/               自检脚本（隐私 / 完整性 / 一致性）
test-*.mjs             9 套测试
docs/                  实现记录与详细纪律
```

## 许可

[MIT](LICENSE)

---

实现细节、逐项实测记录与历史事故分析见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。
