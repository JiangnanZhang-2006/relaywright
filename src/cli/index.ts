#!/usr/bin/env node
import { Command } from 'commander';
import { installChromeForTesting, whichBrowser } from '../browser/resolve.js';
import { tailAudit, verifyAudit } from '../audit/log.js';
import { errorText, packageVersion, readTextFile } from '../config/paths.js';
import { normalizeActArgs } from './act-args.js';
import { issuesText, type PageBody } from '../protocol.js';
import { formatRunReport, formatSkillList, formatTrace } from '../skills/format.js';
import { CheckSchema, type CheckInput } from '../skills/schema.js';
import { z } from 'zod';
import {
  act,
  browserTabs,
  clearTrace,
  daemonMismatchLine,
  download,
  type DaemonStatus,
  ensureDaemon,
  findHealthyDaemon,
  getSnapshot,
  getTrace,
  listIdentities,
  listSkills,
  navigate,
  parseHttpUrl,
  printPdf,
  readStatus,
  restartDaemon,
  revokeIdentity,
  rollbackSkill,
  runSkill,
  saveIdentity,
  saveSkill,
  showSkill,
  skillHistory,
  startHandoff,
  stopDaemon,
  waitFor,
  waitForBrowserReady,
  waitHandoff,
} from '../daemon/client.js';
import { humanSize } from '../session/downloads.js';
import { formatClock } from '../session/login.js';

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

function withStep(text: string, step?: number): string {
  if (!step) return text;
  return `${text}\n(step ${step})`;
}

function formatPage(page: PageBody): string {
  const files = (page.downloads ?? []).map((file) => `file: ${file.name}  ${file.bytes}  ${file.sha256}  ${file.path}`).join('\n');
  return files ? `${page.snapshot}\n${files}` : page.snapshot;
}

// Exit by exitCode, never process.exit(): on Windows, exiting while fetch sockets close trips a libuv assertion.
function fail(command: Command, err: unknown): void {
  const message = errorText(err);
  if (wantsJson(command)) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { message } }, null, 2)}\n`);
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  const warning = daemonMismatchLine();
  if (warning && !message.includes(warning)) process.stderr.write(`${warning}\n`);
  process.exitCode = 1;
}

async function guard(command: Command, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    const warning = daemonMismatchLine();
    if (warning) process.stderr.write(`${warning}\n`);
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
  if (status.build) {
    lines.push(`build: ${status.build.entry}`);
    lines.push(`builtAt: ${status.build.builtAt}`);
  }
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
    build: status.build ?? null,
    mismatch: daemonMismatchLine() !== null,
  };
}

const program = new Command();
program
  .name('relaywright')
  .description('Control one shared Chromium through a local daemon, from the CLI or an MCP client.')
  .version(packageVersion())
  // Options after a subcommand belong to that subcommand, so `skill show --version 1` is not the root version flag.
  .enablePositionalOptions()
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
    .description('Stop the daemon if it is running. A visible Chrome window stays open unless --close-browser is set.')
    .option('--close-browser', 'close Chrome even when it is showing a window')
    .addHelpText(
      'after',
      `
Headless Chrome is always closed. A headed window stays open so the next start can adopt it.
Examples:
  relaywright daemon stop
  relaywright daemon stop --close-browser
  relaywright daemon stop --json
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const result = await stopDaemon({ closeBrowser: command.getOptionValue('closeBrowser') === true });
    if (result === 'not_running') {
      emit(command, 'daemon: not running', { running: false, stopped: false });
      return;
    }
    emit(command, 'daemon: stopped', { running: false, stopped: true });
  });
});

