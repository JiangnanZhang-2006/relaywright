import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModelItem } from '../src/perception/snapshot.js';
import type { ReplayDownload, ReplayPage } from '../src/session/page.js';
import { valueForTrace } from '../src/recorder/redact.js';
import { observedLines, TraceLog } from '../src/recorder/trace.js';
import type { TargetDescriptor, TraceStep } from '../src/recorder/types.js';
import { chooseLocator } from '../src/skills/locate.js';
import { expandMatrix, summaryExitCode, bindSkill, runSkill } from '../src/skills/run.js';
import { buildSkill, makeStepId, slugTarget } from '../src/skills/save.js';
import { parseSkill, stringifySkill, type Skill } from '../src/skills/schema.js';
import { listSkills, readSkill, rollbackSkill, skillHistory, writeSkill } from '../src/skills/store.js';
import { templatize } from '../src/skills/template.js';

const PAGE = 'http://127.0.0.1:8765/zf-mock/v1/';

function target(partial: Partial<TargetDescriptor> & Pick<TargetDescriptor, 'role' | 'name'>): TargetDescriptor {
  return { tag: 'button', css: '', cssUnique: false, ...partial };
}

function traceStep(partial: Partial<TraceStep> & Pick<TraceStep, 'n' | 'action'>): TraceStep {
  return {
    at: '2026-01-01T00:00:00.000Z',
    urlBefore: PAGE,
    urlAfter: PAGE,
    observed: ['[e1] button "查询"'],
    ...partial,
  };
}

function timetableTrace(): TraceStep[] {
  return [
    traceStep({ n: 1, action: 'goto', value: PAGE, urlBefore: 'about:blank', urlAfter: PAGE }),
    traceStep({
      n: 2,
      action: 'select',
      value: '2025-2026',
      target: target({ role: 'combobox', name: '学年', tag: 'select', id: 'xnm', css: '#xnm', cssUnique: true }),
    }),
    traceStep({
      n: 3,
      action: 'select',
      value: '2',
      target: target({ role: 'combobox', name: '学期', tag: 'select', id: 'xqm', css: '#xqm', cssUnique: true }),
    }),
    traceStep({
      n: 4,
      action: 'click',
      target: target({
        role: 'button',
        name: '查询',
        tag: 'button',
        id: 'search_go',
        css: '#search_go',
        cssUnique: true,
        text: '查询',
      }),
    }),
  ];
}

const CHECKS = [
  {
    after_step: 4,
    any: [
      {
        outcome: 'empty' as const,
        when: { text_present: '该学年学期尚无您的课表' },
        message: '{{year}} 第{{term}}学期尚未排课',
      },
      { outcome: 'ok' as const, when: { table_rows_min: 1 } },
    ],
  },
];

function savedTimetable() {
  return buildSkill(timetableTrace(), {
    name: 'zf-timetable',
    description: '查询指定学年学期的个人课表',
    params: { year: '2025-2026', term: '2' },
    checks: CHECKS,
  });
}

function item(partial: Partial<ModelItem> & Pick<ModelItem, 'backend' | 'role' | 'name'>): ModelItem {
  return { ref: `e${partial.backend}`, ...partial };
}

describe('skill yaml', () => {
  it('round-trips the timetable skill', () => {
    const built = savedTimetable();
    const again = parseSkill(stringifySkill(built.skill));
    expect(again).toEqual(built.skill);
    expect(again.steps.map((step) => step.id)).toEqual(['s1-select-学年', 's2-select-学期', 's3-click-查询', 's4-expect']);
    expect(again.params.year).toEqual({ type: 'string', example: '2025-2026' });
    expect(again.steps[3]?.expect?.any[0]?.message).toBe('{{year}} 第{{term}}学期尚未排课');
  });
});

