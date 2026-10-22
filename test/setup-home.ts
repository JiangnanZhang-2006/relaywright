import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'relaywright-test-home-'));
process.env.RELAYWRIGHT_HOME = home;
if (!process.env.RELAYWRIGHT_HEADLESS) process.env.RELAYWRIGHT_HEADLESS = '1';

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