addJson(
  daemon
    .command('restart')
    .description('Stop the daemon and start it again. Headless Chrome is closed; a visible window is adopted again.')
    .addHelpText(
      'after',
      `
Headless Chrome is closed. A headed window stays open and the new daemon connects to it.
Examples:
  relaywright daemon restart
  relaywright daemon restart --json
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const info = await restartDaemon();
    await waitForBrowserReady(info);
    const status = await readStatus(info);
    emit(command, `daemon: restarted\n${statusText(status, info.port, info.version)}`, {
      ...statusJson(status, info.port, info.version, info.startedAt),
      restarted: true,
    });
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
      process.exitCode = 1;
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
    emit(command, withStep(formatPage(page), page.step), page);
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
    emit(command, formatPage(page), page);
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
    emit(command, withStep(formatPage(page), page.step), page);
  });
});

addJson(
  program
    .command('download')
    .description('Click a ref and save the file it downloads. File contents are not printed.')
    .argument('<ref>', 'element ref such as e4')
    .option('--save-as <name>', 'file name to save as')
    .option('--timeout <ms>', 'milliseconds to wait for a download to begin (default 30000, max 120000)', (value) => Number(value))
    .addHelpText(
      'after',
      `
Examples:
  relaywright download e4
  relaywright download e4 --save-as 2025-2026-2.pdf
  relaywright download e4 --timeout 1500 --json
`,
    ),
).action(function (this: Command, ref: string) {
  const command = this;
  return guard(command, async () => {
    const saveAs = command.getOptionValue('saveAs') as string | undefined;
    const timeoutMs = command.getOptionValue('timeout') as number | undefined;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)) {
      throw new Error('--timeout must be an integer from 1 to 120000');
    }
    const page = await download({ ref, ...(saveAs ? { save_as: saveAs } : {}), ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}) });
    emit(command, withStep(formatPage(page), page.step), page);
  });
});

addJson(
  program
    .command('pdf')
    .description('Print the current page to a PDF. File contents are not printed.')
    .option('--save-as <name>', 'file name to save as')
    .option('--landscape', 'print landscape instead of portrait')
    .addHelpText(
      'after',
      `
Examples:
  relaywright pdf
  relaywright pdf --save-as timetable.pdf --landscape
  relaywright pdf --json
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const saveAs = command.getOptionValue('saveAs') as string | undefined;
    const landscape = command.getOptionValue('landscape') === true;
    const result = await printPdf({
      ...(saveAs ? { save_as: saveAs } : {}),
      ...(landscape ? { landscape: true } : {}),
    });
    const text = `${result.header}\n(pdf: ${result.file.name} ${humanSize(result.file.bytes)} -> ${result.file.path})\nfile: ${result.file.name}  ${result.file.bytes}  ${result.file.sha256}  ${result.file.path}`;
    emit(command, withStep(text, result.step), result);
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
    emit(command, withStep(`matched: ${result.matched}\n${formatPage(result)}`, result.step), result);
  });
});

const tabs = program.command('tabs').description('List, select, close, or open browser tabs');
addJson(tabs);

addJson(
  tabs
    .command('list', { isDefault: true })
    .description('List open tabs. The active tab is marked with *')
    .addHelpText(
      'after',
      `
Examples:
  relaywright tabs
  relaywright tabs list --json
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const listed = await browserTabs({ action: 'list' });
    if (!('text' in listed)) throw new Error('Expected a tab list');
    emit(command, listed.text, listed);
  });
});

addJson(
  tabs
    .command('select')
    .description('Make a tab active and print its snapshot')
    .argument('<index>', '1-based tab index', (value) => parseStepFlag('index', value))
    .addHelpText(
      'after',
      `
Examples:
  relaywright tabs select 2
`,
    ),
).action(function (this: Command, index: number) {
  const command = this;
  return guard(command, async () => {
    const page = await browserTabs({ action: 'select', index });
    if (!('snapshot' in page)) throw new Error('Expected a page snapshot');
    emit(command, formatPage(page), page);
  });
});

addJson(
  tabs
    .command('close')
    .description('Close a tab. Omit the index to close the active tab')
    .argument('[index]', '1-based tab index', (value) => parseStepFlag('index', value))
    .addHelpText(
      'after',
      `
Examples:
  relaywright tabs close
  relaywright tabs close 2
`,
    ),
).action(function (this: Command, index?: number) {
  const command = this;
  return guard(command, async () => {
    const listed = await browserTabs({ action: 'close', ...(index === undefined ? {} : { index }) });
    if (!('text' in listed)) throw new Error('Expected a tab list');
    emit(command, listed.text, listed);
  });
});

addJson(
  tabs
    .command('new')
    .description('Open a tab and print its snapshot')
    .argument('[url]', 'absolute http(s) URL')
    .addHelpText(
      'after',
      `
Examples:
  relaywright tabs new
  relaywright tabs new https://example.com
`,
    ),
).action(function (this: Command, url?: string) {
  const command = this;
  return guard(command, async () => {
    const page = await browserTabs({ action: 'new', ...(url ? { url: parseHttpUrl(url) } : {}) });
    if (!('snapshot' in page)) throw new Error('Expected a page snapshot');
    emit(command, formatPage(page), page);
  });
});

const trace = program.command('trace').description('Show or clear the exploration trace for the shared page');
addJson(trace);

addJson(
  trace
    .command('show')
    .description('Print the current trace')
    .addHelpText(
      'after',
      `
Examples:
  relaywright trace show
  relaywright trace show --json
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const current = await getTrace();
    emit(command, formatTrace(current), current);
  });
});

