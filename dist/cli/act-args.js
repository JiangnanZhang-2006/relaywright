const ACTIONS = new Set(['click', 'type', 'select', 'press', 'scroll']);
const REF = /^e\d+$/;
export function normalizeActArgs(action, ref, value, key) {
    if (!ACTIONS.has(action)) {
        throw new Error(`Unknown action ${action}. Expected click, type, select, press, or scroll.\nExample: relaywright act click e3`);
    }
    let nextRef = ref;
    let nextValue = value;
    let nextKey = key;
    if (action === 'scroll' && nextRef && (nextRef === 'up' || nextRef === 'down') && nextValue === undefined) {
        nextValue = nextRef;
        nextRef = undefined;
    }
    if (action === 'press') {
        if (!nextKey && nextValue !== undefined) {
            nextKey = nextValue;
            nextValue = undefined;
        }
        else if (!nextKey && nextRef && !REF.test(nextRef)) {
            nextKey = nextRef;
            nextRef = undefined;
        }
    }
    return {
        action: action,
        ref: nextRef,
        value: nextValue,
        key: nextKey,
    };
}
//# sourceMappingURL=act-args.js.map