import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tracesDir } from '../config/paths.js';
const OBSERVED_CAP = 20;
let serial = 0;
function createTraceId() {
    serial += 1;
    return `${Date.now()}-${serial}`;
}
const LEAD = /^\((?:navigated: full snapshot|switched to (?:new )?tab:.*)\)$/;
export function observedLines(snapshot) {
    const lines = snapshot.split('\n');
    let index = 0;
    while (index < lines.length && LEAD.test(lines[index] ?? ''))
        index += 1;
    // The next line is the page header, whether or not a switch banner preceded it.
    index += 1;
    return lines.slice(index, index + OBSERVED_CAP);
}
export class TraceLog {
    dir;
    id;
    steps = [];
    constructor(dir = tracesDir()) {
        this.dir = dir;
        mkdirSync(this.dir, { recursive: true });
        this.id = createTraceId();
    }
    view() {
        return { id: this.id, path: join(this.dir, `${this.id}.jsonl`), steps: this.steps.map((step) => ({ ...step })) };
    }
    clear() {
        this.id = createTraceId();
        this.steps.length = 0;
        return this.view();
    }
    append(input, persist = (step) => step) {
        const step = {
            n: this.steps.length + 1,
            at: new Date().toISOString(),
            action: input.action,
            urlBefore: input.urlBefore,
            urlAfter: input.urlAfter,
            observed: input.observed.slice(0, OBSERVED_CAP),
        };
        if (input.target)
            step.target = input.target;
        if (input.value !== undefined)
            step.value = input.value;
        if (input.key !== undefined)
            step.key = input.key;
        if (input.url !== undefined)
            step.url = input.url;
        if (input.tabUrl !== undefined)
            step.tabUrl = input.tabUrl;
        if (input.timeout_ms !== undefined)
            step.timeout_ms = input.timeout_ms;
        if (input.suggested !== undefined)
            step.suggested = input.suggested;
        if (input.landscape !== undefined)
            step.landscape = input.landscape;
        this.steps.push(step);
        mkdirSync(this.dir, { recursive: true });
        const stored = persist(step);
        appendFileSync(join(this.dir, `${this.id}.jsonl`), `${JSON.stringify(stored)}\n`, 'utf8');
        return step;
    }
}
//# sourceMappingURL=trace.js.map