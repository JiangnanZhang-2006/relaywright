import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configPath, privacyPath, readTextFile, relaywrightHome } from '../config/paths.js';
import { hostOfUrl, registrableDomain } from '../session/domain.js';
const EMPTY = () => ({
    self: {},
    rejections: [],
    allow: [],
    others: {},
    candidates: {},
    aliases: {},
    retired: {},
    next: {},
    categories: {},
});
export class PrivacyStore {
    root;
    constructor(root = relaywrightHome()) {
        this.root = root;
    }
    identityKey(url) {
        if (!url)
            return null;
        const host = hostOfUrl(url);
        if (!host)
            return null;
        return safeKey(registrableDomain(host));
    }
    globalMode() {
        return readConfig(this.root).privacy?.model_redaction === true;
    }
    setGlobalMode(on) {
        const config = readConfig(this.root);
        config.privacy = { ...(config.privacy ?? {}), model_redaction: on };
        writeJson(configPath(this.root), config);
    }
    read(identity) {
        const key = safeKey(identity);
        if (!key)
            return EMPTY();
        const path = privacyPath(key, this.root);
        if (!existsSync(path))
            return EMPTY();
        try {
            const parsed = JSON.parse(readTextFile(path));
            const next = { ...(parsed.next ?? {}) };
            const hadCounter = Object.prototype.hasOwnProperty.call(next, '候选');
            delete next['候选'];
            const hadCandidates = parsed.candidates != null && Object.keys(parsed.candidates).length > 0;
            const file = {
                ...EMPTY(),
                ...parsed,
                self: parsed.self ?? {},
                rejections: parsed.rejections ?? [],
                allow: parsed.allow ?? [],
                others: parsed.others ?? {},
                candidates: {},
                aliases: parsed.aliases ?? {},
                retired: parsed.retired ?? {},
                next,
                categories: {},
            };
            if (hadCandidates || hadCounter)
                this.write(key, file);
            return file;
        }
        catch {
            return EMPTY();
        }
    }
    write(identity, file) {
        const key = safeKey(identity);
        if (!key)
            return;
        const next = { ...file.next };
        delete next['候选'];
        const stored = { ...file, candidates: {}, next, categories: {} };
        writeJson(privacyPath(key, this.root), stored);
    }
}
export function safeKey(name) {
    const key = name.trim().toLowerCase().replace(/:/g, '_');
    if (!key || key === '.' || key === '..' || key.includes('..'))
        return null;
    if (!/^[\w.-]+$/.test(key))
        return null;
    return key;
}
export function readGlobalConfig(root = relaywrightHome()) {
    return readConfig(root);
}
export function updateGlobalConfig(mutate, root = relaywrightHome()) {
    const config = readConfig(root);
    mutate(config);
    writeJson(configPath(root), config);
    return config;
}
function migrateBrowserMode(config) {
    const mode = config.browser?.mode;
    if (mode !== 'own' && mode !== 'attach')
        return false;
    config.browser = { ...config.browser, mode: mode === 'own' ? 'separate' : 'daily' };
    return true;
}
function readConfig(root) {
    const path = configPath(root);
    if (!existsSync(path))
        return {};
    try {
        const parsed = JSON.parse(readTextFile(path));
        if (!parsed || typeof parsed !== 'object')
            return {};
        if (migrateBrowserMode(parsed)) {
            try {
                writeJson(path, parsed);
            }
            catch {
                // The caller still sees the new mode name. The next successful write stores it.
            }
        }
        return parsed;
    }
    catch {
        return {};
    }
}
function writeJson(path, value) {
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
        chmodSync(tmp, 0o600);
    }
    catch {
        // Windows may refuse the mode. The file is still the user's own local data.
    }
    try {
        renameSync(tmp, path);
    }
    catch (err) {
        const code = err.code;
        if (code !== 'EPERM' && code !== 'EEXIST') {
            rmSync(tmp, { force: true });
            throw err;
        }
        rmSync(path, { force: true });
        renameSync(tmp, path);
    }
    try {
        chmodSync(path, 0o600);
    }
    catch {
        // Same as the temp file: best effort.
    }
}
//# sourceMappingURL=store.js.map