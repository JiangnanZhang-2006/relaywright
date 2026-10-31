import { fileURLToPath } from 'node:url';
import { RelayError } from '../errors.js';
import { performAction } from '../actions/perform.js';
import { loadDocument } from '../perception/capture.js';
import { EXTRACT_SOURCE } from '../perception/extract-script.js';
import { normalizeExtract, withExtractWarning } from '../perception/extract.js';
import { BROWSER_HELPERS } from '../perception/inspect-script.js';
import { diffLines } from '../perception/diff.js';
import { RefRegistry } from '../perception/registry.js';
import { formatLines, loginHintLine, renderSnapshotParts } from '../perception/snapshot.js';
import { errorText, logDaemon } from '../config/paths.js';
import { TEXT_DEFAULT_CHARS, TEXT_MAX_CHARS } from '../protocol.js';
import { bounded, runPaint } from './timeout.js';
import { describeBackend, findFrameId, queryCssBackends, rowTextsFor } from '../recorder/dom.js';
import { isSensitive } from '../recorder/redact.js';
import { rowPeers } from '../skills/locate.js';
const NAV_DETECT_MS = 500;
const LOAD_CAP_MS = 15_000;
const IDLE_CAP_MS = 5_000;
const IDLE_QUIET_MS = 500;
const CALL_TIMEOUT_MS = 8_000;
const EVAL_TIMEOUT_MS = 3_000;
const PDF_TIMEOUT_MS = 60_000;
const PRINT_HOOK = `(() => {
  const w = window;
  if (typeof w.__rwPrintRequests !== 'number') w.__rwPrintRequests = 0;
  w.print = function () { w.__rwPrintRequests += 1; };
})();`;
const NAME_SHIM = `(() => {
  const w = window;
  if (typeof w.__name === 'function') return;
  w.__name = function (target, value) {
    try { Object.defineProperty(target, 'name', { value: value, configurable: true }); } catch (err) {}
    return target;
  };
})();`;
/**
 * tsx keepNames rewrites closures passed to page.evaluate so they call __name.
 * tsc output does not. The shim belongs only on pages driven by the TypeScript sources.
 */
