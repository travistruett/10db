import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import { ClaimKind, Delivery, type AreaDef, type HazardDef } from '@10db/contracts';
import { z } from 'zod';
import {
  changedDirectory,
  envDumpRefusal,
  isOwnToolResult,
  keychainRefusal,
  pathRefusal,
  scriptRefusal,
  secretReferenceRefusal,
  segmentPathRefusal,
  type ProtectedPath,
} from './account-rules';
import { commandForms, startsWithWords } from './command-forms';
import { ghVerdict } from './gh-rules';
import { gitVerdict } from './git-rules';
import { classifyPath, resolveInRepo } from './paths';
import { readOnlyShellRefusal } from './read-only';
import {
  findExecCommands,
  leadingWords,
  parseShell,
  runsEnvSplitString,
  stripCommandPrefixes,
  type ShellSegment,
} from './shell-words';

export interface GuardInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly repoPath: string;
  readonly areas: readonly AreaDef[];
  readonly hazards: readonly HazardDef[];
  readonly claims: readonly { readonly kind: ClaimKind; readonly name: string }[];
  /** A read-only step: file writes and writing shell commands are refused, claims or not. */
  readonly readOnly: boolean;
  /** The project's delivery; absent means local. In pull-request projects only the daemon pushes. */
  readonly delivery?: Delivery;
  /** Paths no tool or command may touch: the data directory and the default account's sign-in. */
  readonly protectedPaths: readonly ProtectedPath[];
  /**
   * The session's own config directory and Claude Code session id. Claude Code saves a large tool
   * output under `<configDir>/projects/*\/<id>/tool-results/` and points the model at it, so Read and
   * Grep may open that directory.
   */
  readonly ownSession?: { readonly configDir: string; readonly providerSessionId: string | null };
}

export type GuardVerdict =
  { readonly decision: 'allow' } | { readonly decision: 'deny'; readonly reason: string };

const ALLOW: GuardVerdict = { decision: 'allow' };
const deny = (reason: string): GuardVerdict => ({ decision: 'deny', reason });

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DEPLOY = [
  /^(vercel|netlify)\b.*(\bdeploy|--prod)\b/,
  /^fly (deploy|launch)\b/,
  /^kubectl (apply|delete|rollout)\b/,
  /^terraform (apply|destroy)\b/,
  /^(npm|pnpm|yarn) publish\b/,
  /^cargo publish\b/,
  /^gh release create\b/,
];
const SHELLS = new Set(['sh', 'bash', 'zsh']);
const ToolInput = z.record(z.string(), z.unknown());

/** Reads a string field from a tool's input, which arrives as untyped JSON. */
export function stringField(input: unknown, key: string): string | null {
  const parsed = ToolInput.safeParse(input);
  if (!parsed.success) return null;
  const value = parsed.data[key];
  return typeof value === 'string' ? value : null;
}

function claimed(input: GuardInput, kind: ClaimKind, name: string): boolean {
  return input.claims.some((c) => c.kind === kind && c.name === name);
}

function judgeFile(input: GuardInput, filePath: string): GuardVerdict {
  const where = resolveInRepo(input.repoPath, filePath);
  if (!where.inside)
    return deny(`${filePath} is outside the repository. Edit files inside ${input.repoPath} only.`);
  const hit = classifyPath(where.rel, input.areas, input.hazards);
  const missingHazard = hit.hazards.find((h) => !claimed(input, ClaimKind.Hazard, h));
  if (missingHazard) {
    return deny(
      `${where.rel} is in the "${missingHazard}" hazard. Call the request_claim tool with kind "hazard" and name "${missingHazard}" first.`,
    );
  }
  if (hit.hazards.length > 0) return ALLOW;
  if (hit.areas.some((a) => claimed(input, ClaimKind.Area, a))) return ALLOW;
  const which = hit.areas.length > 0 ? `area "${hit.areas.join('", "')}"` : 'no area';
  return deny(
    `${where.rel} is outside your claims (it is in ${which}). Call the request_claim tool for the area you need.`,
  );
}

