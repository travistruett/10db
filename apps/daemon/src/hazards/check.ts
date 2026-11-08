import {
  AreaName,
  HazardEntryKind,
  PathPattern,
  type HazardAdditionDraft,
  type HazardAdditionDto,
  type HazardDef,
  type HazardEvidence,
  type HazardRemoval,
} from '@10db/contracts';
import { z } from 'zod';
import { modelJson, oneLine } from '../folders';
import { classifyPath } from '../guard';

/** The most additions and removals taken from one answer. */
const MAX_ENTRIES = 40;
/** The longest reason shown, in characters. */
const MAX_REASON = 200;
/** The longest command prefix, in characters and in words. */
const MAX_COMMAND = 120;
const MAX_COMMAND_WORDS = 6;
/** A glob that holds more than this share of a repository's files cannot be one task at a time. */
const MAX_SHARE = 0.5;
/** Below this many tracked files the share rule says nothing. */
const SHARE_FROM = 20;

/**
 * Words and parts of words that make a command a look and not a change: it reads, so a hazard claim
 * would only hold other tasks up. `make gate` and `makemigrations --check` are the cases that matter.
 */
const READ_ONLY: ReadonlySet<string> = new Set([
  'check',
  'checks',
  'test',
  'tests',
  'lint',
  'gate',
  'verify',
  'status',
  'show',
  'plan',
  'diff',
  'format',
  'fmt',
  'typecheck',
  'precheck',
  'ci',
  'help',
  'version',
  'list',
  'doctor',
  'audit',
  'outdated',
  'info',
  'view',
  'why',
]);

/** Programs and subcommands that name no change by themselves. */
const WRAPPERS: ReadonlySet<string> = new Set([
  'make',
  'just',
  'task',
  'python',
  'python3',
  'py',
  'node',
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'uv',
  'docker',
  'compose',
  'run',
  'exec',
  'sh',
  'bash',
  'zsh',
]);

/** Programs that are never a hazard's command. */
const NEVER: ReadonlySet<string> = new Set([
  'git',
  'rm',
  'cd',
  'ls',
  'cat',
  'echo',
  'curl',
  'wget',
  'sudo',
  'ssh',
  'sh',
  'bash',
  'zsh',
  'eval',
]);

const WORD = /^[A-Za-z0-9_][A-Za-z0-9_./:@+%-]*$/u;

const Proposal = z.object({
  hazard: z.string(),
  kind: z.enum([HazardEntryKind.Glob, HazardEntryKind.Command]),
  value: z.string(),
  reason: z.string().default(''),
  file: z.string().default(''),
  line: z.int().min(1).optional(),
});
const Reply = z.object({
  additions: z.array(Proposal).default([]),
  removals: z.array(Proposal).default([]),
});

export interface CheckInput {
  /** The tracked files of the commit read. */
  readonly tracked: readonly string[];
  /** The lines of each file the model was given, by path. */
  readonly lines: ReadonlyMap<string, readonly string[]>;
  /** The project's hazards now. */
  readonly hazards: readonly HazardDef[];
  readonly areaNames: readonly string[];
  /** The project's gate commands: a check, never a hazard. */
  readonly gateCommands: readonly string[];
  /** Entries the builder kept after a removal card listed them. */
  readonly kept: readonly { hazard: string; kind: string; value: string }[];
  /** Entries the builder took out (Undo, an agreed removal, or by hand): never proposed again. */
  readonly declined: readonly { hazard: string; kind: string; value: string }[];
}

export interface CheckedAssessment {
  readonly additions: HazardAdditionDraft[];
  readonly removals: HazardRemoval[];
}

const words = (text: string): string[] =>
  text
    .trim()
    .split(/\s+/u)
    .filter((w) => w !== '');

function startsWithWords(longer: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= longer.length && prefix.every((w, i) => longer[i] === w);
}

/** What is wrong with `value` as a command prefix, or null when it is a command that changes things. */
export function commandProblem(value: string, gateCommands: readonly string[]): string | null {
  if (value.length > MAX_COMMAND) return 'too long';
  const parts = words(value);
  if (parts.length === 0 || parts.length > MAX_COMMAND_WORDS) return 'not a short command';
  if (!parts.every((w) => WORD.test(w))) return 'has more than plain words';
  // The guard drops flags before it compares, so a flag in a prefix could never match.
  if (parts.some((w) => w.startsWith('-'))) return 'has a flag';
  if (NEVER.has(parts[0] ?? '')) return 'not a command that changes files';
  if (parts.every((w) => WRAPPERS.has(w))) return 'names no change';
  for (const part of parts)
    for (const token of part.split(/[-_:./]+/u))
      if (READ_ONLY.has(token.toLowerCase())) return 'only reads';
  for (const gate of gateCommands) {
    const gateWords = words(gate);
    if (startsWithWords(parts, gateWords) || startsWithWords(gateWords, parts)) return 'the gate';
  }
  return null;
}

/** Whether `glob` is a pattern a hazard may hold, before it is tried on the tracked files. */
function globProblem(glob: string): string | null {
  if (!PathPattern.safeParse(glob).success) return 'not a path pattern';
  // A pattern of only wildcards names no file.
  if (glob.replace(/[*?/.]/gu, '').length < 3) return 'names no file';
  return null;
}

/** The tracked files `glob` holds, as a hazard's glob holds them. */
function matches(glob: string, tracked: readonly string[]): string[] {
  const hazard: HazardDef = { name: 'probe', globs: [glob], commands: [] };
  return tracked.filter((path) => classifyPath(path, [], [hazard]).hazards.length > 0);
}

