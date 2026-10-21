import { describe, expect, it } from 'vitest';
import { normalizeActArgs } from '../src/cli/act-args.js';

describe('normalizeActArgs', () => {
  it('keeps click, select, and type in positional order', () => {
    expect(normalizeActArgs('click', 'e3')).toEqual({ action: 'click', ref: 'e3', value: undefined, key: undefined });
    expect(normalizeActArgs('select', 'e1', '2025-2026')).toMatchObject({ action: 'select', ref: 'e1', value: '2025-2026' });
    expect(normalizeActArgs('type', 'e5', '张三', 'Enter')).toMatchObject({ ref: 'e5', value: '张三', key: 'Enter' });
  });

  it('treats a bare scroll direction or press key as the value', () => {
    expect(normalizeActArgs('scroll', 'down')).toEqual({ action: 'scroll', ref: undefined, value: 'down', key: undefined });
    expect(normalizeActArgs('scroll', 'e3')).toMatchObject({ ref: 'e3', value: undefined });
    expect(normalizeActArgs('press', 'Enter')).toEqual({ action: 'press', ref: undefined, value: undefined, key: 'Enter' });
    expect(normalizeActArgs('press', 'e3', 'Enter')).toMatchObject({ ref: 'e3', key: 'Enter' });
  });
});
