import { describe, expect, it } from 'vitest';
import { needsNameShim } from '../src/session/page.js';

describe('needsNameShim', () => {
  it('is on for TypeScript sources and tsx, and off for compiled javascript', () => {
    expect(needsNameShim('file:///C:/proj/src/session/page.ts')).toBe(true);
    expect(needsNameShim('file:///C:/proj/src/session/page.ts?t=1')).toBe(true);
    expect(needsNameShim('file:///C:/proj/src/session/page.mts')).toBe(true);
    expect(needsNameShim('file:///C:/proj/dist/session/page.js')).toBe(false);
    expect(needsNameShim('file:///C:/proj/dist/session/page.js', ['C:/proj/node_modules/vitest/dist/cli.js'])).toBe(false);
    expect(needsNameShim('file:///C:/proj/dist/session/page.js', ['C:/proj/node_modules/tsx/dist/cli.mjs'])).toBe(true);
    expect(needsNameShim('/opt/app/dist/page.js', ['/opt/app/mytsx/bin/node'])).toBe(false);
  });
});
