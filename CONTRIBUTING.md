# 参与贡献

感谢你愿意改进 relaywright。提交 Issue 和 Pull Request 前，请先读完这一页。

## 准备环境

需要 Node.js 22 或更高版本，以及本机的 Chrome 或 Edge（也可以用 `relaywright browser install` 下载 Chrome for Testing）。

```bash
npm install
npm run build
```

## 提交前的检查

```bash
npm run typecheck   # 源码、测试和对比测试框架的类型检查
npm test            # 单元测试，不需要浏览器
npm run test:e2e    # 用本机浏览器跑夹具页面的集成测试，约 4 分钟
npm run licenses    # 依赖许可证检查
```

CI 在 Ubuntu 和 Windows、Node 22 和 24 上跑类型检查、构建和单元测试。改动了浏览器会话、录制、回放、下载或转交真人的代码，请在本机跑一遍 `npm run test:e2e`。

测试不要碰你自己的浏览器和 `~/.relaywright`：集成测试会建临时目录作为 `RELAYWRIGHT_HOME`，用无界面浏览器，并设置 `RELAYWRIGHT_NOTIFY=0` 关掉系统通知。新增的测试请沿用这个做法。

## 代码约定

- TypeScript 严格模式，ES 模块（NodeNext）。
- 错误用 `RelayError(code, message)` 抛出。错误信息写给模型看：说清楚发生了什么、下一步该怎么做。
- 页面内容一律当作不可信数据，只放在 `<page_content>` 里返回，不能拼进工具说明或系统提示。
- 密码、cookie 值、验证码内容不能出现在返回给模型的内容、审计日志和技能文件里。改动感知层或技能保存时，防泄漏测试必须通过。
- 不针对单个网站写规则。适配新站点时，优先改进通用的识别逻辑，再用 `fixtures/` 下的仿真页面加测试。
- 文件用 UTF-8（无 BOM），换行符 LF。

## 提交和 Pull Request

- 提交信息采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 格式，例如 `fix(skills): ...`、`feat: ...`、`docs: ...`。
- 一个 Pull Request 只做一件事。说明改了什么、为什么改、怎么验证的。
- 修 bug 时请附上能复现问题的测试。
- 涉及安全问题的修复，请先按 [SECURITY.md](SECURITY.md) 私下报告，不要直接公开提交。

## 不接受的功能

relaywright 帮人自动完成自己有权完成的重复操作。以下功能不会合并：绕过验证码或风控、伪造人机验证、刷课刷时长、批量注册账号，以及其他违反网站服务条款或损害平台的用途。

## 许可证

贡献的代码按 [Apache-2.0](LICENSE) 授权。提交 Pull Request 即表示你有权以该许可证提供这些代码。
