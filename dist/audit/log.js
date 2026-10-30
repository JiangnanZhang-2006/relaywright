import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditDir, errorText, logDaemon } from '../config/paths.js';
const GENESIS = '0'.repeat(64);
const URL_IN_TEXT = /https?:\/\/[^\s]+/g;
let chain = Promise.resolve();
/** Never throws into a request path. Events are queued so the hash chain stays ordered. */
export function recordAudit(event, fields = {}) {
    const job = chain.then(() => appendAudit(event, fields));
    chain = job.catch((err) => {
        logDaemon(`audit write failed: ${errorText(err)}`);
    });
}
export function flushAudit() {
    return chain;
}
export function canonicalJson(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value))
        return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
    const record = value;
    const keys = Object.keys(record)
        .filter((key) => key !== 'hash' && record[key] !== undefined)
        .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
export function hashRecord(prev, record) {
    return createHash('sha256').update(`${prev}${canonicalJson(record)}`).digest('hex');
}
export function readAuditRecords() {
    const files = auditFiles();
    const records = [];
    for (const file of files) {
        const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? '';
            if (!line.trim())
                continue;
            records.push({ file, line: index + 1, record: JSON.parse(line) });
        }
    }
    return records;
}
export function verifyAudit() {
    let prev = GENESIS;
    let saw = false;
    for (const item of readAuditRecords()) {
        saw = true;
        const { hash, ...body } = item.record;
        if (item.record.prev !== prev) {
            return { ok: false, where: `${item.file}:${item.line} prev mismatch` };
        }
        const expected = hashRecord(item.record.prev, body);
        if (expected !== hash)
            return { ok: false, where: `${item.file}:${item.line} hash mismatch` };
        prev = hash;
    }
    if (!saw)
        return { ok: true };
    return { ok: true };
}
export function tailAudit(limit) {
    const records = readAuditRecords().map((item) => item.record);
    return records.slice(Math.max(0, records.length - limit));
}
export function queryAudit(query = {}) {
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    let records = readAuditRecords().map((item) => item.record);
    if (query.since) {
        const since = query.since;
        records = records.filter((record) => String(record.ts) >= since);
    }
    if (query.event)
        records = records.filter((record) => record.event === query.event);
    if (query.identity)
        records = records.filter((record) => record.identity === query.identity);
    if (query.skill) {
        const skill = query.skill;
        records = records.filter((record) => record.skill === skill || record.name === skill);
    }
    return { entries: records.slice(-limit), chain: verifyAudit() };
}
function appendAudit(event, fields) {
    mkdirSync(auditDir(), { recursive: true });
    const prev = lastHash();
    const record = {
        ts: new Date().toISOString(),
        event,
        ...scrubFields(fields),
        prev,
    };
    record.hash = hashRecord(prev, record);
    const file = join(auditDir(), monthFile());
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}
function lastHash() {
    const files = auditFiles();
    for (let index = files.length - 1; index >= 0; index -= 1) {
        const file = files[index];
        if (!file)
            continue;
        const lines = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
        for (let line = lines.length - 1; line >= 0; line -= 1) {
            const text = lines[line];
            if (!text?.trim())
                continue;
            const parsed = JSON.parse(text);
            if (typeof parsed.hash === 'string' && parsed.hash.length > 0)
                return parsed.hash;
        }
    }
    return GENESIS;
}
function auditFiles() {
    const dir = auditDir();
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
        .sort()
        .map((name) => join(dir, name));
}
function monthFile(at = new Date()) {
    const month = String(at.getMonth() + 1).padStart(2, '0');
    return `${at.getFullYear()}-${month}.jsonl`;
}
function scrubFields(fields) {
    const out = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined)
            continue;
        out[key] = scrubValue(value);
    }
    return out;
}
function scrubValue(value) {
    if (typeof value === 'string')
        return value.replace(URL_IN_TEXT, stripQuery);
    if (Array.isArray(value))
        return value.map((item) => scrubValue(item));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, child] of Object.entries(value))
            out[key] = scrubValue(child);
        return out;
    }
    return value;
}
function stripQuery(url) {
    try {
        const parsed = new URL(url);
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    }
    catch {
        const query = url.indexOf('?');
        return query >= 0 ? url.slice(0, query) : url;
    }
}
//# sourceMappingURL=log.js.map