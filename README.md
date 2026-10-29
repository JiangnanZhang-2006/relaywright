# relaywright

[English](README.en.md)

AI 学一次浏览器任务，之后自己重复做。遇到登录和验证码，把浏览器交给坐在电脑前的人。密码和 cookie 不进模型，每一步都可审计。

relaywright 用 Chrome DevTools Protocol 操控本机 Chromium，同一套后台进程同时给 MCP 客户端和命令行用。第一次把任务做成功后，可以存成技能；之后按参数回放，不再调用模型。页面改版时，只为失败的那一步挑选新的控件并保存新版本。

设计说明见 [docs/architecture.md](docs/architecture.md)。项目处于 0.1.0-rc.1。

## 安装

需要 Node.js 22 或更高版本，以及本机的 Chrome 或 Edge。

```bash
npm install
npm run build
```

`browser which` 只打印会用到的浏览器，不下载。没有系统浏览器时，`browser install` 把 Chrome for Testing 下载到 `~/.relaywright/browsers`。

```bash
npx relaywright browser which
npx relaywright browser install
```

## 命令行

```bash
npx relaywright daemon start
npx relaywright open https://example.com
npx relaywright snapshot
npx relaywright act click e3
npx relaywright skill list
npx relaywright skill run zf-timetable --matrix year=2025-2026,2026-2027 --matrix term=1,2
npx relaywright daemon stop
```

`daemon stop` 默认留下浏览器，登录状态还在；要连浏览器一起关，用 `daemon stop --close-browser`。无界面模式设置 `RELAYWRIGHT_HEADLESS=1`。

## 接到 Cursor

构建之后，仓库里的 `.cursor/mcp.json` 会用 `node dist/cli/index.js mcp` 启动 MCP 服务。改了源码要重新 `npm run build`。

推荐的用法已经写在 MCP 的说明里：先 `skill_list`，有合适的技能就 `skill_run`；没有就用浏览器工具做**一组**参数，再 `skill_save`，其余组合交给 `skill_run`。页面改版时，`skill_run` 返回 heal 块，用 `skill_patch` 指定新的控件。

## 技能、登录和隐私

- 技能是 YAML。参数来自你输入或选择的值；像「尚无课表」这样的业务结果用 `checks` 判成 empty，而不是当成页面坏了。
- 保存时会去掉个人信息：自己的值换成 `‹我.姓名›` 这类占位符，别人的值变成参数。
- 遇到登录，调用转交。模型在此期间拿不到页面，也不能往密码框里输入。人在这台电脑上完成后，任务继续。
- 域名白名单生效时，名单外的跳转会在请求发出前被拦住。放行只来自本机对话框。
- `browser_eval` 默认关闭。
- 审计日志在 `~/.relaywright/audit/`，`relaywright audit verify` 校验哈希链。

## 对比测试

同一个模型、同一条任务、同一套 Chrome，分别驱动 relaywright 和 Playwright MCP：在仿教务课表页上导出三个有课的学期（纵向），并说明空的那个学期。relaywright 的技能在各次运行之间保留，Playwright MCP 每次都是新会话。

```bash
npm run bench -- --tools relaywright,playwright --repeats 5 --out bench/results
```

密钥只从环境变量 `DEEPSEEK_API_KEY` 读取，不会写入结果。`--thinking on`（默认）打开 DeepSeek 的思考模式。成功与否看页面服务器收到的导出请求，不看模型自己的汇报。一次成功必须是三个有课学期各一份纵向 PDF，空学期不导出，并且最终回答点出那个空学期。

2026-10-29 的一次完整运行（`deepseek-chat`，接口实际由 `deepseek-flash` 提供，思考模式开着，Chrome 156，每个工具 7 次）：

| 工具 | 首次 token | 重复中位数 | 改版 token | 合计 | 成功 |
| --- | ---: | ---: | ---: | ---: | ---: |
| relaywright | 144,690 | 54,720 | 45,472 | 498,938 | 5/7 |
| Playwright MCP 0.0.83 | 973,960 | 858,912 | 924,268 | 6,304,405 | 5/7 |

重复运行的 token 中位数大约是 Playwright MCP 的十六分之一，改版那次大约是二十分之一。relaywright 失败的两次都是 2025-2026 第 1 学期多导出了一份。Playwright MCP 失败的两次里，一次只通过页面导出了第 1 学期（其余是脚本直接请求导出接口，不算数），一次把第 2 学期导出了两份。完整表格和曲线在 [docs/bench/summary.md](docs/bench/summary.md)。

![每次 token](docs/bench/tokens.svg)

## 开发

```bash
npm run typecheck
npm test
npm run test:e2e
npm run licenses
```

单元测试不需要浏览器。`test:e2e` 用本机浏览器打开 `fixtures/` 里的仿真页面，大约 4 分钟，并且使用临时的 `RELAYWRIGHT_HOME`，不会碰你自己的浏览器配置。

参与贡献、报告漏洞和版本变化见 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)、[CHANGELOG.md](CHANGELOG.md)。后续计划见 [ROADMAP.md](ROADMAP.md)。

## 许可证

[Apache-2.0](LICENSE)。依赖包的许可证由 `npm run licenses` 对照白名单检查：随包分发的依赖只允许宽松许可证，开发依赖额外允许 MPL-2.0。
