import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { flushAudit, queryAudit, recordAudit } from '../src/audit/log.js';
import { formatHealConfig, missingKeyHint, readHealConfig, writeHealConfig } from '../src/healer/config.js';
import { completeHeal, parseHealContent } from '../src/healer/complete.js';
import { maskTail } from '../src/privacy/detect.js';
import { loginAccountWatchSource, readBindingPayload } from '../src/privacy/login-account.js';
import { PrivacyStore } from '../src/privacy/store.js';
import { formatPatchResult, formatRunReport } from '../src/skills/format.js';
import { buildHealContext, HEAL_TOKEN_MS, HealLedger, rerunFailedReason } from '../src/skills/heal.js';
import { mergeResumedRun, runMatrix, stopsMatrix, summaryExitCode } from '../src/skills/run.js';
import type { HealContext, Skill, SkillRunResult, SkillStep } from '../src/skills/schema.js';
import type { ModelItem } from '../src/perception/snapshot.js';
import type { PageBody, WaitInput } from '../src/protocol.js';
import type { ReplayPage, SavedDownload } from '../src/session/page.js';
import { startStatic } from './e2e/static-server.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const clickStep: SkillStep = {
  id: 'go',
  intent: '点击查询',
  click: { target: { role: 'button', name: '查询', css: '#search_go', text: '查询' } },
};

class FakePage implements ReplayPage {
  navigations = 0;
  url = 'http://fixture.test/table';
  text = '';
  includeButton = false;
  readonly snapshot = '[e1] combobox "学年"\n[e4] button "检索"';

  async navigate(url: string): Promise<PageBody> {
    this.navigations += 1;
    this.url = url;
    return { url, title: 'table', snapshot: this.snapshot };
  }

  async capture() {
    const items: ModelItem[] = [{ ref: 'e1', backend: 1, role: 'combobox', name: '学年' }];
    if (this.includeButton) items.push({ ref: 'e2', backend: 2, role: 'button', name: '查询', text: '查询' });
    return { items, tables: [], url: this.url };
  }

  currentUrl(): string {
    return this.url;
  }

  async pageText(): Promise<string> {
    return this.text;
  }

  async extract() {
    return { rows: [], limit: 200, truncated: false };
  }

  async evalExpr(): Promise<string> {
    throw new Error('eval was not expected');
  }

  async queryCss(): Promise<number[]> {
    return [];
  }

  async hasVisiblePassword(): Promise<boolean> {
    return false;
  }

  async isPasswordBackend(): Promise<boolean> {
    return false;
  }

  async performBackend(): Promise<void> {}

  async performInput(): Promise<void> {}

  async waitFor(_input: WaitInput) {
    return { url: this.url, title: 'table', snapshot: this.snapshot, matched: false };
  }

  async excerpt(): Promise<string> {
    return 'excerpt';
  }

  async fullSnapshot(): Promise<string> {
    return this.snapshot;
  }

  documentEpoch(): number {
    return 1;
  }

  markDownloads(): number {
    return 0;
  }

  releaseDownloads(): void {}

  async waitForDownloadBegin(): Promise<null> {
    return null;
  }

  async waitForDownloadComplete(): Promise<'completed' | 'canceled'> {
    return 'canceled';
  }

  async saveDownload(): Promise<SavedDownload> {
    throw new Error('unused');
  }

  async printPdf(): Promise<SavedDownload> {
    throw new Error('unused');
  }
}

function demoSkill(): Skill {
  return {
    name: 'demo-skill',
    description: 'demo',
    version: 1,
    start_url: 'http://fixture.test/table',
    params: { year: { type: 'string' } },
    steps: [
      { id: 'year', intent: '选择学年', select: { target: { role: 'combobox', name: '学年' }, value: '{{year}}' } },
      clickStep,
      { id: 'check', expect: { any: [{ outcome: 'ok', when: { text_present: '课表' } }] } },
    ],
  };
}

