#!/usr/bin/env node
import { Command } from 'commander';
import { installChromeForTesting, whichBrowser } from '../browser/resolve.js';
import { tailAudit, verifyAudit } from '../audit/log.js';
import { formatHealConfig, healKeySet, readHealConfig, writeHealConfig } from '../healer/config.js';
import { runSkillWithHeal } from '../healer/drive.js';
import { errorText, packageVersion, readTextFile } from '../config/paths.js';
import { EVAL_DISABLED_MESSAGE, setEvalEnabled } from '../config/runtime.js';
import { parseExtractField } from '../perception/extract.js';
import { normalizeActArgs } from './act-args.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { maybePrintInitHint } from './hint.js';
import { formatInit, runInit } from './init.js';
import { issuesText } from '../protocol.js';
import { formatDeidentified } from '../privacy/redactor.js';
import { formatRunReport, formatSkillList, formatTrace } from '../skills/format.js';
import { CheckSchema } from '../skills/schema.js';
import { z } from 'zod';
import { act, adoptTab, attachBrowser, browserTabs, clearTrace, daemonMismatchLine, detachBrowser, download, ensureDaemon, findHealthyDaemon, getSnapshot, getTrace, listForeignTabs, listIdentities, listSkills, navigate, parseHttpUrl, printPdf, readStatus, requestAccess, restartDaemon, revokeIdentity, patchSkill, rollbackSkill, saveIdentity, privacyAdd, privacyCheck, privacyConfirm, privacyList, privacyMode, deleteState, evalInPage, extractPage, getState, listState, privacyReject, putState, saveSkill, showSkill, skillHistory, startHandoff, stopDaemon, waitFor, waitForBrowserReady, waitHandoff, } from '../daemon/client.js';
import { humanSize } from '../session/downloads.js';
import { formatClock } from '../session/login.js';
function wantsJson(command) {
    for (let current = command; current; current = current.parent) {
        if (current.getOptionValue('json') === true)
            return true;
    }
    return false;
}
function emit(command, text, json) {
    if (wantsJson(command)) {
        process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
        return;
    }
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}
function withStep(text, step) {
    if (!step)
        return text;
    return `${text}\n(step ${step})`;
}
function formatPage(page) {
    const files = (page.downloads ?? []).map((file) => `file: ${file.name}  ${file.bytes}  ${file.sha256}  ${file.path}`).join('\n');
    return files ? `${page.snapshot}\n${files}` : page.snapshot;
}
// Exit by exitCode, never process.exit(): on Windows, exiting while fetch sockets close trips a libuv assertion.
function fail(command, err) {
    const message = errorText(err);
    if (wantsJson(command)) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: { message } }, null, 2)}\n`);
    }
    else {
        process.stderr.write(`Error: ${message}\n`);
    }
    const warning = daemonMismatchLine();
    if (warning && !message.includes(warning))
        process.stderr.write(`${warning}\n`);
    process.exitCode = 1;
}
async function guard(command, fn) {
    try {
        await fn();
        const warning = daemonMismatchLine();
        if (warning)
            process.stderr.write(`${warning}\n`);
    }
    catch (err) {
        fail(command, err);
    }
}
function addJson(command) {
    return command.option('--json', 'print machine-readable JSON on stdout');
}
function statusText(status, port, version) {
    const lines = [
        `pid: ${status.pid}`,
        `port: ${port}`,
        `uptime: ${status.uptime}s`,
        `version: ${version}`,
        `browserState: ${status.browser.state}`,
    ];
    if (status.browser.percent !== undefined)
        lines.push(`browserPercent: ${status.browser.percent}`);
    if (status.browser.message)
        lines.push(`browserError: ${status.browser.message}`);
    if (status.browser.executablePath)
        lines.push(`browser: ${status.browser.executablePath}`);
    if (status.browser.version)
        lines.push(`browserVersion: ${status.browser.version}`);
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
function statusJson(status, port, version, startedAt) {
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
program.hook('preAction', (_thisCommand, actionCommand) => {
    maybePrintInitHint(actionCommand);
});
program.addHelpText('after', `
Examples:
  relaywright daemon start
  relaywright open https://example.com
  relaywright snapshot --diff
  relaywright act click e3
  relaywright act select e1 2025-2026
  relaywright act type e5 张三 --key Enter
  relaywright daemon stop
`);
const daemon = program.command('daemon').description('Manage the long-lived browser process');
addJson(daemon);
addJson(daemon
    .command('start')
    .description('Start the daemon if it is not already running, then wait until the browser is ready')
    .addHelpText('after', `
Examples:
  relaywright daemon start
  relaywright daemon start --json
`)).action(function () {
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
addJson(daemon
    .command('stop')
    .description('Stop the daemon if it is running. A visible Chrome window stays open unless --close-browser is set.')
    .option('--close-browser', 'close Chrome even when it is showing a window')
    .addHelpText('after', `
Headless Chrome is always closed. A headed window stays open so the next start can adopt it.
Examples:
  relaywright daemon stop
  relaywright daemon stop --close-browser
  relaywright daemon stop --json
`)).action(function () {
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
addJson(daemon
    .command('restart')
    .description('Stop the daemon and start it again. Headless Chrome is closed; a visible window is adopted again.')
    .addHelpText('after', `
Headless Chrome is closed. A headed window stays open and the new daemon connects to it.
Examples:
  relaywright daemon restart
  relaywright daemon restart --json
`)).action(function () {
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
addJson(daemon
    .command('status')
    .description('Show whether the daemon is running. Does not wait for the browser to finish launching.')
    .addHelpText('after', `
Examples:
  relaywright daemon status
  relaywright daemon status --json
