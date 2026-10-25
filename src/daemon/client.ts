import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { daemonJsonPath, daemonLockPath, daemonLogPath, ensureHomeLayout, errorText, logDaemon, relaywrightHome } from '../config/paths.js';
import { explainDaemonError, formatBuildMismatch, readBuildFingerprint } from './build.js';
import { PageSchema, PdfResultSchema, StatusSchema, TabsCommandSchema, TabsListSchema, WaitResultSchema, type DaemonStatus, type PageBody, type PdfInput, type PdfResult, type TabsCommand, type TabsList, type WaitBody } from '../protocol.js';
import {
  MatrixResultSchema,
  SaveResultSchema,
  SkillDocumentSchema,
  SkillHistorySchema,
  SkillListSchema,
  type MatrixResult,
  type RunSkillInput,
  type SaveSkillInput,
  type SaveSkillResult,
  type SkillDocument,
  type SkillHistory,
  type SkillSummary,
} from '../skills/schema.js';
import { TraceViewSchema, type TraceView } from '../recorder/types.js';

const START_TIMEOUT_MS = 20_000;
const POLL_MS = 200;

const DaemonInfoSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
  startedAt: z.string().min(1),
  version: z.string().min(1),
  build: z
    .object({
      entry: z.string().min(1),
      builtAt: z.string().min(1),
    })
    .optional(),
});

export type DaemonInfo = z.infer<typeof DaemonInfoSchema>;
export type { DaemonStatus };
export type PageView = PageBody;

const HealthSchema = z.object({
  ok: z.literal(true),
  pid: z.number(),
  build: z
    .object({
      entry: z.string().min(1),
      builtAt: z.string().min(1),
    })
    .optional(),
  browser: z
    .object({
      state: z.enum(['idle', 'resolving', 'downloading', 'launching', 'ready', 'error']),
      percent: z.number().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

const BROWSER_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const BROWSER_START_TIMEOUT_MS = 60_000;

export class DaemonStartError extends Error {
  constructor(message: string) {
    const tail = tailLog();
    const detail = tail ? `${message}\n${tail}` : message;
    super(`${detail}\nLog: ${daemonLogPath()}`);
    this.name = 'DaemonStartError';
  }
}

let cached: DaemonInfo | null = null;
let mismatchLine: string | null = null;

export function daemonMismatchLine(): string | null {
  return mismatchLine;
}

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
  if (cached && (await fetchHealth(cached))) {
    await noteFingerprint(cached);
    return cached;
  }
  cached = null;
  const info = readDaemonInfo();
  if (!info || !isPidAlive(info.pid)) return null;
  if (!(await fetchHealth(info))) return null;
  cached = info;
  await noteFingerprint(info);
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
    await noteFingerprint(ready);
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
      timeoutMs: 70_000,
    }),
  );
}

export async function getSnapshot(options?: { mode?: 'full' | 'diff'; maxRows?: number }): Promise<PageView> {
  const info = await ensureDaemon();
  const params = new URLSearchParams();
  if (options?.mode) params.set('mode', options.mode);
  if (options?.maxRows !== undefined) params.set('maxRows', String(options.maxRows));
  const query = params.size > 0 ? `?${params.toString()}` : '';
  return PageSchema.parse(await authorized(info, `/snapshot${query}`, { timeoutMs: 45_000 }));
}

export async function act(input: { action: string; ref?: string; value?: string; key?: string }): Promise<PageView> {
  const info = await ensureDaemon();
  return PageSchema.parse(
    await authorized(info, '/act', {
      method: 'POST',
      body: input,
      timeoutMs: 180_000,
    }),
  );
}

export async function download(input: { ref: string; save_as?: string; timeout_ms?: number }): Promise<PageView> {
  const info = await ensureDaemon();
  const begin = input.timeout_ms ?? 30_000;
  return PageSchema.parse(
    await authorized(info, '/download', {
      method: 'POST',
      body: input,
      timeoutMs: begin + 150_000,
    }),
  );
}

export async function printPdf(input: PdfInput): Promise<PdfResult> {
  const info = await ensureDaemon();
  return PdfResultSchema.parse(
    await authorized(info, '/pdf', {
      method: 'POST',
      body: input,
      timeoutMs: 90_000,
    }),
  );
}

export async function waitFor(input: { text?: string; ref?: string; url?: string; timeoutMs?: number }): Promise<WaitBody> {
  const info = await ensureDaemon();
  const timeoutMs = input.timeoutMs ?? 10_000;
  return WaitResultSchema.parse(
    await authorized(info, '/wait', {
      method: 'POST',
      body: input,
      timeoutMs: Math.min(90_000, timeoutMs + 20_000),
    }),
  );
}

