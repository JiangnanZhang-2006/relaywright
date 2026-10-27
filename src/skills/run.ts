import { existsSync, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActInput } from '../actions/perform.js';
import { relaywrightHome } from '../config/paths.js';
import { activeDownloadsDir } from '../config/runtime.js';
import { RelayError } from '../errors.js';
import type { ModelItem } from '../perception/snapshot.js';
import { assertSaveAs } from '../session/downloads.js';
import { pageNeedsLogin } from '../session/login.js';
import type { ReplayPage } from '../session/page.js';
import { parseStateValue, statePut } from '../state/store.js';
import { resolveStateText, resolveStateValue } from '../state/template.js';
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
  type HealContext,
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

export function summaryExitCode(results: readonly { outcome: string }[]): 0 | 20 | 30 {
  if (results.some((result) => result.outcome === 'broken')) return 30;
  if (results.some((result) => result.outcome === 'needs_human')) return 20;
  return 0;
}

export type PriorOutcome = 'undecided' | 'ok' | 'empty';

export interface FailureSite {
  step: SkillStep;
  reason: string;
  params: Record<string, string>;
  priorOutcome: PriorOutcome;
  outDir: string;
  /** True when every locator missed, including a download whose click target was missing. */
  healable: boolean;
  missingTarget: boolean;
  /** Steps that already finished before this failure. */
  completed?: StepResult[];
  artifacts?: SkillArtifact[];
  warnings?: string[];
  /** Combinations the matrix has not started. */
  remaining?: Record<string, string>[];
}

export interface RunHooks {
  waitForHuman?: (reason: string) => Promise<'done' | 'cancelled' | 'timeout'>;
  onFailure?: (site: FailureSite) => Promise<HealContext | undefined>;
}

export function stopsMatrix(result: { outcome: string; broken?: { reason?: string; heal?: unknown } }): boolean {
  const reason = result.broken?.reason;
  if (result.outcome !== 'broken' || !result.broken?.heal) return false;
  return reason === 'target_not_found' || reason === 'no_download';
}

export async function runMatrix(page: ReplayPage, skill: Skill, input: RunSkillInput, hooks?: RunHooks): Promise<MatrixResult> {
  const combos = expandMatrix(input.matrix, input.params ?? {});
  for (const params of combos) bindSkill(skill, params);
  const outDir = input.out_dir ?? runOutputDir(skill.name);
  await mkdir(outDir, { recursive: true });
  const results: SkillRunResult[] = [];
  const waitForHuman = input.wait_human ? hooks?.waitForHuman : undefined;
  let halt = false;
  for (let index = 0; index < combos.length; index += 1) {
    const params = combos[index];
    if (!params) continue;
    if (halt) {
      results.push(skippedCombo(skill, params));
      continue;
    }
    const remaining = combos.slice(index + 1);
    const comboHooks: RunHooks | undefined = hooks?.onFailure
      ? { ...hooks, onFailure: (site) => hooks.onFailure!({ ...site, remaining }) }
      : hooks;
    const result = await runSkill(page, skill, params, { startUrl: input.startUrl, outDir, waitForHuman }, comboHooks);
    results.push(result);
    if (result.halt_matrix) halt = true;
  }
  return { results, exit_code: summaryExitCode(results), out_dir: outDir };
}

export async function runSkill(
  page: ReplayPage,
  skill: Skill,
  params: Record<string, string>,
  options?: { startUrl?: string; outDir?: string; waitForHuman?: RunHooks['waitForHuman'] },
  hooks?: RunHooks,
): Promise<SkillRunResult> {
  const bound = bindSkill(skill, params);
  let startUrl: string;
  try {
    startUrl = await resolveStateText(options?.startUrl ?? bound.start_url);
  } catch (err) {
    // A missing state value is a broken step. The previous page must not be treated as a login wall.
    return failedBeforeSteps(bound, params, reasonOf(err), Date.now());
  }
  const nextOptions = { ...options, startUrl };
  let last = await runSkillOnce(page, skill, params, nextOptions, hooks);
  if (!(await comboNeedsHuman(page, startUrl, last))) return last;
  const message = last.message ?? 'Login required';
  if (!options?.waitForHuman) return humanResult(last, message);
  const host = hostOf(page.currentUrl());
  const decision = await options.waitForHuman(`skill ${skill.name}: 登录 ${host}`);
  if (decision !== 'done') return humanResult(last, message);
  last = await runSkillOnce(page, skill, params, nextOptions, hooks);
  if (await comboNeedsHuman(page, startUrl, last)) return humanResult(last, last.message ?? message);
  return last;
}

