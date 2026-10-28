import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchRun, RunKind, TokenRun, ToolAggregate } from './types.js';

export const REPRODUCE_COMMAND = 'npm run bench -- --tools relaywright,playwright --repeats 5 --out bench/results';

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const left = sorted[mid - 1];
  const right = sorted[mid];
  if (left === undefined || right === undefined) return null;
  return (left + right) / 2;
}

function tokensOf(run: TokenRun | undefined): number | null {
  if (!run) return null;
  return run.promptTokens + run.completionTokens;
}

export function aggregate(runs: readonly TokenRun[]): ToolAggregate[] {
  const tools: string[] = [];
  for (const run of runs) {
    if (!tools.includes(run.tool)) tools.push(run.tool);
  }
  return tools.map((tool) => {
    const group = runs.filter((run) => run.tool === tool);
    const first = group.find((run) => run.kind === 'first');
    const redesign = group.find((run) => run.kind === 'redesign');
    const repeats = group.filter((run) => run.kind === 'repeat');
    const successes = group.filter((run) => run.success).length;
    return {
      tool,
      runs: group.length,
      firstTokens: tokensOf(first),
      medianRepeatTokens: median(repeats.map((run) => run.promptTokens + run.completionTokens)),
      redesignTokens: tokensOf(redesign),
      totalTokens: group.reduce((sum, run) => sum + run.promptTokens + run.completionTokens, 0),
      successRate: group.length === 0 ? 0 : successes / group.length,
    };
  });
}

export interface ReportEnvironment {
  node: string;
  os: string;
  chromePath: string;
  chromeVersion: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  commit: string;
  playwrightMcp: string;
}

export interface ReportInput {
  generatedAt: string;
  dry: boolean;
  environment: ReportEnvironment;
  runs: BenchRun[];
  downloads: Array<{ path: string; bytes: number }>;
  error?: string;
}

export function renderSummary(input: ReportInput): string {
  const aggregates = aggregate(input.runs);
  const lines = [
    '# relaywright benchmark',
    '',
    '## How to reproduce',
    '',
    '```',
    'npm run build',
    REPRODUCE_COMMAND,
    '```',
    '',
    `The API key is the environment variable \`${input.environment.apiKeyEnv}\`. It is not written in this file.`,
    '',
  ];
  if (input.dry) {
    lines.push('This file was produced by `--dry`: a scripted model, no LLM network calls.', '');
  }
  lines.push(
    '## Environment',
    '',
    `- node: ${input.environment.node}`,
    `- os: ${input.environment.os}`,
    `- chrome: ${input.environment.chromeVersion}`,
    `- chrome path: ${input.environment.chromePath}`,
    `- model: ${input.environment.model}`,
    `- base_url: ${input.environment.baseUrl}`,
    `- api_key_env: ${input.environment.apiKeyEnv}`,
    `- commit: ${input.environment.commit}`,
    `- playwright mcp: ${input.environment.playwrightMcp}`,
    '',
  );
  if (input.error) lines.push('## Harness error', '', input.error, '');
  lines.push('## Runs', '', '| tool | kind | success | model calls | tool calls | prompt | completion | cache hit | wall ms | empty reported | exports |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const run of input.runs) {
    const label = runLabel(run.kind, run.repeatIndex);
    const exports = run.exports.map((post) => `${post.year}/${post.term}/${post.layout}`).join(', ') || '(none)';
    lines.push(
      `| ${run.tool} | ${label} | ${run.success ? 'yes' : 'no'} | ${run.modelCalls} | ${run.toolCalls} | ${run.promptTokens} | ${run.completionTokens} | ${run.cacheHitTokens} | ${run.wallMs} | ${run.emptyReported ? 'yes' : 'no'} | ${exports} |`,
    );
  }
  lines.push('', '## Aggregates', '', '| tool | first tokens | median repeat tokens | redesign tokens | total tokens | success rate |', '| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const row of aggregates) {
    lines.push(
      `| ${row.tool} | ${show(row.firstTokens)} | ${show(row.medianRepeatTokens)} | ${show(row.redesignTokens)} | ${row.totalTokens} | ${row.runs === 0 ? 'n/a' : `${row.successRate * 100}% (${Math.round(row.successRate * row.runs)}/${row.runs})`} |`,
    );
  }
  lines.push('', '## Success detail', '', '| tool | kind | duplicates | extra | missing | empty exported |', '| --- | --- | --- | --- | --- | --- |');
  for (const run of input.runs) {
    const duplicates = run.duplicates.map((item) => `${item.year}/${item.term} x${item.count}`).join(', ') || '(none)';
    const extra = run.extra.map((item) => `${item.year}/${item.term}/${item.layout}`).join(', ') || '(none)';
    const missing = run.missing.map((item) => `${item.year}/${item.term}`).join(', ') || '(none)';
    lines.push(`| ${run.tool} | ${runLabel(run.kind, run.repeatIndex)} | ${duplicates} | ${extra} | ${missing} | ${run.emptyExported ? 'yes' : 'no'} |`);
  }
  lines.push('', '## Tokens', '', '![tokens per run](tokens.svg)', '', '## Wall time', '', '![wall time per run](time.svg)', '');
  if (input.downloads.length > 0) {
    lines.push('## Downloaded files', '');
    for (const file of input.downloads) lines.push(`- ${file.bytes} bytes  ${file.path}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function renderTokensSvg(runs: readonly BenchRun[]): string {
  return groupedSvg(
    'Tokens per run',
    runs.map((run) => ({ tool: run.tool, label: runLabel(run.kind, run.repeatIndex), value: run.promptTokens + run.completionTokens })),
  );
}

export function renderTimeSvg(runs: readonly BenchRun[]): string {
  return groupedSvg(
    'Wall time per run (ms)',
    runs.map((run) => ({ tool: run.tool, label: runLabel(run.kind, run.repeatIndex), value: run.wallMs })),
  );
}

export function writeReport(dir: string, input: ReportInput): void {
  mkdirSync(dir, { recursive: true });
  const aggregates = aggregate(input.runs);
  const json = {
    generatedAt: input.generatedAt,
    dry: input.dry,
    reproduce: {
      command: REPRODUCE_COMMAND,
      api_key_env: input.environment.apiKeyEnv,
    },
    environment: input.environment,
    runs: input.runs,
    aggregates,
    downloads: input.downloads,
    ...(input.error ? { error: input.error } : {}),
  };
  writeFileSync(join(dir, 'results.json'), `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'summary.md'), renderSummary(input), 'utf8');
  writeFileSync(join(dir, 'tokens.svg'), renderTokensSvg(input.runs), 'utf8');
  writeFileSync(join(dir, 'time.svg'), renderTimeSvg(input.runs), 'utf8');
}

