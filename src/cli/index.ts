#!/usr/bin/env node
import { Command } from 'commander';
import { errorText, packageVersion } from '../config/paths.js';
import {
  type DaemonStatus,
  ensureDaemon,
  findHealthyDaemon,
  getSnapshot,
  getStatus,
  navigate,
  readStatus,
  stopDaemon,
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
  return [
    `pid: ${status.pid}`,
    `port: ${port}`,
    `uptime: ${status.uptime}s`,
    `version: ${version}`,
    `browser: ${status.browser.executablePath}`,
    `browserVersion: ${status.browser.version}`,
    `page: ${status.page.title}`,
    `url: ${status.page.url}`,
  ].join('\n');
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
    page: status.page,
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
  relaywright snapshot --json
  relaywright daemon stop
`,
);

const daemon = program.command('daemon').description('Manage the long-lived browser process');
addJson(daemon);

addJson(
  daemon
    .command('start')
    .description('Start the daemon if it is not already running')
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
    const status = await getStatus();
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
    .description('Show whether the daemon is running')
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
    emit(command, `daemon: running\n${statusText(status, info.port, info.version)}`, statusJson(status, info.port, info.version, info.startedAt));
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
    .description('Print a snapshot of the current page')
    .addHelpText(
      'after',
      `
Examples:
  relaywright snapshot
  relaywright snapshot --json
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const page = await getSnapshot();
    emit(command, page.snapshot, page);
  });
});

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`Error: ${errorText(err)}\n`);
  process.exit(1);
});
