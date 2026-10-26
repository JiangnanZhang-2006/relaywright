import { downloadsDir, relaywrightHome } from './paths.js';
import { readGlobalConfig, updateGlobalConfig } from '../privacy/store.js';

export const EVAL_MAX_BYTES = 256 * 1024;

export const EVAL_DISABLED_MESSAGE =
  'Eval is disabled. Enable it with: relaywright config set eval on    or restart the daemon with RELAYWRIGHT_EVAL=on';

export function evalEnabled(): boolean {
  return process.env.RELAYWRIGHT_EVAL === 'on' || readGlobalConfig().eval === true;
}

export function setEvalEnabled(on: boolean, root = relaywrightHome()): boolean {
  updateGlobalConfig((config) => {
    config.eval = on;
  }, root);
  return on;
}

/** RELAYWRIGHT_HEADLESS wins. Otherwise config.headless, which defaults to headful. */
export function headlessEnabled(): boolean {
  const env = process.env.RELAYWRIGHT_HEADLESS;
  if (env === '1') return true;
  if (env === '0') return false;
  return readGlobalConfig().headless === true;
}

/** Configured save directory, or the home downloads folder when unset. */
export function activeDownloadsDir(): string {
  const configured = readGlobalConfig().downloads?.trim();
  return configured ? configured : downloadsDir();
}
