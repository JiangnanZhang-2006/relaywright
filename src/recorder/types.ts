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
});

export type TargetDescriptor = z.infer<typeof TargetDescriptorSchema>;

export const TraceActionSchema = z.enum(['goto', 'click', 'type', 'select', 'press', 'scroll', 'wait']);

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
  timeout_ms: z.number().int().positive().optional(),
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
