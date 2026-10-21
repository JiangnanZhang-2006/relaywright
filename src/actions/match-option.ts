import { RelayError } from '../errors.js';
import type { SelectOption } from '../perception/snapshot.js';

export type OptionMatch =
  | { ok: true; option: SelectOption }
  | { ok: false; kind: 'none' | 'ambiguous' };

export function matchOption(options: readonly SelectOption[], query: string): OptionMatch {
  const exact = options.filter((option) => option.text === query);
  if (exact.length === 1) return { ok: true, option: exact[0]! };
  if (exact.length > 1) return { ok: false, kind: 'ambiguous' };

  const wanted = compact(query);
  const compacted = options.filter((option) => compact(option.text) === wanted);
  if (compacted.length === 1) return { ok: true, option: compacted[0]! };
  if (compacted.length > 1) return { ok: false, kind: 'ambiguous' };

  if (wanted) {
    const partial = options.filter((option) => compact(option.text).includes(wanted));
    if (partial.length === 1) return { ok: true, option: partial[0]! };
    if (partial.length > 1) return { ok: false, kind: 'ambiguous' };
  }

  const byValue = options.filter((option) => option.value === query);
  if (byValue.length === 1) return { ok: true, option: byValue[0]! };
  if (byValue.length > 1) return { ok: false, kind: 'ambiguous' };
  return { ok: false, kind: 'none' };
}

export function optionMissMessage(query: string, options: readonly SelectOption[]): string {
  const texts = options
    .map((option) => compact(option.text))
    .filter((text) => text.length > 0)
    .slice(0, 10);
  return `No option matching ${JSON.stringify(query)}. Options: ${texts.join(', ')}`;
}

export function optionMiss(query: string, options: readonly SelectOption[]): RelayError {
  return new RelayError('no_such_option', optionMissMessage(query, options));
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
