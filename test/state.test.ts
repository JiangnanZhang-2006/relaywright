import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stateDir } from '../src/config/paths.js';
import { createApp } from '../src/daemon/server.js';
import { RelayError } from '../src/errors.js';
import { Redactor } from '../src/privacy/redactor.js';
import type { BrowserControl } from '../src/session/browser.js';
import type { ReplayPage } from '../src/session/page.js';
import { parseSkill, stringifySkill, type Skill } from '../src/skills/schema.js';
import { runSkill } from '../src/skills/run.js';
import { parseStateValue, STATE_VALUE_LIMIT, stateDelete, stateGet, stateList, statePut } from '../src/state/store.js';
import { resolveStateText } from '../src/state/template.js';

const PHONE = '13800138000';

describe('state store', () => {
  it('creates with if_version 0, conflicts, and lists versions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rw-state-'));
    const created = await statePut('notes', 'last', { title: 'kb' }, 0, root);
    expect(created.version).toBe(1);
    await expect(statePut('notes', 'last', 'other', 0, root)).rejects.toMatchObject({
      code: 'version_conflict',
      details: { version: 1 },
    });
    const next = await statePut('notes', 'last', { title: 'kb', n: 2 }, 1, root);
    expect(next.version).toBe(2);
    expect(await stateGet('notes', 'last', root)).toMatchObject({ value: { title: 'kb', n: 2 }, version: 2 });
    await statePut('notes', 'other', 'x', undefined, root);
    expect(await stateList('notes', root)).toEqual([
      { key: 'last', version: 2, updated_at: next.updated_at },
      { key: 'other', version: 1, updated_at: expect.any(String) },
    ]);
    await expect(stateDelete('notes', 'last', 1, root)).rejects.toMatchObject({ code: 'version_conflict', details: { version: 2 } });
    expect(await stateDelete('notes', 'last', 2, root)).toEqual({ key: 'last', version: 2 });
    await expect(stateGet('notes', 'last', root)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects oversized values, bad namespaces, and dotted keys', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rw-state-'));
    const exact = 'x'.repeat(STATE_VALUE_LIMIT - 2);
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(STATE_VALUE_LIMIT);
    await statePut('notes', 'fit', exact, undefined, root);
    await expect(statePut('notes', 'big', 'x'.repeat(STATE_VALUE_LIMIT - 1), undefined, root)).rejects.toMatchObject({
      code: 'bad_request',
    });
    for (const ns of ['..', '.', 'a..b', 'Bad', 'a/b', '']) {
      await expect(statePut(ns, 'k', 1, undefined, root)).rejects.toMatchObject({ code: 'bad_request' });
    }
    for (const key of ['a.b', 'a/b', '..', '', 'k'.repeat(129)]) {
      await expect(statePut('notes', key, 1, undefined, root)).rejects.toMatchObject({ code: 'bad_request' });
    }
  });

  it('keeps a valid namespace file when writes overlap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rw-state-'));
    await statePut('batch', 'seed', { n: 0 }, 0, root);
    await Promise.all(
      Array.from({ length: 30 }, (_, index) => statePut('batch', `k${index}`, { index }, undefined, root)),
    );
    const reads = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        stateGet('batch', `k${index}`, root).catch((err: unknown) => {
          if (err instanceof RelayError && (err.code === 'not_found' || err.code === 'bad_request')) throw err;
          throw err;
        }),
      ),
    );
    expect(reads).toHaveLength(30);
    const names = readdirSync(stateDir(root));
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(names).toContain('batch.json');
    const parsed = JSON.parse(readFileSync(join(stateDir(root), 'batch.json'), 'utf8')) as { keys: Record<string, unknown> };
    expect(Object.keys(parsed.keys)).toHaveLength(31);

    await statePut('race', 'k', 'v1', 0, root);
    const settled = await Promise.allSettled([statePut('race', 'k', 'a', 1, root), statePut('race', 'k', 'b', 1, root)]);
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((item) => item.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({
      code: 'version_conflict',
      details: { version: 2 },
    });
    const stored = await stateGet('race', 'k', root);
    expect(stored.version).toBe(2);
    expect(['a', 'b']).toContain(stored.value);
  });

  it('walks templates and reports a missing key as state_missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rw-state-'));
    await statePut('notes', 'row', { title: '课表', tags: ['a', 'b'], n: 2 }, undefined, root);
    expect(await resolveStateText('see {{state.notes.row.title}}', root)).toBe('see 课表');
    expect(await resolveStateText('{{state.notes.row.tags.0}}/{{state.notes.row.n}}', root)).toBe('a/2');
    expect(await resolveStateText('plain', root)).toBe('plain');
    expect(parseStateValue(' {"title":"课表"} ')).toEqual({ title: '课表' });
    expect(parseStateValue('hello')).toBe('hello');
    await expect(resolveStateText('{{state.notes.missing}}', root)).rejects.toMatchObject({ code: 'state_missing' });
    await expect(resolveStateText('{{state.notes.row.nope}}', root)).rejects.toMatchObject({ code: 'state_missing' });
  });

  it('returns version_conflict with the current version over HTTP', async () => {
    const session = { redactOutbound: <T>(value: T): T => value } as BrowserControl;
    const app = createApp({ token: 'state-token', session, onShutdown: () => undefined });
    const put = await app.request('http://127.0.0.1/state/put', {
      method: 'POST',
      headers: { authorization: 'Bearer state-token', 'content-type': 'application/json' },
      body: JSON.stringify({ ns: 'httpnotes', key: 'last', value: { ok: true }, if_version: 0 }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ version: 1 });
    const conflict = await app.request('http://127.0.0.1/state/put', {
      method: 'POST',
      headers: { authorization: 'Bearer state-token', 'content-type': 'application/json' },
      body: JSON.stringify({ ns: 'httpnotes', key: 'last', value: 'nope', if_version: 0 }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'version_conflict', version: 1 } });
    const missing = await app.request('http://127.0.0.1/state/get', {
      method: 'POST',
      headers: { authorization: 'Bearer state-token', 'content-type': 'application/json' },
      body: JSON.stringify({ ns: 'httpnotes', key: 'absent' }),
    });
    expect(missing.status).toBe(404);
    const bad = await app.request('http://127.0.0.1/state/put', {
      method: 'POST',
      headers: { authorization: 'Bearer state-token', 'content-type': 'application/json' },
      body: JSON.stringify({ ns: '..', key: 'last', value: 1 }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('state in skills', () => {
  it('writes during a step and lets a later step read it', async () => {
    const replay = fakePage();
    const out = mkdtempSync(join(tmpdir(), 'rw-state-out-'));
    const skill: Skill = {
      name: 'state-note',
      description: 'save a page',
      version: 1,
      start_url: 'http://127.0.0.1/start',
      params: { id: { type: 'string' } },
      steps: [
        { id: 'save', state_set: { ns: 'skillnotes', key: 'page', value: 'http://127.0.0.1/{{id}}' } },
        { id: 'go', goto: { url: '{{state.skillnotes.page}}' } },
      ],
    };
    const ran = await runSkill(replay.page, skill, { id: 'abc' }, { outDir: out });
    expect(ran.outcome).toBe('ok');
    expect(replay.visits).toEqual(['http://127.0.0.1/start', 'http://127.0.0.1/abc']);
    expect((await stateGet('skillnotes', 'page')).value).toBe('http://127.0.0.1/abc');

    const nested = fakePage();
    const walked: Skill = {
      ...skill,
      steps: [
        { id: 'save', state_set: { ns: 'skillnotes', key: 'meta', value: '{"title":"kb","n":2}' } },
        { id: 'go', goto: { url: 'http://127.0.0.1/{{state.skillnotes.meta.title}}/{{state.skillnotes.meta.n}}' } },
      ],
    };
    expect((await runSkill(nested.page, walked, { id: 'abc' }, { outDir: out })).outcome).toBe('ok');
    expect(nested.visits.at(-1)).toBe('http://127.0.0.1/kb/2');

    const missingPath = fakePage();
    const broken = await runSkill(
      missingPath.page,
      {
        ...skill,
        steps: [
          { id: 'save', state_set: { ns: 'skillnotes', key: 'meta', value: '{"title":"kb"}' } },
          { id: 'go', goto: { url: 'http://127.0.0.1/{{state.skillnotes.meta.missing}}' } },
        ],
      },
      { id: 'abc' },
      { outDir: out },
    );
    expect(broken.outcome).toBe('broken');
    expect(broken.broken?.reason).toContain('state_missing');
    expect(missingPath.visits).toEqual(['http://127.0.0.1/start']);

    const gap = fakePage();
    gap.page.hasVisiblePassword = async () => true;
    let waited = false;
    const before = await runSkill(
      gap.page,
      { ...skill, start_url: '{{state.skillnotes.absent}}', steps: [{ id: 'go', goto: { url: 'http://127.0.0.1/nope' } }] },
      { id: 'abc' },
      {
        outDir: out,
        waitForHuman: async () => {
          waited = true;
          return 'timeout';
        },
      },
    );
    expect(before.outcome).toBe('broken');
    expect(before.broken?.step_id).toBe('start');
    expect(before.broken?.reason).toContain('state_missing');
    expect(gap.visits).toEqual([]);
    expect(waited).toBe(false);
  });

  it('de-identifies a state_set value the same way as other skill text', () => {
    const skill: Skill = {
      name: 'state-phone',
      description: 'save a number',
      version: 1,
      start_url: 'https://school.edu.cn/home',
      params: {},
      steps: [{ id: 'save', state_set: { ns: 'notes', key: 'phone', value: PHONE } }],
    };
    expect(parseSkill(stringifySkill(skill)).steps[0]?.state_set?.value).toBe(PHONE);
    const redactor = new Redactor({ root: mkdtempSync(join(tmpdir(), 'rw-state-privacy-')) });
    redactor.absorb(`联系电话 ${PHONE}`, 'https://school.edu.cn/home');
    const cleaned = redactor.deidentify(skill, 'https://school.edu.cn/home');
    const saved = stringifySkill(cleaned.skill);
    expect(saved).not.toContain(PHONE);
    expect(saved).toContain('{{phone');
    expect(cleaned.skill.steps[0]?.state_set?.ns).toBe('notes');
    expect(cleaned.skill.steps[0]?.state_set?.key).toBe('phone');
  });
});

function fakePage(): { page: ReplayPage; visits: string[] } {
  const visits: string[] = [];
  let url = 'about:blank';
  const page: ReplayPage = {
    navigate: async (next) => {
      visits.push(next);
      url = next;
      return { url: next, title: 't', snapshot: '' };
    },
    capture: async () => ({ items: [], tables: [], url }),
    currentUrl: () => url,
    pageText: async () => '查询',
    extract: async () => ({ rows: [], limit: 200, truncated: false }),
    evalExpr: async () => {
      throw new Error('eval was not expected');
    },
    queryCss: async () => [],
    hasVisiblePassword: async () => false,
    isPasswordBackend: async () => false,
    performBackend: async () => {
      throw new Error('act was not expected');
    },
    performInput: async () => {
      throw new Error('input was not expected');
    },
    waitFor: async () => ({ matched: true, url, title: 't', snapshot: '' }),
    excerpt: async () => '',
    fullSnapshot: async () => '',
    documentEpoch: () => 1,
    markDownloads: () => 1,
    releaseDownloads: () => undefined,
    waitForDownloadBegin: async () => null,
    waitForDownloadComplete: async () => 'completed',
    saveDownload: async () => {
      throw new Error('download was not expected');
    },
    printPdf: async () => {
      throw new Error('pdf was not expected');
    },
  };
  return { page, visits };
}
