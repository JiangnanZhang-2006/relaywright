#!/usr/bin/env node
import { Command } from 'commander';
import { installChromeForTesting, whichBrowser } from '../browser/resolve.js';
import { errorText, packageVersion } from '../config/paths.js';
import { normalizeActArgs } from './act-args.js';
import {
  act,
  type DaemonStatus,
  ensureDaemon,
  findHealthyDaemon,
  getSnapshot,
  navigate,
  readStatus,
  stopDaemon,
  waitFor,
  waitForBrowserReady,
} from '../daemon/client.js';

function wantsJson(command: Command): boolean {
  for (let current: Command | null = command; current; current = current.parent) {
    if (current.getOptionValue('json') === true) return true;
  }
  return false;
}

function emit(command: Command, text: string, json: unknown): void {
  if (wantsJson(command)) {
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    return;
  }
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function fail(command: Command, err: unknown): never {
  const message = errorText(err);
  if (wantsJson(command)) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { message } }, null, 2)}\n`);
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exit(1);
}

async function guard(command: Command, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    fail(command, err);
  }
}

function addJson(command: Command): Command {
  return command.option('--json', 'print machine-readable JSON on stdout');
}

function statusText(status: DaemonStatus, port: number, version: string): string {
  const lines = [
    `pid: ${status.pid}`,
    `port: ${port}`,
    `uptime: ${status.uptime}s`,
    `version: ${version}`,
    `browserState: ${status.browser.state}`,
  ];
  if (status.browser.percent !== undefined) lines.push(`browserPercent: ${status.browser.percent}`);
  if (status.browser.message) lines.push(`browserError: ${status.browser.message}`);
  if (status.browser.executablePath) lines.push(`browser: ${status.browser.executablePath}`);
  if (status.browser.version) lines.push(`browserVersion: ${status.browser.version}`);
  if (status.page) {
    lines.push(`page: ${status.page.title}`);
    lines.push(`url: ${status.page.url}`);
  }
  return lines.join('\n');
}

function statusJson(status: DaemonStatus, port: number, version: string, startedAt: string): Record<string, unknown> {
  return {
    running: true,
    port,
    startedAt,
    version,
    pid: status.pid,
    uptime: status.uptime,
    browser: status.browser,
    page: status.page ?? null,
  };
}

const program = new Command();
program
  .name('relaywright')
  .description('Control one shared Chromium through a local daemon, from the CLI or an MCP client.')
  .version(packageVersion())
  .showHelpAfterError();
addJson(program);
program.addHelpText(
  'after',
  `
Examples:
  relaywright daemon start
  relaywright open https://example.com
  relaywright snapshot --diff
  relaywright act click e3
  relaywright act select e1 2025-2026
  relaywright act type e5 张三 --key Enter
  relaywright daemon stop
`,
);

const daemon = program.command('daemon').description('Manage the long-lived browser process');
addJson(daemon);

addJson(
  daemon
    .command('start')
    .description('Start the daemon if it is not already running, then wait until the browser is ready')
    .addHelpText(
      'after',
      `
Examples:
  relaywright daemon start
  relaywright daemon start --json
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const already = await findHealthyDaemon();
    const info = await ensureDaemon();
    await waitForBrowserReady(info);
    const status = await readStatus(info);
    const label = already ? 'daemon: already running' : 'daemon: started';
    emit(command, `${label}\n${statusText(status, info.port, info.version)}`, {
      ...statusJson(status, info.port, info.version, info.startedAt),
      alreadyRunning: Boolean(already),
    });
  });
});

addJson(
  daemon
    .command('stop')
    .description('Stop the daemon if it is running')
    .addHelpText(
      'after',
      `
Examples:
  relaywright daemon stop
  relaywright daemon stop --json
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const result = await stopDaemon();
    if (result === 'not_running') {
      emit(command, 'daemon: not running', { running: false, stopped: false });
      return;
    }
    emit(command, 'daemon: stopped', { running: false, stopped: true });
  });
});

addJson(
  daemon
    .command('status')
    .description('Show whether the daemon is running. Does not wait for the browser to finish launching.')
    .addHelpText(
      'after',
      `
Examples:
  relaywright daemon status
  relaywright daemon status --json
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const info = await findHealthyDaemon();
    if (!info) {
      emit(command, 'daemon: not running', { running: false });
      return;
    }
    const status = await readStatus(info);
    emit(
      command,
      `daemon: running\n${statusText(status, info.port, info.version)}`,
      statusJson(status, info.port, info.version, info.startedAt),
    );
  });
});

const browser = program.command('browser').description('Resolve or install the Chromium executable');
addJson(browser);