describe('skill save', () => {
  it('templatizes values without rewriting ports or years', () => {
    const built = savedTimetable();
    expect(built.skill.start_url).toBe(PAGE);
    expect(built.skill.steps[0]?.select?.value).toBe('{{year}}');
    expect(built.skill.steps[1]?.select?.value).toBe('{{term}}');
    expect(built.warnings).toEqual([]);
    const rewritten = templatize('http://127.0.0.1:8765/zf-mock/v1/ 2025-2026', [
      { name: 'year', example: '2025-2026' },
      { name: 'term', example: '2' },
    ]);
    expect(rewritten.text).toBe('http://127.0.0.1:8765/zf-mock/v1/ {{year}}');
    expect(templatize('{{secret}}', [{ name: 'year', example: '2025-2026' }]).text).toBe('{{secret}}');
  });

  it('rejects a param that matched nothing', () => {
    expect(() =>
      buildSkill(timetableTrace(), {
        name: 'zf-timetable',
        description: '查询课表',
        params: { year: '2025-2026', term: '2', room: 'A101' },
      }),
    ).toThrow(expect.objectContaining({ code: 'param_unused', message: expect.stringContaining('room') }));
  });

  it('inserts an expect after the requested step and rejects a step outside the range', () => {
    const built = savedTimetable();
    expect(built.skill.steps[3]?.expect?.any.map((branch) => branch.outcome)).toEqual(['empty', 'ok']);
    expect(() =>
      buildSkill(timetableTrace(), {
        name: 'zf-timetable',
        description: '查询课表',
        params: { year: '2025-2026', term: '2' },
        checks: [{ after_step: 9, any: [{ outcome: 'ok', when: { table_rows_min: 1 } }] }],
      }),
    ).toThrow(expect.objectContaining({ code: 'bad_params' }));
  });

  it('builds step ids from the action and the target name', () => {
    expect(slugTarget('查询 按钮')).toBe('查询-按钮');
    expect(makeStepId(1, 'select', '学年')).toBe('s1-select-学年');
    expect(makeStepId(4, 'expect')).toBe('s4-expect');
    const ranged = buildSkill(timetableTrace(), {
      name: 'zf-timetable',
      description: '查询课表',
      params: { year: '2025-2026' },
      from_step: 2,
      to_step: 2,
    });
    expect(ranged.skill.steps.map((step) => step.id)).toEqual(['s1-select-学年']);
    expect(ranged.skill.start_url).toBe(PAGE);
  });

  it('warns when css is not unique and when a later step follows a navigation', () => {
    const steps = timetableTrace();
    const click = steps[3];
    if (!click?.target) throw new Error('missing click');
    click.target = { ...click.target, css: 'button.btn', cssUnique: false };
    const drifted = [
      ...steps.slice(0, 3),
      traceStep({ ...click, n: 4, urlAfter: `${PAGE}#next` }),
      traceStep({
        n: 5,
        action: 'click',
        urlBefore: `${PAGE}#next`,
        urlAfter: `${PAGE}#next`,
        target: target({ role: 'button', name: '输出PDF', css: '#shcPDF', cssUnique: true }),
      }),
    ];
    const built = buildSkill(drifted, {
      name: 'zf-timetable',
      description: '查询课表',
      params: { year: '2025-2026', term: '2' },
    });
    expect(built.warnings.some((warning) => warning.includes('s3-click-查询') && warning.includes('not unique'))).toBe(true);
    expect(built.warnings.some((warning) => warning.includes('s3-click-查询') && warning.includes('relies only on name'))).toBe(true);
    expect(built.warnings.some((warning) => warning.startsWith('s4-click-输出PDF') && warning.includes('navigation'))).toBe(true);
    expect(built.skill.steps[2]?.click?.target.css).toBeUndefined();
  });
});

describe('recorder secrets', () => {
  it('stores a password and sensitive names as {{secret}} and leaves select values', () => {
    expect(valueForTrace('type', 'secret-fixture', { name: '密码' })).toBe('{{secret}}');
    expect(valueForTrace('type', 'secret-fixture', { label: 'captcha' })).toBe('{{secret}}');
    expect(valueForTrace('type', 'secret-fixture', { sensitive: true, name: '用户名' })).toBe('{{secret}}');
    expect(valueForTrace('type', 'student', { name: '用户名' })).toBe('student');
    expect(valueForTrace('select', '2', { name: '密码' })).toBe('2');

    const dir = mkdtempSync(join(tmpdir(), 'relaywright-trace-'));
    const log = new TraceLog(dir);
    log.append({
      action: 'type',
      urlBefore: PAGE,
      urlAfter: PAGE,
      value: valueForTrace('type', 'secret-fixture', { role: 'textbox', name: '密码', sensitive: true }),
      target: target({ role: 'textbox', name: '密码', tag: 'input', id: 'password', css: '#password', cssUnique: true }),
      observed: observedLines('(navigated: full snapshot)\n- 个人课表查询\n[e1] textbox "密码" = "[redacted]"'),
    });
    const file = readFileSync(join(dir, `${log.view().id}.jsonl`), 'utf8');
    expect(file).not.toContain('secret-fixture');
    expect(file).toContain('{{secret}}');
    expect(JSON.parse(file).observed).toEqual(['[e1] textbox "密码" = "[redacted]"']);
    const previous = log.view().id;
    log.clear();
    expect(log.view().steps).toEqual([]);
    expect(log.view().id).not.toBe(previous);
  });
});

