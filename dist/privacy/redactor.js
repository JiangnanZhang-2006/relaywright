import { recordAudit } from '../audit/log.js';
import { logDaemon } from '../config/paths.js';
import { RelayError } from '../errors.js';
import { SkillSchema } from '../skills/schema.js';
import { findCandidates, findLabels, findStructured, findVariants, fold, headerCandidateName, labelOf, looksLikePage, maskTail, otherToken, SELF_KINDS, SELF_TOKEN, stripRole, } from './detect.js';
import { PrivacyStore, safeKey } from './store.js';
export class PrivacyGap extends RelayError {
    gap = true;
    constructor(message) {
        super('bad_request', message);
    }
}
const BARE_PARAMS = new Set(['teacher', 'nickname', 'username']);
const TOKEN_RE = /‹[^›\n]{1,40}›/g;
let envLogged = false;
function envMode() {
    const raw = process.env.RELAYWRIGHT_PRIVACY?.trim().toLowerCase();
    if (raw === 'on' || raw === '1' || raw === 'true') {
        noteEnv('on');
        return true;
    }
    if (raw === 'off' || raw === '0' || raw === 'false') {
        noteEnv('off');
        return false;
    }
    return null;
}
function noteEnv(state) {
    if (envLogged)
        return;
    envLogged = true;
    logDaemon(`RELAYWRIGHT_PRIVACY=${state} overrides privacy.model_redaction`);
}
/**
 * Model-facing redaction is opt-in. Skill files are always de-identified,
 * from the raw trace, even when the model is allowed to see real values.
 */