export async function resumeFromStep(
  page: ReplayPage,
  skill: Skill,
  params: Record<string, string>,
  fromStepId: string,
  target: SkillTarget,
  prior: PriorOutcome,
  outDir: string,
): Promise<SkillRunResult> {
  const index = skill.steps.findIndex((step) => step.id === fromStepId);
  if (index < 0) throw new RelayError('bad_params', `Step ${fromStepId} was not found`);
  const steps = skill.steps.map((step, cursor) => (cursor === index ? replaceStepTarget(step, target) : step));
  const started = Date.now();
  await mkdir(outDir, { recursive: true });
  const played = await driveSteps(page, steps, outDir, prior, undefined, params, index);
  const outcome = played.outcome === 'undecided' ? 'ok' : played.outcome;
  return {
    outcome,
    ...(played.message !== undefined ? { message: played.message } : {}),
    params,
    steps: played.steps,
    duration_ms: Date.now() - started,
    ...(played.broken ? { broken: played.broken } : {}),
    ...(played.artifacts.length > 0 ? { artifacts: played.artifacts } : {}),
    ...(played.warnings.length > 0 ? { warnings: played.warnings } : {}),
  };
}

/** Prefix steps already ran. The resumed tail is the verification replay, so the combination is not started over. */
export function mergeResumedRun(
  prefix: { steps: readonly StepResult[]; artifacts?: readonly SkillArtifact[]; warnings?: readonly string[] },
  replay: SkillRunResult,
): SkillRunResult {
  const artifacts = [...(prefix.artifacts ?? []), ...(replay.artifacts ?? [])];
  const warnings = [...(prefix.warnings ?? []), ...(replay.warnings ?? [])];
  return {
    outcome: replay.outcome,
    ...(replay.message !== undefined ? { message: replay.message } : {}),
    params: replay.params,
    steps: [...prefix.steps, ...replay.steps],
    duration_ms: prefix.steps.reduce((sum, step) => sum + step.ms, 0) + replay.duration_ms,
    ...(replay.broken ? { broken: replay.broken } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(replay.halt_matrix ? { halt_matrix: true } : {}),
  };
}

export function replaceStepTarget(step: SkillStep, target: SkillTarget): SkillStep {
  if (step.click) return { ...step, click: { target } };
  if (step.type) return { ...step, type: { ...step.type, target } };
  if (step.select) return { ...step, select: { ...step.select, target } };
  if (step.press?.target) return { ...step, press: { ...step.press, target } };
  if (step.scroll?.target) return { ...step, scroll: { ...step.scroll, target } };
  if (step.wait?.target) return { ...step, wait: { ...step.wait, target } };
  if (step.download) return { ...step, download: { ...step.download, click: { target } } };
  throw new RelayError('bad_params', `Step ${step.id} has no target to replace`);
}

async function runSkillOnce(
  page: ReplayPage,
  skill: Skill,
  params: Record<string, string>,
  options?: { startUrl?: string; outDir?: string },
  hooks?: RunHooks,
): Promise<SkillRunResult> {
  const bound = bindSkill(skill, params);
  const outDir = options?.outDir ?? runOutputDir(skill.name);
  await mkdir(outDir, { recursive: true });
  const started = Date.now();
  let startUrl: string;
  try {
    startUrl = await resolveStateText(options?.startUrl ?? bound.start_url);
  } catch (err) {
    return failedBeforeSteps(bound, params, reasonOf(err), started);
  }
  await page.navigate(startUrl);
  if (await loginGate(page, startUrl)) {
    return {
      outcome: 'needs_human',
      message: 'Login required',
      params,
      steps: bound.steps.map((step) => ({ id: step.id, status: 'skipped' as const, ms: 0 })),
      duration_ms: Date.now() - started,
    };
  }
  const played = await driveSteps(page, bound.steps, outDir, 'undecided', hooks, params, 0, {});
  const outcome = played.outcome === 'undecided' ? 'ok' : played.outcome;
  return {
    outcome,
    ...(played.message !== undefined ? { message: played.message } : {}),
    params,
    steps: played.steps,
    duration_ms: Date.now() - started,
    ...(played.broken ? { broken: played.broken } : {}),
    ...(played.artifacts.length > 0 ? { artifacts: played.artifacts } : {}),
    ...(played.warnings.length > 0 ? { warnings: played.warnings } : {}),
    ...(played.halt ? { halt_matrix: true } : {}),
  };
}

async function driveSteps(
  page: ReplayPage,
  steps: readonly SkillStep[],
  outDir: string,
  prior: Running,
  hooks: RunHooks | undefined,
  params: Record<string, string>,
  startIndex: number,
  memory: Record<string, unknown> = {},
): Promise<{
  outcome: Running;
  message?: string;
  broken?: BrokenReport;
  steps: StepResult[];
  artifacts: SkillArtifact[];
  warnings: string[];
  halt: boolean;
}> {
  const extractSteps = priorExtractSteps(steps, startIndex);
  let outcome: Running = prior;
  let message: string | undefined;
  let broken: BrokenReport | undefined;
  const done: StepResult[] = [];
  const artifacts: SkillArtifact[] = [];
  const warnings: string[] = [];
  let stop = false;
  let halt = false;
  for (let index = startIndex; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step) continue;
    const stepStarted = Date.now();
    if (stop || !shouldRun(step, outcome)) {
      done.push({ id: step.id, status: 'skipped', ms: 0 });
      continue;
    }
    const result = await runStep(page, step, outDir, memory, extractSteps);
    done.push({
      id: step.id,
      status: result.status,
      ...(result.locator ? { locator: result.locator } : {}),
      ms: Date.now() - stepStarted,
    });
    if (result.artifact) artifacts.push(result.artifact);
    if (result.warning) warnings.push(result.warning);
    if (result.broken) {
      const reason = result.broken.reason;
      const missingTarget = result.locator === undefined && (reason === 'target_not_found' || reason === 'no_download');
      const healable = reason === 'target_not_found' || (reason === 'no_download' && missingTarget);
      let next = result.broken;
      if ((healable || reason === 'expect_unmatched') && hooks?.onFailure) {
        const heal = await hooks.onFailure({
          step,
          reason,
          params,
          priorOutcome: asPrior(outcome),
          outDir,
          healable,
          missingTarget,
          completed: done.slice(0, -1),
          artifacts: [...artifacts],
          warnings: [...warnings],
        });
        if (heal) next = { ...next, heal };
      }
      broken = next;
      outcome = 'broken';
      if (healable) halt = true;
      stop = true;
      continue;
    }
    if (result.outcome) outcome = result.outcome;
    if (result.message !== undefined) message = result.message;
  }
  return { outcome, ...(message !== undefined ? { message } : {}), ...(broken ? { broken } : {}), steps: done, artifacts, warnings, halt };
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

function priorExtractSteps(steps: readonly SkillStep[], startIndex: number): Record<string, string> {
  const hints: Record<string, string> = {};
  for (let index = 0; index < startIndex; index += 1) {
    const step = steps[index];
    if (step?.extract) hints[step.extract.save_as] = step.id;
  }
  return hints;
}

function shouldRun(step: SkillStep, outcome: Running): boolean {
  if (outcome === 'broken' || outcome === 'needs_human') return false;
  if (step.when_outcome) return outcome === step.when_outcome;
  return outcome === 'undecided' || outcome === 'ok';
}

async function runStep(
  page: ReplayPage,
  step: SkillStep,
  outDir: string,
  memory: Record<string, unknown>,
  extractSteps: Record<string, string>,
): Promise<OneStep> {
  let current = step;
  try {
    current = await resolveStateValue(step, relaywrightHome(), { extract: memory, extractSteps });
    if (current.extract) return await runExtract(page, current, memory);
    if (current.state_set) return await runStateSet(current);
    if (current.goto) {
      await page.navigate(current.goto.url);
      return { status: 'done' };
    }
    if (current.expect) return await runExpect(page, current);
    if (current.wait) return await runWait(page, current);
    if (current.download) return await runDownload(page, current, outDir);
    if (current.pdf) return await runPdf(page, current, outDir);
    return await runAct(page, current);
  } catch (err) {
    return { status: 'failed', broken: await report(page, current, reasonOf(err)) };
  }
}

async function runExtract(page: ReplayPage, step: SkillStep, memory: Record<string, unknown>): Promise<OneStep> {
  const action = step.extract;
  if (!action) return { status: 'done' };
  const result = await page.extract({
    root_selector: action.root_selector,
    fields: action.fields,
    ...(action.limit !== undefined ? { limit: action.limit } : {}),
  });
  memory[action.save_as] = result.rows;
  return { status: 'done' };
}

async function runStateSet(step: SkillStep): Promise<OneStep> {
  const action = step.state_set;
  if (!action) return { status: 'done' };
  await statePut(action.ns, action.key, parseStateValue(action.value));
  return { status: 'done' };
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
    if (await targetsPassword(page, backend)) return passwordStep();
    await page.performBackend(requiredBackend(backend), { action: 'type', value: step.type.value, key: step.type.key });
  } else if (step.select) {
    await page.performBackend(requiredBackend(backend), { action: 'select', value: step.select.value });
  } else if (step.press) {
    if (backend !== undefined && (await targetsPassword(page, backend))) return passwordStep();
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

async function comboNeedsHuman(page: ReplayPage, startUrl: string, result: SkillRunResult): Promise<boolean> {
  if (result.outcome === 'needs_human') return true;
  if (result.outcome !== 'broken') return false;
  return loginGate(page, startUrl);
}

async function loginGate(page: ReplayPage, startUrl: string): Promise<boolean> {
  let visible = false;
  try {
    visible = await page.hasVisiblePassword();
  } catch {
    visible = false;
  }
  return pageNeedsLogin(page.currentUrl(), startUrl, visible);
}

async function targetsPassword(page: ReplayPage, backend: number | undefined): Promise<boolean> {
  if (backend === undefined) return false;
  try {
    return await page.isPasswordBackend(backend);
  } catch {
    return false;
  }
}

function passwordStep(): OneStep {
  return { status: 'failed', outcome: 'needs_human', message: 'Passwords are typed by a human. Call request_human.' };
}

function humanResult(result: SkillRunResult, message: string): SkillRunResult {
  const { broken: _broken, halt_matrix: _halt, ...rest } = result;
  return { ...rest, outcome: 'needs_human', message };
}

function asPrior(outcome: Running): PriorOutcome {
  if (outcome === 'ok' || outcome === 'empty') return outcome;
  return 'undecided';
}

function skippedCombo(skill: Skill, params: Record<string, string>): SkillRunResult {
  return {
    outcome: 'skipped',
    message: 'skipped because an earlier combination is broken',
    params,
    steps: skill.steps.map((step) => ({ id: step.id, status: 'skipped' as const, ms: 0 })),
    duration_ms: 0,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function reasonOf(err: unknown): string {
  if (err instanceof RelayError) {
    if (err.code === 'state_missing' || err.code === 'extract_missing' || err.code === 'domain_not_allowed') {
      return `${err.code}: ${err.message}`;
    }
    return err.code;
  }
  const message = err instanceof Error ? err.message.trim() : '';
  return message ? `action_failed: ${message}` : 'action_failed';
}

function failedBeforeSteps(skill: Skill, params: Record<string, string>, reason: string, started: number): SkillRunResult {
  return {
    outcome: 'broken',
    params,
    steps: skill.steps.map((step) => ({ id: step.id, status: 'skipped' as const, ms: 0 })),
    duration_ms: Date.now() - started,
    broken: { step_id: 'start', reason, excerpt: '' },
  };
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
  if (step.state_set) {
    next.state_set = {
      ns: render(step.state_set.ns),
      key: render(step.state_set.key),
      value: render(step.state_set.value),
    };
  }
  if (step.extract) {
    next.extract = {
      root_selector: render(step.extract.root_selector),
      save_as: render(step.extract.save_as),
      ...(step.extract.limit !== undefined ? { limit: step.extract.limit } : {}),
      fields: bindExtractFields(step.extract.fields, render),
    };
  }
  return next;
}

function bindExtractFields(
  fields: NonNullable<SkillStep['extract']>['fields'],
  render: (value: string) => string,
): NonNullable<SkillStep['extract']>['fields'] {
  const out: NonNullable<SkillStep['extract']>['fields'] = {};
  for (const [name, field] of Object.entries(fields)) {
    out[name] = {
      selector: render(field.selector),
      ...(field.attr !== undefined ? { attr: render(field.attr) } : {}),
      ...(field.all !== undefined ? { all: field.all } : {}),
    };
  }
  return out;
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
  const root = join(activeDownloadsDir(), skillName);
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
