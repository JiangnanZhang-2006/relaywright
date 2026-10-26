/** Precision-first detectors. Names of other people are not matched unless a field label says so. */

export type SelfKind = 'name' | 'account' | 'phone' | 'email' | 'idcard';

export type ValueKind = 'name' | 'account' | 'phone' | 'email' | 'idcard' | 'card' | 'student' | 'address' | 'birth';

export type TokenKind = '姓名' | '账号' | '手机' | '邮箱' | '身份证' | '银行卡' | '学号' | '住址' | '出生日期' | '候选';

export interface LabelSpec {
  text: string;
  kind: ValueKind;
  /** Param stem. `teacher` stays a bare name; `name` becomes name1. */
  param: string;
  tokenKind: TokenKind;
}

export const SELF_TOKEN: Record<SelfKind, string> = {
  name: '‹我.姓名›',
  account: '‹我.账号›',
  phone: '‹我.手机›',
  email: '‹我.邮箱›',
  idcard: '‹我.身份证›',
};

export const SELF_KINDS: readonly SelfKind[] = ['name', 'account', 'phone', 'email', 'idcard'];

const LABELS: readonly LabelSpec[] = [
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
const AVATAR = /avatar|photo|head|portrait|头像|zp|xszp/i;

export interface StructuredHit {
  start: number;
  end: number;
  kind: ValueKind;
  tokenKind: TokenKind;
  param: string;
  /** Slice of the original text, not the NFKC form. */
  value: string;
}

export interface LabelHit {
  value: string;
  spec: LabelSpec;
}

export function fold(value: string): string {
  return value.normalize('NFKC').replace(/[\s\u3000]+/g, '');
}

export function stripRole(value: string): string {
  return value.replace(ROLE_WORDS, ' ').replace(/\s+/g, ' ').trim();
}

export function maskTail(value: string): string {
  const chars = [...value];
  if (chars.length <= 2) return value;
  return `${'*'.repeat(chars.length - 2)}${chars.slice(-2).join('')}`;
}

export function otherToken(kind: TokenKind, n: number): string {
  return `‹${kind}${n}›`;
}

export function labelOf(text: string): LabelSpec | null {
  return LABEL_BY_TEXT.get(text.trim().toLowerCase()) ?? null;
}

export function validId18(id: string): boolean {
  const body = id.toUpperCase();
  if (!/^\d{17}[\dX]$/.test(body)) return false;
  if (!PROVINCES.has(Number(body.slice(0, 2)))) return false;
  const year = Number(body.slice(6, 10));
  const month = Number(body.slice(10, 12));
  const day = Number(body.slice(12, 14));
  if (year < 1900 || year > 2099 || !validDate(year, month, day)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(body[i]) * (ID_WEIGHTS[i] ?? 0);
  return ID_CODES[sum % 11] === body[17];
}

export function validId15(id: string): boolean {
  if (!/^\d{15}$/.test(id)) return false;
  if (!PROVINCES.has(Number(id.slice(0, 2)))) return false;
  const yy = Number(id.slice(6, 8));
  const month = Number(id.slice(8, 10));
  const day = Number(id.slice(10, 12));
  return validDate(1900 + yy, month, day) || validDate(2000 + yy, month, day);
}

export function luhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function findStructured(original: string): StructuredHit[] {
  const scan = original.normalize('NFKC');
  const aligned = scan.length === original.length;
  const text = aligned ? scan : original;
  const hits: StructuredHit[] = [];
  const taken: Array<{ start: number; end: number }> = [];
  const claim = (start: number, end: number, kind: ValueKind, tokenKind: TokenKind, param: string): void => {
    if (taken.some((span) => start < span.end && end > span.start)) return;
    taken.push({ start, end });
    hits.push({ start, end, kind, tokenKind, param, value: original.slice(start, end) });
  };

  for (const match of text.matchAll(/(?<![A-Za-z0-9])(\d{17}[\dXx])(?![A-Za-z0-9])/g)) {
    const digits = match[1] ?? '';
    if (!validId18(digits)) continue;
    const start = match.index ?? 0;
    claim(start, start + match[0].length, 'idcard', '身份证', 'idcard');
  }
  for (const match of text.matchAll(/(?<![A-Za-z0-9])(\d{15})(?![A-Za-z0-9])/g)) {
    const digits = match[1] ?? '';
    if (!validId15(digits)) continue;
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
    if (!luhn(digits)) continue;
    const start = match.index ?? 0;
    claim(start, start + match[0].length, 'card', '银行卡', 'card');
  }
  return hits;
}

export function findLabels(text: string): LabelHit[] {
  const found: LabelHit[] = [];
  const lines = text.split('\n');
  let headers: string[] | null = null;
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
        if (!spec || raw === undefined) return;
        const value = cleanLabeled(spec, raw);
        if (value) found.push({ value, spec });
      });
      continue;
    }
    headers = null;
    const control = /^\[e\d+\]\s+\S+\s+"([^"]*)"(?:\s+=\s+"([^"]*)")?/.exec(line);
    if (control?.[2]) {
      const spec = labelOf(control[1] ?? '');
      if (spec) {
        const value = cleanLabeled(spec, control[2]);
        if (value) found.push({ value, spec });
      }
    }
  }
  const inline = labelPattern();
  for (const match of text.matchAll(inline)) {
    const spec = labelOf(match[1] ?? '');
    if (!spec) continue;
    const value = cleanLabeled(spec, match[2] ?? '');
    if (value) found.push({ value, spec });
  }
  return found;
}