function isRecursiveRm(words: readonly string[]): boolean {
  return words.some((w) => w === '--recursive' || /^-[a-zA-Z]*[rR]/.test(w));
}

function rmVerdict(
  input: GuardInput,
  words: readonly string[],
  afterCd: boolean,
): GuardVerdict | null {
  if (!isRecursiveRm(words)) return null;
  if (afterCd)
    return deny('rm -r after cd is not allowed: the working directory is not the repository.');
  for (const arg of words.slice(1).filter((w) => !w.startsWith('-'))) {
    if (arg.includes('$')) return deny(`rm -r of ${arg} uses a variable the guard cannot resolve.`);
    if (arg.split('/').includes('.git')) return deny('rm -r of a .git path is never allowed.');
    const expanded = arg.startsWith('~') ? arg.replace(/^~/, homedir()) : arg;
    const where = resolveInRepo(
      input.repoPath,
      isAbsolute(expanded) ? expanded : resolve(input.repoPath, expanded),
    );
    if (!where.inside)
      return deny(`rm -r of ${arg} reaches outside the repository (or is the repository itself).`);
    if (where.rel.split(sep).includes('.git'))
      return deny('rm -r of a .git path is never allowed.');
  }
  return null;
}

const shellQuote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

const SHELL_C_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;

/** The scripts a shell's words hand it: a `-c` argument and a `<<<` here-string. */
function shellScripts(words: readonly string[]): string[] {
  const flag = words.findIndex((w) => SHELL_C_FLAG.test(w));
  const here = words.findIndex((w) => w.startsWith('<<<'));
  const hereWord = words[here];
  return [
    ...(flag === -1 ? [] : words.slice(flag + 1, flag + 2)),
    ...(hereWord === undefined
      ? []
      : hereWord === '<<<'
        ? words.slice(here + 1, here + 2)
        : [hereWord.slice(3)]),
  ];
}

/** A directory a command may run in; null when the guard cannot name it (`cd "$DIR"`). */
type Dir = string | null;
const union = (...lists: readonly (readonly Dir[])[]): Dir[] => [...new Set(lists.flat())];
const DIRECTORY_CHANGES: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd']);

/** The command a segment runs, past reserved words, assignments and wrappers. */
function commandOf(segment: ShellSegment): {
  readonly words: string[];
  readonly negated: boolean;
  readonly outOfOrder: boolean;
  /** env runs a split string, a command the guard cannot see. */
  readonly splitString: boolean;
} {
  const leading = leadingWords(segment.words);
  return {
    words: stripCommandPrefixes(leading.command, { lookThroughRunners: true }),
    negated: leading.negated,
    outOfOrder: leading.outOfOrder,
    splitString: runsEnvSplitString(leading.command),
  };
}

/**
 * Every directory a `cd` in the segments names, in an `eval` or a nested script too; a relative one
 * is unknown.
 */
function directoriesNamed(segments: readonly ShellSegment[]): Dir[] {
  return segments.flatMap((segment) => {
    const { words } = commandOf(segment);
    const head = words[0] ?? '';
    const scripts =
      head === 'eval' ? [words.slice(1).join(' '), ...segment.nested] : segment.nested;
    const own = DIRECTORY_CHANGES.has(head) ? [changedDirectory(segment.raw, words, null)] : [];
    return [...own, ...scripts.flatMap((script) => directoriesNamed(parseShell(script).segments))];
  });
}

function firstRefusal(dirs: readonly Dir[], refusal: (dir: Dir) => string | null): string | null {
  for (const dir of dirs) {
    const found = refusal(dir);
    if (found) return found;
  }
  return null;
}

