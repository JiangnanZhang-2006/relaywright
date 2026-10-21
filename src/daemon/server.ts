import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import type { Server } from 'node:http';
import { z } from 'zod';
import { errorText, logDaemon, packageVersion } from '../config/paths.js';
import type { BrowserSession, PageBody, StatusBody } from '../session/browser.js';

const NavigateBody = z.object({
  url: z.string().min(1),
});

type BrowserControl = Pick<BrowserSession, 'status' | 'navigate' | 'snapshot'>;

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

  app.get('/health', (c) => c.json({ ok: true, pid: process.pid, version: packageVersion() }));

  app.get('/status', async (c) => {
    try {
      const status: StatusBody = await options.session.status();
      return c.json(status);
    } catch (err) {
      return browserError(c, err);
    }
  });

  app.post('/navigate', async (c) => {
    try {
      const body = NavigateBody.safeParse(await readJson(c));
      if (!body.success) {
        return jsonError(c, 400, 'bad_request', body.error.issues.map((issue) => issue.message).join('; '));
      }
      const url = parseHttpUrl(body.data.url);
      const page: PageBody = await options.session.navigate(url);
      return c.json(page);
    } catch (err) {
      return browserError(c, err);
    }
  });

  app.get('/snapshot', async (c) => {
    try {
      const page: PageBody = await options.session.snapshot();
      return c.json(page);
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
    readonly status: 400 | 401 | 404 | 500 | 504,
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
  const timeout = err instanceof Error && err.name === 'TimeoutError';
  const message = errorText(err);
  logDaemon(`${timeout ? 'timeout' : 'browser_error'}: ${message}`);
  return jsonError(c, timeout ? 504 : 500, timeout ? 'timeout' : 'browser_error', message);
}

function jsonError(
  c: Context,
  status: 400 | 401 | 404 | 500 | 504,
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