describe('locator chain', () => {
  const query = item({ backend: 1, role: 'button', name: '查询', text: '查询' });
  const other = item({ backend: 2, role: 'button', name: '输出PDF', text: '输出PDF' });

  it('prefers an exact role and name, then css, then text, then a unique contains match', () => {
    expect(chooseLocator([query, other], { role: 'button', name: '查询', css: '#search_go', text: '查询' }, [9])).toEqual({
      locator: 'role_name',
      backend: 1,
    });
    expect(
      chooseLocator(
        [item({ backend: 3, role: 'button', name: '查询' }), item({ backend: 4, role: 'button', name: '查询' })],
        { role: 'button', name: '查询', css: '#search_go' },
        [8],
      ),
    ).toEqual({ locator: 'css', backend: 8 });
    expect(chooseLocator([query, other], { role: 'button', name: '不存在', text: '输出PDF' }, [])).toEqual({
      locator: 'text',
      backend: 2,
    });
    expect(
      chooseLocator(
        [
          item({ backend: 5, role: 'button', name: '查询甲', text: '查询' }),
          item({ backend: 7, role: 'button', name: '查询乙', text: '查询' }),
          item({ backend: 6, role: 'button', name: '课表', text: '课表' }),
        ],
        { role: 'button', name: '课', text: '查询' },
        [5, 7],
      ),
    ).toEqual({ locator: 'role_name_contains', backend: 6 });
    expect(chooseLocator([query], { role: 'button', name: '没有' }, [])).toBeNull();
  });

  it('uses css for a renamed combobox before a contains match', () => {
    const year = item({ backend: 11, role: 'combobox', name: '学年度', label: '学年度' });
    expect(chooseLocator([year], { role: 'combobox', name: '学年', css: '#xnm' }, [11])).toEqual({
      locator: 'css',
      backend: 11,
    });
  });

  it('ignores items in a different frame', () => {
    const framed = item({ backend: 7, role: 'link', name: '查看详情', frame: { name: 'notice', url: 'http://127.0.0.1/notice.html' } });
    const target = { role: 'link', name: '查看详情', frame: { name: 'other', url: 'http://127.0.0.1/other.html' } };
    expect(chooseLocator([framed], target)).toBeNull();
    expect(chooseLocator([framed], { ...target, frame: framed.frame })).toEqual({ locator: 'role_name', backend: 7 });
  });
});

describe('matrix and outcomes', () => {
  it('expands a cartesian product and maps broken to exit 30', () => {
    expect(expandMatrix({ year: ['2025-2026', '2026-2027'], term: ['1', '2'] }, { campus: 'main' })).toEqual([
      { campus: 'main', year: '2025-2026', term: '1' },
      { campus: 'main', year: '2025-2026', term: '2' },
      { campus: 'main', year: '2026-2027', term: '1' },
      { campus: 'main', year: '2026-2027', term: '2' },
    ]);
    expect(expandMatrix(undefined, { year: '2025-2026' })).toEqual([{ year: '2025-2026' }]);
    expect(expandMatrix({ year: ['b'] }, { year: 'a' })).toEqual([{ year: 'b' }]);
    expect(summaryExitCode([{ outcome: 'ok' }, { outcome: 'empty' }, { outcome: 'needs_human' }])).toBe(20);
    expect(summaryExitCode([{ outcome: 'ok' }, { outcome: 'broken' }])).toBe(30);
    expect(summaryExitCode([{ outcome: 'needs_human' }, { outcome: 'broken' }])).toBe(30);
    expect(() => expandMatrix({ term: [] })).toThrow(expect.objectContaining({ code: 'bad_params' }));
  });

  it('rejects secret, unknown, and missing placeholders before a run', () => {
    const secret: Skill = {
      name: 'pw-box',
      description: 'sign in',
      version: 1,
      start_url: 'http://127.0.0.1/',
      params: {},
      steps: [{ id: 's1-type', type: { target: { role: 'textbox', name: '密码' }, value: '{{secret}}' } }],
    };
    expect(() => bindSkill(secret, {})).toThrow(expect.objectContaining({ code: 'bad_params', message: expect.stringContaining('vault') }));

    const unknown: Skill = {
      ...secret,
      steps: [{ id: 's1-type', type: { target: { role: 'textbox', name: '用户名' }, value: '{{nope}}' } }],
    };
    expect(() => bindSkill(unknown, {})).toThrow(expect.objectContaining({ code: 'bad_params', message: expect.stringContaining('{{nope}}') }));

    const missing: Skill = {
      ...secret,
      params: { year: { type: 'string', example: '2025-2026' } },
      steps: [{ id: 's1-select', select: { target: { role: 'combobox', name: '学年' }, value: '{{year}}' } }],
    };
    expect(() => bindSkill(missing, {})).toThrow(expect.objectContaining({ code: 'bad_params', message: expect.stringContaining('year') }));
    expect(bindSkill(missing, { year: '2026-2027' }).steps[0]?.select?.value).toBe('2026-2027');
  });
});

