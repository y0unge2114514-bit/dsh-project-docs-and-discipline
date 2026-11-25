# v0.3.3

本次没有改插件行为，只把发布这件事本身从「照着手打的命令」变成一条能重复执行的命令。

## 新增

**发布脚本**（`scripts/release-lib.mjs` + `scripts/release.mjs`，`npm run release`）把一次发布拆成固定四步：推 main → 推 tag → 建 GitHub Release → 回读核对。默认 dry-run，只打印计划；加 `--yes` 才真跑。

四道前置闸门依次拒绝：

- 没有 `--yes` —— 不执行任何命令
- 没有 `GITHUB_TOKEN` —— 拒绝，而不是静默退化成匿名推送
- 工作区有未提交改动 —— 拒绝并列出文件，那可能正是别人没来得及提交的修复
- 远端已有同名 tag —— 拒绝覆盖

任一步失败立即停止，不会带着半个发布继续往下走。令牌只从环境变量读（不接命令行参数，免得进 shell 历史），所有输出过 `redact`，有专门用例断言结果里不含令牌原文。

## 修正

**Release 正文必须是字符串**。上一次发布用 PowerShell `Get-Content -Raw` 读 Markdown 再 `ConvertTo-Json`，正文被序列化成带 `PSPath`/`PSProvider`/`ReadCount` 的对象，GitHub 返回 422 `For 'properties/body', {...} is not a string`，中文还被按 GBK 读成乱码。`buildReleasePayload` 现在对非字符串正文当场报错，不再带着它去撞接口。

发布脚本自己吃这口教训：正文一律用 `fs.readFileSync` 读、拼 JSON，不经过 PowerShell。

## 测试

17 套，329 项。

新增 `test/test-release.mjs` 27 项，覆盖参数解析、版本读取、payload 构造（含拒绝 PowerShell 对象、中文不乱码）、令牌脱敏、三道前置闸门、某步失败即停、以及真起子进程验证 CLI 的 `--help` / dry-run / 无令牌退出码 2。

测试里的令牌与主机全部运行时拼接，既避免隐私扫描器把假串当真 token，也避免源码里出现凭据赋值的形状。
