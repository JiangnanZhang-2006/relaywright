import { z } from 'zod';

export const FrameRefSchema = z.object({
  name: z.string(),
  url: z.string(),
});

export type FrameRef = z.infer<typeof FrameRefSchema>;

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
  /** Set when other controls share this role and name: 1-based position and count, in snapshot order. */
  nth: z.number().int().positive().optional(),
  peers: z.number().int().positive().optional(),
  /** Text of the row that holds this control and none of its peers. */
  row: z.string().optional(),
});

export type TargetDescriptor = z.infer<typeof TargetDescriptorSchema>;

export const TraceActionSchema = z.enum(['goto', 'click', 'type', 'select', 'press', 'scroll', 'wait', 'download', 'pdf']);

export type TraceAction = z.infer<typeof TraceActionSchema>;

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

export type TraceStep = z.infer<typeof TraceStepSchema>;

export const TraceViewSchema = z.object({
  id: z.string(),
  path: z.string(),
  steps: z.array(TraceStepSchema),
});

export type TraceView = z.infer<typeof TraceViewSchema>;

export interface DescribedTarget {
  target: TargetDescriptor;
  sensitive: boolean;
}
