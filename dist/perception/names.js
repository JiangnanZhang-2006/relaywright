const GENERIC_TOKENS = new Set(['ng-star-inserted', 'icon', 'fa', 'fas', 'far', 'fab', 'material-icons', 'svg-icon']);
/** Fallback when an interactive control has no accessible name. */
export function fallbackControlName(parts) {
    const aria = compact(parts.ariaLabel ?? '');
    if (aria)
        return aria;
    const title = compact(parts.title ?? '');
    if (title)
        return title;
    const alt = compact(parts.imgAlt ?? '');
    if (alt)
        return alt;
    const imgTitle = compact(parts.imgTitle ?? '');
    if (imgTitle)
        return imgTitle;
    const token = classToken(parts.className ?? '');
    if (token)
        return `icon: ${token}`;
    const stem = fileStem(parts.imgSrc ?? '');
    if (stem && !generic(stem))
        return `icon: ${stem}`;
    return '';
}
function classToken(className) {
    for (const token of className.split(/\s+/)) {
        if (!token || generic(token) || token.startsWith('ant-'))
            continue;
        return token;
    }
    return '';
}
function generic(token) {
    return GENERIC_TOKENS.has(token.toLowerCase());
}
function fileStem(src) {
    const clean = src.split('?')[0]?.split('#')[0] ?? '';
    const base = clean.split(/[/\\]/).pop() ?? '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0)
        return base;
    return base.slice(0, dot);
}
function compact(value) {
    return value.replace(/\s+/g, ' ').trim();
}
//# sourceMappingURL=names.js.map