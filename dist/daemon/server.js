import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { errorText, logDaemon, packageVersion } from '../config/paths.js';
import { RelayError, relayStatus } from '../errors.js';
import { stateDelete, stateGet, stateList, statePut } from '../state/store.js';
import { EVAL_DISABLED_MESSAGE, evalEnabled } from '../config/runtime.js';
import { EXTRACT_MAX_LIMIT } from '../perception/extract.js';
import { ActSchema, DownloadSchema, HandoffStartSchema, HandoffWaitSchema, IdentitySaveSchema, issuesText, PdfSchema, SnapshotQuery, TabsCommandSchema, WaitSchema } from '../protocol.js';
import { RunSkillInputSchema, SaveSkillInputSchema, SkillPatchInputSchema } from '../skills/schema.js';
const NavigateBody = z.object({
    url: z.string().min(1),
});
const AttachBody = z.object({
    auto: z.boolean().optional(),
    cdp_url: z.string().min(1).optional(),
    user_data_dir: z.string().min(1).optional(),
});
const AccessBody = z.object({
    domain: z.string().min(1),
    reason: z.string().max(500).optional(),
});
const AdoptBody = z.object({
    index: z.number().int().positive(),
});
const RollbackBody = z.object({
    to: z.number().int().positive(),
});
const PrivacyKind = z.enum(['name', 'account', 'phone', 'email', 'idcard']);
const PrivacyModeBody = z.object({
    on: z.boolean(),
    identity: z.string().min(1).optional(),
});
const PrivacyAddBody = z.object({
    kind: PrivacyKind,
    value: z.string().min(1),
    identity: z.string().min(1).optional(),
});
const PrivacyConfirmBody = z.object({
    token: z.string().min(1),
    as: PrivacyKind.optional(),
    reject: z.boolean().optional(),
    identity: z.string().min(1).optional(),
});
const PrivacyMarkBody = z.object({
    ref: z.string().min(1).optional(),
    value: z.string().min(1).optional(),
    as: PrivacyKind,
});
const StatePutBody = z.object({
    ns: z.string().min(1),
    key: z.string().min(1),
    value: z.unknown(),
    if_version: z.number().int().nonnegative().optional(),
});
const StateKeyBody = z.object({
    ns: z.string().min(1),
    key: z.string().min(1),
    if_version: z.number().int().nonnegative().optional(),
});
const StateListBody = z.object({
    ns: z.string().min(1),
});
const ExtractBody = z.object({
    root_selector: z.string().min(1),
    fields: z.record(z.string(), z.object({
        selector: z.string().min(1),
        attr: z.string().min(1).optional(),
        all: z.boolean().optional(),
    })),
    limit: z.number().int().min(1).max(EXTRACT_MAX_LIMIT).optional(),
});
const EvalBody = z.object({
    expr: z.string().min(1),
    args: z.array(z.unknown()).optional(),
});
export function createApp(options) {
    const app = new Hono();
    const show = (c, body) => c.json(options.session.redactOutbound(body));
    const fail = (c, err) => browserError(c, err, (message) => {
        try {
            return options.session.redactOutbound(message);
        }
        catch {
            return 'Request failed';
        }
    });
    app.onError((err, c) => {
        logDaemon(`http error: ${errorText(err)}`);
        return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
    });
    app.notFound((c) => jsonError(c, 404, 'not_found', `No route for ${c.req.method} ${c.req.path}`));
    app.use('*', async (c, next) => {
        if (c.req.method === 'GET' && c.req.path === '/health')
            return next();
        if (!bearerOk(c.req.header('authorization'), options.token)) {
            return jsonError(c, 401, 'unauthorized', 'Missing or invalid bearer token');
        }
        await next();
    });
    app.get('/health', (c) => c.json({
        ok: true,
        pid: process.pid,
        version: packageVersion(),
        browser: options.session.browserState(),
        ...(options.build ? { build: options.build } : {}),
    }));
    app.get('/status', async (c) => {
        try {
            const status = await options.session.status();
            return show(c, options.build ? { ...status, build: options.build } : status);
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/navigate', async (c) => {
        try {
            const body = NavigateBody.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            const url = parseHttpUrl(body.data.url);
            return show(c, await options.session.navigate(url));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.get('/snapshot', async (c) => {
        try {
            const parsed = SnapshotQuery.safeParse({
                mode: emptyAsUndefined(c.req.query('mode')) ?? 'full',
                maxRows: emptyAsUndefined(c.req.query('maxRows')) === undefined ? undefined : Number(c.req.query('maxRows')),
                maxChars: emptyAsUndefined(c.req.query('maxChars')) === undefined ? undefined : Number(c.req.query('maxChars')),
            });
            if (!parsed.success)
                return jsonError(c, 400, 'bad_request', issuesText(parsed.error));
            return show(c, await options.session.snapshot({ mode: parsed.data.mode, maxRows: parsed.data.maxRows, maxChars: parsed.data.maxChars }));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/act', async (c) => {
        try {
            const body = ActSchema.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, await options.session.act(body.data));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/download', async (c) => {
        try {
            const body = DownloadSchema.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, await options.session.download(body.data));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/pdf', async (c) => {
        try {
            const body = PdfSchema.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, await options.session.pdf(body.data));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/wait', async (c) => {
        try {
            const body = WaitSchema.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, await options.session.waitFor(body.data));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.get('/tabs', async (c) => {
        try {
            return show(c, await options.session.tabs({ action: 'list' }));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/tabs', async (c) => {
        try {
            const body = TabsCommandSchema.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, await options.session.tabs(body.data));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.get('/trace', (c) => show(c, options.session.trace()));
    app.post('/trace/clear', (c) => show(c, options.session.clearTrace()));
    app.post('/skills/save', async (c) => {
        try {
            const body = SaveSkillInputSchema.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, options.session.saveSkill(body.data));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.get('/skills', (c) => {
        try {
            return show(c, { skills: options.session.listSkills() });
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.get('/skills/:name/history', (c) => {
        try {
            return show(c, options.session.skillHistory(c.req.param('name')));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/skills/:name/rollback', async (c) => {
        try {
            const body = RollbackBody.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, options.session.rollbackSkill(c.req.param('name'), body.data.to));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/skills/:name/run', async (c) => {
        try {
            const body = RunSkillInputSchema.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, await options.session.runSkill(c.req.param('name'), body.data));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/skills/:name/patch', async (c) => {
        try {
            const body = SkillPatchInputSchema.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, await options.session.skillPatch({ name: c.req.param('name'), ...body.data }));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.get('/skills/:name', (c) => {
        try {
            return show(c, options.session.readSkill(c.req.param('name'), parseVersion(c.req.query('version'))));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/handoff', async (c) => {
        try {
            const body = HandoffStartSchema.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, await options.session.requestHandoff(body.data.reason, body.data.url));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/handoff/wait', async (c) => {
        try {
            const body = HandoffWaitSchema.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, await options.session.waitHandoff(body.data.timeout_ms));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/handoff/cancel', async (c) => {
        try {
            return show(c, await options.session.cancelHandoff());
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.get('/identities', (c) => {
        try {
            return show(c, { identities: options.session.listIdentities() });
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/identities/save', async (c) => {
        try {
            const body = IdentitySaveSchema.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, await options.session.saveIdentity(body.data));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/identities/:name/revoke', async (c) => {
        try {
            return show(c, await options.session.revokeIdentity(c.req.param('name')));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/privacy/mode', async (c) => {
        try {
            const body = PrivacyModeBody.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return c.json(options.session.privacyMode(body.data.on, body.data.identity));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/privacy/add', async (c) => {
        try {
            const body = PrivacyAddBody.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return c.json(options.session.privacyAdd(body.data.kind, body.data.value, body.data.identity));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/privacy/confirm', async (c) => {
        try {
            const body = PrivacyConfirmBody.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return c.json(options.session.privacyConfirm(body.data));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/privacy/reject', async (c) => {
        try {
            const body = PrivacyConfirmBody.pick({ token: true, identity: true }).safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return c.json(options.session.privacyConfirm({ ...body.data, reject: true }));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.get('/privacy/list', (c) => {
        try {
            return c.json(options.session.privacyList(emptyAsUndefined(c.req.query('identity'))));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.get('/privacy/check', (c) => {
        try {
            return c.json(options.session.privacyCheck());
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/privacy/mark', async (c) => {
        try {
            const body = PrivacyMarkBody.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return c.json(await options.session.privacyMark(body.data));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/extract', async (c) => {
        try {
            const body = ExtractBody.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, await options.session.extract(body.data));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/eval', async (c) => {
        try {
            if (!evalEnabled())
                throw new RelayError('eval_disabled', EVAL_DISABLED_MESSAGE);
            const body = EvalBody.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, { result: await options.session.evalExpr(body.data.expr, body.data.args ?? []) });
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/state/put', async (c) => {
        try {
            const body = StatePutBody.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            const entry = await statePut(body.data.ns, body.data.key, body.data.value, body.data.if_version);
            return show(c, { version: entry.version, updated_at: entry.updated_at });
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/state/get', async (c) => {
        try {
            const body = StateKeyBody.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            const entry = await stateGet(body.data.ns, body.data.key);
            return show(c, entry);
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/state/list', async (c) => {
        try {
            const body = StateListBody.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, { keys: await stateList(body.data.ns) });
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/state/delete', async (c) => {
        try {
            const body = StateKeyBody.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, await stateDelete(body.data.ns, body.data.key, body.data.if_version));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/browser/attach', async (c) => {
        try {
            const body = AttachBody.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, await options.session.attach({ auto: body.data.auto, cdpUrl: body.data.cdp_url, userDataDir: body.data.user_data_dir }));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/browser/detach', async (c) => {
        try {
            return show(c, await options.session.detach());
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/access/request', async (c) => {
        try {
            const body = AccessBody.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, await options.session.requestAccess(body.data.domain, body.data.reason));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.get('/tabs/foreign', async (c) => {
        try {
            return show(c, await options.session.listForeignTabs());
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/tabs/adopt', async (c) => {
        try {
            const body = AdoptBody.safeParse(await readJson(c));
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            return show(c, await options.session.adoptTab(body.data.index));
        }
        catch (err) {
            return fail(c, err);
        }
    });
    app.post('/shutdown', async (c) => {
        let closeBrowser = false;
        const text = await c.req.text();
        if (text.trim()) {
            let parsed;
            try {
                parsed = JSON.parse(text);
            }
            catch {
                return jsonError(c, 400, 'bad_request', 'Request body must be JSON');
            }
            const body = z.object({ close_browser: z.boolean().optional() }).safeParse(parsed);
            if (!body.success)
                return jsonError(c, 400, 'bad_request', issuesText(body.error));
            closeBrowser = body.data.close_browser === true;
        }
        // Let the response flush before the process closes the listening socket.
        setTimeout(() => options.onShutdown(closeBrowser), 100);
        return c.json({ ok: true });
    });
    return app;
}
export function listen(app) {
    return new Promise((resolve, reject) => {
        const server = serve({
            fetch: app.fetch,
            hostname: '127.0.0.1',
            port: 0,
        }, (info) => {
            const nodeServer = server;
            nodeServer.requestTimeout = 16 * 60_000;
            nodeServer.headersTimeout = 16 * 60_000 + 60_000;
            resolve({
                port: info.port,
                close: () => closeServer(server),
            });
        });
        server.on('error', reject);
    });
}
function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
    });
}
class HttpError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'HttpError';
    }
}
async function readJson(c) {
    try {
        return await c.req.json();
    }
    catch {
        throw new HttpError(400, 'bad_request', 'Request body must be JSON');
    }
}
function parseHttpUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new HttpError(400, 'bad_request', `Invalid URL: ${value}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new HttpError(400, 'bad_request', `Only http and https URLs are supported, got ${url.protocol}`);
    }
    return url.toString();
}
function browserError(c, err, redact = (message) => message) {
    if (err instanceof HttpError)
        return jsonError(c, err.status, err.code, redact(err.message));
    if (err instanceof RelayError) {
        logDaemon(`${err.code}: ${err.message}`);
        const version = err.details.version;
        return c.json({
            error: {
                code: err.code,
                message: redact(err.message),
                ...(typeof version === 'number' ? { version } : {}),
            },
        }, relayStatus(err.code));
    }
    const timeout = err instanceof Error && err.name === 'TimeoutError';
    const message = errorText(err);
    logDaemon(`${timeout ? 'timeout' : 'browser_error'}: ${message}`);
    const code = timeout ? 'timeout' : 'browser_error';
    return jsonError(c, timeout ? 504 : 500, code, redact(message));
}
function jsonError(c, status, code, message) {
    return c.json({ error: { code, message } }, status);
}
function bearerOk(header, token) {
    if (!header)
        return false;
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!match?.[1])
        return false;
    const presented = Buffer.from(match[1]);
    const expected = Buffer.from(token);
    if (presented.length !== expected.length)
        return false;
    return timingSafeEqual(presented, expected);
}
function emptyAsUndefined(value) {
    if (value === undefined || value === '')
        return undefined;
    return value;
}
function parseVersion(value) {
    if (value === undefined || value === '')
        return undefined;
    const version = Number(value);
    if (!Number.isInteger(version) || version < 1) {
        throw new RelayError('bad_params', 'version must be a positive integer');
    }
    return version;
}
//# sourceMappingURL=server.js.map