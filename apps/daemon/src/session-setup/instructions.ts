import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { readRepoConfigFile, RepoConfigFileError } from '../sessions';
import type { LeftOut } from './left-out';

/** The most instruction text 10db puts in a session's system prompt; whole files past it are left out. */
export const INSTRUCTIONS_MAX_CHARS = 64_000;

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

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A checkout file through the safe reader: no link, no FIFO or device, nothing over its cap. */
function checkoutFile(checkout: string, source: string, label: string): Candidate | null {
  try {
    const content = readRepoConfigFile(join(checkout, source));
    return content === null ? null : { label, source, content };
  } catch (error) {
    if (error instanceof RepoConfigFileError) return { source, refused: error.message };
    throw error;
  }
}

function projectCandidates(checkout: string): Candidate[] {
  const found: Candidate[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = checkoutFile(checkout, name, 'Project instructions');
    if (file) found.push(file);
  }
  const rulesSource = '.claude/rules';
  if (isLink(join(checkout, '.claude')) || isLink(join(checkout, rulesSource))) {
    found.push({ source: rulesSource, refused: 'it is a link' });
    return found;
  }
  let names: string[];
  try {
    names = readdirSync(join(checkout, rulesSource)).filter((name) => name.endsWith('.md'));
  } catch {
    return found;
  }
  for (const name of names.sort()) {
    const file = checkoutFile(checkout, `${rulesSource}/${name}`, 'Project rule');
    if (file) found.push(file);
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
  const candidates: Candidate[] = [];
  if (input.project) candidates.push(...projectCandidates(input.checkout));
  if (input.yours) {
    const yours = yoursCandidate(input.home, input.laneWritable);
    if (yours) candidates.push(yours);
  }
  const sections: string[] = [];
  const sources: string[] = [];
  const leftOut: LeftOut[] = [];
  let length = PRECEDENCE_LINE.length;
  let full = false;
  for (const candidate of candidates) {
    if ('refused' in candidate) {
      leftOut.push({ what: candidate.source, why: candidate.refused });
      continue;
    }
    const section = `## ${candidate.label} (${candidate.source})\n\n${candidate.content.trimEnd()}`;
    full ||= length + 2 + section.length > INSTRUCTIONS_MAX_CHARS;
    if (full) {
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
