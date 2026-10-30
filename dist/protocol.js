import { z } from 'zod';
export const BrowserStateName = z.enum(['idle', 'resolving', 'downloading', 'launching', 'ready', 'error']);
export const BuildFingerprintSchema = z.object({
    entry: z.string().min(1),
    builtAt: z.string().min(1),
});
export const LoginCheckSchema = z.object({
    url_contains: z.string().min(1).optional(),
    text_absent: z.string().min(1).optional(),
});
export const IdentitySchema = z.object({
    name: z.string().min(1),
    domains: z.array(z.string().min(1)),
    login_hosts: z.array(z.string().min(1)),
    created_at: z.string().min(1),
    saved_at: z.string().min(1),
    last_used_at: z.string().min(1),
    persist_days: z.number().int().positive(),
    cookie_count: z.number().int().nonnegative(),
    login_check: LoginCheckSchema.optional(),
    login_url: z.string().min(1).optional(),
});
export const HandoffViewSchema = z.object({
    state: z.enum(['idle', 'waiting', 'done', 'cancelled', 'timeout']),
    id: z.string().optional(),
    reason: z.string().optional(),
    identity: IdentitySchema.optional(),
    elapsed_ms: z.number().int().nonnegative().optional(),
    remaining_ms: z.number().int().nonnegative().optional(),
});
export const HandoffStartSchema = z.object({
    reason: z.string().min(1),
    url: z.string().min(1).optional(),
});
export const HandoffWaitSchema = z.object({
    timeout_ms: z.number().int().min(1).max(90_000),
});
export const IdentitySaveSchema = z.object({
    name: z.string().min(1).optional(),
    domains: z.array(z.string().min(1)).optional(),
});
export const StatusSchema = z.object({
    pid: z.number(),
    uptime: z.number(),
    browser: z.object({
        state: BrowserStateName,
        percent: z.number().optional(),
        message: z.string().optional(),
        executablePath: z.string().optional(),
        version: z.string().optional(),
    }),
    page: z
        .object({
        url: z.string(),
        title: z.string(),
    })
        .optional(),
    build: BuildFingerprintSchema.optional(),
    handoff: HandoffViewSchema.optional(),
});
export const DownloadInfoSchema = z.object({
    path: z.string(),
    name: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string(),
    url: z.string(),
    mime: z.string().optional(),
});
export const PageSchema = z.object({
    url: z.string(),
    title: z.string(),
    snapshot: z.string(),
    step: z.number().int().positive().optional(),
    downloads: z.array(DownloadInfoSchema).optional(),
});
export const WaitResultSchema = PageSchema.extend({
    matched: z.boolean(),
});
export const SnapshotQuery = z.object({
    mode: z.enum(['full', 'diff']).default('full'),
    maxRows: z.number().int().min(1).max(50).optional(),
});
export const ActSchema = z
    .object({
    action: z.enum(['click', 'type', 'select', 'press', 'scroll']),
    ref: z.string().min(1).optional(),
    value: z.string().optional(),
    key: z.string().min(1).optional(),
})
    .superRefine((input, ctx) => {
    if ((input.action === 'click' || input.action === 'type' || input.action === 'select') && !input.ref) {
        ctx.addIssue({ code: 'custom', message: 'ref is required for this action', path: ['ref'] });
    }
    if ((input.action === 'type' || input.action === 'select') && input.value === undefined) {
        ctx.addIssue({ code: 'custom', message: 'value is required for this action', path: ['value'] });
    }
    if (input.action === 'press' && !input.key) {
        ctx.addIssue({ code: 'custom', message: 'key is required for press', path: ['key'] });
    }
    if (input.action === 'scroll' && !input.ref && input.value !== 'up' && input.value !== 'down') {
        ctx.addIssue({ code: 'custom', message: 'scroll without a ref requires value up or down', path: ['value'] });
    }
});
export const WaitSchema = z
    .object({
    text: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1).max(60_000).default(10_000),
})
    .superRefine((input, ctx) => {
    if (!input.text && !input.ref && !input.url) {
        ctx.addIssue({ code: 'custom', message: 'At least one of text, ref, or url is required' });
    }
});
export const TabInfoSchema = z.object({
    index: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    active: z.boolean(),
});
export const TabsListSchema = z.object({
    tabs: z.array(TabInfoSchema),
    text: z.string(),
});
export const TabsCommandSchema = z
    .object({
    action: z.enum(['list', 'select', 'close', 'new']),
    index: z.number().int().positive().optional(),
    url: z.string().min(1).optional(),
})
    .superRefine((input, ctx) => {
    if (input.action === 'select' && input.index === undefined) {
        ctx.addIssue({ code: 'custom', message: 'index is required for select', path: ['index'] });
    }
    if (input.url !== undefined && input.action !== 'new') {
        ctx.addIssue({ code: 'custom', message: 'url is only valid for new', path: ['url'] });
    }
});
export const DownloadSchema = z.object({
    ref: z.string().min(1),
    save_as: z.string().min(1).optional(),
    timeout_ms: z.number().int().min(1).max(120_000).default(30_000),
});
export const PdfSchema = z.object({
    save_as: z.string().min(1).optional(),
    landscape: z.boolean().optional(),
});
export const PdfResultSchema = z.object({
    url: z.string(),
    title: z.string(),
    header: z.string(),
    file: DownloadInfoSchema,
    step: z.number().int().positive().optional(),
});
export function issuesText(error) {
    return error.issues.map((issue) => issue.message).join('; ');
}
//# sourceMappingURL=protocol.js.map