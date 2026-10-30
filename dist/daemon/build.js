import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Absolute path of the daemon entry this module would spawn (`main.ts` or `main.js`). */
export function daemonEntryPath(moduleUrl = import.meta.url) {
    const selfPath = fileURLToPath(moduleUrl);
    const entryName = selfPath.endsWith('.ts') ? 'main.ts' : 'main.js';
    return resolve(dirname(selfPath), entryName);
}
export function readBuildFingerprint(moduleUrl = import.meta.url) {
    const entry = daemonEntryPath(moduleUrl);
    return { entry, builtAt: statSync(entry).mtime.toISOString() };
}
export function sameBuild(left, right) {
    return left.entry === right.entry && left.builtAt === right.builtAt;
}
/**
 * Mismatch does not restart the daemon: that would close the user's browser.
 * `health` is the fingerprint the process captured at startup. `stored` is `daemon.json`,
 * which a hand edit can change without touching the running process.
 */
export function formatBuildMismatch(expected, health, stored) {
    if (!health && !stored) {
        return `relaywright: warning: running daemon did not report a build fingerprint; this CLI is ${expected.entry}. Run: relaywright daemon restart`;
    }
    const healthDiff = Boolean(health && !sameBuild(health, expected));
    const storedDiff = Boolean(stored && !sameBuild(stored, expected));
    if (!healthDiff && !storedDiff)
        return null;
    const shown = healthDiff ? health : stored;
    if (!shown)
        return null;
    return `relaywright: warning: running daemon is from ${shown.entry} (built ${shown.builtAt}); this CLI is ${expected.entry}. Run: relaywright daemon restart`;
}
export function explainDaemonError(message, status, code, warning) {
    if (status === 404 && code === 'not_found' && warning)
        return `${message}\n${warning}`;
    return message;
}
//# sourceMappingURL=build.js.map