addJson(
  browser
    .command('which')
    .description('Print the resolved browser executable and its source. Does not download anything.')
    .addHelpText(
      'after',
      `
Examples:
  relaywright browser which
  relaywright browser which --json
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const resolved = await whichBrowser();
    const pathText = resolved.path ?? '(not installed)';
    emit(command, `source: ${resolved.source}\npath: ${pathText}`, resolved);
  });
});

addJson(
  browser
    .command('install')
    .description('Download Chrome for Testing into ~/.relaywright/browsers')
    .addHelpText(
      'after',
      `
Examples:
  relaywright browser install
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    let last = -1;
    const path = await installChromeForTesting((percent) => {
      if (percent === last) return;
      last = percent;
      process.stderr.write(`downloading Chrome for Testing ${percent}%\n`);
    });
    emit(command, path, { path, source: 'cached-cft' });
  });
});

addJson(
  program
    .command('mcp')
    .description('Run the stdio MCP server. Nothing except MCP messages is written to stdout.')
    .addHelpText(
      'after',
      `
Examples:
  relaywright mcp
`,
    ),
).action(() => {
  return import('../mcp/server.js')
    .then(({ startMcpServer }) => startMcpServer())
    .catch((err: unknown) => {
      process.stderr.write(`Error: ${errorText(err)}\n`);
      process.exit(1);
    });
});

addJson(
  program
    .command('open')
    .description('Navigate the shared browser and print a snapshot')
    .argument('<url>', 'absolute http(s) URL')
    .addHelpText(
      'after',
      `
Examples:
  relaywright open https://example.com
  relaywright open https://example.com --json
`,
    ),
).action(function (this: Command, url: string) {
  const command = this;
  return guard(command, async () => {
    const page = await navigate(url);
    emit(command, page.snapshot, page);
  });
});

addJson(
  program
    .command('snapshot')
    .description('Print a snapshot of the current page. --diff is against the last snapshot from any client.')
    .option('--diff', 'print only changes since the last snapshot')
    .option('--max-rows <n>', 'maximum data rows to render for each table', (value) => Number(value))
    .addHelpText(
      'after',
      `
Examples:
  relaywright snapshot
  relaywright snapshot --diff
  relaywright snapshot --max-rows 8 --json
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const diff = command.getOptionValue('diff') === true;
    const maxRows = command.getOptionValue('maxRows') as number | undefined;
    if (maxRows !== undefined && (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 50)) {
      throw new Error('--max-rows must be an integer from 1 to 50');
    }
    const page = await getSnapshot({ mode: diff ? 'diff' : 'full', maxRows });
    emit(command, page.snapshot, page);
  });
});

addJson(
  program
    .command('act')
    .description('Click, type, select, press, or scroll using a ref from the latest snapshot')
    .argument('<action>', 'click, type, select, press, or scroll')
    .argument('[ref]', 'element ref such as e3')
    .argument('[value]', 'text, option, or up/down')
    .option('--key <key>', 'key to press after type, or the key for press')
    .addHelpText(
      'after',
      `
Examples:
  relaywright act click e3
  relaywright act select e1 2025-2026
  relaywright act type e5 张三 --key Enter
  relaywright act press Enter
  relaywright act scroll down
`,
    ),
).action(function (this: Command, action: string, ref?: string, value?: string) {
  const command = this;
  return guard(command, async () => {
    const key = command.getOptionValue('key') as string | undefined;
    const input = normalizeActArgs(action, ref, value, key);
    const page = await act(input);
    emit(command, page.snapshot, page);
  });
});

addJson(
  program
    .command('wait')
    .description('Wait until text, a ref, or a URL substring matches, then print a diff snapshot')
    .option('--text <text>', 'page text to wait for')
    .option('--ref <ref>', 'ref that must be visible')
    .option('--url <url>', 'URL substring to wait for')
    .option('--timeout <ms>', 'timeout in milliseconds (default 10000, max 60000)', (value) => Number(value))
    .addHelpText(
      'after',
      `
Examples:
  relaywright wait --text 课表
  relaywright wait --ref e3 --timeout 5000
  relaywright wait --url example.com --json
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const text = command.getOptionValue('text') as string | undefined;
    const ref = command.getOptionValue('ref') as string | undefined;
    const url = command.getOptionValue('url') as string | undefined;
    const timeoutMs = command.getOptionValue('timeout') as number | undefined;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)) {
      throw new Error('--timeout must be an integer from 1 to 60000');
    }
    const result = await waitFor({ text, ref, url, timeoutMs });
    emit(command, `matched: ${result.matched}\n${result.snapshot}`, result);
  });
});

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`Error: ${errorText(err)}\n`);
  process.exit(1);
});
