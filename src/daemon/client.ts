import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { daemonJsonPath, daemonLockPath, daemonLogPath, ensureHomeLayout, errorText, logDaemon, relaywrightHome } from '../config/paths.js';

const START_TIMEOUT_MS = 20_000;
const POLL_MS = 200;

const DaemonInfoSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
  startedAt: z.string().min(1),
  version: z.string().min(1),
});

export type DaemonInfo = z.infer<typeof DaemonInfoSchema>;

const StatusSchema = z.object({
  pid: z.number(),
  uptime: z.number(),
  browser: z.object({
    executablePath: z.string(),
    version: z.string(),
  }),
  page: z.object({
    url: z.string(),
    title: z.string(),
  }),
});

export type DaemonStatus = z.infer<typeof StatusSchema>;

const PageSchema = z.object({
  url: z.string(),
  title: z.string(),
  snapshot: z.string(),
});

export type PageView = z.infer<typeof PageSchema>;

export class DaemonStartError extends Error {
  constructor(message: string) {
    const tail = tailLog();
    const detail = tail ? `${message}\n${tail}` : message;
    super(`${detail}\nLog: ${daemonLogPath()}`);
    this.name = 'DaemonStartError';
  }
}

let cached: DaemonInfo | null = null;

/** This module is imported by the MCP server. It must not write to stdout. */
function diag(message: string): void {
  process.stderr.write(`relaywright: ${message}\n`);
  logDaemon(message);
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    const parsed = DaemonInfoSchema.safeParse(JSON.parse(readFileSync(daemonJsonPath(), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeDaemonInfo(info: DaemonInfo): Promise<void> {
  const path = daemonJsonPath();
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  try {
    await rename(tmp, path);
  } catch (err) {
    // Windows rename cannot replace an existing file.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EEXIST') throw err;
    await rm(path, { force: true });
    await rename(tmp, path);
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLockPid(): number | null {
  try {
    const pid = Number(readFileSync(daemonLockPath(), 'utf8').split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function acquireDaemonLock(): boolean {
  const path = daemonLockPath();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readLockPid();
      if (holder && holder !== process.pid && isPidAlive(holder)) return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}

export function releaseDaemonLock(): void {
  const holder = readLockPid();
  if (holder !== null && holder !== process.pid) return;
  try {
    rmSync(daemonLockPath(), { force: true });
  } catch {
    // already gone
  }
}

export async function fetchHealth(info: DaemonInfo, timeoutMs = 1_000): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: unknown; pid?: unknown; token?: unknown };
    if ('token' in body) return false;
    return body.ok === true && body.pid === info.pid;
  } catch {
    return false;
  }
}

export async function findHealthyDaemon(): Promise<DaemonInfo | null> {
  if (cached && (await fetchHealth(cached))) return cached;
  cached = null;
  const info = readDaemonInfo();
  if (!info || !isPidAlive(info.pid)) return null;
  if (!(await fetchHealth(info))) return null;
  cached = info;
  return info;
}

export async function ensureDaemon(): Promise<DaemonInfo> {
  const existing = await findHealthyDaemon();
  if (existing) return existing;

  const lockPid = readLockPid();
  if (lockPid && isPidAlive(lockPid)) {
    diag(`waiting for daemon pid ${lockPid}`);
    const waited = await waitForHealthy(START_TIMEOUT_MS);
    if (waited) return waited;
    throw new DaemonStartError(`Daemon pid ${lockPid} did not become healthy within ${START_TIMEOUT_MS}ms.`);
  }

  ensureHomeLayout();
  const spec = daemonLaunchSpec();
  diag(`starting daemon: ${spec.command} ${spec.args.join(' ')}`);
  const child = spawnDaemon(spec);
  const ready = await waitForHealthy(START_TIMEOUT_MS, child);
  if (ready) {
    diag(`daemon ready pid=${ready.pid} port=${ready.port}`);
    return ready;
  }
  throw new DaemonStartError(`Daemon did not become healthy within ${START_TIMEOUT_MS}ms.`);
}

export async function readStatus(info: DaemonInfo): Promise<DaemonStatus> {
  return StatusSchema.parse(await authorized(info, '/status'));
}

export async function getStatus(): Promise<DaemonStatus> {
  return readStatus(await ensureDaemon());
}

export async function navigate(url: string): Promise<PageView> {
  const parsed = parseHttpUrl(url);
  const info = await ensureDaemon();
  return PageSchema.parse(
    await authorized(info, '/navigate', {
      method: 'POST',
      body: { url: parsed },
      timeoutMs: 45_000,
    }),
  );
}

export async function getSnapshot(): Promise<PageView> {
  const info = await ensureDaemon();
  return PageSchema.parse(await authorized(info, '/snapshot'));
}

export async function stopDaemon(): Promise<'stopped' | 'not_running'> {
  cached = null;
  const info = readDaemonInfo();
  if (!info || !isPidAlive(info.pid)) {
    if (info) rmSync(daemonJsonPath(), { force: true });
    return 'not_running';
  }

  const response = await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${info.token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Shutdown failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(info.pid)) {
      rmSync(daemonJsonPath(), { force: true });
      return 'stopped';
    }
    await delay(100);
  }
  throw new Error(`Daemon pid ${info.pid} did not exit after shutdown.\nLog: ${daemonLogPath()}`);
}

export function createDaemonToken(): string {
  return randomBytes(32).toString('hex');
}

export function parseHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}\nExample: relaywright open https://example.com`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `Only http and https URLs are supported, got ${url.protocol}\nExample: relaywright open https://example.com`,
    );
  }
  return url.toString();
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

async function authorized(info: DaemonInfo, path: string, options: RequestOptions = {}, allowRefresh = true): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${info.token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const text = await response.text();
  const data = text ? parseJson(text) : null;
  if (response.status === 401 && allowRefresh) {
    cached = null;
    const fresh = readDaemonInfo();
    if (fresh && fresh.token !== info.token && isPidAlive(fresh.pid)) {
      return authorized(fresh, path, options, false);
    }
  }
  if (!response.ok) {
    throw new Error(errorMessage(data) ?? `Daemon request failed (${response.status})`);
  }
  return data;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Daemon returned non-JSON: ${text.slice(0, 200)}`);
  }
}

function errorMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object' || !('error' in data)) return null;
  const error = (data as { error?: { message?: unknown } }).error;
  return typeof error?.message === 'string' ? error.message : null;
}

interface LaunchSpec {
  command: string;
  args: string[];
}

function daemonLaunchSpec(): LaunchSpec {
  const selfPath = fileURLToPath(import.meta.url);
  const entry = join(dirname(selfPath), selfPath.endsWith('.ts') ? 'main.ts' : 'main.js');
  if (!existsSync(entry)) {
    throw new DaemonStartError(`Daemon entry not found: ${entry}\nRun: npm run build`);
  }
  if (entry.endsWith('.ts')) {
    const tsxCli = join(dirname(selfPath), '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (!existsSync(tsxCli)) {
      throw new DaemonStartError(`tsx was not found at ${tsxCli}. Run npm run build and start dist/cli/index.js.`);
    }
    return { command: process.execPath, args: [tsxCli, entry] };
  }
  return { command: process.execPath, args: [entry] };
}

function spawnDaemon(spec: LaunchSpec): ChildProcess {
  const logFd = openSync(daemonLogPath(), 'a');
  try {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      windowsHide: true,
      cwd: relaywrightHome(),
      env: process.env,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
}

async function waitForHealthy(timeoutMs: number, child?: ChildProcess): Promise<DaemonInfo | null> {
  const deadline = Date.now() + timeoutMs;
  const observed: {
    spawnError: Error | null;
    exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  } = { spawnError: null, exit: null };
  const onError = (err: Error): void => {
    observed.spawnError = err;
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    observed.exit = { code, signal };
  };
  child?.on('error', onError);
  child?.on('exit', onExit);

  try {
    while (Date.now() < deadline) {
      if (observed.spawnError) {
        throw new DaemonStartError(`Failed to spawn daemon: ${errorText(observed.spawnError)}`);
      }
      const info = readDaemonInfo();
      if (info && isPidAlive(info.pid) && (await fetchHealth(info))) {
        cached = info;
        return info;
      }
      const exitState = observed.exit;
      if (exitState) {
        if (exitState.code === 0) {
          const winner = readDaemonInfo();
          if (winner && isPidAlive(winner.pid) && (await fetchHealth(winner))) {
            cached = winner;
            return winner;
          }
        }
        throw new DaemonStartError(
          `Daemon exited before it was healthy (code ${exitState.code ?? 'null'}, signal ${exitState.signal ?? 'none'}).`,
        );
      }
      await delay(POLL_MS);
    }
    return null;
  } finally {
    child?.off('error', onError);
    child?.off('exit', onExit);
  }
}

function tailLog(maxLines = 20): string {
  try {
    const lines = readFileSync(daemonLogPath(), 'utf8').trim().split(/\r?\n/);
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
