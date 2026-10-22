import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import type { Server } from 'node:http';
import { z } from 'zod';
import { errorText, logDaemon, packageVersion } from '../config/paths.js';
import { RelayError, relayStatus, type RelayErrorCode } from '../errors.js';
import { ActSchema, issuesText, SnapshotQuery, WaitSchema } from '../protocol.js';
import type { BrowserControl } from '../session/browser.js';
import { RunSkillInputSchema, SaveSkillInputSchema } from '../skills/schema.js';

const NavigateBody = z.object({
  url: z.string().min(1),
});

const RollbackBody = z.object({
  to: z.number().int().positive(),
});

export interface AppOptions {
  token: string;
  session: BrowserControl;
  onShutdown: () => void;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    logDaemon(`http error: ${errorText(err)}`);
    return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
  });

  app.notFound((c) => jsonError(c, 404, 'not_found', `No route for ${c.req.method} ${c.req.path}`));

  app.use('*', async (c, next) => {
    if (c.req.method === 'GET' && c.req.path === '/health') return next();
    if (!bearerOk(c.req.header('authorization'), options.token)) {
      return jsonError(c, 401, 'unauthorized', 'Missing or invalid bearer token');
    }
    await next();
  });

  app.get('/health', (c) =>
    c.json({
      ok: true,
      pid: process.pid,
      version: packageVersion(),
      browser: options.session.browserState(),
    }),
  );

  app.get('/status', async (c) => {
    try {
      return c.json(await options.session.status());
    } catch (err) {
      return browserError(c, err);
    }
  });

  app.post('/navigate', async (c) => {
    try {
      const body = NavigateBody.safeParse(await readJson(c));
      if (!body.success) return jsonError(c, 400, 'bad_request', issuesText(body.error));
      const url = parseHttpUrl(body.data.url);
      return c.json(await options.session.navigate(url));
    } catch (err) {
      return browserError(c, err);
    }
  });

  app.get('/snapshot', async (c) => {
    try {
      const parsed = SnapshotQuery.safeParse({
        mode: emptyAsUndefined(c.req.query('mode')) ?? 'full',
        maxRows: emptyAsUndefined(c.req.query('maxRows')) === undefined ? undefined : Number(c.req.query('maxRows')),
      });
      if (!parsed.success) return jsonError(c, 400, 'bad_request', issuesText(parsed.error));
      return c.json(await options.session.snapshot({ mode: parsed.data.mode, maxRows: parsed.data.maxRows }));
    } catch (err) {
      return browserError(c, err);
    }
  });

  app.post('/act', async (c) => {
    try {
      const body = ActSchema.safeParse(await readJson(c));
      if (!body.success) return jsonError(c, 400, 'bad_request', issuesText(body.error));
      return c.json(await options.session.act(body.data));
    } catch (err) {
      return browserError(c, err);
    }
  });

  app.post('/wait', async (c) => {
    try {
      const body = WaitSchema.safeParse(await readJson(c));
      if (!body.success) return jsonError(c, 400, 'bad_request', issuesText(body.error));
      return c.json(await options.session.waitFor(body.data));
    } catch (err) {
      return browserError(c, err);
    }
  });

  app.get('/trace', (c) => c.json(options.session.trace()));

  app.post('/trace/clear', (c) => c.json(options.session.clearTrace()));

  app.post('/skills/save', async (c) => {
    try {
      const body = SaveSkillInputSchema.safeParse(await readJson(c));
      if (!body.success) return jsonError(c, 400, 'bad_request', issuesText(body.error));
      return c.json(options.session.saveSkill(body.data));
    } catch (err) {
      return browserError(c, err);
    }
  });

  app.get('/skills', (c) => {
    try {
      return c.json({ skills: options.session.listSkills() });
    } catch (err) {
      return browserError(c, err);
    }
  });

  app.get('/skills/:name/history', (c) => {
    try {
      return c.json(options.session.skillHistory(c.req.param('name')));
    } catch (err) {
      return browserError(c, err);
    }
  });

  app.post('/skills/:name/rollback', async (c) => {
    try {
      const body = RollbackBody.safeParse(await readJson(c));
      if (!body.success) return jsonError(c, 400, 'bad_request', issuesText(body.error));
      return c.json(options.session.rollbackSkill(c.req.param('name'), body.data.to));
    } catch (err) {
      return browserError(c, err);
    }
  });

  app.post('/skills/:name/run', async (c) => {
    try {
      const body = RunSkillInputSchema.safeParse(await readJson(c));
      if (!body.success) return jsonError(c, 400, 'bad_request', issuesText(body.error));
      return c.json(await options.session.runSkill(c.req.param('name'), body.data));
    } catch (err) {
      return browserError(c, err);
    }
  });

  app.get('/skills/:name', (c) => {
    try {
      return c.json(options.session.readSkill(c.req.param('name'), parseVersion(c.req.query('version'))));
    } catch (err) {
      return browserError(c, err);
    }
  });

  app.post('/shutdown', (c) => {
    // Let the response flush before the process closes the listening socket.
    setTimeout(() => options.onShutdown(), 100);
    return c.json({ ok: true });
  });

  return app;
}

export interface ListeningServer {
  port: number;
  close: () => Promise<void>;
}

export function listen(app: Hono): Promise<ListeningServer> {
  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: '127.0.0.1',
        port: 0,
      },
      (info) => {
        resolve({
          port: info.port,
          close: () => closeServer(server),
        });
      },
    );
    (server as Server).on('error', reject);
  });
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 500 | 503 | 504,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, 'bad_request', 'Request body must be JSON');
  }
}

function parseHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'bad_request', `Invalid URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'bad_request', `Only http and https URLs are supported, got ${url.protocol}`);
  }
  return url.toString();
}

function browserError(c: Context, err: unknown): Response {
  if (err instanceof HttpError) return jsonError(c, err.status, err.code, err.message);
  if (err instanceof RelayError) {
    logDaemon(`${err.code}: ${err.message}`);
    return jsonError(c, relayStatus(err.code), err.code, err.message);
  }
  const timeout = err instanceof Error && err.name === 'TimeoutError';
  const message = errorText(err);
  logDaemon(`${timeout ? 'timeout' : 'browser_error'}: ${message}`);
  const code: RelayErrorCode | 'browser_error' = timeout ? 'timeout' : 'browser_error';
  return jsonError(c, timeout ? 504 : 500, code, message);
}

function jsonError(
  c: Context,
  status: 400 | 401 | 404 | 409 | 500 | 503 | 504,
  code: string,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status);
}

function bearerOk(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match?.[1]) return false;
  const presented = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

function emptyAsUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  return value;
}

function parseVersion(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new RelayError('bad_params', 'version must be a positive integer');
  }
  return version;
}
