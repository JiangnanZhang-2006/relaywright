import { relaywrightHome } from '../config/paths.js';
import { RelayError } from '../errors.js';
import { stateGet } from './store.js';
const STATE_REF = /\{\{\s*state\.([a-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,128})((?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;
const EXTRACT_REF = /\{\{\s*extract\.([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;
export async function resolveStateText(input, root = relaywrightHome(), scope = {}) {
    const extracted = resolveExtractText(input, scope.extract ?? {}, scope.extractSteps ?? {});
    if (!extracted.includes('{{'))
        return extracted;
    const matches = [...extracted.matchAll(STATE_REF)];
    if (matches.length === 0)
        return extracted;
    let out = '';
    let index = 0;
    for (const match of matches) {
        const start = match.index ?? 0;
        out += extracted.slice(index, start);
        out += await lookup(match, root);
        index = start + match[0].length;
    }
    out += extracted.slice(index);
    return out;
}
export async function resolveStateValue(value, root = relaywrightHome(), scope = {}) {
    if (typeof value === 'string')
        return (await resolveStateText(value, root, scope));
    if (Array.isArray(value)) {
        const out = [];
        for (const item of value)
            out.push(await resolveStateValue(item, root, scope));
        return out;
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, child] of Object.entries(value)) {
            out[key] = await resolveStateValue(child, root, scope);
        }
        return out;
    }
    return value;
}
function resolveExtractText(input, bag, steps) {
    if (!input.includes('{{extract.'))
        return input;
    const matches = [...input.matchAll(EXTRACT_REF)];
    if (matches.length === 0)
        return input;
    let out = '';
    let index = 0;
    for (const match of matches) {
        const start = match.index ?? 0;
        out += input.slice(index, start);
        const name = match[1] ?? '';
        const path = match[2] ?? '';
        if (!Object.prototype.hasOwnProperty.call(bag, name)) {
            const stepId = steps[name];
            const rerun = stepId ? ` Re-run extract step ${stepId}.` : '';
            throw new RelayError('extract_missing', `Missing extract ${name}.${rerun}`);
        }
        const label = name;
        out += stringifyLeaf(walk(bag[name], path, label, 'extract_missing'), path ? `${label}${path}` : label, 'extract_missing');
        index = start + match[0].length;
    }
    out += input.slice(index);
    return out;
}
async function lookup(match, root) {
    const ns = match[1] ?? '';
    const key = match[2] ?? '';
    const path = match[3] ?? '';
    const label = `${ns}/${key}`;
    let entry;
    try {
        entry = await stateGet(ns, key, root);
    }
    catch (err) {
        if (err instanceof RelayError && err.code === 'not_found') {
            throw new RelayError('state_missing', `Missing state ${label}`);
        }
        throw err;
    }
    return stringifyLeaf(walk(entry.value, path, label, 'state_missing'), path ? `${label}${path}` : label, 'state_missing');
}
function walk(value, path, label, code) {
    if (!path)
        return value;
    let current = value;
    let walked = label;
    for (const segment of path.split('.').filter((part) => part.length > 0)) {
        walked += `.${segment}`;
        if (segment === '__proto__' || segment === 'prototype' || segment === 'constructor') {
            throw new RelayError(code, `Missing ${code === 'extract_missing' ? 'extract' : 'state'} path ${walked}`);
        }
        if (Array.isArray(current)) {
            if (!/^\d+$/.test(segment) || Number(segment) >= current.length) {
                throw new RelayError(code, `Missing ${code === 'extract_missing' ? 'extract' : 'state'} path ${walked}`);
            }
            current = current[Number(segment)];
            continue;
        }
        if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)) {
            current = current[segment];
            continue;
        }
        throw new RelayError(code, `Missing ${code === 'extract_missing' ? 'extract' : 'state'} path ${walked}`);
    }
    return current;
}
function stringifyLeaf(value, label, code) {
    if (typeof value === 'string')
        return value;
    if (value === undefined)
        throw new RelayError(code, `Missing ${code === 'extract_missing' ? 'extract' : 'state'} path ${label}`);
    const text = JSON.stringify(value);
    if (text === undefined)
        throw new RelayError(code, `Missing ${code === 'extract_missing' ? 'extract' : 'state'} path ${label}`);
    return text;
}
//# sourceMappingURL=template.js.map