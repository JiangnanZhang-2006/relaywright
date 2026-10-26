import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { whichBrowser } from '../browser/resolve.js';
import { verifyAudit } from '../audit/log.js';
import { configPath, defaultProfileDir, errorText, relaywrightHome } from '../config/paths.js';
import { findHealthyDaemon } from '../daemon/client.js';
import { formatBuildMismatch, readBuildFingerprint } from '../daemon/build.js';
import { healKeySet, missingKeyHint, readHealConfig } from '../healer/config.js';
import { readGlobalConfig } from '../privacy/store.js';
import { defaultChromeUserDataDir } from '../session/connect.js';
import { readDevToolsEndpoint } from '../session/launch.js';

export type DoctorStatus = 'OK' | 'WARN' | 'FAIL';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  hint: string;
}

export async function runDoctor(root = relaywrightHome()): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  checks.push(checkNode());
  checks.push(await checkChrome());
  checks.push(await checkDaemon());
  checks.push(checkProfileLock(root));
  const config = readConfig(root, checks);
  checks.push(await checkAttach(config));
  checks.push(await checkCdp(config));
  checks.push(checkHeal());
  checks.push(checkNotify(config));
  checks.push(...checkWritable(root));
  checks.push(checkAudit());
  return { ok: checks.every((check) => check.status !== 'FAIL'), checks };
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks
    .map((check) => {
      const line = `${check.status.padEnd(4, ' ')} ${check.name.padEnd(12, ' ')} ${check.detail}`;
      return check.hint ? `${line}\n     hint: ${check.hint}` : line;
    })
    .join('\n');
}

function checkNode(): DoctorCheck {
  const version = process.versions.node;
  const major = Number(version.split('.')[0]);
  if (Number.isInteger(major) && major >= 22) return item('node', 'OK', `Node ${version}`, '');
  return item('node', 'FAIL', `Node ${version} is older than 22`, 'Install Node.js 22 or newer.');
}

async function checkChrome(): Promise<DoctorCheck> {
  try {
    const resolved = await whichBrowser();
    if (!resolved.path) return item('chrome', 'FAIL', 'No Chrome, Edge, or cached Chrome for Testing', 'Run: relaywright browser install');
    return item('chrome', 'OK', `${resolved.source} ${resolved.path}`, '');
  } catch (err) {
    return item('chrome', 'FAIL', errorText(err), 'Set RELAYWRIGHT_CHROME or run: relaywright browser install');
  }
}

async function checkDaemon(): Promise<DoctorCheck> {
  const running = await findHealthyDaemon();
  if (!running) return item('daemon', 'WARN', 'Daemon is not running', 'Run: relaywright daemon start');
  const mismatch = formatBuildMismatch(readBuildFingerprint(), running.build, running.build);
  if (mismatch) return item('daemon', 'WARN', mismatch, 'Run: relaywright daemon restart');
  return item('daemon', 'OK', `Daemon is running (pid ${running.pid})`, '');
}

function checkProfileLock(root: string): DoctorCheck {
  const lock = join(root === relaywrightHome() ? defaultProfileDir() : join(root, 'profiles', 'default'), 'SingletonLock');
  if (!existsSync(lock)) return item('profile', 'OK', 'Own profile is not locked', '');
  return item('profile', 'WARN', 'Own profile is locked', "Close that Chrome before launching relaywright's own window.");
}

function readConfig(root: string, checks: DoctorCheck[]): ReturnType<typeof readGlobalConfig> | undefined {
  const path = configPath(root);
  if (!existsSync(path)) {
    checks.push(item('config', 'OK', 'No config.json yet', 'Run: relaywright init'));
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      checks.push(item('config', 'FAIL', 'config.json is not an object', 'Fix or remove the file, then run: relaywright init'));
      return undefined;
    }
    checks.push(item('config', 'OK', 'config.json parses', ''));
    return readGlobalConfig(root);
  } catch (err) {
    checks.push(item('config', 'FAIL', `config.json does not parse: ${errorText(err)}`, 'Fix or remove the file, then run: relaywright init'));
    return undefined;
  }
}

