import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { flushAudit, recordAudit } from '../audit/log.js';
import { resolveBrowserForLaunch } from '../browser/resolve.js';
import { defaultProfileDir, ensureHomeLayout, errorText, logDaemon } from '../config/paths.js';
import { activeDownloadsDir, EVAL_DISABLED_MESSAGE, EVAL_MAX_BYTES, evalEnabled, headlessEnabled } from '../config/runtime.js';
import { notify } from '../notify.js';
import { readGlobalConfig, updateGlobalConfig } from '../privacy/store.js';
import { browserDownloadingMessage, RelayError, staleTabRefMessage } from '../errors.js';
import { headerCandidatesEvaluator } from '../privacy/header-candidates.js';
import { PrivacyGap, Redactor } from '../privacy/redactor.js';
import { ensureTabHeader, pageHeader, switchBanner } from '../perception/snapshot.js';
import { observedLines, TraceLog } from '../recorder/trace.js';
import { valueForTrace } from '../recorder/redact.js';
import { buildHealContext, HEAL_TOKEN_MS, HealLedger, MAX_PATCH_ATTEMPTS, rerunFailedReason } from '../skills/heal.js';
import { bindSkill, mergeResumedRun, replaceStepTarget, resumeFromStep, runMatrix, runOutputDir } from '../skills/run.js';
import { buildSkill, toSkillTarget } from '../skills/save.js';
import { listSkills as listStoredSkills, readSkill as readStoredSkill, rollbackSkill as rollbackStoredSkill, skillHistory as storedSkillHistory, writeSkill as writeStoredSkill, writeSkillChecks, } from '../skills/store.js';
import { assertSaveAs, canceledLine, sanitizeFilename, downloadLine, DownloadManager, preferExternalPdf, PRINT_REQUESTED_LINE, publishDownload, stageBytes, stripDownloadUrl, } from './downloads.js';
import { HandoffManager } from './handoff.js';
import { bounded } from './timeout.js';
import { IdentityStore } from './identity.js';
import { domainNotAllowed, navigationDecision, normalizeAllowDomain, readAllowDomains } from './allowlist.js';
import { askAccess, askAdopt, testOverridesEnabled } from './access-dialog.js';
import { hostOfUrl, registrableDomain } from './domain.js';
import { ATTACH_ALLOW_HINT, ATTACH_TIMEOUT_MS, ATTACH_TRANSFERS_MESSAGE, attachIsDeferred, connectWebSocket, explainAttachFailure, resolveAttachRequest, resolveStoredAttach, } from './connect.js';
import { armNavigationGate } from './nav-gate.js';
import { adoptChrome, HEADLESS_VIEWPORT, launchChrome } from './launch.js';
import { HANDOFF_TIMEOUT_MS } from './login.js';
import { formatTabList, formatUserTabText, POPUP_GRACE_MS, TabSet } from './tabs.js';
const NO_DOWNLOAD_QUIET_MS = 3_000;
/** Already attached to this Chrome. Reconnecting would drop adopted tabs. */
export function reuseLiveAttach(live, nextEndpoint) {
    return live.connection === 'attached' && live.connected && live.endpoint.length > 0 && live.endpoint === nextEndpoint;
}
const READY_WAIT_MS = 30_000;
const TITLE_TIMEOUT_MS = 3_000;
export class BrowserSession {
    phase = { state: 'idle' };
    attempt = null;
    browser = null;
    downloads = null;
    tabSet = null;
    executablePath = '';
    browserVersion = '';
    closed = false;
    replayDepth = 0;
    /** The combination that already ran outside skill_run; the next matrix run skips it. */
    savedPass = null;
    /** Last trace step recorded before the latest skill run; a pass saved from steps up to here was already replayed. */
    replayedThrough = 0;
    lastActionPage = null;
    keepBrowser = false;
    releasing = false;
    persistTimer = null;
    traceLog = new TraceLog();
    privacy = new Redactor();
    heals = new HealLedger();
    startupError = null;
    pageUrl = '';
    lastRawSnapshot = '';
    identities;
    handoff;
    resolveExecutable;
    launchBrowser;
    connection = 'own';
    launchedHeadless = false;
    transfersDisabled = false;
    blockedDomain = null;
    attachedMode = null;
    endpointKind = 'own';
    /** WebSocket endpoint of the Chrome this session is attached to. Empty unless attach finished. */
    attachedEndpoint = '';
    sessionGrants = new Set();
    constructor(options = {}) {
        this.resolveExecutable = options.resolveExecutable ?? resolveBrowserForLaunch;
        this.launchBrowser = options.launchBrowser ?? ((request) => launchChrome(request));
        this.identities = new IdentityStore(() => this.browser);
        this.handoff = new HandoffManager({
            getBrowser: () => this.browser,
            getTabs: () => this.tabSet,
            identities: this.identities,
            noteLoginAccount: (account, urls) => {
                const cleaned = account.replace(/\s+/g, ' ').trim();
                if (!cleaned || [...cleaned].length > 80)
                    return;
                this.privacy.addSelf('account', cleaned, { urls });
            },
        });
    }
    browserState() {
        const view = this.phase.state === 'downloading'
            ? { state: 'downloading', percent: this.phase.percent }
            : this.phase.state === 'error'
                ? { state: 'error', message: this.phase.message }
                : { state: this.phase.state };
        if (attachIsDeferred(readGlobalConfig(), this.phase.state, this.browser?.connected === true))
            view.deferred = true;
        return view;
    }
    warmUp() {
        if (this.closed || this.isReady() || this.attempt)
            return;
        this.attempt = this.launchAttempt().finally(() => {
            this.attempt = null;
        });
    }
    async status() {
        const browser = { ...this.browserState() };
        const body = {
            pid: process.pid,
            uptime: Math.round(process.uptime() * 10) / 10,
            browser,
        };
        if (!this.isReady() || !this.tabSet)
            return this.withHandoff(body);
        browser.executablePath = this.executablePath;
        browser.version = this.browserVersion;
        try {
            const controller = await this.prepareController();
            const title = await bounded(controller.pageHandle().title(), TITLE_TIMEOUT_MS, 'title').catch(() => '');
            body.page = { url: controller.currentUrl(), title };
        }
        catch (err) {
            logDaemon(`status page read failed: ${errorText(err)}`);
        }
        return this.withHandoff(body);
    }
    async navigate(url) {
        this.assertModel();
        const controller = await this.prepareController();
        const urlBefore = controller.currentUrl();
        const target = this.privacy.reveal(url, 'navigate', urlBefore || url);
        this.assertNavigation(target);
        const actionPage = controller.pageHandle();
        const page = await controller.navigate(target, this.tabset().tabHint());
        const shown = await this.finishLive(page);
        this.identities.touch(shown.url);
        return this.record(shown, {
            action: 'goto',
            urlBefore,
            urlAfter: shown.url,
            value: target,
            observed: observedLines(shown.snapshot),
            tabUrl: this.noteTab(actionPage, urlBefore),
        });
    }
    async snapshot(options) {
        this.assertModel();
        const controller = await this.prepareController();
        if (options?.mode === 'text') {
            const body = await controller.visibleText(options.maxChars);
            return this.finishLive(body);
        }
        const kind = this.tabset().peekSwitch();
        const mode = options?.mode ?? 'full';
        const body = await controller.snapshot(kind ? 'full' : mode, options?.maxRows, this.tabset().tabHint());
        return this.finishLive(body);
    }
    async extract(input) {
        this.assertModel();
        const controller = await this.prepareController();
        return controller.extract(input);
    }
    async evalExpr(expr, args = []) {
        this.assertModel();
        if (!evalEnabled())
            throw new RelayError('eval_disabled', EVAL_DISABLED_MESSAGE);
        if (!expr.trim())
            throw new RelayError('bad_request', 'expr is required');
        if (!Array.isArray(args))
            throw new RelayError('bad_request', 'args must be an array');
        const controller = await this.prepareController();
        const origin = pageOrigin(controller.currentUrl());
        const exprSha = createHash('sha256').update(expr).digest('hex');
        const exprLen = Buffer.byteLength(expr);
        try {
            const json = await controller.evalExpr(expr, args);
            const resultLen = Buffer.byteLength(json);
            if (resultLen > EVAL_MAX_BYTES) {
                await noteEval(exprSha, exprLen, origin, false, resultLen);
                throw new RelayError('bad_request', `Eval result exceeds ${EVAL_MAX_BYTES} bytes`);
            }
            const value = JSON.parse(json);
            await noteEval(exprSha, exprLen, origin, true, resultLen);
            return value;
        }
        catch (err) {
            if (err instanceof RelayError && err.message.startsWith('Eval result exceeds'))
                throw err;
            await noteEval(exprSha, exprLen, origin, false, 0);
            if (err instanceof RelayError)
                throw err;
            const message = err instanceof Error ? err.message : 'Eval failed';
            if (message.includes('EVAL_NOT_JSON'))
                throw new RelayError('bad_request', 'Eval result must be JSON');
            throw new RelayError('bad_request', `Eval failed: ${message}`);
        }
    }
    async act(input) {
        this.assertModel();
        const controller = await this.prepareController();
        const urlBefore = controller.currentUrl();
        const actionPage = controller.pageHandle();
        const described = input.ref ? await this.describe(controller, input.ref) : undefined;
        if (input.ref && (input.action === 'type' || input.action === 'press') && (await controller.isPasswordRef(input.ref))) {
            recordAudit('password_blocked', { action: input.action });
            throw new RelayError('human_required', 'Passwords are typed by a human. Call request_human.');
        }
        const revealed = this.revealAct(input, urlBefore);
        this.blockedDomain = null;
        const since = this.tabset().generation();
        const mark = this.downloader().mark();
        const printBefore = await controller.printCount();
        try {
            await controller.performInput(revealed);
            this.throwIfBlocked();
            const switched = await this.tabset().waitForPopup(since, actionPage, input.action === 'click' ? POPUP_GRACE_MS : 0);
            // target=_blank (a PDF form, for example) can emit the download after the click returns.
            if (input.action === 'click' && this.tabset().generation() !== since) {
                await this.downloader().waitForAnyBegin(mark, 2_000);
            }
            const caught = await this.finishDownloads(mark);
            const lines = [...caught.lines];
            if (await this.printIncreased(controller, printBefore))
                lines.push(PRINT_REQUESTED_LINE);
            const kind = this.tabset().peekSwitch();
            const body = await this.readSnapshot(kind || switched ? 'full' : 'diff');
            const shown = await this.finishLive(body, { downloads: caught.files, lines });
            const produced = input.action === 'click' && caught.files.length > 0;
            return this.record(shown, {
                action: produced ? 'download' : revealed.action,
                urlBefore,
                urlAfter: shown.url,
                target: described?.target,
                value: produced ? caught.requested : valueForTrace(revealed.action, revealed.value, described ? { ...described.target, sensitive: described.sensitive } : undefined),
                suggested: produced ? caught.suggested : undefined,
                key: revealed.key,
                observed: observedLines(shown.snapshot),
                tabUrl: this.noteTab(actionPage, urlBefore),
            });
        }
        finally {
            this.downloads?.release(mark);
        }
    }
    async download(input) {
        this.assertModel();
        await this.ensureReady();
        this.assertTransfers();
        const saveAs = input.save_as ? this.privacy.reveal(input.save_as, 'download', this.pageUrl) : undefined;
        if (saveAs)
            assertSaveAs(saveAs);
        const controller = await this.prepareController();
        const urlBefore = controller.currentUrl();
        const actionPage = controller.pageHandle();
        const described = await this.describe(controller, input.ref);
        const since = this.tabset().generation();
        const mark = this.downloader().mark();
        const printBefore = await controller.printCount();
        const timeout = input.timeout_ms ?? 30_000;
        try {
            await controller.performInput({ action: 'click', ref: input.ref });
            const clickedAt = Date.now();
            await this.tabset().waitForPopup(since, actionPage, POPUP_GRACE_MS);
            const started = await this.waitForDownloadBegin(mark, timeout, () => {
                if (this.tabset().generation() !== since)
                    return false;
                return Date.now() - clickedAt >= NO_DOWNLOAD_QUIET_MS && controller.networkQuietMs() >= NO_DOWNLOAD_QUIET_MS;
            });
            if (!started) {
                // The click already ran and may have opened a dialog. Keep that target as a click.
                await this.keepPerformedClick(urlBefore, actionPage, described.target);
                throw new RelayError('no_download', 'No download began after the click. The click may have opened a dialog that needs another click.');
            }
            const done = await this.downloader().waitForComplete(started);
            const lines = [];
            const files = [];
            let requested = '';
            if (done.state === 'canceled') {
                lines.push(canceledLine(done.suggestedFilename));
            }
            else {
                const published = await this.downloader().finalize(done, {
                    dir: activeDownloadsDir(),
                    fileName: saveAs ?? done.suggestedFilename,
                    dedupe: true,
                });
                files.push(published.info);
                lines.push(downloadLine(published.info));
                requested = published.requested;
            }
            if (await this.printIncreased(controller, printBefore))
                lines.push(PRINT_REQUESTED_LINE);
            const kind = this.tabset().peekSwitch();
            const body = await this.readSnapshot(kind ? 'full' : 'diff');
            const shown = await this.finishLive(body, { downloads: files, lines });
            const file = files[0];
            if (!file)
                return shown;
            return this.record(shown, {
                action: 'download',
                urlBefore,
                urlAfter: shown.url,
                target: described.target,
                value: saveAs ?? requested,
                suggested: done.suggestedFilename,
                timeout_ms: timeout,
                observed: observedLines(shown.snapshot),
                tabUrl: this.noteTab(actionPage, urlBefore),
            });
        }
        finally {
            this.downloads?.release(mark);
        }
    }
    async pdf(input) {
        this.assertModel();
        await this.ensureReady();
        this.assertTransfers();
        const saveAs = input.save_as ? this.privacy.reveal(input.save_as, 'pdf', this.pageUrl) : undefined;
        if (saveAs)
            assertSaveAs(saveAs);
        const controller = await this.prepareController();
        const url = controller.currentUrl();
        const title = await bounded(controller.pageHandle().title(), TITLE_TIMEOUT_MS, 'title').catch(() => '');
        const bytes = await controller.printToPdf({ landscape: input.landscape });
        const fileName = saveAs ?? `${sanitizeTitle(title)}.pdf`;
        const sourcePath = await stageBytes(bytes);
        try {
            const published = await publishDownload({
                sourcePath,
                dir: activeDownloadsDir(),
                fileName,
                url: stripDownloadUrl(url),
                mime: 'application/pdf',
                dedupe: true,
            });
            const header = pageHeader(title, url, this.tabset().tabHint());
            return this.record({ url, title, header, file: published.info }, {
                action: 'pdf',
                urlBefore: url,
                urlAfter: url,
                value: saveAs ?? published.requested,
                ...(input.landscape !== undefined ? { landscape: input.landscape } : {}),
                observed: [],
            });
        }
        catch (err) {
            await unlink(sourcePath).catch(() => undefined);
            throw err;
        }
    }
    async waitFor(input) {
        this.assertModel();
        const controller = await this.prepareController();
        const urlBefore = controller.currentUrl();
        const actionPage = controller.pageHandle();
        const described = input.ref ? await this.describe(controller, input.ref) : undefined;
        const revealed = {
            ...input,
            ...(input.text !== undefined ? { text: this.privacy.reveal(input.text, 'wait', urlBefore) } : {}),
            ...(input.url !== undefined ? { url: this.privacy.reveal(input.url, 'wait', urlBefore) } : {}),
        };
        const since = this.tabset().generation();
        let result = await controller.waitFor(revealed);
        const switched = await this.tabset().waitForPopup(since, actionPage, 0);
        if (switched) {
            const current = await this.tabset().current();
            const body = await current.snapshot('full', undefined, this.tabset().tabHint());
            result = { matched: result.matched, url: body.url, title: body.title, snapshot: body.snapshot };
        }
        const shown = await this.finishLive(result);
        const withMatch = { ...shown, matched: result.matched };
        if (!result.matched)
            return withMatch;
        return this.record(withMatch, {
            action: 'wait',
            urlBefore,
            urlAfter: shown.url,
            target: described?.target,
            value: revealed.text,
            url: revealed.url,
            timeout_ms: input.timeoutMs,
            observed: observedLines(shown.snapshot),
            tabUrl: this.noteTab(actionPage, urlBefore),
        });
    }
    async tabs(input) {
        if (input.action !== 'list')
            this.assertModel();
        await this.ensureReady();
        const tabs = this.tabset();
        if (input.action === 'list') {
            if (this.replayDepth > 0)
                await tabs.current();
            else
                await tabs.prepare();
            const described = await tabs.describe();
            return { tabs: described, text: formatTabList(described) };
        }
        if (input.action === 'select') {
            if (input.index === undefined)
                throw new RelayError('bad_request', 'index is required for select');
            const controller = await tabs.select(input.index);
            return this.finishLive(await controller.snapshot('full', undefined, tabs.tabHint()));
        }
        if (input.action === 'user')
            return this.userTabs();
        if (input.action === 'adopt') {
            if (input.index === undefined)
                throw new RelayError('bad_request', 'index is required for adopt');
            return this.requestAdopt(input.index);
        }
        if (input.action === 'new') {
            const controller = await tabs.openBlank();
            if (input.url) {
                const opened = this.privacy.reveal(input.url, 'tabs', this.pageUrl || input.url);
                const target = parseHttpUrl(opened);
                this.assertNavigation(target);
                const body = await controller.navigate(target, tabs.tabHint());
                return this.finishLive(body);
            }
            return this.finishLive(await controller.snapshot('full', undefined, tabs.tabHint()));
        }
        await tabs.closeIndex(input.index);
        const described = await tabs.describe();
        return { tabs: described, text: formatTabList(described) };
    }
    async openPages() {
        await this.ensureReady();
        await this.tabset().reconcile();
        return this.tabset().pages();
    }
    trace() {
        return this.traceLog.view();
    }
    clearTrace() {
        this.assertModel();
        this.lastActionPage = null;
        this.replayedThrough = 0;
        this.savedPass = null;
        return this.traceLog.clear();
    }
    saveSkill(input) {
        this.assertModel();
        const steps = this.traceLog.view().steps;
        const identity = this.identities.matchUrls(steps.flatMap((step) => [step.urlBefore, step.urlAfter]));
        const built = buildSkill(steps, identity ? { ...input, identity } : input);
        const url = steps.at(-1)?.urlAfter || steps[0]?.urlBefore || this.pageUrl;
        const corpus = [
            this.lastRawSnapshot,
            ...steps.flatMap((step) => [
                step.url,
                step.urlBefore,
                step.urlAfter,
                step.value,
                step.suggested,
                step.target?.name,
                step.target?.text,
                step.target?.label,
                step.target?.css,
                ...(step.observed ?? []),
            ]),
        ]
            .filter((item) => typeof item === 'string' && item.length > 0)
            .join('\n');
        this.privacy.absorb(corpus, url);
        const cleaned = this.privacy.deidentify(built.skill, url);
        const stored = writeStoredSkill(cleaned.skill, input.overwrite === true);
        writeSkillChecks(cleaned.skill, stored.path);
        const lastSaved = Math.min(input.to_step ?? Number.POSITIVE_INFINITY, steps.at(-1)?.n ?? 0);
        this.savedPass =
            input.session && lastSaved > this.replayedThrough
                ? {
                    session: input.session,
                    name: cleaned.skill.name,
                    version: stored.version,
                    params: { ...(input.params ?? {}) },
                    why: 'done by hand in the pass this skill was saved from',
                }
                : null;
        return {
            name: cleaned.skill.name,
            version: stored.version,
            path: stored.path,
            yaml: stored.yaml,
            warnings: built.warnings,
            deidentified: cleaned.report,
        };
    }
    listSkills() {
        return listStoredSkills();
    }
    readSkill(name, version) {
        return readStoredSkill(name, version);
    }
    skillHistory(name) {
        return storedSkillHistory(name);
    }
    rollbackSkill(name, to) {
        return rollbackStoredSkill(name, to);
    }
    async runSkill(name, input) {
        this.assertModel();
        const stored = readStoredSkill(name).skill;
        const pass = this.savedPass;
        this.savedPass = null;
        this.replayedThrough = this.traceLog.view().steps.at(-1)?.n ?? 0;
        const savedPass = pass && input.session === pass.session && pass.name === stored.name && pass.version === stored.version ? pass : undefined;
        let skill = stored;
        let runInput = input;
        try {
            const prepared = this.privacy.prepareRun(stored, input);
            skill = prepared.skill;
            runInput = prepared.input;
        }
        catch (err) {
            if (err instanceof PrivacyGap)
                return missingSelfResult(name, input, err.message);
            throw err;
        }
        this.heals.beginRun(input.continue_heal === true);
        await this.ensureReady();
        this.replayDepth += 1;
        try {
            const page = this.replayPage();
            return await runMatrix(page, skill, runInput, {
                waitForHuman: runInput.wait_human ? (reason) => this.waitOutHandoff(reason) : undefined,
                onFailure: async (site) => {
                    const snapshot = await page.fullSnapshot();
                    return buildHealContext({
                        site,
                        skillName: skill.name,
                        skillVersion: skill.version,
                        snapshot,
                        url: page.currentUrl(),
                        epoch: page.documentEpoch(),
                        outDir: site.outDir,
                        ledger: this.heals,
                    });
                },
            }, savedPass);
        }
        finally {
            this.replayDepth -= 1;
            this.tabSet?.consumeSwitch();
        }
    }
    async skillPatch(input) {
        this.assertModel();
        await this.ensureReady();
        this.replayDepth += 1;
        try {
            const page = this.replayPage();
            const controller = await this.prepareController();
            const decision = this.heals.beginAttempt({
                token: input.heal_token,
                name: input.name,
                stepId: input.step_id,
                now: Date.now(),
                epoch: controller.documentEpoch(),
                url: controller.currentUrl(),
            });
            if (!decision.ok) {
                return { accepted: false, name: input.name, step_id: input.step_id, reason: decision.reason, retryable: false };
            }
            const ticket = decision.ticket;
            let described;
            try {
                described = await this.describe(controller, input.ref);
            }
            catch (err) {
                return await this.rejectPatch(input.name, input.step_id, err instanceof RelayError ? err.code : 'stale_ref', ticket);
            }
            if (described.sensitive)
                return await this.rejectPatch(input.name, input.step_id, 'human_required', ticket);
            const rawTarget = toSkillTarget(described.target);
            const stored = readStoredSkill(input.name).skill;
            if (stored.version !== ticket.version) {
                this.heals.dropTicket();
                return { accepted: false, name: input.name, step_id: input.step_id, reason: 'heal_token', retryable: false };
            }
            let cleaned;
            try {
                const replaced = replaceSkillStep(stored, input.step_id, rawTarget);
                this.privacy.absorb([ticket.snapshot, rawTarget.name, rawTarget.text, rawTarget.label, rawTarget.css].filter(Boolean).join('\n'), ticket.url);
                cleaned = this.privacy.deidentify(replaced, ticket.url);
            }
            catch (err) {
                return await this.rejectPatch(input.name, input.step_id, err instanceof Error ? err.message : 'bad_params', ticket);
            }
            let prepared;
            try {
                prepared = this.privacy.prepareRun(stored, { params: ticket.params, startUrl: ticket.url });
            }
            catch (err) {
                return await this.rejectPatch(input.name, input.step_id, err instanceof Error ? err.message : 'bad_params', ticket);
            }
            const bound = bindSkill(prepared.skill, ticket.params);
            const replay = await resumeFromStep(page, bound, ticket.params, input.step_id, rawTarget, ticket.priorOutcome, ticket.outDir);
            if (replay.outcome !== 'ok' && replay.outcome !== 'empty') {
                const failedStep = replay.broken?.step_id ?? input.step_id;
                const cause = replay.broken?.reason ?? replay.outcome;
                return await this.rejectPatch(input.name, input.step_id, rerunFailedReason(failedStep, cause), ticket, replay.message, {
                    failed_step: failedStep,
                    cause,
                });
            }
            const written = writeStoredSkill(cleaned.skill, true);
            writeSkillChecks(cleaned.skill, written.path);
            recordAudit('skill_patched', {
                name: input.name,
                from_version: ticket.version,
                to_version: written.version,
                step_id: input.step_id,
                healer: input.healer ?? 'manual',
                ...(input.llm_tokens !== undefined ? { llm_tokens: input.llm_tokens } : {}),
            });
            await flushAudit();
            const result = mergeResumedRun({ steps: ticket.completed, artifacts: ticket.artifacts, warnings: ticket.warnings }, replay);
            const remaining = ticket.remaining.map((params) => ({ ...params }));
            this.heals.noteHealed();
            this.savedPass = input.session
                ? { session: input.session, name: input.name, version: written.version, params: { ...ticket.params }, why: 'finished by skill_patch' }
                : null;
            return {
                accepted: true,
                name: input.name,
                step_id: input.step_id,
                from_version: ticket.version,
                to_version: written.version,
                outcome: replay.outcome,
                result,
                remaining_params: remaining,
                ...(replay.message ? { message: replay.message } : {}),
            };
        }
        finally {
            this.replayDepth -= 1;
            this.tabSet?.consumeSwitch();
        }
    }
    async rejectPatch(name, stepId, reason, ticket, message, failure) {
        let retryable = false;
        let drop = true;
        try {
            const controller = await this.prepareController();
            const samePage = ticket.epoch === controller.documentEpoch() && ticket.url === controller.currentUrl();
            const fresh = Date.now() - ticket.createdAt <= HEAL_TOKEN_MS;
            retryable = samePage && fresh && ticket.attempts < MAX_PATCH_ATTEMPTS;
            // A used-up budget still names the next call heal_budget. Navigation or expiry invalidates the token.
            drop = !samePage || !fresh;
        }
        catch {
            retryable = false;
            drop = true;
        }
        if (drop)
            this.heals.dropTicket();
        return {
            accepted: false,
            name,
            step_id: stepId,
            reason,
            retryable,
            ...(message ? { message } : {}),
            ...(failure ? { failed_step: failure.failed_step, cause: failure.cause } : {}),
        };
    }
    async requestHandoff(reason, url) {
        const revealed = url === undefined ? undefined : this.privacy.reveal(url, 'handoff', this.pageUrl || url);
        const target = revealed === undefined ? undefined : parseHandoffUrl(revealed);
        await this.ensureReady();
        // Tests play the human in a headless browser.
        if (this.connection !== 'attached' && this.launchedHeadless && !testOverridesEnabled()) {
            throw new RelayError('human_required', 'The browser is headless, so nobody can see it to log in. Report that a login is needed, or restart the daemon with a visible browser.');
        }
        if (target)
            this.assertNavigation(target);
        return this.handoff.start(reason, target);
    }
    waitHandoff(timeoutMs) {
        return this.handoff.wait(timeoutMs);
    }
    cancelHandoff() {
        return this.handoff.cancel();
    }
    listIdentities() {
        return this.identities.list();
    }
    async saveIdentity(input) {
        this.assertModel();
        if (this.connection === 'attached') {
            throw new RelayError('bad_request', 'Identity cookies are not saved while attached to an existing Chrome.');
        }
        await this.ensureReady();
        const controller = await this.prepareController();
        return this.identities.saveManual({ ...input, pageUrl: controller.currentUrl() });
    }
    async revokeIdentity(name) {
        this.assertModel();
        await this.ensureReady();
        await this.identities.revoke(name);
        return { name };
    }
    redactOutbound(value) {
        if (!this.privacy.modelRedaction(this.pageUrl))
            return value;
        return this.privacy.maskValue(value, this.pageUrl);
    }
    privacyMode(on, identity) {
        if (identity) {
            this.privacy.setIdentityMode(identity, on);
            return { model_redaction: on, scope: 'identity', identity };
        }
        this.privacy.setGlobalMode(on);
        return { model_redaction: on, scope: 'global' };
    }
    privacyAdd(kind, value, identity) {
        if (!identity && !this.pageUrl)
            throw new RelayError('bad_request', 'Open the site first, or pass an identity');
        const token = this.privacy.addSelf(kind, value, identity ? { identity } : { url: this.pageUrl });
        return { token, as: kind };
    }
    privacyConfirm(input) {
        const url = input.identity ? undefined : this.pageUrl;
        if (input.reject)
            return this.privacy.reject(input.token, url, input.identity);
        return this.privacy.confirm(input.token, input.as, url, input.identity);
    }
    privacyList(identity) {
        if (!identity && !this.pageUrl)
            return { identity: null, self: [] };
        return this.privacy.list(identity ? undefined : this.pageUrl, identity);
    }
    privacyCheck() {
        if (!this.lastRawSnapshot)
            throw new RelayError('bad_request', 'Take a snapshot first');
        return this.privacy.check(this.lastRawSnapshot, this.pageUrl);
    }
    async privacyMark(input) {
        let value = input.value;
        if (input.ref) {
            const controller = await this.prepareController();
            const described = await this.describe(controller, input.ref);
            this.pageUrl = controller.currentUrl();
            value = described.target.text || described.target.name || described.target.label || '';
        }
        if (!value)
            throw new RelayError('bad_request', 'privacy_mark needs a ref or a value');
        const revealed = this.privacy.reveal(value, 'privacy_mark', this.pageUrl);
        const token = this.privacy.addSelf(input.as, revealed, { url: this.pageUrl });
        return { token, as: input.as };
    }
    async close(options) {
        this.keepBrowser = options?.keepBrowser === true;
        this.closed = true;
        // Resolving or downloading has no Chrome yet. Waiting here would deadlock a caller
        // that releases the resolver only after close returns.
        const launchInFlight = this.browser !== null || this.phase.state === 'launching' || this.phase.state === 'ready';
        if (launchInFlight && this.attempt)
            await this.attempt.catch(() => undefined);
        this.stopPersistTimer();
        if (this.connection === 'attached')
            await this.tabSet?.closeCreated().catch(() => undefined);
        if (this.connection !== 'attached') {
            await this.identities.persistAll().catch((err) => logDaemon(`cookie persist failed: ${errorText(err)}`));
        }
        await this.handoff.shutdown().catch((err) => logDaemon(`handoff shutdown: ${errorText(err)}`));
        const downloads = this.downloads;
        this.downloads = null;
        if (downloads)
            await downloads.dispose().catch(() => undefined);
        const tabs = this.tabSet;
        this.tabSet = null;
        if (tabs)
            await tabs.dispose().catch(() => undefined);
        const browser = this.browser;
        this.browser = null;
        if (browser)
            await this.releaseBrowser(browser);
    }
    replayPage() {
        const session = this;
        let current = null;
        const use = async () => {
            current = await session.prepareController();
            session.pageUrl = current.currentUrl();
            return current;
        };
        return {
            navigate: async (url) => {
                const controller = await use();
                session.assertNavigation(url);
                const body = await controller.navigate(url);
                session.identities.touch(body.url);
                return body;
            },
            capture: async () => (await use()).capture(),
            hasVisiblePassword: async () => (await use()).hasVisiblePassword(),
            isPasswordBackend: async (backend) => (await use()).isPasswordBackend(backend),
            currentUrl: () => {
                if (!current)
                    throw new Error('Replay has not opened a page');
                return current.currentUrl();
            },
            pageText: async () => (await use()).pageText(),
            extract: async (input) => (await use()).extract(input),
            evalExpr: async (expr, args) => (await use()).evalExpr(expr, args),
            queryCss: async (css, frame) => (await use()).queryCss(css, frame),
            performBackend: async (backend, input) => {
                const page = await use();
                const opener = page.pageHandle();
                const since = session.tabset().generation();
                await page.performBackend(backend, input);
                await session.tabset().waitForPopup(since, opener, input.action === 'click' ? POPUP_GRACE_MS : 0);
                current = await session.prepareController();
            },
            performInput: async (input) => {
                const page = await use();
                const opener = page.pageHandle();
                const since = session.tabset().generation();
                await page.performInput(input);
                await session.tabset().waitForPopup(since, opener, input.action === 'click' ? POPUP_GRACE_MS : 0);
                current = await session.prepareController();
            },
            waitFor: async (input) => (await use()).waitFor(input),
            excerpt: async () => (await use()).excerpt(),
            fullSnapshot: async () => (await (await use()).snapshot('full')).snapshot,
            documentEpoch: () => {
                if (!current)
                    throw new Error('Replay has not opened a page');
                return current.documentEpoch();
            },
            markDownloads: () => session.downloader().mark(),
            releaseDownloads: (mark) => session.downloader().release(mark),
            waitForDownloadBegin: async (mark, timeoutMs) => {
                const pending = await session.downloader().waitForBegin(mark, timeoutMs);
                if (!pending)
                    return null;
                return { id: pending.id, suggestedFilename: pending.suggestedFilename, url: pending.url };
            },
            waitForDownloadComplete: async (download) => {
                const done = await session.downloader().waitForComplete(download);
                return done.state === 'canceled' ? 'canceled' : 'completed';
            },
            saveDownload: async (download, dir, fileName) => {
                assertSaveAs(fileName);
                const published = await session.downloader().finalize(download, { dir, fileName, dedupe: true });
                return { file: published.info, deduped: published.deduped };
            },
            printPdf: async ({ dir, fileName, landscape }) => {
                assertSaveAs(fileName);
                const controller = await use();
                const bytes = await controller.printToPdf({ landscape });
                const sourcePath = await stageBytes(bytes);
                try {
                    const published = await publishDownload({
                        sourcePath,
                        dir,
                        fileName,
                        url: stripDownloadUrl(controller.currentUrl()),
                        mime: 'application/pdf',
                        dedupe: true,
                    });
                    return { file: published.info, deduped: published.deduped };
                }
                catch (err) {
                    await unlink(sourcePath).catch(() => undefined);
                    throw err;
                }
            },
        };
    }
    present(body) {
        const tabs = this.tabSet;
        const kind = tabs?.consumeSwitch() ?? null;
        let snapshot = ensureTabHeader(body.snapshot, tabs?.tabHint());
        if (kind)
            snapshot = `${switchBanner(kind, body.title)}\n${snapshot}`;
        return { ...body, snapshot };
    }
    noteTab(page, url) {
        const previous = this.lastActionPage;
        this.lastActionPage = page;
        if (!previous || previous === page)
            return undefined;
        return url;
    }
    async describe(controller, ref) {
        if (!controller.hasRef(ref) && this.tabset().hasRefElsewhere(controller, ref)) {
            throw new RelayError('stale_ref', staleTabRefMessage(ref));
        }
        return controller.describeRef(ref);
    }
    async finishLive(body, extra) {
        try {
            const page = (await this.tabset().current()).pageHandle();
            const values = await bounded(page.evaluate(headerCandidatesEvaluator()), 1_500, 'header candidates').catch(() => []);
            if (Array.isArray(values))
                this.privacy.noteHeaderCandidates(values.filter((item) => typeof item === 'string'), body.url);
        }
        catch (err) {
            logDaemon(`header candidate scan failed: ${errorText(err)}`);
        }
        return this.finishPage(body, extra);
    }
    finishPage(body, extra) {
        const pending = this.downloads?.takeUnreported() ?? { files: [], lines: [] };
        const downloads = [...(extra?.downloads ?? []), ...pending.files];
        const lines = [...(extra?.lines ?? []), ...pending.lines];
        let snapshot = body.snapshot;
        if (lines.length > 0)
            snapshot = `${snapshot}\n${lines.join('\n')}`;
        const presented = this.present({ ...body, snapshot });
        const page = downloads.length === 0 ? presented : { ...presented, downloads };
        this.pageUrl = page.url;
        this.lastRawSnapshot = page.snapshot;
        this.privacy.absorb(page.snapshot, page.url);
        return page;
    }
    async finishDownloads(mark) {
        const pending = this.downloader().claimSince(mark);
        const files = [];
        const lines = [];
        let suggested;
        let requested;
        for (const item of pending) {
            const done = await this.downloader().waitForComplete(item);
            if (done.state === 'canceled') {
                lines.push(canceledLine(done.suggestedFilename));
                continue;
            }
            const published = await this.downloader().finalize(done, {
                dir: activeDownloadsDir(),
                fileName: done.suggestedFilename,
                dedupe: true,
            });
            files.push(published.info);
            lines.push(downloadLine(published.info));
            if (!suggested) {
                suggested = done.suggestedFilename;
                requested = published.requested;
            }
        }
        return { files, lines, suggested, requested };
    }
    async readSnapshot(mode) {
        const once = async () => {
            const current = await this.tabset().current();
            if (current.pageHandle().isClosed())
                throw new Error('Target closed');
            return current.snapshot(mode, undefined, this.tabset().tabHint());
        };
        try {
            return await once();
        }
        catch (err) {
            if (!isClosedTarget(err))
                throw err;
            logDaemon(`snapshot retried after tab close: ${errorText(err)}`);
            return once();
        }
    }
    async printIncreased(controller, before) {
        if (controller.pageHandle().isClosed())
            return false;
        return (await controller.printCount()) > before;
    }
    downloader() {
        const downloads = this.downloads;
        if (!downloads)
            throw new Error('Browser is not connected');
        return downloads;
    }
    /** A download needs a request; once the page has been quiet for a while, stop waiting. */
    async waitForDownloadBegin(mark, timeoutMs, quiet) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const left = deadline - Date.now();
            if (left <= 0)
                return null;
            const begun = await this.downloader().waitForBegin(mark, Math.min(250, left));
            if (begun)
                return begun;
            if (quiet())
                return null;
        }
    }
    /** The click already ran; a no_download after that still belongs in the trace, as a click. */
    async keepPerformedClick(urlBefore, actionPage, target) {
        const append = (urlAfter, observed) => {
            this.record({ url: urlAfter }, {
                action: 'click',
                urlBefore,
                urlAfter,
                ...(target ? { target } : {}),
                observed,
                tabUrl: this.noteTab(actionPage, urlBefore),
            });
        };
        try {
            const kind = this.tabset().peekSwitch();
            const body = await this.readSnapshot(kind ? 'full' : 'diff');
            const shown = await this.finishLive(body);
            append(shown.url, observedLines(shown.snapshot));
        }
        catch (err) {
            logDaemon(`click kept after no_download: ${errorText(err)}`);
            append(urlBefore, []);
        }
    }
    record(page, input) {
        if (this.replayDepth > 0)
            return page;
        const step = this.traceLog.append(input, (raw) => this.traceForDisk(raw));
        return { ...page, step: step.n };
    }
    traceForDisk(step) {
        const url = step.urlAfter || step.urlBefore;
        if (!this.privacy.modelRedaction(url))
            return step;
        return this.privacy.maskValue(step, url);
    }
    revealAct(input, url) {
        if (input.value === undefined)
            return input;
        return { ...input, value: this.privacy.reveal(input.value, input.action, url) };
    }
    tabset() {
        const tabs = this.tabSet;
        if (!tabs)
            throw new Error('Browser is not connected');
        return tabs;
    }
    async prepareController() {
        await this.ensureReady();
        const tabs = this.tabset();
        if (this.replayDepth > 0)
            return tabs.current();
        return tabs.prepare();
    }
    async ensureReady() {
        if (this.closed)
            throw new Error('Browser session is closed');
        if (this.isReady())
            return;
        const initial = this.downloadError();
        if (initial)
            throw initial;
        // Re-read phase after every await. The background launch mutates it.
        if (this.launchInFlight()) {
            await this.waitPhase(this.readyWaitMs());
            if (this.isReady())
                return;
            const waited = this.downloadError();
            if (waited)
                throw waited;
            if (this.launchInFlight()) {
                throw new RelayError('browser_not_ready', 'Browser is still starting. Retry shortly, or run: relaywright browser install');
            }
        }
        if (this.isReady())
            return;
        const beforeRetry = this.downloadError();
        if (beforeRetry)
            throw beforeRetry;
        this.warmUp();
        await this.waitPhase(this.readyWaitMs());
        if (this.isReady())
            return;
        const finished = this.downloadError();
        if (finished)
            throw finished;
        if (this.phase.state === 'error')
            throw this.startupError ?? new Error(this.phase.message);
        throw new RelayError('browser_not_ready', 'Browser is still starting. Retry shortly, or run: relaywright browser install');
    }
    downloadError() {
        if (this.phase.state !== 'downloading')
            return null;
        return new RelayError('browser_not_ready', browserDownloadingMessage(this.phase.percent));
    }
    launchInFlight() {
        return this.attempt !== null && this.phase.state !== 'error' && this.phase.state !== 'idle' && this.phase.state !== 'downloading';
    }
    async waitPhase(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (this.isReady())
                return;
            if (this.phase.state === 'downloading' || this.phase.state === 'error')
                return;
            if (!this.attempt)
                return;
            await delay(50);
        }
    }
    isReady() {
        return this.phase.state === 'ready' && this.browser?.connected === true && this.tabSet !== null;
    }
    async attach(input) {
        this.assertModel();
        if (this.closed)
            throw new Error('Browser session is closed');
        if (this.attempt)
            await this.attempt.catch(() => undefined);
        let result;
        this.phase = { state: 'launching' };
        this.attempt = this.performAttach(input)
            .then((attached) => {
            result = attached;
        })
            .finally(() => {
            this.attempt = null;
        });
        await this.attempt;
        if (!result)
            throw new RelayError('attach_failed', 'Attach did not connect');
        return result;
    }
    async detach() {
        this.assertModel();
        if (this.attempt)
            await this.attempt.catch(() => undefined);
        const mode = this.attachedMode ?? 'separate';
        const endpointKind = this.endpointKind;
        await this.dropBrowser('disconnect');
        this.phase = { state: 'idle' };
        this.sessionGrants.clear();
        updateGlobalConfig((config) => {
            config.browser = { ...(config.browser ?? {}), mode: 'separate' };
            delete config.browser.cdp_url;
            delete config.browser.user_data_dir;
        });
        recordAudit('detach', { mode, endpoint_kind: endpointKind });
        await flushAudit();
        return { mode: 'separate', endpoint_kind: 'own' };
    }
    async requestAccess(domain, reason = '') {
        const normalized = normalizeAllowDomain(domain);
        const decision = await askAccess(normalized, reason.slice(0, 500));
        if (decision === 'once')
            this.sessionGrants.add(normalized);
        if (decision === 'always') {
            updateGlobalConfig((config) => {
                const next = new Set(readAllowDomains());
                next.add(normalized);
                config.allow_domains = [...next];
            });
        }
        recordAudit('access_request', { domain: normalized, decision });
        await flushAudit();
        return { domain: normalized, decision };
    }
    async listForeignTabs() {
        this.assertModel();
        await this.ensureReady();
        if (this.connection !== 'attached')
            throw new RelayError('bad_request', 'Adopt is only available while attached to an existing browser');
        const tabs = await this.tabset().listForeign();
        return { tabs, text: formatTabList(tabs) };
    }
    async adoptTab(index) {
        this.assertModel();
        await this.ensureReady();
        if (this.connection !== 'attached')
            throw new RelayError('bad_request', 'Adopt is only available while attached to an existing browser');
        const controller = await this.tabset().adopt(index);
        return this.finishLive(await controller.snapshot('full', undefined, this.tabset().tabHint()));
    }
    async userTabs() {
        if (this.connection !== 'attached') {
            throw new RelayError('bad_request', 'User tabs are only available while attached to an existing browser');
        }
        const listed = await this.listForeignTabs();
        return {
            tabs: listed.tabs,
            text: formatUserTabText(listed.text, listed.tabs.length, this.tabset().adoptedCount()),
        };
    }
    /** Model path: the person confirms the tab before it becomes visible. The CLI adopt skips this. */
    async requestAdopt(index) {
        if (this.connection !== 'attached')
            throw new RelayError('bad_request', 'Adopt is only available while attached to an existing browser');
        const page = await this.tabset().foreignPage(index);
        let title = '';
        try {
            title = await bounded(page.title(), 1_500, 'tab title');
        }
        catch {
            title = '';
        }
        const url = page.isClosed() ? '' : page.url();
        const decision = await askAdopt(title, url);
        if (decision !== 'allow')
            throw new RelayError('bad_request', 'The person refused access to that tab.');
        const domain = grantDomain(url);
        if (domain)
            this.sessionGrants.add(domain);
        const controller = await this.tabset().adopt(index, page);
        recordAudit('tab_adopted', { domain: domain ?? '' });
        await flushAudit();
        return this.finishLive(await controller.snapshot('full', undefined, this.tabset().tabHint()));
    }
    readyWaitMs() {
        const mode = readGlobalConfig().browser?.mode;
        if (mode === 'daily' || mode === 'cdp')
            return ATTACH_TIMEOUT_MS + 5_000;
        return READY_WAIT_MS;
    }
    async launchAttempt() {
        this.startupError = null;
        const config = readGlobalConfig();
        const mode = config.browser?.mode ?? 'separate';
        if (mode === 'daily' || mode === 'cdp') {
            await this.launchConfiguredAttach(config);
            return;
        }
        await this.launchOwn();
    }
    async launchOwn() {
        this.phase = { state: 'resolving' };
        try {
            const resolved = await this.resolveExecutable((percent) => {
                this.phase = { state: 'downloading', percent };
            });
            if (this.closed)
                return;
            this.phase = { state: 'launching' };
            ensureHomeLayout();
            preferExternalPdf(defaultProfileDir());
            const headless = headlessEnabled();
            const profile = defaultProfileDir();
            const viewport = headless ? { width: HEADLESS_VIEWPORT.width, height: HEADLESS_VIEWPORT.height } : null;
            let browser = await adoptChrome(profile, viewport);
            if (browser) {
                logDaemon('adopted browser');
            }
            else {
                logDaemon(`launching browser headless=${headless ? '1' : '0'} source=${resolved.source} path=${resolved.path}`);
                browser = await this.launchBrowser({
                    executablePath: resolved.path,
                    userDataDir: profile,
                    headless,
                    defaultViewport: viewport,
                    timeoutMs: 45_000,
                });
            }
            if (this.closed) {
                await this.releaseBrowser(browser);
                return;
            }
            this.browser = browser;
            const downloads = await DownloadManager.start(browser);
            if (this.closed) {
                await downloads.dispose().catch(() => undefined);
                this.browser = null;
                await this.releaseBrowser(browser);
                return;
            }
            this.downloads = downloads;
            this.watchBrowser(browser);
            const tabs = new TabSet(browser, { onController: (controller) => this.armController(controller) });
            this.tabSet = tabs;
            await tabs.start();
            await tabs.attachAll();
            if (this.closed) {
                await tabs.dispose().catch(() => undefined);
                await downloads.dispose().catch(() => undefined);
                this.downloads = null;
                this.tabSet = null;
                this.browser = null;
                await this.releaseBrowser(browser);
                return;
            }
            this.tabSet = tabs;
            this.connection = 'own';
            this.transfersDisabled = false;
            this.launchedHeadless = headless;
            this.attachedMode = null;
            this.endpointKind = 'own';
            this.executablePath = resolved.path;
            this.browserVersion = await browser.version();
            this.phase = { state: 'ready' };
            this.startPersistTimer();
            logDaemon(`browser ready ${this.browserVersion}`);
        }
        catch (err) {
            if (this.closed)
                return;
            const message = errorText(err);
            logDaemon(`browser launch failed: ${message}`);
            this.phase = { state: 'error', message };
            const tabs = this.tabSet;
            this.tabSet = null;
            void tabs?.dispose().catch(() => undefined);
            const downloads = this.downloads;
            this.downloads = null;
            void downloads?.dispose().catch(() => undefined);
            const browser = this.browser;
            this.browser = null;
            if (browser)
                await this.releaseBrowser(browser);
        }
    }
    async launchConfiguredAttach(config) {
        this.phase = { state: 'launching' };
        let target;
        try {
            target = await resolveStoredAttach(config);
            notify('relaywright', ATTACH_ALLOW_HINT);
            const browser = await connectWebSocket(target.endpoint, ATTACH_TIMEOUT_MS);
            if (this.closed) {
                await browser.disconnect().catch(() => undefined);
                return;
            }
            await this.finishAttached(browser, target);
            const stored = config.browser?.cdp_url;
            if (target.inspectFallback || (stored && target.cdpUrl && target.cdpUrl !== stored))
                this.rememberAttach(target);
            logDaemon(`attached ${target.endpointKind}`);
        }
        catch (err) {
            if (this.browser)
                await this.dropBrowser('disconnect').catch(() => undefined);
            if (this.closed)
                return;
            const mapped = explainAttachFailure(target ?? { mode: 'daily', endpoint: '', endpointKind: 'devtools-file' }, err);
            logDaemon(`attach failed: ${mapped.message}`);
            this.startupError = mapped;
            this.phase = { state: 'error', message: mapped.message };
        }
    }
    async performAttach(input) {
        const target = await resolveAttachRequest(input);
        if (reuseLiveAttach({ connection: this.connection, connected: this.browser?.connected === true, endpoint: this.attachedEndpoint }, target.endpoint)) {
            this.phase = { state: 'ready' };
            const mode = this.attachedMode ?? target.mode;
            const endpointKind = this.endpointKind === 'own' ? target.endpointKind : this.endpointKind;
            return { mode, endpoint_kind: endpointKind, user_tabs: await this.foreignTabCount() };
        }
        notify('relaywright', ATTACH_ALLOW_HINT);
        const headlessOwn = this.connection !== 'attached' && (this.launchedHeadless || process.env.RELAYWRIGHT_HEADLESS === '1');
        await this.dropBrowser(this.connection === 'attached' || !headlessOwn ? 'disconnect' : 'close');
        let browser;
        try {
            browser = await connectWebSocket(target.endpoint, ATTACH_TIMEOUT_MS);
        }
        catch (err) {
            const mapped = explainAttachFailure(target, err);
            this.phase = { state: 'error', message: mapped.message };
            throw mapped;
        }
        if (this.closed) {
            await browser.disconnect().catch(() => undefined);
            throw new RelayError('attach_failed', 'Browser session is closed');
        }
        try {
            await this.finishAttached(browser, target);
        }
        catch (err) {
            if (this.browser === browser)
                await this.dropBrowser('disconnect').catch(() => undefined);
            else
                await browser.disconnect().catch(() => undefined);
            const mapped = explainAttachFailure(target, err);
            this.phase = { state: 'error', message: mapped.message };
            throw mapped;
        }
        this.rememberAttach(target);
        recordAudit('attach', { mode: target.mode, endpoint_kind: target.endpointKind });
        await flushAudit();
        logDaemon(`attached ${target.endpointKind}`);
        return { mode: target.mode, endpoint_kind: target.endpointKind, user_tabs: await this.foreignTabCount() };
    }
    async foreignTabCount() {
        try {
            return (await this.tabset().listForeign()).length;
        }
        catch (err) {
            logDaemon(`user tab count failed: ${errorText(err)}`);
            return 0;
        }
    }
    rememberAttach(target) {
        updateGlobalConfig((config) => {
            const browser = { ...(config.browser ?? {}), mode: target.mode };
            if (target.mode === 'daily') {
                browser.user_data_dir = target.userDataDir;
                delete browser.cdp_url;
            }
            else {
                browser.cdp_url = target.cdpUrl;
                delete browser.user_data_dir;
            }
            config.browser = browser;
            if (!config.attach?.reconnect)
                config.attach = { ...(config.attach ?? {}), reconnect: 'lazy' };
        });
    }
    async finishAttached(browser, target) {
        this.browser = browser;
        this.connection = 'attached';
        this.transfersDisabled = true;
        this.attachedMode = target.mode;
        this.endpointKind = target.endpointKind;
        this.executablePath = '';
        this.launchedHeadless = false;
        this.watchBrowser(browser);
        const downloads = await DownloadManager.start(browser, { applyBehavior: false });
        this.downloads = downloads;
        const tabs = new TabSet(browser, {
            scope: 'owned',
            onController: (controller) => this.armController(controller),
        });
        this.tabSet = tabs;
        await tabs.start();
        if (this.closed) {
            await this.dropBrowser('disconnect');
            return;
        }
        this.browserVersion = await browser.version().catch(() => '');
        this.attachedEndpoint = target.endpoint;
        this.phase = { state: 'ready' };
    }
    async dropBrowser(policy) {
        this.stopPersistTimer();
        const attached = this.connection === 'attached';
        if (!attached && policy === 'close') {
            await this.identities.persistAll().catch((err) => logDaemon(`cookie persist failed: ${errorText(err)}`));
        }
        if (attached)
            await this.tabSet?.closeCreated().catch(() => undefined);
        const downloads = this.downloads;
        this.downloads = null;
        await downloads?.dispose().catch(() => undefined);
        const tabs = this.tabSet;
        this.tabSet = null;
        await tabs?.dispose().catch(() => undefined);
        const browser = this.browser;
        this.browser = null;
        this.transfersDisabled = false;
        this.attachedMode = null;
        this.endpointKind = 'own';
        if (browser) {
            this.releasing = true;
            try {
                if (attached || policy === 'disconnect')
                    await browser.disconnect().catch(() => undefined);
                else
                    await browser.close().catch(() => undefined);
            }
            finally {
                this.releasing = false;
            }
        }
        this.attachedEndpoint = '';
        this.connection = 'own';
    }
    watchBrowser(browser) {
        browser.on('disconnected', () => {
            logDaemon('browser disconnected');
            if (this.browser !== browser)
                return;
            this.browser = null;
            this.attachedEndpoint = '';
            const open = this.tabSet;
            this.tabSet = null;
            const caught = this.downloads;
            this.downloads = null;
            this.stopPersistTimer();
            void caught?.dispose().catch(() => undefined);
            void open?.dispose().catch(() => undefined);
            if (!this.closed && !this.releasing && this.phase.state === 'ready') {
                this.phase = { state: 'error', message: 'Browser disconnected' };
            }
        });
    }
    async armController(controller) {
        if (!this.shouldGate())
            return;
        const page = controller.pageHandle();
        await armNavigationGate(page, (url) => this.decision(url), (domain) => {
            this.blockedDomain = domain;
        });
    }
    shouldGate() {
        if (this.connection === 'attached')
            return true;
        return readAllowDomains().length > 0 || this.sessionGrants.size > 0;
    }
    decision(url) {
        const mode = this.connection === 'attached' ? (this.attachedMode ?? 'daily') : 'separate';
        return navigationDecision(url, mode, readAllowDomains(), [...this.sessionGrants]);
    }
    assertNavigation(url) {
        const decision = this.decision(url);
        if (!decision.ok)
            throw domainNotAllowed(decision.domain);
    }
    throwIfBlocked() {
        if (!this.blockedDomain)
            return;
        const domain = this.blockedDomain;
        this.blockedDomain = null;
        throw domainNotAllowed(domain);
    }
    assertTransfers() {
        if (this.transfersDisabled)
            throw new RelayError('bad_request', ATTACH_TRANSFERS_MESSAGE);
    }
    withHandoff(body) {
        const handoff = this.handoff.view();
        if (handoff.state === 'idle')
            return body;
        return { ...body, handoff };
    }
    assertModel() {
        const reason = this.handoff.lockReason();
        if (!reason)
            return;
        throw new RelayError('human_in_control', `A human is completing login: ${reason}. Call request_human to keep waiting.`);
    }
    async waitOutHandoff(reason) {
        await this.handoff.start(reason);
        const view = await this.handoff.wait(HANDOFF_TIMEOUT_MS);
        if (view.state === 'done' || view.state === 'cancelled' || view.state === 'timeout')
            return view.state;
        return 'timeout';
    }
    startPersistTimer() {
        this.stopPersistTimer();
        const timer = setInterval(() => {
            void this.identities.persistAll().catch((err) => logDaemon(`cookie persist failed: ${errorText(err)}`));
        }, 5 * 60_000);
        timer.unref?.();
        this.persistTimer = timer;
    }
    stopPersistTimer() {
        if (!this.persistTimer)
            return;
        clearInterval(this.persistTimer);
        this.persistTimer = null;
    }
    async releaseBrowser(browser) {
        this.releasing = true;
        try {
            if (this.connection === 'attached' || this.keepBrowser)
                await browser.disconnect().catch(() => undefined);
            else
                await browser.close().catch(() => undefined);
        }
        finally {
            this.releasing = false;
        }
    }
}
function replaceSkillStep(skill, stepId, target) {
    let found = false;
    const steps = skill.steps.map((step) => {
        if (step.id !== stepId)
            return step;
        found = true;
        return replaceStepTarget(step, target);
    });
    if (!found)
        throw new RelayError('bad_params', `Step ${stepId} was not found`);
    return { ...skill, steps };
}
function pageOrigin(url) {
    try {
        return new URL(url).origin;
    }
    catch {
        return 'null';
    }
}
async function noteEval(exprSha, exprLen, origin, ok, resultLen) {
    recordAudit('eval', {
        expr_sha256: exprSha,
        expr_len: exprLen,
        url_origin: origin,
        ok,
        result_len: resultLen,
    });
    await flushAudit();
}
function missingSelfResult(name, input, message) {
    return {
        results: [
            {
                outcome: 'broken',
                message,
                params: input.params ?? {},
                steps: [],
                duration_ms: 0,
                broken: { step_id: 'privacy', reason: message, excerpt: '' },
            },
        ],
        exit_code: 30,
        out_dir: input.out_dir ?? runOutputDir(name),
    };
}
function grantDomain(url) {
    const host = hostOfUrl(url);
    if (!host)
        return null;
    const domain = registrableDomain(host);
    return domain || null;
}
function parseHandoffUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new RelayError('bad_request', `Invalid URL: ${value}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new RelayError('bad_request', `request_human only opens an http(s) page so a person can log in. It cannot change Chrome settings. Got ${url.protocol}`);
    }
    return url.toString();
}
function parseHttpUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new RelayError('bad_request', `Invalid URL: ${value}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new RelayError('bad_request', `Only http and https URLs are supported, got ${url.protocol}`);
    }
    return url.toString();
}
function sanitizeTitle(title) {
    const name = sanitizeFilename(title.trim() || 'page');
    if (name.toLowerCase().endsWith('.pdf')) {
        const stem = name.slice(0, -4).replace(/[. ]+$/g, '');
        return stem || 'page';
    }
    return name;
}
function isClosedTarget(err) {
    return /Target closed|Session closed|Connection closed|TargetClose|detached|Tab closed|Tab is closed/i.test(errorText(err));
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=browser.js.map