addJson(
  trace
    .command('clear')
    .description('Start a new trace. The previous trace file is kept.')
    .addHelpText(
      'after',
      `
Examples:
  relaywright trace clear
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const current = await clearTrace();
    emit(command, `trace: ${current.id}\nsteps: 0`, current);
  });
});

const skill = program.command('skill').description('Save and replay deterministic browser skills');
addJson(skill);

addJson(
  skill
    .command('list')
    .description('List saved skills')
    .addHelpText(
      'after',
      `
Examples:
  relaywright skill list
  relaywright skill list --json
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const skills = await listSkills();
    emit(command, formatSkillList(skills), { skills });
  });
});

addJson(
  skill
    .command('show')
    .description('Print a skill YAML file')
    .argument('<name>', 'skill name')
    .option('--version <n>', 'read a saved version instead of the current skill', (value) => parseStepFlag('--version', value))
    .addHelpText(
      'after',
      `
Examples:
  relaywright skill show zf-timetable
  relaywright skill show zf-timetable --version 1
`,
    ),
).action(function (this: Command, name: string) {
  const command = this;
  return guard(command, async () => {
    const version = command.getOptionValue('version') as number | undefined;
    const doc = await showSkill(name, version);
    emit(command, doc.yaml, doc);
  });
});

addJson(
  skill
    .command('history')
    .description('List saved versions of a skill')
    .argument('<name>', 'skill name')
    .addHelpText(
      'after',
      `
Examples:
  relaywright skill history zf-timetable
`,
    ),
).action(function (this: Command, name: string) {
  const command = this;
  return guard(command, async () => {
    const history = await skillHistory(name);
    const lines = [`${history.name}`, `current: ${history.current}`, ...history.versions.map((version) => `v${version}`)];
    emit(command, lines.join('\n'), history);
  });
});

addJson(
  skill
    .command('rollback')
    .description('Make an older saved version the current skill')
    .argument('<name>', 'skill name')
    .requiredOption('--to <version>', 'version number to restore', (value) => parseStepFlag('--to', value))
    .addHelpText(
      'after',
      `
Examples:
  relaywright skill rollback zf-timetable --to 1
`,
    ),
).action(function (this: Command, name: string) {
  const command = this;
  return guard(command, async () => {
    const to = command.getOptionValue('to') as number;
    const doc = await rollbackSkill(name, to);
    emit(command, `rolled back ${doc.name} to v${doc.version}`, doc);
  });
});

addJson(
  skill
    .command('run')
    .description('Replay a skill. Exit 30 when any combination is broken, 20 when one needs a human.')
    .argument('<name>', 'skill name')
    .option('--param <pair>', 'fixed parameter key=value (repeatable)', collect, [])
    .option('--matrix <pair>', 'parameter axis key=v1,v2 (repeatable)', collect, [])
    .option('--start-url <url>', 'open this URL instead of the skill start_url')
    .option('--out <dir>', 'directory for download and PDF artifacts')
    .option('--no-wait', 'do not wait for a person to log in')
    .addHelpText(
      'after',
      `
Examples:
  relaywright skill run zf-timetable --param year=2025-2026 --param term=2
  relaywright skill run zf-timetable --matrix year=2025-2026,2026-2027 --matrix term=1,2
  relaywright skill run zf-timetable --start-url http://127.0.0.1:8765/zf-mock/v2/ --param year=2025-2026 --param term=2
  relaywright skill run zf-timetable --matrix year=2025-2026 --matrix term=1,2 --out ./out
`,
    ),
).action(function (this: Command, name: string) {
  const command = this;
  return guard(command, async () => {
    const params = pairs(command.getOptionValue('param') as string[], '--param year=2025-2026');
    const matrix = matrixPairs(command.getOptionValue('matrix') as string[]);
    const startUrl = command.getOptionValue('startUrl') as string | undefined;
    const outDir = command.getOptionValue('out') as string | undefined;
    const wait = command.getOptionValue('wait') !== false;
    const info = await ensureDaemon();
    let stopPoll = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const poll = (async () => {
      while (!stopPoll) {
        await new Promise<void>((resolve) => {
          pollTimer = setTimeout(resolve, 2_000);
        });
        if (stopPoll) return;
        try {
          const status = await readStatus(info);
          if (status.handoff?.state === 'waiting') {
            process.stderr.write(`[等待登录] ${status.handoff.reason ?? ''} 剩余 ${formatClock(status.handoff.remaining_ms ?? 0)}\n`);
          }
        } catch {
          // The run result is what decides success. Status can blip while Chrome is busy.
        }
      }
    })();
    void poll;
    try {
      const report = await runSkill(name, {
        ...(Object.keys(params).length > 0 ? { params } : {}),
        ...(Object.keys(matrix).length > 0 ? { matrix } : {}),
        ...(startUrl ? { startUrl } : {}),
        ...(outDir ? { out_dir: outDir } : {}),
        wait_human: wait,
      });
      emit(command, formatRunReport(report.results), report);
      if (report.exit_code !== 0) process.exitCode = report.exit_code;
    } finally {
      stopPoll = true;
      if (pollTimer) clearTimeout(pollTimer);
    }
  });
});

