import { z } from 'zod';

export const BrowserStateName = z.enum(['idle', 'resolving', 'downloading', 'launching', 'ready', 'error']);

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
});

export type DaemonStatus = z.infer<typeof StatusSchema>;

export const PageSchema = z.object({
  url: z.string(),
  title: z.string(),
  snapshot: z.string(),
});

export type PageBody = z.infer<typeof PageSchema>;

export const WaitResultSchema = PageSchema.extend({
  matched: z.boolean(),
});

export type WaitBody = z.infer<typeof WaitResultSchema>;

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

export type ActInput = z.infer<typeof ActSchema>;

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

export type WaitInput = z.infer<typeof WaitSchema>;

export function issuesText(error: { issues: { message: string }[] }): string {
  return error.issues.map((issue) => issue.message).join('; ');
}
