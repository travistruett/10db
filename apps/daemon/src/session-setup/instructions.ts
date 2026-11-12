import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { readRepoConfigFile, RepoConfigFileError, REPO_CONFIG_MAX_BYTES } from '../sessions';
import { readCheckoutFile } from './checkout-file';
import type { LeftOut } from './left-out';

/** The most instruction text 10db puts in a session's system prompt; whole files past it are left out. */
export const INSTRUCTIONS_MAX_CHARS = 64_000;

/** The most `.claude/rules` files considered, by name; the rest are listed unread. */
export const INSTRUCTIONS_MAX_RULES = 100;

/**
 * Coordination outranks project text: a project's or the builder's file never overrides 10db's own rules
 * for the session.
 */
const PRECEDENCE_LINE =
  "These are the project's and the builder's own instructions, which Claude Code would load itself. " +
  "Follow them, except where 10db's brief for this session says otherwise: 10db's rules on commits, " +
  'pushes, claims and the gate come first.';

const OVER_THE_CAP = 'over the size 10db puts in a system prompt';
const YOURS = '~/.claude/CLAUDE.md';

export interface Instructions {
  /** One text for the system prompt, or null when nothing was read. */
  readonly text: string | null;
  /** The files the text holds, in order: checkout-relative, or `~/.claude/CLAUDE.md`. */
  readonly sources: readonly string[];
  readonly leftOut: readonly LeftOut[];
}

interface InstructionsInput {
  readonly checkout: string;
  readonly home: string;
  /** The project's `AGENTS.md`, `CLAUDE.md` and `.claude/rules/*.md`. */
  readonly project: boolean;
  /** The builder's `~/.claude/CLAUDE.md`. */
  readonly yours: boolean;
  /** Every root a lane can write; the builder's file may not lead into one. */
  readonly laneWritable: readonly string[];
}

type Candidate =
  | { readonly label: string; readonly source: string; readonly content: string }
  | { readonly source: string; readonly refused: string };

/** A source in order, read only when the text still has room for it. */
interface Pending {
  readonly source: string;
  readonly load: () => Candidate | null;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function isAtOrUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** A checkout file through the safe reader, inside the checkout's real path only. */
function checkoutFile(checkoutReal: string, source: string, label: string): Pending {
  return {
    source,
    load: () => {
      try {
        const read = readCheckoutFile(checkoutReal, source, REPO_CONFIG_MAX_BYTES);
        return read === null ? null : { label, source, content: read.bytes.toString('utf8') };
      } catch (error) {
        if (error instanceof RepoConfigFileError) return { source, refused: error.message };
        throw error;
      }
    },
  };
}

function refused(source: string, why: string): Pending {
  return { source, load: () => ({ source, refused: why }) };
}

function projectSources(checkout: string): Pending[] {
  const checkoutReal = realOrSelf(checkout);
  const found = ['AGENTS.md', 'CLAUDE.md'].map((name) =>
    checkoutFile(checkoutReal, name, 'Project instructions'),
  );
  const rulesSource = '.claude/rules';
  const rules = join(checkoutReal, rulesSource);
  let names: string[];
  try {
    if (realpathSync.native(rules) !== rules)
      return [...found, refused(rulesSource, 'it is a link')];
    names = readdirSync(rules).filter((name) => name.endsWith('.md'));
  } catch {
    return found;
  }
  names.sort();
  for (const [index, name] of names.entries()) {
    const source = `${rulesSource}/${name}`;
    found.push(
      index < INSTRUCTIONS_MAX_RULES
        ? checkoutFile(checkoutReal, source, 'Project rule')
        : refused(source, `past the ${String(INSTRUCTIONS_MAX_RULES)} rule files 10db reads`),
    );
  }
  return found;
}

/** The builder's own file, which may be a link into a dotfiles folder but never into lane-writable ground. */
function yoursCandidate(home: string, laneWritable: readonly string[]): Candidate | null {
  const path = join(home, '.claude', 'CLAUDE.md');
  try {
    lstatSync(path);
  } catch {
    return null;
  }
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    return { source: YOURS, refused: 'it leads nowhere' };
  }
  if (laneWritable.some((root) => isAtOrUnder(real, realOrSelf(root))))
    return { source: YOURS, refused: 'it leads into a folder a lane can write' };
  try {
    const content = readRepoConfigFile(real);
    return content === null
      ? { source: YOURS, refused: 'it leads nowhere' }
      : { label: 'Your instructions', source: YOURS, content };
  } catch (error) {
    if (error instanceof RepoConfigFileError) return { source: YOURS, refused: error.message };
    throw error;
  }
}

/**
 * The project's and the builder's instructions as one text, in the order Claude Code would read them.
 * `@path` imports are not expanded, and a rule's `paths:` frontmatter does not filter it.
 */
export function readInstructions(input: InstructionsInput): Instructions {
  const pending: Pending[] = [];
  if (input.project) pending.push(...projectSources(input.checkout));
  if (input.yours)
    pending.push({ source: YOURS, load: () => yoursCandidate(input.home, input.laneWritable) });
  const sections: string[] = [];
  const sources: string[] = [];
  const leftOut: LeftOut[] = [];
  let length = PRECEDENCE_LINE.length;
  let full = false;
  for (const next of pending) {
    if (full) {
      leftOut.push({ what: next.source, why: OVER_THE_CAP });
      continue;
    }
    const candidate = next.load();
    if (candidate === null) continue;
    if ('refused' in candidate) {
      leftOut.push({ what: candidate.source, why: candidate.refused });
      continue;
    }
    const section = `## ${candidate.label} (${candidate.source})\n\n${candidate.content.trimEnd()}`;
    if (length + 2 + section.length > INSTRUCTIONS_MAX_CHARS) {
      full = true;
      leftOut.push({ what: candidate.source, why: OVER_THE_CAP });
      continue;
    }
    length += 2 + section.length;
    sections.push(section);
    sources.push(candidate.source);
  }
  const text = sections.length === 0 ? null : [PRECEDENCE_LINE, ...sections].join('\n\n');
  return { text, sources, leftOut };
}
