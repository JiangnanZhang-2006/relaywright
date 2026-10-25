import type { TraceView } from '../recorder/types.js';
import type { SkillRunResult } from './schema.js';

export function formatRunReport(results: readonly SkillRunResult[]): string {
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
    } else if (result.outcome === 'empty') {
      lines.push(`${outcome}${params}  ${result.message ?? ''}`.trimEnd());
    } else {
      const id = result.broken?.step_id ?? '';
      const reason = result.broken?.reason ?? result.outcome;
      lines.push(`${outcome}${params}  ${id} ${reason}`.trimEnd());
    }
    for (const artifact of result.artifacts ?? []) {
      lines.push(`  ${artifact.step_id}  ${artifact.path}  ${artifact.bytes}  ${artifact.sha256}`);
    }
    for (const warning of result.warnings ?? []) lines.push(`  warning: ${warning}`);
    if (result.outcome !== 'ok' && result.outcome !== 'empty' && result.broken?.excerpt) {
      lines.push(`<page_content>\n${result.broken.excerpt}\n</page_content>`);
    }
  }
  lines.push('llm_tokens: 0');
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