export function findCandidates(text: string, selfValues: readonly string[]): string[] {
  const lines = text.split('\n');
  const found: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (LOGOUT.test(line) || AVATAR.test(line)) {
      const near = nearestName(lines, i);
      if (near) found.push(near);
    }
  }
  for (const self of selfValues) {
    const flex = flexBody(self);
    if (!flex) continue;
    const wrapped = new RegExp(`([\\p{L}][\\p{L}\\p{N}]{0,19})\\s*[（(]\\s*${flex}\\s*[）)]`, 'gu');
    const beside = new RegExp(`([\\p{L}][\\p{L}\\p{N}]{0,19})[ \\u3000]+${flex}(?![\\p{L}\\p{N}])`, 'gu');
    for (const match of text.matchAll(wrapped)) {
      const name = cleanCandidate(match[1] ?? '');
      if (name) found.push(name);
    }
    for (const match of text.matchAll(beside)) {
      const name = cleanCandidate(match[1] ?? '');
      if (name) found.push(name);
    }
  }
  return found;
}

export interface VariantMatch {
  start: number;
  end: number;
}

export function findVariants(text: string, value: string): VariantMatch[] {
  const source = variantSource(value);
  if (!source) return [];
  const pattern = new RegExp(source, 'giu');
  const matches: VariantMatch[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (match[0].includes('\uE000')) continue;
    if (!hanBounded(text, start, end)) continue;
    matches.push({ start, end });
  }
  return matches;
}

export function looksLikePage(text: string): boolean {
  return text.startsWith('page:') || text.startsWith('(navigated:') || text.startsWith('(switched to');
}

function nearestName(lines: readonly string[], index: number): string | null {
  for (let delta = 1; delta <= 8; delta += 1) {
    const around = [lines[index - delta], lines[index + delta]];
    for (const line of around) {
      if (!line) continue;
      const heading = /^(?:h[1-6]|heading)\s+"([^"]+)"/.exec(line);
      if (!heading?.[1]) continue;
      const name = cleanCandidate(heading[1]);
      if (name) return name;
    }
    for (const line of around) {
      if (!line || /^\[e\d+\]/.test(line) || line.startsWith('  | ') || line.startsWith('table ')) continue;
      const quoted = /"([^"]+)"/.exec(line);
      if (!quoted?.[1]) continue;
      const name = cleanCandidate(quoted[1]);
      if (name) return name;
    }
  }
  return null;
}

function cleanCandidate(value: string): string | null {
  const text = stripRole(value);
  if (text.length < 2 || [...text].length > 20) return null;
  if (LOGOUT.test(text)) return null;
  if (labelOf(text)) return null;
  if (/^\d+$/.test(text)) return null;
  if (/^[a-z]{1,3}$/i.test(text)) return null;
  return text;
}

function cleanLabeled(spec: LabelSpec, raw: string): string | null {
  let text = raw.trim();
  if (!text || text === '[redacted]' || text.length > 80) return null;
  if (spec.kind === 'name' || spec.param === 'teacher' || spec.param === 'nickname') text = stripRole(text);
  text = text.trim();
  if (text.length < 2 || text.length > 80) return null;
  if (labelOf(text)) return null;
  return text;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return [];
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}

function labelPattern(): RegExp {
  const alts = [...LABELS].sort((left, right) => right.text.length - left.text.length).map((label) => escapeRegExp(label.text));
  return new RegExp(`(?<![\\p{L}\\p{N}])(${alts.join('|')})[^\\S\\n]*[:：][^\\S\\n]*([^\\s,，;；|\\n]{1,80})`, 'giu');
}

function variantSource(value: string): string | null {
  const body = flexBody(value);
  if (!body) return null;
  const encoded = encodedAlt(fold(value));
  const core = encoded ? `(?:${body}|${encoded})` : body;
  // ASCII boundaries keep phones and ids inside longer runs from matching.
  // Han boundaries are applied afterwards so a title like 张三的主页 still matches,
  // while a longer name such as 张三丰 does not.
  return `(?<![A-Za-z0-9%])${core}(?![A-Za-z0-9])`;
}

function hanBounded(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text.codePointAt(start - 1) : undefined;
  const after = text.codePointAt(end);
  if (before !== undefined && isHan(before)) return false;
  if (after !== undefined && isHan(after) && after !== 0x7684) return false;
  return true;
}

function isHan(code: number): boolean {
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

function flexBody(value: string): string | null {
  const folded = fold(value);
  if ([...folded].length < 2) return null;
  return [...folded]
    .map((ch) => {
      const half = escapeRegExp(ch);
      const full = fullwidth(ch);
      if (full === ch) return half;
      return `(?:${half}|${escapeRegExp(full)})`;
    })
    .join('[\\t \\u3000]*');
}

function encodedAlt(value: string): string | null {
  const encoded = encodeURIComponent(value);
  if (encoded === value) return null;
  return encoded.replace(/%[0-9A-F]{2}/gi, (hex) => {
    const upper = hex.toUpperCase();
    const lower = hex.toLowerCase();
    return upper === lower ? upper : `(?:${upper}|${lower})`;
  });
}

function fullwidth(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x21 && code <= 0x7e) return String.fromCodePoint(code + 0xfee0);
  return ch;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
