import { errorText } from '../config/paths.js';
import { RelayError } from '../errors.js';
import { BROWSER_HELPERS } from '../perception/inspect-script.js';
import { matchOption, optionMiss } from './match-option.js';
const OPTION_WAIT_MS = 2_000;
const STALE_MESSAGE = /Could not find node|No node with given id|Node is detached|Cannot find context|Inspected target navigated|Backend node/i;
export async function performAction(ctx, input) {
    try {
        switch (input.action) {
            case 'click':
                await clickRef(ctx, requiredRef(input));
                return;
            case 'type':
                await typeRef(ctx, requiredRef(input), requiredValue(input), input.key);
                return;
            case 'select':
                await selectRef(ctx, requiredRef(input), requiredValue(input));
                return;
            case 'press':
                if (!input.key)
                    throw new RelayError('bad_request', 'key is required for press');
                if (input.ref)
                    await focusRef(ctx, input.ref);
                await ctx.page.keyboard.press(input.key);
                return;
            case 'scroll':
                await scroll(ctx, input.ref, input.value);
                return;
            default:
                throw new RelayError('bad_request', `Unknown action ${String(input.action)}`);
        }
    }
    catch (err) {
        if (err instanceof RelayError)
            throw err;
        if (input.ref && STALE_MESSAGE.test(errorText(err))) {
            throw new RelayError('stale_ref', `Ref ${input.ref} no longer matches an element. Take a new snapshot.`);
        }
        throw err;
    }
}
async function clickRef(ctx, ref) {
    await clickBackend(ctx, ctx.resolve(ref));
}
async function clickBackend(ctx, backendNodeId) {
    const point = await viewportPoint(ctx, backendNodeId);
    const objectId = await objectIdFor(ctx.cdp, backendNodeId);
    const hit = await callOn(ctx.cdp, objectId, `function(x, y) {
      const hit = document.elementFromPoint(x, y);
      const target = this;
      if (!hit) return { ok: false, cover: 'no element' };
      if (hit === target || target.contains(hit) || hit.contains(target)) return { ok: true, cover: '' };
      const tag = hit.tagName.toLowerCase();
      const id = hit.id ? '#' + hit.id : '';
      const classes = [...hit.classList].map((name) => '.' + name).join('');
      const text = String(hit.innerText || hit.textContent || '').replace(/\\s+/g, ' ').trim();
      const desc = (tag + id + classes + (text ? ' ' + text : '')).slice(0, 60);
      return { ok: false, cover: desc };
    }`, [point.x, point.y]);
    const cover = recordValue(hit);
    if (!cover || cover.ok !== true) {
        const name = typeof cover?.cover === 'string' && cover.cover ? cover.cover : 'another element';
        throw new RelayError('occluded', `Click blocked by ${name}.`);
    }
    await ctx.page.mouse.click(point.x, point.y);
}
async function viewportPoint(ctx, backendNodeId) {
    await ctx.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    const { quads } = await ctx.cdp.send('DOM.getContentQuads', { backendNodeId });
    const quad = quads[0];
    if (!quad)
        throw new Error('Element is not visible');
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const quadPoint = {
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
    const objectId = await objectIdFor(ctx.cdp, backendNodeId);
    const described = await callOn(ctx.cdp, objectId, `function() {
      const rect = this.getBoundingClientRect();
      let x = rect.left + rect.width / 2;
      let y = rect.top + rect.height / 2;
      let view = this.ownerDocument.defaultView;
      const scrollX = view ? view.scrollX : 0;
      const scrollY = view ? view.scrollY : 0;
      while (view && view.frameElement) {
        const frameRect = view.frameElement.getBoundingClientRect();
        x += frameRect.left;
        y += frameRect.top;
        view = view.frameElement.ownerDocument.defaultView;
      }
      return { x: x, y: y, scrollX: scrollX, scrollY: scrollY };
    }`);
    const box = recordValue(described);
    if (!box || typeof box.x !== 'number' || typeof box.y !== 'number')
        return quadPoint;
    const scrollX = typeof box.scrollX === 'number' ? box.scrollX : 0;
    const scrollY = typeof box.scrollY === 'number' ? box.scrollY : 0;
    // getContentQuads is document-relative in some Chrome builds and viewport-relative in others.
    const asViewport = quadPoint;
    const asDocument = { x: quadPoint.x - scrollX, y: quadPoint.y - scrollY };
    const target = { x: box.x, y: box.y };
    const quadChoice = distance(asViewport, target) <= distance(asDocument, target) ? asViewport : asDocument;
    if (distance(quadChoice, target) <= 5)
        return quadChoice;
    return target;
}
async function typeRef(ctx, ref, value, key) {
    const backendNodeId = ctx.resolve(ref);
    await ctx.cdp.send('DOM.focus', { backendNodeId });
    const objectId = await objectIdFor(ctx.cdp, backendNodeId);
    const cleared = await callOn(ctx.cdp, objectId, `function() {
      const el = this;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'field';
      }
      if (el.isContentEditable) return 'editable';
      return 'other';
    }`);
    if (cleared.value === 'editable') {
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await ctx.page.keyboard.down(modifier);
        await ctx.page.keyboard.press('KeyA');
        await ctx.page.keyboard.up(modifier);
        await ctx.page.keyboard.press('Backspace');
    }
    await ctx.cdp.send('Input.insertText', { text: value });
    if (key)
        await ctx.page.keyboard.press(key);
}
async function selectRef(ctx, ref, query) {
    const backendNodeId = ctx.resolve(ref);
    const objectId = await objectIdFor(ctx.cdp, backendNodeId);
    const read = await callOn(ctx.cdp, objectId, `function() {
      ${BROWSER_HELPERS}
      const select = this;
      if (!(select instanceof HTMLSelectElement)) return null;
      const options = [];
      for (const option of select.options) options.push({ value: option.value, text: option.text });
      return { optionsJson: JSON.stringify(options), hasWidget: Boolean(rwFindWidget(select)) };
    }`);
    const info = recordValue(read);
    if (!info || typeof info.optionsJson !== 'string') {
        throw new RelayError('select_failed', 'Target is not a select element.');
    }
    const options = parseOptions(info.optionsJson);
    const matched = matchOption(options, query);
    if (!matched.ok)
        throw optionMiss(query, options);
    const applied = await callOn(ctx.cdp, objectId, `function(value) {
      const select = this;
      select.value = value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const jq = window.jQuery;
      if (typeof jq === 'function') {
        try {
          jq(select).trigger('change').trigger('chosen:updated');
          jq(select).trigger('change.select2');
        } catch (err) {
          /* Widget refresh is best-effort; the change event already ran. */
        }
      }
      return select.value;
    }`, [matched.option.value]);
    const widgetBackend = info.hasWidget === true ? await widgetBackendId(ctx.cdp, objectId) : null;
    const valueOk = applied.value === matched.option.value;
    const shown = widgetBackend === null ? true : await widgetShows(ctx.cdp, widgetBackend, matched.option.text);
    if (valueOk && shown)
        return;
    if (widgetBackend === null) {
        throw new RelayError('select_failed', `Select did not apply ${JSON.stringify(matched.option.text)}.`);
    }
    await clickBackend(ctx, widgetBackend);
    const optionBackend = await waitForOption(ctx.cdp, widgetBackend, matched.option.text);
    if (optionBackend === null) {
        throw new RelayError('select_failed', `Could not find option ${JSON.stringify(matched.option.text)} in the open widget.`);
    }
    await clickBackend(ctx, optionBackend);
    const verified = await callOn(ctx.cdp, objectId, `function() { return this.value; }`);
    const shownAfter = await widgetShows(ctx.cdp, widgetBackend, matched.option.text);
    if (verified.value !== matched.option.value || !shownAfter) {
        throw new RelayError('select_failed', `Select did not apply ${JSON.stringify(matched.option.text)}.`);
    }
}
async function widgetBackendId(cdp, selectObjectId) {
    const widget = await callOn(cdp, selectObjectId, `function() { ${BROWSER_HELPERS} return rwFindWidget(this); }`, [], false);
    if (!widget.objectId)
        return null;
    const described = await cdp.send('DOM.describeNode', { objectId: widget.objectId });
    return described.node.backendNodeId;
}
async function widgetShows(cdp, backendNodeId, text) {
    const objectId = await objectIdFor(cdp, backendNodeId);
    const result = await callOn(cdp, objectId, `function(text) {
      const compact = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
      const parts = [];
      const walk = (node) => {
        if (node.nodeType === 3) {
          parts.push(node.textContent || '');
          return;
        }
        if (node.nodeType !== 1) return;
        const style = getComputedStyle(node);
        if (node !== this && (style.display === 'none' || style.visibility === 'hidden')) return;
        for (const child of node.childNodes) walk(child);
      };
      walk(this);
      return compact(parts.join(' ')).includes(compact(text));
    }`, [text]);
    return result.value === true;
}
async function waitForOption(cdp, widgetBackend, text) {
    const deadline = Date.now() + OPTION_WAIT_MS;
    for (;;) {
        const objectId = await objectIdFor(cdp, widgetBackend);
        const found = await callOn(cdp, objectId, `function(text) {
        const want = String(text).replace(/\\s+/g, ' ').trim();
        const nodes = this.querySelectorAll('li, [role="option"]');
        for (const el of nodes) {
          const got = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (got !== want) continue;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          return el;
        }
        return null;
      }`, [text], false);
        if (found.objectId) {
            const described = await cdp.send('DOM.describeNode', { objectId: found.objectId });
            return described.node.backendNodeId;
        }
        if (Date.now() >= deadline)
            return null;
        await delay(50);
    }
}
async function focusRef(ctx, ref) {
    await ctx.cdp.send('DOM.focus', { backendNodeId: ctx.resolve(ref) });
}
async function scroll(ctx, ref, value) {
    if (ref) {
        await ctx.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: ctx.resolve(ref) });
        return;
    }
    if (value !== 'up' && value !== 'down') {
        throw new RelayError('bad_request', 'scroll without a ref requires value up or down');
    }
    await ctx.page.evaluate((direction) => {
        const view = globalThis;
        const amount = view.innerHeight * 0.8;
        view.scrollBy(0, direction === 'up' ? -amount : amount);
    }, value);
}
function requiredRef(input) {
    if (!input.ref)
        throw new RelayError('bad_request', 'ref is required for this action');
    return input.ref;
}
function requiredValue(input) {
    if (input.value === undefined)
        throw new RelayError('bad_request', 'value is required for this action');
    return input.value;
}
async function objectIdFor(cdp, backendNodeId) {
    const resolved = await cdp.send('DOM.resolveNode', { backendNodeId });
    const objectId = resolved.object.objectId;
    if (!objectId)
        throw new Error(`No object for backend node ${backendNodeId}`);
    return objectId;
}
async function callOn(cdp, objectId, functionDeclaration, args = [], returnByValue = true) {
    const result = await cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue,
    });
    if (result.exceptionDetails) {
        const details = result.exceptionDetails;
        throw new Error(details.exception?.description || details.text || 'callFunctionOn failed');
    }
    return result.result;
}
function recordValue(remote) {
    if (!remote.value || typeof remote.value !== 'object')
        return null;
    return remote.value;
}
function parseOptions(json) {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed))
        return [];
    const options = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object')
            continue;
        const record = item;
        options.push({ value: String(record.value ?? ''), text: String(record.text ?? '') });
    }
    return options;
}
function distance(left, right) {
    return Math.hypot(left.x - right.x, left.y - right.y);
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=perform.js.map