import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'relaywright-test-home-'));
process.env.RELAYWRIGHT_HOME = home;
if (!process.env.RELAYWRIGHT_HEADLESS) process.env.RELAYWRIGHT_HEADLESS = '1';
process.env.RELAYWRIGHT_NOTIFY = '0';
// The daemon inherits this. Test-only access overrides stay off when it is absent.
if (!process.env.VITEST) process.env.VITEST = 'true';

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
