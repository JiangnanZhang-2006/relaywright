// Checks the license of every package in package-lock.json against an allowlist.
// Runtime packages ship with relaywright, so they must be permissive and compatible with
// Apache-2.0. Dev-only packages are never distributed; weak copyleft is accepted there.
import { readFileSync } from 'node:fs';

const RUNTIME = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0']);
const DEV_ONLY = new Set([...RUNTIME, 'MPL-2.0', 'CC-BY-4.0', 'Python-2.0']);

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const problems = [];
const counts = new Map();
for (const [path, info] of Object.entries(lock.packages ?? {})) {
  if (!path) continue;
  const license = typeof info.license === 'string' ? info.license : '(none)';
  const allowed = info.dev ? DEV_ONLY : RUNTIME;
  const ok = license
    .replace(/[()]/g, '')
    .split(/\s+OR\s+/)
    .some((choice) => choice.split(/\s+AND\s+/).every((part) => allowed.has(part.trim())));
  counts.set(license, (counts.get(license) ?? 0) + 1);
  if (!ok) problems.push(`${path.replace(/^node_modules\//, '')} ${license}${info.dev ? ' (dev)' : ''}`);
}

console.log([...counts].map(([license, count]) => `${license}: ${count}`).join(', '));
if (problems.length > 0) {
  console.error(`License not allowed:\n${problems.map((line) => `  ${line}`).join('\n')}`);
  process.exitCode = 1;
}
