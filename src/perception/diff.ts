const REF_LINE = /^\[(e\d+)\]/;

export function splitSnapshot(text: string): { header: string; body: string[] } {
  const lines = text.split('\n');
  return { header: lines[0] ?? '', body: lines.slice(1) };
}

/**
 * Ref lines match by ref. Everything else (headings, table rows, frame markers)
 * matches by exact text with multiset semantics.
 * Order: additions and changes in current order, then removals in baseline order.
 */
export function diffLines(baseline: readonly string[], current: readonly string[]): string[] {
  const baseRef = new Map<string, string>();
  const baseNonRefCount = new Map<string, number>();
  for (const line of baseline) {
    const ref = REF_LINE.exec(line)?.[1];
    if (ref) baseRef.set(ref, line);
    else baseNonRefCount.set(line, (baseNonRefCount.get(line) ?? 0) + 1);
  }

  const currentRefs = new Set<string>();
  const currentNonRefSeen = new Map<string, number>();
  const changes: string[] = [];

  for (const line of current) {
    const ref = REF_LINE.exec(line)?.[1];
    if (ref) {
      currentRefs.add(ref);
      const previous = baseRef.get(ref);
      if (previous === undefined) changes.push(`+ ${line}`);
      else if (previous !== line) changes.push(`~ ${line}`);
      continue;
    }
    const seen = (currentNonRefSeen.get(line) ?? 0) + 1;
    currentNonRefSeen.set(line, seen);
    if (seen > (baseNonRefCount.get(line) ?? 0)) changes.push(`+ ${line}`);
  }

  const removedNonRef = new Map<string, number>();
  for (const [line, count] of baseNonRefCount) {
    const extra = count - (currentNonRefSeen.get(line) ?? 0);
    if (extra > 0) removedNonRef.set(line, extra);
  }
  for (const line of baseline) {
    const ref = REF_LINE.exec(line)?.[1];
    if (ref) {
      if (!currentRefs.has(ref)) changes.push(`- ${line}`);
      continue;
    }
    const left = removedNonRef.get(line) ?? 0;
    if (left > 0) {
      changes.push(`- ${line}`);
      removedNonRef.set(line, left - 1);
    }
  }
  return changes;
}

export function formatDiff(header: string, baseline: readonly string[], current: readonly string[]): string {
  const changes = diffLines(baseline, current);
  if (changes.length === 0) return `${header}\n(no changes)`;
  return [header, ...changes].join('\n');
}

export function renderSnapshotMode(options: {
  mode: 'full' | 'diff';
  fullText: string;
  baseline: readonly string[] | null;
  navigated: boolean;
}): { text: string; baseline: string[] } {
  const { header, body } = splitSnapshot(options.fullText);
  if (options.mode === 'diff' && options.navigated) {
    return { text: `(navigated: full snapshot)\n${options.fullText}`, baseline: body };
  }
  if (options.mode === 'diff' && options.baseline) {
    return { text: formatDiff(header, options.baseline, body), baseline: body };
  }
  return { text: options.fullText, baseline: body };
}
