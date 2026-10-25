import { existsSync, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActInput } from '../actions/perform.js';
import { downloadsDir } from '../config/paths.js';
import { RelayError } from '../errors.js';
import type { ModelItem } from '../perception/snapshot.js';
import { assertSaveAs } from '../session/downloads.js';
import type { ReplayPage } from '../session/page.js';
import { chooseLocator, type LocatorKind } from './locate.js';
import {
  stepTarget,
  type BrokenReport,
  type MatrixResult,
  type RunSkillInput,
  type Skill,
  type SkillArtifact,
  type SkillOutcome,
  type SkillRunResult,
  type SkillStep,
  type SkillTarget,
  type StepResult,
  type When,
} from './schema.js';
import { renderTemplate } from './template.js';

type Running = 'undecided' | SkillOutcome;

interface OneStep {
  status: 'done' | 'failed';
  locator?: LocatorKind;
  outcome?: SkillOutcome;
  message?: string;
  broken?: BrokenReport;
  artifact?: SkillArtifact;
  warning?: string;
}

export function expandMatrix(matrix: Record<string, string[]> | undefined, fixed: Record<string, string> = {}): Record<string, string>[] {
  if (!matrix || Object.keys(matrix).length === 0) return [{ ...fixed }];
  let combos: Record<string, string>[] = [{}];
  for (const [key, values] of Object.entries(matrix)) {
    if (values.length === 0) throw new RelayError('bad_params', `matrix ${key} has no values`);
    const next: Record<string, string>[] = [];
    for (const combo of combos) {
      for (const value of values) next.push({ ...combo, [key]: value });
    }
    combos = next;
  }
  return combos.map((combo) => ({ ...fixed, ...combo }));
}

export function summaryExitCode(results: readonly { outcome: string }[]): 0 | 30 {
  return results.some((result) => result.outcome === 'broken') ? 30 : 0;
}

export async function runMatrix(page: ReplayPage, skill: Skill, input: RunSkillInput): Promise<MatrixResult> {
  const combos = expandMatrix(input.matrix, input.params ?? {});
  for (const params of combos) bindSkill(skill, params);
  const outDir = input.out_dir ?? runOutputDir(skill.name);
  await mkdir(outDir, { recursive: true });
  const results: SkillRunResult[] = [];
  for (const params of combos) {
    results.push(await runSkill(page, skill, params, { startUrl: input.startUrl, outDir }));
  }
  return { results, exit_code: summaryExitCode(results), out_dir: outDir };
}

