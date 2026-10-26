/** Previous maximized/fullscreen windows stay that way. A minimized or normal window comes back normal. */
export function restoredWindowState(state: string | undefined): 'normal' | 'maximized' | 'fullscreen' {
  if (state === 'maximized' || state === 'fullscreen') return state;
  return 'normal';
}
