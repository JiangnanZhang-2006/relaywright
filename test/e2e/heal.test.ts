import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryAudit } from '../../src/audit/log.js';
import { whichBrowser } from '../../src/browser/resolve.js';
import { stopDaemon } from '../../src/daemon/client.js';
import { createApp } from '../../src/daemon/server.js';
import { BrowserSession } from '../../src/session/browser.js';
import { readSkill } from '../../src/skills/store.js';
import { startStatic } from './static-server.js';

const exec = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resolved = await whichBrowser();
if (!resolved.path) console.log('Skipping heal e2e: no Chrome, Edge, or cached Chrome for Testing.');

const TOKEN = 'heal-e2e-token';

function refFor(snapshot: string, pattern: RegExp): string {
  const match = snapshot.match(pattern);
  if (!match?.[1]) throw new Error(`ref not found for ${pattern}\n${snapshot.slice(0, 800)}`);
  return match[1];
}

interface RunBody {
  exit_code: number;
  llm_tokens?: number;
  results: {
    outcome: string;
    message?: string;
    params: Record<string, string>;
    halt_matrix?: boolean;
    broken?: { step_id?: string; reason?: string; heal?: { step_id?: string; heal_token?: string; snapshot?: string; intent?: string } };
    steps?: { id: string; status: string; locator?: string }[];
    artifacts?: { path: string }[];
  }[];
}

interface PatchBody {
  accepted: boolean;
  reason?: string;
  failed_step?: string;
  cause?: string;
  outcome?: string;
  from_version?: number;
  to_version?: number;
  retryable?: boolean;
}

