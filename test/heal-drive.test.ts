import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeHeal } from '../src/healer/complete.js';
import { runSkillWithHeal } from '../src/healer/drive.js';
import { patchSkill, runSkill } from '../src/daemon/client.js';
import type { SkillRunResult } from '../src/skills/schema.js';

vi.mock('../src/daemon/client.js', () => ({
  runSkill: vi.fn(),
  patchSkill: vi.fn(),
}));

vi.mock('../src/healer/complete.js', () => ({
  completeHeal: vi.fn(),
}));

const run = vi.mocked(runSkill);
const patch = vi.mocked(patchSkill);
const heal = vi.mocked(completeHeal);

const finished: SkillRunResult = {
  outcome: 'ok',
  params: { year: '2025-2026', term: '1' },
  steps: [
    { id: 's1-select-学年', status: 'done', ms: 1 },
    { id: 's2-select-学期', status: 'done', ms: 1 },
    { id: 's3-click-查询', status: 'done', ms: 1 },
    { id: 's4-click-输出PDF', status: 'done', ms: 1 },
    { id: 's5-download-确定', status: 'done', ms: 1 },
  ],
  duration_ms: 5,
  artifacts: [{ step_id: 's5-download-确定', path: 'out/2025-2026-1.pdf', bytes: 8, sha256: 'a'.repeat(64) }],
};

describe('heal drive', () => {
  const previous = process.env.DEEPSEEK_API_KEY;

  afterEach(() => {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
    run.mockReset();
    patch.mockReset();
    heal.mockReset();
  });

  it('keeps the patched combination and reruns only later ones', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    heal.mockResolvedValue({ ref: 'e4', reason: '检索', prompt: 11, completion: 7 });
    run.mockImplementation(async (_name, input) => {
      if (input.params) {
        return {
          results: [
            {
              outcome: 'ok',
              params: input.params,
              steps: finished.steps,
              duration_ms: 4,
              artifacts: [{ step_id: 's5-download-确定', path: `out/${input.params.year}-${input.params.term}.pdf`, bytes: 8, sha256: 'b'.repeat(64) }],
            },
          ],
          exit_code: 0,
          out_dir: 'out',
        };
      }
      return {
        results: [
          {
            outcome: 'broken',
            params: { year: '2025-2026', term: '1' },
            steps: [
              { id: 's1-select-学年', status: 'done', ms: 1 },
              { id: 's2-select-学期', status: 'done', ms: 1 },
              { id: 's3-click-查询', status: 'failed', ms: 1 },
            ],
            duration_ms: 3,
            halt_matrix: true,
            broken: {
              step_id: 's3-click-查询',
              reason: 'target_not_found',
              excerpt: '',
              heal: {
                name: 'zf-pdf-heal',
                version: 1,
                step_id: 's3-click-查询',
                kind: 'click',
                reason: 'target_not_found',
                url: 'http://127.0.0.1/zf-mock/v3/',
                params: { year: '2025-2026', term: '1' },
                snapshot: '[e4] button "检索"',
                heal_token: 'abc',
              },
            },
          },
          {
            outcome: 'skipped',
            message: 'skipped because an earlier combination is broken',
            params: { year: '2026-2027', term: '1' },
            steps: [],
            duration_ms: 0,
          },
        ],
        exit_code: 30,
        out_dir: 'out',
      };
    });
    patch.mockResolvedValue({
      accepted: true,
      name: 'zf-pdf-heal',
      step_id: 's3-click-查询',
      from_version: 1,
      to_version: 2,
      outcome: 'ok',
      result: finished,
      remaining_params: [{ year: '2026-2027', term: '1' }],
    });

    const healed = await runSkillWithHeal(
      'zf-pdf-heal',
      { matrix: { year: ['2025-2026', '2026-2027'], term: ['1'] }, out_dir: 'out' },
      { heal: true },
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[1]).toMatchObject({ params: { year: '2026-2027', term: '1' }, out_dir: 'out', continue_heal: true });
    expect(healed.report.results.map((result) => result.params)).toEqual([
      { year: '2025-2026', term: '1' },
      { year: '2026-2027', term: '1' },
    ]);
    expect(healed.report.results[0]?.steps.filter((step) => step.status === 'done')).toHaveLength(5);
    expect(healed.report.results[0]?.artifacts?.map((artifact) => artifact.path)).toEqual(['out/2025-2026-1.pdf']);
    expect(healed.report.results.map((result) => result.outcome)).toEqual(['ok', 'ok']);
  });
});
