/** Precision-first detectors. Names of other people are not matched unless a field label says so. */
export const SELF_TOKEN = {
    name: '‹我.姓名›',
    account: '‹我.账号›',
    phone: '‹我.手机›',
    email: '‹我.邮箱›',
    idcard: '‹我.身份证›',
};
export const SELF_KINDS = ['name', 'account', 'phone', 'email', 'idcard'];
const LABELS = [
    { text: '身份证', kind: 'idcard', param: 'idcard', tokenKind: '身份证' },
    { text: '证件号', kind: 'idcard', param: 'idcard', tokenKind: '身份证' },
    { text: 'id number', kind: 'idcard', param: 'idcard', tokenKind: '身份证' },
    { text: '出生日期', kind: 'birth', param: 'birth', tokenKind: '出生日期' },
    { text: '联系方式', kind: 'phone', param: 'phone', tokenKind: '手机' },
    { text: '手机号', kind: 'phone', param: 'phone', tokenKind: '手机' },
    { text: '手机', kind: 'phone', param: 'phone', tokenKind: '手机' },
    { text: '电话', kind: 'phone', param: 'phone', tokenKind: '手机' },
    { text: 'phone', kind: 'phone', param: 'phone', tokenKind: '手机' },
    { text: 'mobile', kind: 'phone', param: 'phone', tokenKind: '手机' },
    { text: '邮箱', kind: 'email', param: 'email', tokenKind: '邮箱' },
    { text: 'email', kind: 'email', param: 'email', tokenKind: '邮箱' },
    { text: '班主任', kind: 'name', param: 'teacher', tokenKind: '姓名' },
    { text: '辅导员', kind: 'name', param: 'teacher', tokenKind: '姓名' },
    { text: '教师', kind: 'name', param: 'teacher', tokenKind: '姓名' },
    { text: '老师', kind: 'name', param: 'teacher', tokenKind: '姓名' },
    { text: '用户名', kind: 'account', param: 'username', tokenKind: '账号' },
    { text: 'username', kind: 'account', param: 'username', tokenKind: '账号' },
    { text: '昵称', kind: 'name', param: 'nickname', tokenKind: '姓名' },
    { text: 'nickname', kind: 'name', param: 'nickname', tokenKind: '姓名' },
    { text: '姓名', kind: 'name', param: 'name', tokenKind: '姓名' },
    { text: 'name', kind: 'name', param: 'name', tokenKind: '姓名' },
    { text: '学号', kind: 'student', param: 'student', tokenKind: '学号' },
    { text: '工号', kind: 'student', param: 'student', tokenKind: '学号' },
    { text: '住址', kind: 'address', param: 'address', tokenKind: '住址' },
    { text: '地址', kind: 'address', param: 'address', tokenKind: '住址' },
    { text: 'address', kind: 'address', param: 'address', tokenKind: '住址' },
    { text: 'birth', kind: 'birth', param: 'birth', tokenKind: '出生日期' },
];
const LABEL_BY_TEXT = new Map(LABELS.map((label) => [label.text.toLowerCase(), label]));
const PROVINCES = new Set([
    11, 12, 13, 14, 15, 21, 22, 23, 31, 32, 33, 34, 35, 36, 37, 41, 42, 43, 44, 45, 46, 50, 51, 52, 53, 54, 61, 62, 63, 64, 65, 71, 81, 82, 91,
]);
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
const ROLE_WORDS = /学生|教师|老师|同学/g;
const LOGOUT = /退出|注销|登出|logout|log\s*out|sign\s*out/i;
/** `head` must not match `heading` / `header`. `cxXszp4` matches via `xszp`. */
export const AVATAR_PATTERN = 'avatar|photo|portrait|头像|user_?logo|(?:^|[^a-z])head(?:img|pic|photo)?(?![a-z])|(?:^|[^a-z])(?:xs)?zp(?![a-z])|xszp(?![a-z])';
const SPACE = /[\t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;
/** Collapse NBSP, ideographic spaces, and other Unicode spaces to a single ASCII space. */
export function normalizeSpace(value) {
    return value.replace(SPACE, ' ').trim();
}
export function fold(value) {
    return normalizeSpace(value.normalize('NFKC')).replace(/ /g, '');
}
export function stripRole(value) {
    return normalizeSpace(normalizeSpace(value).replace(ROLE_WORDS, ' '));
}
export function matchesAvatarSignal(value) {
    return new RegExp(AVATAR_PATTERN, 'i').test(value);
}
export function headerCandidateName(value) {
    return cleanCandidate(value);
}
/** Short values keep only the last character. Longer values keep the last two. */
export function maskTail(value) {
    const chars = [...value];
    if (chars.length === 0)
        return value;
    const keep = chars.length <= 4 ? 1 : 2;
    if (chars.length <= keep)
        return value;
    return `${'*'.repeat(chars.length - keep)}${chars.slice(-keep).join('')}`;
}
export function otherToken(kind, n) {
    return `‹${kind}${n}›`;
}
export function labelOf(text) {
    return LABEL_BY_TEXT.get(text.trim().toLowerCase()) ?? null;
}
export function validId18(id) {
    const body = id.toUpperCase();
    if (!/^\d{17}[\dX]$/.test(body))
        return false;
    if (!PROVINCES.has(Number(body.slice(0, 2))))
        return false;
    const year = Number(body.slice(6, 10));
    const month = Number(body.slice(10, 12));
    const day = Number(body.slice(12, 14));
    if (year < 1900 || year > 2099 || !validDate(year, month, day))
        return false;
    let sum = 0;
    for (let i = 0; i < 17; i += 1)
        sum += Number(body[i]) * (ID_WEIGHTS[i] ?? 0);
    return ID_CODES[sum % 11] === body[17];
}
export function validId15(id) {
    if (!/^\d{15}$/.test(id))
        return false;
    if (!PROVINCES.has(Number(id.slice(0, 2))))
        return false;
    const yy = Number(id.slice(6, 8));
    const month = Number(id.slice(8, 10));
    const day = Number(id.slice(10, 12));
    return validDate(1900 + yy, month, day) || validDate(2000 + yy, month, day);
}
export function luhn(digits) {
    if (!/^\d{13,19}$/.test(digits))
        return false;
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
        let n = digits.charCodeAt(i) - 48;
        if (alt) {
            n *= 2;
            if (n > 9)
                n -= 9;
        }
        sum += n;
        alt = !alt;
    }
    return sum % 10 === 0;
}
export function findStructured(original) {
    const scan = original.normalize('NFKC');
    const aligned = scan.length === original.length;
    const text = aligned ? scan : original;
    const hits = [];
    const taken = [];
    const claim = (start, end, kind, tokenKind, param) => {
        if (taken.some((span) => start < span.end && end > span.start))
            return;
        taken.push({ start, end });
        hits.push({ start, end, kind, tokenKind, param, value: original.slice(start, end) });
    };
    for (const match of text.matchAll(/(?<![A-Za-z0-9])(\d{17}[\dXx])(?![A-Za-z0-9])/g)) {
        const digits = match[1] ?? '';
        if (!validId18(digits))
            continue;
        const start = match.index ?? 0;
        claim(start, start + match[0].length, 'idcard', '身份证', 'idcard');
    }
    for (const match of text.matchAll(/(?<![A-Za-z0-9])(\d{15})(?![A-Za-z0-9])/g)) {
        const digits = match[1] ?? '';
        if (!validId15(digits))
            continue;
        const start = match.index ?? 0;
        claim(start, start + match[0].length, 'idcard', '身份证', 'idcard');
    }
    for (const match of text.matchAll(/(?<![A-Za-z0-9])(1[3-9]\d{9})(?![A-Za-z0-9])/g)) {
        const start = match.index ?? 0;
        claim(start, start + match[0].length, 'phone', '手机', 'phone');
    }
    for (const match of text.matchAll(/(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})(?![A-Za-z0-9.-])/g)) {
        const start = match.index ?? 0;
        claim(start, start + match[0].length, 'email', '邮箱', 'email');
    }
    for (const match of text.matchAll(/(?<![A-Za-z0-9])(\d{13,19})(?![A-Za-z0-9])/g)) {
        const digits = match[1] ?? '';
        if (!luhn(digits))
            continue;
        const start = match.index ?? 0;
        claim(start, start + match[0].length, 'card', '银行卡', 'card');
    }
    return hits;
}
export function findLabels(text) {
    const found = [];
    const lines = text.split('\n');
    let headers = null;
    for (const line of lines) {
        const table = /^table\s+"[^"]*"\s+rows=\d+\s+cols:\s*(.+)$/.exec(line);
        if (table?.[1]) {
            headers = table[1].split('|').map((cell) => cell.trim());
            continue;
        }
        if (headers && line.startsWith('  | ')) {
            const cells = splitRow(line);
            headers.forEach((header, index) => {
                const spec = labelOf(header);
                const raw = cells[index];
                if (!spec || raw === undefined)
                    return;
                const value = cleanLabeled(spec, raw);
                if (value)
                    found.push({ value, spec });
            });
            continue;
        }
        headers = null;
        const control = /^\[e\d+\]\s+\S+\s+"([^"]*)"(?:\s+=\s+"([^"]*)")?/.exec(line);
        if (control?.[2]) {
            const spec = labelOf(control[1] ?? '');
            if (spec) {
                const value = cleanLabeled(spec, control[2]);
                if (value)
                    found.push({ value, spec });
            }
        }
    }
    const inline = labelPattern();
    for (const match of text.matchAll(inline)) {
        const spec = labelOf(match[1] ?? '');
        if (!spec)
            continue;
        const value = cleanLabeled(spec, match[2] ?? '');
        if (value)
            found.push({ value, spec });
    }
    return found;
}
export function findCandidates(text, selfValues) {
    const lines = text.split('\n');
    const title = pageTitle(lines);
    const found = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        const logout = LOGOUT.test(line) && !/^(?:h[1-6]|heading)\b/.test(line);
        if (logout || isAvatarLine(line)) {
            const near = nearbyHeaderName(lines, i, title);
            if (near)
                found.push(near);
        }
    }
    for (const self of selfValues) {
        const flex = flexBody(self);
        if (!flex)
            continue;
        const wrapped = new RegExp(`([\\p{L}][\\p{L}\\p{N}]{0,19})\\s*[（(]\\s*${flex}\\s*[）)]`, 'gu');
        const beside = new RegExp(`([\\p{L}][\\p{L}\\p{N}]{0,19})[\\t \\u00a0\\u3000]+${flex}(?![\\p{L}\\p{N}])`, 'gu');
        for (const match of text.matchAll(wrapped)) {
            const name = cleanCandidate(match[1] ?? '');
            if (name)
                found.push(name);
        }
        for (const match of text.matchAll(beside)) {
            const name = cleanCandidate(match[1] ?? '');
            if (name)
                found.push(name);
        }
    }
    return found;
}
export function findVariants(text, value) {
    const source = variantSource(value);
    if (!source)
        return [];
    const pattern = new RegExp(source, 'giu');
    const matches = [];
    for (const match of text.matchAll(pattern)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (match[0].includes('\uE000'))
            continue;
        if (!hanBounded(text, start, end))
            continue;
        matches.push({ start, end });
    }
    return matches;
}
export function looksLikePage(text) {
    return text.startsWith('page:') || text.startsWith('(navigated:') || text.startsWith('(switched to');
}
function pageTitle(lines) {
    const line = lines.find((item) => item.startsWith('page:')) ?? '';
    return /^page:\s+(.*?)\s+url:\s+/.exec(line)?.[1]?.trim() ?? '';
}
function containedInTitle(name, title) {
    const foldedName = normalizeSpace(name).toLowerCase();
    const foldedTitle = normalizeSpace(title).toLowerCase();
    return foldedName.length > 0 && foldedTitle.includes(foldedName);
}
/** Snapshot fallback: only h4–h6 within two lines. h1–h3 and section titles are not the user. */
function nearbyHeaderName(lines, index, title) {
    for (let delta = 1; delta <= 2; delta += 1) {
        for (const at of [index + delta, index - delta]) {
            const line = lines[at];
            if (!line)
                continue;
            const heading = /^(h[4-6])\s+"([^"]*)"/.exec(line);
            if (!heading)
                continue;
            if (sectionTitleLine(lines, at))
                continue;
            const name = acceptableCandidate(heading[2] ?? '', title);
            if (name)
                return name;
        }
    }
    return null;
}
function sectionTitleLine(lines, index) {
    const next = (lines[index + 1] ?? '').trim();
    return /^(?:ul|ol|list|section|dl)\b/i.test(next);
}
function acceptableCandidate(value, title) {
    const name = cleanCandidate(value);
    if (!name || containedInTitle(name, title))
        return null;
    return name;
}
function isAvatarLine(line) {
    if (/^(?:h[1-6]|heading)\s+"/.test(line) || line.startsWith('page:'))
        return false;
    const lower = line.toLowerCase();
    if (lower.includes('logo') && !/user_?logo/.test(lower))
        return false;
    return matchesAvatarSignal(line);
}
function cleanCandidate(value) {
    const text = stripRole(value);
    if (text.length < 2 || [...text].length > 20)
        return null;
    if (LOGOUT.test(text))
        return null;
    if (labelOf(text))
        return null;
    if (/^\d+$/.test(text))
        return null;
    if (/^[a-z]{1,3}$/i.test(text))
        return null;
    return text;
}
function cleanLabeled(spec, raw) {
    let text = raw.trim();
    if (!text || text === '[redacted]' || text.length > 80)
        return null;
    if (spec.kind === 'name' || spec.param === 'teacher' || spec.param === 'nickname')
        text = stripRole(text);
    text = text.trim();
    if (text.length < 2 || text.length > 80)
        return null;
    if (labelOf(text))
        return null;
    return text;
}
function splitRow(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|'))
        return [];
    return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}
function labelPattern() {
    const alts = [...LABELS].sort((left, right) => right.text.length - left.text.length).map((label) => escapeRegExp(label.text));
    return new RegExp(`(?<![\\p{L}\\p{N}])(${alts.join('|')})[^\\S\\n]*[:：][^\\S\\n]*([^\\s,，;；|\\n]{1,80})`, 'giu');
}
function variantSource(value) {
    const body = flexBody(value);
    if (!body)
        return null;
    const encoded = encodedAlt(fold(value));
    const core = encoded ? `(?:${body}|${encoded})` : body;
    // ASCII boundaries keep phones and ids inside longer runs from matching.
    // Han boundaries are applied afterwards so a title like 张三的主页 still matches,
    // while a longer name such as 张三丰 does not.
    return `(?<![A-Za-z0-9%])${core}(?![A-Za-z0-9])`;
}
function hanBounded(text, start, end) {
    const before = start > 0 ? text.codePointAt(start - 1) : undefined;
    const after = text.codePointAt(end);
    if (before !== undefined && isHan(before))
        return false;
    if (after !== undefined && isHan(after) && after !== 0x7684)
        return false;
    return true;
}
function isHan(code) {
    return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}
function flexBody(value) {
    const folded = fold(value);
    if ([...folded].length < 2)
        return null;
    return [...folded]
        .map((ch) => {
        const half = escapeRegExp(ch);
        const full = fullwidth(ch);
        if (full === ch)
            return half;
        return `(?:${half}|${escapeRegExp(full)})`;
    })
        .join('[\\t \\u00a0\\u3000]*');
}
function encodedAlt(value) {
    const encoded = encodeURIComponent(value);
    if (encoded === value)
        return null;
    return encoded.replace(/%[0-9A-F]{2}/gi, (hex) => {
        const upper = hex.toUpperCase();
        const lower = hex.toLowerCase();
        return upper === lower ? upper : `(?:${upper}|${lower})`;
    });
}
function fullwidth(ch) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x21 && code <= 0x7e)
        return String.fromCodePoint(code + 0xfee0);
    return ch;
}
function escapeRegExp(value) {
    return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
function validDate(year, month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31)
        return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
//# sourceMappingURL=detect.js.map