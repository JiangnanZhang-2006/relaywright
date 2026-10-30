export function formatRunReport(results, usage) {
    const lines = [];
    for (const result of results) {
        const outcome = result.outcome.padEnd(7, ' ');
        const params = Object.entries(result.params)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
        if (result.outcome === 'ok') {
            const done = result.steps.filter((step) => step.status === 'done').length;
            const seconds = (result.duration_ms / 1000).toFixed(1);
            lines.push(`${outcome}${params}  ${done}/${result.steps.length} steps ${seconds}s`);
        }
        else if (result.outcome === 'empty' || result.outcome === 'needs_human' || result.outcome === 'skipped') {
            lines.push(`${outcome}${params}  ${result.message ?? result.outcome}`.trimEnd());
        }
        else {
            const id = result.broken?.step_id ?? '';
            const reason = healFailureText(result);
            lines.push(`${outcome}${params}  ${id} ${reason}`.trimEnd());
        }
        const heal = result.broken?.heal;
        if (heal?.heal_token) {
            lines.push(`heal ${heal.name} v${heal.version} step ${heal.step_id} (${heal.kind})${heal.intent ? ` ${heal.intent}` : ''}`);
            if (heal.target)
                lines.push(`old target: ${heal.target.role} ${JSON.stringify(heal.target.name)}`);
            lines.push('Pick the ref that performs this intent and call skill_patch. That finishes this combination; call skill_run only for combinations that were skipped.');
            lines.push(`heal_token: ${heal.heal_token}`);
        }
        else if (result.broken?.reason === 'expect_unmatched') {
            lines.push('expect matched no declared outcome; this step is not repaired automatically');
        }
        for (const artifact of result.artifacts ?? []) {
            lines.push(`  ${artifact.step_id}  ${artifact.path}  ${artifact.bytes}  ${artifact.sha256}`);
        }
        for (const warning of result.warnings ?? [])
            lines.push(`  warning: ${warning}`);
        const pageBody = heal?.snapshot ?? (result.outcome !== 'ok' && result.outcome !== 'empty' && result.outcome !== 'skipped' ? result.broken?.excerpt : undefined);
        if (pageBody)
            lines.push(`<page_content>\n${pageBody}\n</page_content>`);
    }
    for (const step of usage?.steps ?? []) {
        lines.push(`llm_tokens ${step.step_id}: prompt=${step.prompt} completion=${step.completion}`);
    }
    lines.push(`llm_tokens: ${usage?.total ?? 0}`);
    return lines.join('\n');
}
function healFailureText(result) {
    const code = result.broken?.reason ?? result.outcome;
    const message = result.message?.trim();
    if (code !== 'heal_failed' || !message)
        return code;
    if (message === code || message.startsWith(`${code}:`) || message.startsWith(`${code} `))
        return message;
    return `${code} ${message}`;
}
export function formatPatchResult(patch) {
    if (!patch.accepted) {
        const reason = patch.reason ?? 'rejected';
        return `rejected: ${reason}${patch.message ? `\n${patch.message}` : ''}`;
    }
    const finished = patch.result;
    const params = finished ? Object.entries(finished.params).map(([key, value]) => `${key}=${value}`).join(' ') : '';
    const done = finished ? finished.steps.filter((step) => step.status === 'done').length : 0;
    const total = finished?.steps.length ?? 0;
    const lines = [
        `patched: ${patch.name} v${patch.to_version}`,
        `finished: ${params}`.trimEnd(),
        `outcome: ${finished?.outcome ?? patch.outcome ?? 'ok'}`,
        `steps: ${done}/${total}`,
    ];
    for (const artifact of finished?.artifacts ?? [])
        lines.push(`  ${artifact.step_id}  ${artifact.path}`);
    const remaining = patch.remaining_params ?? [];
    if (remaining.length === 0) {
        lines.push('This combination is finished. No combinations remain.');
    }
    else {
        lines.push('This combination is finished. Do not run it again.');
        lines.push('remaining:');
        for (const combo of remaining)
            lines.push(`  ${Object.entries(combo).map(([key, value]) => `${key}=${value}`).join(' ')}`);
        lines.push('Call skill_run only for the remaining combinations, with the same out_dir.');
    }
    return lines.join('\n');
}
export function formatTrace(trace) {
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
export function formatSkillList(skills) {
    if (skills.length === 0)
        return 'no skills';
    return skills
        .map((skill) => `${skill.name}  v${skill.version}  ${skill.description}\n  params: ${skill.params.join(', ') || '(none)'}`)
        .join('\n');
}
//# sourceMappingURL=format.js.map