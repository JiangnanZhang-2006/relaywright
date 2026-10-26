import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relaywrightHome } from '../config/paths.js';
import { healKeySet, readHealConfig, writeHealConfig, type HealConfig } from '../healer/config.js';
import { notify } from '../notify.js';
import { Redactor } from '../privacy/redactor.js';
import { readGlobalConfig, updateGlobalConfig, type GlobalConfig } from '../privacy/store.js';
import { normalizeAllowDomain } from '../session/allowlist.js';
import type { SelfKind } from '../privacy/detect.js';

export type BrowserChoice = 'own' | 'attach' | 'cdp';

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
  writeMcp?: boolean;
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

const ATTACH_GUIDE =
  'Attach: open chrome://inspect/#remote-debugging in your daily Chrome, allow remote debugging, then run: relaywright daemon attach --auto';

const TAB_SCOPE = 'Tab scope: relaywright only sees tabs it opens. Other tabs stay hidden unless you run: relaywright tabs adopt --index <n>';

export async function runInit(options: InitOptions = {}, root = relaywrightHome()): Promise<InitResult> {
  const current = readGlobalConfig(root);
  const interactive = options.tty === true && options.yes !== true;
  const answers = interactive ? await prompt(current) : {};
  const browser = options.browser ?? answers.browser ?? current.browser?.mode ?? 'own';
  if (browser !== 'own' && browser !== 'attach' && browser !== 'cdp') throw new Error('--browser must be own, attach, or cdp');
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
  const registered = registerSelf(options.self ?? answers.self ?? [], root);
  let mcp: string | undefined;
  if (options.writeMcp) mcp = writeCursorMcp(options.cwd ?? process.cwd());
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
  if (result.browser !== 'own') lines.splice(1, 0, ATTACH_GUIDE, TAB_SCOPE);
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

async function prompt(current: GlobalConfig): Promise<Answers> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const browser = (await ask(rl, 'Browser mode own/attach/cdp', current.browser?.mode ?? 'own')) as BrowserChoice;
    const answers: Answers = { browser };
    if (browser === 'cdp') answers.cdpUrl = await ask(rl, 'cdp url', current.browser?.cdp_url ?? '');
    if (browser !== 'own') {
      process.stdout.write(`${ATTACH_GUIDE}\n${TAB_SCOPE}\n`);
      const domains = await ask(rl, 'Allow domains, comma separated', (current.allow_domains ?? []).join(','));
      answers.allowDomains = parseDomains(domains);
      const connect = await ask(rl, 'Test-connect now? yes/no', 'no');
      answers.testConnect = connect === 'yes';
    }
    answers.headless = (await ask(rl, 'Headless on/off', current.headless ? 'on' : 'off')) === 'on';
    answers.downloads = await ask(rl, 'Download directory', current.downloads ?? 'downloads');
    answers.privacy = (await ask(rl, 'Model redaction on/off', current.privacy?.model_redaction ? 'on' : 'off')) === 'on';
    rl.pause();
    const name = await readHidden('Your name (empty skips, not echoed): ');
    const account = await readHidden('Your account (empty skips, not echoed): ');
    rl.resume();
    answers.self = [...(name ? [`name=${name}`] : []), ...(account ? [`account=${account}`] : [])];
    answers.eval = (await ask(rl, 'Page eval on/off', current.eval ? 'on' : 'off')) === 'on';
    const heal = readHealConfig();
    answers.healBaseUrl = await ask(rl, 'Heal base url', heal.base_url);
    answers.healModel = await ask(rl, 'Heal model', heal.model);
    answers.apiKeyEnv = await ask(rl, 'Heal api key env', heal.api_key_env);
    process.stdout.write(`${heal.api_key_env}: ${healKeySet(heal) ? 'set' : 'missing'}\n`);
    answers.notify = (await ask(rl, 'Notifications on/off', current.notify === false ? 'off' : 'on')) === 'on';
    return answers;
  } finally {
    rl.close();
  }
}

function ask(rl: ReturnType<typeof createInterface>, label: string, current: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${label} [${current}]: `, (answer) => resolve(answer.trim() || current));
  });
}

function readHidden(label: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.resolve('');
  process.stdout.write(label);
  return new Promise((resolve) => {
    const raw = stdin as NodeJS.ReadStream;
    raw.setRawMode(true);
    raw.resume();
    raw.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string): void => {
      if (chunk === '\u0003') {
        raw.setRawMode(false);
        raw.pause();
        raw.off('data', onData);
        process.stdout.write('\n');
        process.exitCode = 1;
        resolve('');
        return;
      }
      if (chunk === '\r' || chunk === '\n') {
        raw.setRawMode(false);
        raw.pause();
        raw.off('data', onData);
        process.stdout.write('\n');
        resolve(value.trim());
        return;
      }
      if (chunk === '\u007f' || chunk === '\b') {
        value = [...value].slice(0, -1).join('');
        return;
      }
      value += chunk;
    };
    raw.on('data', onData);
  });
}
