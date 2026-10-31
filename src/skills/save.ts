import { RelayError } from '../errors.js';
import { issuesText } from '../protocol.js';
import type { TargetDescriptor, TraceStep } from '../recorder/types.js';
import { fileExtension } from '../session/downloads.js';
import { rowScoped } from './locate.js';
import { SkillSchema, type CheckInput, type Skill, type SkillStep, type SkillTarget } from './schema.js';
import { templatize, tokenIndex, type ExampleParam, type TemplateMiss, type TemplatePlace } from './template.js';

export interface BuiltSkill {
  skill: Skill;
  warnings: string[];
}

export function makeStepId(index: number, action: string, targetName?: string): string {
  const slug = slugTarget(targetName ?? '');
  return slug ? `s${index}-${action}-${slug}` : `s${index}-${action}`;
}

export function slugTarget(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function buildSkill(steps: readonly TraceStep[], input: {
  name: string;
  description: string;
  params?: Record<string, string>;
  from_step?: number;
  to_step?: number;
  checks?: CheckInput[];
  identity?: string;
}): BuiltSkill {
  if (steps.length === 0) throw new RelayError('bad_params', 'The trace is empty');
  const examples = exampleParams(input.params ?? {});
  const range = bounds(steps, input.from_step, input.to_step);
  const selected = steps.filter((step) => step.n >= range.from && step.n <= range.to);
  if (selected.length === 0) throw new RelayError('bad_params', 'No trace steps in the selected range');
  const numbers = new Set(selected.map((step) => step.n));
  for (const check of input.checks ?? []) {
    if (!numbers.has(check.after_step)) {
      throw new RelayError('bad_params', `check after_step ${check.after_step} is outside the selected steps`);
    }
  }

  const used = new Set<string>();
  const entered = new Map<string, number>();
  let current = 0;
  const apply = (value: string, place: TemplatePlace): { text: string; missed: TemplateMiss[] } => {
    const result = templatize(value, examples, place);
    for (const name of result.used) {
      used.add(name);
      if (place !== 'file' && !entered.has(name)) entered.set(name, current);
    }
    return { text: result.text, missed: result.missed };
  };

  const leading = selected[0]?.action === 'goto' ? selected[0] : undefined;
  const body = leading ? selected.slice(1) : selected;
  const started = apply(leading ? leading.value || leading.urlAfter : (body[0]?.urlBefore ?? ''), 'url');
  const startUrl = started.text;
  if (!startUrl) throw new RelayError('bad_params', 'The selected trace has no start URL');
  const startWarnings = started.missed.map((miss) => unsubstitutedWarning(miss.name, 'start_url', miss.part));

  const drafts: Draft[] = [];
  if (leading) {
    for (const check of (input.checks ?? []).filter((check) => check.after_step === leading.n)) {
      drafts.push(expectDraft(check));
    }
  }
  let drifted = false;
  for (const step of body) {
    current = step.n;
    drafts.push(actionDraft(step, apply, drifted, examples, used));
    if (step.action === 'goto' || step.urlAfter !== step.urlBefore) drifted = true;
    for (const check of (input.checks ?? []).filter((check) => check.after_step === step.n)) {
      drafts.push(expectDraft(check));
    }
  }
  if (drafts.length === 0) throw new RelayError('bad_params', 'No steps to save');
  if (!drafts.some((draft) => draft.action !== 'expect')) {
    const ranged = input.from_step !== undefined || input.to_step !== undefined;
    const where = ranged
      ? `The selected range starts at step ${range.from}.`
      : `The default range starts at step ${range.from} (the last goto).`;
    throw new RelayError(
      'bad_params',
      `No action steps to save. browser_eval, browser_extract, and browser_snapshot are not recorded. ${where} Pass from_step to include earlier actions.`,
    );
  }

  const unused = examples.filter((param) => !used.has(param.name)).map((param) => param.name);
  if (unused.length === 1) throw new RelayError('param_unused', `Unused param ${unused[0]}`);
  if (unused.length > 1) throw new RelayError('param_unused', `Unused params ${unused.join(', ')}`);
  const fileOnly = examples.filter((param) => !entered.has(param.name));
  if (fileOnly.length > 0) {
    const list = fileOnly.map((param) => `${param.name} (${JSON.stringify(param.example)})`).join(', ');
    throw new RelayError(
      'param_unused',
      `Param ${list} only names saved files; no step enters it into the page, so every replay would use whatever the page shows. Do not drop the param: if the page already had this value, select or type it anyway (select the same option again), then save again with the same params and a step range that includes that action.`,
    );
  }
  const early = body.find((step) => isExport(step) && examples.some((param) => (entered.get(param.name) ?? 0) > step.n));
  if (early) {
    const late = examples
      .filter((param) => (entered.get(param.name) ?? 0) > early.n)
      .map((param) => `${param.name} (entered at step ${entered.get(param.name)})`)
      .join(', ');
    throw new RelayError(
      'bad_params',
      `Step ${early.n} saves a file before any step enters ${late}, so every replay would first export with whatever the page shows. Save one complete pass that enters every param before it exports: set from_step to where the last pass starts and keep the same params. If that pass skipped a param because the page already showed it, run the pass again entering every param, then save that range.`,
    );
  }

  const warnings: string[] = [...startWarnings];
  const skillSteps: SkillStep[] = drafts.map((draft, index) => {
    const id = makeStepId(index + 1, draft.action, draft.targetName);
    if (draft.css && !(draft.css.unique && draft.css.value)) {
      if (draft.css.value && !draft.css.unique) warnings.push(`${id} css is not unique (${draft.css.value})`);
      warnings.push(`${id} relies only on name`);
    }
    if (draft.row?.nth !== undefined) {
      const which = draft.row.nth.includes('{{') ? `position ${draft.row.nth}` : `position ${draft.row.nth} (fixed)`;
      warnings.push(`${id} picks ${which} of ${draft.row.of} "${draft.row.name}" by order; a reordered list clicks another row, a different count stops the replay`);
    }
    if (draft.drifted) warnings.push(`${id} runs after a navigation away from the start URL`);
    if (draft.tabUrl) warnings.push(`${id} runs in tab ${draft.tabUrl}`);
    if (draft.rewritten) {
      warnings.push(`${id} save_as had no parameters; rewrote it to ${draft.rewritten} so matrix runs do not collide`);
    }
    if (JSON.stringify(draft.step).includes('{{secret}}')) {
      warnings.push(`${id} types a secret; replay is refused until the vault exists (drop it with --from/--to)`);
    }
    for (const hit of draft.unsubstituted ?? []) {
      warnings.push(unsubstitutedWarning(hit.name, `${id} ${hit.field}`, hit.part));
    }
    return { id, ...draft.step } as SkillStep;
  });

  const skill = {
    name: input.name,
    description: input.description,
    ...(input.identity ? { identity: input.identity } : {}),
    version: 1,
    start_url: startUrl,
    params: Object.fromEntries(examples.map((param) => [param.name, { type: 'string' as const, example: param.example }])),
    steps: skillSteps,
  };
  const parsed = SkillSchema.safeParse(skill);
  if (!parsed.success) throw new RelayError('bad_params', issuesText(parsed.error));
  return { skill: parsed.data, warnings };
}

interface Draft {
  action: string;
  targetName?: string;
  step: Record<string, unknown>;
  css?: { value: string; unique: boolean };
  drifted?: boolean;
  tabUrl?: string;
  rewritten?: string;
  unsubstituted?: UnsubstitutedHit[];
  /** The saved target when it is scoped to a row. */
  row?: SkillTarget;
}

interface UnsubstitutedHit {
  name: string;
  field: string;
  part?: TemplateMiss['part'];
}

function exampleParams(params: Record<string, string>): ExampleParam[] {
  const examples: ExampleParam[] = [];
  for (const [name, example] of Object.entries(params)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new RelayError('bad_params', `Param ${name} is not a valid placeholder name`);
    }
    if (!example) throw new RelayError('bad_params', `Param ${name} has an empty example`);
    examples.push({ name, example });
  }
  return examples;
}

