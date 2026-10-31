import { RelayError } from '../errors.js';
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
/**
 * Examples replace only a whole step value, a whole token in free text or a file
 * name, or a whole URL query value / path segment. Host, port, locator text, and a
 * partial segment stay literal. Examples shorter than 2 characters are only a whole
 * step value, a whole query value, or a whole token in a file name (the extension
 * dot is a boundary). Occurrences left literal are returned as misses.
 */
export function templatize(input, params, place) {
    if (input === '{{secret}}')
        return { text: input, used: new Set(), missed: [] };
    const ordered = orderedParams(params);
    if (place === 'value')
        return finish(input, ordered, valueRanges(input, ordered), () => undefined);
    if (place === 'text' || place === 'file' || place === 'anchor') {
        return finish(input, ordered, textRanges(input, ordered, place !== 'text'), () => undefined);
    }
    const marks = urlMarks(input);
    return finish(input, ordered, urlRanges(input, ordered, marks), (index) => partAt(marks, index));
}
export function renderTemplate(input, params, declared) {
    return input.replace(PLACEHOLDER, (_full, name) => {
        if (name === 'secret') {
            throw new RelayError('bad_params', 'Secrets are not supported until the vault exists ({{secret}}).');
        }
        if (!declared.has(name))
            throw new RelayError('bad_params', `Unknown placeholder {{${name}}}`);
        if (!Object.prototype.hasOwnProperty.call(params, name)) {
            throw new RelayError('bad_params', `Missing required param ${name}`);
        }
        return params[name] ?? '';
    });
}
function orderedParams(params) {
    return [...params]
        .filter((param) => param.example.length > 0)
        .sort((left, right) => characterLength(right.example) - characterLength(left.example) || left.name.localeCompare(right.name));
}
function characterLength(value) {
    return [...value].length;
}
function shortExample(example) {
    return characterLength(example) < 2;
}
function finish(input, params, ranges, partOf) {
    const used = new Set(ranges.map((range) => range.name));
    return { text: applyRanges(input, ranges), used, missed: collectMisses(input, params, ranges, partOf) };
}
function valueRanges(input, params) {
    for (const param of params) {
        if (param.example === input)
            return [{ start: 0, end: input.length, name: param.name }];
    }
    return [];
}
function textRanges(input, params, allowShort = false) {
    const ranges = [];
    let index = 0;
    while (index < input.length) {
        let hit;
        for (const param of params) {
            if (!allowShort && shortExample(param.example))
                continue;
            if (!input.startsWith(param.example, index))
                continue;
            if (!tokenBounded(input, index, param.example))
                continue;
            hit = param;
            break;
        }
        if (hit) {
            ranges.push({ start: index, end: index + hit.example.length, name: hit.name });
            index += hit.example.length;
            continue;
        }
        index += 1;
    }
    return ranges;
}
function tokenBounded(input, index, literal) {
    const before = index > 0 ? input[index - 1] : '';
    const after = input[index + literal.length] ?? '';
    return !/[A-Za-z0-9]/.test(before ?? '') && !/[A-Za-z0-9]/.test(after);
}
/** First index where `literal` occurs with no letter or digit on either side, or -1. */
export function tokenIndex(input, literal) {
    if (!literal)
        return -1;
    let from = 0;
    for (;;) {
        const at = input.indexOf(literal, from);
        if (at < 0)
            return -1;
        if (tokenBounded(input, at, literal))
            return at;
        from = at + 1;
    }
}
function urlRanges(input, params, marks) {
    const ranges = [];
    for (const mark of marks) {
        if (!mark.eligible)
            continue;
        const slice = input.slice(mark.start, mark.end);
        for (const param of params) {
            if (slice !== param.example)
                continue;
            if (shortExample(param.example) && mark.part !== 'query')
                break;
            ranges.push({ start: mark.start, end: mark.end, name: param.name });
            break;
        }
    }
    return ranges;
}
function applyRanges(input, ranges) {
    const ordered = [...ranges].sort((left, right) => right.start - left.start);
    let text = input;
    for (const range of ordered) {
        text = `${text.slice(0, range.start)}{{${range.name}}}${text.slice(range.end)}`;
    }
    return text;
}
function collectMisses(input, params, ranges, partOf) {
    const missed = [];
    const seen = new Set();
    for (const param of params) {
        let from = 0;
        while (from < input.length) {
            const at = input.indexOf(param.example, from);
            if (at < 0)
                break;
            const end = at + param.example.length;
            const covered = ranges.some((range) => range.start <= at && range.end >= end);
            if (!covered) {
                const part = partOf(at);
                const key = `${param.name}\0${part ?? ''}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    missed.push(part ? { name: param.name, part } : { name: param.name });
                }
            }
            from = at + 1;
        }
    }
    return missed;
}
function partAt(marks, index) {
    for (const mark of marks) {
        if (index >= mark.start && index < mark.end)
            return mark.part;
    }
    return 'url';
}
function urlMarks(input) {
    const marks = [];
    let index = 0;
    const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(input);
    if (scheme?.[0]) {
        push(marks, 0, scheme[0].length, 'scheme');
        index = scheme[0].length;
    }
    else if (input.startsWith('//')) {
        push(marks, 0, 2, 'scheme');
        index = 2;
    }
    const rest = input.slice(index);
    const headed = Boolean(scheme?.[0]) || input.startsWith('//');
    if ((headed || looksLikeHost(rest)) && !rest.startsWith('/')) {
        let authEnd = index;
        while (authEnd < input.length && input[authEnd] !== '/' && input[authEnd] !== '?' && input[authEnd] !== '#')
            authEnd += 1;
        const split = splitHostPort(input.slice(index, authEnd));
        push(marks, index, index + split.host.length, 'host');
        if (split.port) {
            const colon = index + split.host.length;
            push(marks, colon, colon + 1, 'port');
            push(marks, colon + 1, authEnd, 'port');
        }
        index = authEnd;
    }
    else if (!rest.includes('/') && rest.includes('=')) {
        const queryEnd = endBeforeHash(input, index);
        markQuery(marks, input, index, queryEnd);
        if (queryEnd < input.length)
            push(marks, queryEnd, input.length, 'hash');
        return marks;
    }
    if (index < input.length && input[index] !== '?' && input[index] !== '#') {
        const pathEnd = endBeforeQueryOrHash(input, index);
        markPath(marks, input, index, pathEnd);
        index = pathEnd;
    }
    if (index < input.length && input[index] === '?') {
        const queryEnd = endBeforeHash(input, index + 1);
        markQuery(marks, input, index, queryEnd);
        index = queryEnd;
    }
    if (index < input.length && input[index] === '#') {
        push(marks, index, input.length, 'hash');
        index = input.length;
    }
    if (index < input.length)
        push(marks, index, input.length, 'url');
    return marks;
}
function looksLikeHost(rest) {
    if (!rest || rest.startsWith('/') || rest.startsWith('?') || rest.startsWith('#'))
        return false;
    const end = firstOf(rest, ['/', '?', '#']);
    const authority = end < 0 ? rest : rest.slice(0, end);
    if (!authority || /\s/.test(authority))
        return false;
    if (authority.startsWith('['))
        return true;
    if (authority === 'localhost' || authority.startsWith('localhost:'))
        return true;
    return authority.includes('.');
}
function splitHostPort(authority) {
    if (authority.startsWith('[')) {
        const close = authority.indexOf(']');
        if (close >= 0) {
            const host = authority.slice(0, close + 1);
            const rest = authority.slice(close + 1);
            if (rest.startsWith(':'))
                return { host, port: rest.slice(1) };
            return { host, port: '' };
        }
    }
    const colon = authority.lastIndexOf(':');
    if (colon >= 0 && /^\d+$/.test(authority.slice(colon + 1))) {
        return { host: authority.slice(0, colon), port: authority.slice(colon + 1) };
    }
    return { host: authority, port: '' };
}
function markPath(marks, input, start, end) {
    let cursor = start;
    while (cursor < end) {
        if (input[cursor] === '/') {
            push(marks, cursor, cursor + 1, 'path');
            cursor += 1;
            continue;
        }
        const segment = cursor;
        while (cursor < end && input[cursor] !== '/')
            cursor += 1;
        push(marks, segment, cursor, 'path', true);
    }
}
function markQuery(marks, input, start, end) {
    let cursor = start;
    if (input[cursor] === '?') {
        push(marks, cursor, cursor + 1, 'query');
        cursor += 1;
    }
    while (cursor < end) {
        if (input[cursor] === '&') {
            push(marks, cursor, cursor + 1, 'query');
            cursor += 1;
            continue;
        }
        const part = cursor;
        while (cursor < end && input[cursor] !== '&')
            cursor += 1;
        const eq = input.indexOf('=', part);
        if (eq >= part && eq < cursor) {
            push(marks, part, eq + 1, 'query');
            push(marks, eq + 1, cursor, 'query', true);
        }
        else {
            push(marks, part, cursor, 'query');
        }
    }
}
function endBeforeHash(input, start) {
    const hash = input.indexOf('#', start);
    return hash < 0 ? input.length : hash;
}
function endBeforeQueryOrHash(input, start) {
    let end = input.length;
    const query = input.indexOf('?', start);
    const hash = input.indexOf('#', start);
    if (query >= 0)
        end = Math.min(end, query);
    if (hash >= 0)
        end = Math.min(end, hash);
    return end;
}
function firstOf(input, chars) {
    let at = -1;
    for (const char of chars) {
        const found = input.indexOf(char);
        if (found >= 0 && (at < 0 || found < at))
            at = found;
    }
    return at;
}
function push(marks, start, end, part, eligible = false) {
    if (end > start)
        marks.push({ start, end, part, eligible });
}
//# sourceMappingURL=template.js.map