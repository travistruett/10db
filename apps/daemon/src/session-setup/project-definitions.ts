import { readdirSync, realpathSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { RepoConfigFileError } from '../sessions';
import { readCheckoutFile } from './checkout-file';
import { cleanDefinition, DefinitionKind } from './definition-frontmatter';
import type { LeftOut } from './left-out';

/** A file the session's `project` plugin holds: a copy no lane can write. */
export interface DefinitionFile {
  /** Under the plugin root: `skills/<name>/<path>`, `commands/<name>.md` or `agents/<name>.md`. */
  readonly relative: string;
  /** Where it was read, under the checkout: `.claude/skills/<name>/<path>` and so on. */
  readonly source: string;
  readonly content: Buffer;
  /** The checkout file's mode, masked with `0o700`. */
  readonly mode: number;
}

export const PROJECT_DEFINITIONS_MAX_BYTES = 4 * 1024 * 1024;
export const PROJECT_FILE_MAX_BYTES = 256 * 1024;
export const PROJECT_DEFINITIONS_MAX_FILES = 500;

const PAST_THE_CAP = 'past the 4 MiB or 500 files 10db copies';
const SECRETS_FILE = 'a secrets file is never copied';

/**
 * A skill's Codex config, which the pinned Codex reads from a skill root to install and start the
 * tools and MCP servers it names: a lane-written one would run outside every sandbox.
 */
const CODEX_SKILL_CONFIG = 'agents/openai.yaml';

/** A `.env*` name in any case: stricter than the file system's fold, so `.ENV` is never copied anywhere. */
const isSecretName = (name: string): boolean => name.toLowerCase().startsWith('.env');

/** What the copy may still take. */
interface Budget {
  bytes: number;
  files: number;
}

type Read =
  | { readonly files: DefinitionFile[]; readonly notes: LeftOut[] }
  | { readonly refused: string }
  | { readonly overCap: true };

function realOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function sortedEntries(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

function why(error: unknown): string {
  if (error instanceof RepoConfigFileError) return error.message;
  throw error;
}

function removedNote(what: string, dropped: readonly string[]): LeftOut[] {
  if (dropped.length === 0) return [];
  return [{ what, why: `${dropped.join(', ')} removed: a lane can write this file` }];
}

function take(budget: Budget, bytes: number): boolean {
  if (budget.files < 1 || budget.bytes < bytes) return false;
  budget.files -= 1;
  budget.bytes -= bytes;
  return true;
}

/** One command or agent file, cleaned, within the budget. */
function readDefinitionFile(
  checkout: string,
  kind: DefinitionKind,
  source: string,
  relative: string,
  budget: Budget,
): Read {
  let read;
  try {
    read = readCheckoutFile(checkout, source, PROJECT_FILE_MAX_BYTES);
  } catch (error) {
    return { refused: why(error) };
  }
  if (read === null) return { files: [], notes: [] };
  const cleaned = cleanDefinition(kind, read.bytes.toString('utf8'));
  if ('refused' in cleaned) return cleaned;
  const content = Buffer.from(cleaned.text, 'utf8');
  if (!take(budget, content.length)) return { overCap: true };
  return {
    files: [{ relative, source, content, mode: read.mode & 0o700 }],
    notes: removedNote(source, cleaned.dropped),
  };
}

/** A skill folder copied whole, its `SKILL.md` cleaned; any file it can't copy leaves the skill out. */
function readSkill(checkout: string, name: string, budget: Budget): Read {
  const root = `.claude/skills/${name}`;
  const files: DefinitionFile[] = [];
  const notes: LeftOut[] = [];
  const local: Budget = { ...budget };
  const walk = (inSkill: string): Read | null => {
    let entries: Dirent[];
    try {
      entries = sortedEntries(join(checkout, root, inSkill));
    } catch (error) {
      return { refused: `${inSkill || '.'}: it can't be listed (${String(error)})` };
    }
    for (const entry of entries) {
      const path = inSkill === '' ? entry.name : `${inSkill}/${entry.name}`;
      // A `.env*` folder is a secret as a whole, as the lane sandbox treats one.
      if (isSecretName(entry.name)) {
        notes.push({ what: `${root}/${path}`, why: SECRETS_FILE });
        continue;
      }
      if (entry.isDirectory()) {
        const failed = walk(path);
        if (failed) return failed;
        continue;
      }
      if (path.toLowerCase() === CODEX_SKILL_CONFIG) {
        notes.push({
          what: `${root}/${path}`,
          why: 'Codex reads it to install and run what it names',
        });
        continue;
      }
      let read;
      try {
        read = readCheckoutFile(checkout, `${root}/${path}`, PROJECT_FILE_MAX_BYTES);
      } catch (error) {
        return { refused: `${path}: ${why(error)}` };
      }
      if (read === null) continue;
      let content = read.bytes;
      if (path === 'SKILL.md') {
        const cleaned = cleanDefinition(DefinitionKind.Skill, content.toString('utf8'));
        if ('refused' in cleaned) return cleaned;
        content = Buffer.from(cleaned.text, 'utf8');
        notes.push(...removedNote(`${root}/SKILL.md`, cleaned.dropped));
      }
      if (!take(local, content.length)) return { overCap: true };
      files.push({
        relative: `skills/${name}/${path}`,
        source: `${root}/${path}`,
        content,
        mode: read.mode & 0o700,
      });
    }
    return null;
  };
  const failed = walk('');
  if (failed) return failed;
  if (!files.some((f) => f.relative === `skills/${name}/SKILL.md`))
    return { refused: 'no SKILL.md' };
  budget.bytes = local.bytes;
  budget.files = local.files;
  return { files, notes };
}

/** A definition dir under `.claude`, or why it can't be read: it must be the folder its spelling names. */
function definitionDir(checkout: string, kind: string): { entries: Dirent[] } | LeftOut | null {
  const spelled = join(checkout, '.claude', kind);
  const real = realOrNull(spelled);
  if (real === null) return null;
  if (real !== spelled) return { what: `.claude/${kind}`, why: 'it is a link' };
  try {
    return { entries: sortedEntries(spelled) };
  } catch {
    return null;
  }
}

/** One definition to read in order: its name in the left-out list, and how to read it. */
interface Pending {
  readonly what: string;
  readonly read: (budget: Budget) => Read;
}

function pendingDefinitions(checkout: string, leftOut: LeftOut[]): Pending[] {
  const pending: Pending[] = [];
  const skills = definitionDir(checkout, 'skills');
  if (skills && 'what' in skills) leftOut.push(skills);
  else if (skills) {
    for (const entry of skills.entries) {
      if (entry.name.startsWith('.')) continue;
      const what = `.claude/skills/${entry.name}`;
      if (entry.isSymbolicLink()) leftOut.push({ what, why: 'it is a link' });
      else if (entry.isDirectory())
        pending.push({ what, read: (budget) => readSkill(checkout, entry.name, budget) });
    }
  }
  for (const [dir, kind] of [
    ['commands', DefinitionKind.Command],
    ['agents', DefinitionKind.Agent],
  ] as const) {
    const found = definitionDir(checkout, dir);
    if (found && 'what' in found) leftOut.push(found);
    else if (found) {
      for (const entry of found.entries) {
        if (entry.name.startsWith('.') || !entry.name.endsWith('.md') || entry.isDirectory())
          continue;
        const what = `.claude/${dir}/${entry.name}`;
        pending.push({
          what,
          read: (budget) =>
            readDefinitionFile(checkout, kind, what, `${dir}/${entry.name}`, budget),
        });
      }
    }
  }
  return pending;
}

/**
 * The project's `.claude/skills/<name>/**`, `.claude/commands/*.md` and `.claude/agents/*.md`, copied with
 * lane-written power removed: no link is followed, no `.env*` file or folder is copied, each definition keeps only the
 * frontmatter its kind allows and no shell line, and past either cap the remaining definitions are left out
 * whole, unread.
 */
export function readProjectDefinitions(checkout: string): {
  files: DefinitionFile[];
  leftOut: LeftOut[];
} {
  const real = realOrNull(checkout);
  if (real === null) return { files: [], leftOut: [] };
  const files: DefinitionFile[] = [];
  const leftOut: LeftOut[] = [];
  const budget: Budget = {
    bytes: PROJECT_DEFINITIONS_MAX_BYTES,
    files: PROJECT_DEFINITIONS_MAX_FILES,
  };
  let full = false;
  for (const next of pendingDefinitions(real, leftOut)) {
    const read: Read = full ? { overCap: true } : next.read(budget);
    if ('overCap' in read) {
      full = true;
      leftOut.push({ what: next.what, why: PAST_THE_CAP });
    } else if ('refused' in read) {
      leftOut.push({ what: next.what, why: read.refused });
    } else {
      files.push(...read.files);
      leftOut.push(...read.notes);
    }
  }
  return { files, leftOut };
}
