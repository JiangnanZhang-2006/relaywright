import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function relaywrightHome(): string {
  const override = process.env.RELAYWRIGHT_HOME?.trim();
  if (override) return override;
  return join(homedir(), '.relaywright');
}

export function daemonJsonPath(): string {
  return join(relaywrightHome(), 'daemon.json');
}

export function daemonLockPath(): string {
  return join(relaywrightHome(), 'daemon.lock');
}

export function logsDir(): string {
  return join(relaywrightHome(), 'logs');
}

export function daemonLogPath(): string {
  return join(logsDir(), 'daemon.log');
}

export function profilesDir(): string {
  return join(relaywrightHome(), 'profiles');
}

export function defaultProfileDir(): string {
  return join(profilesDir(), 'default');
}

export function browsersDir(): string {
  return join(relaywrightHome(), 'browsers');
}

export function tracesDir(): string {
  return join(relaywrightHome(), 'traces');
}

export function skillsDir(): string {
  return join(relaywrightHome(), 'skills');
}

export function downloadsDir(): string {
  return join(relaywrightHome(), 'downloads');
}

export function downloadsStagingDir(): string {
  return join(downloadsDir(), '.staging');
}

export function identitiesDir(): string {
  return join(relaywrightHome(), 'identities');
}

export function identityPath(name: string): string {
  return join(identitiesDir(), `${name}.json`);
}

export function auditDir(): string {
  return join(relaywrightHome(), 'audit');
}

export function configPath(root = relaywrightHome()): string {
  return join(root, 'config.json');
}

export function privacyDir(root = relaywrightHome()): string {
  return join(root, 'privacy');
}

export function privacyPath(identity: string, root = relaywrightHome()): string {
  return join(privacyDir(root), `${identity}.json`);
}

export function ensureHomeLayout(): void {
  mkdirSync(logsDir(), { recursive: true });
  mkdirSync(defaultProfileDir(), { recursive: true });
  mkdirSync(browsersDir(), { recursive: true });
  mkdirSync(tracesDir(), { recursive: true });
  mkdirSync(skillsDir(), { recursive: true });
  mkdirSync(downloadsStagingDir(), { recursive: true });
  mkdirSync(identitiesDir(), { recursive: true });
  mkdirSync(auditDir(), { recursive: true });
  mkdirSync(privacyDir(), { recursive: true });
}

let cachedVersion: string | undefined;

export function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
  cachedVersion = pkg.version ?? '0.0.0';
  return cachedVersion;
}

/** Files edited by hand on Windows (Notepad, PowerShell 5 `-Encoding utf8`) often start with a BOM. */
export function readTextFile(path: string): string {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Append-only daemon log. Must never throw into a request path or the MCP stdio stream. */
export function logDaemon(message: string): void {
  try {
    mkdirSync(logsDir(), { recursive: true });
    appendFileSync(daemonLogPath(), `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // A full disk should not take down the daemon or corrupt MCP stdout.
  }
}
