import { RelayError } from '../errors.js';
/** Hidden tabs do not run requestAnimationFrame, so paint must not wait on it. */
export const PAINT_TIMEOUT_MS = 300;
export function bounded(work, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new RelayError('timeout', `${label} timed out after ${ms}ms`));
        }, ms);
        work.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (err) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
}
function paintFrames() {
    return new Promise((resolve) => {
        const view = globalThis;
        const raf = view.requestAnimationFrame?.bind(view);
        if (!raf) {
            resolve();
            return;
        }
        raf(() => raf(() => resolve()));
    });
}
/** Two animation frames, or give up. `evaluate` is injected so tests can hang it. */
export async function runPaint(evaluate, timeoutMs = PAINT_TIMEOUT_MS) {
    await bounded(evaluate(paintFrames), timeoutMs, 'paint').catch(() => undefined);
}
//# sourceMappingURL=timeout.js.map