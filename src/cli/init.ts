import { clearScreenDown, cursorTo, emitKeypressEvents, moveCursor, type Key } from 'node:readline';
import { ReadStream as TtyReadStream } from 'node:tty';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import { relaywrightHome } from '../config/paths.js';
import { healKeySet, readHealConfig, writeHealConfig, type HealConfig } from '../healer/config.js';
import { notify } from '../notify.js';
import { Redactor } from '../privacy/redactor.js';
import { readGlobalConfig, updateGlobalConfig, type GlobalConfig } from '../privacy/store.js';
import { normalizeAllowDomain } from '../session/allowlist.js';
import type { SelfKind } from '../privacy/detect.js';

export type BrowserChoice = 'separate' | 'daily' | 'cdp';

export interface InitOptions {
  yes?: boolean;
  tty?: boolean;
  browser?: BrowserChoice;
  cdpUrl?: string;
  allowDomains?: string;
  headless?: boolean;
  downloads?: string;
  privacy?: boolean;
  eval?: boolean;
  notify?: boolean;
  healBaseUrl?: string;
  healModel?: string;
  apiKeyEnv?: string;
  testLlm?: boolean;
  writeMcp?: 'cursor';
  self?: string[];
  cwd?: string;
}

export interface InitResult {
  browser: BrowserChoice;
  cdp_url?: string;
  allow_domains: string[];
  headless: boolean;
  downloads: string;
  privacy: boolean;
  eval: boolean;
  notify: boolean;
  heal: { base_url: string; model: string; api_key_env: string; api_key: 'set' | 'missing' };
  initialized_at: string;
  mcp?: string;
  self: string[];
  note?: string;
  /** Set when the interactive test-connect was requested and failed. Config is already saved. */
  connectError?: string;
}

const INSPECT_URL = 'chrome://inspect/#remote-debugging';

const ATTACH_GUIDE =
  'Attach: open chrome://inspect/#remote-debugging in your daily Chrome, allow remote debugging, then run: relaywright daemon attach --auto';

const TAB_SCOPE =
  'Tab scope: relaywright only sees tabs it opens. Other tabs stay hidden until you adopt one: relaywright tabs adopt --index <n>, or the model calls browser_tabs action=user and then action=adopt (that asks you to confirm).';

function terminalAppName(): string {
  const hints = [process.env.VSCODE_GIT_ASKPASS_MAIN, process.env.VSCODE_GIT_ASKPASS_NODE, process.env.PATH].join('\n');
  if (hints.includes('Cursor.app')) return 'Cursor';
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') return 'Terminal';
  if (process.env.TERM_PROGRAM === 'iTerm.app') return 'iTerm';
  return 'your terminal app';
}

function dailyAccessLines(): string[] {
  const lines = ['Daily Chrome access:', '1. In that Chrome, open', INSPECT_URL, '   and allow remote debugging.'];
  if (process.platform === 'darwin') {
    lines.push(`2. System Settings → Privacy & Security → Files & Folders → ${terminalAppName()} → turn on Google Chrome.`);
    lines.push('   macOS does not ask. The switch takes effect immediately.');
    lines.push('3. Run: relaywright daemon attach --auto');
  } else {
    lines.push('2. Run: relaywright daemon attach --auto');
  }
  lines.push(TAB_SCOPE);
  return lines;
}

function colorInspect(text: string): string {
  return text.replaceAll(INSPECT_URL, styleText(['bold', 'cyan', 'underline'], INSPECT_URL));
}

