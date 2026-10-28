import { describe, expect, it } from 'vitest';
import { aggregate, median } from '../bench/report.js';
import { mentionsEmptyTerm, parseExportBody, scoreRun } from '../bench/score.js';
import { redactSecrets } from '../bench/redact.js';
import { withoutLoginBox } from '../bench/server.js';
import { readFileSync } from 'node:fs';

const portrait = (year: string, term: string) => ({ year, term, layout: 'portrait' });
const ANSWER = '已导出三个学期。2026-2027 学年第2学期没有课表，未导出。';

describe('bench scoring', () => {
  it('parses an export form body', () => {
    expect(parseExportBody('year=2025-2026&term=1&layout=portrait')).toEqual(portrait('2025-2026', '1'));
  });

  it('passes the three scheduled terms plus an empty-term report', () => {
    const score = scoreRun([portrait('2025-2026', '1'), portrait('2025-2026', '2'), portrait('2026-2027', '1')], ANSWER);
    expect(score).toMatchObject({ success: true, missing: [], extra: [], emptyReported: true, emptyExported: false });
  });

  it('allows duplicates but reports them', () => {
    const score = scoreRun(
      [portrait('2025-2026', '1'), portrait('2025-2026', '1'), portrait('2025-2026', '2'), portrait('2026-2027', '1')],
      ANSWER,
    );
    expect(score.success).toBe(true);
    expect(score.duplicates).toEqual([{ year: '2025-2026', term: '1', layout: 'portrait', count: 2 }]);
  });

  it('fails when the empty term is exported, a term is missing, or the layout is wrong', () => {
    const all = [portrait('2025-2026', '1'), portrait('2025-2026', '2'), portrait('2026-2027', '1')];
    expect(scoreRun([...all, portrait('2026-2027', '2')], ANSWER)).toMatchObject({ success: false, emptyExported: true });
    expect(scoreRun(all.slice(1), ANSWER).missing).toEqual([{ year: '2025-2026', term: '1' }]);
    expect(scoreRun([...all.slice(1), { year: '2025-2026', term: '1', layout: 'landscape' }], ANSWER).success).toBe(false);
  });

  it('fails when the answer does not name the empty term', () => {
    const all = [portrait('2025-2026', '1'), portrait('2025-2026', '2'), portrait('2026-2027', '1')];
    expect(scoreRun(all, '全部导出完成。').success).toBe(false);
    expect(mentionsEmptyTerm('2026-2027 学年第二学期尚无课表')).toBe(true);
    expect(mentionsEmptyTerm('2026-2027 学年第1学期已导出')).toBe(false);
  });
});

describe('bench server', () => {
  it('removes the fixture login form from both page versions', () => {
    for (const version of ['v1', 'v3']) {
      const html = readFileSync(new URL(`../fixtures/zf-mock/${version}/index.html`, import.meta.url), 'utf8');
      const served = withoutLoginBox(html);
      expect(served).not.toContain('type="password"');
      expect(served).toContain('输出PDF');
    }
  });
});

describe('bench report', () => {
  it('computes medians and per-tool aggregates', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    const rows = aggregate([
      { tool: 'a', kind: 'first', promptTokens: 900, completionTokens: 100, success: true },
      { tool: 'a', kind: 'repeat', promptTokens: 10, completionTokens: 0, success: true },
      { tool: 'a', kind: 'repeat', promptTokens: 30, completionTokens: 0, success: false },
      { tool: 'a', kind: 'redesign', promptTokens: 400, completionTokens: 60, success: true },
    ]);
    expect(rows).toEqual([
      { tool: 'a', runs: 4, firstTokens: 1000, medianRepeatTokens: 20, redesignTokens: 460, totalTokens: 1500, successRate: 0.75 },
    ]);
  });

  it('strips keys and bearer tokens', () => {
    expect(redactSecrets('Bearer abc.def failed with sk-1234567890abcdef', 'xyz')).toBe('Bearer [redacted] failed with [redacted]');
    expect(redactSecrets('token xyz-secret here', 'xyz-secret')).toBe('token [redacted] here');
  });
});
