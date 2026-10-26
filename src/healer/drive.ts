import { patchSkill, runSkill } from '../daemon/client.js';
import { readHealConfig } from './config.js';
import { completeHeal } from './complete.js';
import { missingKeyHint } from './config.js';
import { stopsMatrix, summaryExitCode } from '../skills/run.js';
import type { LlmStepUsage, MatrixResult, RunSkillInput, SkillRunResult } from '../skills/schema.js';

export interface HealedRun {
  report: MatrixResult;
  hint?: string;
}

export async function runSkillWithHeal(name: string, input: RunSkillInput, options: { heal: boolean }): Promise<HealedRun> {
  const config = readHealConfig();
  const apiKey = process.env[config.api_key_env]?.trim() ?? '';
  const enabled = options.heal && apiKey.length > 0;
  let report = await runSkill(name, { ...input, continue_heal: false });
  const usage = new Map<string, { prompt: number; completion: number }>();
  const attempts = new Map<string, number>();
  let healed = 0;
  if (enabled) {
    while (healed < 3) {
      const index = report.results.findIndex((result) => stopsMatrix(result) && result.broken?.heal?.heal_token);
      const current = index >= 0 ? report.results[index] : undefined;
      const heal = current?.broken?.heal;
      if (!current || !heal?.heal_token) break;
      const attempt = (attempts.get(heal.heal_token) ?? 0) + 1;
      attempts.set(heal.heal_token, attempt);
      if (attempt > 2) {
        report = replaceAt(report, index, failHeal(current, 'heal_budget'));
        break;
      }
      let choice;
      try {
        choice = await completeHeal(config, apiKey, heal);
      } catch (err) {
        report = replaceAt(report, index, failHeal(current, err instanceof Error ? err.message : 'heal_failed'));
        break;
      }
      addUsage(usage, heal.step_id, choice.prompt, choice.completion);
      if (!choice.ref) {
        report = replaceAt(report, index, failHeal(current, choice.reason ? `heal_failed: ${choice.reason}` : 'heal_failed: model returned no ref'));
        break;
      }
      const patched = await patchSkill(name, {
        step_id: heal.step_id,
        ref: choice.ref,
        heal_token: heal.heal_token,
        healer: 'cli',
        llm_tokens: choice.prompt + choice.completion,
      });
      if (!patched.accepted) {
        if (patched.retryable && attempt < 2) continue;
        report = replaceAt(report, index, failHeal(current, patched.reason ?? 'heal_failed'));
        break;
      }
      healed += 1;
      report = await rerunTail(name, input, report, index);
    }
  }
  const steps: LlmStepUsage[] = [...usage.entries()].map(([step_id, tokens]) => ({ step_id, prompt: tokens.prompt, completion: tokens.completion }));
  const total = steps.reduce((sum, step) => sum + step.prompt + step.completion, 0);
  const needsHint = options.heal && !apiKey && report.results.some((result) => result.broken?.heal?.heal_token);
  return {
    report: { ...report, llm_tokens: total, ...(steps.length > 0 ? { llm_steps: steps } : {}) },
    ...(needsHint ? { hint: missingKeyHint(config.api_key_env) } : {}),
  };
}

async function rerunTail(name: string, input: RunSkillInput, report: MatrixResult, index: number): Promise<MatrixResult> {
  const prefix = report.results.slice(0, index);
  const tail = report.results.slice(index);
  const results: SkillRunResult[] = [...prefix];
  for (let cursor = 0; cursor < tail.length; cursor += 1) {
    const combo = tail[cursor];
    if (!combo) continue;
    const one = await runSkill(name, {
      params: combo.params,
      ...(input.startUrl ? { startUrl: input.startUrl } : {}),
      out_dir: report.out_dir,
      wait_human: input.wait_human === true,
      continue_heal: true,
    });
    const result = one.results[0];
    if (!result) throw new Error('Skill run returned no result');
    results.push(result);
    if (stopsMatrix(result)) {
      for (const rest of tail.slice(cursor + 1)) results.push(asSkipped(rest));
      break;
    }
  }
  return { results, exit_code: summaryExitCode(results), out_dir: report.out_dir };
}

function asSkipped(result: SkillRunResult): SkillRunResult {
  if (result.outcome === 'skipped') return result;
  return {
    outcome: 'skipped',
    message: 'skipped because an earlier combination is broken',
    params: result.params,
    steps: result.steps.map((step) => ({ id: step.id, status: 'skipped' as const, ms: 0 })),
    duration_ms: 0,
  };
}

function failHeal(result: SkillRunResult, reason: string): SkillRunResult {
  if (!result.broken) return { ...result, outcome: 'broken', message: reason };
  const heal = result.broken.heal;
  const nextHeal = heal ? { ...heal, heal_token: undefined } : undefined;
  return {
    ...result,
    outcome: 'broken',
    message: reason,
    broken: {
      ...result.broken,
      reason: 'heal_failed',
      ...(nextHeal ? { heal: nextHeal } : {}),
    },
  };
}

function replaceAt(report: MatrixResult, index: number, result: SkillRunResult): MatrixResult {
  const results = report.results.map((item, cursor) => (cursor === index ? result : item));
  return { ...report, results, exit_code: summaryExitCode(results) };
}

function addUsage(usage: Map<string, { prompt: number; completion: number }>, stepId: string, prompt: number, completion: number): void {
  const current = usage.get(stepId) ?? { prompt: 0, completion: 0 };
  usage.set(stepId, { prompt: current.prompt + prompt, completion: current.completion + completion });
}
