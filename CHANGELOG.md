# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [0.1.0-rc.1] - 2026-10-29

首个公开版本的预发布。

### 新增

- 后台进程、CLI 和 MCP 服务共用一个本机后台进程；后台进程重启时浏览器不关，登录状态不掉。
- 感知层：精简快照和增量 diff，表格按行列返回；多标签页自动跟随。
- `browser_act`、`browser_wait`、`browser_download`、`browser_pdf`、`browser_extract`；页面脚本 `browser_eval` 默认关闭。
- 录制器和技能：`skill_save` 把一次成功的操作存成 YAML 技能，参数化、带业务结果判定（例如“无数据”报告为空而不是导出）；`skill_run` 支持 matrix 批量执行，回放不消耗模型 token。
- 自愈：页面改版导致步骤失败时，`skill_patch` 只为失败的一步选择新目标，验证通过后生成新版本。
- 转交真人：遇到登录和验证码时，浏览器顶到前台并通知用户，期间模型拿不到页面内容；身份按站点保存。
- 隐私：技能保存时始终去掉个人信息；可选的脱敏模式让模型只看到占位符。
- 审计日志：哈希链 JSONL，`relaywright audit verify` 校验。
- 域名白名单和本机授权对话框；接入正在运行的 Chrome（`attach`）。
- `relaywright init`、`relaywright doctor`；状态存储 `state`。
- 对比测试框架 `npm run bench`：同一模型分别驱动 Playwright MCP 和 relaywright。
- 依赖许可证检查 `npm run licenses`，GitHub Actions CI。
- 发布流程见 `RELEASING.md`。

### 修复

- 页面上未结束的请求（例如新标签页预加载的资源）不再让每个动作都等满 5 秒；Chrome 以 about:blank 启动。
- 点击后页面 3 秒没有网络请求、也没有打开新标签页时，`browser_download` 立即报告 `no_download`，不再等满 30 秒。
- 拒绝保存只在文件名里出现、从未输入到页面的参数，以及“导出发生在输入参数之前”的步骤范围。
- 无界面模式下请求真人登录立即失败，不再一直等待。