export class Redactor {
    store;
    buckets = new Map();
    auditEvent;
    constructor(options = {}) {
        this.store = new PrivacyStore(options.root);
        this.auditEvent = options.audit ?? recordAudit;
    }
    modelRedaction(url) {
        const env = envMode();
        if (env !== null)
            return env;
        const key = this.store.identityKey(url);
        if (key) {
            const override = this.bucketFor(url).file.model_redaction;
            if (typeof override === 'boolean')
                return override;
        }
        return this.store.globalMode();
    }
    setGlobalMode(on) {
        this.store.setGlobalMode(on);
    }
    setIdentityMode(identity, on) {
        const bucket = this.bucketFor(undefined, identity);
        bucket.file.model_redaction = on;
        bucket.dirty = true;
        this.save(bucket);
    }
    /** Names from the live header (avatar / logout). Raw values are not returned to the model. */
    noteHeaderCandidates(values, url) {
        const bucket = this.bucketFor(url);
        for (const value of values) {
            const cleaned = headerCandidateName(value);
            if (!cleaned)
                continue;
            this.addPending(bucket, cleaned, { kind: 'name', param: 'name', tokenKind: '候选', source: 'candidate' });
        }
    }
    /** Learn labelled values, patterns, and self candidates. Does not mask and does not allocate tokens. */
    absorb(text, url) {
        if (!text)
            return;
        this.absorbInto(text, this.bucketFor(url));
    }
    /** Mode-aware. Off returns the text unchanged and writes no reveal audit. */
    present(text, url) {
        if (!this.modelRedaction(url))
            return text;
        return this.mask(text, url);
    }
    mask(text, url) {
        return this.maskValue(text, url);
    }
    maskValue(value, url) {
        const bucket = this.bucketFor(url);
        const copy = structuredClone(value);
        this.absorbValue(copy, bucket);
        const masked = this.replaceValue(copy, bucket, true);
        this.save(bucket);
        return masked;
    }
    reveal(text, action, url) {
        if (!text.includes('‹'))
            return text;
        const bucket = this.bucketFor(url);
        const audit = this.modelRedaction(url);
        return text.replace(TOKEN_RE, (token) => {
            const value = this.lookup(bucket, token);
            if (value === undefined)
                throw new RelayError('bad_request', `Unknown privacy token ${token}`);
            if (audit)
                this.auditEvent('privacy_reveal', { token, action });
            return value;
        });
    }
    addSelf(kind, value, where) {
        const cleaned = (kind === 'name' ? stripRole(value) : value).trim();
        if (!cleaned || [...cleaned].length > 80)
            throw new RelayError('bad_request', 'A self value must be 1-80 characters');
        const buckets = where?.urls && where.urls.length > 0 ? where.urls.map((url) => this.bucketFor(url)) : [this.bucketFor(where?.url, where?.identity)];
        const seen = new Set();
        for (const bucket of buckets) {
            if (seen.has(bucket))
                continue;
            seen.add(bucket);
            bucket.file.self[kind] = cleaned;
            const folded = fold(cleaned);
            delete bucket.file.candidates[folded];
            bucket.sessionCandidates.delete(folded);
            bucket.pending.delete(folded);
            bucket.dirty = true;
            this.save(bucket);
        }
        return SELF_TOKEN[kind];
    }
    confirm(token, as, url, identity) {
        const bucket = this.bucketFor(url, identity);
        const found = this.candidateByToken(bucket, token);
        if (!found)
            throw new RelayError('bad_request', `Unknown privacy token ${token}`);
        const kind = as ?? 'name';
        bucket.file.self[kind] = found.value;
        delete bucket.file.candidates[found.folded];
        bucket.sessionCandidates.delete(found.folded);
        bucket.pending.delete(found.folded);
        bucket.file.aliases[token] = SELF_TOKEN[kind];
        bucket.dirty = true;
        this.save(bucket);
        return { token: SELF_TOKEN[kind], as: kind };
    }
    reject(token, url, identity) {
        const bucket = this.bucketFor(url, identity);
        const found = this.candidateByToken(bucket, token);
        if (!found)
            throw new RelayError('bad_request', `Unknown privacy token ${token}`);
        if (!bucket.file.rejections.includes(found.folded))
            bucket.file.rejections.push(found.folded);
        delete bucket.file.candidates[found.folded];
        bucket.sessionCandidates.delete(found.folded);
        bucket.pending.delete(found.folded);
        bucket.file.retired[token] = found.value;
        bucket.dirty = true;
        this.save(bucket);
        return { token, rejected: true };
    }
    list(url, identity) {
        const bucket = this.bucketFor(url, identity);
        const self = SELF_KINDS.flatMap((kind) => {
            const value = bucket.file.self[kind];
            if (!value)
                return [];
            return [{ token: SELF_TOKEN[kind], kind, masked: maskTail(value) }];
        });
        return { identity: bucket.key, self };
    }
    check(text, url, identity) {
        const bucket = this.bucketFor(url, identity);
        this.absorbInto(text, bucket);
        const rows = this.rows(this.protect(text), bucket, 'check');
        this.save(bucket);
        const counts = { self: 0, others: 0, candidates: 0 };
        const lines = [];
        const seen = new Set();
        for (const row of rows) {
            if (seen.has(row.token))
                continue;
            seen.add(row.token);
            if (row.source === 'self')
                counts.self += 1;
            else if (row.source === 'candidate')
                counts.candidates += 1;
            else
                counts.others += 1;
            lines.push(`${row.token}  ${row.kind}  ${row.source}  ${row.value}`);
        }
        return { identity: bucket.key, lines, counts };
    }
    /**
     * Skill files always lose raw personal data. Self values become ‹我.*› tokens.
     * Other people, patterns, labels, and unconfirmed candidates become {{params}}.
     * The report names tokens and params only.
     */
    deidentify(skill, url) {
        const bucket = this.bucketFor(url, this.store.identityKey(url) ? undefined : skill.identity);
        const ctx = {
            bucket,
            alloc: new ParamAlloc(Object.keys(skill.params)),
            tokens: new Map(),
            params: new Map(),
        };
        const next = {
            ...skill,
            description: this.rewrite(skill.description, ctx),
            start_url: this.rewrite(skill.start_url, ctx),
            params: { ...skill.params },
            steps: skill.steps.map((step) => this.rewriteStep(step, ctx)),
        };
        for (const [name, param] of Object.entries(next.params)) {
            if (param.example && this.personal(param.example, ctx)) {
                const { example: _example, ...rest } = param;
                next.params[name] = rest;
            }
        }
        for (const [folded, claimed] of ctx.alloc.entries()) {
            void folded;
            if (!next.params[claimed.name])
                next.params[claimed.name] = { type: 'string' };
        }
        const parsed = SkillSchema.safeParse(next);
        if (!parsed.success) {
            throw new RelayError('bad_params', 'Skill could not be saved after removing personal data');
        }
        const report = {
            tokens: [...ctx.tokens.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
            params: [...ctx.params.entries()]
                .map(([name, item]) => ({ name, kind: item.kind, count: item.count }))
                .sort((a, b) => a.name.localeCompare(b.name)),
        };
        return { skill: parsed.data, report };
    }
    prepareRun(skill, input) {
        const url = input.startUrl || skill.start_url;
        const bucket = this.bucketFor(url, this.store.identityKey(url) ? undefined : skill.identity);
        const params = input.params ? mapRecord(input.params, (value) => this.reveal(value, 'skill_run', url)) : undefined;
        const matrix = input.matrix
            ? mapRecord(input.matrix, (values) => values.map((value) => this.reveal(value, 'skill_run', url)))
            : undefined;
        const missing = new Set();
        const resolve = (text) => text.replace(TOKEN_RE, (token) => {
            if (token.startsWith('‹我.')) {
                const value = this.selfByToken(bucket, token);
                if (!value) {
                    missing.add(token);
                    return token;
                }
                return value;
            }
            const value = this.lookup(bucket, token);
            if (value === undefined)
                throw new RelayError('bad_request', `Unknown privacy token ${token}`);
            if (this.modelRedaction(url))
                this.auditEvent('privacy_reveal', { token, action: 'skill_run' });
            return value;
        });
        const resolved = this.mapSkillText(skill, resolve);
        if (missing.size > 0) {
            const tokens = [...missing].sort().join(', ');
            throw new PrivacyGap(`Missing self value ${tokens} for this identity. Add it with: relaywright privacy add`);
        }
        return { skill: resolved, input: { ...input, ...(params ? { params } : {}), ...(matrix ? { matrix } : {}) } };
    }
    mapSkillText(skill, render) {
        const ctx = renderCtx(render);
        return {
            ...skill,
            description: render(skill.description),
            start_url: render(skill.start_url),
            steps: skill.steps.map((step) => this.rewriteStep(step, ctx)),
        };
    }
    rewriteStep(step, ctx) {
        const text = (value) => ('render' in ctx ? ctx.render(value) : this.rewrite(value, ctx));
        const target = (value) => ('render' in ctx ? mapTarget(value, ctx.render) : this.rewriteTarget(value, step.id, ctx));
        const next = { ...step, id: text(step.id) };
        if (step.intent)
            next.intent = text(step.intent);
        if (step.goto)
            next.goto = { url: text(step.goto.url) };
        if (step.click)
            next.click = { target: target(step.click.target) };
        if (step.type)
            next.type = { target: target(step.type.target), value: text(step.type.value), ...(step.type.key ? { key: step.type.key } : {}) };
        if (step.select)
            next.select = { target: target(step.select.target), value: text(step.select.value) };
        if (step.press)
            next.press = { key: step.press.key, ...(step.press.target ? { target: target(step.press.target) } : {}) };
        if (step.scroll) {
            next.scroll = {
                ...(step.scroll.target ? { target: target(step.scroll.target) } : {}),
                ...(step.scroll.direction ? { direction: step.scroll.direction } : {}),
            };
        }
        if (step.wait) {
            next.wait = {
                ...(step.wait.text ? { text: text(step.wait.text) } : {}),
                ...(step.wait.url ? { url: text(step.wait.url) } : {}),
                ...(step.wait.target ? { target: target(step.wait.target) } : {}),
                ...(step.wait.timeout_ms ? { timeout_ms: step.wait.timeout_ms } : {}),
            };
        }
        if (step.expect) {
            next.expect = {
                any: step.expect.any.map((branch) => ({
                    outcome: branch.outcome,
                    when: {
                        ...(branch.when.text_present ? { text_present: text(branch.when.text_present) } : {}),
                        ...(branch.when.text_absent ? { text_absent: text(branch.when.text_absent) } : {}),
                        ...(branch.when.table_rows_min !== undefined ? { table_rows_min: branch.when.table_rows_min } : {}),
                        ...(branch.when.url_contains ? { url_contains: text(branch.when.url_contains) } : {}),
                    },
                    ...(branch.message ? { message: text(branch.message) } : {}),
                })),
            };
        }
        if (step.download) {
            next.download = {
                click: { target: target(step.download.click.target) },
                save_as: text(step.download.save_as),
                ...(step.download.timeout_ms ? { timeout_ms: step.download.timeout_ms } : {}),
            };
        }
        if (step.pdf)
            next.pdf = { save_as: text(step.pdf.save_as), ...(step.pdf.landscape !== undefined ? { landscape: step.pdf.landscape } : {}) };
        if (step.state_set) {
            next.state_set = { ns: step.state_set.ns, key: step.state_set.key, value: text(step.state_set.value) };
        }
        if (step.extract) {
            const fields = {};
            for (const [name, field] of Object.entries(step.extract.fields)) {
                fields[name] = {
                    selector: text(field.selector),
                    ...(field.attr ? { attr: text(field.attr) } : {}),
                    ...(field.all ? { all: true } : {}),
                };
            }
            next.extract = {
                root_selector: text(step.extract.root_selector),
                save_as: step.extract.save_as,
                ...(step.extract.limit !== undefined ? { limit: step.extract.limit } : {}),
                fields,
            };
        }
        return next;
    }
    rewriteTarget(target, stepId, ctx) {
        const name = this.rewrite(target.name, ctx);
        const text = target.text === undefined ? undefined : this.rewrite(target.text, ctx);
        const label = target.label === undefined ? undefined : this.rewrite(target.label, ctx);
        let css = target.css;
        if (css && this.personal(css, ctx)) {
            if (name.trim() || (text && text.trim()))
                css = undefined;
            else {
                throw new RelayError('bad_params', `Step ${stepId} cannot be saved because personal data is part of its only locator (css). Choose a role and name that do not include that data.`);
            }
        }
        const frame = target.frame ? { name: this.rewrite(target.frame.name, ctx), url: this.rewrite(target.frame.url, ctx) } : undefined;
        const within = target.within === undefined ? undefined : this.rewrite(target.within, ctx);
        if (!name.trim() && !(text && text.trim()) && !css) {
            throw new RelayError('bad_params', `Step ${stepId} cannot be saved because personal data is part of its only locator. Choose a role and name that do not include that data.`);
        }
        return {
            role: target.role,
            name,
            ...(label ? { label } : {}),
            ...(css ? { css } : {}),
            ...(text !== undefined ? { text } : {}),
            ...(frame ? { frame } : {}),
            ...(within !== undefined ? { within } : {}),
            ...(target.nth !== undefined ? { nth: target.nth } : {}),
            ...(target.of !== undefined ? { of: target.of } : {}),
        };
    }
    personal(text, ctx) {
        return this.collect(this.protect(text), ctx.bucket, 'skill').length > 0;
    }
    rewrite(text, ctx) {
        const protectedText = this.protect(text);
        const spans = this.collect(protectedText, ctx.bucket, 'skill');
        if (spans.length === 0)
            return text;
        let out = '';
        let index = 0;
        for (const span of spans) {
            const replacement = this.skillReplacement(span, ctx);
            out += protectedText.slice(index, span.start) + replacement;
            index = span.end;
        }
        out += protectedText.slice(index);
        return this.restore(out);
    }
    skillReplacement(span, ctx) {
        if (span.self) {
            const token = SELF_TOKEN[span.self];
            ctx.tokens.set(token, (ctx.tokens.get(token) ?? 0) + 1);
            return token;
        }
        const pending = span.pending;
        if (!pending)
            return '';
        const stem = paramStem(pending);
        const name = ctx.alloc.claim(pending.folded, stem, stem);
        const current = ctx.params.get(name) ?? { kind: stem, count: 0 };
        current.count += 1;
        ctx.params.set(name, current);
        return `{{${name}}}`;
    }
    replaceValue(value, bucket, hint) {
        if (typeof value === 'string')
            return this.maskString(value, bucket, hint);
        if (Array.isArray(value))
            return value.map((item) => this.replaceValue(item, bucket, hint));
        if (value && typeof value === 'object') {
            const out = {};
            for (const [key, item] of Object.entries(value))
                out[key] = this.replaceValue(item, bucket, hint);
            return out;
        }
        return value;
    }
    absorbValue(value, bucket) {
        if (typeof value === 'string') {
            this.absorbInto(value, bucket);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value)
                this.absorbValue(item, bucket);
            return;
        }
        if (value && typeof value === 'object') {
            for (const item of Object.values(value))
                this.absorbValue(item, bucket);
        }
    }
    maskString(text, bucket, hint) {
        const protectedText = this.protect(text);
        const spans = this.collect(protectedText, bucket, 'mask');
        let out = '';
        let index = 0;
        const hinted = new Set();
        for (const span of spans) {
            const replacement = this.maskReplacement(span, bucket, hinted);
            out += protectedText.slice(index, span.start) + replacement;
            index = span.end;
        }
        out += protectedText.slice(index);
        out = this.restore(out);
        if (hint && looksLikePage(text) && hinted.size > 0 && !out.includes('(privacy:')) {
            const tokens = [...hinted].sort().join(', ');
            out += `\n(privacy: ${tokens} looks like the user's own info; ask the user and call privacy_confirm)`;
        }
        return out;
    }
    maskReplacement(span, bucket, hinted) {
        if (span.self)
            return SELF_TOKEN[span.self];
        const pending = span.pending;
        if (!pending)
            return '';
        const token = this.tokenFor(bucket, pending);
        if (bucket.file.allow.includes(token))
            return pending.value;
        if (token.startsWith('‹候选'))
            hinted.add(token);
        return token;
    }
    tokenFor(bucket, pending) {
        const storedOther = bucket.file.others[pending.folded];
        if (storedOther)
            return storedOther.token;
        const want = wantKind(pending);
        if (want === '候选')
            return this.sessionCandidateToken(bucket, pending);
        const n = (bucket.file.next[want] ?? 0) + 1;
        bucket.file.next[want] = n;
        const token = otherToken(want, n);
        const stored = {
            token,
            n,
            value: pending.value,
            kind: pending.kind,
            param: paramStem(pending),
            tokenKind: want,
        };
        bucket.file.others[pending.folded] = stored;
        bucket.dirty = true;
        return token;
    }
    /** Candidate numbers restart with the process and are not stored. */
    sessionCandidateToken(bucket, pending) {
        const known = bucket.sessionCandidates.get(pending.folded);
        if (known)
            return known.token;
        const n = bucket.sessionCandidateNext + 1;
        bucket.sessionCandidateNext = n;
        const token = otherToken('候选', n);
        bucket.sessionCandidates.set(pending.folded, { token, n, value: pending.value });
        return token;
    }
    rows(text, bucket, purpose) {
        return this.collect(text, bucket, purpose).map((span) => {
            if (span.self) {
                const value = bucket.file.self[span.self] ?? '';
                return { token: SELF_TOKEN[span.self], kind: span.self, source: 'self', value };
            }
            const pending = span.pending;
            if (!pending)
                return { token: '', kind: '', source: 'label', value: '' };
            const token = this.tokenFor(bucket, pending);
            const source = pending.sources.has('pattern') ? 'pattern' : pending.sources.has('label') ? 'label' : 'candidate';
            return { token, kind: pending.kind, source, value: pending.value };
        });
    }
    collect(text, bucket, purpose) {
        this.hydrate(bucket);
        const found = [];
        for (const kind of SELF_KINDS) {
            const value = bucket.file.self[kind];
            if (!value)
                continue;
            if (purpose === 'mask' && this.allowed(bucket, SELF_TOKEN[kind], kind))
                continue;
            for (const match of findVariants(text, value))
                found.push({ ...match, rank: 0, self: kind });
        }
        for (const pending of bucket.pending.values()) {
            if (this.selfFold(bucket, pending.folded))
                continue;
            const rejected = bucket.file.rejections.includes(pending.folded);
            const onlyCandidate = pending.sources.size === 1 && pending.sources.has('candidate');
            if (rejected && onlyCandidate && purpose !== 'check')
                continue;
            if (purpose === 'mask' && this.allowed(bucket, undefined, pending.kind, pending.tokenKind, pending.param))
                continue;
            const rank = pending.sources.has('pattern') ? 1 : pending.sources.has('candidate') ? 2 : 3;
            for (const match of findVariants(text, pending.value))
                found.push({ ...match, rank, pending });
        }
        found.sort((left, right) => left.start - right.start || right.end - left.end || left.rank - right.rank);
        const chosen = [];
        let cursor = 0;
        for (const span of found) {
            if (span.start < cursor || span.end <= span.start)
                continue;
            chosen.push(span);
            cursor = span.end;
        }
        return chosen;
    }
    allowed(bucket, token, ...kinds) {
        if (token && bucket.file.allow.includes(token))
            return true;
        return kinds.some((kind) => bucket.file.allow.includes(kind));
    }
    hydrate(bucket) {
        for (const [key, other] of Object.entries(bucket.file.others)) {
            if (bucket.pending.has(key) || this.selfFold(bucket, key))
                continue;
            bucket.pending.set(key, {
                folded: key,
                value: other.value,
                kind: other.kind,
                param: other.param,
                tokenKind: other.tokenKind,
                sources: new Set(['label']),
            });
        }
    }
    absorbInto(text, bucket) {
        if (!text)
            return;
        // Labels and header candidates only come from page snapshots. Skill YAML uses
        // keys such as `name:` and must not be learned as someone else's name.
        if (pageish(text)) {
            for (const hit of findLabels(text)) {
                this.addPending(bucket, hit.value, {
                    kind: hit.spec.kind,
                    param: hit.spec.param,
                    tokenKind: hit.spec.tokenKind,
                    source: 'label',
                });
            }
        }
        for (const hit of findStructured(text)) {
            this.addPending(bucket, hit.value, { kind: hit.kind, param: hit.param, tokenKind: hit.tokenKind, source: 'pattern' });
        }
        const decoded = percentDecoded(text);
        if (decoded) {
            for (const hit of findStructured(decoded)) {
                this.addPending(bucket, hit.value, { kind: hit.kind, param: hit.param, tokenKind: hit.tokenKind, source: 'pattern' });
            }
        }
        if (!pageish(text))
            return;
        const selves = SELF_KINDS.flatMap((kind) => {
            const value = bucket.file.self[kind];
            return value ? [value] : [];
        });
        for (const value of findCandidates(text, selves)) {
            this.addPending(bucket, value, { kind: 'name', param: 'name', tokenKind: '候选', source: 'candidate' });
        }
    }
    addPending(bucket, value, spec) {
        const cleaned = value.trim();
        if ([...cleaned].length < 2 || [...cleaned].length > 80)
            return;
        const folded = fold(cleaned);
        if (folded.length < 2 || this.selfFold(bucket, folded))
            return;
        if (labelOf(cleaned))
            return;
        const existing = bucket.pending.get(folded);
        if (existing) {
            existing.sources.add(spec.source);
            if (spec.source === 'label')
                existing.param = spec.param;
            if (spec.source === 'pattern' || (spec.source === 'label' && !existing.sources.has('pattern'))) {
                existing.kind = spec.kind;
                existing.tokenKind = spec.tokenKind;
            }
            if (spec.source === 'label' && existing.sources.has('pattern'))
                existing.kind = spec.kind;
            return;
        }
        bucket.pending.set(folded, {
            folded,
            value: cleaned,
            kind: spec.kind,
            param: spec.param,
            tokenKind: spec.tokenKind,
            sources: new Set([spec.source]),
        });
    }
    lookup(bucket, token) {
        let current = token;
        for (let hop = 0; hop < 4; hop += 1) {
            const alias = bucket.file.aliases[current];
            if (!alias || alias === current)
                break;
            current = alias;
        }
        const self = this.selfByToken(bucket, current);
        if (self)
            return self;
        for (const other of Object.values(bucket.file.others)) {
            if (other.token === current)
                return other.value;
        }
        for (const candidate of bucket.sessionCandidates.values()) {
            if (candidate.token === current)
                return candidate.value;
        }
        return bucket.file.retired?.[current];
    }
    selfByToken(bucket, token) {
        for (const kind of SELF_KINDS) {
            if (SELF_TOKEN[kind] === token)
                return bucket.file.self[kind];
        }
        return undefined;
    }
    candidateByToken(bucket, token) {
        for (const [folded, candidate] of bucket.sessionCandidates) {
            if (candidate.token === token)
                return { folded, value: candidate.value };
        }
        return null;
    }
    selfFold(bucket, folded) {
        return SELF_KINDS.some((kind) => {
            const value = bucket.file.self[kind];
            return value ? fold(value) === folded : false;
        });
    }
    bucketFor(url, identity) {
        const key = identity ? safeKey(identity) : this.store.identityKey(url);
        if (identity && !key)
            throw new RelayError('bad_request', `Invalid identity ${identity}`);
        const cacheKey = key ?? '';
        const cached = this.buckets.get(cacheKey);
        if (cached)
            return cached;
        const bucket = {
            key,
            file: key ? this.store.read(key) : emptyFile(),
            pending: new Map(),
            sessionCandidates: new Map(),
            sessionCandidateNext: 0,
            dirty: false,
        };
        this.buckets.set(cacheKey, bucket);
        return bucket;
    }
    save(bucket) {
        if (!bucket.dirty || !bucket.key) {
            bucket.dirty = false;
            return;
        }
        this.store.write(bucket.key, bucket.file);
        bucket.dirty = false;
    }
    holes = [];
    protect(text) {
        this.holes = [];
        return text.replace(/‹[^›\n]{1,40}›|\{\{[^{}\n]+\}\}/g, (match) => {
            const id = this.holes.push(match) - 1;
            return `\uE000${id}\uE001`;
        });
    }
    restore(text) {
        const holes = this.holes;
        return text.replace(/\uE000(\d+)\uE001/g, (_match, id) => holes[Number(id)] ?? '');
    }
}
function renderCtx(render) {
    return { render };
}
function mapTarget(target, render) {
    return {
        ...target,
        name: render(target.name),
        ...(target.label ? { label: render(target.label) } : {}),
        ...(target.css ? { css: render(target.css) } : {}),
        ...(target.text ? { text: render(target.text) } : {}),
        ...(target.frame ? { frame: { name: render(target.frame.name), url: render(target.frame.url) } } : {}),
        ...(target.within ? { within: render(target.within) } : {}),
    };
}
function wantKind(pending) {
    if (pending.sources.has('pattern'))
        return pending.tokenKind;
    if (pending.sources.has('candidate'))
        return '候选';
    return pending.tokenKind;
}
function paramStem(pending) {
    if (pending.sources.has('label') || pending.sources.has('pattern'))
        return pending.param;
    return 'name';
}
class ParamAlloc {
    used = new Set();
    byFold = new Map();
    constructor(existing) {
        for (const name of existing)
            this.used.add(name);
    }
    claim(folded, stem, kind) {
        const known = this.byFold.get(folded);
        if (known)
            return known.name;
        const name = BARE_PARAMS.has(stem) && !this.used.has(stem) ? stem : this.numbered(stem);
        this.used.add(name);
        this.byFold.set(folded, { name, kind });
        return name;
    }
    entries() {
        return this.byFold.entries();
    }
    numbered(stem) {
        let n = 1;
        while (this.used.has(`${stem}${n}`))
            n += 1;
        return `${stem}${n}`;
    }
}
function mapRecord(record, map) {
    const out = {};
    for (const [key, value] of Object.entries(record))
        out[key] = map(value);
    return out;
}
function emptyFile() {
    return { self: {}, rejections: [], allow: [], others: {}, candidates: {}, aliases: {}, retired: {}, next: {}, categories: {} };
}
export function pageish(text) {
    return text.includes('page:') || text.includes('[e') || text.includes('\n  | ') || text.includes('cols:');
}
function percentDecoded(text) {
    if (!/%[0-9A-Fa-f]{2}/.test(text))
        return null;
    try {
        const decoded = decodeURIComponent(text);
        return decoded === text ? null : decoded;
    }
    catch {
        const decoded = text.replace(/%([0-9A-Fa-f]{2})/g, (_hex, pair) => String.fromCharCode(Number.parseInt(pair, 16)));
        return decoded === text ? null : decoded;
    }
}
export function formatDeidentified(report) {
    if (!report || (report.tokens.length === 0 && report.params.length === 0))
        return 'de-identified: none';
    const parts = [
        ...report.tokens.map((item) => `${item.name} ×${item.count}`),
        ...report.params.map((item) => `{{${item.name}}} ×${item.count}`),
    ];
    return `de-identified: ${parts.join(', ')}`;
}
//# sourceMappingURL=redactor.js.map