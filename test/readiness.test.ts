import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserDownloadingMessage, RelayError } from '../src/errors.js';
import { createApp } from '../src/daemon/server.js';
import type { BrowserControl } from '../src/session/browser.js';
import { BrowserSession } from '../src/session/browser.js';

function control(partial: Partial<BrowserControl> & Pick<BrowserControl, 'browserState'>): BrowserControl {
  const fail = async () => {
    throw new RelayError('browser_not_ready', browserDownloadingMessage(42));
  };
  return {
    status: async () => ({ pid: process.pid, uptime: 0.1, browser: partial.browserState() }),
    navigate: fail,
    snapshot: fail,
    act: async () => {
      throw new RelayError('stale_ref', 'Unknown ref e9. Take a new snapshot.');
    },
    download: fail,
    pdf: fail,
    waitFor: fail,
    trace: () => ({ id: 'trace-test', path: 'trace-test.jsonl', steps: [] }),
    clearTrace: () => ({ id: 'trace-test', path: 'trace-test.jsonl', steps: [] }),
    saveSkill: () => {
      throw new RelayError('bad_params', 'not used');
    },
    listSkills: () => [],
    readSkill: () => {
      throw new RelayError('skill_not_found', 'not used');
    },
    skillHistory: () => {
      throw new RelayError('skill_not_found', 'not used');
    },
    rollbackSkill: () => {
      throw new RelayError('skill_not_found', 'not used');
    },
    runSkill: fail,
    requestHandoff: fail,
    waitHandoff: fail,
    cancelHandoff: fail,
    listIdentities: () => [],
    saveIdentity: fail,
    revokeIdentity: fail,
    redactOutbound: <T>(value: T) => value,
    privacyMode: () => ({ model_redaction: false, scope: 'global' as const }),
    privacyAdd: () => {
      throw new RelayError('bad_request', 'not used');
    },
    privacyConfirm: () => {
      throw new RelayError('bad_request', 'not used');
    },
    privacyList: () => ({ identity: null, self: [] }),
    privacyCheck: () => ({ identity: null, lines: [], counts: { self: 0, others: 0, candidates: 0 } }),
    privacyMark: fail,
    tabs: async () => ({ tabs: [], text: '' }),
    ...partial,
    skillPatch: partial.skillPatch ?? fail,
  };
}

describe('browser readiness', () => {
  it('returns 503 immediately while the browser is downloading and does not leak the token', async () => {
    const session = control({ browserState: () => ({ state: 'downloading', percent: 42 }) });
    const app = createApp({ token: 'secret-token', session, onShutdown: () => undefined });
    const health = await app.request('http://127.0.0.1/health');
    const healthBody = (await health.json()) as { browser?: { state: string; percent?: number }; token?: string };
    expect(healthBody.browser).toEqual({ state: 'downloading', percent: 42 });
    expect(healthBody.token).toBeUndefined();

    const started = Date.now();
    const response = await app.request('http://127.0.0.1/snapshot', {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('browser_not_ready');
    expect(body.error.message).toBe(browserDownloadingMessage(42));
  });

  it('maps stale_ref to 409 and answers status without waiting', async () => {
    const session = control({ browserState: () => ({ state: 'launching' }) });
    const app = createApp({ token: 'secret-token', session, onShutdown: () => undefined });
    const started = Date.now();
    const status = await app.request('http://127.0.0.1/status', {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as { browser: { state: string } };
    expect(statusBody.browser.state).toBe('launching');

    const missing = await app.request('http://127.0.0.1/act', {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'click', ref: 'e9' }),
    });
    expect(missing.status).toBe(409);
    const body = (await missing.json()) as { error: { code: string } };
    expect(body.error.code).toBe('stale_ref');
  });

  it('reports an unmatched wait as a normal result, not an error', async () => {
    const session = control({
      browserState: () => ({ state: 'ready' }),
      waitFor: async () => ({ matched: false, url: 'http://x/', title: 't', snapshot: '(no changes)' }),
    });
    const app = createApp({ token: 'secret-token', session, onShutdown: () => undefined });
    const response = await app.request('http://127.0.0.1/wait', {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'never' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ matched: false, snapshot: '(no changes)' });
  });

  it('keeps the handoff start route private', async () => {
    const session = control({ browserState: () => ({ state: 'ready' }) });
    const app = createApp({ token: 'secret-token', session, onShutdown: () => undefined });
    const denied = await app.request('http://127.0.0.1/handoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: '登录' }),
    });
    expect(denied.status).toBe(401);
  });

  it('does not block status or snapshot on an in-progress browser launch', async () => {
    process.env.RELAYWRIGHT_HOME = mkdtempSync(join(tmpdir(), 'relaywright-ready-'));
    let release: (path: string) => void = () => undefined;
    const pending = new Promise<{ source: 'edge'; path: string }>((resolve) => {
      release = (path) => resolve({ source: 'edge', path });
    });
    const session = new BrowserSession({
      resolveExecutable: (onProgress) => {
        onProgress?.(42);
        return pending;
      },
    });
    session.warmUp();
    const started = Date.now();
    const status = await session.status();
    await expect(session.snapshot()).rejects.toMatchObject({ code: 'browser_not_ready' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(status.browser.state).toBe('downloading');
    expect(status.browser.percent).toBe(42);
    await session.close();
    release('unused');
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