describe('heal ledger', () => {
  it('allows two attempts, then budget, and expires after 10 minutes', () => {
    const ledger = new HealLedger();
    const ticket = ledger.issue({
      name: 'demo-skill',
      version: 1,
      stepId: 'go',
      params: {},
      url: 'http://fixture.test/table',
      epoch: 4,
      priorOutcome: 'undecided',
      outDir: 'out',
      snapshot: 'snap',
      now: 1_000,
    });
    const attempt = { token: ticket.token, name: 'demo-skill', stepId: 'go', epoch: 4, url: 'http://fixture.test/table' };
    expect(ledger.beginAttempt({ ...attempt, now: 1_000 }).ok).toBe(true);
    expect(ledger.beginAttempt({ ...attempt, now: 1_000 }).ok).toBe(true);
    expect(ledger.beginAttempt({ ...attempt, now: 1_000 })).toMatchObject({ ok: false, reason: 'heal_budget' });

    const expired = new HealLedger();
    const old = expired.issue({
      name: 'demo-skill',
      version: 1,
      stepId: 'go',
      params: {},
      url: 'http://fixture.test/table',
      epoch: 4,
      priorOutcome: 'undecided',
      outDir: 'out',
      snapshot: 'snap',
      now: 0,
    });
    expect(expired.beginAttempt({ token: old.token, name: 'demo-skill', stepId: 'go', epoch: 4, url: 'http://fixture.test/table', now: HEAL_TOKEN_MS + 1 })).toMatchObject({
      ok: false,
      reason: 'heal_token',
    });
  });

  it('issues a token only for a healable miss and stops after three healed steps', () => {
    const ledger = new HealLedger();
    const site = {
      step: clickStep,
      reason: 'target_not_found',
      params: { year: '2025-2026' },
      priorOutcome: 'undecided' as const,
      outDir: 'out',
      healable: true,
      missingTarget: true,
    };
    const issued = buildHealContext({ site, skillName: 'demo-skill', skillVersion: 1, snapshot: 'full', url: 'http://fixture.test/table', epoch: 1, outDir: 'out', ledger });
    expect(issued?.heal_token).toMatch(/^[a-f0-9]{32}$/);
    expect(issued?.intent).toBe('点击查询');

    const unmatched = buildHealContext({
      site: { ...site, reason: 'expect_unmatched', healable: false, missingTarget: false },
      skillName: 'demo-skill',
      skillVersion: 1,
      snapshot: 'full',
      url: 'http://fixture.test/table',
      epoch: 1,
      outDir: 'out',
      ledger: new HealLedger(),
    });
    expect(unmatched?.reason).toBe('expect_unmatched');
    expect(unmatched?.heal_token).toBeUndefined();

    const capped = new HealLedger();
    capped.noteHealed();
    capped.noteHealed();
    capped.noteHealed();
    const hidden = buildHealContext({ site, skillName: 'demo-skill', skillVersion: 1, snapshot: 'full', url: 'http://fixture.test/table', epoch: 1, outDir: 'out', ledger: capped });
    expect(hidden?.snapshot).toBe('full');
    expect(hidden?.heal_token).toBeUndefined();
    expect(capped.canIssue()).toBe(false);
  });
});

describe('replay matrix', () => {
  it('skips the remaining combinations when a target is missing', async () => {
    const page = new FakePage();
    let failures = 0;
    const report = await runMatrix(page, demoSkill(), { matrix: { year: ['2025-2026', '2026-2027'] } }, {
      onFailure: async (site) => {
        failures += 1;
        expect(site.healable).toBe(true);
        expect(site.completed?.map((step) => step.id)).toEqual(['year']);
        expect(site.completed?.[0]?.status).toBe('done');
        expect(site.remaining).toEqual([{ year: '2026-2027' }]);
        return {
          name: 'demo-skill',
          version: 1,
          step_id: site.step.id,
          kind: 'click',
          intent: '点击查询',
          reason: site.reason,
          url: 'http://fixture.test/table',
          params: site.params,
          snapshot: page.snapshot,
          heal_token: 'token',
        };
      },
    });
    expect(failures).toBe(1);
    expect(page.navigations).toBe(1);
    expect(report.exit_code).toBe(30);
    expect(report.results[0]).toMatchObject({ outcome: 'broken', halt_matrix: true });
    expect(report.results[0]?.broken?.reason).toBe('target_not_found');
    expect(report.results[1]?.outcome).toBe('skipped');
    expect(stopsMatrix(report.results[0]!)).toBe(true);
    expect(summaryExitCode(report.results)).toBe(30);
  });

  it('skips the combination the skill was just saved from', async () => {
    const page = new FakePage();
    page.includeButton = true;
    page.text = 'nothing';
    const done = { params: { year: '2025-2026' }, why: 'done by hand' };
    const report = await runMatrix(page, demoSkill(), { matrix: { year: ['2025-2026', '2026-2027'] } }, undefined, done);
    expect(page.navigations).toBe(1);
    expect(report.results[0]).toMatchObject({ outcome: 'skipped', params: { year: '2025-2026' } });
    expect(report.results[0]?.message).toContain('done by hand');
    expect(report.results[1]?.params).toEqual({ year: '2026-2027' });
    expect(report.results[1]?.outcome).not.toBe('skipped');

    const single = new FakePage();
    single.includeButton = true;
    single.text = 'nothing';
    await runMatrix(single, demoSkill(), { params: { year: '2025-2026' } }, undefined, done);
    expect(single.navigations).toBe(1);
  });

  it('does not stop the matrix or mint a token when expect matches nothing', async () => {
    const page = new FakePage();
    page.includeButton = true;
    page.text = 'nothing';
    const tokens: string[] = [];
    const report = await runMatrix(page, demoSkill(), { matrix: { year: ['2025-2026', '2026-2027'] } }, {
      onFailure: async (site) => {
        expect(site.reason).toBe('expect_unmatched');
        expect(site.healable).toBe(false);
        const context = buildHealContext({
          site,
          skillName: 'demo-skill',
          skillVersion: 1,
          snapshot: page.snapshot,
          url: page.url,
          epoch: 1,
          outDir: 'out',
          ledger: new HealLedger(),
        });
        if (context?.heal_token) tokens.push(context.heal_token);
        return context;
      },
    });
    expect(page.navigations).toBe(2);
    expect(tokens).toEqual([]);
    expect(report.results.every((result) => result.outcome === 'broken' && result.broken?.reason === 'expect_unmatched')).toBe(true);
    expect(report.results.some((result) => result.outcome === 'skipped')).toBe(false);
    const text = formatRunReport(report.results);
    expect(text).toContain('this step is not repaired automatically');
    expect(text).not.toContain('heal_token:');
  });
});

