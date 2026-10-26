import { relaywrightHome } from '../config/paths.js';
import { RelayError, type RelayErrorCode } from '../errors.js';
import { stateGet } from './store.js';

const STATE_REF = /\{\{\s*state\.([a-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,128})((?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;
const EXTRACT_REF = /\{\{\s*extract\.([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;

export interface TemplateScope {
  extract?: Record<string, unknown>;
  /** save_as -> step id for extract steps a mid-skill resume did not run again. */
  extractSteps?: Record<string, string>;
}

export async function resolveStateText(input: string, root = relaywrightHome(), scope: TemplateScope = {}): Promise<string> {
  const extracted = resolveExtractText(input, scope.extract ?? {}, scope.extractSteps ?? {});
  if (!extracted.includes('{{')) return extracted;
  const matches = [...extracted.matchAll(STATE_REF)];
  if (matches.length === 0) return extracted;
  let out = '';
  let index = 0;
  for (const match of matches) {
    const start = match.index ?? 0;
    out += extracted.slice(index, start);
    out += await lookup(match, root);
    index = start + match[0].length;
  }
  out += extracted.slice(index);
  return out;
}

export async function resolveStateValue<T>(value: T, root = relaywrightHome(), scope: TemplateScope = {}): Promise<T> {
  if (typeof value === 'string') return (await resolveStateText(value, root, scope)) as T;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await resolveStateValue(item, root, scope));
    return out as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = await resolveStateValue(child, root, scope);
    }
    return out as T;
  }
  return value;
}

function resolveExtractText(input: string, bag: Record<string, unknown>, steps: Record<string, string>): string {
  if (!input.includes('{{extract.')) return input;
  const matches = [...input.matchAll(EXTRACT_REF)];
  if (matches.length === 0) return input;
  let out = '';
  let index = 0;
  for (const match of matches) {
    const start = match.index ?? 0;
    out += input.slice(index, start);
    const name = match[1] ?? '';
    const path = match[2] ?? '';
    if (!Object.prototype.hasOwnProperty.call(bag, name)) {
      const stepId = steps[name];
      const rerun = stepId ? ` Re-run extract step ${stepId}.` : '';
      throw new RelayError('extract_missing', `Missing extract ${name}.${rerun}`);
    }
    const label = name;
    out += stringifyLeaf(walk(bag[name], path, label, 'extract_missing'), path ? `${label}${path}` : label, 'extract_missing');
    index = start + match[0].length;
  }
  out += input.slice(index);
  return out;
}

async function lookup(match: RegExpMatchArray, root: string): Promise<string> {
  const ns = match[1] ?? '';
  const key = match[2] ?? '';
  const path = match[3] ?? '';
  const label = `${ns}/${key}`;
  let entry;
  try {
    entry = await stateGet(ns, key, root);
  } catch (err) {
    if (err instanceof RelayError && err.code === 'not_found') {
      throw new RelayError('state_missing', `Missing state ${label}`);
    }
    throw err;
  }
  return stringifyLeaf(walk(entry.value, path, label, 'state_missing'), path ? `${label}${path}` : label, 'state_missing');
}

function walk(value: unknown, path: string, label: string, code: RelayErrorCode): unknown {
  if (!path) return value;
  let current = value;
  let walked = label;
  for (const segment of path.split('.').filter((part) => part.length > 0)) {
    walked += `.${segment}`;
    if (segment === '__proto__' || segment === 'prototype' || segment === 'constructor') {
      throw new RelayError(code, `Missing ${code === 'extract_missing' ? 'extract' : 'state'} path ${walked}`);
    }
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment) || Number(segment) >= current.length) {
        throw new RelayError(code, `Missing ${code === 'extract_missing' ? 'extract' : 'state'} path ${walked}`);
      }
      current = current[Number(segment)];
      continue;
    }
    if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    throw new RelayError(code, `Missing ${code === 'extract_missing' ? 'extract' : 'state'} path ${walked}`);
  }
  return current;
}

function stringifyLeaf(value: unknown, label: string, code: RelayErrorCode): string {
  if (typeof value === 'string') return value;
  if (value === undefined) throw new RelayError(code, `Missing ${code === 'extract_missing' ? 'extract' : 'state'} path ${label}`);
  const text = JSON.stringify(value);
  if (text === undefined) throw new RelayError(code, `Missing ${code === 'extract_missing' ? 'extract' : 'state'} path ${label}`);
  return text;
}