describe.skipIf(!resolved.path)('skill self-heal', () => {
  let home = '';
  let server: { port: number; close: () => Promise<void> } | undefined;
  let session: BrowserSession | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  let v1 = '';
  let v3 = '';
  const failure: { token: string; stepId: string; snapshot: string } = { token: '', stepId: '', snapshot: '' };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'relaywright-heal-e2e-'));
    process.env.RELAYWRIGHT_HOME = home;
    process.env.RELAYWRIGHT_HEADLESS = '1';
    process.env.RELAYWRIGHT_NOTIFY = '0';
    server = await startStatic(join(repoRoot, 'fixtures'));
    v1 = `http://127.0.0.1:${server.port}/zf-mock/v1/`;
    v3 = `http://127.0.0.1:${server.port}/zf-mock/v3/`;
    session = new BrowserSession();
    app = createApp({ token: TOKEN, session, onShutdown: () => undefined });
  });

  afterAll(async () => {
    await session?.close().catch(() => undefined);
    await stopDaemon({ closeBrowser: true }).catch(() => undefined);
    await server?.close();
    if (home) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          rmSync(home, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
    }
  });

  function live(): BrowserSession {
    if (!session || !app || !server) throw new Error('heal e2e did not start');
    return session;
  }

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    if (!app) throw new Error('heal e2e did not start');
    const response = await app.request(`http://127.0.0.1${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? (JSON.parse(text) as unknown) : {} };
  }

  async function exportBodies(): Promise<string[]> {
    const port = server?.port;
    if (!port) throw new Error('static server did not start');
    const response = await fetch(`http://127.0.0.1:${port}/zf-mock/export-bodies`);
    if (!response.ok) throw new Error(`export log ${response.status}`);
    return (await response.json()) as string[];
  }

  it('stops the matrix and returns a heal token when v3 hides the query button', async () => {
    const browser = live();
    const opened = await browser.navigate(v1);
    const year = refFor(opened.snapshot, /\[(e\d+)\] combobox "学年"/);
    const term = refFor(opened.snapshot, /\[(e\d+)\] combobox "学期"/);
    const search = refFor(opened.snapshot, /\[(e\d+)\] button "查询"/);
    await browser.act({ action: 'select', ref: year, value: '2025-2026' });
    await browser.act({ action: 'select', ref: term, value: '1' });
    const clicked = await browser.act({ action: 'click', ref: search });
    if (!clicked.step) throw new Error('click was not recorded');
    browser.saveSkill({
      name: 'zf-heal',
      description: '查询指定学年学期的个人课表',
      params: { year: '2025-2026', term: '1' },
      checks: [
        {
          after_step: clicked.step,
          any: [
            { outcome: 'empty', when: { text_present: '尚无您的课表' }, message: '{{year}} 第{{term}}学期尚未排课' },
            { outcome: 'ok', when: { table_rows_min: 1 } },
          ],
        },
      ],
    });

    const preview = await browser.navigate(v3);
    expect(preview.snapshot).toMatch(/combobox "学年"/);
    expect(preview.snapshot).toMatch(/combobox "学期"/);
    expect(preview.snapshot).toMatch(/button "检索"/);
    expect(preview.snapshot).toMatch(/输出PDF/);
    expect(preview.snapshot).not.toMatch(/button "查询"/);

    const ran = await call('POST', '/skills/zf-heal/run', {
      matrix: { year: ['2025-2026', '2026-2027'], term: ['1'] },
      startUrl: v3,
    });
    expect(ran.status).toBe(200);
    const body = ran.json as RunBody;
    expect(body.exit_code).toBe(30);
    const broken = body.results[0];
    expect(broken?.outcome).toBe('broken');
    expect(broken?.broken?.reason).toBe('target_not_found');
    expect(broken?.broken?.step_id).toContain('click');
    expect(broken?.halt_matrix).toBe(true);
    const heal = broken?.broken?.heal;
    expect(heal?.intent).toContain('查询');
    expect(heal?.heal_token).toMatch(/^[a-f0-9]{32}$/);
    expect(heal?.snapshot).toContain('检索');
    expect(heal?.snapshot).toMatch(/\[e\d+\]/);
    const skipped = body.results[1];
    expect(skipped?.outcome).toBe('skipped');
    expect(skipped?.params).toMatchObject({ year: '2026-2027', term: '1' });
    const stayed = await browser.snapshot();
    expect(stayed.url).toContain('/zf-mock/v3/');
    failure.token = heal?.heal_token ?? '';
    failure.stepId = heal?.step_id ?? broken?.broken?.step_id ?? '';
    failure.snapshot = heal?.snapshot ?? '';
  });

  it('rejects a wrong ref twice and then the budget, without changing the skill', async () => {
    expect(failure.token).not.toBe('');
    const before = readSkill('zf-heal').yaml;
    const wrong = refFor(failure.snapshot, /\[(e\d+)\][^\n]*异步提示/);
    const first = await call('POST', '/skills/zf-heal/patch', { step_id: failure.stepId, ref: wrong, heal_token: failure.token, healer: 'mcp' });
    const second = await call('POST', '/skills/zf-heal/patch', { step_id: failure.stepId, ref: wrong, heal_token: failure.token, healer: 'mcp' });
    const third = await call('POST', '/skills/zf-heal/patch', { step_id: failure.stepId, ref: wrong, heal_token: failure.token, healer: 'mcp' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(first.json as PatchBody).toMatchObject({ accepted: false, retryable: true });
    const rejected = first.json as PatchBody;
    expect(rejected.reason).toMatch(/^rerun_failed: /);
    expect(rejected.failed_step).toBeTruthy();
    expect(rejected.cause).toBeTruthy();
    expect(rejected.reason).toContain(rejected.failed_step ?? '');
    expect(rejected.reason).toContain(rejected.cause ?? '');
    expect(rejected.reason).not.toBe('heal_budget');
    expect(second.json as PatchBody).toMatchObject({ accepted: false });
    expect((second.json as PatchBody).reason).not.toBe('heal_budget');
    expect(third.json as PatchBody).toMatchObject({ accepted: false, reason: 'heal_budget' });
    expect(readSkill('zf-heal').version).toBe(1);
    expect(readSkill('zf-heal').yaml).toBe(before);
  });

  it('patches the 检索 ref, audits it, and rollback restores the old locators', async () => {
    const ran = await call('POST', '/skills/zf-heal/run', {
      matrix: { year: ['2025-2026', '2026-2027'], term: ['1'] },
      startUrl: v3,
    });
    const body = ran.json as RunBody;
    const heal = body.results[0]?.broken?.heal;
    const stepId = heal?.step_id ?? '';
    const token = heal?.heal_token ?? '';
    const ref = refFor(heal?.snapshot ?? '', /\[(e\d+)\][^\n]*检索/);
    const patched = await call('POST', '/skills/zf-heal/patch', { step_id: stepId, ref, heal_token: token, healer: 'mcp' });
    expect(patched.status).toBe(200);
    expect(patched.json as PatchBody).toMatchObject({ accepted: true, from_version: 1, to_version: 2, outcome: 'ok' });
    const yaml = readSkill('zf-heal').yaml;
    expect(yaml).toContain('检索');
    expect(yaml).toContain('btn-retrieve');
    expect(yaml).not.toContain('#search_go');

    const audit = queryAudit({ event: 'skill_patched', skill: 'zf-heal' });
    expect(audit.chain.ok).toBe(true);
    expect(audit.entries.at(-1)).toMatchObject({ healer: 'mcp', from_version: 1, to_version: 2, step_id: stepId });
    const auditText = JSON.stringify(audit.entries);
    expect(auditText).not.toContain('个人课表');
    expect(auditText).not.toContain('btn-retrieve');
    expect(auditText).not.toContain(token);

    const again = await call('POST', '/skills/zf-heal/run', {
      matrix: { year: ['2025-2026', '2026-2027'], term: ['1'] },
      startUrl: v3,
    });
    const replay = again.json as RunBody;
    expect(replay.exit_code).toBe(0);
    expect(replay.results.map((result) => result.outcome)).toEqual(['ok', 'ok']);

    const rolled = await call('POST', '/skills/zf-heal/rollback', { to: 1 });
    expect(rolled.status).toBe(200);
    const restored = readSkill('zf-heal');
    expect(restored.version).toBe(1);
    expect(restored.yaml).toContain('#search_go');
    expect(restored.yaml).toContain('查询');

    const broken = await call('POST', '/skills/zf-heal/run', { params: { year: '2025-2026', term: '1' }, startUrl: v3 });
    expect((broken.json as RunBody).exit_code).toBe(30);
    expect((broken.json as RunBody).results[0]?.broken?.reason).toBe('target_not_found');
  });

  it('does not mint a heal token when the expect matches nothing', async () => {
    const browser = live();
    browser.clearTrace();
    const opened = await browser.navigate(v1);
    const search = refFor(opened.snapshot, /\[(e\d+)\] button "查询"/);
    const clicked = await browser.act({ action: 'click', ref: search });
    if (!clicked.step) throw new Error('click was not recorded');
    browser.saveSkill({
      name: 'zf-expect',
      description: '查询后应出现一句不会出现的话',
      checks: [{ after_step: clicked.step, any: [{ outcome: 'ok', when: { text_present: '不可能出现的句子' } }] }],
    });
    const ran = await call('POST', '/skills/zf-expect/run', {});
    const body = ran.json as RunBody;
    expect(body.exit_code).toBe(30);
    expect(body.results[0]?.broken?.reason).toBe('expect_unmatched');
    expect(body.results[0]?.broken?.heal?.heal_token).toBeUndefined();
    expect(body.results[0]?.broken?.heal?.snapshot).toBeTruthy();
    expect(readSkill('zf-expect').version).toBe(1);
  });

  it('heals only the renamed query step and downloads the redesigned v3 PDF', async () => {
    const browser = live();
    browser.clearTrace();
    const opened = await browser.navigate(v1);
    const year = refFor(opened.snapshot, /\[(e\d+)\] combobox "学年"/);
    const term = refFor(opened.snapshot, /\[(e\d+)\] combobox "学期"/);
    const search = refFor(opened.snapshot, /\[(e\d+)\] button "查询"/);
    const pdf = refFor(opened.snapshot, /\[(e\d+)\] button "输出PDF"/);
    await browser.act({ action: 'select', ref: year, value: '2025-2026' });
    await browser.act({ action: 'select', ref: term, value: '1' });
    await browser.act({ action: 'click', ref: search });
    await browser.act({ action: 'click', ref: pdf });
    const revealed = await browser.snapshot({ mode: 'full' });
    const ok = refFor(revealed.snapshot, /\[(e\d+)\] button "确定"/);
    const downloaded = await browser.download({ ref: ok, save_as: '2025-2026-1.pdf', timeout_ms: 30_000 });
    if (!downloaded.downloads?.[0]) throw new Error(`确定 produced no download\n${downloaded.snapshot}`);

    browser.saveSkill({
      name: 'zf-pdf-heal',
      description: '按学年学期导出课表 PDF',
      params: { year: '2025-2026', term: '1' },
    });
    const stored = readSkill('zf-pdf-heal');
    expect(stored.skill.start_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/zf-mock\/v1\/$/);
    expect(stored.skill.steps.map((step) => step.id)).toEqual([
      's1-select-学年',
      's2-select-学期',
      's3-click-查询',
      's4-click-输出PDF',
      's5-download-确定',
    ]);
    expect(stored.yaml).toContain('{{year}}-{{term}}.pdf');
    expect(stored.yaml).toContain('#search_go');
    expect(stored.yaml).toContain('#shcPDF');
    expect(stored.yaml).toContain('#pdf-ok');
    const beforeSteps = readSkill('zf-pdf-heal').skill.steps;

    const failed = await call('POST', '/skills/zf-pdf-heal/run', {
      matrix: { year: ['2025-2026', '2026-2027'], term: ['1'] },
      startUrl: v3,
    });
    expect(failed.status).toBe(200);
    const broken = failed.json as RunBody;
    expect(broken.exit_code).toBe(30);
    expect(broken.results[0]?.broken?.step_id).toContain('查询');
    expect(broken.results[0]?.broken?.reason).toBe('target_not_found');
    expect(broken.results[0]?.broken?.heal?.heal_token).toMatch(/^[a-f0-9]{32}$/);
    expect(broken.results[1]?.outcome).toBe('skipped');

    const heal = broken.results[0]?.broken?.heal;
    const ref = refFor(heal?.snapshot ?? '', /\[(e\d+)\][^\n]*检索/);
    const patched = await call('POST', '/skills/zf-pdf-heal/patch', {
      step_id: heal?.step_id,
      ref,
      heal_token: heal?.heal_token,
      healer: 'manual',
    });
    expect(patched.status).toBe(200);
    const patch = patched.json as PatchBody;
    expect(patch).toMatchObject({ accepted: true, from_version: 1, to_version: 2, outcome: 'ok' });
    const after = readSkill('zf-pdf-heal');
    const changed = after.skill.steps.filter((step, index) => JSON.stringify(step) !== JSON.stringify(beforeSteps[index]));
    expect(changed.map((step) => step.id)).toEqual(['s3-click-查询']);
    expect(changed[0]?.click?.target.name).toBe('检索');
    expect(changed[0]?.click?.target.css).toBe('#btn-retrieve');
    expect(after.skill.steps[3]?.click?.target).toMatchObject({ name: '输出PDF', css: '#shcPDF' });
    expect(after.skill.steps[4]?.download?.click.target).toMatchObject({ name: '确定', css: '#pdf-ok' });

    const beforeExports = await exportBodies();
    const out = mkdtempSync(join(tmpdir(), 'relaywright-v3-pdf-'));
    const again = await call('POST', '/skills/zf-pdf-heal/run', {
      matrix: { year: ['2025-2026', '2026-2027'], term: ['1'] },
      startUrl: v3,
      out_dir: out,
    });
    const replay = again.json as RunBody;
    expect(replay.exit_code).toBe(0);
    expect(replay.results.map((result) => result.outcome)).toEqual(['ok', 'ok']);
    expect(replay.results.every((result) => result.broken?.heal?.heal_token === undefined)).toBe(true);
    expect(readSkill('zf-pdf-heal').version).toBe(2);
    for (const result of replay.results) {
      expect(result.steps?.find((step) => step.id.includes('输出PDF'))).toMatchObject({ status: 'done', locator: 'role_name' });
      expect(result.steps?.find((step) => step.id.includes('确定'))).toMatchObject({ status: 'done', locator: 'role_name' });
    }
    const names = replay.results.flatMap((result) => (result.artifacts ?? []).map((artifact) => basename(artifact.path)));
    expect(names).toEqual(['2025-2026-1.pdf', '2026-2027-1.pdf']);
    for (const artifact of replay.results.flatMap((result) => result.artifacts ?? [])) {
      expect(artifact.path.startsWith(out)).toBe(true);
      expect(readFileSync(artifact.path).subarray(0, 4).toString('utf8')).toBe('%PDF');
    }
    const posted = (await exportBodies()).slice(beforeExports.length);
    expect(posted.map(exportFields)).toEqual([
      { year: '2025-2026', term: '1', layout: 'portrait' },
      { year: '2026-2027', term: '1', layout: 'portrait' },
    ]);
  });

  it('heals from the CLI mock model and stays broken when the key is missing', async () => {
    await session?.close();
    session = undefined;
    const port = server?.port;
    if (!port) throw new Error('static server did not start');
    const base = `http://127.0.0.1:${port}/mock-llm/v1`;
    const configured = await cli(['heal', 'config', '--base-url', base, '--model', 'mock-heal', '--api-key-env', 'RELAYWRIGHT_HEAL_TEST_KEY', '--json'], {
      RELAYWRIGHT_HEAL_TEST_KEY: 'local-test-key',
    });
    expect(configured.code, configured.stderr).toBe(0);
    const config = JSON.parse(configured.stdout) as { base_url: string; model: string; api_key: string };
    expect(config).toMatchObject({ base_url: base, model: 'mock-heal', api_key_env: 'RELAYWRIGHT_HEAL_TEST_KEY', api_key: 'set' });
    expect(readFileSync(join(home, 'config.json'), 'utf8')).not.toContain('local-test-key');

    const first = await cli(
      ['skill', 'run', 'zf-heal', '--start-url', v3, '--param', 'year=2025-2026', '--param', 'term=1', '--json'],
      { RELAYWRIGHT_HEAL_TEST_KEY: 'local-test-key' },
    );
    expect(first.code, first.stderr.slice(0, 500)).toBe(0);
    const healed = JSON.parse(first.stdout) as {
      llm_tokens?: number;
      llm_steps?: { step_id: string; prompt: number; completion: number }[];
      exit_code: number;
    };
    expect(healed.exit_code).toBe(0);
    expect(healed.llm_tokens).toBe(18);
    expect(healed.llm_steps).toEqual([{ step_id: expect.stringContaining('click'), prompt: 11, completion: 7 }]);

    const second = await cli(
      ['skill', 'run', 'zf-heal', '--start-url', v3, '--param', 'year=2025-2026', '--param', 'term=1', '--json'],
      { RELAYWRIGHT_HEAL_TEST_KEY: 'local-test-key' },
    );
    expect(second.code, second.stderr).toBe(0);
    expect((JSON.parse(second.stdout) as { llm_tokens?: number }).llm_tokens).toBe(0);

    const rolled = await cli(['skill', 'rollback', 'zf-heal', '--to', '1', '--json'], { RELAYWRIGHT_HEAL_TEST_KEY: 'local-test-key' });
    expect(rolled.code, rolled.stderr).toBe(0);
    expect(readSkill('zf-heal').yaml).toContain('#search_go');

    const missing = await cli(['skill', 'run', 'zf-heal', '--start-url', v3, '--param', 'year=2025-2026', '--param', 'term=1', '--json'], {});
    expect(missing.code).toBe(30);
    expect(missing.stderr).toContain('No RELAYWRIGHT_HEAL_TEST_KEY set');
    expect(missing.stderr).toContain('relaywright heal config');
    const broken = JSON.parse(missing.stdout) as RunBody;
    expect(broken.llm_tokens).toBe(0);
    expect(broken.results[0]?.broken?.heal?.heal_token).toMatch(/^[a-f0-9]{32}$/);
  }, 240_000);
});

function exportFields(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

async function cli(args: string[], extra: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
  const tsx = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RELAYWRIGHT_HOME: process.env.RELAYWRIGHT_HOME,
    RELAYWRIGHT_HEADLESS: '1',
    RELAYWRIGHT_NOTIFY: '0',
  };
  delete env.DEEPSEEK_API_KEY;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  try {
    const result = await exec(process.execPath, [tsx, join(repoRoot, 'src', 'cli', 'index.ts'), ...args], {
      cwd: repoRoot,
      env,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const error = err as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}