export function needsNameShim(moduleUrl, argv = []) {
    const path = modulePath(moduleUrl);
    if (/\.(?:[cm]?ts|tsx)$/.test(path))
        return true;
    return argv.some((arg) => /(?:^|[\\/])tsx(?:[\\/]|$)/.test(arg));
}
function modulePath(moduleUrl) {
    const trimmed = moduleUrl.split(/[?#]/)[0] ?? moduleUrl;
    if (!trimmed.startsWith('file:'))
        return trimmed;
    try {
        return fileURLToPath(trimmed);
    }
    catch {
        return trimmed;
    }
}
function startupSource() {
    return needsNameShim(import.meta.url, process.argv) ? `${PRINT_HOOK}\n${NAME_SHIM}` : PRINT_HOOK;
}
export class PageController {
    page;
    cdp;
    registry = new RefRegistry();
    baseline = null;
    navigatedSinceBaseline = false;
    loaderId = '';
    epoch = 0;
    pending = new Map();
    lastNetwork = 0;
    disposed = false;
    model = { items: [], tables: [] };
    constructor(page, cdp) {
        this.page = page;
        this.cdp = cdp;
    }
    static async attach(page) {
        const cdp = await bounded(page.createCDPSession(), CALL_TIMEOUT_MS, 'cdp');
        const controller = new PageController(page, cdp);
        await bounded(cdp.send('Page.enable'), CALL_TIMEOUT_MS, 'Page.enable');
        await bounded(cdp.send('DOM.enable'), CALL_TIMEOUT_MS, 'DOM.enable').catch(() => undefined);
        await installPrintHook(page, cdp);
        const { frameTree } = await bounded(cdp.send('Page.getFrameTree'), CALL_TIMEOUT_MS, 'frame tree');
        controller.loaderId = frameTree.frame.loaderId;
        cdp.on('Page.frameNavigated', (event) => {
            // Same-document history updates use navigatedWithinDocument and keep the loader id.
            if (event.frame.parentId)
                return;
            controller.noteLoader(event.frame.loaderId);
        });
        page.on('request', (request) => {
            controller.pending.set(request, Date.now());
            controller.lastNetwork = Date.now();
        });
        page.on('requestfinished', (request) => {
            controller.pending.delete(request);
            controller.lastNetwork = Date.now();
        });
        page.on('requestfailed', (request) => {
            controller.pending.delete(request);
            controller.lastNetwork = Date.now();
        });
        return controller;
    }
    async dispose() {
        this.disposed = true;
        await this.cdp.detach().catch(() => undefined);
    }
    async navigate(url, tabs) {
        // Login pages long-poll (QR codes), so network idle may never come; settle has its own cap.
        await this.page.goto(url, { waitUntil: 'load', timeout: 30_000 });
        await this.settle(this.loaderId);
        return this.snapshot('full', undefined, tabs);
    }
    pageHandle() {
        return this.page;
    }
    /** Milliseconds since the page last started or finished a request; 0 while one is open. */
    networkQuietMs() {
        return this.pending.size > 0 ? 0 : Date.now() - this.lastNetwork;
    }
    hasRef(ref) {
        return this.registry.resolve(ref) !== undefined;
    }
    /** The next diff has no baseline, so it is returned as a full snapshot. */
    forgetBaseline() {
        this.baseline = null;
        this.navigatedSinceBaseline = false;
    }
    /** Visible text only. Does not move the diff baseline. */
    async visibleText(maxChars) {
        await this.paint();
        const title = await bounded(this.page.title(), EVAL_TIMEOUT_MS, 'title');
        const url = this.page.url();
        const raw = await readPageText(this.page);
        return { url, title, snapshot: formatVisibleText({ title, url, text: raw, maxChars }) };
    }
    async snapshot(mode, maxRows, tabs) {
        await this.paint();
        const title = await bounded(this.page.title(), EVAL_TIMEOUT_MS, 'title');
        const url = this.page.url();
        const rendered = await this.render(title, url, maxRows, tabs);
        const previous = this.baseline;
        const navigated = previous !== null && this.navigatedSinceBaseline;
        this.baseline = rendered.lines;
        this.navigatedSinceBaseline = false;
        if (mode === 'full' || previous === null || navigated) {
            const text = mode === 'diff' && navigated ? `(navigated: full snapshot)\n${rendered.text}` : rendered.text;
            return { url, title, snapshot: this.withLoginHint(text, title, rendered.visiblePassword) };
        }
        const changes = diffLines(previous, rendered.lines);
        const body = changes.length === 0 ? ['(no changes)'] : changes;
        return { url, title, snapshot: this.withLoginHint(formatLines(rendered.header, body), title, rendered.visiblePassword) };
    }
    async act(input) {
        await this.performInput(input);
        return this.snapshot('diff');
    }
    currentUrl() {
        return this.page.url();
    }
    pageText() {
        return readPageText(this.page);
    }
    async extract(input) {
        const request = normalizeExtract(input);
        try {
            const raw = await bounded(this.page.evaluate((source, payload) => {
                const fn = new Function('request', source);
                return fn(payload);
            }, EXTRACT_SOURCE, request), 10_000, 'extract');
            return withExtractWarning({ rows: raw.rows, limit: request.limit, truncated: Boolean(raw.truncated) });
        }
        catch (err) {
            if (err instanceof RelayError)
                throw err;
            const message = err instanceof Error ? err.message : 'Extract failed';
            throw new RelayError('bad_request', message.includes('Invalid selector') ? message : `Extract failed: ${message}`);
        }
    }
    async evalExpr(expr, args) {
        return bounded(this.page.evaluate((input) => {
            const ctor = globalThis.eval('(async function(){}).constructor');
            const fn = new ctor('args', input.expr);
            return fn(input.args).then((value) => {
                const text = JSON.stringify(value);
                if (typeof text !== 'string')
                    throw new Error('EVAL_NOT_JSON');
                return text;
            });
        }, { expr, args }), 10_000, 'eval');
    }
    /** Role and name come from the last snapshot model; CSS is read from the live node before it can disappear. */
    async describeRef(ref) {
        const backend = this.resolveRef(ref);
        const item = this.model.items.find((entry) => entry.ref === ref) ?? this.model.items.find((entry) => entry.backend === backend);
        const dom = await bounded(describeBackend(this.cdp, backend), CALL_TIMEOUT_MS, 'describe element');
        if (!dom)
            throw new RelayError('stale_ref', `Ref ${ref} no longer matches an element. Take a new snapshot.`);
        const name = item?.name ?? '';
        const label = item?.label;
        const role = item?.role ?? dom.tag;
        const sensitive = isSensitive({ role, name, label, sensitive: dom.password || item?.redacted === true });
        const target = {
            role,
            name,
            tag: dom.tag,
            css: dom.css,
            cssUnique: dom.cssUnique,
        };
        if (label && label !== name)
            target.label = label;
        if (dom.id)
            target.id = dom.id;
        if (dom.text && !sensitive)
            target.text = dom.text;
        if (item?.frame)
            target.frame = item.frame;
        const peers = item ? rowPeers(this.model.items, { role, name, frame: item.frame }) : [];
        const position = peers.findIndex((entry) => entry.backend === backend);
        if (peers.length > 1 && position >= 0) {
            target.nth = position + 1;
            target.peers = peers.length;
            if (!sensitive) {
                const rows = await this.rowTexts(peers.map((entry) => entry.backend)).catch(() => []);
                const row = rows[position];
                if (row)
                    target.row = row;
            }
        }
        return { target, sensitive };
    }
    async rowTexts(backends) {
        return bounded(rowTextsFor(this.cdp, backends), CALL_TIMEOUT_MS, 'row text');
    }
    async capture() {
        await this.paint();
        const url = this.page.url();
        const rendered = await this.render(await bounded(this.page.title(), EVAL_TIMEOUT_MS, 'title'), url);
        this.baseline = rendered.lines;
        this.navigatedSinceBaseline = false;
        return { items: rendered.items, tables: rendered.tables, url };
    }
    async queryCss(css, frame) {
        return bounded(this.queryCssInner(css, frame), CALL_TIMEOUT_MS, 'query css');
    }
    async hasVisiblePassword() {
        const loaded = await bounded(loadDocument(this.cdp), CALL_TIMEOUT_MS, 'password');
        if (loaded.main.visiblePassword)
            return true;
        return loaded.frames.some((frame) => frame.visiblePassword === true);
    }
    async isPasswordBackend(backend) {
        const dom = await bounded(describeBackend(this.cdp, backend), CALL_TIMEOUT_MS, 'describe element').catch(() => null);
        return dom?.password === true;
    }
    async isPasswordRef(ref) {
        const backend = this.registry.resolve(ref);
        if (backend === undefined)
            return false;
        return this.isPasswordBackend(backend);
    }
    async performInput(input) {
        const before = this.loaderId;
        await bounded(performAction({
            page: this.page,
            cdp: this.cdp,
            resolve: (ref) => this.resolveRef(ref),
        }, input), CALL_TIMEOUT_MS, 'action');
        await this.settle(before);
    }
    async performBackend(backend, input) {
        const ref = this.registry.refFor(backend);
        await this.performInput({ ...input, ref });
    }
    async printCount() {
        if (this.disposed || this.page.isClosed())
            return 0;
        try {
            const value = await bounded(this.page.evaluate(() => {
                const count = globalThis.__rwPrintRequests;
                return typeof count === 'number' ? count : 0;
            }), EVAL_TIMEOUT_MS, 'print count');
            return value;
        }
        catch {
            return 0;
        }
    }
    async printToPdf(options) {
        if (this.disposed || this.page.isClosed())
            throw new Error('Tab is closed');
        return bounded(this.readPdf(options.landscape === true), PDF_TIMEOUT_MS, 'printToPDF');
    }
    async excerpt() {
        const page = await this.snapshot('full');
        return page.snapshot.split('\n').slice(0, 40).join('\n');
    }
    documentEpoch() {
        return this.epoch;
    }
    async waitFor(input) {
        const timeout = input.timeoutMs ?? 10_000;
        const deadline = Date.now() + timeout;
        let matched = false;
        for (;;) {
            matched = await this.matches(input);
            if (matched || Date.now() >= deadline)
                break;
            await delay(Math.min(250, Math.max(0, deadline - Date.now())));
        }
        const page = await this.snapshot('diff');
        return { matched, url: page.url, title: page.title, snapshot: page.snapshot };
    }
    async queryCssInner(css, frame) {
        const listed = await this.cdp.send('Page.getFrameTree');
        const frameId = findFrameId(listed.frameTree, frame);
        if (!frameId)
            return [];
        return queryCssBackends(this.cdp, frameId, css);
    }
    async render(title, url, maxRows, tabs) {
        const loaded = await bounded(loadDocument(this.cdp), CALL_TIMEOUT_MS, 'snapshot');
        const rendered = renderSnapshotParts({
            title,
            url,
            nodes: loaded.main.nodes,
            passwordBackendNodeIds: loaded.main.passwordBackendNodeIds,
            clickableBackendNodeIds: loaded.main.clickableBackendNodeIds,
            clickableLabels: loaded.main.clickableLabels,
            controlNames: loaded.main.controlNames,
            adaptedSelects: loaded.main.adaptedSelects,
            frames: loaded.frames,
            maxRows,
            tabs,
            registry: this.registry,
        });
        this.model = { items: rendered.items, tables: rendered.tables };
        const visiblePassword = loaded.main.visiblePassword || loaded.frames.some((frame) => frame.visiblePassword === true);
        return { ...rendered, visiblePassword };
    }
    withLoginHint(text, title, visiblePassword) {
        if (!visiblePassword)
            return text;
        const line = loginHintLine(title);
        if (text.includes(line))
            return text;
        return `${text}\n${line}`;
    }
    resolveRef(ref) {
        const backend = this.registry.resolve(ref);
        if (backend === undefined)
            throw new RelayError('stale_ref', `Unknown ref ${ref}. Take a new snapshot.`);
        return backend;
    }
    noteLoader(loaderId) {
        if (!loaderId || loaderId === this.loaderId)
            return;
        const hadDocument = this.loaderId !== '';
        this.loaderId = loaderId;
        // Subresources of the old document may never report finished or failed once it is gone.
        this.pending.clear();
        if (!hadDocument)
            return;
        this.registry.reset();
        // A heal token's refs belong to this document. The next load makes them unusable.
        this.epoch += 1;
        if (this.baseline)
            this.navigatedSinceBaseline = true;
    }
    async matches(input) {
        if (input.url && !this.page.url().includes(input.url))
            return false;
        if (input.text) {
            const text = await readPageText(this.page).catch(() => '');
            if (!text.includes(input.text))
                return false;
        }
        if (input.ref) {
            const backend = this.resolveRef(input.ref);
            const visible = await bounded(this.refVisible(backend), EVAL_TIMEOUT_MS, 'ref').catch(() => false);
            if (!visible)
                return false;
        }
        return true;
    }
    async refVisible(backendNodeId) {
        try {
            const resolved = await this.cdp.send('DOM.resolveNode', { backendNodeId });
            const objectId = resolved.object.objectId;
            if (!objectId)
                return false;
            const result = await this.cdp.send('Runtime.callFunctionOn', {
                objectId,
                functionDeclaration: `function() {
          ${BROWSER_HELPERS}
          const style = getComputedStyle(this);
          const rect = this.getBoundingClientRect();
          const selfVisible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          if (selfVisible) return true;
          if (this instanceof HTMLSelectElement && rwFindWidget(this)) return true;
          return false;
        }`,
                returnByValue: true,
            });
            return result.result.value === true;
        }
        catch {
            return false;
        }
    }
    async settle(beforeLoader) {
        const start = Date.now();
        let quietSince = this.pending.size === 0 ? start : null;
        const idleDeadline = start + IDLE_CAP_MS;
        while (Date.now() < idleDeadline) {
            const now = Date.now();
            if (this.loaderId !== beforeLoader && now - start <= NAV_DETECT_MS + 50) {
                await this.waitForLoad(Math.max(0, start + LOAD_CAP_MS - now));
                return;
            }
            if (this.pending.size === 0) {
                if (quietSince === null)
                    quietSince = now;
            }
            else {
                quietSince = null;
            }
            if (now - start >= NAV_DETECT_MS && quietSince !== null && now - quietSince >= IDLE_QUIET_MS)
                return;
            await delay(50);
        }
        const open = [...this.pending.keys()].slice(0, 3).map((request) => `${request.resourceType()} ${request.url().slice(0, 120)}`);
        logDaemon(`settle cap reached with ${this.pending.size} open request(s): ${open.join(', ')}`);
    }
    async waitForLoad(timeoutMs) {
        if (timeoutMs <= 0)
            return;
        const ready = await bounded(this.page.evaluate(() => {
            const doc = globalThis.document;
            return doc?.readyState ?? 'complete';
        }), EVAL_TIMEOUT_MS, 'readyState').catch(() => 'complete');
        if (ready === 'complete')
            return;
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.page.off('load', onLoad);
                resolve();
            }, timeoutMs);
            const onLoad = () => {
                clearTimeout(timer);
                resolve();
            };
            this.page.once('load', onLoad);
        });
    }
    async readPdf(landscape) {
        let stream;
        try {
            const result = await this.cdp.send('Page.printToPDF', {
                printBackground: true,
                landscape,
                preferCSSPageSize: true,
                transferMode: 'ReturnAsStream',
            });
            if (result.stream) {
                stream = result.stream;
                return await readIoStream(this.cdp, result.stream);
            }
            if (result.data)
                return Buffer.from(result.data, 'base64');
            throw new RelayError('pdf_unsupported', 'Page.printToPDF returned no data');
        }
        catch (err) {
            if (err instanceof RelayError)
                throw err;
            if (isPdfUnsupported(err))
                throw new RelayError('pdf_unsupported', errorText(err));
            throw err;
        }
        finally {
            if (stream)
                await this.cdp.send('IO.close', { handle: stream }).catch(() => undefined);
        }
    }
    async paint() {
        if (this.disposed)
            return;
        // requestAnimationFrame does not run in a hidden tab, so this must be raced.
        await runPaint((fn) => this.page.evaluate(fn));
    }
}
export function formatVisibleText(input) {
    const limit = input.maxChars ?? TEXT_DEFAULT_CHARS;
    if (!Number.isInteger(limit) || limit < 1 || limit > TEXT_MAX_CHARS) {
        throw new RelayError('bad_request', `max_chars must be an integer from 1 to ${TEXT_MAX_CHARS}`);
    }
    const collapsed = input.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const chars = [...collapsed];
    const truncated = chars.length > limit;
    const body = truncated ? `${chars.slice(0, limit).join('')}\n[truncated]` : collapsed;
    return `page: ${input.title}  url: ${input.url}\n${body}`;
}
async function readPageText(page) {
    return bounded(page.evaluate(() => {
        const parts = [];
        const visit = (view) => {
            try {
                const body = view.document?.body;
                if (body?.innerText)
                    parts.push(body.innerText);
                const frames = view.document?.querySelectorAll('iframe,frame');
                if (!frames)
                    return;
                for (const frame of frames) {
                    try {
                        const child = frame.contentWindow;
                        if (child)
                            visit(child);
                    }
                    catch {
                        // A cross-origin frame throws; keep reading the frames after it.
                    }
                }
            }
            catch {
                // The document itself is unreachable.
            }
        };
        visit(globalThis);
        return parts.join('\n');
    }), EVAL_TIMEOUT_MS, 'page text');
}
async function installPrintHook(page, cdp) {
    try {
        await bounded(cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: startupSource(), runImmediately: true }), CALL_TIMEOUT_MS, 'print hook');
    }
    catch (err) {
        logDaemon(`print hook install failed: ${errorText(err)}`);
    }
    await bounded(page.evaluate(() => {
        const w = globalThis;
        if (typeof w.__rwPrintRequests !== 'number')
            w.__rwPrintRequests = 0;
        w.print = () => {
            w.__rwPrintRequests = (w.__rwPrintRequests ?? 0) + 1;
        };
    }), EVAL_TIMEOUT_MS, 'print hook').catch(() => undefined);
}
async function readIoStream(cdp, handle) {
    const chunks = [];
    for (;;) {
        const chunk = await cdp.send('IO.read', { handle });
        chunks.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data, 'latin1'));
        if (chunk.eof)
            break;
    }
    return Buffer.concat(chunks);
}
function isPdfUnsupported(err) {
    const text = errorText(err);
    return /not implemented|not supported|unsupported|print preview is not available/i.test(text);
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=page.js.map