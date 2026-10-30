# relaywright

[English](README.en.md)

**AI 第一次做浏览器任务时踩过的坑，沉淀成一份技能文件；之后同类任务直接调用，不再让模型从头看页面、从头试错。**

现有的浏览器 MCP（Playwright MCP、Chrome DevTools MCP 等）每次执行都要模型重新读页面、重新决策，重复任务一遍遍烧 token，结果还不稳定。relaywright 让 agent 只探索一次：

```mermaid
flowchart LR
  A[第一次：agent 用浏览器工具探索] -->|做成一组参数| B[skill_save<br/>存成 YAML 技能]
  B --> C[之后：skill_run 按参数回放<br/>CLI 回放完全不调用模型]
  C -->|页面改版，某一步失败| D[只为这一步挑选新控件<br/>skill_patch 存成新版本]
  D --> C
```

1. **探索一次**：agent 用浏览器工具把任务做成一组参数（比如一个学期的课表）。
2. **沉淀成技能**：`skill_save` 把操作步骤、控件的多重定位方式和结果判定写成 YAML，个人信息自动换成占位符。
3. **直接回放**：其余参数组合交给 `skill_run`。走 MCP 时 agent 只需调用几次工具；走 CLI 或定时任务时完全不调用模型。
4. **只修坏掉的那一步**：页面改版导致某一步失败时，`skill_run` 返回 heal 块，模型只为这一步选出新控件，用 `skill_patch` 存成新版本，其余步骤不动。

## 效果

同一个模型、同一条任务、同一套 Chrome，分别驱动 relaywright 和 Playwright MCP：在仿教务系统页面上导出三个有课学期的纵向课表 PDF，并说明哪个学期没课。relaywright 的技能在各次运行之间保留，Playwright MCP 每次都是新会话。

| 工具 | 首次 token | 重复中位数 | 改版 token | 合计 | 成功 |
| --- | ---: | ---: | ---: | ---: | ---: |
| relaywright | 144,690 | 54,720 | 45,472 | 498,938 | 5/7 |
| Playwright MCP 0.0.83 | 973,960 | 858,912 | 924,268 | 6,304,405 | 5/7 |

- 重复运行的 token 中位数约为 Playwright MCP 的**十六分之一**，页面改版那次约为**二十分之一**，总量约为十三分之一。
- 首次探索也只用了约七分之一，因为快照经过精简，动作之后只返回变化的部分。
- 重复运行的耗时中位数约 36 秒，Playwright MCP 约 142 秒。

![每次 token](docs/bench/tokens.svg)