describe('skill store', () => {
  it('keeps older versions across overwrite and rollback', () => {
    const root = mkdtempSync(join(tmpdir(), 'relaywright-skills-'));
    const skill = savedTimetable().skill;
    const first = writeSkill(skill, false, root);
    expect(first.version).toBe(1);
    expect(() => writeSkill(skill, false, root)).toThrow(expect.objectContaining({ code: 'skill_exists' }));
    const second = writeSkill({ ...skill, description: '下一版' }, true, root);
    expect(second.version).toBe(2);
    expect(skillHistory(skill.name, root)).toEqual({ name: skill.name, current: 2, versions: [1, 2] });
    expect(rollbackSkill(skill.name, 1, root).version).toBe(1);
    expect(readSkill(skill.name, undefined, root).skill.description).toBe(skill.description);
    expect(writeSkill(skill, true, root).version).toBe(3);
    expect(readSkill(skill.name, 2, root).skill.description).toBe('下一版');
    expect(listSkills(root).map((entry) => entry.name)).toEqual([skill.name]);
    expect(() => readSkill('missing-skill', undefined, root)).toThrow(expect.objectContaining({ code: 'skill_not_found' }));
    expect(() => writeSkill({ ...skill, name: 'Bad' }, false, root)).toThrow(expect.objectContaining({ code: 'bad_params' }));
  });
});