/** The last word of a command, the target or script or subcommand that must be on its evidence line. */
const lastWord = (value: string): string => words(value).at(-1) ?? value;

function holds(hazard: HazardDef | undefined, kind: string, value: string): boolean {
  if (hazard === undefined) return false;
  return (kind === HazardEntryKind.Glob ? hazard.globs : hazard.commands).includes(value);
}

function evidenceOf(
  file: string,
  line: number | undefined,
  input: CheckInput,
): HazardEvidence | null {
  if (!input.tracked.includes(file)) return null;
  const text = input.lines.get(file);
  if (line === undefined) return { file };
  if (text === undefined || line > text.length) return null;
  return { file, line };
}

function cleanReason(text: string): string {
  return oneLine(text, MAX_REASON);
}

/**
 * What a model's answer is worth: additions and removals that pass every check in code, nothing
 * else. A command must be a short run of plain words that changes files (no flag, not a check, not
 * the gate), and the line it cites must be in a file the model was given and name the command's last
 * word. A glob must be a valid pattern that holds some tracked file and not most of them; its
 * evidence is a tracked file it holds, whatever the model cited. A removal must name something the
 * hazard holds now and cite a tracked file. Null when the answer is not the agreed JSON.
 */
export function checkAssessment(text: string, input: CheckInput): CheckedAssessment | null {
  const parsed = Reply.safeParse(modelJson(text));
  if (!parsed.success) return null;
  const additions: HazardAdditionDraft[] = [];
  for (const proposal of parsed.data.additions.slice(0, MAX_ENTRIES)) {
    if (!AreaName.safeParse(proposal.hazard).success) continue;
    if (input.areaNames.includes(proposal.hazard)) continue;
    const hazard = input.hazards.find((h) => h.name === proposal.hazard);
    const value =
      proposal.kind === HazardEntryKind.Command
        ? words(proposal.value).join(' ')
        : proposal.value.trim();
    if (holds(hazard, proposal.kind, value)) continue;
    if (
      additions.some(
        (a) => a.hazard === proposal.hazard && a.kind === proposal.kind && a.value === value,
      )
    )
      continue;
    if (
      [...input.kept, ...input.declined].some(
        (k) => k.hazard === proposal.hazard && k.kind === proposal.kind && k.value === value,
      )
    )
      continue;
    const reason = cleanReason(proposal.reason);
    if (reason === '') continue;
    if (proposal.kind === HazardEntryKind.Command) {
      if (commandProblem(value, input.gateCommands) !== null) continue;
      // A command is proven by a line that names it.
      if (proposal.line === undefined) continue;
      const evidence = evidenceOf(proposal.file, proposal.line, input);
      const line =
        evidence === null ? undefined : input.lines.get(evidence.file)?.[proposal.line - 1];
      if (evidence === null || line?.includes(lastWord(value)) !== true) continue;
      additions.push({ hazard: proposal.hazard, kind: proposal.kind, value, reason, evidence });
    } else {
      if (globProblem(value) !== null) continue;
      const held = matches(value, input.tracked);
      const [first] = held;
      if (first === undefined) continue;
      if (input.tracked.length > SHARE_FROM && held.length / input.tracked.length > MAX_SHARE)
        continue;
      additions.push({
        hazard: proposal.hazard,
        kind: proposal.kind,
        value,
        reason,
        evidence: { file: first },
      });
    }
  }
  const removals: HazardRemoval[] = [];
  for (const proposal of parsed.data.removals.slice(0, MAX_ENTRIES)) {
    const hazard = input.hazards.find((h) => h.name === proposal.hazard);
    if (!holds(hazard, proposal.kind, proposal.value)) continue;
    if (
      input.kept.some(
        (k) =>
          k.hazard === proposal.hazard && k.kind === proposal.kind && k.value === proposal.value,
      )
    )
      continue;
    const evidence = evidenceOf(proposal.file, proposal.line, input);
    const reason = cleanReason(proposal.reason);
    if (evidence === null || reason === '') continue;
    if (
      removals.some(
        (r) =>
          r.hazard === proposal.hazard && r.kind === proposal.kind && r.value === proposal.value,
      )
    )
      continue;
    removals.push({
      hazard: proposal.hazard,
      kind: proposal.kind,
      value: proposal.value,
      reason,
      evidence,
    });
  }
  return { additions, removals };
}

/**
 * The additions 10db made earlier whose evidence is gone from the commit now read: a command whose
 * line no longer names it, or a glob that holds no tracked file. These are proposed for removal, not
 * removed, and come from the repository itself with no model in between.
 */
export function staleAdditions(
  additions: readonly HazardAdditionDto[],
  input: CheckInput,
): HazardRemoval[] {
  const stale: HazardRemoval[] = [];
  for (const addition of additions) {
    const { file } = addition.evidence;
    let reason: string | null = null;
    if (addition.kind === HazardEntryKind.Glob) {
      if (matches(addition.value, input.tracked).length === 0)
        reason = `No tracked file matches ${addition.value} any more.`;
    } else if (!input.tracked.includes(file)) {
      reason = `${file} is no longer in the repository.`;
    } else {
      // A file that was not read says nothing; one that was read names the command anywhere, since lines move.
      const text = input.lines.get(file);
      if (text !== undefined && !text.some((l) => l.includes(lastWord(addition.value))))
        reason = `${file} no longer names ${lastWord(addition.value)}.`;
    }
    if (reason !== null)
      stale.push({
        hazard: addition.hazard,
        kind: addition.kind,
        value: addition.value,
        reason,
        evidence: addition.evidence,
      });
  }
  return stale;
}
