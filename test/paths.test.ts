import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTextFile } from '../src/config/paths.js';

describe('readTextFile', () => {
  it('strips a leading UTF-8 BOM', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rw-paths-')), 'checks.json');
    writeFileSync(path, '\uFEFF[{"a":1}]', 'utf8');
    expect(JSON.parse(readTextFile(path))).toEqual([{ a: 1 }]);
  });
});