addJson(
  skill
    .command('save')
    .description('Save the current trace as a skill')
    .argument('<name>', 'skill name')
    .requiredOption('--description <text>', 'what the skill does')
    .option('--param <pair>', 'parameter example key=value from the trace (repeatable)', collect, [])
    .option('--from <n>', 'first trace step to keep', (value) => parseStepFlag('--from', value))
    .option('--to <n>', 'last trace step to keep', (value) => parseStepFlag('--to', value))
    .option('--check-file <path>', 'JSON file of expect checks')
    .option('--overwrite', 'replace an existing skill and keep the previous version')
    .addHelpText(
      'after',
      `
Examples:
  relaywright skill save zf-timetable --description "查询指定学年学期的个人课表" --param year=2025-2026 --param term=2
  relaywright skill save zf-timetable --description "查询课表" --param year=2025-2026 --check-file checks.json --overwrite
`,
    ),
).action(function (this: Command, name: string) {
  const command = this;
  return guard(command, async () => {
    const description = command.getOptionValue('description') as string;
    const params = pairs(command.getOptionValue('param') as string[], '--param year=2025-2026');
    const from = command.getOptionValue('from') as number | undefined;
    const to = command.getOptionValue('to') as number | undefined;
    const checkFile = command.getOptionValue('checkFile') as string | undefined;
    const overwrite = command.getOptionValue('overwrite') === true;
    const checks = checkFile ? readChecks(checkFile) : undefined;
    const saved = await saveSkill({
      name,
      description,
      params,
      ...(from !== undefined ? { from_step: from } : {}),
      ...(to !== undefined ? { to_step: to } : {}),
      ...(checks ? { checks } : {}),
      ...(overwrite ? { overwrite: true } : {}),
    });
    const warningText = saved.warnings.length === 0 ? 'warnings: 0' : `warnings:\n${saved.warnings.map((warning) => `- ${warning}`).join('\n')}`;
    emit(command, `saved: ${saved.name} v${saved.version}\npath: ${saved.path}\n${warningText}\n\n${saved.yaml}`, saved);
  });
});

addJson(
  program
    .command('handoff')
    .description('Ask the person at this PC to log in. Exit 20 on timeout or cancel.')
    .argument('<reason>', 'why a person needs to take over')
    .option('--no-wait', 'start the handoff and return without waiting')
    .addHelpText(
      'after',
      `
Examples:
  relaywright handoff "请扫码登录教务系统"
  relaywright handoff "请扫码登录" --no-wait
`,
    ),
).action(function (this: Command, reason: string) {
  const command = this;
  return guard(command, async () => {
    const view = await startHandoff(reason);
    if (command.getOptionValue('wait') === false) {
      process.stderr.write(`等待登录… 剩余 ${formatClock(view.remaining_ms ?? 0)}\n`);
      emit(command, view.state, view);
      return;
    }
    let current = view;
    while (current.state === 'waiting') {
      process.stderr.write(`等待登录… 剩余 ${formatClock(current.remaining_ms ?? 0)}\n`);
      current = await waitHandoff(5_000);
    }
    emit(command, current.state, current);
    if (current.state !== 'done') process.exitCode = 20;
  });
});

const identity = program.command('identity').description('Login identities stored by Chrome');
addJson(identity);

