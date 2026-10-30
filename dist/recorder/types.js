import { z } from 'zod';
export const FrameRefSchema = z.object({
    name: z.string(),
    url: z.string(),
});
export const TargetDescriptorSchema = z.object({
    role: z.string(),
    name: z.string(),
    label: z.string().optional(),
    tag: z.string(),
    id: z.string().optional(),
    css: z.string(),
    cssUnique: z.boolean(),
    text: z.string().optional(),
    frame: FrameRefSchema.optional(),
});
export const TraceActionSchema = z.enum(['goto', 'click', 'type', 'select', 'press', 'scroll', 'wait', 'download', 'pdf']);
export const TraceStepSchema = z.object({
    n: z.number().int().positive(),
    at: z.string(),
    action: TraceActionSchema,
    urlBefore: z.string(),
    urlAfter: z.string(),
    target: TargetDescriptorSchema.optional(),
    value: z.string().optional(),
    key: z.string().optional(),
    /** Wait condition URL. Not the page URL. */
    url: z.string().optional(),
    /** Set when this step ran in a different tab than the previous step. */
    tabUrl: z.string().optional(),
    timeout_ms: z.number().int().positive().optional(),
    /** Browser-suggested download name, before save_as and dedupe. */
    suggested: z.string().optional(),
    landscape: z.boolean().optional(),
    observed: z.array(z.string()),
});
export const TraceViewSchema = z.object({
    id: z.string(),
    path: z.string(),
    steps: z.array(TraceStepSchema),
});
//# sourceMappingURL=types.js.map