function isExport(step: TraceStep): boolean {
  return step.action === 'download' || step.action === 'pdf';
}

function bounds(steps: readonly TraceStep[], from: number | undefined, to: number | undefined): { from: number; to: number } {
  const first = steps[0]?.n ?? 1;
  const last = steps[steps.length - 1]?.n ?? first;
  if (from === undefined && to === undefined) {
    let start = first;
    for (const step of steps) if (step.action === 'goto') start = step.n;
    return { from: start, to: last };
  }
  const resolved = { from: from ?? first, to: to ?? last };
  if (resolved.from > resolved.to) throw new RelayError('bad_params', 'from_step is after to_step');
  return resolved;
}

function expectDraft(check: CheckInput): Draft {
  return {
    action: 'expect',
    step: {
      expect: {
        any: check.any.map((branch) => ({
          outcome: branch.outcome,
          when: branch.when,
          ...(branch.message ? { message: branch.message } : {}),
        })),
      },
    },
  };
}

function actionDraft(
  step: TraceStep,
  apply: (value: string, place: TemplatePlace) => { text: string; missed: TemplateMiss[] },
  drifted: boolean,
  examples: readonly ExampleParam[],
  used: Set<string>,
): Draft {
  const hits: UnsubstitutedHit[] = [];
  const text = (value: string, place: TemplatePlace, field: string): string => {
    const result = apply(value, place);
    for (const miss of result.missed) hits.push({ name: miss.name, field, part: miss.part });
    return result.text;
  };
  const target = step.target ? scopeTarget(step.target, examples, (value, place) => text(value, place, 'target row')) : undefined;
  const scoped = target ? rowScoped(target) : false;
  const css = step.target && !scoped ? { value: step.target.css, unique: step.target.cssUnique } : undefined;
  const base = { targetName: target?.name, css, drifted, tabUrl: step.tabUrl, unsubstituted: hits, row: scoped ? target : undefined };
  hits.push(...locatorMisses(step.target, examples, !scoped));
  switch (step.action) {
    case 'goto':
      return { action: 'goto', ...base, step: { goto: { url: text(step.value || step.urlAfter, 'url', 'url') } } };
    case 'click':
      return { action: 'click', ...base, step: { click: { target: requiredTarget(step, target) } } };
    case 'type':
      return {
        action: 'type',
        ...base,
        step: {
          type: {
            target: requiredTarget(step, target),
            value: text(step.value ?? '', 'value', 'value'),
            ...(step.key ? { key: step.key } : {}),
          },
        },
      };
    case 'select':
      return {
        action: 'select',
        ...base,
        step: { select: { target: requiredTarget(step, target), value: text(step.value ?? '', 'value', 'value') } },
      };
    case 'press':
      if (!step.key) throw new RelayError('bad_params', `Trace step ${step.n} is a press without a key`);
      return {
        action: 'press',
        ...base,
        step: { press: { key: step.key, ...(target ? { target } : {}) } },
      };
    case 'scroll':
      return {
        action: 'scroll',
        ...base,
        step: {
          scroll: {
            ...(target ? { target } : {}),
            ...(step.value === 'up' || step.value === 'down' ? { direction: step.value } : {}),
          },
        },
      };
    case 'download': {
      const saved = saveAsForTrace(step.value || step.suggested || 'download.pdf', apply, examples, used);
      for (const miss of saved.missed) hits.push({ name: miss.name, field: 'save_as', part: miss.part });
      return {
        action: 'download',
        ...base,
        rewritten: saved.rewritten,
        step: {
          download: {
            click: { target: requiredTarget(step, target) },
            save_as: saved.saveAs,
            ...(step.timeout_ms ? { timeout_ms: step.timeout_ms } : {}),
          },
        },
      };
    }
    case 'pdf': {
      const saved = saveAsForTrace(step.value || 'page.pdf', apply, examples, used);
      for (const miss of saved.missed) hits.push({ name: miss.name, field: 'save_as', part: miss.part });
      return {
        action: 'pdf',
        ...base,
        rewritten: saved.rewritten,
        step: {
          pdf: {
            save_as: saved.saveAs,
            ...(step.landscape ? { landscape: true } : {}),
          },
        },
      };
    }
    case 'wait': {
      const waited = step.value ? text(step.value, 'text', 'text') : undefined;
      const url = step.url ? text(step.url, 'url', 'url') : undefined;
      return {
        action: 'wait',
        ...base,
        step: {
          wait: {
            ...(waited ? { text: waited } : {}),
            ...(url ? { url } : {}),
            ...(target ? { target } : {}),
            ...(step.timeout_ms ? { timeout_ms: step.timeout_ms } : {}),
          },
        },
      };
    }
    default:
      throw new RelayError('bad_params', `Trace step ${step.n} cannot be saved`);
  }
}