export async function runInit(options: InitOptions = {}, root = relaywrightHome()): Promise<InitResult> {
  const current = readGlobalConfig(root);
  const interactive = options.tty === true && options.yes !== true;
  const answers = interactive ? await prompt(current, root) : {};
  const browser = options.browser ?? answers.browser ?? current.browser?.mode ?? 'separate';
  if (browser !== 'separate' && browser !== 'daily' && browser !== 'cdp') throw new Error('--browser must be separate, daily, or cdp');
  const cdpUrl = options.cdpUrl ?? answers.cdpUrl ?? current.browser?.cdp_url;
  if (browser === 'cdp' && !cdpUrl) throw new Error('--cdp-url is required when --browser is cdp');
  const allow = options.allowDomains !== undefined ? parseDomains(options.allowDomains) : answers.allowDomains ?? current.allow_domains ?? [];
  const headless = options.headless ?? answers.headless ?? current.headless ?? false;
  const downloads = options.downloads ?? answers.downloads ?? current.downloads ?? join(root, 'downloads');
  const privacy = options.privacy ?? answers.privacy ?? current.privacy?.model_redaction ?? false;
  const evalOn = options.eval ?? answers.eval ?? current.eval ?? false;
  const notifyOn = options.notify ?? answers.notify ?? current.notify ?? true;
  const initializedAt = new Date().toISOString();

  updateGlobalConfig((config) => {
    config.browser = {
      ...(config.browser ?? {}),
      mode: browser,
      ...(browser === 'cdp' && cdpUrl ? { cdp_url: cdpUrl } : {}),
    };
    if (browser !== 'cdp') delete config.browser.cdp_url;
    config.allow_domains = allow;
    config.headless = headless;
    config.downloads = downloads;
    config.eval = evalOn;
    config.notify = notifyOn;
    config.privacy = { ...(config.privacy ?? {}), model_redaction: privacy };
    config.initialized_at = initializedAt;
  }, root);

  if (options.healBaseUrl || options.healModel || options.apiKeyEnv || answers.healBaseUrl || answers.healModel || answers.apiKeyEnv) {
    writeHealConfig(
      {
        ...(options.healBaseUrl || answers.healBaseUrl ? { base_url: options.healBaseUrl ?? answers.healBaseUrl } : {}),
        ...(options.healModel || answers.healModel ? { model: options.healModel ?? answers.healModel } : {}),
        ...(options.apiKeyEnv || answers.apiKeyEnv ? { api_key_env: options.apiKeyEnv ?? answers.apiKeyEnv } : {}),
      },
      root,
    );
  }
  const heal = readHealConfig(root);
  const fromFlag = options.self && options.self.length > 0 ? options.self : undefined;
  const registered = registerSelf(fromFlag ?? answers.self ?? [], root);
  let mcp: string | undefined;
  if (options.writeMcp === 'cursor') mcp = writeCursorMcp(options.cwd ?? process.cwd());
  if (notifyOn) notify('relaywright', 'Notifications are on');
  const notes: string[] = [];
  let connectError: string | undefined;
  if (answers.testConnect) {
    try {
      const { attachBrowser } = await import('../daemon/client.js');
      const attached = await attachBrowser(browser === 'cdp' && cdpUrl ? { cdpUrl } : { auto: true });
      notes.push(`test-connect: ${attached.mode} (${attached.endpoint_kind})`);
    } catch (err) {
      connectError = err instanceof Error ? err.message : 'test-connect failed';
      notes.push(`test-connect failed: ${connectError}`);
    }
  }
  if (options.testLlm) notes.push(await testLlm(heal));
  const note = notes.filter((line) => line.length > 0).join('\n');

  return {
    browser,
    ...(browser === 'cdp' && cdpUrl ? { cdp_url: cdpUrl } : {}),
    allow_domains: allow,
    headless,
    downloads,
    privacy,
    eval: evalOn,
    notify: notifyOn,
    heal: { base_url: heal.base_url, model: heal.model, api_key_env: heal.api_key_env, api_key: healKeySet(heal) ? 'set' : 'missing' },
    initialized_at: initializedAt,
    ...(mcp ? { mcp } : {}),
    self: registered,
    ...(note ? { note } : {}),
    ...(connectError ? { connectError } : {}),
  };
}

export function formatInit(result: InitResult): string {
  const lines = [
    `browser: ${result.browser}`,
    ...(result.cdp_url ? [`cdp_url: ${result.cdp_url}`] : []),
    `allow_domains: ${result.allow_domains.join(', ') || '(none)'}`,
    `headless: ${result.headless ? 'on' : 'off'}`,
    `downloads: ${result.downloads}`,
    `privacy: ${result.privacy ? 'on' : 'off'}`,
    `eval: ${result.eval ? 'on' : 'off'}`,
    `notify: ${result.notify ? 'on' : 'off'}`,
    `heal: ${result.heal.model} via ${result.heal.api_key_env} (${result.heal.api_key})`,
    `self: ${result.self.length > 0 ? result.self.join(', ') : '(none)'}`,
    ...(result.mcp ? [`mcp: ${result.mcp}`] : []),
    ...(result.note ? [result.note] : []),
    mcpSnippet(),
    'Next: relaywright doctor',
  ];
  if (result.browser === 'daily') lines.splice(1, 0, ...dailyAccessLines().map(colorInspect));
  else if (result.browser !== 'separate') lines.splice(1, 0, colorInspect(ATTACH_GUIDE), TAB_SCOPE);
  return lines.join('\n');
}