async function checkAttach(config: ReturnType<typeof readGlobalConfig> | undefined): Promise<DoctorCheck> {
  const mode = config?.browser?.mode ?? 'own';
  if (mode !== 'attach') return item('attach', 'OK', 'Browser mode is not attach', '');
  const dir = config?.browser?.user_data_dir || defaultChromeUserDataDir();
  const endpoint = readDevToolsEndpoint(dir);
  if (!endpoint) {
    return item(
      'attach',
      'FAIL',
      `DevToolsActivePort is missing in ${dir}`,
      'Open chrome://inspect/#remote-debugging and allow remote debugging for this browser.',
    );
  }
  const listening = await portListening(endpoint.port);
  if (!listening) {
    return item('attach', 'FAIL', `Port ${endpoint.port} is not listening`, 'Start that Chrome, then open chrome://inspect/#remote-debugging.');
  }
  return item('attach', 'OK', `DevToolsActivePort is present and port ${endpoint.port} is listening`, '');
}

async function checkCdp(config: ReturnType<typeof readGlobalConfig> | undefined): Promise<DoctorCheck> {
  const mode = config?.browser?.mode ?? 'own';
  if (mode !== 'cdp') return item('cdp', 'OK', 'Browser mode is not cdp', '');
  const raw = config?.browser?.cdp_url;
  if (!raw) return item('cdp', 'FAIL', 'cdp mode has no cdp_url', 'Run: relaywright init --browser cdp --cdp-url <url>');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return item('cdp', 'FAIL', 'cdp_url is not a URL', 'Run: relaywright daemon attach --cdp-url <url>');
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1) return item('cdp', 'FAIL', 'cdp_url has no port', 'Use a URL with an explicit port.');
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    return item('cdp', 'WARN', 'cdp_url is not local, so doctor did not open it', '');
  }
  const listening = await portListening(port);
  if (!listening) return item('cdp', 'FAIL', `Nothing is listening on 127.0.0.1:${port}`, 'Start the browser that owns that endpoint.');
  return item('cdp', 'OK', `127.0.0.1:${port} is accepting connections`, '');
}

function checkHeal(): DoctorCheck {
  const config = readHealConfig();
  if (healKeySet(config)) return item('heal', 'OK', `${config.api_key_env} is set`, '');
  return item('heal', 'WARN', `${config.api_key_env} is not set`, missingKeyHint(config.api_key_env));
}

function checkNotify(config: ReturnType<typeof readGlobalConfig> | undefined): DoctorCheck {
  if (process.env.RELAYWRIGHT_NOTIFY === '0' || config?.notify === false) {
    return item('notify', 'WARN', 'Notifications are off', 'Run: relaywright init --notify on');
  }
  return item('notify', 'OK', 'Notifications are enabled', '');
}

function checkWritable(root: string): DoctorCheck[] {
  return ['state', 'privacy', 'identities'].map((name) => {
    const dir = join(root, name);
    const probe = join(dir, '.doctor-write');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(probe, 'ok', 'utf8');
      rmSync(probe, { force: true });
      return item(name, 'OK', `${dir} is writable`, '');
    } catch (err) {
      return item(name, 'FAIL', `${dir} is not writable: ${errorText(err)}`, 'Fix the directory permissions.');
    }
  });
}

function checkAudit(): DoctorCheck {
  const chain = verifyAudit();
  if (chain.ok) return item('audit', 'OK', 'Audit chain verifies', '');
  return item('audit', 'FAIL', `Audit chain broke at ${chain.where}`, 'Keep the audit directory intact. Do not edit old lines.');
}

function item(name: string, status: DoctorStatus, detail: string, hint: string): DoctorCheck {
  return { name, status, detail, hint };
}

/** Ask the OS whether something is listening. This never opens a socket, so it cannot raise Chrome's remote-debugging dialog. */
function portListening(port: number): Promise<boolean> {
  const args = process.platform === 'win32' ? ['-ano', '-p', 'tcp'] : ['-an'];
  return new Promise((resolve) => {
    execFile('netstat', args, { timeout: 5_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(netstatShowsListen(stdout, port));
    });
  });
}

function netstatShowsListen(text: string, port: number): boolean {
  const marked = new RegExp(`[:.]${port}(?![0-9])`);
  for (const line of text.split(/\r?\n/)) {
    if (!/LISTENING|LISTEN/i.test(line)) continue;
    if (marked.test(line)) return true;
  }
  return false;
}