describe('heal report', () => {
  it('tells the model to patch the one failed step and keeps the snapshot out of the instruction', () => {
    const result: SkillRunResult = {
      outcome: 'broken',
      params: { year: '2025-2026' },
      steps: [{ id: 'go', status: 'failed', ms: 1 }],
      duration_ms: 1,
      broken: {
        step_id: 'go',
        reason: 'target_not_found',
        excerpt: 'excerpt',
        heal: {
          name: 'demo-skill',
          version: 1,
          step_id: 'go',
          kind: 'click',
          intent: '点击查询',
          target: { role: 'button', name: '查询' },
          reason: 'target_not_found',
          url: 'http://fixture.test/table',
          params: { year: '2025-2026' },
          snapshot: '[e4] button "检索"',
          heal_token: 'abc',
        },
      },
    };
    const text = formatRunReport([result], { total: 18, steps: [{ step_id: 'go', prompt: 11, completion: 7 }] });
    const instruction = text.indexOf('call skill_patch');
    const page = text.indexOf('<page_content>');
    expect(instruction).toBeGreaterThan(0);
    expect(page).toBeGreaterThan(instruction);
    expect(text.slice(page)).toContain('[e4] button "检索"');
    expect(text).toContain('llm_tokens go: prompt=11 completion=7');
    expect(text).toContain('llm_tokens: 18');
  });

  it('prints the later step when a patch tail fails', () => {
    const reason = rerunFailedReason('s5-download-确定', 'target_not_found');
    expect(reason).toBe('rerun_failed: s5-download-确定 target_not_found');
    const text = formatRunReport([
      {
        outcome: 'broken',
        message: reason,
        params: { year: '2025-2026' },
        steps: [{ id: 's3-click-查询', status: 'failed', ms: 1 }],
        duration_ms: 1,
        broken: { step_id: 's3-click-查询', reason: 'heal_failed', excerpt: '' },
      },
    ]);
    expect(text).toContain('s3-click-查询 heal_failed rerun_failed: s5-download-确定 target_not_found');
  });

  it('reports the healed combination as finished and names what is left', () => {
    const merged = mergeResumedRun(
      {
        steps: [
          { id: 's1-select-学年', status: 'done', locator: 'role_name', ms: 2 },
          { id: 's2-select-学期', status: 'done', locator: 'role_name', ms: 3 },
        ],
      },
      {
        outcome: 'ok',
        params: { year: '2025-2026', term: '1' },
        steps: [
          { id: 's3-click-查询', status: 'done', locator: 'role_name', ms: 4 },
          { id: 's4-click-输出PDF', status: 'done', locator: 'role_name', ms: 5 },
          { id: 's5-download-确定', status: 'done', locator: 'role_name', ms: 6 },
        ],
        duration_ms: 20,
        artifacts: [{ step_id: 's5-download-确定', path: 'out/2025-2026-1.pdf', bytes: 8, sha256: 'ab' }],
      },
    );
    expect(merged.steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(merged.duration_ms).toBe(25);
    expect(merged.artifacts?.map((artifact) => artifact.path)).toEqual(['out/2025-2026-1.pdf']);
    const text = formatPatchResult({
      accepted: true,
      name: 'zf-pdf-heal',
      step_id: 's3-click-查询',
      to_version: 2,
      outcome: 'ok',
      result: merged,
      remaining_params: [{ year: '2026-2027', term: '1' }],
    });
    expect(text).toContain('steps: 5/5');
    expect(text).toContain('finished: year=2025-2026 term=1');
    expect(text).toContain('Do not run it again');
    expect(text).toContain('year=2026-2027 term=1');
    expect(text).toContain('out/2025-2026-1.pdf');
    expect(
      formatPatchResult({
        accepted: true,
        name: 'zf-pdf-heal',
        step_id: 's3-click-查询',
        to_version: 2,
        outcome: 'ok',
        result: merged,
        remaining_params: [],
      }),
    ).toContain('No combinations remain');
  });
});

describe('heal model call', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('sends only the failed step and parses the ref', async () => {
    const seen: unknown[] = [];
    globalThis.fetch = (async (_url, init) => {
      seen.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'prefix {"ref":"e4","reason":"检索"} suffix' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const heal: HealContext = {
      name: 'demo-skill',
      version: 1,
      step_id: 'go',
      kind: 'click',
      intent: '点击查询',
      target: { role: 'button', name: '查询' },
      reason: 'target_not_found',
      url: 'http://fixture.test/table',
      params: { year: 'do-not-send' },
      snapshot: '[e4] button "检索"',
      heal_token: 'abc',
    };
    const choice = await completeHeal({ base_url: 'http://127.0.0.1:9/v1', model: 'mock-heal', api_key_env: 'RELAYWRIGHT_HEAL_TEST_KEY' }, 'secret-key', heal);
    expect(choice).toMatchObject({ ref: 'e4', prompt: 11, completion: 7 });
    const body = seen[0] as { messages: { role: string; content: string }[]; response_format?: { type: string } };
    expect(body.response_format).toEqual({ type: 'json_object' });
    const user = body.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(user).toContain('intent: 点击查询');
    expect(user).toContain('kind: click');
    expect(user).toContain('查询');
    expect(user).toContain('http://fixture.test/table');
    expect(user).toContain('[e4] button "检索"');
    expect(user).not.toContain('do-not-send');
    expect(JSON.stringify(body)).not.toContain('secret-key');
  });

  it('retries once without response_format and hides the api key', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response('unsupported response_format', { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ref":null,"reason":"none"}' } }] }), { status: 200 });
    }) as typeof fetch;
    const heal: HealContext = {
      name: 'demo-skill',
      version: 1,
      step_id: 'go',
      kind: 'click',
      reason: 'target_not_found',
      url: 'http://fixture.test/table',
      params: {},
      snapshot: 'snap',
    };
    const choice = await completeHeal({ base_url: 'http://127.0.0.1:9/v1', model: 'mock-heal', api_key_env: 'RELAYWRIGHT_HEAL_TEST_KEY' }, 'secret-key', heal);
    expect(calls).toBe(2);
    expect(choice.ref).toBeNull();

    globalThis.fetch = (async () => {
      throw new Error('connect failed for secret-key');
    }) as typeof fetch;
    await expect(completeHeal({ base_url: 'http://127.0.0.1:9/v1', model: 'mock-heal', api_key_env: 'RELAYWRIGHT_HEAL_TEST_KEY' }, 'secret-key', heal)).rejects.toThrow(/heal_failed/);
    await expect(completeHeal({ base_url: 'http://127.0.0.1:9/v1', model: 'mock-heal', api_key_env: 'RELAYWRIGHT_HEAL_TEST_KEY' }, 'secret-key', heal)).rejects.toThrow(/^(?!.*secret-key)/);
  });
});

describe('heal config and privacy mask', () => {
  it('keeps the privacy flag when heal config is written, and never prints the key', () => {
    const root = mkdtempSync(join(tmpdir(), 'relaywright-heal-config-'));
    new PrivacyStore(root).setGlobalMode(true);
    const config = writeHealConfig({ base_url: 'http://127.0.0.1:9/v1/', model: 'mock-heal', api_key_env: 'RELAYWRIGHT_HEAL_TEST_KEY' }, root);
    expect(config.base_url).toBe('http://127.0.0.1:9/v1');
    expect(new PrivacyStore(root).globalMode()).toBe(true);
    new PrivacyStore(root).setGlobalMode(false);
    expect(readHealConfig(root).model).toBe('mock-heal');
    const text = formatHealConfig(config, { RELAYWRIGHT_HEAL_TEST_KEY: 'super-secret-value' });
    expect(text).toContain('api_key: set');
    expect(text).not.toContain('super-secret-value');
    expect(missingKeyHint('RELAYWRIGHT_HEAL_TEST_KEY')).toContain('relaywright heal config');
  });

  it('masks short privacy values down to the last character', () => {
    expect(maskTail('')).toBe('');
    expect(maskTail('a')).toBe('a');
    expect(maskTail('ab')).toBe('*b');
    expect(maskTail('abcd')).toBe('***d');
    expect(maskTail('abcde')).toBe('***de');
    expect(maskTail('13800138000')).toBe('*********00');
  });
});

describe('login watch and audit query', () => {
  it('injects input, change, and submit listeners', () => {
    const source = loginAccountWatchSource();
    expect(source).toContain("addEventListener('input'");
    expect(source).toContain("addEventListener('change'");
    expect(source).toContain("addEventListener('submit'");
    expect(() => new Function(source)).not.toThrow();
    expect(readBindingPayload('"fastuser99"')).toBe('fastuser99');
    expect(readBindingPayload('["fastuser99"]')).toBe('fastuser99');
    expect(readBindingPayload('fastuser99')).toBe('fastuser99');
  });

  it('returns value-free audit entries and the chain status', async () => {
    recordAudit('skill_patched', { name: 'unit-heal-skill', from_version: 1, to_version: 2, step_id: 'go', healer: 'mcp', llm_tokens: 18 });
    await flushAudit();
    const found = queryAudit({ event: 'skill_patched', skill: 'unit-heal-skill', limit: 5 });
    expect(found.chain.ok).toBe(true);
    expect(found.entries.at(-1)).toMatchObject({ event: 'skill_patched', name: 'unit-heal-skill', healer: 'mcp', from_version: 1, to_version: 2 });
    expect(JSON.stringify(found.entries)).not.toContain('个人课表');
  });
});

describe('v3 fixture and mock healer', () => {
  it('redesigns the query button and keeps the pdf text', () => {
    const html = readFileSync(join(repoRoot, 'fixtures', 'zf-mock', 'v3', 'index.html'), 'utf8');
    expect(html).toContain('学年');
    expect(html).toContain('学期');
    expect(html).toContain('id="yearPick"');
    expect(html).toContain('id="termPick"');
    expect(html).toContain('id="btn-retrieve"');
    expect(html).toContain('检索');
    expect(html).toContain('输出PDF');
    expect(html).toContain('id="pdf-go"');
    expect(html).toContain('id="export-dialog"');
    expect(html).toContain('id="export-confirm"');
    expect(html).toContain('action="/zf-mock/export.pdf"');
    expect(html).not.toContain('search_go');
    expect(html).not.toContain('pdf-ok');
    expect(html).not.toContain('shcPDF');
    expect(html).not.toContain('id="xnm"');
    expect(html).not.toContain('id="xqm"');
    expect(html).not.toContain('>查询<');
  });

  it('returns the ref on the 检索 line of an escaped snapshot', async () => {
    const server = await startStatic(join(repoRoot, 'fixtures'));
    try {
      const snapshot = '[e1] combobox "学年"\n[e4] button "检索"\n[e9] button "输出PDF"';
      const response = await fetch(`http://127.0.0.1:${server.port}/mock-llm/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret-key' },
        body: JSON.stringify({ messages: [{ role: 'user', content: `snapshot:\n${snapshot}` }] }),
      });
      const json = (await response.json()) as { choices: { message: { content: string } }[]; usage: { prompt_tokens: number; completion_tokens: number } };
      expect(JSON.parse(json.choices[0]?.message.content ?? '{}')).toEqual({ ref: 'e4', reason: 'button text is 检索' });
      expect(json.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
    } finally {
      await server.close();
    }
  });
});

describe('parseHealContent', () => {
  it('accepts a ref or null and rejects anything else', () => {
    expect(parseHealContent('{"ref":"e12","reason":"检索"}')).toEqual({ ref: 'e12', reason: '检索' });
    expect(parseHealContent('note {"ref":null,"reason":"none"} trailing')).toEqual({ ref: null, reason: 'none' });
    expect(() => parseHealContent('{"ref":"button"}')).toThrow(/heal_failed/);
  });
});
