import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { RelayError } from '../errors.js';
import { issuesText } from '../protocol.js';

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const SkillNameSchema = z.string().regex(SKILL_NAME);

export const SkillTargetSchema = z.object({
  role: z.string().min(1),
  name: z.string(),
  label: z.string().optional(),
  css: z.string().min(1).optional(),
  text: z.string().optional(),
  frame: z.object({ name: z.string(), url: z.string() }).optional(),
});

export type SkillTarget = z.infer<typeof SkillTargetSchema>;

export const WhenSchema = z
  .object({
    text_present: z.string().min(1).optional(),
    text_absent: z.string().min(1).optional(),
    table_rows_min: z.number().int().nonnegative().optional(),
    url_contains: z.string().min(1).optional(),
  })
  .refine((when) => Object.values(when).some((value) => value !== undefined), {
    message: 'when requires a condition',
  });

export type When = z.infer<typeof WhenSchema>;

export const ExpectBranchSchema = z.object({
  outcome: z.enum(['ok', 'empty']),
  when: WhenSchema,
  message: z.string().optional(),
});

export type ExpectBranch = z.infer<typeof ExpectBranchSchema>;

export const CheckSchema = z.object({
  after_step: z.number().int().positive(),
  any: z.array(ExpectBranchSchema).min(1),
});

export type CheckInput = z.infer<typeof CheckSchema>;

const WaitActionSchema = z
  .object({
    text: z.string().optional(),
    url: z.string().optional(),
    target: SkillTargetSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .refine((wait) => Boolean(wait.text || wait.url || wait.target), {
    message: 'wait needs text, url, or target',
  });

const STEP_KINDS = ['goto', 'click', 'type', 'select', 'press', 'scroll', 'wait', 'expect', 'download', 'pdf'] as const;

export const SkillStepSchema = z
  .object({
    id: z.string().min(1),
    intent: z.string().optional(),
    when_outcome: z.enum(['ok', 'empty']).optional(),
    goto: z.object({ url: z.string().min(1) }).optional(),
    click: z.object({ target: SkillTargetSchema }).optional(),
    type: z.object({ target: SkillTargetSchema, value: z.string(), key: z.string().optional() }).optional(),
    select: z.object({ target: SkillTargetSchema, value: z.string() }).optional(),
    press: z.object({ key: z.string().min(1), target: SkillTargetSchema.optional() }).optional(),
    scroll: z
      .object({
        target: SkillTargetSchema.optional(),
        direction: z.enum(['up', 'down']).optional(),
      })
      .optional(),
    wait: WaitActionSchema.optional(),
    expect: z.object({ any: z.array(ExpectBranchSchema).min(1) }).optional(),
    download: z
      .object({
        click: z.object({ target: SkillTargetSchema }),
        save_as: z.string().min(1),
        timeout_ms: z.number().int().positive().optional(),
      })
      .optional(),
    pdf: z
      .object({
        save_as: z.string().min(1),
        landscape: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((step, ctx) => {
    const kinds = STEP_KINDS.filter((kind) => step[kind] !== undefined);
    if (kinds.length !== 1) {
      ctx.addIssue({ code: 'custom', message: `Step ${step.id} must have exactly one action` });
    }
  });

export type SkillStep = z.infer<typeof SkillStepSchema>;

export const ParamSchema = z.object({
  type: z.literal('string'),
  example: z.string().optional(),
});

export type SkillParam = z.infer<typeof ParamSchema>;

export const SkillSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1),
  version: z.number().int().positive(),
  start_url: z.string().min(1),
  params: z.record(z.string(), ParamSchema),
  steps: z.array(SkillStepSchema),
});

export type Skill = z.infer<typeof SkillSchema>;

export const LocatorKindSchema = z.enum(['role_name', 'css', 'text', 'role_name_contains']);

export const ArtifactSchema = z.object({
  step_id: z.string(),
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
});

export type SkillArtifact = z.infer<typeof ArtifactSchema>;

export const StepResultSchema = z.object({
  id: z.string(),
  status: z.enum(['done', 'skipped', 'failed']),
  locator: LocatorKindSchema.optional(),
  ms: z.number(),
});

export type StepResult = z.infer<typeof StepResultSchema>;

export const BrokenSchema = z.object({
  step_id: z.string(),
  intent: z.string().optional(),
  target: SkillTargetSchema.optional(),
  reason: z.string(),
  excerpt: z.string(),
});

export type BrokenReport = z.infer<typeof BrokenSchema>;

export const OutcomeSchema = z.enum(['ok', 'empty', 'needs_human', 'broken']);

export type SkillOutcome = z.infer<typeof OutcomeSchema>;

export const SkillRunResultSchema = z.object({
  outcome: OutcomeSchema,
  message: z.string().optional(),
  params: z.record(z.string(), z.string()),
  steps: z.array(StepResultSchema),
  duration_ms: z.number(),
  broken: BrokenSchema.optional(),
  artifacts: z.array(ArtifactSchema).optional(),
  warnings: z.array(z.string()).optional(),
});

export type SkillRunResult = z.infer<typeof SkillRunResultSchema>;

export const MatrixResultSchema = z.object({
  results: z.array(SkillRunResultSchema),
  exit_code: z.union([z.literal(0), z.literal(30)]),
  out_dir: z.string().min(1),
});

export type MatrixResult = z.infer<typeof MatrixResultSchema>;

export const SaveSkillInputSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1),
  params: z.record(z.string(), z.string()).optional(),
  from_step: z.number().int().positive().optional(),
  to_step: z.number().int().positive().optional(),
  checks: z.array(CheckSchema).optional(),
  overwrite: z.boolean().optional(),
});

