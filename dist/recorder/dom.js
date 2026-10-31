import { errorText } from '../config/paths.js';
import { PASSWORD_FIELD_HELPERS } from '../perception/password-like.js';
const ROW_TEXT_MAX = 300;
const STALE = /Could not find node|No node with given id|Node is detached|Cannot find context|Inspected target navigated|Backend node/i;
/**
 * #id when the id is unique and not generated; otherwise a short ancestor path.
 * Uniqueness is checked with querySelectorAll in the element's own document.
 */
const DESCRIBE_FUNCTION = `function() {
  ${PASSWORD_FIELD_HELPERS}
  const el = this;
  if (!el || el.nodeType !== 1) return null;
  const doc = el.ownerDocument;
  const generated = /\\d{5,}|[0-9a-f]{8,}|^ember|^react|^:r/i;
  const skip = new Set(['active', 'hover', 'focus', 'open', 'selected', 'disabled', 'in', 'show', 'chosen-with-drop', 'chosen-container-active']);
  function goodId(node) {
    if (!node.id || generated.test(node.id)) return false;
    try {
      return doc.querySelectorAll('#' + CSS.escape(node.id)).length === 1;
    } catch (err) {
      return false;
    }
  }
  function segment(node) {
    const tag = node.tagName.toLowerCase();
    const classes = [];
    for (const name of node.classList) {
      if (skip.has(name)) continue;
      classes.push(name);
      if (classes.length === 2) break;
    }
    let selector = tag + classes.map((name) => '.' + CSS.escape(name)).join('');
    const parent = node.parentElement;
    if (parent) {
      let count = 0;
      let index = 0;
      for (const child of parent.children) {
        if (child.tagName !== node.tagName) continue;
        count += 1;
        if (child === node) index = count;
      }
      if (count > 1) selector += ':nth-of-type(' + index + ')';
    }
    return selector;
  }
  const tag = el.tagName.toLowerCase();
  const type = String(el.getAttribute('type') || 'text').toLowerCase();
  const style = getComputedStyle(el);
  const shown = style.display !== 'none' && style.visibility !== 'hidden';
  const password = tag === 'input' && (type === 'password' || (rwShown(el) && rwPasswordLike(el)));
  // Chrome's innerText on a hidden <select> is the option list, not a label.
  const text = password || tag === 'select' || !shown ? '' : String(el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  let css = '';
  if (goodId(el)) {
    css = '#' + CSS.escape(el.id);
  } else {
    const parts = [];
    let current = el;
    for (let depth = 0; current && current.nodeType === 1 && depth <= 5; depth += 1) {
      if (depth > 0 && goodId(current)) {
        parts.unshift('#' + CSS.escape(current.id));
        break;
      }
      parts.unshift(segment(current));
      current = current.parentElement;
    }
    css = parts.join(' > ');
  }
  let count = 0;
  try {
    count = css ? doc.querySelectorAll(css).length : 0;
  } catch (err) {
    count = 0;
  }
  return { tag: tag, id: el.id || '', css: css, cssUnique: count === 1, text: text, password: password };
}`;
export function findFrameId(root, frame) {
    if (!frame)
        return root.frame.id;
    const visit = (node) => {
        const name = (node.frame.name ?? '').trim();
        const nameOk = frame.name ? name === frame.name : true;
        const urlOk = frame.url ? node.frame.url === frame.url : true;
        if (nameOk && urlOk && (frame.name || frame.url))
            return node.frame.id;
        for (const child of node.childFrames ?? []) {
            const found = visit(child);
            if (found)
                return found;
        }
        return null;
    };
    return visit(root);
}
export async function describeBackend(cdp, backendNodeId) {
    let objectId = '';
    try {
        const resolved = await cdp.send('DOM.resolveNode', { backendNodeId });
        objectId = resolved.object.objectId ?? '';
    }
    catch (err) {
        if (STALE.test(errorText(err)))
            return null;
        throw err;
    }
    if (!objectId)
        return null;
    try {
        const result = await cdp.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: DESCRIBE_FUNCTION,
            returnByValue: true,
        });
        if (result.exceptionDetails) {
            const details = result.exceptionDetails;
            throw new Error(details.exception?.description || details.text || 'describe failed');
        }
        return asDescriptor(result.result.value);
    }
    finally {
        await cdp.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
}
/**
 * For each node: climb while the parent holds no other node of the set, so the result is
 * the largest ancestor unique to it (a list row or card). Stops below body.
 */
