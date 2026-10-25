import { RelayError } from '../errors.js';
import { issuesText } from '../protocol.js';
import type { TargetDescriptor, TraceStep } from '../recorder/types.js';
import { fileExtension } from '../session/downloads.js';
import { SkillSchema, type CheckInput, type Skill, type SkillStep, type SkillTarget } from './schema.js';
import { templatize, type ExampleParam } from './template.js';

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
  const apply = (value: string): string => {
    const result = templatize(value, examples);
    for (const name of result.used) used.add(name);
    return result.text;
  };

  const leading = selected[0]?.action === 'goto' ? selected[0] : undefined;
  const body = leading ? selected.slice(1) : selected;
  const startUrl = leading ? apply(leading.value || leading.urlAfter) : apply(body[0]?.urlBefore ?? '');
  if (!startUrl) throw new RelayError('bad_params', 'The selected trace has no start URL');

  const drafts: Draft[] = [];
  if (leading) {
    for (const check of (input.checks ?? []).filter((check) => check.after_step === leading.n)) {
      drafts.push(expectDraft(check));
    }
  }
  let drifted = false;
  for (const step of body) {
    drafts.push(actionDraft(step, apply, drifted, examples, used));
    if (step.action === 'goto' || step.urlAfter !== step.urlBefore) drifted = true;
    for (const check of (input.checks ?? []).filter((check) => check.after_step === step.n)) {
      drafts.push(expectDraft(check));
    }
  }
  if (drafts.length === 0) throw new RelayError('bad_params', 'No steps to save');

  const unused = examples.filter((param) => !used.has(param.name)).map((param) => param.name);
  if (unused.length === 1) throw new RelayError('param_unused', `Unused param ${unused[0]}`);
  if (unused.length > 1) throw new RelayError('param_unused', `Unused params ${unused.join(', ')}`);

  const warnings: string[] = [];
  const skillSteps: SkillStep[] = drafts.map((draft, index) => {
    const id = makeStepId(index + 1, draft.action, draft.targetName);
    if (draft.css && !(draft.css.unique && draft.css.value)) {
      if (draft.css.value && !draft.css.unique) warnings.push(`${id} css is not unique (${draft.css.value})`);
      warnings.push(`${id} relies only on name`);
    }
    if (draft.drifted) warnings.push(`${id} runs after a navigation away from the start URL`);
    if (draft.tabUrl) warnings.push(`${id} runs in tab ${draft.tabUrl}`);
    if (draft.rewritten) {
      warnings.push(`${id} save_as had no parameters; rewrote it to ${draft.rewritten} so matrix runs do not collide`);
    }
    if (JSON.stringify(draft.step).includes('{{secret}}')) {
      warnings.push(`${id} types a secret; replay is refused until the vault exists (drop it with --from/--to)`);
    }
    return { id, ...draft.step } as SkillStep;
  });

  const skill = {
    name: input.name,
    description: input.description,
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
  apply: (value: string) => string,
  drifted: boolean,
  examples: readonly ExampleParam[],
  used: Set<string>,
): Draft {
  const target = step.target ? toSkillTarget(step.target) : undefined;
  const css = step.target ? { value: step.target.css, unique: step.target.cssUnique } : undefined;
  const base = { targetName: target?.name, css, drifted, tabUrl: step.tabUrl };
  switch (step.action) {
    case 'goto':
      return { action: 'goto', ...base, step: { goto: { url: apply(step.value || step.urlAfter) } } };
    case 'click':
      return { action: 'click', ...base, step: { click: { target: requiredTarget(step, target) } } };
    case 'type':
      return {
        action: 'type',
        ...base,
        step: {
          type: {
            target: requiredTarget(step, target),
            value: apply(step.value ?? ''),
            ...(step.key ? { key: step.key } : {}),
          },
        },
      };
    case 'select':
      return {
        action: 'select',
        ...base,
        step: { select: { target: requiredTarget(step, target), value: apply(step.value ?? '') } },
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
      const text = step.value ? apply(step.value) : undefined;
      const url = step.url ? apply(step.url) : undefined;
      return {
        action: 'wait',
        ...base,
        step: {
          wait: {
            ...(text ? { text } : {}),
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
  apply: (value: string) => string,
  examples: readonly ExampleParam[],
  used: Set<string>,
): { saveAs: string; rewritten?: string } {
  const templated = apply(raw);
  if (examples.length === 0 || templated.includes('{{')) return { saveAs: templated };
  const ext = fileExtension(raw) || '.pdf';
  const rewritten = `${examples.map((param) => `{{${param.name}}}`).join('-')}${ext}`;
  for (const param of examples) used.add(param.name);
  return { saveAs: rewritten, rewritten };
}

function requiredTarget(step: TraceStep, target: SkillTarget | undefined): SkillTarget {
  if (!target) throw new RelayError('bad_params', `Trace step ${step.n} has no target`);
  return target;
}

function toSkillTarget(target: TargetDescriptor): SkillTarget {
  return {
    role: target.role,
    name: target.name,
    ...(target.label && target.label !== target.name ? { label: target.label } : {}),
    ...(target.css && target.cssUnique ? { css: target.css } : {}),
    ...(target.text ? { text: target.text } : {}),
    ...(target.frame ? { frame: { name: target.frame.name, url: target.frame.url } } : {}),
  };
}
