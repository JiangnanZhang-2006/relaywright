import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readTextFile, relaywrightHome } from '../config/paths.js';
import { RelayError } from '../errors.js';
import { parseSkill, SkillNameSchema, stringifySkill, type Skill, type SkillDocument, type SkillHistory, type SkillSummary } from './schema.js';

export function writeSkill(skill: Skill, overwrite: boolean, root = relaywrightHome()): { path: string; yaml: string; version: number } {
  assertName(skill.name);
  const current = currentPath(skill.name, root);
  if (existsSync(current) && !overwrite) {
    throw new RelayError('skill_exists', `Skill ${skill.name} already exists`);
  }
  const version = existsSync(current) ? highestVersion(skill.name, root) + 1 : 1;
  const stored: Skill = { ...skill, version };
  const yaml = stringifySkill(stored);
  const versions = join(root, 'skills', skill.name, 'versions');
  mkdirSync(versions, { recursive: true });
  writeFileSync(join(versions, `v${version}.yaml`), yaml, 'utf8');
  writeFileSync(current, yaml, 'utf8');
  return { path: current, yaml, version };
}

/** Checks travel with the skill. They are already de-identified by the time they are written. */
export function writeSkillChecks(skill: Skill, yamlPath: string): void {
  const checks = skill.steps.filter((step) => step.expect).map((step) => ({ id: step.id, any: step.expect?.any ?? [] }));
  if (checks.length === 0) return;
  writeFileSync(join(dirname(yamlPath), 'checks.json'), `${JSON.stringify(checks, null, 2)}\n`, 'utf8');
}

export function readSkill(name: string, version?: number, root = relaywrightHome()): SkillDocument {
  assertName(name);
  const path = version === undefined ? currentPath(name, root) : versionPath(name, version, root);
  if (!existsSync(path)) {
    const which = version === undefined ? `Skill ${name} was not found` : `Skill ${name} version ${version} was not found`;
    throw new RelayError('skill_not_found', which);
  }
  const yaml = readTextFile(path);
  const skill = parseSkill(yaml);
  return { name: skill.name, version: skill.version, path, yaml, skill };
}

export function listSkills(root = relaywrightHome()): SkillSummary[] {
  const dir = join(root, 'skills');
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SkillNameSchema.safeParse(entry.name).success)
    .map((entry) => entry.name)
    .sort();
  const skills: SkillSummary[] = [];
  for (const name of names) {
    try {
      const doc = readSkill(name, undefined, root);
      skills.push({
        name: doc.skill.name,
        description: doc.skill.description,
        version: doc.skill.version,
        params: Object.keys(doc.skill.params),
      });
    } catch (err) {
      if (err instanceof RelayError && err.code === 'skill_not_found') continue;
      throw err;
    }
  }
  return skills;
}

export function skillHistory(name: string, root = relaywrightHome()): SkillHistory {
  const current = readSkill(name, undefined, root);
  return { name, current: current.version, versions: versionNumbers(name, root) };
}

export function rollbackSkill(name: string, to: number, root = relaywrightHome()): SkillDocument {
  const doc = readSkill(name, to, root);
  const path = currentPath(name, root);
  writeFileSync(path, doc.yaml, 'utf8');
  return { ...doc, path };
}

function versionNumbers(name: string, root: string): number[] {
  const dir = join(root, 'skills', name, 'versions');
  if (!existsSync(dir)) return [];
  const versions: number[] = [];
  for (const file of readdirSync(dir)) {
    const match = /^v(\d+)\.yaml$/.exec(file);
    if (match?.[1]) versions.push(Number(match[1]));
  }
  return versions.sort((left, right) => left - right);
}

function highestVersion(name: string, root: string): number {
  let max = 0;
  const current = currentPath(name, root);
  if (existsSync(current)) {
    try {
      max = parseSkill(readTextFile(current)).version;
    } catch {
      max = 0;
    }
  }
  for (const version of versionNumbers(name, root)) max = Math.max(max, version);
  return max;
}

function currentPath(name: string, root: string): string {
  return join(root, 'skills', name, 'skill.yaml');
}

function versionPath(name: string, version: number, root: string): string {
  return join(root, 'skills', name, 'versions', `v${version}.yaml`);
}

function assertName(name: string): void {
  if (!SkillNameSchema.safeParse(name).success) throw new RelayError('bad_params', `Invalid skill name ${name}`);
}