const ROW_TEXT_FUNCTION = `function() {
  const nodes = Array.prototype.slice.call(arguments);
  return nodes.map(function (el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return '';
    const doc = el.ownerDocument;
    let row = el;
    while (row.parentElement && row.parentElement !== doc.body && row.parentElement !== doc.documentElement) {
      const up = row.parentElement;
      if (nodes.some(function (other) { return other && other !== el && up.contains(other); })) break;
      row = up;
    }
    return String(row.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, ${ROW_TEXT_MAX});
  });
}`;
/** Row text for each backend, '' when a node cannot be resolved (for example in another process frame). */
export async function rowTextsFor(cdp, backends) {
    const objectIds = [];
    for (const backendNodeId of backends) {
        try {
            const resolved = await cdp.send('DOM.resolveNode', { backendNodeId });
            objectIds.push(resolved.object.objectId ?? '');
        }
        catch {
            objectIds.push('');
        }
    }
    const live = objectIds.filter((id) => id.length > 0);
    const first = live[0];
    if (!first)
        return backends.map(() => '');
    try {
        const result = await cdp.send('Runtime.callFunctionOn', {
            objectId: first,
            functionDeclaration: ROW_TEXT_FUNCTION,
            arguments: live.map((objectId) => ({ objectId })),
            returnByValue: true,
        });
        const value = result.exceptionDetails ? [] : result.result.value;
        const texts = Array.isArray(value) ? value.map((text) => (typeof text === 'string' ? text : '')) : [];
        let cursor = 0;
        return objectIds.map((id) => (id ? (texts[cursor++] ?? '') : ''));
    }
    finally {
        await Promise.all(live.map((objectId) => cdp.send('Runtime.releaseObject', { objectId }).catch(() => undefined)));
    }
}
export async function queryCssBackends(cdp, frameId, css) {
    let contextId;
    try {
        const world = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'relaywright-css' });
        contextId = world.executionContextId;
    }
    catch {
        return [];
    }
    const evaluated = await cdp.send('Runtime.evaluate', {
        expression: `(() => { try { return Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(css)}), 0, 2); } catch (err) { return []; } })()`,
        contextId,
        returnByValue: false,
    });
    if (evaluated.exceptionDetails || !evaluated.result.objectId)
        return [];
    const rootId = evaluated.result.objectId;
    const release = [rootId];
    try {
        const listed = await cdp.send('Runtime.getProperties', { objectId: rootId, ownProperties: true });
        const ids = listed.result
            .filter((property) => /^\d+$/.test(property.name) && property.value?.objectId)
            .sort((left, right) => Number(left.name) - Number(right.name))
            .map((property) => property.value?.objectId ?? '')
            .filter((id) => id.length > 0);
        release.push(...ids);
        const backends = [];
        for (const objectId of ids) {
            try {
                const described = await cdp.send('DOM.describeNode', { objectId });
                backends.push(described.node.backendNodeId);
            }
            catch {
                // The node can detach between the query and describeNode.
            }
        }
        return backends;
    }
    finally {
        await Promise.all(release.map((objectId) => cdp.send('Runtime.releaseObject', { objectId }).catch(() => undefined)));
    }
}
function asDescriptor(value) {
    if (!value || typeof value !== 'object')
        return null;
    const record = value;
    if (typeof record.tag !== 'string' || typeof record.css !== 'string')
        return null;
    return {
        tag: record.tag,
        id: typeof record.id === 'string' ? record.id : '',
        css: record.css,
        cssUnique: record.cssUnique === true,
        text: typeof record.text === 'string' ? record.text : '',
        password: record.password === true,
    };
}
//# sourceMappingURL=dom.js.map