export function runLabel(kind: RunKind, repeatIndex: number): string {
  if (kind === 'first') return 'first';
  if (kind === 'redesign') return 'redesign';
  return `repeat ${repeatIndex}`;
}

function show(value: number | null): string {
  return value === null ? 'n/a' : String(value);
}

interface ChartPoint {
  tool: string;
  label: string;
  value: number;
}

function groupedSvg(title: string, points: readonly ChartPoint[]): string {
  const tools: string[] = [];
  const labels: string[] = [];
  for (const point of points) {
    if (!tools.includes(point.tool)) tools.push(point.tool);
    if (!labels.includes(point.label)) labels.push(point.label);
  }
  const width = 760;
  const height = 320;
  const left = 56;
  const right = 16;
  const top = 36;
  const bottom = 64;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const max = Math.max(1, ...points.map((point) => point.value));
  const groupWidth = labels.length === 0 ? plotWidth : plotWidth / labels.length;
  const barWidth = Math.max(4, groupWidth / (tools.length + 1));
  const colors = ['#1f6b4a', '#1d4e89', '#8a5a00', '#6b3fa0'];
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="${left}" y="22" font-family="sans-serif" font-size="14">${escapeXml(title)}</text>`,
    `<line x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}" stroke="#222"/>`,
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}" stroke="#222"/>`,
  ];
  labels.forEach((label, groupIndex) => {
    const origin = left + groupIndex * groupWidth;
    tools.forEach((tool, toolIndex) => {
      const point = points.find((item) => item.label === label && item.tool === tool);
      const value = point?.value ?? 0;
      const barHeight = (value / max) * (plotHeight - 8);
      const x = origin + barWidth * 0.5 + toolIndex * barWidth;
      const y = top + plotHeight - barHeight;
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barWidth * 0.8).toFixed(1)}" height="${barHeight.toFixed(1)}" fill="${colors[toolIndex % colors.length]}"/>`);
    });
    parts.push(`<text x="${(origin + groupWidth / 2).toFixed(1)}" y="${height - 28}" text-anchor="middle" font-family="sans-serif" font-size="11">${escapeXml(label)}</text>`);
  });
  tools.forEach((tool, index) => {
    const x = left + index * 140;
    parts.push(`<rect x="${x}" y="${height - 16}" width="12" height="12" fill="${colors[index % colors.length]}"/>`);
    parts.push(`<text x="${x + 16}" y="${height - 6}" font-family="sans-serif" font-size="11">${escapeXml(tool)}</text>`);
  });
  parts.push('</svg>');
  return parts.join('\n');
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
