import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export function relaywrightHome() {
    const override = process.env.RELAYWRIGHT_HOME?.trim();
    if (override)
        return override;
    return join(homedir(), '.relaywright');
}
export function daemonJsonPath() {
    return join(relaywrightHome(), 'daemon.json');
}
export function daemonLockPath() {
    return join(relaywrightHome(), 'daemon.lock');
}
export function logsDir() {
    return join(relaywrightHome(), 'logs');
}
export function daemonLogPath() {
    return join(logsDir(), 'daemon.log');
}
export function profilesDir() {
    return join(relaywrightHome(), 'profiles');
}
export function defaultProfileDir() {
    return join(profilesDir(), 'default');
}
export function browsersDir() {
    return join(relaywrightHome(), 'browsers');
}
export function tracesDir() {
    return join(relaywrightHome(), 'traces');
}
export function skillsDir() {
    return join(relaywrightHome(), 'skills');
}
export function downloadsDir() {
    return join(relaywrightHome(), 'downloads');
}
export function downloadsStagingDir() {
    return join(downloadsDir(), '.staging');
}
export function identitiesDir() {
    return join(relaywrightHome(), 'identities');
}
export function identityPath(name) {
    return join(identitiesDir(), `${name}.json`);
}
export function auditDir() {
    return join(relaywrightHome(), 'audit');
}
export function configPath(root = relaywrightHome()) {
    return join(root, 'config.json');
}
export function privacyDir(root = relaywrightHome()) {
    return join(root, 'privacy');
}
export function stateDir(root = relaywrightHome()) {
    return join(root, 'state');
}
export function privacyPath(identity, root = relaywrightHome()) {
    return join(privacyDir(root), `${identity}.json`);
}
export function ensureHomeLayout() {
    mkdirSync(logsDir(), { recursive: true });
    mkdirSync(defaultProfileDir(), { recursive: true });
    mkdirSync(browsersDir(), { recursive: true });
    mkdirSync(tracesDir(), { recursive: true });
    mkdirSync(skillsDir(), { recursive: true });
    mkdirSync(downloadsStagingDir(), { recursive: true });
    mkdirSync(identitiesDir(), { recursive: true });
    mkdirSync(auditDir(), { recursive: true });
    mkdirSync(privacyDir(), { recursive: true });
    mkdirSync(stateDir(), { recursive: true });
}
let cachedVersion;
export function packageVersion() {
    if (cachedVersion)
        return cachedVersion;
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    cachedVersion = pkg.version ?? '0.0.0';
    return cachedVersion;
}
/** Files edited by hand on Windows (Notepad, PowerShell 5 `-Encoding utf8`) often start with a BOM. */
export function readTextFile(path) {
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
}
export function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
/** Append-only daemon log. Must never throw into a request path or the MCP stdio stream. */
export function logDaemon(message) {
    try {
        mkdirSync(logsDir(), { recursive: true });
        appendFileSync(daemonLogPath(), `${new Date().toISOString()} ${message}\n`, 'utf8');
    }
    catch {
        // A full disk should not take down the daemon or corrupt MCP stdout.
    }
}
//# sourceMappingURL=paths.js.map