import { RelayError } from '../errors.js';
export const EXTRACT_DEFAULT_LIMIT = 200;
export const EXTRACT_MAX_LIMIT = 2000;
export const EXTRACT_REDACTED = '‹redacted›';
export function normalizeExtract(input) {
    const root = input.root_selector.trim();
    if (!root)
        throw new RelayError('bad_request', 'root_selector is required');
    const names = Object.keys(input.fields);
    if (names.length === 0)
        throw new RelayError('bad_request', 'extract needs at least one field');
    if (names.includes('frame'))
        throw new RelayError('bad_request', 'Field name frame is reserved');
    const fields = {};
    for (const name of names) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new RelayError('bad_request', `Field name ${name} must be an identifier`);
        }
        const field = input.fields[name];
        if (!field || !field.selector.trim())
            throw new RelayError('bad_request', `Field ${name} needs a selector`);
        fields[name] = {
            selector: field.selector,
            ...(field.attr ? { attr: field.attr } : {}),
            ...(field.all ? { all: true } : {}),
        };
    }
    const limit = input.limit ?? EXTRACT_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > EXTRACT_MAX_LIMIT) {
        throw new RelayError('bad_request', `limit must be an integer from 1 to ${EXTRACT_MAX_LIMIT}`);
    }
    return { root_selector: root, fields, limit };
}
/** `--field name=selector[@attr][*]`. A trailing * asks for every match. */
export function parseExtractField(raw) {
    const eq = raw.indexOf('=');
    if (eq <= 0)
        throw new Error(`Expected name=selector[@attr][*], got ${JSON.stringify(raw)}`);
    const name = raw.slice(0, eq).trim();
    let rest = raw.slice(eq + 1).trim();
    let all = false;
    if (rest.endsWith('*')) {
        all = true;
        rest = rest.slice(0, -1);
    }
    const at = rest.lastIndexOf('@');
    let selector = rest;
    let attr;
    if (at > 0) {
        selector = rest.slice(0, at);
        attr = rest.slice(at + 1);
    }
    if (!name || !selector)
        throw new Error(`Expected name=selector[@attr][*], got ${JSON.stringify(raw)}`);
    return { name, selector, ...(attr ? { attr } : {}), ...(all ? { all: true } : {}) };
}
//# sourceMappingURL=extract.js.map