import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { foldPathCase } from '../guard';
import { readFrontmatter, writeFrontmatter } from './frontmatter';

/**
 * Frontmatter keys of a builder's or a plugin's skill, command or agent that Claude Code acts on outside
 * 10db's guard and broker: a `hooks` hook runs once the skill is invoked and its rewrite of a call holds,
 * and `allowed-tools` lets a call skip the broker and a `!` line run unjudged (research L3c). An agent's
 * `mcpServers` would start a server 10db never launched. Compared with case, `-` and `_` folded away.
 */
const STRIPPED: ReadonlyMap<string, string> = new Map([
  ['hooks', 'hooks left out'],
  ['allowedtools', 'pre-approved tools left out'],
  ['mcpservers', 'MCP servers left out'],
]);

/** What a frontmatter 10db can't read might hide, in its raw text: a stripped key's name or an escape. */
const MIGHT_HOLD_STRIPPED = /hooks|allowed[-_\s]*tools|mcp[-_\s]*servers|\\/i;

/** Past this, a definition file is not read and is left out. */
const DEFINITION_MAX_BYTES = 256 * 1024;
/** Past this many entries, a plugin's definition folders are not walked and the plugin is left out. */
const PLUGIN_MAX_ENTRIES = 5000;
const MAX_DEPTH = 8;

const normalized = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, '');

/** A definition file the setup dir writes in place of its link: re-emitted text, or null to leave it out. */
export interface Rewrite {
  /** Under the folder being mirrored, with the names as written. */
  readonly relative: string;
  readonly text: string | null;
}

/** A definition's file re-emitted without its stripped keys, with what went; null when it needs none. */
type Stripped = { text: string; notes: string[] } | { refused: string } | null;

/** The frontmatter block's raw text, or the file's start when it has no end. */
function rawBlock(text: string): string {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (!source.startsWith('---')) return '';
  const end = source.indexOf('\n---', 3);
  return end < 0 ? source : source.slice(0, end);
}

/**
 * A definition with its stripped keys removed and every other key kept, the body as written; null when
 * it holds none. Frontmatter 10db can't read is refused when its text could spell one.
 */
export function withoutStrippedKeys(text: string): Stripped {
  const split = readFrontmatter(text);
  if ('refused' in split)
    return MIGHT_HOLD_STRIPPED.test(rawBlock(text))
      ? { refused: `${split.refused}, and it may hold hooks or pre-approved tools` }
      : null;
  const notes = [...new Set(split.pairs.flatMap(([key]) => STRIPPED.get(normalized(key)) ?? []))];
  if (notes.length === 0) return null;
  const kept = Object.fromEntries(split.pairs.filter(([key]) => !STRIPPED.has(normalized(key))));
  const written = writeFrontmatter(kept, split.body);
  return 'refused' in written ? written : { text: written.text, notes };
}

function readDefinition(path: string): Stripped {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { refused: "it can't be read" };
  }
  if (size > DEFINITION_MAX_BYTES) return { refused: 'it is past the 256 KiB 10db reads' };
  try {
    return withoutStrippedKeys(readFileSync(path, 'utf8'));
  } catch {
    return { refused: "it can't be read" };
  }
}

/** What a folder's definitions need: each file to rewrite or leave out, and a note for each. */
export interface DefinitionChanges {
  readonly rewrites: Rewrite[];
  readonly notes: { readonly where: string; readonly why: string }[];
}

function change(changes: DefinitionChanges, relative: string, stripped: Stripped): void {
  if (stripped === null) return;
  if ('refused' in stripped) {
    changes.rewrites.push({ relative, text: null });
    changes.notes.push({ where: relative, why: `left out: ${stripped.refused}` });
    return;
  }
  changes.rewrites.push({ relative, text: stripped.text });
  changes.notes.push({ where: relative, why: stripped.notes.join(', ') });
}

function entriesOf(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The entry of `dir` that Claude Code's read of `name` opens, as the file system folds names. */
function entryNamed(dir: string, name: string): string | null {
  return entriesOf(dir).find((entry) => foldPathCase(entry) === foldPathCase(name)) ?? null;
}

/** A builder's skill folder: its `SKILL.md`, re-emitted when it holds a stripped key. */
export function skillChanges(folder: string): DefinitionChanges {
  const changes: DefinitionChanges = { rewrites: [], notes: [] };
  const file = entryNamed(folder, 'SKILL.md');
  if (file !== null) change(changes, file, readDefinition(join(folder, file)));
  return changes;
}

/**
 * A plugin's carried folders (`entries`, each `[folder as written, its kind]`): each skill's `SKILL.md`
 * and every `.md` under its agents and commands, followed through links as Claude Code follows them.
 * Null when there are more entries than 10db walks.
 */
export function pluginChanges(
  installPath: string,
  entries: readonly (readonly [string, 'skills' | 'agents' | 'commands'])[],
): DefinitionChanges | null {
  const changes: DefinitionChanges = { rewrites: [], notes: [] };
  const budget = { left: PLUGIN_MAX_ENTRIES };
  const seen = new Set<string>();
  const walk = (relative: string, depth: number): boolean => {
    const path = join(installPath, relative);
    let real: string;
    try {
      real = realpathSync.native(path);
    } catch {
      return true;
    }
    // A folder link back up would never end the walk; Claude Code's own walk is not this one's to judge.
    if (seen.has(real) || depth > MAX_DEPTH) return true;
    seen.add(real);
    for (const entry of entriesOf(path)) {
      budget.left -= 1;
      if (budget.left < 0) return false;
      const inner = `${relative}/${entry}`;
      if (isFolder(join(installPath, inner))) {
        if (!walk(inner, depth + 1)) return false;
      } else if (foldPathCase(entry).endsWith('.md')) {
        change(changes, inner, readDefinition(join(installPath, inner)));
      }
    }
    return true;
  };
  for (const [entry, kind] of entries) {
    if (kind !== 'skills') {
      if (!walk(entry, 0)) return null;
      continue;
    }
    for (const skill of entriesOf(join(installPath, entry))) {
      budget.left -= 1;
      if (budget.left < 0) return null;
      const folder = join(installPath, entry, skill);
      if (!isFolder(folder)) continue;
      const file = entryNamed(folder, 'SKILL.md');
      if (file !== null)
        change(changes, `${entry}/${skill}/${file}`, readDefinition(join(folder, file)));
    }
  }
  return changes;
}

/**
 * Links `dst` to `src`, or, when a rewrite lies under it, makes `dst` a folder of links to `src`'s
 * entries with each rewritten file written in place and each left-out file missing. `relative` is
 * `src` under the folder the rewrites are relative to, `''` for that folder itself.
 */
export function linkWithRewrites(
  src: string,
  dst: string,
  relative: string,
  rewrites: readonly Rewrite[],
): void {
  const own = rewrites.find((rewrite) => rewrite.relative === relative);
  if (own !== undefined) {
    if (own.text !== null) writeFileSync(dst, own.text, { mode: 0o600 });
    return;
  }
  const prefix = relative === '' ? '' : `${relative}/`;
  if (!rewrites.some((rewrite) => rewrite.relative.startsWith(prefix))) {
    symlinkSync(src, dst);
    return;
  }
  mkdirSync(dst, { mode: 0o700 });
  for (const entry of readdirSync(src))
    linkWithRewrites(join(src, entry), join(dst, entry), `${prefix}${entry}`, rewrites);
}
