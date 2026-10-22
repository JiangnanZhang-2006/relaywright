import { RelayError } from '../errors.js';

export interface ExampleParam {
  name: string;
  example: string;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Numeric examples match only as whole numbers. A term like "2" must not rewrite
 * a port, a year, or an id that merely contains that digit.
 */
export function templatize(input: string, params: readonly ExampleParam[]): { text: string; used: Set<string> } {
  if (input === '{{secret}}') return { text: input, used: new Set() };
  const ordered = [...params]
    .filter((param) => param.example.length > 0)
    .sort((left, right) => right.example.length - left.example.length || left.name.localeCompare(right.name));
  let index = 0;
  let text = '';
  const used = new Set<string>();
  while (index < input.length) {
    let hit: ExampleParam | undefined;
    for (const param of ordered) {
      if (!input.startsWith(param.example, index)) continue;
      if (!wholeNumber(input, index, param.example)) continue;
      hit = param;
      break;
    }
    if (hit) {
      text += `{{${hit.name}}}`;
      used.add(hit.name);
      index += hit.example.length;
      continue;
    }
    text += input[index];
    index += 1;
  }
  return { text, used };
}

export function renderTemplate(input: string, params: Record<string, string>, declared: ReadonlySet<string>): string {
  return input.replace(PLACEHOLDER, (_full, name: string) => {
    if (name === 'secret') {
      throw new RelayError('bad_params', 'Secrets are not supported until the vault exists ({{secret}}).');
    }
    if (!declared.has(name)) throw new RelayError('bad_params', `Unknown placeholder {{${name}}}`);
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new RelayError('bad_params', `Missing required param ${name}`);
    }
    return params[name] ?? '';
  });
}

function wholeNumber(input: string, index: number, literal: string): boolean {
  if (!/^\d+$/.test(literal)) return true;
  const before = index > 0 ? input[index - 1] : '';
  const after = input[index + literal.length] ?? '';
  if (before && /\d/.test(before)) return false;
  if (after && /\d/.test(after)) return false;
  return true;
}
