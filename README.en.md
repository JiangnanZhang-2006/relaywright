# relaywright

[中文](README.md)

An agent learns a browser task once, then repeats it on its own. Login and captchas are handed to the person at the computer. Passwords and cookies never reach the model, and every sensitive step is audited.

relaywright drives a local Chromium through the Chrome DevTools Protocol. One daemon serves both the MCP server and the CLI. A finished task can be saved as a skill and replayed with parameters, without calling a model. When a redesign breaks a step, only that step is pointed at a new control and saved as a new version.

See [docs/architecture.md](docs/architecture.md) for the design. The project is at 0.1.0.

## Install

Node.js 22 or newer, and a local Chrome or Edge.

```bash
npm install
npm run build
```

`browser which` prints the browser it would use and downloads nothing. `browser install` downloads Chrome for Testing into `~/.relaywright/browsers` when no system browser is available.

```bash
npx relaywright browser which
npx relaywright browser install
```

## CLI

```bash
npx relaywright daemon start
npx relaywright open https://example.com
npx relaywright snapshot
npx relaywright act click e3
npx relaywright skill list
npx relaywright skill run zf-timetable --matrix year=2025-2026,2026-2027 --matrix term=1,2
npx relaywright daemon stop
```

`daemon stop` leaves the browser running, so the login survives. `daemon stop --close-browser` closes it too. Set `RELAYWRIGHT_HEADLESS=1` for headless mode.

## Cursor

After the build, `.cursor/mcp.json` starts the MCP server with `node dist/cli/index.js mcp`. Run `npm run build` again after changing the source.

The MCP instructions say to call `skill_list` first and `skill_run` when a skill fits. Otherwise do one combination with the browser tools, `skill_save` it, and `skill_run` the rest. On a redesigned page, `skill_run` returns a heal block; `skill_patch` supplies the new control.

## Skills, login, privacy

- A skill is YAML. Parameters are the values you typed or selected. A check turns a business result such as "no timetable" into `empty` instead of treating the page as broken.
- Saving a skill removes personal data: your own values become tokens such as `‹我.姓名›`, and other people's values become parameters.
- A login handoff hides the page from the model and refuses typing into a password field. The person at this computer finishes, and the task continues.
- While a domain allowlist is in effect, navigation outside it is blocked before the request is sent. Only the local dialog can allow a domain.
- `browser_eval` is off unless you enable it.
- The audit log lives in `~/.relaywright/audit/`. `relaywright audit verify` checks the hash chain.

## Benchmark

The same model, the same task, and the same Chrome drive relaywright and Playwright MCP. The task exports three scheduled terms as portrait PDFs from a mock timetable page and names the empty term. relaywright keeps its skills across runs. Playwright MCP starts a fresh session every run.

```bash
npm run bench -- --tools relaywright,playwright --repeats 5 --out bench/results
```

The API key is read from `DEEPSEEK_API_KEY` and is not written into the results. `--thinking on` (the default) enables DeepSeek thinking mode. Success comes from the export requests the page server received, not from the model's own report. A run succeeds only with one portrait PDF for each of the three scheduled terms, none for the empty term, and a final answer that names the empty term.

One full run on 2026-10-29 (`deepseek-chat`, served as `deepseek-flash`, thinking on, Chrome 156, seven runs per tool):

| tool | first tokens | median repeat | redesign tokens | total | success |
| --- | ---: | ---: | ---: | ---: | ---: |
| relaywright | 144,690 | 54,720 | 45,472 | 498,938 | 5/7 |
| Playwright MCP 0.0.83 | 973,960 | 858,912 | 924,268 | 6,304,405 | 5/7 |

The median repeat uses about one sixteenth of Playwright MCP's tokens, and the redesign run about one twentieth. Both of relaywright's failures exported the 2025-2026 first term twice. Of Playwright MCP's two failures, one exported only the first term through the page (the other terms were requested by a script, which does not count), and one exported the second term twice. The full table and charts are in [docs/bench/summary.md](docs/bench/summary.md).

![tokens per run](docs/bench/tokens.svg)

## Development

```bash
npm run typecheck
npm test
npm run test:e2e
npm run licenses
```

Unit tests need no browser. `test:e2e` drives the fixture pages under `fixtures/` for about four minutes, using a temporary `RELAYWRIGHT_HOME`, so it does not touch your own browser profile.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md), and [ROADMAP.md](ROADMAP.md).

## License

[Apache-2.0](LICENSE). `npm run licenses` checks the lockfile against an allowlist: distributed dependencies must be permissive, and dev dependencies may also be MPL-2.0.