export async function browserTabs(input: TabsCommand): Promise<TabsList | PageBody> {
  const parsed = TabsCommandSchema.parse(input);
  const info = await ensureDaemon();
  if (parsed.action === 'list') return TabsListSchema.parse(await authorized(info, '/tabs'));
  const data = await authorized(info, '/tabs', { method: 'POST', body: parsed, timeoutMs: 70_000 });
  if (parsed.action === 'close') return TabsListSchema.parse(data);
  return PageSchema.parse(data);
}

const SKILL_RUN_TIMEOUT_MS = 10 * 60_000;

export async function getTrace(): Promise<TraceView> {
  const info = await ensureDaemon();
  return TraceViewSchema.parse(await authorized(info, '/trace'));
}

export async function clearTrace(): Promise<TraceView> {
  const info = await ensureDaemon();
  return TraceViewSchema.parse(await authorized(info, '/trace/clear', { method: 'POST', body: {} }));
}

export async function saveSkill(input: SaveSkillInput): Promise<SaveSkillResult> {
  const info = await ensureDaemon();
  return SaveResultSchema.parse(await authorized(info, '/skills/save', { method: 'POST', body: input, timeoutMs: 30_000 }));
}

export async function listSkills(): Promise<SkillSummary[]> {
  const info = await ensureDaemon();
  return SkillListSchema.parse(await authorized(info, '/skills')).skills;
}

export async function showSkill(name: string, version?: number): Promise<SkillDocument> {
  const info = await ensureDaemon();
  const query = version === undefined ? '' : `?version=${version}`;
  return SkillDocumentSchema.parse(await authorized(info, `/skills/${encodeURIComponent(name)}${query}`));
}

export async function skillHistory(name: string): Promise<SkillHistory> {
  const info = await ensureDaemon();
  return SkillHistorySchema.parse(await authorized(info, `/skills/${encodeURIComponent(name)}/history`));
}

export async function rollbackSkill(name: string, to: number): Promise<SkillDocument> {
  const info = await ensureDaemon();
  return SkillDocumentSchema.parse(
    await authorized(info, `/skills/${encodeURIComponent(name)}/rollback`, { method: 'POST', body: { to } }),
  );
}

export async function runSkill(name: string, input: RunSkillInput): Promise<MatrixResult> {
  const info = await ensureDaemon();
  return MatrixResultSchema.parse(
    await authorized(info, `/skills/${encodeURIComponent(name)}/run`, {
      method: 'POST',
      body: input,
      timeoutMs: SKILL_RUN_TIMEOUT_MS,
    }),
  );
}

export async function waitForBrowserReady(info: DaemonInfo): Promise<void> {
  const started = Date.now();
  let sawDownload = false;
  let lastPercent = -1;
  for (;;) {
    const health = await fetchHealthBody(info);
    const state = health?.browser?.state ?? 'idle';
    if (state === 'downloading') {
      sawDownload = true;
      const percent = health?.browser?.percent ?? 0;
      if (percent !== lastPercent) {
        process.stderr.write(`downloading Chrome for Testing ${percent}%\n`);
        lastPercent = percent;
      }
    }
    if (state === 'ready') return;
    if (state === 'error') throw new Error(health?.browser?.message || 'Browser failed to start');
    const limit = sawDownload ? BROWSER_DOWNLOAD_TIMEOUT_MS : BROWSER_START_TIMEOUT_MS;
    if (Date.now() - started > limit) {
      throw new Error(`Browser was not ready within ${Math.round(limit / 1000)}s (state ${state}).`);
    }
    await delay(200);
  }
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

export async function restartDaemon(): Promise<DaemonInfo> {
  await stopDaemon();
  mismatchLine = null;
  cached = null;
  return ensureDaemon();
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
    const message = errorMessage(data) ?? `Daemon request failed (${response.status})`;
    throw new Error(explainDaemonError(message, response.status, errorCode(data), mismatchLine));
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
  const error = (data as { error?: { code?: unknown; message?: unknown } }).error;
  if (!error || typeof error.message !== 'string') return null;
  if (typeof error.code === 'string' && error.code.length > 0) return `${error.code}: ${error.message}`;
  return error.message;
}

function errorCode(data: unknown): string | null {
  if (!data || typeof data !== 'object' || !('error' in data)) return null;
  const code = (data as { error?: { code?: unknown } }).error?.code;
  return typeof code === 'string' ? code : null;
}

async function noteFingerprint(info: DaemonInfo): Promise<void> {
  const health = await fetchHealthBody(info);
  const stored = readDaemonInfo()?.build ?? info.build;
  mismatchLine = formatBuildMismatch(readBuildFingerprint(), health?.build, stored);
}

async function fetchHealthBody(info: DaemonInfo): Promise<z.infer<typeof HealthSchema> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return null;
    const parsed = HealthSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.pid !== info.pid) return null;
    return parsed.data;
  } catch {
    return null;
  }
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
