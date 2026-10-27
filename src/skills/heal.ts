import { randomBytes } from 'node:crypto';
import type { FailureSite } from './run.js';
import { stepKind, stepTarget, type HealContext, type SkillArtifact, type SkillOutcome, type SkillStep, type StepResult } from './schema.js';

export const HEAL_TOKEN_MS = 10 * 60 * 1000;
export const MAX_PATCH_ATTEMPTS = 2;
export const MAX_HEALED_STEPS = 3;

export type PriorOutcome = 'undecided' | Extract<SkillOutcome, 'ok' | 'empty'>;

export interface HealTicket {
  token: string;
  name: string;
  version: number;
  stepId: string;
  params: Record<string, string>;
  url: string;
  epoch: number;
  createdAt: number;
  attempts: number;
  priorOutcome: PriorOutcome;
  outDir: string;
  snapshot: string;
  completed: StepResult[];
  artifacts: SkillArtifact[];
  warnings: string[];
  remaining: Record<string, string>[];
}

export class HealLedger {
  private healed = 0;
  private ticket: HealTicket | null = null;

  beginRun(continueHeal: boolean): void {
    if (!continueHeal) this.healed = 0;
    // The run is about to leave the failure page. A token from the previous run cannot be applied.
    this.ticket = null;
  }

  canIssue(): boolean {
    return this.healed < MAX_HEALED_STEPS;
  }

  healedCount(): number {
    return this.healed;
  }

  latest(): HealTicket | null {
    return this.ticket;
  }

  issue(
    input: Omit<HealTicket, 'token' | 'createdAt' | 'attempts' | 'completed' | 'artifacts' | 'warnings' | 'remaining'> & {
      now?: number;
      completed?: readonly StepResult[];
      artifacts?: readonly SkillArtifact[];
      warnings?: readonly string[];
      remaining?: readonly Record<string, string>[];
    },
  ): HealTicket {
    const ticket: HealTicket = {
      name: input.name,
      version: input.version,
      stepId: input.stepId,
      params: input.params,
      url: input.url,
      epoch: input.epoch,
      priorOutcome: input.priorOutcome,
      outDir: input.outDir,
      snapshot: input.snapshot,
      completed: [...(input.completed ?? [])],
      artifacts: [...(input.artifacts ?? [])],
      warnings: [...(input.warnings ?? [])],
      remaining: (input.remaining ?? []).map((params) => ({ ...params })),
      token: randomBytes(16).toString('hex'),
      createdAt: input.now ?? Date.now(),
      attempts: 0,
    };
    this.ticket = ticket;
    return ticket;
  }

  beginAttempt(input: {
    token?: string;
    name: string;
    stepId: string;
    now: number;
    epoch: number;
    url: string;
  }): { ok: true; ticket: HealTicket } | { ok: false; reason: 'heal_token' | 'heal_budget' } {
    const ticket = this.ticket;
    if (!ticket) return { ok: false, reason: 'heal_token' };
    if (input.token && input.token !== ticket.token) return { ok: false, reason: 'heal_token' };
    if (ticket.name !== input.name || ticket.stepId !== input.stepId) return { ok: false, reason: 'heal_token' };
    if (input.now - ticket.createdAt > HEAL_TOKEN_MS) return { ok: false, reason: 'heal_token' };
    if (ticket.epoch !== input.epoch || ticket.url !== input.url) return { ok: false, reason: 'heal_token' };
    if (ticket.attempts >= MAX_PATCH_ATTEMPTS) return { ok: false, reason: 'heal_budget' };
    ticket.attempts += 1;
    return { ok: true, ticket };
  }

  noteHealed(): void {
    this.healed += 1;
    this.ticket = null;
  }

  dropTicket(): void {
    this.ticket = null;
  }
}

export function buildHealContext(input: {
  site: FailureSite;
  skillName: string;
  skillVersion: number;
  snapshot: string;
  url: string;
  epoch: number;
  outDir: string;
  ledger: HealLedger;
  now?: number;
}): HealContext | undefined {
  const { site } = input;
  if (!site.healable && site.reason !== 'expect_unmatched') return undefined;
  const target = stepTarget(site.step);
  const intent = site.step.intent || fallbackIntent(site.step);
  const context: HealContext = {
    name: input.skillName,
    version: input.skillVersion,
    step_id: site.step.id,
    kind: stepKind(site.step),
    ...(intent ? { intent } : {}),
    ...(target ? { target } : {}),
    reason: site.reason,
    url: input.url,
    params: site.params,
    snapshot: input.snapshot,
  };
  // expect_unmatched stays descriptive. A token would let a model rewrite the check.
  if (!site.healable || !input.ledger.canIssue()) return context;
  const ticket = input.ledger.issue({
    name: input.skillName,
    version: input.skillVersion,
    stepId: site.step.id,
    params: site.params,
    url: input.url,
    epoch: input.epoch,
    priorOutcome: site.priorOutcome,
    outDir: input.outDir,
    snapshot: input.snapshot,
    completed: site.completed,
    artifacts: site.artifacts,
    warnings: site.warnings,
    remaining: site.remaining,
    now: input.now,
  });
  return { ...context, heal_token: ticket.token };
}

/** Tail re-run failed after the patched step. Names the later step and its cause. */
export function rerunFailedReason(stepId: string, cause: string): string {
  return `rerun_failed: ${stepId} ${cause}`;
}

/** Recorded steps have no intent field. The healer still needs one sentence for the failed action. */
function fallbackIntent(step: SkillStep): string | undefined {
  const kind = stepKind(step);
  const name = stepTarget(step)?.name.trim();
  if (kind === 'goto') return '打开页面';
  if (kind === 'expect') return '检查页面结果';
  if (kind === 'pdf') return '打印 PDF';
  if (!name) return undefined;
  if (kind === 'click' || kind === 'download') return `点击${name}`;
  if (kind === 'select') return `选择${name}`;
  if (kind === 'type') return `输入${name}`;
  if (kind === 'press') return `按键${name}`;
  if (kind === 'scroll') return `滚动到${name}`;
  if (kind === 'wait') return `等待${name}`;
  return name;
}