/**
 * Judges a command run from any of the `start` directories. Each segment is checked from every
 * directory it may run in. In order, that is where the `cd`s before it may have left the shell: a
 * `cd` that fails or is skipped leaves it where it was, so only a command joined to a `cd` by `&&`
 * runs in its target alone, and a subshell's `cd`s end at its `)`. When the order is not certain (a
 * loop, a function, a parenthesis that is not a subshell), every segment may run from the start or
 * any directory a `cd` in the command names.
 */
function judgeShell(
  input: GuardInput,
  command: string,
  depth = 0,
  start: readonly Dir[] = [input.repoPath],
): GuardVerdict {
  const parse = parseShell(command);
  const segments = parse.segments.map((segment) => ({ segment, ...commandOf(segment) }));
  const ordered = parse.certain && !segments.some((s) => s.outOfOrder);
  const named = ordered ? [] : directoriesNamed(parse.segments);
  const anywhere = union(start, named);
  let afterCd = named.length > 0;
  let dirs: Dir[] = [...start];
  // Every directory the shell may be in by now.
  let possible: Dir[] = [...start];
  // Where a segment after `&&` runs: set by a `cd` or an `eval` that may move the shell.
  let chained: Dir[] | null = null;
  // The subshells the previous segment ran in, each with what was possible outside it.
  const subshells: { readonly id: number; readonly possible: Dir[] }[] = [];
  let previousSeparator = '';
  for (const { segment, words, negated, splitString } of segments) {
    if (ordered) {
      let left = false;
      while (
        subshells.length > 0 &&
        segment.subshells[subshells.length - 1] !== subshells[subshells.length - 1]?.id
      ) {
        possible = subshells.pop()?.possible ?? possible;
        left = true;
      }
      // The operator after a `)` is not kept, so a segment after a subshell may run anywhere possible.
      dirs = !left && previousSeparator === '&&' ? (chained ?? dirs) : possible;
      for (const id of segment.subshells.slice(subshells.length)) {
        subshells.push({ id, possible });
        possible = [...dirs];
      }
    } else {
      dirs = anywhere;
    }
    chained = null;
    const head = words[0] ?? '';
    const piped = previousSeparator === '|';
    previousSeparator = segment.separator;
    if (head === 'sudo') return deny('sudo is never allowed.');
    if (splitString)
      return deny('env -S runs a command the guard cannot read. Run the command itself instead.');
    // Substitutions and here-documents run where the segment runs.
    for (const body of segment.nested) {
      const verdict = judgeShell(input, body, depth, dirs);
      if (verdict.decision === 'deny') return verdict;
    }
    const accountRule =
      keychainRefusal(words) ??
      envDumpRefusal(segment.words, words) ??
      secretReferenceRefusal(segment.raw) ??
      scriptRefusal(head, [segment.raw, ...segment.nested].join('\n')) ??
      firstRefusal(dirs, (dir) =>
        segmentPathRefusal(segment.raw, words, dir, input.protectedPaths, segment.nested),
      );
    if (accountRule) return deny(accountRule);
    if (SHELLS.has(head)) {
      if (piped) return deny('Piping into a shell runs commands the guard cannot see.');
      for (const inner of shellScripts(words)) {
        if (depth >= 3) break;
        const verdict = judgeShell(input, inner, depth + 1, dirs);
        if (verdict.decision === 'deny') return verdict;
      }
    }
    if (head === 'find' && depth < 3) {
      for (const exec of findExecCommands(words)) {
        const verdict = judgeShell(input, exec.map(shellQuote).join(' '), depth + 1, dirs);
        if (verdict.decision === 'deny') return verdict;
      }
    }
    if (head === 'eval' && depth < 3) {
      const script = words.slice(1).join(' ');
      const verdict = judgeShell(input, script, depth + 1, dirs);
      if (verdict.decision === 'deny') return verdict;
      // eval runs in this shell, so a `cd` in it moves this shell.
      const moved = directoriesNamed(parseShell(script).segments);
      if (moved.length > 0) {
        afterCd = true;
        possible = union(possible, moved);
        chained = union(dirs, moved);
      }
    }
    if (head === 'git') {
      const verdict = gitVerdict(words, input.delivery ?? Delivery.Local);
      if (verdict) return deny(verdict.deny);
    }
    if (head === 'gh') {
      const verdict = ghVerdict(words);
      if (verdict) return deny(verdict.deny);
    }
    if (head === 'rm') {
      const verdict = rmVerdict(input, words, afterCd);
      if (verdict) return verdict;
    }
    if (DIRECTORY_CHANGES.has(head)) {
      afterCd = true;
      const moved = union(dirs.map((dir) => changedDirectory(segment.raw, words, dir)));
      possible = union(possible, moved);
      // After `! cd`, what follows `&&` runs when the cd failed.
      chained = negated ? union(dirs, moved) : moved;
    }
    const forms = commandForms(words);
    if (DEPLOY.some((re) => forms.lines.some((l) => re.test(l))))
      return deny('Deploy and publish commands are never run by agents.');
    const line = words.join(' ');
    for (const hazard of input.hazards) {
      if (
        hazard.commands.some((c) => forms.bare.some((f) => startsWithWords(f, c.split(' ')))) &&
        !claimed(input, ClaimKind.Hazard, hazard.name)
      ) {
        return deny(
          `"${line}" needs the "${hazard.name}" hazard claim. Call request_claim with kind "hazard" and name "${hazard.name}" first.`,
        );
      }
    }
  }
  return ALLOW;
}

