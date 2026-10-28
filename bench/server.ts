import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { parseExportBody } from './score.js';
import type { ExportPost } from './types.js';

export interface BenchServer {
  port: number;
  exports: () => ExportPost[];
  /** Export posts that did not come from a page navigation, e.g. a script calling the endpoint. */
  direct: () => ExportPost[];
  reset: () => void;
  close: () => Promise<void>;
}

export async function startBenchServer(root: string): Promise<BenchServer> {
  const base = resolve(root);
  const posts: ExportPost[] = [];
  const direct: ExportPost[] = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/__bench/reset') {
        posts.length = 0;
        direct.length = 0;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/zf-mock/export.pdf') {
        const post = parseExportBody(await readBody(req));
        (req.headers['sec-fetch-mode'] === 'navigate' ? posts : direct).push(post);
        const pdf = timetablePdf(post);
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
    direct: () => direct.map((post) => ({ ...post })),
    reset: () => {
      posts.length = 0;
      direct.length = 0;
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

/** A one-page PDF naming the term, so exports of different terms differ like a real site's do. */
export function timetablePdf(post: ExportPost): Buffer {
  const label = `Timetable ${post.year} term ${post.term} ${post.layout}`.replace(/[^\x20-\x7e]/g, '?').replace(/[()\\]/g, '');
  const [width, height] = post.layout === 'landscape' ? [842, 595] : [595, 842];
  const stream = `BT /F1 18 Tf 72 ${height - 96} Td (${label}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
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
