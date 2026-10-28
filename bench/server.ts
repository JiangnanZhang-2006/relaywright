import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { parseExportBody } from './score.js';
import type { ExportPost } from './types.js';

export interface BenchServer {
  port: number;
  exports: () => ExportPost[];
  reset: () => void;
  close: () => Promise<void>;
}

export async function startBenchServer(root: string): Promise<BenchServer> {
  const base = resolve(root);
  const posts: ExportPost[] = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/__bench/reset') {
        posts.length = 0;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/zf-mock/export.pdf') {
        const body = await readBody(req);
        posts.push(parseExportBody(body));
        const pdf = await readFile(join(base, 'sample.pdf'));
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition': 'inline; filename="kb.pdf"',
          'cache-control': 'no-store',
        });
        res.end(pdf);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        res.end();
        return;
      }
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const file = resolve(base, `.${pathname}`);
      if (file !== base && !file.startsWith(base + sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const data = extname(file) === '.html' ? withoutLoginBox(await readFile(file, 'utf8')) : await readFile(file);
      res.writeHead(200, { 'content-type': mime(extname(file)), 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((listenResolve, listenReject) => {
    server.once('error', listenReject);
    server.listen(0, '127.0.0.1', () => listenResolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    exports: () => posts.map((post) => ({ ...post })),
    reset: () => {
      posts.length = 0;
    },
    close: () => closeServer(server),
  };
}

/**
 * The zf-mock pages carry a login form for the password-redaction tests. The benchmark task
 * starts after login, so the form is removed for every tool alike.
 */
export function withoutLoginBox(html: string): string {
  return html.replace(/<form id="login-box">[\s\S]*?<\/form>\s*/g, '');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function mime(extension: string): string {
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((err) => (err ? rejectClose(err) : resolveClose()));
  });
}