/** Tools a read-only step may call besides Bash and the 10db MCP server's own tools. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'TodoWrite',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'Skill',
  'BashOutput',
  'KillShell',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);
const READ_ONLY_REFUSAL =
  'This step is read-only. Describe the change in mcp__10db__complete_step; the implement step makes it.';

/** The PreToolUse decision for a managed session (spec §8.2). Rules only; never an LLM. */
export function judgeToolUse(input: GuardInput): GuardVerdict {
  // Every tool, in every step kind: no path under the data directory or the default sign-in.
  const searches = input.toolName === 'Grep' || input.toolName === 'Glob';
  const base = resolve(input.repoPath, stringField(input.toolInput, 'path') ?? '.');
  for (const field of ['file_path', 'notebook_path', 'path', 'pattern'] as const) {
    // Grep's pattern is a regular expression, not a path; Glob's is a path pattern under `path`.
    if (field === 'pattern' && input.toolName !== 'Glob') continue;
    const value = stringField(input.toolInput, field);
    if (value === null) continue;
    const own =
      (input.toolName === 'Read' || input.toolName === 'Grep') &&
      input.ownSession !== undefined &&
      isOwnToolResult(input.ownSession, value, input.repoPath);
    if (own) continue;
    const refusal = pathRefusal(
      value,
      field === 'pattern' ? base : input.repoPath,
      input.protectedPaths,
      {
        contains: searches && (field === 'path' || field === 'pattern'),
      },
    );
    if (refusal) return deny(refusal);
  }
  if (FILE_TOOLS.has(input.toolName)) {
    if (input.readOnly) return deny(READ_ONLY_REFUSAL);
    const filePath =
      stringField(input.toolInput, 'file_path') ?? stringField(input.toolInput, 'notebook_path');
    return filePath === null ? ALLOW : judgeFile(input, filePath);
  }
  if (input.toolName === 'Bash') {
    const command = stringField(input.toolInput, 'command');
    if (command === null) return ALLOW;
    if (input.readOnly) {
      const refusal = readOnlyShellRefusal(command);
      if (refusal) return deny(refusal);
    }
    return judgeShell(input, command);
  }
  if (
    input.readOnly &&
    !READ_ONLY_TOOLS.has(input.toolName) &&
    !input.toolName.startsWith('mcp__10db__')
  )
    return deny(READ_ONLY_REFUSAL);
  return ALLOW;
}
