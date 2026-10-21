import { describe, expect, it } from 'vitest';
import { matchOption, optionMissMessage } from '../src/actions/match-option.js';

const years = [
  { value: '', text: '---请选择---' },
  { value: '2026', text: '2026-2027' },
  { value: '2025', text: '2025-2026' },
  { value: '2024', text: '2024-2025' },
];

const terms = [
  { value: '', text: '---请选择---' },
  { value: '3', text: '1' },
  { value: '12', text: '2' },
  { value: '16', text: '3' },
];

describe('matchOption', () => {
  it('matches option text exactly before the value attribute', () => {
    expect(matchOption(terms, '2')).toEqual({ ok: true, option: { value: '12', text: '2' } });
    expect(matchOption(years, '2025-2026')).toEqual({ ok: true, option: { value: '2025', text: '2025-2026' } });
  });

  it('compacts whitespace, then accepts a unique substring, then the value attribute', () => {
    expect(matchOption([{ value: '1', text: ' 高等 数学 ' }], '高等 数学').ok).toBe(true);
    expect(matchOption(years, '2024-2025')).toEqual({ ok: true, option: { value: '2024', text: '2024-2025' } });
    expect(matchOption(terms, '12')).toEqual({ ok: true, option: { value: '12', text: '2' } });
  });

  it('rejects ambiguous substrings and unknown text', () => {
    expect(matchOption(years, '2025').ok).toBe(false);
    expect(matchOption(years, '1999-2000')).toEqual({ ok: false, kind: 'none' });
    const message = optionMissMessage('1999-2000', years);
    expect(message).toContain('1999-2000');
    expect(message).toContain('2026-2027');
    expect(message.split(',').length).toBeLessThanOrEqual(10);
  });
});
