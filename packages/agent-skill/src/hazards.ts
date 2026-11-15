import { matchesGlob } from 'node:path';
import { AreaName } from '@10db/contracts';
import { TendbError } from './errors';
import type { HazardView, ProjectView } from './api-views';

const HAZARD_ADDITION_KEYS = ['name', 'globs', 'commands', 'scope'];
const HAZARD_SCOPES = ['copy', 'project'];
const CONTROL_CHARACTER = /\p{Cc}/u;

function stringList(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== 'string' || v.trim() === '' || CONTROL_CHARACTER.test(v))
  ) {
    throw new TendbError(`${what} must be a list of non-empty strings.`);
  }
  return value.map((v: string) => v.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface HazardMerge {
  merged: HazardView[];
  report: string[];
}

/**
 * `additions` merged into `project`'s hazards. Adding only makes 10db stricter, so this never removes or
 * loosens: it appends globs and commands to a hazard of the same name, or adds a new hazard (scope
 * `project` unless given), and refuses a scope change to an existing one. `files` are the repo's tracked
 * files, or null when git could not list them; each added glob is reported with how many it covers.
 */
export function mergeHazards(
  project: ProjectView,
  additions: unknown,
  files: readonly string[] | null,
): HazardMerge {
  if (!Array.isArray(additions) || additions.length === 0) {
    throw new TendbError(
      'The additions must be a non-empty JSON list of { name, globs?, commands?, scope? }.',
    );
  }
  const list: unknown[] = additions;
  const merged = project.hazards.map((h) => ({
    ...h,
    globs: [...h.globs],
    commands: [...h.commands],
  }));
  const report: string[] = [];
  for (const add of list) {
    if (!isRecord(add)) throw new TendbError('Each addition must be an object.');
    const unknown = Object.keys(add).filter((k) => !HAZARD_ADDITION_KEYS.includes(k));
    if (unknown.length > 0) throw new TendbError(`Unknown hazard fields: ${unknown.join(', ')}.`);
    const { name, scope } = add;
    if (typeof name !== 'string' || !AreaName.safeParse(name).success) {
      throw new TendbError(
        `"${String(name)}" is not a hazard name: lowercase letters, digits and dashes.`,
      );
    }
    if (scope !== undefined && (typeof scope !== 'string' || !HAZARD_SCOPES.includes(scope))) {
      throw new TendbError(`${name}: scope is copy or project.`);
    }
    const globs = stringList(add['globs'], `${name}: globs`);
    const commands = stringList(add['commands'], `${name}: commands`);
    let target = merged.find((h) => h.name === name);
    if (target) {
      if (scope !== undefined && scope !== (target.scope ?? 'project')) {
        throw new TendbError(
          `${name} exists with scope ${target.scope ?? 'project'}; this command never changes a scope.`,
        );
      }
    } else {
      if (globs.length === 0)
        throw new TendbError(`${name} is a new hazard and needs at least one glob.`);
      target = { name, globs: [], commands: [], scope: scope ?? 'project' };
      merged.push(target);
      report.push(`+ hazard ${name} (scope ${target.scope ?? 'project'})`);
    }
    for (const g of globs) {
      if (target.globs.includes(g)) continue;
      target.globs.push(g);
      const covers = files === null ? '?' : files.filter((f) => matchesGlob(f, g)).length;
      report.push(`+ ${name} glob ${g}  (${String(covers)} tracked files)`);
    }
    for (const c of commands) {
      if (target.commands.includes(c)) continue;
      target.commands.push(c);
      report.push(`+ ${name} command "${c}"`);
    }
  }
  return { merged, report };
}
