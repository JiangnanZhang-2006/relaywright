import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configPath, privacyPath, readTextFile, relaywrightHome } from '../config/paths.js';
import { hostOfUrl, registrableDomain } from '../session/domain.js';
import type { SelfKind, TokenKind, ValueKind } from './detect.js';

export interface StoredOther {
  token: string;
  n: number;
  value: string;
  kind: ValueKind;
  param: string;
  tokenKind: TokenKind;
}

export interface StoredCandidate {
  token: string;
  n: number;
  value: string;
}

export interface PrivacyFile {
  model_redaction?: boolean;
  self: Partial<Record<SelfKind, string>>;
  rejections: string[];
  allow: string[];
  others: Record<string, StoredOther>;
  candidates: Record<string, StoredCandidate>;
  aliases: Record<string, string>;
  /** Old candidate tokens still resolve after confirm or reject. Values stay on disk. */
  retired: Record<string, string>;
  next: Partial<Record<TokenKind, number>>;
  categories: Record<string, never>;
}

export interface GlobalConfig {
  privacy?: { model_redaction?: boolean };
  heal?: { base_url?: string; model?: string; api_key_env?: string };
  /** Page eval stays off until init or `relaywright config set eval on`. */
  eval?: boolean;
  browser?: {
    mode?: 'separate' | 'daily' | 'cdp';
    cdp_url?: string;
    user_data_dir?: string;
  };
  /** Default reconnect is lazy: the allow dialog waits until the next browser command. */
  attach?: { reconnect?: 'lazy' | 'eager' };
  /** Registrable domains. Subdomains are included. Empty means separate mode allows every site. */
  allow_domains?: string[];
  /** Set by `relaywright init`. Absent until the first completed init. */
  initialized_at?: string;
  /** Separate-mode Chrome. RELAYWRIGHT_HEADLESS still overrides this. */
  headless?: boolean;
  /** Directory for files relaywright saves. */
  downloads?: string;
  /** Desktop toasts. RELAYWRIGHT_NOTIFY=0 still disables them. */
  notify?: boolean;
}

const EMPTY = (): PrivacyFile => ({
  self: {},
  rejections: [],
  allow: [],
  others: {},
  candidates: {},
  aliases: {},
  retired: {},
  next: {},
  categories: {},
});

export class PrivacyStore {
  constructor(private readonly root = relaywrightHome()) {}

  identityKey(url: string | undefined): string | null {
    if (!url) return null;
    const host = hostOfUrl(url);
    if (!host) return null;
    return safeKey(registrableDomain(host));
  }

  globalMode(): boolean {
    return readConfig(this.root).privacy?.model_redaction === true;
  }

  setGlobalMode(on: boolean): void {
    const config = readConfig(this.root);
    config.privacy = { ...(config.privacy ?? {}), model_redaction: on };
    writeJson(configPath(this.root), config);
  }

  read(identity: string): PrivacyFile {
    const key = safeKey(identity);
    if (!key) return EMPTY();
    const path = privacyPath(key, this.root);
    if (!existsSync(path)) return EMPTY();
    try {
      const parsed = JSON.parse(readTextFile(path)) as Partial<PrivacyFile>;
      const next = { ...(parsed.next ?? {}) };
      const hadCounter = Object.prototype.hasOwnProperty.call(next, '候选');
      delete next['候选'];
      const hadCandidates = parsed.candidates != null && Object.keys(parsed.candidates).length > 0;
      const file: PrivacyFile = {
        ...EMPTY(),
        ...parsed,
        self: parsed.self ?? {},
        rejections: parsed.rejections ?? [],
        allow: parsed.allow ?? [],
        others: parsed.others ?? {},
        candidates: {},
        aliases: parsed.aliases ?? {},
        retired: parsed.retired ?? {},
        next,
        categories: {},
      };
      if (hadCandidates || hadCounter) this.write(key, file);
      return file;
    } catch {
      return EMPTY();
    }
  }

  write(identity: string, file: PrivacyFile): void {
    const key = safeKey(identity);
    if (!key) return;
    const next = { ...file.next };
    delete next['候选'];
    const stored: PrivacyFile = { ...file, candidates: {}, next, categories: {} };
    writeJson(privacyPath(key, this.root), stored);
  }
}

export function safeKey(name: string): string | null {
  const key = name.trim().toLowerCase().replace(/:/g, '_');
  if (!key || key === '.' || key === '..' || key.includes('..')) return null;
  if (!/^[\w.-]+$/.test(key)) return null;
  return key;
}

export function readGlobalConfig(root = relaywrightHome()): GlobalConfig {
  return readConfig(root);
}

export function updateGlobalConfig(mutate: (config: GlobalConfig) => void, root = relaywrightHome()): GlobalConfig {
  const config = readConfig(root);
  mutate(config);
  writeJson(configPath(root), config);
  return config;
}

function migrateBrowserMode(config: GlobalConfig): boolean {
  const mode = config.browser?.mode as string | undefined;
  if (mode !== 'own' && mode !== 'attach') return false;
  config.browser = { ...config.browser, mode: mode === 'own' ? 'separate' : 'daily' };
  return true;
}

function readConfig(root: string): GlobalConfig {
  const path = configPath(root);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readTextFile(path)) as GlobalConfig;
    if (!parsed || typeof parsed !== 'object') return {};
    if (migrateBrowserMode(parsed)) {
      try {
        writeJson(path, parsed);
      } catch {
        // The caller still sees the new mode name. The next successful write stores it.
      }
    }
    return parsed;
  } catch {
    return {};
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows may refuse the mode. The file is still the user's own local data.
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EEXIST') {
      rmSync(tmp, { force: true });
      throw err;
    }
    rmSync(path, { force: true });
    renameSync(tmp, path);
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Same as the temp file: best effort.
  }
}