export type SaveSkillInput = z.infer<typeof SaveSkillInputSchema>;

export const SaveResultSchema = z.object({
  name: z.string(),
  version: z.number().int().positive(),
  path: z.string(),
  yaml: z.string(),
  warnings: z.array(z.string()),
});

export type SaveSkillResult = z.infer<typeof SaveResultSchema>;

export const SkillSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.number().int().positive(),
  params: z.array(z.string()),
});

export type SkillSummary = z.infer<typeof SkillSummarySchema>;

export const SkillListSchema = z.object({
  skills: z.array(SkillSummarySchema),
});

export const SkillDocumentSchema = z.object({
  name: z.string(),
  version: z.number().int().positive(),
  path: z.string(),
  yaml: z.string(),
  skill: SkillSchema,
});

export type SkillDocument = z.infer<typeof SkillDocumentSchema>;

export const SkillHistorySchema = z.object({
  name: z.string(),
  current: z.number().int().positive(),
  versions: z.array(z.number().int().positive()),
});

export type SkillHistory = z.infer<typeof SkillHistorySchema>;

export const RunSkillInputSchema = z.object({
  params: z.record(z.string(), z.string()).optional(),
  matrix: z.record(z.string(), z.array(z.string())).optional(),
  startUrl: z.string().min(1).optional(),
  out_dir: z.string().min(1).optional(),
});

export type RunSkillInput = z.infer<typeof RunSkillInputSchema>;

export function stringifySkill(skill: Skill): string {
  const text = stringify(toPlain(skill), { lineWidth: 0 });
  return text.endsWith('\n') ? text : `${text}\n`;
}

export function parseSkill(text: string): Skill {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (err) {
    throw new RelayError('bad_params', err instanceof Error ? err.message : 'Invalid skill YAML');
  }
  const result = SkillSchema.safeParse(parsed);
  if (!result.success) throw new RelayError('bad_params', issuesText(result.error));
  return result.data;
}

export function stepKind(step: SkillStep): (typeof STEP_KINDS)[number] {
  const kind = STEP_KINDS.find((name) => step[name] !== undefined);
  if (!kind) throw new RelayError('bad_params', `Step ${step.id} has no action`);
  return kind;
}

export function stepTarget(step: SkillStep): SkillTarget | undefined {
  return (
    step.click?.target ??
    step.type?.target ??
    step.select?.target ??
    step.press?.target ??
    step.scroll?.target ??
    step.wait?.target ??
    step.download?.click.target
  );
}

/** YAML's document model keeps key order; drop undefined so optional fields stay absent. */
function toPlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => toPlain(item));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    out[key] = toPlain(child);
  }
  return out;
}