测试条件、失败原因和复现方法见下文的[对比测试](#对比测试)，逐次数据在 [docs/bench/summary.md](docs/bench/summary.md)。

## 技能长什么样

技能就是一份可读、可改、可提交到仓库的 YAML。下面节选自 [examples/zf-timetable/skill.yaml](examples/zf-timetable/skill.yaml)：

```yaml
name: zf-timetable
description: 导出指定学年学期的个人课表 PDF
params:
  year: { type: string, example: 2025-2026 }
  term: { type: string, example: "1" }
steps:
  - id: s1-select-学年
    select:
      target: { role: combobox, name: 学年, css: "#xnm" }
      value: "{{year}}"
  # ……选择学期、点击查询……
  - id: s4-expect
    expect:
      any:
        - outcome: empty
          when: { text_present: 该学年学期尚无您的课表 }
          message: "{{year}} 第 {{term}} 学期尚未排课"
        - outcome: ok
          when: { text_present: "{{year}}学年第{{term}}学期", table_rows_min: 1 }
  # ……点击「输出PDF」并保存为 {{year}}-{{term}}.pdf
```

- 每个控件同时记下角色、名称、CSS 和文字。页面小改动时，换一种定位方式仍能找到它。
- `expect` 把「尚无课表」这样的业务结果判成 empty，如实报告，不当成页面坏了去修。
- 保存时去掉个人信息：自己的值换成 `‹我.姓名›` 这类占位符，别人的值变成参数。

一份技能可以按参数矩阵批量跑：

```bash
npx relaywright skill run zf-timetable --matrix year=2025-2026,2026-2027 --matrix term=1,2
```

## 登录和安全

重复任务经常卡在登录上，relaywright 把这一步交给人，并保证凭据不进模型：

- **转交真人**：遇到登录或验证码时，模型拿不到页面，也不能往密码框里输入；浏览器被顶到前台并发出通知，人在这台电脑上完成后，任务继续。
- **凭据不进模型**：密码、cookie 不出现在任何工具返回值里，登录状态由浏览器自身加密保存。
- **域名白名单**：名单外的跳转在请求发出前被拦住，放行只来自本机对话框。`browser_eval` 默认关闭。
- **可审计**：审计日志在 `~/.relaywright/audit/`，`relaywright audit verify` 校验哈希链。

## 快速开始

需要 Node.js 22 或更高版本，以及本机的 Chrome 或 Edge。没有系统浏览器时，`npx relaywright browser install` 把 Chrome for Testing 下载到 `~/.relaywright/browsers`。

```bash
npm install
npm run build
npx relaywright init                     # 逐项设置浏览器模式、白名单等，回车保留当前值
npx relaywright init --write-mcp cursor  # 把 MCP 启动命令写进当前目录的 .cursor/mcp.json
```

`init` 加上 `--yes` 或在没有终端时只按参数写入，不再提问。姓名和账号只在本机登记，输入时不会显示。

### 在 Cursor 里用

写好 `.cursor/mcp.json` 后，agent 会按 MCP 说明里的流程工作：先 `skill_list`，有合适的技能就 `skill_run`；没有就用浏览器工具做一组参数，`skill_save` 之后其余组合交给 `skill_run`。改了源码要重新 `npm run build`。

### 在命令行里用

MCP 和 CLI 共用同一个后台进程和浏览器，在 Cursor 里探索出的技能可以立刻在终端回放。

```bash
npx relaywright daemon start
npx relaywright open https://example.com
npx relaywright snapshot
npx relaywright act click e3
npx relaywright skill list
npx relaywright daemon stop          # 默认留下浏览器，登录状态还在；加 --close-browser 一起关
```

无界面模式设置 `RELAYWRIGHT_HEADLESS=1`。

### 在 DeepSeek Harness 里用

在插件页填写 `github:JiangnanZhang-2006/relaywright`（`github:` 前缀要自己写上），然后重启。仓库带有编译好的 `dist/`，安装时不再编译；工具名带 `mcp__relaywright__` 前缀。浏览器模式和白名单仍用 `relaywright init` 设置。

## 对比测试

```bash
npm run bench -- --tools relaywright,playwright --repeats 5 --out bench/results
```

密钥只从环境变量 `DEEPSEEK_API_KEY` 读取，不会写入结果。`--thinking on`（默认）打开 DeepSeek 的思考模式。成功与否看页面服务器收到的导出请求，不看模型自己的汇报：三个有课学期各一份纵向 PDF，空学期不导出，并且最终回答点出那个空学期。

上面的数据来自 2026-10-29 的一次完整运行（`deepseek-chat`，接口实际由 `deepseek-flash` 提供，思考模式开着，Chrome 156，每个工具 7 次）。relaywright 失败的两次都是 2025-2026 第 1 学期多导出了一份。Playwright MCP 失败的两次里，一次只通过页面导出了第 1 学期（其余是脚本直接请求导出接口，不算数），一次把第 2 学期导出了两份。

## 开发

```bash
npm run typecheck
npm test
npm run test:e2e
npm run licenses
```

单元测试不需要浏览器。`test:e2e` 用本机浏览器打开 `fixtures/` 里的仿真页面，大约 4 分钟，并且使用临时的 `RELAYWRIGHT_HOME`，不会碰你自己的浏览器配置。

设计说明见 [docs/architecture.md](docs/architecture.md)。参与贡献、报告漏洞和版本变化见 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)、[CHANGELOG.md](CHANGELOG.md)，后续计划见 [ROADMAP.md](ROADMAP.md)。项目处于 0.1.0-rc.1。

## 许可证

[Apache-2.0](LICENSE)。依赖包的许可证由 `npm run licenses` 对照白名单检查：随包分发的依赖只允许宽松许可证，开发依赖额外允许 MPL-2.0。
