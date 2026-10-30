import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { downloadsStagingDir, errorText, logDaemon, readTextFile } from '../config/paths.js';
import { activeDownloadsDir } from '../config/runtime.js';
import { RelayError } from '../errors.js';
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const NAME_LIMIT = 150;
const COMPLETE_TIMEOUT_MS = 120_000;
export const PRINT_REQUESTED_LINE = '(print requested: the page called window.print(); use browser_pdf to save it as PDF)';
/** Last suffix that looks like a file extension, otherwise empty. */
export function fileExtension(name) {
    const base = name.split(/[/\\]/).pop() ?? name;
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1)
        return '';
    const ext = base.slice(dot);
    if (!/^\.[A-Za-z0-9]{1,16}$/.test(ext))
        return '';
    return ext;
}
export function sanitizeFilename(input) {
    let name = input.replace(INVALID_CHARS, '_').replace(/[. ]+$/g, '');
    if (RESERVED.test(name))
        name = `_${name}`;
    if (name === '.' || name === '..')
        name = 'download';
    if (name.length > NAME_LIMIT) {
        const ext = fileExtension(name);
        let base = name.slice(0, NAME_LIMIT - ext.length).replace(/[. ]+$/g, '');
        if (!base)
            base = 'download';
        name = `${base}${ext}`;
        if (name.length > NAME_LIMIT)
            name = name.slice(0, NAME_LIMIT).replace(/[. ]+$/g, '') || 'download';
        if (RESERVED.test(name))
            name = `_${name}`.slice(0, NAME_LIMIT);
    }
    return name || 'download';
}
/** User-supplied save_as is a single file name. Suggested names from Chrome are sanitized instead. */
export function assertSaveAs(name) {
    if (!name.trim() || name.includes('/') || name.includes('\\') || name.includes('..')) {
        throw new RelayError('bad_params', `save_as must be a file name without directories: ${name}`);
    }
}
export function allocateFilename(dir, fileName) {
    const safe = sanitizeFilename(fileName);
    const ext = fileExtension(safe);
    const base = safe.slice(0, safe.length - ext.length);
    if (!existsSync(join(dir, safe)))
        return { name: safe, deduped: false };
    for (let n = 1; n < 1000; n += 1) {
        const candidate = `${base} (${n})${ext}`;
        if (!existsSync(join(dir, candidate)))
            return { name: candidate, deduped: true };
    }
    throw new RelayError('bad_params', `No free file name for ${safe}`);
}
export function stripDownloadUrl(raw) {
    try {
        const url = new URL(raw);
        url.search = '';
        url.hash = '';
        return url.toString();
    }
    catch {
        const hash = raw.indexOf('#');
        const noHash = hash >= 0 ? raw.slice(0, hash) : raw;
        const query = noHash.indexOf('?');
        return query >= 0 ? noHash.slice(0, query) : noHash;
    }
}
export function humanSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1024)
        return `${Math.max(0, Math.round(bytes))} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 'KB';
    for (let index = 0; index < units.length; index += 1) {
        unit = units[index] ?? unit;
        if (value < 1024 || index === units.length - 1)
            break;
        value /= 1024;
    }
    return `${(Math.round(value * 10) / 10).toFixed(1)} ${unit}`;
}
export function downloadLine(info) {
    return `(downloaded: ${info.name} ${humanSize(info.bytes)} -> ${info.path})`;
}
export function canceledLine(name) {
    return `(download canceled: ${sanitizeFilename(name)})`;
}
export function hashFile(path) {
    return new Promise((resolveHash, rejectHash) => {
        const hash = createHash('sha256');
        const stream = createReadStream(path);
        stream.on('error', rejectHash);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolveHash(hash.digest('hex')));
    });
}
/**
 * Move a finished file into dir. allowAndName leaves the bytes under the download guid;
 * rename fails across volumes, so fall back to copy and unlink.
 */
export async function publishDownload(options) {
    mkdirSync(options.dir, { recursive: true });
    const requested = sanitizeFilename(options.fileName);
    const allocated = options.dedupe
        ? allocateFilename(options.dir, requested)
        : { name: requested, deduped: false };
    const root = resolve(options.dir);
    const dest = resolve(options.dir, allocated.name);
    if (dest !== root && !dest.startsWith(root + sep)) {
        throw new RelayError('bad_params', `save_as escapes the output directory: ${options.fileName}`);
    }
    await moveFile(options.sourcePath, dest);
    const info = {
        path: dest,
        name: allocated.name,
        bytes: statSync(dest).size,
        sha256: await hashFile(dest),
        url: stripDownloadUrl(options.url),
    };
    if (options.mime)
        info.mime = options.mime;
    return { info, requested, deduped: allocated.deduped };
}
export async function stageBytes(bytes) {
    const dir = downloadsStagingDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `pdf-${randomBytes(8).toString('hex')}`);
    await writeFile(path, bytes);
    return path;
}
/**
 * Chrome only reads this when the profile starts. A broken Preferences file must not block launch.
 */
export function preferExternalPdf(userDataDir) {
    const path = join(userDataDir, 'Default', 'Preferences');
    try {
        mkdirSync(dirname(path), { recursive: true });
        let prefs = {};
        if (existsSync(path)) {
            try {
                const parsed = JSON.parse(readTextFile(path));
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    logDaemon('pdf preference skipped: Preferences is not an object');
                    return;
                }
                prefs = { ...parsed };
            }
            catch (err) {
                logDaemon(`pdf preference skipped: ${errorText(err)}`);
                return;
            }
        }
        const plugins = prefs.plugins;
        const next = plugins && typeof plugins === 'object' && !Array.isArray(plugins) ? { ...plugins } : {};
        next.always_open_pdf_externally = true;
        prefs.plugins = next;
        writeFileSync(path, JSON.stringify(prefs), 'utf8');
    }
    catch (err) {
        logDaemon(`pdf preference skipped: ${errorText(err)}`);
    }
}
export class DownloadManager {
    session;
    seq = 0;
    inflightMarks = new Set();
    items = [];
    beginListeners = [];
    unreportedFiles = [];
    unreportedLines = [];
    stopped = false;
    constructor(session) {
        this.session = session;
    }
    static async start(browser, options) {
        mkdirSync(downloadsStagingDir(), { recursive: true });
        const session = await browser.target().createCDPSession();
        const manager = new DownloadManager(session);
        // allowAndName stores the bytes as <staging>/<guid>, not the suggested name.
        // Skip it when attached: the command applies to the whole profile, not one tab.
        if (options?.applyBehavior !== false) {
            await session.send('Browser.setDownloadBehavior', {
                behavior: 'allowAndName',
                downloadPath: downloadsStagingDir(),
                eventsEnabled: true,
            });
        }
        session.on('Browser.downloadWillBegin', (event) => manager.onBegin(event));
        session.on('Browser.downloadProgress', (event) => manager.onProgress(event));
        return manager;
    }
    async dispose() {
        this.stopped = true;
        await this.session.detach().catch(() => undefined);
    }
    mark() {
        this.seq += 1;
        this.inflightMarks.add(this.seq);
        return this.seq;
    }
    release(mark) {
        if (!this.inflightMarks.delete(mark))
            return;
        this.sweep();
    }
    claimSince(mark) {
        const found = this.items.filter((item) => item.seq > mark && !item.claimed);
        for (const item of found)
            item.claimed = true;
        this.inflightMarks.delete(mark);
        this.sweep();
        return found;
    }
    /** Resolves when any download has begun after mark, without claiming it. */
    waitForAnyBegin(mark, timeoutMs) {
        const ready = () => this.items.some((item) => item.seq > mark);
        if (ready() || timeoutMs <= 0)
            return Promise.resolve(ready());
        return new Promise((resolveReady) => {
            let settled = false;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                const index = this.beginListeners.indexOf(onBegin);
                if (index >= 0)
                    this.beginListeners.splice(index, 1);
                resolveReady(ready());
            };
            const onBegin = () => {
                if (ready())
                    finish();
            };
            const timer = setTimeout(finish, timeoutMs);
            this.beginListeners.push(onBegin);
            if (ready())
                finish();
        });
    }
    waitForBegin(mark, timeoutMs) {
        const take = () => this.items.find((item) => item.seq > mark && !item.claimed);
        const claim = (item) => {
            item.claimed = true;
            this.inflightMarks.delete(mark);
            this.sweep();
            return item;
        };
        const existing = take();
        if (existing)
            return Promise.resolve(claim(existing));
        if (timeoutMs <= 0) {
            this.inflightMarks.delete(mark);
            this.sweep();
            return Promise.resolve(null);
        }
        return new Promise((resolveBegin) => {
            let settled = false;
            const finish = (item) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                const index = this.beginListeners.indexOf(onBegin);
                if (index >= 0)
                    this.beginListeners.splice(index, 1);
                if (item) {
                    resolveBegin(claim(item));
                    return;
                }
                this.inflightMarks.delete(mark);
                this.sweep();
                resolveBegin(null);
            };
            const onBegin = () => {
                const item = take();
                if (item)
                    finish(item);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            this.beginListeners.push(onBegin);
            onBegin();
        });
    }
    async waitForComplete(download, timeoutMs = COMPLETE_TIMEOUT_MS) {
        const item = this.requireItem(download.id);
        if (item.state === 'completed' || item.state === 'canceled')
            return item;
        try {
            await new Promise((resolveDone, rejectDone) => {
                const timer = setTimeout(() => {
                    item.waiters = item.waiters.filter((waiter) => waiter !== onDone);
                    rejectDone(new RelayError('timeout', `download timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                const onDone = () => {
                    clearTimeout(timer);
                    resolveDone();
                };
                item.waiters.push(onDone);
                if (item.state === 'completed' || item.state === 'canceled')
                    onDone();
            });
        }
        catch (err) {
            item.claimed = false;
            this.sweep();
            throw err;
        }
        return item;
    }
    async finalize(download, options) {
        const item = this.requireItem(download.id);
        if (item.state === 'canceled')
            throw new Error(`Download ${item.suggestedFilename} was canceled`);
        const source = await this.stagedPath(item);
        return publishDownload({
            sourcePath: source,
            dir: options.dir,
            fileName: options.fileName,
            url: item.url,
            dedupe: options.dedupe,
        });
    }
    takeUnreported() {
        return { files: this.unreportedFiles.splice(0), lines: this.unreportedLines.splice(0) };
    }
    requireItem(id) {
        const item = this.items.find((entry) => entry.id === id);
        if (!item)
            throw new Error(`Unknown download ${id}`);
        return item;
    }
    onBegin(event) {
        if (this.stopped || this.items.some((item) => item.id === event.guid))
            return;
        this.seq += 1;
        const item = {
            id: event.guid,
            seq: this.seq,
            url: stripDownloadUrl(event.url),
            suggestedFilename: event.suggestedFilename,
            state: 'inProgress',
            claimed: false,
            backgrounded: false,
            waiters: [],
        };
        this.items.push(item);
        logDaemon(`download begin file=${event.suggestedFilename || '(none)'}`);
        for (const listener of [...this.beginListeners])
            listener();
    }
    onProgress(event) {
        if (this.stopped)
            return;
        const item = this.items.find((entry) => entry.id === event.guid);
        if (!item)
            return;
        if (event.filePath)
            item.filePath = event.filePath;
        if (event.state !== 'inProgress' && event.state !== 'completed' && event.state !== 'canceled')
            return;
        item.state = event.state;
        if (event.state === 'inProgress')
            return;
        logDaemon(`download ${event.state} file=${item.suggestedFilename || '(none)'}`);
        const waiters = item.waiters;
        item.waiters = [];
        for (const waiter of waiters)
            waiter();
        this.sweep();
    }
    blocked(item) {
        for (const mark of this.inflightMarks) {
            if (mark < item.seq)
                return true;
        }
        return false;
    }
    sweep() {
        for (const item of this.items) {
            if (item.claimed || item.backgrounded)
                continue;
            if (item.state !== 'completed' && item.state !== 'canceled')
                continue;
            if (this.blocked(item))
                continue;
            item.backgrounded = true;
            item.claimed = true;
            void this.background(item);
        }
    }
    async background(item) {
        try {
            if (item.state === 'canceled') {
                this.unreportedLines.push(canceledLine(item.suggestedFilename));
                return;
            }
            const published = await this.finalize(item, {
                dir: activeDownloadsDir(),
                fileName: item.suggestedFilename,
                dedupe: true,
            });
            this.unreportedFiles.push(published.info);
            this.unreportedLines.push(downloadLine(published.info));
        }
        catch (err) {
            logDaemon(`download finalize failed: ${errorText(err)}`);
        }
    }
    async stagedPath(item) {
        const dir = downloadsStagingDir();
        const deadline = Date.now() + 2_000;
        for (;;) {
            const found = lookupStaged(dir, item);
            if (found)
                return found;
            if (Date.now() >= deadline)
                break;
            await delay(50);
        }
        let names = '';
        try {
            names = readdirSync(dir).slice(0, 20).join(',');
        }
        catch {
            names = '';
        }
        throw new Error(`Download ${item.suggestedFilename || item.id} completed but the file was not in staging (${names})`);
    }
}
function lookupStaged(dir, item) {
    if (item.filePath && existsSync(item.filePath) && !item.filePath.endsWith('.crdownload'))
        return item.filePath;
    const direct = join(dir, item.id);
    if (existsSync(direct))
        return direct;
    if (!existsSync(dir))
        return null;
    const names = readdirSync(dir);
    const exact = names.find((name) => name === item.id);
    if (exact)
        return join(dir, exact);
    const partial = names.find((name) => name.startsWith(item.id) && !name.endsWith('.crdownload'));
    return partial ? join(dir, partial) : null;
}
async function moveFile(from, to) {
    let last;
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            await rename(from, to);
            return;
        }
        catch (err) {
            last = err;
            const code = err.code;
            if (code === 'EXDEV') {
                await copyFile(from, to);
                await unlink(from);
                return;
            }
            // Chrome on Windows can still have the guid file open for a moment after completed.
            if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')
                throw err;
            await delay(100);
        }
    }
    throw last;
}
function delay(ms) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
//# sourceMappingURL=downloads.js.map