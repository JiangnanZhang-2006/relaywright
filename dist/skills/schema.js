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
    /** Text in the same row. Among controls with this role and name, only the one whose row contains it matches. */
    within: z.string().min(1).optional(),
    /** 1-based position among controls with this role and name. A string so it can hold a placeholder. */
    nth: z.string().min(1).optional(),
    /** How many such controls the page had when nth was recorded. A different count stops the replay. */
    of: z.number().int().positive().optional(),
});
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
export const ExpectBranchSchema = z.object({
    outcome: z.enum(['ok', 'empty']),
    when: WhenSchema,
    message: z.string().optional(),
});
export const CheckSchema = z.object({
    after_step: z.number().int().positive(),
    any: z.array(ExpectBranchSchema).min(1),
});
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
const STEP_KINDS = ['goto', 'click', 'type', 'select', 'press', 'scroll', 'wait', 'expect', 'download', 'pdf', 'state_set', 'extract'];
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
    state_set: z
        .object({
        ns: z.string().min(1),
        key: z.string().min(1),
        value: z.string(),
    })
        .optional(),
    extract: z
        .object({
        root_selector: z.string().min(1),
        save_as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
        limit: z.number().int().min(1).max(2000).optional(),
        fields: z.record(z.string(), z.object({
            selector: z.string().min(1),
            attr: z.string().min(1).optional(),
            all: z.boolean().optional(),
        })),
    })
        .refine((extract) => Object.keys(extract.fields).length > 0, { message: 'extract needs a field' })
        .optional(),
})
    .superRefine((step, ctx) => {
    const kinds = STEP_KINDS.filter((kind) => step[kind] !== undefined);
    if (kinds.length !== 1) {
        ctx.addIssue({ code: 'custom', message: `Step ${step.id} must have exactly one action` });
    }
});
export const ParamSchema = z.object({
    type: z.literal('string'),
    example: z.string().optional(),
});
export const SkillSchema = z.object({
    name: SkillNameSchema,
    description: z.string().min(1),
    identity: z.string().min(1).optional(),
    version: z.number().int().positive(),
    start_url: z.string().min(1),
    params: z.record(z.string(), ParamSchema),
    steps: z.array(SkillStepSchema),
});
export const LocatorKindSchema = z.enum(['role_name', 'css', 'text', 'role_name_contains', 'row', 'nth']);
export const ArtifactSchema = z.object({
    step_id: z.string(),
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string(),
});
export const StepResultSchema = z.object({
    id: z.string(),
    status: z.enum(['done', 'skipped', 'failed']),
    locator: LocatorKindSchema.optional(),
    ms: z.number(),
});
export const HealContextSchema = z.object({
    name: z.string(),
    version: z.number().int().positive(),
    step_id: z.string(),
    kind: z.string(),
    intent: z.string().optional(),
    target: SkillTargetSchema.optional(),
    reason: z.string(),
    url: z.string(),
    params: z.record(z.string(), z.string()),
    snapshot: z.string(),
    heal_token: z.string().min(1).optional(),
});
export const BrokenSchema = z.object({
    step_id: z.string(),
    intent: z.string().optional(),
    target: SkillTargetSchema.optional(),
    reason: z.string(),
    excerpt: z.string(),
    heal: HealContextSchema.optional(),
});
export const OutcomeSchema = z.enum(['ok', 'empty', 'needs_human', 'broken', 'skipped']);
export const SkillRunResultSchema = z.object({
    outcome: OutcomeSchema,
    message: z.string().optional(),
    params: z.record(z.string(), z.string()),
    steps: z.array(StepResultSchema),
    duration_ms: z.number(),
    broken: BrokenSchema.optional(),
    artifacts: z.array(ArtifactSchema).optional(),
    warnings: z.array(z.string()).optional(),
    /** Set when a locator miss should stop the matrix so the page stays at the failure. */
    halt_matrix: z.boolean().optional(),
});
export const LlmStepUsageSchema = z.object({
    step_id: z.string(),
    prompt: z.number().int().nonnegative(),
    completion: z.number().int().nonnegative(),
});
export const MatrixResultSchema = z.object({
    results: z.array(SkillRunResultSchema),
    exit_code: z.union([z.literal(0), z.literal(20), z.literal(30)]),
    out_dir: z.string().min(1),
    llm_tokens: z.number().int().nonnegative().optional(),
    llm_steps: z.array(LlmStepUsageSchema).optional(),
});
export const SaveSkillInputSchema = z.object({
    name: SkillNameSchema,
    description: z.string().min(1),
    params: z.record(z.string(), z.string()).optional(),
    from_step: z.number().int().positive().optional(),
    to_step: z.number().int().positive().optional(),
    checks: z.array(CheckSchema).optional(),
    overwrite: z.boolean().optional(),
    /** MCP connection that saved the skill; its next skill_run skips the saved pass. */
    session: z.string().min(1).max(100).optional(),
});
export const DeidentifiedSchema = z.object({
    tokens: z.array(z.object({ name: z.string(), count: z.number().int().nonnegative() })),
    params: z.array(z.object({ name: z.string(), kind: z.string(), count: z.number().int().nonnegative() })),
});
export const SaveResultSchema = z.object({
    name: z.string(),
    version: z.number().int().positive(),
    path: z.string(),
    yaml: z.string(),
    warnings: z.array(z.string()),
    deidentified: DeidentifiedSchema.optional(),
});
export const SkillSummarySchema = z.object({
    name: z.string(),
    description: z.string(),
    version: z.number().int().positive(),
    params: z.array(z.string()),
});
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
export const SkillHistorySchema = z.object({
    name: z.string(),
    current: z.number().int().positive(),
    versions: z.array(z.number().int().positive()),
});
export const RunSkillInputSchema = z.object({
    params: z.record(z.string(), z.string()).optional(),
    matrix: z.record(z.string(), z.array(z.string())).optional(),
    startUrl: z.string().min(1).optional(),
    out_dir: z.string().min(1).optional(),
    wait_human: z.boolean().optional(),
    /** Keep the per-run heal budget. The CLI sets this while replaying the rest of one matrix. */
    continue_heal: z.boolean().optional(),
    /** MCP connection; skips the combination its last skill_save or skill_patch finished, which agents tend to rerun. */
    session: z.string().min(1).max(100).optional(),
});
export const HealerSchema = z.enum(['mcp', 'cli', 'manual']);
export const SkillPatchInputSchema = z.object({
    step_id: z.string().min(1),
    ref: z.string().min(1),
    heal_token: z.string().min(1).optional(),
    healer: HealerSchema.optional(),
    llm_tokens: z.number().int().nonnegative().optional(),
    session: z.string().min(1).max(100).optional(),
});
export const SkillPatchResultSchema = z.object({
    accepted: z.boolean(),
    name: z.string(),
    step_id: z.string(),
    reason: z.string().optional(),
    message: z.string().optional(),
    /** Step that failed while re-running the tail after a patch. */
    failed_step: z.string().optional(),
    /** Cause of that tail failure, such as target_not_found. */
    cause: z.string().optional(),
    from_version: z.number().int().positive().optional(),
    to_version: z.number().int().positive().optional(),
    outcome: z.enum(['ok', 'empty']).optional(),
    retryable: z.boolean().optional(),
    /** Verification replay of the healed combination, including steps that finished before the break. */
    result: SkillRunResultSchema.optional(),
    /** Combinations still skipped. skill_run should be called only for these. */
    remaining_params: z.array(z.record(z.string(), z.string())).optional(),
});
export function stringifySkill(skill) {
    const text = stringify(toPlain(skill), { lineWidth: 0 });
    return text.endsWith('\n') ? text : `${text}\n`;
}
export function parseSkill(text) {
    let parsed;
    try {
        parsed = parse(text);
    }
    catch (err) {
        throw new RelayError('bad_params', err instanceof Error ? err.message : 'Invalid skill YAML');
    }
    const result = SkillSchema.safeParse(parsed);
    if (!result.success)
        throw new RelayError('bad_params', issuesText(result.error));
    return result.data;
}
export function stepKind(step) {
    const kind = STEP_KINDS.find((name) => step[name] !== undefined);
    if (!kind)
        throw new RelayError('bad_params', `Step ${step.id} has no action`);
    return kind;
}
export function stepTarget(step) {
    return (step.click?.target ??
        step.type?.target ??
        step.select?.target ??
        step.press?.target ??
        step.scroll?.target ??
        step.wait?.target ??
        step.download?.click.target);
}
/** YAML's document model keeps key order; drop undefined so optional fields stay absent. */
function toPlain(value) {
    if (Array.isArray(value))
        return value.map((item) => toPlain(item));
    if (!value || typeof value !== 'object')
        return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
        if (child === undefined)
            continue;
        out[key] = toPlain(child);
    }
    return out;
}
//# sourceMappingURL=schema.js.map