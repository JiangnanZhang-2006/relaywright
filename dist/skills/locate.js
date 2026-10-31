import { tokenIndex } from './template.js';
const TEXT_ROLES = new Set(['clickable', 'button', 'link']);
/** First unique hit wins. An ambiguous level falls through to the next locator. */
export function chooseLocator(items, target, cssBackends = []) {
    const scoped = items.filter((item) => frameOk(item, target));
    if (target.role && target.name) {
        const exact = scoped.filter((item) => item.role === target.role && item.name === target.name);
        if (exact.length === 1 && exact[0])
            return { locator: 'role_name', backend: exact[0].backend };
    }
    if (target.css && cssBackends.length === 1 && cssBackends[0] !== undefined) {
        return { locator: 'css', backend: cssBackends[0] };
    }
    if (target.text) {
        const textual = scoped.filter((item) => textMatches(item, target.text ?? ''));
        if (textual.length === 1 && textual[0])
            return { locator: 'text', backend: textual[0].backend };
    }
    if (target.role && target.name) {
        const partial = scoped.filter((item) => item.role === target.role && item.name.includes(target.name));
        if (partial.length === 1 && partial[0])
            return { locator: 'role_name_contains', backend: partial[0].backend };
    }
    return null;
}
export function rowScoped(target) {
    return target.within !== undefined || target.nth !== undefined;
}
/** Controls that share the target's role and name, in snapshot order. Row and position count among these. */
export function rowPeers(items, target) {
    return items.filter((item) => frameOk(item, target) && item.role === target.role && item.name === target.name);
}
/**
 * A row-scoped target never falls back to the other locators: every peer has the same
 * role and name, so a fallback would click some other row.
 * `rows[i]` is the row text of `peers[i]`; only `within` needs it.
 */
export function chooseInRow(peers, target, rows) {
    if (target.within !== undefined) {
        const within = target.within;
        const hits = peers.filter((_peer, index) => tokenIndex(rows[index] ?? '', within) >= 0);
        if (hits.length === 1 && hits[0])
            return { locator: 'row', backend: hits[0].backend };
        return 'target_not_found';
    }
    const position = Number(target.nth);
    if (!Number.isInteger(position) || position < 1)
        return 'target_not_found';
    if (target.of !== undefined && peers.length !== target.of)
        return 'nth_shifted';
    const hit = peers[position - 1];
    return hit ? { locator: 'nth', backend: hit.backend } : 'target_not_found';
}
function textMatches(item, text) {
    if (!text || !TEXT_ROLES.has(item.role))
        return false;
    if (item.text !== undefined)
        return item.text === text;
    return item.name === text;
}
function frameOk(item, target) {
    if (!target.frame)
        return true;
    if (!item.frame)
        return false;
    if (target.frame.name && item.frame.name !== target.frame.name)
        return false;
    if (target.frame.url && item.frame.url !== target.frame.url)
        return false;
    return true;
}
//# sourceMappingURL=locate.js.map