import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTextFile, relaywrightHome, stateDir } from '../config/paths.js';
import { RelayError } from '../errors.js';

/** Serialized JSON, not the JavaScript string length. */
export const STATE_VALUE_LIMIT = 64 * 1024;

/**
 * Namespaces and keys cannot contain dots. `{{state.<ns>.<key>.<path>}}`
 * uses the first segment as the namespace, the second as the key, and the rest as a path.
 */
const NAMESPACE = /^[a-z0-9_-]{1,64}$/;
const KEY = /^[A-Za-z0-9_-]{1,128}$/;

export interface StateEntry {
  value: unknown;
  version: number;
  updated_at: string;
}

interface NamespaceFile {
  keys: Record<string, StateEntry>;
}

const tails = new Map<string, Promise<unknown>>();

function locked<T>(root: string, ns: string, fn: () => T): Promise<T> {
  const id = `${root}\0${ns}`;
  const prev = tails.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  tails.set(
    id,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function assertNamespace(ns: string): void {
  if (!NAMESPACE.test(ns)) {
    throw new RelayError('bad_request', 'Namespace must match [a-z0-9_-]{1,64}');
  }
}

export function assertStateKey(key: string): void {
  if (!KEY.test(key)) {
    throw new RelayError('bad_request', 'State key must match [A-Za-z0-9_-]{1,128} (no dots or slashes)');
  }
}

export function stateFile(ns: string, root = relaywrightHome()): string {
  assertNamespace(ns);
  return join(stateDir(root), `${ns}.json`);
}

/**
 * A state_set value is text after templating. JSON text becomes the parsed
 * value so a later `{{state.ns.key.path}}` can walk it; other text stays a string.
 */
export function parseStateValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return text;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

export async function statePut(ns: string, key: string, value: unknown, ifVersion?: number, root = relaywrightHome()): Promise<StateEntry> {
  assertNamespace(ns);
  assertStateKey(key);
  const size = measure(value);
  if (size > STATE_VALUE_LIMIT) {
    throw new RelayError('bad_request', `State value exceeds ${STATE_VALUE_LIMIT} bytes`);
  }
  if (ifVersion !== undefined && (!Number.isInteger(ifVersion) || ifVersion < 0)) {
    throw new RelayError('bad_request', 'if_version must be a non-negative integer');
  }
  return locked(root, ns, () => {
    const file = readNamespace(ns, root);
    const current = file.keys[key];
    const currentVersion = current?.version ?? 0;
    if (ifVersion !== undefined && ifVersion !== currentVersion) {
      throw new RelayError('version_conflict', `Version conflict for ${ns}/${key} (current ${currentVersion})`, {
        version: currentVersion,
      });
    }
    const entry: StateEntry = {
      value,
      version: currentVersion + 1,
      updated_at: new Date().toISOString(),
    };
    file.keys[key] = entry;
    writeNamespace(ns, file, root);
    return entry;
  });
}

export async function stateGet(ns: string, key: string, root = relaywrightHome()): Promise<StateEntry> {
  assertNamespace(ns);
  assertStateKey(key);
  return locked(root, ns, () => {
    const entry = readNamespace(ns, root).keys[key];
    if (!entry) throw new RelayError('not_found', `State ${ns}/${key} was not found`);
    return entry;
  });
}

export async function stateList(ns: string, root = relaywrightHome()): Promise<Array<{ key: string; version: number; updated_at: string }>> {
  assertNamespace(ns);
  return locked(root, ns, () => {
    const file = readNamespace(ns, root);
    return Object.entries(file.keys)
      .map(([key, entry]) => ({ key, version: entry.version, updated_at: entry.updated_at }))
      .sort((left, right) => left.key.localeCompare(right.key));
  });
}

export async function stateDelete(ns: string, key: string, ifVersion?: number, root = relaywrightHome()): Promise<{ key: string; version: number }> {
  assertNamespace(ns);
  assertStateKey(key);
  if (ifVersion !== undefined && (!Number.isInteger(ifVersion) || ifVersion < 0)) {
    throw new RelayError('bad_request', 'if_version must be a non-negative integer');
  }
  return locked(root, ns, () => {
    const file = readNamespace(ns, root);
    const current = file.keys[key];
    if (!current) throw new RelayError('not_found', `State ${ns}/${key} was not found`);
    if (ifVersion !== undefined && ifVersion !== current.version) {
      throw new RelayError('version_conflict', `Version conflict for ${ns}/${key} (current ${current.version})`, {
        version: current.version,
      });
    }
    const version = current.version;
    delete file.keys[key];
    writeNamespace(ns, file, root);
    return { key, version };
  });
}

function measure(value: unknown): number {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new RelayError('bad_request', 'State value must be JSON');
  }
  if (text === undefined) throw new RelayError('bad_request', 'State value must be JSON');
  return Buffer.byteLength(text, 'utf8');
}

function readNamespace(ns: string, root: string): NamespaceFile {
  const path = stateFile(ns, root);
  if (!existsSync(path)) return { keys: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readTextFile(path));
  } catch {
    throw new RelayError('bad_request', `State namespace ${ns} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { keys: {} };
  const keys = (parsed as { keys?: unknown }).keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return { keys: {} };
  return { keys: keys as Record<string, StateEntry> };
}

function writeNamespace(ns: string, file: NamespaceFile, root: string): void {
  const path = stateFile(ns, root);
  mkdirSync(stateDir(root), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
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
    // Windows cannot rename onto an existing file. The previous file stays until this point.
    rmSync(path, { force: true });
    renameSync(tmp, path);
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Same as the temp file: best effort.
  }
}
