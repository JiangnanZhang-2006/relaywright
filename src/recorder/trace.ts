import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tracesDir } from '../config/paths.js';
import type { TargetDescriptor, TraceAction, TraceStep, TraceView } from './types.js';

const OBSERVED_CAP = 20;

let serial = 0;

function createTraceId(): string {
  serial += 1;
  return `${Date.now()}-${serial}`;
}

const LEAD = /^\((?:navigated: full snapshot|switched to (?:new )?tab:.*)\)$/;

export function observedLines(snapshot: string): string[] {
  const lines = snapshot.split('\n');
  let index = 0;
  while (index < lines.length && LEAD.test(lines[index] ?? '')) index += 1;
  // The next line is the page header, whether or not a switch banner preceded it.
  index += 1;
  return lines.slice(index, index + OBSERVED_CAP);
}

export interface TraceAppend {
  action: TraceAction;
  urlBefore: string;
  urlAfter: string;
  target?: TargetDescriptor;
  value?: string;
  key?: string;
  url?: string;
  tabUrl?: string;
  timeout_ms?: number;
  suggested?: string;
  landscape?: boolean;
  observed: string[];
}

export class TraceLog {
  private id: string;
  private readonly steps: TraceStep[] = [];

  constructor(private readonly dir: string = tracesDir()) {
    mkdirSync(this.dir, { recursive: true });
    this.id = createTraceId();
  }

  view(): TraceView {
    return { id: this.id, path: join(this.dir, `${this.id}.jsonl`), steps: this.steps.map((step) => ({ ...step })) };
  }

  clear(): TraceView {
    this.id = createTraceId();
    this.steps.length = 0;
    return this.view();
  }

  append(input: TraceAppend, persist: (step: TraceStep) => TraceStep = (step) => step): TraceStep {
    const step: TraceStep = {
      n: this.steps.length + 1,
      at: new Date().toISOString(),
      action: input.action,
      urlBefore: input.urlBefore,
      urlAfter: input.urlAfter,
      observed: input.observed.slice(0, OBSERVED_CAP),
    };
    if (input.target) step.target = input.target;
    if (input.value !== undefined) step.value = input.value;
    if (input.key !== undefined) step.key = input.key;
    if (input.url !== undefined) step.url = input.url;
    if (input.tabUrl !== undefined) step.tabUrl = input.tabUrl;
    if (input.timeout_ms !== undefined) step.timeout_ms = input.timeout_ms;
    if (input.suggested !== undefined) step.suggested = input.suggested;
    if (input.landscape !== undefined) step.landscape = input.landscape;
    this.steps.push(step);
    mkdirSync(this.dir, { recursive: true });
    const stored = persist(step);
    appendFileSync(join(this.dir, `${this.id}.jsonl`), `${JSON.stringify(stored)}\n`, 'utf8');
    return step;
  }
}
