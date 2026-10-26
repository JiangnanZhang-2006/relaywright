import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

export async function startStatic(root: string): Promise<{ port: number; close: () => Promise<void> }> {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/mock-llm/v1/chat/completions') {
        const raw = await readBody(req);
        // JSON.stringify escapes newlines, so a real [^\n] would span the whole snapshot.
        const ref = /\[(e\d+)\](?:(?!\\n).)*检索/.exec(raw)?.[1] ?? null;
        const content = JSON.stringify({ ref, reason: ref ? 'button text is 检索' : 'no 检索 ref' });
        const payload = {
          id: 'mock-heal',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        };
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(payload));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/zf-mock/export.pdf') {
        await drain(req);
        const pdf = await readFile(join(base, 'sample.pdf'));
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition': 'inline; filename="kb.pdf"',
          'cache-control': 'no-store',
        });
        res.end(pdf);
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/protected/zf' || url.pathname.startsWith('/protected/zf/'))) {
        const allowed = (req.headers.cookie ?? '').split(';').some((part) => part.trim() === 'mocksession=1');
        if (!allowed) {
          const service = `http://${req.headers.host ?? '127.0.0.1'}${url.pathname}`;
          res.writeHead(302, {
            location: `/cas-mock/?service=${encodeURIComponent(service)}`,
            'cache-control': 'no-store',
          });
          res.end();
          return;
        }
        const root = resolve(base, 'zf-mock', 'v1');
        let rel = url.pathname.slice('/protected/zf'.length);
        if (rel === '' || rel.endsWith('/')) rel = `${rel}index.html`;
        const file = resolve(root, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
        if (file !== root && !file.startsWith(`${root}${sep}`)) {
          res.writeHead(403);
          res.end();
          return;
        }
        let data = await readFile(file);
        if (extname(file) === '.html') {
          const html = data.toString('utf8').replace(/<form id="login-box">[\s\S]*?<\/form>/, '');
          data = Buffer.from(html, 'utf8');
        }
        res.writeHead(200, { 'content-type': mime(extname(file)), 'cache-control': 'no-store' });
        res.end(data);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/privacy-home/roster.txt') {
        const filename = encodeURIComponent('张三-20210001.txt');
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="roster.txt"; filename*=UTF-8''${filename}`,
          'cache-control': 'no-store',
        });
        res.end('roster');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/zf-mock/attachment.pdf') {
        const pdf = await readFile(join(base, 'sample.pdf'));
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="notes.pdf"',
          'cache-control': 'no-store',
        });
        res.end(pdf);
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
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': mime(extname(file)), 'cache-control': 'no-store' });
      res.end(data);
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
    close: () => closeServer(server),
  };
}

async function drain(req: IncomingMessage): Promise<void> {
  if (req.readableEnded) return;
  for await (const chunk of req) {
    void chunk;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function mime(extension: string): string {
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((err) => (err ? rejectClose(err) : resolveClose()));
  });
}