`)).action(function () {
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
addJson(daemon
    .command('attach')
    .description('Attach the daemon to an existing Chrome. Choose one of --auto, --cdp-url, or --user-data-dir.')
    .option('--auto', 'read DevToolsActivePort from the default Chrome profile')
    .option('--cdp-url <url>', 'ws(s) URL, or an http(s) base that exposes /json/version')
    .option('--user-data-dir <dir>', 'profile directory that contains DevToolsActivePort')
    .addHelpText('after', `
Chrome shows an allow dialog. The daemon waits up to 60s.
Examples:
  relaywright daemon attach --auto
  relaywright daemon attach --user-data-dir "%LOCALAPPDATA%\\Google\\Chrome\\User Data"
  relaywright daemon attach --cdp-url ws://127.0.0.1:9222/devtools/browser/id
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const auto = command.getOptionValue('auto') === true;
        const cdpUrl = command.getOptionValue('cdpUrl');
        const userDataDir = command.getOptionValue('userDataDir');
        const result = await attachBrowser({ auto, cdpUrl, userDataDir });
        emit(command, `attached ${result.mode} (${result.endpoint_kind})`, result);
    });
});
addJson(daemon
    .command('detach')
    .description('Disconnect from an attached Chrome. The browser stays open.')
    .addHelpText('after', `
Examples:
  relaywright daemon detach
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const result = await detachBrowser();
        emit(command, 'detached', result);
    });
});
const browser = program.command('browser').description('Resolve or install the Chromium executable');
addJson(browser);
addJson(browser
    .command('which')
    .description('Print the resolved browser executable and its source. Does not download anything.')
    .addHelpText('after', `
Examples:
  relaywright browser which
  relaywright browser which --json
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const resolved = await whichBrowser();
        const pathText = resolved.path ?? '(not installed)';
        emit(command, `source: ${resolved.source}\npath: ${pathText}`, resolved);
    });
});
addJson(browser
    .command('install')
    .description('Download Chrome for Testing into ~/.relaywright/browsers')
    .addHelpText('after', `
Examples:
  relaywright browser install
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        let last = -1;
        const path = await installChromeForTesting((percent) => {
            if (percent === last)
                return;
            last = percent;
            process.stderr.write(`downloading Chrome for Testing ${percent}%\n`);
        });
        emit(command, path, { path, source: 'cached-cft' });
    });
});
addJson(program
    .command('mcp')
    .description('Run the stdio MCP server. Nothing except MCP messages is written to stdout.')
    .addHelpText('after', `
Examples:
  relaywright mcp
`)).action(() => {
    return import('../mcp/server.js')
        .then(({ startMcpServer }) => startMcpServer())
        .catch((err) => {
        process.stderr.write(`Error: ${errorText(err)}\n`);
        process.exitCode = 1;
    });
});
addJson(program
    .command('open')
    .description('Navigate the shared browser and print a snapshot')
    .argument('<url>', 'absolute http(s) URL')
    .addHelpText('after', `
Examples:
  relaywright open https://example.com
  relaywright open https://example.com --json
`)).action(function (url) {
    const command = this;
    return guard(command, async () => {
        const page = await navigate(url);
        emit(command, withStep(formatPage(page), page.step), page);
    });
});
addJson(program
    .command('snapshot')
    .description('Print a snapshot of the current page. --diff is against the last snapshot from any client.')
    .option('--diff', 'print only changes since the last snapshot')
    .option('--text', 'print the visible text instead of the accessibility snapshot')
    .option('--max-rows <n>', 'maximum data rows to render for each table', (value) => Number(value))
    .option('--max-chars <n>', 'maximum characters for --text', (value) => Number(value))
    .addHelpText('after', `
Examples:
  relaywright snapshot
  relaywright snapshot --diff
  relaywright snapshot --max-rows 8 --json
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const diff = command.getOptionValue('diff') === true;
        const text = command.getOptionValue('text') === true;
        const maxRows = command.getOptionValue('maxRows');
        const maxChars = command.getOptionValue('maxChars');
        if (diff && text)
            throw new Error('Choose one of --diff or --text');
        if (maxRows !== undefined && (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 50)) {
            throw new Error('--max-rows must be an integer from 1 to 50');
        }
        if (maxChars !== undefined && (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 50_000)) {
            throw new Error('--max-chars must be an integer from 1 to 50000');
        }
        const page = await getSnapshot({ mode: text ? 'text' : diff ? 'diff' : 'full', maxRows, maxChars });
        emit(command, formatPage(page), page);
    });
});
addJson(program
    .command('act')
    .description('Click, type, select, press, or scroll using a ref from the latest snapshot')
    .argument('<action>', 'click, type, select, press, or scroll')
    .argument('[ref]', 'element ref such as e3')
    .argument('[value]', 'text, option, or up/down')
    .option('--key <key>', 'key to press after type, or the key for press')
    .addHelpText('after', `
Examples:
  relaywright act click e3
  relaywright act select e1 2025-2026
  relaywright act type e5 张三 --key Enter
  relaywright act press Enter
  relaywright act scroll down
`)).action(function (action, ref, value) {
    const command = this;
    return guard(command, async () => {
        const key = command.getOptionValue('key');
        const input = normalizeActArgs(action, ref, value, key);
        const page = await act(input);
        emit(command, withStep(formatPage(page), page.step), page);
    });
});
addJson(program
    .command('download')
    .description('Click a ref and save the file it downloads. File contents are not printed.')
    .argument('<ref>', 'element ref such as e4')
    .option('--save-as <name>', 'file name to save as')
    .option('--timeout <ms>', 'milliseconds to wait for a download to begin (default 30000, max 120000)', (value) => Number(value))
    .addHelpText('after', `
Examples:
  relaywright download e4
  relaywright download e4 --save-as 2025-2026-2.pdf
  relaywright download e4 --timeout 1500 --json
`)).action(function (ref) {
    const command = this;
    return guard(command, async () => {
        const saveAs = command.getOptionValue('saveAs');
        const timeoutMs = command.getOptionValue('timeout');
        if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)) {
            throw new Error('--timeout must be an integer from 1 to 120000');
        }
        const page = await download({ ref, ...(saveAs ? { save_as: saveAs } : {}), ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}) });
        emit(command, withStep(formatPage(page), page.step), page);
    });
});
addJson(program
    .command('pdf')
    .description('Print the current page to a PDF. File contents are not printed.')
    .option('--save-as <name>', 'file name to save as')
    .option('--landscape', 'print landscape instead of portrait')
    .addHelpText('after', `
Examples:
  relaywright pdf
  relaywright pdf --save-as timetable.pdf --landscape
  relaywright pdf --json
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const saveAs = command.getOptionValue('saveAs');
        const landscape = command.getOptionValue('landscape') === true;
        const result = await printPdf({
            ...(saveAs ? { save_as: saveAs } : {}),
            ...(landscape ? { landscape: true } : {}),
        });
        const text = `${result.header}\n(pdf: ${result.file.name} ${humanSize(result.file.bytes)} -> ${result.file.path})\nfile: ${result.file.name}  ${result.file.bytes}  ${result.file.sha256}  ${result.file.path}`;
        emit(command, withStep(text, result.step), result);
    });
});
addJson(program
    .command('wait')
    .description('Wait until text, a ref, or a URL substring matches, then print a diff snapshot')
    .option('--text <text>', 'page text to wait for')
    .option('--ref <ref>', 'ref that must be visible')
    .option('--url <url>', 'URL substring to wait for')
    .option('--timeout <ms>', 'timeout in milliseconds (default 10000, max 60000)', (value) => Number(value))
    .addHelpText('after', `
Examples:
  relaywright wait --text 课表
  relaywright wait --ref e3 --timeout 5000
  relaywright wait --url example.com --json
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const text = command.getOptionValue('text');
        const ref = command.getOptionValue('ref');
        const url = command.getOptionValue('url');
        const timeoutMs = command.getOptionValue('timeout');
        if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)) {
            throw new Error('--timeout must be an integer from 1 to 60000');
        }
        const result = await waitFor({ text, ref, url, timeoutMs });
        emit(command, withStep(`matched: ${result.matched}\n${formatPage(result)}`, result.step), result);
    });
});
const tabs = program.command('tabs').description('List, select, close, or open browser tabs');
addJson(tabs);
addJson(tabs
    .command('list', { isDefault: true })
    .description('List open tabs. The active tab is marked with *')
    .addHelpText('after', `
Examples:
  relaywright tabs
  relaywright tabs list --json
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const listed = await browserTabs({ action: 'list' });
        if (!('text' in listed))
            throw new Error('Expected a tab list');
        emit(command, listed.text, listed);
    });
});
addJson(tabs
    .command('select')
    .description('Make a tab active and print its snapshot')
    .argument('<index>', '1-based tab index', (value) => parseStepFlag('index', value))
    .addHelpText('after', `
Examples:
  relaywright tabs select 2
`)).action(function (index) {
    const command = this;
    return guard(command, async () => {
        const page = await browserTabs({ action: 'select', index });
        if (!('snapshot' in page))
            throw new Error('Expected a page snapshot');
        emit(command, formatPage(page), page);
    });
});
addJson(tabs
    .command('close')
    .description('Close a tab. Omit the index to close the active tab')
    .argument('[index]', '1-based tab index', (value) => parseStepFlag('index', value))
    .addHelpText('after', `
Examples:
  relaywright tabs close
  relaywright tabs close 2
`)).action(function (index) {
    const command = this;
    return guard(command, async () => {
        const listed = await browserTabs({ action: 'close', ...(index === undefined ? {} : { index }) });
        if (!('text' in listed))
            throw new Error('Expected a tab list');
        emit(command, listed.text, listed);
    });
});
addJson(tabs
    .command('new')
    .description('Open a tab and print its snapshot')
    .argument('[url]', 'absolute http(s) URL')
    .addHelpText('after', `
Examples:
  relaywright tabs new
  relaywright tabs new https://example.com
`)).action(function (url) {
    const command = this;
    return guard(command, async () => {
        const page = await browserTabs({ action: 'new', ...(url ? { url: parseHttpUrl(url) } : {}) });
        if (!('snapshot' in page))
            throw new Error('Expected a page snapshot');
        emit(command, formatPage(page), page);
    });
});
addJson(tabs
    .command('adopt')
    .description('Show tabs that were already open in an attached Chrome, or adopt one by index. The model uses browser_tabs action=user, then action=adopt, which asks you to confirm.')
    .option('--index <n>', '1-based index from the user-tab list', (value) => parseStepFlag('index', value))
    .addHelpText('after', `
Without --index this prints the person's tabs and changes nothing.
Examples:
  relaywright tabs adopt
  relaywright tabs adopt --index 1
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const index = command.getOptionValue('index');
        if (index === undefined) {
            const listed = await listForeignTabs();
            const hint = listed.tabs.length === 0 ? 'No user tabs to adopt.' : 'Run relaywright tabs adopt --index <n> to adopt one.';
            emit(command, `${listed.text}\n${hint}`, listed);
            return;
        }
        const page = await adoptTab(index);
        emit(command, formatPage(page), page);
    });
});
const access = program.command('access').description('Ask the person at this computer to allow a domain');
addJson(access);
addJson(access
    .command('request')
    .description('Show the allow dialog for one registrable domain. The model cannot approve this itself.')
    .argument('<domain>', 'registrable domain, such as example.com')
    .option('--reason <text>', 'short reason shown in the dialog')
    .addHelpText('after', `
Buttons are 本次允许, 始终允许, and 拒绝. No answer within 60s is a deny.
Examples:
  relaywright access request example.com --reason "open the course site"
`)).action(function (domain) {
    const command = this;
    return guard(command, async () => {
        const reason = command.getOptionValue('reason');
        const result = await requestAccess(domain, reason);
        emit(command, `${result.domain} ${result.decision}`, result);
    });
});
const trace = program.command('trace').description('Show or clear the exploration trace for the shared page');
addJson(trace);
addJson(trace
    .command('show')
    .description('Print the current trace')
    .addHelpText('after', `
Examples:
  relaywright trace show
  relaywright trace show --json
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const current = await getTrace();
        emit(command, formatTrace(current), current);
    });
});
addJson(trace
    .command('clear')
    .description('Start a new trace. The previous trace file is kept.')
    .addHelpText('after', `
Examples:
  relaywright trace clear
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const current = await clearTrace();
        emit(command, `trace: ${current.id}\nsteps: 0`, current);
    });
});
const skill = program.command('skill').description('Save and replay deterministic browser skills');
addJson(skill);
addJson(skill
    .command('list')
    .description('List saved skills')
    .addHelpText('after', `
Examples:
  relaywright skill list
  relaywright skill list --json
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const skills = await listSkills();
        emit(command, formatSkillList(skills), { skills });
    });
});
addJson(skill
    .command('show')
    .description('Print a skill YAML file')
    .argument('<name>', 'skill name')
    .option('--version <n>', 'read a saved version instead of the current skill', (value) => parseStepFlag('--version', value))
    .addHelpText('after', `
Examples:
  relaywright skill show zf-timetable
  relaywright skill show zf-timetable --version 1
`)).action(function (name) {
    const command = this;
    return guard(command, async () => {
        const version = command.getOptionValue('version');
        const doc = await showSkill(name, version);
        emit(command, doc.yaml, doc);
    });
});
addJson(skill
    .command('history')
    .description('List saved versions of a skill')
    .argument('<name>', 'skill name')
    .addHelpText('after', `
Examples:
  relaywright skill history zf-timetable
`)).action(function (name) {
    const command = this;
    return guard(command, async () => {
        const history = await skillHistory(name);
        const lines = [`${history.name}`, `current: ${history.current}`, ...history.versions.map((version) => `v${version}`)];
        emit(command, lines.join('\n'), history);
    });
});
addJson(skill
    .command('rollback')
    .description('Make an older saved version the current skill')
    .argument('<name>', 'skill name')
    .requiredOption('--to <version>', 'version number to restore', (value) => parseStepFlag('--to', value))
    .addHelpText('after', `
Examples:
  relaywright skill rollback zf-timetable --to 1
`)).action(function (name) {
    const command = this;
    return guard(command, async () => {
        const to = command.getOptionValue('to');
        const doc = await rollbackSkill(name, to);
        emit(command, `rolled back ${doc.name} to v${doc.version}`, doc);
    });
});
addJson(skill
    .command('run')
    .description('Replay a skill. Exit 30 when any combination is broken, 20 when one needs a human.')
    .argument('<name>', 'skill name')
    .option('--param <pair>', 'fixed parameter key=value (repeatable)', collect, [])
    .option('--matrix <pair>', 'parameter axis key=v1,v2 (repeatable)', collect, [])
    .option('--start-url <url>', 'open this URL instead of the skill start_url')
    .option('--out <dir>', 'directory for download and PDF artifacts')
    .option('--no-wait', 'do not wait for a person to log in')
    .option('--no-heal', 'do not ask a model to repair a failed step')
    .addHelpText('after', `
Examples:
  relaywright skill run zf-timetable --param year=2025-2026 --param term=2
  relaywright skill run zf-timetable --matrix year=2025-2026,2026-2027 --matrix term=1,2
  relaywright skill run zf-timetable --start-url http://127.0.0.1:8765/zf-mock/v2/ --param year=2025-2026 --param term=2
  relaywright skill run zf-timetable --matrix year=2025-2026 --matrix term=1,2 --out ./out
  relaywright skill run zf-timetable --no-heal --param year=2025-2026 --param term=2
`)).action(function (name) {
    const command = this;
    return guard(command, async () => {
        const params = pairs(command.getOptionValue('param'), '--param year=2025-2026');
        const matrix = matrixPairs(command.getOptionValue('matrix'));
        const startUrl = command.getOptionValue('startUrl');
        const outDir = command.getOptionValue('out');
        const wait = command.getOptionValue('wait') !== false;
        const heal = command.getOptionValue('heal') !== false;
        const info = await ensureDaemon();
        let stopPoll = false;
        let pollTimer;
        const poll = (async () => {
            while (!stopPoll) {
                await new Promise((resolve) => {
                    pollTimer = setTimeout(resolve, 2_000);
                });
                if (stopPoll)
                    return;
                try {
                    const status = await readStatus(info);
                    if (status.handoff?.state === 'waiting') {
                        process.stderr.write(`[等待登录] ${status.handoff.reason ?? ''} 剩余 ${formatClock(status.handoff.remaining_ms ?? 0)}\n`);
                    }
                }
                catch {
                    // The run result is what decides success. Status can blip while Chrome is busy.
                }
            }
        })();
        void poll;
        try {
            const healed = await runSkillWithHeal(name, {
                ...(Object.keys(params).length > 0 ? { params } : {}),
                ...(Object.keys(matrix).length > 0 ? { matrix } : {}),
                ...(startUrl ? { startUrl } : {}),
                ...(outDir ? { out_dir: outDir } : {}),
                wait_human: wait,
            }, { heal });
            if (healed.hint)
                process.stderr.write(`${healed.hint}\n`);
            const report = healed.report;
            emit(command, formatRunReport(report.results, { total: report.llm_tokens ?? 0, steps: report.llm_steps }), report);
            if (report.exit_code !== 0)
                process.exitCode = report.exit_code;
        }
        finally {
            stopPoll = true;
            if (pollTimer)
                clearTimeout(pollTimer);
        }
    });
});
addJson(skill
    .command('patch')
    .description('Repair a failed step with the latest heal token and a snapshot ref')
    .argument('<name>', 'skill name')
    .requiredOption('--step <id>', 'step id from the heal block')
    .requiredOption('--ref <ref>', 'snapshot ref that performs the step intent')
    .addHelpText('after', `
Examples:
  relaywright skill patch zf-timetable --step s3-click-查询 --ref e12
`)).action(function (name) {
    const command = this;
    return guard(command, async () => {
        const stepId = command.getOptionValue('step');
        const ref = command.getOptionValue('ref');
        const result = await patchSkill(name, { step_id: stepId, ref, healer: 'manual' });
        if (!result.accepted) {
            emit(command, `rejected: ${result.reason ?? 'rejected'}`, result);
            process.exitCode = 1;
            return;
        }
        emit(command, `patched ${result.name} v${result.to_version}`, result);
    });
});
addJson(skill
    .command('save')
    .description('Save the current trace as a skill')
    .argument('<name>', 'skill name')
    .requiredOption('--description <text>', 'what the skill does')
    .option('--param <pair>', 'parameter example key=value from the trace (repeatable)', collect, [])
    .option('--from <n>', 'first trace step to keep', (value) => parseStepFlag('--from', value))
    .option('--to <n>', 'last trace step to keep', (value) => parseStepFlag('--to', value))
    .option('--check-file <path>', 'JSON file of expect checks')
    .option('--overwrite', 'replace an existing skill and keep the previous version')
    .addHelpText('after', `
Examples:
  relaywright skill save zf-timetable --description "查询指定学年学期的个人课表" --param year=2025-2026 --param term=2
  relaywright skill save zf-timetable --description "查询课表" --param year=2025-2026 --check-file checks.json --overwrite
`)).action(function (name) {
    const command = this;
    return guard(command, async () => {
        const description = command.getOptionValue('description');
        const params = pairs(command.getOptionValue('param'), '--param year=2025-2026');
        const from = command.getOptionValue('from');
        const to = command.getOptionValue('to');
        const checkFile = command.getOptionValue('checkFile');
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
        const removed = formatDeidentified(saved.deidentified);
        emit(command, `saved: ${saved.name} v${saved.version}\npath: ${saved.path}\n${removed}\n${warningText}\n\n${saved.yaml}`, saved);
    });
});
addJson(program
    .command('handoff')
    .description('Ask the person at this PC to log in. Exit 20 on timeout or cancel.')
    .argument('<reason>', 'why a person needs to take over')
    .option('--no-wait', 'start the handoff and return without waiting')
    .option('--url <url>', 'open this page before handing the window to the person')
    .addHelpText('after', `
Examples:
  relaywright handoff "请扫码登录教务系统"
  relaywright handoff "请扫码登录" --no-wait
  relaywright handoff "请登录" --url https://example.edu/login
`)).action(function (reason) {
    const command = this;
    return guard(command, async () => {
        const requested = command.getOptionValue('url');
        const view = await startHandoff(reason, requested ? parseHttpUrl(requested) : undefined);
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
        if (current.state !== 'done')
            process.exitCode = 20;
    });
});
const privacy = program.command('privacy').description('Self values and optional model redaction');
addJson(privacy);
addJson(privacy
    .command('mode')
    .description('Turn model-facing redaction on or off. Default is off.')
    .argument('<state>', 'on or off')
    .option('--identity <domain>', 'set the override for one site instead of the global default')
    .addHelpText('after', `
Examples:
  relaywright privacy mode on
  relaywright privacy mode off
  relaywright privacy mode on --identity school.edu.cn
`)).action(function (state) {
    const command = this;
    return guard(command, async () => {
        const on = parsePrivacyState(state);
        const identity = command.getOptionValue('identity');
        const result = await privacyMode(on, identity);
        const where = result.scope === 'identity' ? result.identity : 'global';
        emit(command, `model redaction ${result.model_redaction ? 'on' : 'off'} (${where})`, result);
    });
});
addJson(privacy
    .command('add')
    .description('Remember one of your own values for the current site')
    .argument('<kind>', 'name, account, phone, email, or idcard')
    .argument('[value]', 'value, or omit to read it from stdin')
    .option('--identity <domain>', 'site to store the value on')
    .addHelpText('after', `
Examples:
  relaywright privacy add name 张三
  relaywright privacy add account --identity school.edu.cn
  echo 13800138000 | relaywright privacy add phone
`)).action(function (kind, value) {
    const command = this;
    return guard(command, async () => {
        const secret = value ?? (await readStdinValue());
        const identity = command.getOptionValue('identity');
        const result = await privacyAdd(parsePrivacyKind(kind), secret, identity);
        emit(command, `added ${result.token}`, result);
    });
});
addJson(privacy
    .command('confirm')
    .description('Turn a candidate token into a self value')
    .argument('<token>', 'candidate token such as ‹候选1›')
    .option('--as <kind>', 'name, account, phone, email, or idcard', 'name')
    .option('--identity <domain>', 'site the candidate belongs to')
    .addHelpText('after', `
Examples:
  relaywright privacy confirm ‹候选1› --as name
`)).action(function (token) {
    const command = this;
    return guard(command, async () => {
        const identity = command.getOptionValue('identity');
        const result = await privacyConfirm(token, parsePrivacyKind(String(command.getOptionValue('as'))), identity);
        emit(command, `confirmed ${result.token}`, result);
    });
});
addJson(privacy
    .command('reject')
    .description('Stop treating a candidate as your own information')
    .argument('<token>', 'candidate token such as ‹候选1›')
    .option('--identity <domain>', 'site the candidate belongs to')
    .addHelpText('after', `
Examples:
  relaywright privacy reject ‹候选1›
`)).action(function (token) {
    const command = this;
    return guard(command, async () => {
        const identity = command.getOptionValue('identity');
        const result = await privacyReject(token, identity);
        emit(command, `rejected ${result.token}`, result);
    });
});
addJson(privacy
    .command('list')
    .description('List your own values. Length 4 or less shows the last character; longer values show the last two.')
    .option('--identity <domain>', 'site to list')
    .addHelpText('after', `
Examples:
  relaywright privacy list
  relaywright privacy list --identity school.edu.cn
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const identity = command.getOptionValue('identity');
        const result = await privacyList(identity);
        const text = result.self.length === 0 ? 'no self values' : result.self.map((item) => `${item.token}  ${item.kind}  ${item.masked}`).join('\n');
        emit(command, text, result);
    });
});
privacy
    .command('check')
    .description('Print detected values for the current page. Local CLI only; not available to MCP.')
    .addHelpText('after', `
Examples:
  relaywright privacy check
`)
    .action(function () {
    const command = this;
    return guard(command, async () => {
        const result = await privacyCheck();
        const counts = `self ${result.counts.self}  others ${result.counts.others}  candidates ${result.counts.candidates}`;
        const text = result.lines.length === 0 ? `nothing to report\n${counts}` : `${result.lines.join('\n')}\n${counts}`;
        process.stdout.write(`${text}\n`);
        void command;
    });
});
const identity = program.command('identity').description('Login identities stored by Chrome');
addJson(identity);
addJson(identity
    .command('list')
    .description('List identity metadata. Cookies stay in Chrome.')
    .addHelpText('after', `
Examples:
  relaywright identity list
  relaywright identity list --json
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const identities = await listIdentities();
        const text = identities.length === 0 ? 'no identities' : identities.map((item) => `${item.name}  ${item.domains.join(',')}  cookies ${item.cookie_count}`).join('\n');
        emit(command, text, { identities });
    });
});
addJson(identity
    .command('save')
    .description('Persist the active tab session after you logged in yourself')
    .argument('[name]', 'identity name; defaults to the registrable domain')
    .option('--domain <domain>', 'registrable domain to keep (repeatable)', collect, [])
    .addHelpText('after', `
Examples:
  relaywright identity save
  relaywright identity save school.edu.cn --domain school.edu.cn
`)).action(function (name) {
    const command = this;
    return guard(command, async () => {
        const domains = command.getOptionValue('domain');
        const saved = await saveIdentity({
            ...(name ? { name } : {}),
            ...(domains.length > 0 ? { domains } : {}),
        });
        emit(command, `saved ${saved.name}`, saved);
    });
});
addJson(identity
    .command('revoke')
    .description('Delete an identity and its matching cookies')
    .argument('<name>', 'identity name')
    .addHelpText('after', `
Examples:
  relaywright identity revoke school.edu.cn
`)).action(function (name) {
    const command = this;
    return guard(command, async () => {
        const removed = await revokeIdentity(name);
        emit(command, `revoked ${removed.name}`, removed);
    });
});
const heal = program.command('heal').description('Model used when the CLI repairs a failed skill step');
addJson(heal);
addJson(heal
    .command('config')
    .description('Show or set the OpenAI-compatible heal endpoint. The API key stays in the environment.')
    .option('--base-url <url>', 'chat completions origin, default https://api.deepseek.com')
    .option('--model <name>', 'model name, default deepseek-chat')
    .option('--api-key-env <var>', 'environment variable that holds the API key, default DEEPSEEK_API_KEY')
    .addHelpText('after', `
The key is read from the environment in this process and is not written to disk.
Examples:
  relaywright heal config
  relaywright heal config --base-url https://api.deepseek.com --model deepseek-chat --api-key-env DEEPSEEK_API_KEY
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const baseUrl = command.getOptionValue('baseUrl');
        const model = command.getOptionValue('model');
        const apiKeyEnv = command.getOptionValue('apiKeyEnv');
        const updating = baseUrl !== undefined || model !== undefined || apiKeyEnv !== undefined;
        const config = updating
            ? writeHealConfig({
                ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
                ...(model !== undefined ? { model } : {}),
                ...(apiKeyEnv !== undefined ? { api_key_env: apiKeyEnv } : {}),
            })
            : readHealConfig();
        emit(command, formatHealConfig(config), { ...config, api_key: healKeySet(config) ? 'set' : 'missing' });
    });
});
const audit = program.command('audit').description('Append-only audit log');
addJson(audit);
addJson(audit
    .command('tail')
    .description('Show the latest audit records')
    .option('-n, --lines <count>', 'number of records', '20')
    .addHelpText('after', `
Examples:
  relaywright audit tail
  relaywright audit tail -n 20 --json
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const limit = parseStepFlag('-n', String(command.getOptionValue('lines') ?? '20'));
        const records = tailAudit(limit);
        const text = records.length === 0
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
addJson(audit
    .command('verify')
    .description('Check the hash chain. Exit 1 at the first broken line.')
    .addHelpText('after', `
Examples:
  relaywright audit verify
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const result = verifyAudit();
        if (result.ok) {
            emit(command, 'audit: ok', { ok: true });
            return;
        }
        process.stderr.write(`${result.where}\n`);
        if (wantsJson(command))
            process.stdout.write(`${JSON.stringify({ ok: false, where: result.where }, null, 2)}\n`);
        process.exitCode = 1;
    });
});
function splitStatePath(spec) {
    const index = spec.indexOf('/');
    if (index <= 0 || index === spec.length - 1 || spec.includes('/', index + 1)) {
        throw new Error(`Expected ns/key, got ${JSON.stringify(spec)}\nExample: relaywright state get notes/last`);
    }
    return { ns: spec.slice(0, index), key: spec.slice(index + 1) };
}
function parseJsonArg(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error('Value must be JSON. Example: relaywright state set notes/last "\\"hello\\""');
    }
}
async function readStdinJson() {
    if (process.stdin.isTTY)
        throw new Error('Pass JSON as an argument, or pipe it on stdin');
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim();
    if (!text)
        throw new Error('Stdin was empty');
    return parseJsonArg(text);
}
function parseLimit(value) {
    if (value === undefined)
        return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2000)
        throw new Error('--limit must be an integer from 1 to 2000');
    return parsed;
}
function parseOptionalVersion(value) {
    if (value === undefined)
        return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0)
        throw new Error('--if-version must be a non-negative integer');
    return parsed;
}
function parsePrivacyState(state) {
    const normalized = state.trim().toLowerCase();
    if (normalized === 'on')
        return true;
    if (normalized === 'off')
        return false;
    throw new Error('Expected on or off');
}
function parsePrivacyKind(kind) {
    if (kind === 'name' || kind === 'account' || kind === 'phone' || kind === 'email' || kind === 'idcard')
        return kind;
    throw new Error('Kind must be name, account, phone, email, or idcard');
}
async function readStdinValue() {
    if (process.stdin.isTTY)
        throw new Error('Pass the value as an argument, or pipe it on stdin');
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    if (!value)
        throw new Error('Stdin was empty');
    return value;
}
function collect(value, previous = []) {
    return [...previous, value];
}
function onOff(value, flag) {
    if (value === undefined)
        return undefined;
    if (value === 'on')
        return true;
    if (value === 'off')
        return false;
    throw new Error(`${flag} must be on or off`);
}
function argvBool(name) {
    let value;
    for (const arg of process.argv) {
        if (arg === `--${name}`)
            value = true;
        if (arg === `--no-${name}`)
            value = false;
    }
    return value;
}
function parseStepFlag(flag, value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1)
        throw new Error(`${flag} must be a positive integer`);
    return parsed;
}
function pairs(values, example) {
    const params = {};
    for (const raw of values) {
        const index = raw.indexOf('=');
        if (index <= 0)
            throw new Error(`Expected key=value, got ${JSON.stringify(raw)}\nExample: ${example}`);
        params[raw.slice(0, index)] = raw.slice(index + 1);
    }
    return params;
}
function matrixPairs(values) {
    const matrix = {};
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
        if (items.length === 0)
            throw new Error(`matrix ${key} has no values`);
        matrix[key] = items;
    }
    return matrix;
}
function readChecks(path) {
    let raw;
    try {
        raw = JSON.parse(readTextFile(path));
    }
    catch (err) {
        throw new Error(`Could not read checks file: ${errorText(err)}`);
    }
    const parsed = z.array(CheckSchema).safeParse(raw);
    if (!parsed.success)
        throw new Error(issuesText(parsed.error));
    return parsed.data;
}
addJson(program
    .command('extract')
    .description('Read rows from the current page. Password fields come back as ‹redacted›.')
    .requiredOption('--root <css>', 'selector matched once per row')
    .option('--field <spec>', 'name=selector[@attr][*], repeatable', collect, [])
    .option('--limit <n>', 'max rows (default 200, max 2000)')
    .addHelpText('after', `
Examples:
  relaywright open https://example.com
  relaywright extract --root .row --field title=.title --field tags=.tag* --field link=.link@href
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const root = String(command.getOptionValue('root') ?? '');
        const specs = command.getOptionValue('field');
        if (specs.length === 0)
            throw new Error('Pass at least one --field name=selector[@attr][*]');
        const fields = {};
        for (const spec of specs) {
            const field = parseExtractField(spec);
            if (fields[field.name])
                throw new Error(`Duplicate field ${field.name}`);
            fields[field.name] = {
                selector: field.selector,
                ...(field.attr ? { attr: field.attr } : {}),
                ...(field.all ? { all: true } : {}),
            };
        }
        const limit = parseLimit(command.getOptionValue('limit'));
        const result = await extractPage({ root_selector: root, fields, ...(limit !== undefined ? { limit } : {}) });
        emit(command, JSON.stringify(result, null, 2), result);
    });
});
addJson(program
    .command('eval')
    .description(`Run an async function body in the page. ${EVAL_DISABLED_MESSAGE}`)
    .argument('<expr>', 'function body; args is the JSON argument array')
    .option('--arg <json>', 'one JSON argument, repeatable', collect, [])
    .addHelpText('after', `
Examples:
  relaywright config set eval on
  relaywright eval "return args[0] + args[1]" --arg 2 --arg 3
`)).action(function (expr) {
    const command = this;
    return guard(command, async () => {
        const args = command.getOptionValue('arg').map((item) => parseJsonArg(item));
        const result = await evalInPage(expr, args);
        emit(command, JSON.stringify(result, null, 2), { result });
    });
});
const configCmd = program.command('config').description('Local daemon settings');
addJson(configCmd);
addJson(configCmd
    .command('set')
    .description('Turn a setting on or off')
    .argument('<key>', 'eval')
    .argument('<value>', 'on or off')
    .addHelpText('after', `
Examples:
  relaywright config set eval on
  relaywright config set eval off
`)).action(function (key, value) {
    const command = this;
    return guard(command, async () => {
        if (key !== 'eval')
            throw new Error('Supported setting: eval');
        const on = parsePrivacyState(value);
        setEvalEnabled(on);
        emit(command, `eval ${on ? 'on' : 'off'}`, { eval: on });
    });
});
const state = program.command('state').description('JSON values shared by skills and clients');
addJson(state);
addJson(state
    .command('set')
    .description('Write a JSON value. Pass - to read JSON from stdin.')
    .argument('<ns/key>', 'namespace and key, for example notes/last')
    .argument('<json>', 'JSON value, or - for stdin')
    .option('--if-version <n>', 'write only when the current version matches (0 if the key is new)')
    .addHelpText('after', `
Examples:
  relaywright state set notes/last '"hello"'
  echo {"title":"note"} | relaywright state set notes/row -
  relaywright state set notes/last '"hello"' --if-version 0
`)).action(function (spec, json) {
    const command = this;
    return guard(command, async () => {
        const { ns, key } = splitStatePath(spec);
        const value = json === '-' ? await readStdinJson() : parseJsonArg(json);
        const ifVersion = parseOptionalVersion(command.getOptionValue('ifVersion'));
        const entry = await putState(ns, key, value, ifVersion);
        emit(command, `${ns}/${key} version ${entry.version}`, { ns, key, version: entry.version, updated_at: entry.updated_at });
    });
});
addJson(state
    .command('get')
    .description('Read one JSON value and its version')
    .argument('<ns/key>', 'namespace and key')
    .addHelpText('after', `
Examples:
  relaywright state get notes/last
  relaywright state get notes/last --json
`)).action(function (spec) {
    const command = this;
    return guard(command, async () => {
        const { ns, key } = splitStatePath(spec);
        const entry = await getState(ns, key);
        const text = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
        emit(command, `${text}\nversion ${entry.version}`, entry);
    });
});
addJson(state
    .command('list')
    .description('List keys and versions in a namespace')
    .argument('<ns>', 'namespace')
    .addHelpText('after', `
Examples:
  relaywright state list notes
`)).action(function (ns) {
    const command = this;
    return guard(command, async () => {
        const listed = await listState(ns);
        const text = listed.keys.length === 0 ? '(empty)' : listed.keys.map((item) => `${item.key}  version ${item.version}`).join('\n');
        emit(command, text, listed);
    });
});
addJson(state
    .command('rm')
    .description('Delete one key')
    .argument('<ns/key>', 'namespace and key')
    .option('--if-version <n>', 'delete only when the current version matches')
    .addHelpText('after', `
Examples:
  relaywright state rm notes/last
`)).action(function (spec) {
    const command = this;
    return guard(command, async () => {
        const { ns, key } = splitStatePath(spec);
        const ifVersion = parseOptionalVersion(command.getOptionValue('ifVersion'));
        const removed = await deleteState(ns, key, ifVersion);
        emit(command, `removed ${ns}/${key} (version ${removed.version})`, { ns, key, version: removed.version });
    });
});
addJson(program
    .command('init')
    .description('Choose browser mode, privacy, eval, and heal settings. Safe to run again.')
    .option('--yes', 'accept the current value for every question that has no flag')
    .option('--browser <mode>', 'separate, daily, or cdp')
    .option('--cdp-url <url>', 'endpoint used when --browser is cdp')
    .option('--allow-domains <list>', 'comma-separated registrable domains')
    .option('--headless', 'run the separate Chrome headless')
    .option('--downloads <dir>', 'directory for saved files')
    .option('--privacy <on|off>', 'model redaction')
    .option('--eval <on|off>', 'page eval')
    .option('--notify <on|off>', 'desktop notifications')
    .option('--heal-base-url <url>', 'self-heal API base url')
    .option('--heal-model <model>', 'self-heal model')
    .option('--api-key-env <name>', 'env var that holds the heal API key')
    .option('--test-llm', 'send one tiny heal request and print token counts')
    .option('--write-mcp <target>', 'write the Cursor MCP config')
    .option('--self <kind=value>', 'register a self value without printing it', collect, [])
    .addHelpText('after', `
Non-interactive when stdin is not a TTY, or with --yes. A TTY asks; the default for test-connect is no.
Examples:
  relaywright init --yes --browser separate --privacy off --eval off --notify off
  relaywright init --browser daily --allow-domains example.com
  relaywright init --write-mcp cursor
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const writeMcp = command.getOptionValue('writeMcp');
        if (writeMcp !== undefined && writeMcp !== 'cursor') {
            throw new Error('--write-mcp only supports cursor');
        }
        const browser = command.getOptionValue('browser');
        if (browser !== undefined && browser !== 'separate' && browser !== 'daily' && browser !== 'cdp') {
            throw new Error('--browser must be separate, daily, or cdp');
        }
        const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
        const result = await runInit({
            yes: command.getOptionValue('yes') === true || !tty,
            tty,
            ...(browser === 'separate' || browser === 'daily' || browser === 'cdp' ? { browser } : {}),
            cdpUrl: command.getOptionValue('cdpUrl'),
            allowDomains: command.getOptionValue('allowDomains'),
            headless: argvBool('headless'),
            downloads: command.getOptionValue('downloads'),
            privacy: onOff(command.getOptionValue('privacy'), '--privacy'),
            eval: onOff(command.getOptionValue('eval'), '--eval'),
            notify: onOff(command.getOptionValue('notify'), '--notify'),
            healBaseUrl: command.getOptionValue('healBaseUrl'),
            healModel: command.getOptionValue('healModel'),
            apiKeyEnv: command.getOptionValue('apiKeyEnv'),
            testLlm: command.getOptionValue('testLlm') === true,
            writeMcp: writeMcp === 'cursor' ? writeMcp : undefined,
            self: command.getOptionValue('self') ?? [],
        });
        emit(command, formatInit(result), result);
        if (result.connectError)
            process.exitCode = 1;
    });
});
addJson(program
    .command('doctor')
    .description('Check the local setup. Does not connect to a browser.')
    .addHelpText('after', `
Examples:
  relaywright doctor
  relaywright doctor --json
`)).action(function () {
    const command = this;
    return guard(command, async () => {
        const report = await runDoctor();
        emit(command, formatDoctor(report.checks), report);
        if (!report.ok)
            process.exitCode = 1;
    });
});
program.parseAsync(process.argv).catch((err) => {
    process.stderr.write(`Error: ${errorText(err)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=index.js.map