# relaywright

AI 学一次浏览器任务，之后自己重复做；遇到登录和验证码，扫码交给真人；凭据全程不进模型，每一步都可审计。

relaywright 是一个基于 Chromium（CDP）的浏览器操控工具，同时提供 MCP 服务和 CLI。

> 项目处于早期开发阶段。设计文档见 [docs/architecture.md](docs/architecture.md)。

## 开发

需要 Node.js 22 或更高版本。本仓库用 npm 安装依赖。

```bash
npm install
npm run build
```

启动后台进程、打开页面、停止：

```bash
node dist/cli/index.js daemon start
node dist/cli/index.js open https://example.com
node dist/cli/index.js daemon stop
```

构建完成后，Cursor 会读取仓库里的 `.cursor/mcp.json`，通过 `node dist/cli/index.js mcp` 连接本地后台进程。修改源码后需要重新 `npm run build`，MCP 才会用到新的 `dist`。

无界面模式设置环境变量 `RELAYWRIGHT_HEADLESS=1`。`npm run dev -- daemon status` 可以用 tsx 直接跑 TypeScript。`npm run typecheck` 做类型检查，`npm test` 跑单元测试。