function parseDomains(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter((item) => item.length > 0).map((item) => normalizeAllowDomain(item)))];
}

function registerSelf(entries: string[], root: string): string[] {
  if (entries.length === 0) return [];
  const redactor = new Redactor({ root, audit: () => undefined });
  const registered: string[] = [];
  for (const entry of entries) {
    const split = entry.indexOf('=');
    if (split <= 0) throw new Error('--self must look like name=Ada or account=ada');
    const kind = entry.slice(0, split) as SelfKind;
    const value = entry.slice(split + 1);
    if (kind !== 'name' && kind !== 'account' && kind !== 'phone' && kind !== 'email' && kind !== 'idcard') {
      throw new Error('--self kind must be name, account, phone, email, or idcard');
    }
    redactor.addSelf(kind, value, { identity: 'self' });
    registered.push(kind);
  }
  return registered;
}

export function writeCursorMcp(cwd: string): string {
  const path = join(cwd, '.cursor', 'mcp.json');
  mkdirSync(dirname(path), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = { ...(parsed as Record<string, unknown>) };
  }
  const servers = existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers)
    ? { ...(existing.mcpServers as Record<string, unknown>) }
    : {};
  const launch = mcpLaunch();
  servers.relaywright = { command: launch.command, args: launch.args };
  existing.mcpServers = servers;
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  return path;
}

