import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { whichBrowser } from '../../src/browser/resolve.js';
import { BrowserSession } from '../../src/session/browser.js';
import { startStatic } from './static-server.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resolved = await whichBrowser();

describe.skipIf(!resolved.path)('a skill that loops over repeated row controls', () => {
  let server: { port: number; close: () => Promise<void> } | undefined;
  let session: BrowserSession | undefined;
  let list = '';

  beforeAll(async () => {
    process.env.RELAYWRIGHT_HOME = mkdtempSync(join(tmpdir(), 'relaywright-rows-e2e-'));
    server = await startStatic(join(repoRoot, 'fixtures'));
    list = `http://127.0.0.1:${server.port}/ict-mock/problems.html`;
    session = new BrowserSession();
  });

  afterAll(async () => {
    await session?.close();
    await server?.close();
  });

  it('records the row, saves it as a row anchor, and replays each row in a new tab', async () => {
    if (!session) throw new Error('rows e2e did not start');
    const browser = session;
    const opened = await browser.navigate(list);
    const refs = [...opened.snapshot.matchAll(/\[(e\d+)\] link "去做题"/g)].map((match) => match[1]);
    expect(refs).toHaveLength(12);
    const fourth = refs[3];
    if (!fourth) throw new Error('row 4 has no ref');

    const clicked = await browser.act({ action: 'click', ref: fourth });
    expect(clicked.snapshot).toContain(`${fourth} is 4 of 12 link "去做题" in row "赛题4：5分钟极速建站体验`);
    expect(clicked.snapshot).toContain('实验编号4号');
    if (!clicked.step) throw new Error('click was not recorded');
    expect(browser.trace().steps.at(-1)?.target).toMatchObject({ nth: 4, peers: 12 });

    const saved = browser.saveSkill({
      name: 'ict-lab-status',
      description: '打开第 n 题的去做题，判断能否开始实验',
      params: { n: '4' },
      checks: [
        {
          after_step: clicked.step,
          any: [
            { outcome: 'ok', when: { text_present: '实验编号{{n}}号' } },
            { outcome: 'empty', when: { text_present: '该实验维护中' }, message: '赛题{{n}} 维护中' },
          ],
        },
      ],
    });
    expect(saved.yaml).toContain('within: 赛题{{n}}');
    expect(saved.yaml).not.toContain('nth-of-type');

    const report = await browser.runSkill('ict-lab-status', { matrix: { n: ['1', '3', '5', '10', '12'] } });
    const outcomes = Object.fromEntries(report.results.map((result) => [result.params.n, result.outcome]));
    expect(outcomes).toEqual({ '1': 'ok', '3': 'empty', '5': 'empty', '10': 'ok', '12': 'ok' });
    expect(report.results.find((result) => result.params.n === '3')?.message).toBe('赛题3 维护中');
    const clickStep = report.results[0]?.steps.find((step) => step.id.includes('click'));
    expect(clickStep).toMatchObject({ status: 'done', locator: 'row' });
  });
});