describe('download and pdf skills', () => {
  const confirm = target({ role: 'button', name: '确定', tag: 'button', id: 'pdf-ok', css: '#pdf-ok', cssUnique: true, text: '确定' });

  function exportTrace(fileName: string): TraceStep[] {
    return [
      traceStep({ n: 1, action: 'goto', value: PAGE, urlBefore: 'about:blank', urlAfter: PAGE }),
      traceStep({ n: 2, action: 'download', value: fileName, suggested: 'kb.pdf', target: confirm, timeout_ms: 1500 }),
      traceStep({ n: 3, action: 'pdf', value: 'page.pdf', landscape: true }),
    ];
  }

  it('rewrites an untemplated save_as and round-trips download and pdf steps', () => {
    const built = buildSkill(exportTrace('kb.pdf'), {
      name: 'zf-export',
      description: '导出课表 PDF',
      params: { year: '2025-2026', term: '2' },
    });
    expect(built.skill.steps.map((step) => step.id)).toEqual(['s1-download-确定', 's2-pdf']);
    expect(built.skill.steps[0]?.download).toEqual({
      click: { target: { role: 'button', name: '确定', css: '#pdf-ok', text: '确定' } },
      save_as: '{{year}}-{{term}}.pdf',
      timeout_ms: 1500,
    });
    expect(built.skill.steps[1]?.pdf).toEqual({ save_as: '{{year}}-{{term}}.pdf', landscape: true });
    expect(built.warnings).toEqual([
      's1-download-确定 save_as had no parameters; rewrote it to {{year}}-{{term}}.pdf so matrix runs do not collide',
      's2-pdf save_as had no parameters; rewrote it to {{year}}-{{term}}.pdf so matrix runs do not collide',
    ]);
    expect(parseSkill(stringifySkill(built.skill))).toEqual(built.skill);
  });

  it('templatizes a file name that already contains the examples', () => {
    const built = buildSkill(
      [
        traceStep({ n: 1, action: 'goto', value: PAGE, urlBefore: 'about:blank', urlAfter: PAGE }),
        traceStep({ n: 2, action: 'download', value: '2025-2026-2.pdf', suggested: 'kb.pdf', target: confirm }),
      ],
      {
        name: 'zf-export',
        description: '导出课表 PDF',
        params: { year: '2025-2026', term: '2' },
      },
    );
    expect(built.skill.steps[0]?.download?.save_as).toBe('{{year}}-{{term}}.pdf');
    expect(built.warnings.filter((warning) => warning.includes('rewrote'))).toEqual([]);
  });

  it('runs a download step, breaks on no_download, and skips it after an empty outcome', async () => {
    const skill: Skill = {
      name: 'zf-export',
      description: '导出课表 PDF',
      version: 1,
      start_url: PAGE,
      params: {
        year: { type: 'string', example: '2025-2026' },
        term: { type: 'string', example: '2' },
      },
      steps: [
        {
          id: 's1-expect',
          expect: {
            any: [
              { outcome: 'empty', when: { text_present: '尚无您的课表' }, message: '{{year}} 第{{term}}学期尚未排课' },
              { outcome: 'ok', when: { table_rows_min: 1 } },
            ],
          },
        },
        {
          id: 's2-download',
          download: {
            click: { target: { role: 'button', name: '确定' } },
            save_as: '{{year}}-{{term}}.pdf',
          },
        },
      ],
    };
    expect(parseSkill(stringifySkill(skill))).toEqual(skill);
    const out = mkdtempSync(join(tmpdir(), 'relaywright-skill-out-'));
    const params = { year: '2025-2026', term: '2' };

    const ok = fakeReplay({ text: '高等数学', begin: { id: 'g1', suggestedFilename: 'kb.pdf', url: PAGE } });
    const saved = await runSkill(ok.page, skill, params, { outDir: out });
    expect(saved.outcome).toBe('ok');
    expect(saved.artifacts).toEqual([
      { step_id: 's2-download', path: join(out, '2025-2026-2.pdf'), bytes: 12, sha256: 'abc' },
    ]);
    expect(ok.calls).toContain('click');
    expect(ok.calls).toContain('save:2025-2026-2.pdf');

    const missed = fakeReplay({ text: '高等数学', begin: null });
    const broken = await runSkill(missed.page, skill, params, { outDir: out });
    expect(broken.outcome).toBe('broken');
    expect(broken.broken?.reason).toBe('no_download');
    expect(broken.artifacts).toBeUndefined();
    expect(missed.calls).not.toContain('save:2025-2026-2.pdf');

    const empty = fakeReplay({ text: '该学年学期尚无您的课表', begin: { id: 'g2', suggestedFilename: 'kb.pdf', url: PAGE } });
    const skipped = await runSkill(empty.page, skill, params, { outDir: out });
    expect(skipped.outcome).toBe('empty');
    expect(skipped.message).toBe('2025-2026 第2学期尚未排课');
    expect(skipped.artifacts).toBeUndefined();
    expect(skipped.steps.find((step) => step.id === 's2-download')?.status).toBe('skipped');
    expect(empty.calls).not.toContain('click');
  });
});

function fakeReplay(options: { text: string; begin: ReplayDownload | null }): { page: ReplayPage; calls: string[] } {
  const calls: string[] = [];
  const page: ReplayPage = {
    navigate: async () => {
      calls.push('navigate');
      return { url: PAGE, title: 't', snapshot: '' };
    },
    capture: async () => ({
      items: [item({ backend: 4, role: 'button', name: '确定', text: '确定' })],
      tables: [{ name: '个人课表', rows: options.text.includes('尚无') ? 0 : 2 }],
      url: PAGE,
    }),
    currentUrl: () => PAGE,
    pageText: async () => options.text,
    queryCss: async () => [],
    hasVisiblePassword: async () => false,
    isPasswordBackend: async () => false,
    performBackend: async () => {
      calls.push('click');
    },
    performInput: async () => {
      calls.push('input');
    },
    waitFor: async () => ({ matched: true, url: PAGE, title: 't', snapshot: '' }),
    excerpt: async () => 'excerpt',
    markDownloads: () => {
      calls.push('mark');
      return 1;
    },
    releaseDownloads: () => {
      calls.push('release');
    },
    waitForDownloadBegin: async () => {
      calls.push('begin');
      return options.begin;
    },
    waitForDownloadComplete: async () => {
      calls.push('complete');
      return 'completed';
    },
    saveDownload: async (_download, dir, fileName) => {
      calls.push(`save:${fileName}`);
      return {
        deduped: false,
        file: { path: join(dir, fileName), name: fileName, bytes: 12, sha256: 'abc', url: PAGE },
      };
    },
    printPdf: async () => {
      throw new Error('pdf was not expected');
    },
  };
  return { page, calls };
}