export function mcpLaunch(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  const cli = here.replace(/init\.(ts|js)$/, 'index.$1');
  if (cli.endsWith('.ts')) {
    const tsx = join(dirname(here), '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    return { command: process.execPath, args: [tsx, cli, 'mcp'] };
  }
  return { command: process.execPath, args: [cli, 'mcp'] };
}

export function mcpSnippet(): string {
  const launch = mcpLaunch();
  return JSON.stringify({ mcpServers: { relaywright: { command: launch.command, args: launch.args } } }, null, 2);
}

async function testLlm(config: HealConfig): Promise<string> {
  const key = process.env[config.api_key_env]?.trim();
  if (!key) return `${config.api_key_env} is not set; skipped the model check`;
  let response: Response;
  try {
    response = await fetch(`${config.base_url}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: 'Reply with ok' }],
      max_tokens: 4,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'heal test failed';
    throw new Error(message.split(key).join('[redacted]'));
  }
  const body = (await response.json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  if (!response.ok) throw new Error(`heal test failed (${response.status})`);
  const prompt = body.usage?.prompt_tokens ?? 0;
  const completion = body.usage?.completion_tokens ?? 0;
  return `heal test tokens: prompt ${prompt}, completion ${completion}`;
}

interface Answers {
  browser?: BrowserChoice;
  cdpUrl?: string;
  allowDomains?: string[];
  headless?: boolean;
  downloads?: string;
  privacy?: boolean;
  eval?: boolean;
  notify?: boolean;
  healBaseUrl?: string;
  healModel?: string;
  apiKeyEnv?: string;
  self?: string[];
  testConnect?: boolean;
}

/** One raw-mode read for the whole wizard. A readline interface redraws over itself and steals hidden input. */
class Wizard {
  private input: TtyReadStream | undefined;
  private readonly output = process.stdout;
  private drawn = 0;
  private opened = false;
  private onKey: ((press: Press) => void) | null = null;
  private pending: Press[] = [];
  /** True until the next turn after CR, so the LF in a CRLF does not submit twice. */
  private crlf = false;

  open(): void {
    if (!process.stdin.isTTY) throw new Error('init prompts need a TTY');
    const input = process.stdin as TtyReadStream;
    emitKeypressEvents(input);
    input.setRawMode(true);
    this.input = input;
    this.opened = true;
    input.resume();
    bindKeypress(input, this.handle, true);
  }

  close(): void {
    const input = this.input;
    if (!this.opened || !input) return;
    this.opened = false;
    this.onKey = null;
    this.pending.length = 0;
    bindKeypress(input, this.handle, false);
    try {
      input.setRawMode(false);
    } finally {
      input.pause();
    }
  }

  note(text: string): void {
    this.paint(text.split('\n'), true);
  }

  select<T extends string>(label: string, options: readonly { value: T; hint?: string }[], initial: T, hint?: string): Promise<T> {
    let cursor = options.findIndex((item) => item.value === initial);
    if (cursor < 0) cursor = 0;
    const width = options.reduce((max, item) => Math.max(max, item.value.length), 0);
    return this.step(
      () => {
        const lines = [RULE, `? ${label}`];
        if (hint) for (const line of hint.split('\n')) lines.push(`  ${line}`);
        for (const [index, item] of options.entries()) {
          const mark = index === cursor ? '>' : ' ';
          const text = item.hint ? `${item.value.padEnd(width)}  ${item.hint}` : item.value;
          lines.push(`  ${mark} ${text}`);
        }
        return lines;
      },
      (press) => {
        if (press.name === 'up') {
          cursor = (cursor - 1 + options.length) % options.length;
          return KEEP;
        }
        if (press.name === 'down') {
          cursor = (cursor + 1) % options.length;
          return KEEP;
        }
        if (isEnter(press)) return options[cursor]?.value ?? options[0].value;
        return KEEP;
      },
      (picked) => [RULE, `* ${label}  ${picked}`],
    );
  }

  text(label: string, hint: string, initial: string, empty: 'keep' | 'blank', validate?: (value: string) => string | undefined): Promise<string> {
    let value = initial;
    let error = '';
    return this.step(
      () => {
        const lines = [RULE, `? ${label}`, ...hint.split('\n').map((line) => `  ${line}`), `  > ${value}`];
        if (error) lines.push(`  ! ${error}`);
        return lines;
      },
      (press) => {
        const edited = edit(press, value);
        value = edited.value;
        if (!edited.submit) return KEEP;
        const trimmed = value.trim();
        const next = trimmed.length === 0 && empty === 'keep' ? initial : trimmed;
        const problem = validate?.(next);
        if (problem) {
          error = problem;
          value = next;
          return KEEP;
        }
        return next;
      },
      (picked) => [RULE, `* ${label}  ${picked.length > 0 ? picked : '(empty)'}`],
    );
  }

  secret(label: string, hint: string): Promise<string> {
    let value = '';
    let error = '';
    return this.step(
      () => {
        const lines = [RULE, `? ${label}`, ...hint.split('\n').map((line) => `  ${line}`), `  > ${'*'.repeat([...value].length)}`];
        if (error) lines.push(`  ! ${error}`);
        return lines;
      },
      (press) => {
        const edited = edit(press, value);
        value = edited.value;
        if (!edited.submit) return KEEP;
        const trimmed = value.trim();
        if ([...trimmed].length > 80) {
          error = 'use 80 characters or fewer';
          return KEEP;
        }
        error = '';
        return trimmed;
      },
      (picked) => [RULE, `* ${label}  ${picked.length > 0 ? 'saved' : 'skipped'}`],
    );
  }

  private readonly handle = (str: string | undefined, key: Key | undefined): void => {
    const press: Press = {
      name: key?.name,
      ctrl: key?.ctrl === true,
      meta: key?.meta === true,
      str: typeof str === 'string' ? str : '',
    };
    if (press.name === 'enter' && this.crlf) return;
    if (press.name === 'return') {
      this.crlf = true;
      queueMicrotask(() => {
        this.crlf = false;
      });
    }
    if (this.onKey) this.onKey(press);
    else this.pending.push(press);
  };

  private flush(): void {
    while (this.onKey && this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) return;
      this.onKey(next);
    }
  }

  private step<T>(view: () => string[], onPress: (press: Press) => T | typeof KEEP, summary: (value: T) => string[]): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const stop = (): void => {
        settled = true;
        this.onKey = null;
      };
      const cancel = (): void => {
        if (settled) return;
        stop();
        this.pending.length = 0;
        this.paint([RULE, 'x cancelled, nothing saved'], true);
        reject(new Cancelled());
      };
      const accept = (value: T): void => {
        if (settled) return;
        stop();
        this.paint(summary(value), true);
        resolve(value);
      };
      this.onKey = (press) => {
        if (press.ctrl && press.name === 'c') {
          cancel();
          return;
        }
        const result = onPress(press);
        if (result !== KEEP) accept(result);
        else if (!settled) this.paint(view(), false);
      };
      this.flush();
      if (!settled) this.paint(view(), false);
    });
  }

  private paint(lines: string[], commit: boolean): void {
    const wrapped = lines.flatMap((line) => wrapLine(line));
    if (this.drawn > 0) {
      moveCursor(this.output, 0, -this.drawn);
      cursorTo(this.output, 0);
      clearScreenDown(this.output);
    }
    this.output.write(`${wrapped.join('\n')}\n`);
    this.drawn = commit ? 0 : wrapped.length;
  }
}

async function prompt(current: GlobalConfig, root: string): Promise<Answers> {
  const wizard = new Wizard();
  wizard.open();
  try {
    const answers: Answers = {};
    const onOff = async (label: string, hint: string, on: boolean): Promise<boolean> => {
      const picked = await wizard.select<'on' | 'off'>(label, [{ value: 'on' }, { value: 'off' }], on ? 'on' : 'off', hint);
      return picked === 'on';
    };
    wizard.note('relaywright init\narrows move. enter accepts. ctrl-c saves nothing.');
    answers.browser = await wizard.select<BrowserChoice>(
      'Browser',
      [
        { value: 'separate', hint: 'a Chrome for relaywright, with its own logins' },
        { value: 'daily', hint: 'the Chrome you already use' },
        { value: 'cdp', hint: 'a DevTools endpoint you provide' },
      ],
      current.browser?.mode ?? 'separate',
    );
    if (answers.browser === 'cdp') {
      answers.cdpUrl = await wizard.text(
        'cdp url',
        'DevTools endpoint, such as http://127.0.0.1:9222.',
        current.browser?.cdp_url ?? '',
        'keep',
        (value) => (value ? undefined : 'a cdp url is required'),
      );
    }
    if (answers.browser === 'daily') wizard.note(colorInspect(dailyAccessLines().join('\n')));
    else if (answers.browser !== 'separate') wizard.note(colorInspect(`${ATTACH_GUIDE}\n${TAB_SCOPE}`));
    if (answers.browser !== 'separate') {
      const domains = await wizard.text(
        'Allow domains',
        'Comma separated. Only these sites can be opened.\nAn empty list blocks every site.',
        (current.allow_domains ?? []).join(','),
        'blank',
        rejectDomains,
      );
      answers.allowDomains = parseDomains(domains);
      const connect = await wizard.select<'no' | 'yes'>('Test-connect', [{ value: 'no' }, { value: 'yes' }], 'no', 'yes tries now. no waits. A failed try still saves.');
      answers.testConnect = connect === 'yes';
    }
    answers.headless = await onOff(
      'Headless',
      'on hides the window relaywright launches. off shows it.\nAn attached browser stays as it is.',
      current.headless === true,
    );
    answers.downloads = await wizard.text('Download directory', 'Where files saved from the browser are written.', current.downloads ?? 'downloads', 'keep');
    answers.privacy = await onOff(
      'Model redaction',
      'on replaces personal values before the model sees the page.\noff sends the page text as read.',
      current.privacy?.model_redaction === true,
    );
    const name = await wizard.secret('Your name', 'Stored only on this computer. Empty enter skips. Not shown.');
    const account = await wizard.secret('Your account', 'An account id, such as a student number.\nEmpty enter skips. Not shown.');
    answers.self = [...(name ? [`name=${name}`] : []), ...(account ? [`account=${account}`] : [])];
    answers.eval = await onOff('Page eval', 'on lets the model run scripts in the page.\noff keeps that closed. Reading uses extract.', current.eval === true);
    const heal = readHealConfig(root);
    answers.healBaseUrl = await wizard.text(
      'Heal base url',
      'API used when a saved skill step needs a new control.',
      heal.base_url,
      'keep',
      rejectBaseUrl,
    );
    answers.healModel = await wizard.text('Heal model', 'Model name sent to that API.', heal.model, 'keep', (value) => (value ? undefined : 'model must not be empty'));
    answers.apiKeyEnv = await wizard.text(
      'Heal api key env',
      'Variable that holds the API key. The key is not stored.',
      heal.api_key_env,
      'keep',
      rejectEnvName,
    );
    wizard.note(`${answers.apiKeyEnv}: ${healKeySet({ ...heal, api_key_env: answers.apiKeyEnv }) ? 'set' : 'missing'}`);
    answers.notify = await onOff('Notifications', 'on notifies you to log in or solve a captcha.', current.notify !== false);
    return answers;
  } finally {
    wizard.close();
  }
}

const RULE = '-'.repeat(32);
const KEEP = Symbol('keep');
const NAMED_KEYS = new Set(['up', 'down', 'left', 'right', 'escape', 'tab', 'home', 'end', 'pageup', 'pagedown', 'insert']);

class Cancelled extends Error {
  constructor() {
    super('init cancelled, nothing saved');
    this.name = 'Cancelled';
  }
}

interface Press {
  name?: string;
  ctrl: boolean;
  meta: boolean;
  str: string;
}

function bindKeypress(input: TtyReadStream, listener: (str: string | undefined, key: Key | undefined) => void, bound: boolean): void {
  const stream = input as TtyReadStream & {
    on(event: 'keypress', cb: (str: string | undefined, key: Key | undefined) => void): void;
    off(event: 'keypress', cb: (str: string | undefined, key: Key | undefined) => void): void;
  };
  if (bound) stream.on('keypress', listener);
  else stream.off('keypress', listener);
}

function isEnter(press: Press): boolean {
  return press.name === 'return' || press.name === 'enter';
}

function isBackspace(press: Press): boolean {
  return press.name === 'backspace' || press.name === 'delete';
}

function edit(press: Press, value: string): { value: string; submit: boolean } {
  if (isEnter(press)) return { value, submit: true };
  if (isBackspace(press)) return { value: [...value].slice(0, -1).join(''), submit: false };
  if (press.ctrl && press.name === 'u') return { value: '', submit: false };
  if (press.ctrl || press.meta || (press.name !== undefined && NAMED_KEYS.has(press.name))) return { value, submit: false };
  if (!press.str) return { value, submit: false };
  let next = value;
  let submit = false;
  for (const char of press.str) {
    if (char === '\n' || char === '\r') {
      submit = true;
      break;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    next += char;
  }
  return { value: next, submit };
}

function rejectBaseUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'base url must be an http or https URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'base url must be http or https';
  return undefined;
}

function rejectEnvName(value: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return 'use a variable name such as DEEPSEEK_API_KEY';
  return undefined;
}

function rejectDomains(value: string): string | undefined {
  try {
    parseDomains(value);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid domain';
  }
}

function columns(): number {
  const value = process.stdout.columns;
  return Number.isInteger(value) && value >= 40 ? value : 80;
}

function cellWidth(code: number): number {
  if (code < 0x20 || code === 0x7f) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(text: string): number {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  let used = 0;
  for (const char of plain) {
    const size = cellWidth(char.codePointAt(0) ?? 0);
    if (size > 0) used += size;
  }
  return used;
}

function wrapLine(text: string): string[] {
  const limit = Math.max(20, columns() - 1);
  if (text.length === 0 || displayWidth(text) <= limit) return [text];
  const lines: string[] = [];
  let rest = text;
  while (displayWidth(rest) > limit) {
    let index = 0;
    let used = 0;
    let lastSpace = -1;
    for (const char of rest) {
      const size = Math.max(1, cellWidth(char.codePointAt(0) ?? 0));
      if (used + size > limit) break;
      if (char === ' ') lastSpace = index;
      index += char.length;
      used += size;
    }
    const cut = lastSpace > 0 ? lastSpace : Math.max(index, [...rest][0]?.length ?? 1);
    const line = rest.slice(0, cut).trimEnd();
    const next = rest.slice(cut).trimStart();
    if (line.length === 0 || next.length === rest.length) {
      lines.push(rest);
      rest = '';
      break;
    }
    lines.push(line);
    rest = next;
  }
  if (rest.length > 0) lines.push(rest);
  return lines.length > 0 ? lines : [''];
}
