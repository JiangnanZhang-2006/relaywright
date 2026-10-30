import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relaywrightHome } from '../config/paths.js';
import { readGlobalConfig } from '../privacy/store.js';
import { join } from 'node:path';
export const INIT_HINT = 'tip: run relaywright init to choose browser mode, privacy and eval settings';
const SKIP = new Set(['mcp', 'init', 'doctor']);
/** One stderr line per day until init writes initialized_at. mcp, init, doctor, and --json stay quiet. */
export function maybePrintInitHint(command) {
    if (skipHint(command))
        return;
    const root = relaywrightHome();
    if (readGlobalConfig(root).initialized_at)
        return;
    const today = new Date().toISOString().slice(0, 10);
    const stamp = join(root, 'init-hint');
    try {
        if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === today)
            return;
    }
    catch {
        // A broken stamp should not hide the hint.
    }
    process.stderr.write(`${INIT_HINT}\n`);
    try {
        mkdirSync(root, { recursive: true });
        writeFileSync(stamp, `${today}\n`, 'utf8');
    }
    catch {
        // The hint was already printed.
    }
}
function skipHint(command) {
    for (let current = command; current; current = current.parent) {
        if (SKIP.has(current.name()))
            return true;
        if (current.getOptionValue('json') === true)
            return true;
    }
    return false;
}
//# sourceMappingURL=hint.js.map