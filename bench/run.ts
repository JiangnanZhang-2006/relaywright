import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runConversation, type ConversationResult } from './agent.js';
import { childEnv } from './env.js';
import { liveModel } from './model.js';
import { pageUrl, SYSTEM_PROMPT, userPrompt } from './prompt.js';
import { publicError } from './redact.js';
import { aggregate, runLabel, writeReport, type ReportEnvironment } from './report.js';
import { scoreRun } from './score.js';
import { startBenchServer } from './server.js';
import type { BenchRun, BenchTool, Model, RunKind } from './types.js';

const PLAYWRIGHT_MCP_VERSION = '0.0.83';
const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');

interface Plan {
  kind: RunKind;
  repeatIndex: number;
  version: 'v1' | 'v3';
}

interface ToolHarness {
  tool: BenchTool;
  command: string;
  args: (runDir: string) => string[];
  env: Record<string, string>;
  close: () => void;
  downloads: () => Array<{ path: string; bytes: number }>;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tools: { type: 'string', default: 'relaywright,playwright' },
      repeats: { type: 'string', default: '5' },
      kinds: { type: 'string', default: 'first,repeat,redesign' },
      out: { type: 'string', default: 'bench/results' },
      'base-url': { type: 'string', default: process.env.BENCH_BASE_URL ?? 'https://api.deepseek.com' },
      model: { type: 'string', default: process.env.BENCH_MODEL ?? 'deepseek-chat' },
      'api-key-env': { type: 'string', default: 'DEEPSEEK_API_KEY' },
    },
  });
  const tools = (values.tools ?? '').split(',').map((item) => item.trim()).filter(Boolean) as BenchTool[];
  for (const tool of tools) {
    if (tool !== 'relaywright' && tool !== 'playwright') throw new Error(`unknown tool ${tool}`);
  }
  const kinds = new Set((values.kinds ?? '').split(',').map((item) => item.trim()));
  const repeats = Number.parseInt(values.repeats ?? '5', 10);
  const apiKeyEnv = values['api-key-env'] ?? 'DEEPSEEK_API_KEY';
  const apiKey = process.env[apiKeyEnv]?.trim() ?? '';
  if (!apiKey) throw new Error(`Set ${apiKeyEnv} to run the benchmark.`);
  if (!existsSync(CLI)) throw new Error('Run npm run build first.');
  const model: Model = liveModel({ baseUrl: (values['base-url'] ?? '').replace(/\/+$/, ''), model: values.model ?? 'deepseek-chat', apiKey });

  const plans: Plan[] = [];
  if (kinds.has('first')) plans.push({ kind: 'first', repeatIndex: 0, version: 'v1' });
  if (kinds.has('repeat')) for (let index = 1; index <= repeats; index += 1) plans.push({ kind: 'repeat', repeatIndex: index, version: 'v1' });
  if (kinds.has('redesign')) plans.push({ kind: 'redesign', repeatIndex: 0, version: 'v3' });

  const server = await startBenchServer(join(ROOT, 'fixtures'));
  const runs: BenchRun[] = [];
  const downloads: Array<{ path: string; bytes: number }> = [];
  let environment: ReportEnvironment | undefined;
  let harnessError: string | undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(ROOT, values.out ?? 'bench/results', stamp);
  try {
    const browser = resolveBrowser();
    environment = {
      node: process.version,
      os: `${os.type()} ${os.release()}`,
      chromePath: browser.path,
      chromeVersion: browser.version,
      model: values.model ?? 'deepseek-chat',
      baseUrl: values['base-url'] ?? '',
      apiKeyEnv,
      commit: git(['rev-parse', '--short', 'HEAD']),
      playwrightMcp: tools.includes('playwright') ? PLAYWRIGHT_MCP_VERSION : 'not run',
    };
    for (const tool of tools) {
      const harness = tool === 'relaywright' ? startRelaywright() : startPlaywright(browser.path);
      try {
        for (const plan of plans) {
          const run = await runOnce(harness, plan, server, model, apiKey);
          runs.push(run);
          const total = runs.reduce((sum, item) => sum + item.promptTokens + item.completionTokens, 0);
          process.stdout.write(
            `${tool.padEnd(11)} ${runLabel(plan.kind, plan.repeatIndex).padEnd(9)} ${run.success ? 'ok  ' : 'FAIL'} ${run.outcome.padEnd(5)} calls=${run.modelCalls} tools=${run.toolCalls} tokens=${run.promptTokens + run.completionTokens} ${(run.wallMs / 1000).toFixed(1)}s  (all runs: ${total})${run.error ? `  error: ${run.error.split('\n')[0]}` : ''}\n`,
          );
        }
        downloads.push(...harness.downloads());
      } finally {
        harness.close();
      }
    }
  } catch (err) {
    harnessError = publicError(err, apiKey);
    process.stderr.write(`harness error: ${harnessError}\n`);
  } finally {
    await server.close();
  }
  writeReport(outDir, {
    generatedAt: new Date().toISOString(),
    dry: false,
    environment: environment ?? emptyEnvironment(apiKeyEnv),
    runs,
    downloads,
    ...(harnessError ? { error: harnessError } : {}),
  });
  for (const row of aggregate(runs)) {
    process.stdout.write(
      `${row.tool}: first=${row.firstTokens ?? 'n/a'} median_repeat=${row.medianRepeatTokens ?? 'n/a'} redesign=${row.redesignTokens ?? 'n/a'} total=${row.totalTokens} success=${Math.round(row.successRate * row.runs)}/${row.runs}\n`,
    );
  }
  process.stdout.write(`report: ${outDir}\n`);
  if (harnessError) process.exitCode = 1;
}

