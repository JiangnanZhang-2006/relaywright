import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setEvalEnabled } from '../src/config/runtime.js';
import { createApp } from '../src/daemon/server.js';
import { readGlobalConfig, updateGlobalConfig } from '../src/privacy/store.js';
import { EXTRACT_SOURCE } from '../src/perception/extract-script.js';
import { EXTRACT_NULL_WARNING, normalizeExtract, parseExtractField, withExtractWarning } from '../src/perception/extract.js';
import { formatVisibleText } from '../src/session/page.js';
import type { BrowserControl } from '../src/session/browser.js';
import type { ReplayPage } from '../src/session/page.js';
import type { Skill } from '../src/skills/schema.js';
import { resumeFromStep, runSkill } from '../src/skills/run.js';
import { resolveStateText } from '../src/state/template.js';

describe('extract and eval', () => {
  it('parses field specs and rejects a bad limit', () => {
    expect(parseExtractField('title=.title')).toEqual({ name: 'title', selector: '.title' });
    expect(parseExtractField('link=.link@href')).toEqual({ name: 'link', selector: '.link', attr: 'href' });
    expect(parseExtractField('tags=.tag*')).toEqual({ name: 'tags', selector: '.tag', all: true });
    expect(parseExtractField('secret=.secret@value*')).toEqual({ name: 'secret', selector: '.secret', attr: 'value', all: true });
    expect(normalizeExtract({ root_selector: '.row', fields: { title: { selector: '.title' } } }).limit).toBe(200);
    expect(() => normalizeExtract({ root_selector: '.row', fields: { title: { selector: '.title' } }, limit: 2001 })).toThrow(/2000/);
    expect(() => normalizeExtract({ root_selector: '.row', fields: { frame: { selector: '.x' } } })).toThrow(/frame/);
  });

  it('reads :scope from the row and omits frame on the top document', () => {
    const heading = element('H1', '只需 3 步');
    const page = documentOf([heading], 'https://example.test/guide');
    const top = runExtract(page, { root_selector: 'h1', fields: { t: { selector: ' :scope ' } }, limit: 10 });
    expect(top.rows).toEqual([{ t: '只需 3 步' }]);

    const paragraph = element('P', 'inside');
    const frame = element('IFRAME');
    frame.attrs.name = 'extra';
    frame.contentDocument = documentOf([paragraph], 'https://example.test/frame.html');
    frame.contentWindow = { location: { href: 'https://example.test/frame.html' } };
    const nested = runExtract(documentOf([frame], 'https://example.test/'), {
      root_selector: 'p',
      fields: { t: { selector: ':scope' } },
      limit: 10,
    });
    expect(nested.rows).toEqual([{ frame: { name: 'extra', url: 'https://example.test/frame.html' }, t: 'inside' }]);
  });

  it('warns when every extracted field is null', () => {
    expect(withExtractWarning({ rows: [{ t: null }, { t: null }], limit: 200, truncated: false }).warning).toBe(EXTRACT_NULL_WARNING);
    expect(withExtractWarning({ rows: [{ t: 'ok' }], limit: 200, truncated: false }).warning).toBeUndefined();
    expect(withExtractWarning({ rows: [], limit: 200, truncated: false }).warning).toBeUndefined();
  });

  it('collapses visible text and truncates by character', () => {
    expect(formatVisibleText({ title: 'ICT', url: 'https://example.test', text: 'a\n\n\n\nb  \n' })).toBe(
      'page: ICT  url: https://example.test\na\n\nb',
    );
    const trimmed = formatVisibleText({ title: 'T', url: 'https://e', text: '汉字汉字', maxChars: 2 });
    expect(trimmed).toBe('page: T  url: https://e\n汉字\n[truncated]');
    expect(() => formatVisibleText({ title: 'T', url: 'https://e', text: 'a', maxChars: 50_001 })).toThrow(/max_chars/);
  });

  it('fills extract templates from the current run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rw-extract-'));
    const bag = { rows: [{ title: 'Item 1', n: 2, tags: ['a', 'b'] }] };
    expect(await resolveStateText('http://127.0.0.1/{{extract.rows.0.title}}/{{extract.rows.0.n}}', root, { extract: bag })).toBe(
      'http://127.0.0.1/Item 1/2',
    );
    expect(await resolveStateText('{{extract.rows.0.tags.1}}', root, { extract: bag })).toBe('b');
    await expect(resolveStateText('{{extract.missing.0}}', root, { extract: bag })).rejects.toMatchObject({ code: 'extract_missing' });
  });

  it('lets a later step read an extract step', async () => {
    const visits: string[] = [];
    const page = fake(visits);
    const skill: Skill = {
      name: 'extract-note',
      description: 'read a row',
      version: 1,
      start_url: 'http://127.0.0.1/start',
      params: {},
      steps: [
        {
          id: 'read',
          extract: {
            root_selector: '.row',
            save_as: 'rows',
            fields: { title: { selector: '.title' } },
          },
        },
        { id: 'go', goto: { url: 'http://127.0.0.1/{{extract.rows.0.title}}' } },
      ],
    };
    const ran = await runSkill(page, skill, {}, { outDir: mkdtempSync(join(tmpdir(), 'rw-extract-out-')) });
    expect(ran.outcome).toBe('ok');
    expect(visits).toEqual(['http://127.0.0.1/start', 'http://127.0.0.1/Item 1']);
  });

  it('names the extract step to re-run when a resume skipped it', async () => {
    const page = fake([]);
    page.queryCss = async () => [7];
    const skill: Skill = {
      name: 'extract-note',
      description: 'read a row',
      version: 1,
      start_url: 'http://127.0.0.1/start',
      params: {},
      steps: [
        {
          id: 'read',
          extract: {
            root_selector: '.row',
            save_as: 'rows',
            fields: { title: { selector: '.title' } },
          },
        },
        { id: 'fix', click: { target: { role: 'button', name: 'go', css: '#go' } } },
        { id: 'open', goto: { url: 'http://127.0.0.1/{{extract.rows.0.title}}' } },
      ],
    };
    const resumed = await resumeFromStep(page, skill, {}, 'fix', { role: 'button', name: 'go', css: '#go' }, 'undecided', mkdtempSync(join(tmpdir(), 'rw-extract-resume-')));
    expect(resumed.outcome).toBe('broken');
    expect(resumed.broken?.reason).toContain('extract_missing');
    expect(resumed.broken?.reason).toContain('Re-run extract step read');
  });

  it('refuses eval until it is enabled and keeps other config keys', async () => {
    const session = {
      redactOutbound: <T>(value: T): T => value,
      evalExpr: async () => {
        throw new Error('eval should not run while disabled');
      },
    } as unknown as BrowserControl;
    const app = createApp({ token: 'extract-token', session, onShutdown: () => undefined });
    const denied = await app.request('http://127.0.0.1/eval', {
      method: 'POST',
      headers: { authorization: 'Bearer extract-token', 'content-type': 'application/json' },
      body: JSON.stringify({ expr: 'return 1' }),
    });
    expect(denied.status).toBe(400);
    const body = (await denied.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('eval_disabled');
    expect(body.error.message).toContain('relaywright config set eval on');
    expect(body.error.message).toContain('RELAYWRIGHT_EVAL=on');

    const root = mkdtempSync(join(tmpdir(), 'rw-eval-config-'));
    updateGlobalConfig((config) => {
      config.heal = { model: 'keep-me' };
    }, root);
    expect(setEvalEnabled(true, root)).toBe(true);
    expect(readGlobalConfig(root).heal?.model).toBe('keep-me');
    expect(readGlobalConfig(root).eval).toBe(true);
  });
});