addJson(
  identity
    .command('list')
    .description('List identity metadata. Cookies stay in Chrome.')
    .addHelpText(
      'after',
      `
Examples:
  relaywright identity list
  relaywright identity list --json
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const identities = await listIdentities();
    const text = identities.length === 0 ? 'no identities' : identities.map((item) => `${item.name}  ${item.domains.join(',')}  cookies ${item.cookie_count}`).join('\n');
    emit(command, text, { identities });
  });
});

addJson(
  identity
    .command('save')
    .description('Persist the active tab session after you logged in yourself')
    .argument('[name]', 'identity name; defaults to the registrable domain')
    .option('--domain <domain>', 'registrable domain to keep (repeatable)', collect, [])
    .addHelpText(
      'after',
      `
Examples:
  relaywright identity save
  relaywright identity save school.edu.cn --domain school.edu.cn
`,
    ),
).action(function (this: Command, name?: string) {
  const command = this;
  return guard(command, async () => {
    const domains = command.getOptionValue('domain') as string[];
    const saved = await saveIdentity({
      ...(name ? { name } : {}),
      ...(domains.length > 0 ? { domains } : {}),
    });
    emit(command, `saved ${saved.name}`, saved);
  });
});

addJson(
  identity
    .command('revoke')
    .description('Delete an identity and its matching cookies')
    .argument('<name>', 'identity name')
    .addHelpText(
      'after',
      `
Examples:
  relaywright identity revoke school.edu.cn
`,
    ),
).action(function (this: Command, name: string) {
  const command = this;
  return guard(command, async () => {
    const removed = await revokeIdentity(name);
    emit(command, `revoked ${removed.name}`, removed);
  });
});

const audit = program.command('audit').description('Append-only audit log');
addJson(audit);

addJson(
  audit
    .command('tail')
    .description('Show the latest audit records')
    .option('-n, --lines <count>', 'number of records', '20')
    .addHelpText(
      'after',
      `
Examples:
  relaywright audit tail
  relaywright audit tail -n 20 --json
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const limit = parseStepFlag('-n', String(command.getOptionValue('lines') ?? '20'));
    const records = tailAudit(limit);
    const text =
      records.length === 0
        ? '(empty)'
        : records
            .map((record) => {
              const extra = Object.entries(record)
                .filter(([key]) => key !== 'ts' && key !== 'event' && key !== 'prev' && key !== 'hash')
                .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
                .join(' ');
              return `${record.ts}  ${record.event}${extra ? `  ${extra}` : ''}`;
            })
            .join('\n');
    emit(command, text, records);
  });
});

addJson(
  audit
    .command('verify')
    .description('Check the hash chain. Exit 1 at the first broken line.')
    .addHelpText(
      'after',
      `
Examples:
  relaywright audit verify
`,
    ),
).action(function (this: Command) {
  const command = this;
  return guard(command, async () => {
    const result = verifyAudit();
    if (result.ok) {
      emit(command, 'audit: ok', { ok: true });
      return;
    }
    process.stderr.write(`${result.where}\n`);
    if (wantsJson(command)) process.stdout.write(`${JSON.stringify({ ok: false, where: result.where }, null, 2)}\n`);
    process.exitCode = 1;
  });
});

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseStepFlag(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function pairs(values: string[], example: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const raw of values) {
    const index = raw.indexOf('=');
    if (index <= 0) throw new Error(`Expected key=value, got ${JSON.stringify(raw)}\nExample: ${example}`);
    params[raw.slice(0, index)] = raw.slice(index + 1);
  }
  return params;
}

function matrixPairs(values: string[]): Record<string, string[]> {
  const matrix: Record<string, string[]> = {};
  for (const raw of values) {
    const index = raw.indexOf('=');
    if (index <= 0) {
      throw new Error(`Expected key=v1,v2, got ${JSON.stringify(raw)}\nExample: --matrix term=1,2`);
    }
    const key = raw.slice(0, index);
    const items = raw
      .slice(index + 1)
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (items.length === 0) throw new Error(`matrix ${key} has no values`);
    matrix[key] = items;
  }
  return matrix;
}

function readChecks(path: string): CheckInput[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readTextFile(path));
  } catch (err) {
    throw new Error(`Could not read checks file: ${errorText(err)}`);
  }
  const parsed = z.array(CheckSchema).safeParse(raw);
  if (!parsed.success) throw new Error(issuesText(parsed.error));
  return parsed.data;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`Error: ${errorText(err)}\n`);
  process.exitCode = 1;
});