export async function runSkill(
  page: ReplayPage,
  skill: Skill,
  params: Record<string, string>,
  options?: { startUrl?: string; outDir?: string },
): Promise<SkillRunResult> {
  const bound = bindSkill(skill, params);
  const outDir = options?.outDir ?? runOutputDir(skill.name);
  await mkdir(outDir, { recursive: true });
  const started = Date.now();
  await page.navigate(options?.startUrl ?? bound.start_url);
  let outcome: Running = 'undecided';
  let message: string | undefined;
  let broken: BrokenReport | undefined;
  const steps: StepResult[] = [];
  const artifacts: SkillArtifact[] = [];
  const warnings: string[] = [];
  let stop = false;
  for (const step of bound.steps) {
    const stepStarted = Date.now();
    if (stop || !shouldRun(step, outcome)) {
      steps.push({ id: step.id, status: 'skipped', ms: 0 });
      continue;
    }
    const result = await runStep(page, step, outDir);
    steps.push({
      id: step.id,
      status: result.status,
      ...(result.locator ? { locator: result.locator } : {}),
      ms: Date.now() - stepStarted,
    });
    if (result.artifact) artifacts.push(result.artifact);
    if (result.warning) warnings.push(result.warning);
    if (result.broken) {
      broken = result.broken;
      outcome = 'broken';
      stop = true;
      continue;
    }
    if (result.outcome) outcome = result.outcome;
    if (result.message !== undefined) message = result.message;
  }
  if (outcome === 'undecided') outcome = 'ok';
  return {
    outcome,
    ...(message !== undefined ? { message } : {}),
    params,
    steps,
    duration_ms: Date.now() - started,
    ...(broken ? { broken } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function bindSkill(skill: Skill, params: Record<string, string>): Skill {
  const declared = new Set(Object.keys(skill.params));
  const render = (value: string): string => renderTemplate(value, params, declared);
  return {
    ...skill,
    start_url: render(skill.start_url),
    steps: skill.steps.map((step) => bindStep(step, render)),
  };
}

function shouldRun(step: SkillStep, outcome: Running): boolean {
  if (outcome === 'broken' || outcome === 'needs_human') return false;
  if (step.when_outcome) return outcome === step.when_outcome;
  return outcome === 'undecided' || outcome === 'ok';
}

async function runStep(page: ReplayPage, step: SkillStep, outDir: string): Promise<OneStep> {
  try {
    if (step.goto) {
      await page.navigate(step.goto.url);
      return { status: 'done' };
    }
    if (step.expect) return await runExpect(page, step);
    if (step.wait) return await runWait(page, step);
    if (step.download) return await runDownload(page, step, outDir);
    if (step.pdf) return await runPdf(page, step, outDir);
    return await runAct(page, step);
  } catch (err) {
    return { status: 'failed', broken: await report(page, step, reasonOf(err)) };
  }
}

async function runDownload(page: ReplayPage, step: SkillStep, outDir: string): Promise<OneStep> {
  const download = step.download;
  if (!download) return { status: 'done' };
  assertSaveAs(download.save_as);
  const target = download.click.target;
  const model = await page.capture();
  const hit = await locate(page, model.items, target);
  if (!hit) return { status: 'failed', broken: await report(page, step, 'target_not_found') };
  const mark = page.markDownloads();
  try {
    await page.performBackend(hit.backend, { action: 'click' });
    const started = await page.waitForDownloadBegin(mark, download.timeout_ms ?? 30_000);
    if (!started) return { status: 'failed', broken: await report(page, step, 'no_download'), locator: hit.locator };
    const state = await page.waitForDownloadComplete(started);
    if (state === 'canceled') return { status: 'failed', broken: await report(page, step, 'download_canceled'), locator: hit.locator };
    const saved = await page.saveDownload(started, outDir, download.save_as);
    return {
      status: 'done',
      locator: hit.locator,
      artifact: artifactOf(step.id, saved.file),
      ...(saved.deduped ? { warning: `${step.id} save_as ${download.save_as} already existed; saved as ${saved.file.name}` } : {}),
    };
  } catch (err) {
    page.releaseDownloads(mark);
    throw err;
  }
}

async function runPdf(page: ReplayPage, step: SkillStep, outDir: string): Promise<OneStep> {
  const pdf = step.pdf;
  if (!pdf) return { status: 'done' };
  assertSaveAs(pdf.save_as);
  const saved = await page.printPdf({ dir: outDir, fileName: pdf.save_as, landscape: pdf.landscape });
  return {
    status: 'done',
    artifact: artifactOf(step.id, saved.file),
    ...(saved.deduped ? { warning: `${step.id} save_as ${pdf.save_as} already existed; saved as ${saved.file.name}` } : {}),
  };
}

async function runAct(page: ReplayPage, step: SkillStep): Promise<OneStep> {
  const target = stepTarget(step);
  const optional = Boolean(step.press || step.scroll) && !target;
  let locator: LocatorKind | undefined;
  let backend: number | undefined;
  if (target) {
    const model = await page.capture();
    const hit = await locate(page, model.items, target);
    if (!hit) return { status: 'failed', broken: await report(page, step, 'target_not_found') };
    locator = hit.locator;
    backend = hit.backend;
  } else if (!optional) {
    return { status: 'failed', broken: await report(page, step, 'target_not_found') };
  }
  if (step.click) {
    await page.performBackend(requiredBackend(backend), { action: 'click' });
  } else if (step.type) {
    await page.performBackend(requiredBackend(backend), { action: 'type', value: step.type.value, key: step.type.key });
  } else if (step.select) {
    await page.performBackend(requiredBackend(backend), { action: 'select', value: step.select.value });
  } else if (step.press) {
    const input: ActInput = { action: 'press', key: step.press.key };
    if (backend === undefined) await page.performInput(input);
    else await page.performBackend(backend, input);
  } else if (step.scroll) {
    const input: ActInput = { action: 'scroll', value: step.scroll.direction };
    if (backend === undefined) await page.performInput(input);
    else await page.performBackend(backend, input);
  }
  return { status: 'done', locator };
}

async function runWait(page: ReplayPage, step: SkillStep): Promise<OneStep> {
  const wait = step.wait;
  if (!wait) return { status: 'done' };
  if (!wait.target) {
    const waited = await page.waitFor({ text: wait.text, url: wait.url, timeoutMs: wait.timeout_ms ?? 10_000 });
    if (!waited.matched) return { status: 'failed', broken: await report(page, step, 'timeout') };
    return { status: 'done' };
  }
  const deadline = Date.now() + (wait.timeout_ms ?? 10_000);
  for (;;) {
    const model = await page.capture();
    const hit = await locate(page, model.items, wait.target);
    const text = wait.text ? await page.pageText() : '';
    const urlOk = !wait.url || page.currentUrl().includes(wait.url);
    const textOk = !wait.text || text.includes(wait.text);
    if (hit && urlOk && textOk) return { status: 'done', locator: hit.locator };
    if (Date.now() >= deadline) return { status: 'failed', broken: await report(page, step, 'timeout') };
    await delay(200);
  }
}

async function runExpect(page: ReplayPage, step: SkillStep): Promise<OneStep> {
  const expect = step.expect;
  if (!expect) return { status: 'done' };
  const model = await page.capture();
  const text = await page.pageText();
  const facts = { text, url: page.currentUrl(), tableRows: maxTableRows(model.tables) };
  for (const branch of expect.any) {
    if (!holds(branch.when, facts)) continue;
    return { status: 'done', outcome: branch.outcome, message: branch.message };
  }
  return { status: 'failed', broken: await report(page, step, 'expect_unmatched'), outcome: 'broken' };
}

async function locate(page: ReplayPage, items: readonly ModelItem[], target: SkillTarget) {
  const cssBackends = target.css ? await page.queryCss(target.css, target.frame) : [];
  return chooseLocator(items, target, cssBackends);
}

async function report(page: ReplayPage, step: SkillStep, reason: string): Promise<BrokenReport> {
  let excerpt = '';
  try {
    excerpt = await page.excerpt();
  } catch {
    excerpt = '';
  }
  const target = stepTarget(step);
  return {
    step_id: step.id,
    ...(step.intent ? { intent: step.intent } : {}),
    ...(target ? { target } : {}),
    reason,
    excerpt,
  };
}

function holds(when: When, facts: { text: string; url: string; tableRows: number }): boolean {
  if (when.text_present !== undefined && !facts.text.includes(when.text_present)) return false;
  if (when.text_absent !== undefined && facts.text.includes(when.text_absent)) return false;
  if (when.table_rows_min !== undefined && facts.tableRows < when.table_rows_min) return false;
  if (when.url_contains !== undefined && !facts.url.includes(when.url_contains)) return false;
  return true;
}

function maxTableRows(tables: readonly { rows: number }[]): number {
  return tables.reduce((max, table) => Math.max(max, table.rows), 0);
}

function requiredBackend(backend: number | undefined): number {
  if (backend === undefined) throw new RelayError('bad_params', 'Resolved target is missing a backend node');
  return backend;
}

function reasonOf(err: unknown): string {
  if (err instanceof RelayError) return err.code;
  return 'action_failed';
}

function bindStep(step: SkillStep, render: (value: string) => string): SkillStep {
  const next: SkillStep = { id: step.id };
  if (step.intent !== undefined) next.intent = render(step.intent);
  if (step.when_outcome) next.when_outcome = step.when_outcome;
  if (step.goto) next.goto = { url: render(step.goto.url) };
  if (step.click) next.click = { target: bindTarget(step.click.target, render) };
  if (step.type) {
    next.type = {
      target: bindTarget(step.type.target, render),
      value: render(step.type.value),
      ...(step.type.key ? { key: render(step.type.key) } : {}),
    };
  }
  if (step.select) next.select = { target: bindTarget(step.select.target, render), value: render(step.select.value) };
  if (step.press) {
    next.press = {
      key: render(step.press.key),
      ...(step.press.target ? { target: bindTarget(step.press.target, render) } : {}),
    };
  }
  if (step.scroll) {
    next.scroll = {
      ...(step.scroll.target ? { target: bindTarget(step.scroll.target, render) } : {}),
      ...(step.scroll.direction ? { direction: step.scroll.direction } : {}),
    };
  }
  if (step.wait) {
    next.wait = {
      ...(step.wait.text !== undefined ? { text: render(step.wait.text) } : {}),
      ...(step.wait.url !== undefined ? { url: render(step.wait.url) } : {}),
      ...(step.wait.target ? { target: bindTarget(step.wait.target, render) } : {}),
      ...(step.wait.timeout_ms !== undefined ? { timeout_ms: step.wait.timeout_ms } : {}),
    };
  }
  if (step.expect) {
    next.expect = {
      any: step.expect.any.map((branch) => ({
        outcome: branch.outcome,
        when: bindWhen(branch.when, render),
        ...(branch.message !== undefined ? { message: render(branch.message) } : {}),
      })),
    };
  }
  if (step.download) {
    next.download = {
      click: { target: bindTarget(step.download.click.target, render) },
      save_as: render(step.download.save_as),
      ...(step.download.timeout_ms !== undefined ? { timeout_ms: step.download.timeout_ms } : {}),
    };
  }
  if (step.pdf) {
    next.pdf = {
      save_as: render(step.pdf.save_as),
      ...(step.pdf.landscape !== undefined ? { landscape: step.pdf.landscape } : {}),
    };
  }
  return next;
}

function bindTarget(target: SkillTarget, render: (value: string) => string): SkillTarget {
  return {
    role: target.role,
    name: render(target.name),
    ...(target.label !== undefined ? { label: render(target.label) } : {}),
    ...(target.css !== undefined ? { css: render(target.css) } : {}),
    ...(target.text !== undefined ? { text: render(target.text) } : {}),
    ...(target.frame ? { frame: { name: render(target.frame.name), url: render(target.frame.url) } } : {}),
  };
}

function bindWhen(when: When, render: (value: string) => string): When {
  return {
    ...(when.text_present !== undefined ? { text_present: render(when.text_present) } : {}),
    ...(when.text_absent !== undefined ? { text_absent: render(when.text_absent) } : {}),
    ...(when.table_rows_min !== undefined ? { table_rows_min: when.table_rows_min } : {}),
    ...(when.url_contains !== undefined ? { url_contains: render(when.url_contains) } : {}),
  };
}

function artifactOf(stepId: string, file: { path: string; bytes: number; sha256: string }): SkillArtifact {
  return { step_id: stepId, path: file.path, bytes: file.bytes, sha256: file.sha256 };
}

/** One directory for every combo in a matrix run, so rendered names stay comparable. */
export function runOutputDir(skillName: string, at = new Date()): string {
  const root = join(downloadsDir(), skillName);
  const stamp = runStamp(at);
  let dir = join(root, stamp);
  let extra = 2;
  while (existsSync(dir)) {
    dir = join(root, `${stamp}-${extra}`);
    extra += 1;
  }
  mkdirSync(root, { recursive: true });
  return dir;
}

function runStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
