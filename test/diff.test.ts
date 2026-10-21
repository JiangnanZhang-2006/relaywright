import { describe, expect, it } from 'vitest';
import { diffLines } from '../src/perception/diff.js';

describe('diffLines', () => {
  it('returns nothing when the lines match', () => {
    const lines = ['[e1] button "查询"', 'h3 "标题"'];
    expect(diffLines(lines, lines)).toEqual([]);
  });

  it('marks a changed ref with a tilde and ignores identical refs', () => {
    const changes = diffLines(
      ['[e1] combobox "学年" = "2026-2027"', '[e2] button "查询"'],
      ['[e1] combobox "学年" = "2025-2026"', '[e2] button "查询"'],
    );
    expect(changes).toEqual(['~ [e1] combobox "学年" = "2025-2026"']);
  });

  it('adds and removes ref lines', () => {
    expect(diffLines(['[e1] button "旧"'], ['[e2] button "新"'])).toEqual(['+ [e2] button "新"', '- [e1] button "旧"']);
  });

  it('diffs non-ref lines as a multiset', () => {
    expect(diffLines(['h1 "A"', 'h1 "A"', 'status "首页"'], ['h1 "A"', 'status "信息查询"'])).toEqual([
      '+ status "信息查询"',
      '- h1 "A"',
      '- status "首页"',
    ]);
  });

  it('ignores reordering of identical non-ref lines', () => {
    expect(diffLines(['h1 "A"', 'h2 "B"'], ['h2 "B"', 'h1 "A"'])).toEqual([]);
  });
});
