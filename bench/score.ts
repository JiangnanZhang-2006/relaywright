import type { DuplicateExport, ExportPost, RunScore } from './types.js';

const EXPECTED: Array<Pick<ExportPost, 'year' | 'term'>> = [
  { year: '2025-2026', term: '1' },
  { year: '2025-2026', term: '2' },
  { year: '2026-2027', term: '1' },
];

const EMPTY_TERM = { year: '2026-2027', term: '2' };

export function parseExportBody(body: string): ExportPost {
  const params = new URLSearchParams(body);
  return {
    year: params.get('year') ?? '',
    term: params.get('term') ?? '',
    layout: params.get('layout') ?? '',
  };
}

export function mentionsEmptyTerm(answer: string): boolean {
  if (!answer.includes(EMPTY_TERM.year)) return false;
  if (!/第\s*2\s*学期|第二学期|学期\s*2/.test(answer)) return false;
  return /没有|尚无|未导出|为空|无课表/.test(answer);
}

function keyOf(post: Pick<ExportPost, 'year' | 'term'>): string {
  return `${post.year}\t${post.term}`;
}

function isExpected(post: Pick<ExportPost, 'year' | 'term'>): boolean {
  return EXPECTED.some((item) => item.year === post.year && item.term === post.term);
}

/** Portrait posts of the three scheduled terms count. Duplicates of those are allowed. */
export function scoreRun(exports: readonly ExportPost[], answer: string): RunScore {
  const counts = new Map<string, number>();
  const extra: ExportPost[] = [];
  let emptyExported = false;
  for (const post of exports) {
    if (post.year === EMPTY_TERM.year && post.term === EMPTY_TERM.term) {
      emptyExported = true;
      extra.push(post);
      continue;
    }
    if (!isExpected(post) || post.layout !== 'portrait') {
      extra.push(post);
      continue;
    }
    const key = keyOf(post);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const missing = EXPECTED.filter((item) => (counts.get(keyOf(item)) ?? 0) === 0);
  const duplicates: DuplicateExport[] = EXPECTED.filter((item) => (counts.get(keyOf(item)) ?? 0) > 1).map((item) => ({
    year: item.year,
    term: item.term,
    layout: 'portrait',
    count: counts.get(keyOf(item)) ?? 0,
  }));
  const emptyReported = mentionsEmptyTerm(answer);
  const success = missing.length === 0 && extra.length === 0 && !emptyExported && emptyReported;
  return { success, duplicates, extra, missing, emptyReported, emptyExported };
}
