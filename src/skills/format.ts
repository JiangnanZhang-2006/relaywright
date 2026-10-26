import type { TraceView } from '../recorder/types.js';
import type { LlmStepUsage, SkillRunResult } from './schema.js';

export interface LlmUsage {
  total: number;
  steps?: readonly LlmStepUsage[];
}

export function formatRunReport(results: readonly SkillRunResult[], usage?: LlmUsage): string {
  const lines: string[] = [];
  for (const result of results) {
    const outcome = result.outcome.padEnd(7, ' ');
    const params = Object.entries(result.params)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    if (result.outcome === 'ok') {
      const done = result.steps.filter((step) => step.status === 'done').length;
      const seconds = (result.duration_ms / 1000).toFixed(1);
      lines.push(`${outcome}${params}  ${done}/${result.steps.length} steps ${seconds}s`);
    } else if (result.outcome === 'empty' || result.outcome === 'needs_human' || result.outcome === 'skipped') {
      lines.push(`${outcome}${params}  ${result.message ?? result.outcome}`.trimEnd());
    } else {
      const id = result.broken?.step_id ?? '';
      const reason = result.broken?.reason ?? result.outcome;
      lines.push(`${outcome}${params}  ${id} ${reason}`.trimEnd());
    }
    const heal = result.broken?.heal;
    if (heal?.heal_token) {
      lines.push(`heal ${heal.name} v${heal.version} step ${heal.step_id} (${heal.kind})${heal.intent ? ` ${heal.intent}` : ''}`);
      if (heal.target) lines.push(`old target: ${heal.target.role} ${JSON.stringify(heal.target.name)}`);
      lines.push('Pick the ref that performs this intent, call skill_patch, then call skill_run again.');
      lines.push(`heal_token: ${heal.heal_token}`);
    } else if (result.broken?.reason === 'expect_unmatched') {
      lines.push('expect matched no declared outcome; this step is not repaired automatically');
    }
    for (const artifact of result.artifacts ?? []) {
      lines.push(`  ${artifact.step_id}  ${artifact.path}  ${artifact.bytes}  ${artifact.sha256}`);
    }
    for (const warning of result.warnings ?? []) lines.push(`  warning: ${warning}`);
    const pageBody = heal?.snapshot ?? (result.outcome !== 'ok' && result.outcome !== 'empty' && result.outcome !== 'skipped' ? result.broken?.excerpt : undefined);
    if (pageBody) lines.push(`<page_content>\n${pageBody}\n</page_content>`);
  }
  for (const step of usage?.steps ?? []) {
    lines.push(`llm_tokens ${step.step_id}: prompt=${step.prompt} completion=${step.completion}`);
  }
  lines.push(`llm_tokens: ${usage?.total ?? 0}`);
  return lines.join('\n');
}

export function formatTrace(trace: TraceView): string {
  const lines = [`trace: ${trace.id}`, `steps: ${trace.steps.length}`];
  for (const step of trace.steps) {
    const target = step.target ? ` ${step.target.role} ${JSON.stringify(step.target.name)}` : '';
    const value = step.value !== undefined ? ` ${JSON.stringify(step.value)}` : '';
    const key = step.key ? ` key=${step.key}` : '';
    const suggested = step.suggested ? ` suggested=${JSON.stringify(step.suggested)}` : '';
    const landscape = step.landscape ? ' landscape' : '';
    lines.push(`${step.n} ${step.action}${target}${value}${key}${suggested}${landscape}`);
  }
  return lines.join('\n');
}

export function formatSkillList(skills: readonly { name: string; version: number; description: string; params: readonly string[] }[]): string {
  if (skills.length === 0) return 'no skills';
  return skills
    .map((skill) => `${skill.name}  v${skill.version}  ${skill.description}\n  params: ${skill.params.join(', ') || '(none)'}`)
    .join('\n');
}