function saveAsForTrace(
  raw: string,
  apply: (value: string, place: TemplatePlace) => { text: string; missed: TemplateMiss[] },
  examples: readonly ExampleParam[],
  used: Set<string>,
): { saveAs: string; rewritten?: string; missed: TemplateMiss[] } {
  const templated = apply(raw, 'file');
  if (examples.length === 0 || templated.text.includes('{{')) return { saveAs: templated.text, missed: templated.missed };
  const ext = fileExtension(raw) || '.pdf';
  const rewritten = `${examples.map((param) => `{{${param.name}}}`).join('-')}${ext}`;
  for (const param of examples) used.add(param.name);
  return { saveAs: rewritten, rewritten, missed: templated.missed };
}

function locatorMisses(target: TraceStep['target'], examples: readonly ExampleParam[], keepsCss: boolean): UnsubstitutedHit[] {
  if (!target) return [];
  const fields: Array<[string, string | undefined]> = [
    ['target css', keepsCss ? target.css : undefined],
    ['target id', target.id],
    ['target name', target.name],
    ['target label', target.label],
    ['target text', target.text],
    ['target frame', target.frame?.url || target.frame?.name],
  ];
  const hits: UnsubstitutedHit[] = [];
  const seen = new Set<string>();
  for (const [field, value] of fields) {
    if (!value) continue;
    for (const param of examples) {
      if (!param.example || !value.includes(param.example)) continue;
      const key = `${param.name}\0${field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ name: param.name, field });
    }
  }
  return hits;
}

function unsubstitutedWarning(name: string, place: string, part?: string): string {
  const where = part ? `${place} ${part}` : place;
  return `param ${name} occurs in ${where} and was not substituted`;
}

function requiredTarget(step: TraceStep, target: SkillTarget | undefined): SkillTarget {
  if (!target) throw new RelayError('bad_params', `Trace step ${step.n} has no target`);
  return target;
}

export function toSkillTarget(target: TargetDescriptor): SkillTarget {
  return {
    role: target.role,
    name: target.name,
    ...(target.label && target.label !== target.name ? { label: target.label } : {}),
    ...(target.css && target.cssUnique ? { css: target.css } : {}),
    ...(target.text ? { text: target.text } : {}),
    ...(target.frame ? { frame: { name: target.frame.name, url: target.frame.url } } : {}),
  };
}

const ANCHOR_LEFT_MAX = 20;

/**
 * A control that repeats on the page (one per row) is scoped to a row so a matrix can loop over rows.
 * In order: a param shown in the row becomes `within`; a param equal to the position becomes `nth`;
 * otherwise a control with no unique CSS is pinned to its recorded position.
 * A scoped target drops its CSS, which points at the recorded row.
 */
export function scopeTarget(
  described: TargetDescriptor,
  examples: readonly ExampleParam[],
  apply: (value: string, place: TemplatePlace) => string,
): SkillTarget {
  const base = toSkillTarget(described);
  if (!described.nth || !described.peers || described.peers < 2) return base;
  const { css: _pinned, ...unpinned } = base;
  const row = described.row ?? '';
  const ordered = [...examples].sort((left, right) => [...right.example].length - [...left.example].length);
  for (const param of ordered) {
    const at = tokenIndex(row, param.example);
    if (at < 0) continue;
    const within = apply(row.slice(anchorStart(row, at), at + param.example.length), 'anchor');
    return { ...unpinned, within };
  }
  const nth = apply(String(described.nth), 'value');
  if (nth.includes('{{')) return { ...unpinned, nth, of: described.peers };
  if (base.css) return base;
  return { ...unpinned, nth, of: described.peers };
}

/** Start of the anchor: back to whitespace, at most ANCHOR_LEFT_MAX characters, never inside a word. */
function anchorStart(row: string, at: number): number {
  let start = at;
  while (start > 0 && at - start < ANCHOR_LEFT_MAX && !/\s/.test(row[start - 1] ?? '')) start -= 1;
  while (start > 0 && start < at && /[A-Za-z0-9]/.test(row[start - 1] ?? '') && /[A-Za-z0-9]/.test(row[start] ?? '')) start += 1;
  return start;
}