class MiniElement {
  nodeType = 1;
  children: MiniElement[] = [];
  attrs: Record<string, string> = {};
  text = '';
  id = '';
  contentDocument: MiniDocument | null = null;
  contentWindow: { location: { href: string } } | null = null;

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? (name === 'id' ? this.id || null : null);
  }

  querySelectorAll(selector: string): MiniElement[] {
    if (selector === ':scope') throw new Error('querySelectorAll(:scope)');
    const want = selector.split(',').map((part) => part.trim().toLowerCase());
    const found: MiniElement[] = [];
    const walk = (node: MiniElement): void => {
      for (const child of node.children) {
        if (want.includes(child.tagName.toLowerCase())) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

class MiniDocument {
  constructor(
    readonly children: MiniElement[],
    readonly href: string,
  ) {}

  querySelectorAll(selector: string): MiniElement[] {
    const root = new MiniElement('HTML');
    root.children = this.children;
    return root.querySelectorAll(selector);
  }
}

function element(tag: string, text = ''): MiniElement {
  const node = new MiniElement(tag);
  node.text = text;
  return node;
}

function documentOf(children: MiniElement[], href: string): MiniDocument {
  return new MiniDocument(children, href);
}

interface ExtractRequest {
  root_selector: string;
  fields: Record<string, { selector: string }>;
  limit: number;
}

function runExtract(document: MiniDocument, request: ExtractRequest): { rows: Record<string, unknown>[]; truncated: boolean } {
  const fn = new Function('request', 'document', 'location', EXTRACT_SOURCE) as (
    request: ExtractRequest,
    document: MiniDocument,
    location: { href: string },
  ) => { rows: Record<string, unknown>[]; truncated: boolean };
  return fn(request, document, { href: document.href });
}

function fake(visits: string[]): ReplayPage {
  let url = 'about:blank';
  return {
    navigate: async (next) => {
      visits.push(next);
      url = next;
      return { url: next, title: 't', snapshot: '' };
    },
    capture: async () => ({ items: [], tables: [], url }),
    currentUrl: () => url,
    pageText: async () => '',
    extract: async () => ({
      rows: [{ frame: { name: '', url }, title: 'Item 1' }],
      limit: 200,
      truncated: false,
    }),
    evalExpr: async () => {
      throw new Error('eval was not expected');
    },
    queryCss: async () => [],
    hasVisiblePassword: async () => false,
    isPasswordBackend: async () => false,
    performBackend: async () => undefined,
    performInput: async () => undefined,
    waitFor: async () => ({ matched: true, url, title: 't', snapshot: '' }),
    excerpt: async () => '',
    fullSnapshot: async () => '',
    documentEpoch: () => 1,
    markDownloads: () => 1,
    releaseDownloads: () => undefined,
    waitForDownloadBegin: async () => null,
    waitForDownloadComplete: async () => 'completed',
    saveDownload: async () => {
      throw new Error('download was not expected');
    },
    printPdf: async () => {
      throw new Error('pdf was not expected');
    },
  };
}