async function runOnce(
  harness: ToolHarness,
  plan: Plan,
  server: Awaited<ReturnType<typeof startBenchServer>>,
  model: Model,
  apiKey: string,
): Promise<BenchRun> {
  server.reset();
  const url = pageUrl(server.port, plan.version);
  const runDir = mkdtempSync(join(os.tmpdir(), 'rw-bench-run-'));
  let result: ConversationResult;
  try {
    result = await runConversation({
      command: harness.command,
      args: harness.args(runDir),
      env: harness.env,
      cwd: runDir,
      model,
      system: SYSTEM_PROMPT,
      user: userPrompt(url),
      secret: apiKey,
    });
  } catch (err) {
    result = {
      outcome: 'error',
      error: publicError(err, apiKey),
      answer: '',
      modelCalls: [],
      toolCalls: [],
      promptTokens: 0,
      completionTokens: 0,
      cacheHitTokens: 0,
      wallMs: 0,
      tools: [],
    };
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
  // Let a target=_blank export that the last tool call started reach the server.
  await new Promise((done) => setTimeout(done, 1500));
  const exports = server.exports();
  const score = scoreRun(exports, result.answer);
  return {
    tool: harness.tool,
    kind: plan.kind,
    repeatIndex: plan.repeatIndex,
    url,
    success: result.outcome === 'done' && score.success,
    outcome: result.outcome,
    answer: result.answer,
    modelCalls: result.modelCalls.length,
    toolCalls: result.toolCalls.length,
    calls: { model: result.modelCalls, tools: result.toolCalls },
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    cacheHitTokens: result.cacheHitTokens,
    wallMs: result.wallMs,
    exports,
    direct: server.direct(),
    duplicates: score.duplicates,
    extra: score.extra,
    missing: score.missing,
    emptyReported: score.emptyReported,
    emptyExported: score.emptyExported,
    tools: result.tools,
    ...(result.error ? { error: result.error } : {}),
  };
}

/** Skills and the daemon persist across runs; each run is a new MCP client and conversation. */
function startRelaywright(): ToolHarness {
  const home = mkdtempSync(join(os.tmpdir(), 'rw-bench-home-'));
  const env = childEnv(home, process.env, 'DEEPSEEK_API_KEY');
  cli(['daemon', 'start'], env);
  return {
    tool: 'relaywright',
    command: process.execPath,
    args: () => [CLI, 'mcp'],
    env,
    downloads: () => listFiles(join(home, 'downloads')),
    close: () => {
      try {
        cli(['daemon', 'stop', '--close-browser'], env);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

/** A fresh isolated browser per run, which is how Playwright MCP is normally used. */
function startPlaywright(chromePath: string): ToolHarness {
  const prefix = join(os.tmpdir(), 'rw-bench-pw');
  const entry = join(prefix, 'node_modules', '@playwright', 'mcp', 'cli.js');
  if (!existsSync(entry) || installedVersion(prefix) !== PLAYWRIGHT_MCP_VERSION) {
    const npm = join(process.execPath, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    execFileSync(process.execPath, [npm, 'install', '--prefix', prefix, '--no-save', '--no-audit', '--no-fund', `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`], {
      stdio: 'ignore',
    });
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'DEEPSEEK_API_KEY' && value !== undefined) env[key] = value;
  }
  return {
    tool: 'playwright',
    command: process.execPath,
    args: (runDir) => [entry, '--headless', '--isolated', '--image-responses', 'omit', '--executable-path', chromePath, '--output-dir', runDir],
    env,
    downloads: () => [],
    close: () => undefined,
  };
}

function installedVersion(prefix: string): string {
  try {
    const raw = execFileSync(process.execPath, ['-p', `require(${JSON.stringify(join(prefix, 'node_modules', '@playwright', 'mcp', 'package.json'))}).version`], {
      encoding: 'utf8',
    });
    return raw.trim();
  } catch {
    return '';
  }
}

function resolveBrowser(): { path: string; version: string } {
  const home = mkdtempSync(join(os.tmpdir(), 'rw-bench-which-'));
  try {
    const env = childEnv(home, process.env, 'DEEPSEEK_API_KEY');
    const which = JSON.parse(cli(['browser', 'which', '--json'], env)) as { path?: string };
    if (!which.path) throw new Error('relaywright browser which returned no path');
    return { path: which.path, version: chromeVersion(which.path) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function chromeVersion(path: string): string {
  if (process.platform === 'win32') {
    const out = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-Item -LiteralPath $env:RW_CHROME).VersionInfo.ProductVersion'], {
      encoding: 'utf8',
      env: { ...process.env, RW_CHROME: path },
    });
    return out.stdout.trim() || 'unknown';
  }
  const out = spawnSync(path, ['--version'], { encoding: 'utf8' });
  return out.stdout.trim() || 'unknown';
}

function cli(args: string[], env: Record<string, string>): string {
  return execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function listFiles(dir: string): Array<{ path: string; bytes: number }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ path: string; bytes: number }> = [];
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isFile()) out.push({ path: name, bytes: info.size });
  }
  return out;
}

function emptyEnvironment(apiKeyEnv: string): ReportEnvironment {
  return { node: process.version, os: `${os.type()} ${os.release()}`, chromePath: '', chromeVersion: '', model: '', baseUrl: '', apiKeyEnv, commit: '', playwrightMcp: '' };
}

main().catch((err: unknown) => {
  process.stderr.write(`${publicError(err)}\n`);
  process.exitCode = 1;
});
