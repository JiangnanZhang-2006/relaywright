/** Previous maximized/fullscreen windows stay that way. A minimized or normal window comes back normal. */
export function restoredWindowState(state) {
    if (state === 'maximized' || state === 'fullscreen')
        return state;
    return 'normal';
}
//# sourceMappingURL=window.js.map