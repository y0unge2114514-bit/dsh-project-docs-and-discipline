# v0.3.2

侧边栏能看版本、能一键拉取新版；证据门禁不再假装自己是验证。

## 新增

- **版本徽章与拉取新版**（`lib/self-update.js`）
  - 侧边栏标题右侧显示当前版本，点一下检查远端；有新版本时徽章变橙并出现「拉取新版」按钮。
  - `GET /project-docs/api/version` 返回本地版本、远端版本、是否落后、本地 HEAD 与检查来源。
  - `POST /project-docs/api/update` 需显式 `confirm: true`，否则 400 `confirm_required`。
  - 拉取只走 fast-forward，三道闸全部拒绝就报告原因，**永不 force**：`dirty_worktree`（工作区有未提交改动）/ `fetch_failed` / `not_fast_forward`。
  - 拉取成功后需要重启 DSH：插件在会话启动时加载，磁盘上的新代码不会进到正在运行的进程里。

- **HTTPS 证书链回退**
  - Node 只信任自己打包的根证书，不读系统证书库；装过 HTTPS 审计代理的机器上，`fetch` 必然失败。
  - 失败时自动回退一次系统 `curl --ssl-no-revoke`，用系统信任链再校验一遍——而不是关掉校验。返回结果里的 `via` 字段说明这次是 `fetch` 还是 `curl` 拿到的。

## 修正

- **证据门禁的口径**（`verify_deliverable`）
  - 它一直只核对证据文字里有没有写全三类要素，从不判断内容真假；此前渲染文案却写「本轮可以据实汇报已完成」。
  - 现在明确写成「登记不等于成立」：通过只说明记录完整，从不说明交付是真的。工具描述、参数说明、渲染文案、纪律提示四处同步。
  - 一段措辞漂亮的编造同样能通过，这一点写进了 README 与工具描述里，不再靠使用者猜。

- **认领门禁的路径判定**（`lib/claims-guard.js`）
  - 原实现无条件把 `/` 换成 `\` 并折叠大小写，再用子串匹配：项目根 `/srv/app/lib` 会命中另一个项目的 `/srv/app/library/x`，**该路径上认领门禁直接失效**。
  - 改为按平台选择分隔符、只在 win32/darwin 折叠大小写，并用路径边界匹配取代子串匹配。

- **隐私扫描器**：GitHub 官方子域（`raw.githubusercontent.com` 等）不再被误判为私有域名。

- **冒烟脚本**：子测试超时从 10 秒放宽到 60 秒，修掉 `npm run smoke` 里前两套冒烟把机器打热后 `test-store` 偶发超时的假失败。

## 测试

16 套、302 项，全部通过：

```
node test/test-kb.js                 18
node test/test-store.mjs             52
node test/test-session-bus.mjs       13
node test/test-handoff-brief.mjs     17
node test/test-doc-need.mjs          11
node test/test-workflow.mjs          14
node test/test-estimate.mjs          16
node test/test-sleep.mjs             16
node test/test-ask.mjs               12
node test/test-privacy-scan.mjs      37
node test/test-skill-gate.mjs        26
node test/test-link-policy.mjs       16
node test/test-claims-guard.mjs      19
node test/test-self-update.mjs       14
node test/test-verify-wording.mjs     6
node test/test-mount.mjs             15
```

`npm run smoke` 三套（18 / 9 / 9），隐私扫描 0 命中。
