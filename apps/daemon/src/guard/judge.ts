import { lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { ClaimKind, type AreaDef, type Delivery, type HazardDef } from '@10db/contracts';
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
import {
  classifyPath,
  foldPathCase,
  isOverLongPath,
  OVER_LONG_PATH_REFUSAL,
  realPathOf,
  resolveInRepoReadings,
} from './paths';
import { readOnlyShellRefusal } from './read-only';
import {
  commandName,
  findExecCommands,
  leadingWords,
  parseShell,
  hidesEnvCommand,
  redirectionSpan,
  redirectionHidesCommand,
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
  /** Present for a sandboxed lane: refuses reads and writes by the real path they name. */
  readonly fileAccess?: FileAccessJudge;
}

/**
 * Judges the real paths a file tool names. The guard takes it as a function so it need not import
 * the module that knows the sandbox's read policy.
 */
export interface FileAccessJudge {
  read(toolName: string, input: unknown): 'ok' | { refuse: string };
  write(path: string): 'ok' | { refuse: string };
  /** Why a read of these paths needs a person (outside what lanes may read), or null. */
  readAsk(toolName: string, input: unknown): string | null;
  /** Why a write to this path needs a person (a Claude Code config path), or null. */
  writeAsk(path: string): string | null;
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
const PATH_READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
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

function judgeRelative(input: GuardInput, rel: string): GuardVerdict {
  const hit = classifyPath(rel, input.areas, input.hazards);
  const missingHazard = hit.hazards.find((h) => !claimed(input, ClaimKind.Hazard, h));
  if (missingHazard) {
    return deny(
      `${rel} is in the "${missingHazard}" hazard. Call the request_claim tool with kind "hazard" and name "${missingHazard}" first.`,
    );
  }
  if (hit.hazards.length > 0) return ALLOW;
  if (hit.areas.some((a) => claimed(input, ClaimKind.Area, a))) return ALLOW;
  const which = hit.areas.length > 0 ? `area "${hit.areas.join('", "')}"` : 'no area';
  return deny(
    `${rel} is outside your claims (it is in ${which}). Call the request_claim tool for the area you need.`,
  );
}

/** Every reading of the path (as the kernel opens it, and with `..` collapsed) must be allowed. */
function judgeFile(input: GuardInput, filePath: string): GuardVerdict {
  if (isOverLongPath(filePath)) return deny(OVER_LONG_PATH_REFUSAL);
  const where = resolveInRepoReadings(input.repoPath, filePath);
  if (!where.inside)
    return deny(`${filePath} is outside the repository. Edit files inside ${input.repoPath} only.`);
  for (const rel of where.rels) {
    const verdict = judgeRelative(input, rel);
    if (verdict.decision === 'deny') return verdict;
  }
  return ALLOW;
}

function isRecursiveRm(words: readonly string[]): boolean {
  return words.some((w) => w === '--recursive' || /^-[a-zA-Z]*[rR]/.test(w));
}

/** A plain path: these characters only, after an optional `~` or `~/` at the very start. */
const PLAIN_PATH = /^(?:~(?=\/|$))?[A-Za-z0-9_\-./@+%,:]*$/;
/**
 * A last segment with wildcards: no leading `.`, no character but these and `*` and `?`, and no two
 * `*` side by side, which zsh's `globstarshort` turns into a walk that follows links.
 */
const WILDCARD_SEGMENT = /^(?!.*\*\*)[A-Za-z0-9_\-*?][A-Za-z0-9_\-.*?]*$/;
const MAX_WILDCARDS = 4;
/**
 * A redirection or here-document anywhere in the segment, or a quoted word that looks like one:
 * which words it takes as its target cannot be told apart from the paths rm removes.
 */
const REDIRECTION = /[<>]/;
const UNREAD_WORDS =
  "The command has words the guard cannot read: an ANSI-C escape it does not decode (such as $'\\q' or a NUL), a / or newline decoded inside a word, or a lone { or } in the middle of a command. Write the words plainly.";
const HIDDEN_BY_REDIRECTION =
  "A redirection among a wrapper's words, or one the guard does not recognize, hides which command runs. Put redirections after the command.";
const UNJUDGED_RM = 'rm -r argument uses shell syntax the guard does not judge; name the paths.';

function hasGitPart(path: string): boolean {
  return path.split(sep).some((part) => foldPathCase(part) === '.git');
}

function expandTilde(path: string): string {
  return path.startsWith('~') ? path.replace(/^~/, homedir()) : path;
}

/**
 * Judges one plain path an `rm -r` of `arg` would remove: it must be inside the repository and not
 * `.git`, on every reading. Its repo-relative readings when it passes.
 */
function rmPath(
  input: GuardInput,
  arg: string,
  path: string,
): { verdict: GuardVerdict } | { rels: string[] } {
  if (hasGitPart(path)) return { verdict: deny('rm -r of a .git path is never allowed.') };
  const where = resolveInRepoReadings(input.repoPath, path);
  if (!where.inside)
    return {
      verdict: deny(
        `rm -r of ${arg} reaches outside the repository (or is the repository itself).`,
      ),
    };
  if (where.rels.some(hasGitPart))
    return { verdict: deny('rm -r of a .git path is never allowed.') };
  return { rels: where.rels };
}

function holdsGit(directory: string): boolean {
  try {
    lstatSync(join(directory, '.git'));
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Judges a plain directory followed by one wildcard segment (`dist/*`, `build/*.o`). Nothing is
 * listed or matched: the directory must be inside the repository and hold no `.git` entry, since
 * `dotglob` or `GLOB_DOTS` set in the same command would let the wildcard reach it.
 */
function rmWildcard(input: GuardInput, arg: string): GuardVerdict | null {
  const cut = arg.lastIndexOf('/');
  const prefix = cut === -1 ? '' : arg.slice(0, Math.max(cut, 1));
  const segment = arg.slice(cut + 1);
  const wildcards = segment.replace(/[^*?]/g, '').length;
  if (!WILDCARD_SEGMENT.test(segment) || wildcards === 0 || wildcards > MAX_WILDCARDS)
    return deny(UNJUDGED_RM);
  if (!PLAIN_PATH.test(prefix)) return deny(UNJUDGED_RM);
  let root: string;
  try {
    root = realPathOf(input.repoPath);
  } catch {
    return deny(`rm -r of ${arg} cannot be judged: the repository cannot be resolved.`);
  }
  let directories = [root];
  if (prefix !== '') {
    const target = rmPath(input, arg, expandTilde(prefix));
    if ('verdict' in target) return target.verdict;
    directories = target.rels.map((rel) => join(root, rel));
  }
  for (const directory of directories) {
    if (!isDirectory(directory))
      return deny(`rm -r of ${arg} needs ${prefix} to be a directory in the repository.`);
    if (holdsGit(directory))
      return deny(`rm -r of ${arg} could reach the .git beside it; name the paths.`);
  }
  return null;
}

/**
 * The words of an `rm` that may name paths. Options end at the first `--` or the first operand:
 * after either, BSD rm takes every word as a path, `-d/../.git` too. GNU rm still reads a `-` word
 * after an operand as an option; judging it as a path as well only refuses more.
 */
function rmArguments(words: readonly string[]): string[] {
  const args: string[] = [];
  let options = true;
  for (const word of words.slice(1)) {
    if (options && word === '--') {
      options = false;
      continue;
    }
    if (options && word.startsWith('-') && word !== '-') continue;
    options = false;
    args.push(word);
  }
  return args;
}

/**
 * Judges each argument of an `rm -r`. An argument is judged only as a plain path or as a plain
 * directory followed by one wildcard segment; any other shell syntax (grouping, braces, classes,
 * escapes, `~user`, `=cmd`, deeper wildcards, redirections) is refused, and the lane names the
 * paths instead. Quotes are not a special case: the parser drops them and the same rules apply.
 */
function rmVerdict(
  input: GuardInput,
  words: readonly string[],
  afterCd: boolean,
  segment: { readonly raw: string; readonly separator: string; readonly words: readonly string[] },
): GuardVerdict | null {
  if (!isRecursiveRm(words)) return null;
  if (afterCd)
    return deny('rm -r after cd is not allowed: the working directory is not the repository.');
  // A `(` straight after the arguments is zsh glob grouping, never a subshell.
  if (segment.separator === '(') return deny(UNJUDGED_RM);
  if (REDIRECTION.test(segment.raw) || segment.words.some((w) => REDIRECTION.test(w)))
    return deny(UNJUDGED_RM);
  for (const arg of rmArguments(words)) {
    if (isOverLongPath(arg)) return deny(OVER_LONG_PATH_REFUSAL);
    if (arg.includes('$')) return deny(`rm -r of ${arg} uses a variable the guard cannot resolve.`);
    if (PLAIN_PATH.test(arg)) {
      const target = rmPath(input, arg, expandTilde(arg));
      if ('verdict' in target) return target.verdict;
      continue;
    }
    const verdict = rmWildcard(input, arg);
    if (verdict) return verdict;
  }
  return null;
}

export const shellQuote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

export const SHELL_C_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;

/** A here-string word: `<<<`, optionally on a file descriptor, with or without its text attached. */
const HERE_STRING = /^\d*<<<(.*)$/s;

/** Shell options whose value is the next word (`-o pipefail`, `+O extglob`), alone or ending a cluster. */
const OPTION_WITH_VALUE = /^[-+][a-zA-Z]*[oO]$/;

/**
 * The word a shell runs after its `-c` flag: the first operand once the options between are
 * skipped, as bash and zsh read them (`bash -c -e 'cmd'`, `sh -c -- 'cmd'`, `bash -c -o x 'cmd'`).
 */
function commandString(words: readonly string[], flagAt: number): string | undefined {
  for (let at = flagAt + 1; at < words.length; at += 1) {
    const word = words[at] ?? '';
    const span = redirectionSpan(words, at);
    if (span > 0) {
      at += span - 1;
    } else if (word === '--' || word === '-') {
      return words[at + 1];
    } else if (OPTION_WITH_VALUE.test(word)) {
      at += 1;
    } else if (!/^[-+]./.test(word)) {
      return word;
    }
  }
  return undefined;
}

/** The scripts a shell's words hand it: its `-c` command string and every `<<<` here-string. */
export function shellScripts(words: readonly string[]): string[] {
  const flag = words.findIndex((w) => SHELL_C_FLAG.test(w));
  const command = flag === -1 ? undefined : commandString(words, flag);
  const scripts = command === undefined ? [] : [command];
  words.forEach((word, at) => {
    const here = HERE_STRING.exec(word);
    if (here === null) return;
    const text = here[1] ?? '';
    const next = words[at + 1];
    if (text !== '') scripts.push(text);
    else if (next !== undefined) scripts.push(next);
  });
  return scripts;
}

/** A directory a command may run in; null when the guard cannot name it (`cd "$DIR"`). */
type Dir = string | null;
const union = (...lists: readonly (readonly Dir[])[]): Dir[] => [...new Set(lists.flat())];
const DIRECTORY_CHANGES: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd']);

/**
 * The words with every redirection and its target dropped, so `pnpm 2>/dev/null add x` reads as
 * `pnpm add x`: the shell removes a redirection before it runs the command, wherever it stands.
 */
export function withoutRedirections(words: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < words.length;) {
    const span = redirectionSpan(words, i);
    if (span > 0) i += span;
    else kept.push(words[i++] ?? '');
  }
  return kept;
}

/** The command a segment runs, past reserved words, assignments and wrappers. */
export function commandOf(segment: ShellSegment): {
  readonly words: string[];
  readonly negated: boolean;
  readonly outOfOrder: boolean;
  /** env hides the command it runs: a split string, or a long option not spelled in full. */
  readonly hiddenByEnv: boolean;
  /** A redirection among the prefix words, or one the guard does not read, may hide the command. */
  readonly hiddenByRedirection: boolean;
} {
  const leading = leadingWords(segment.words);
  return {
    words: stripCommandPrefixes(leading.command, {
      lookThroughRunners: true,
      skipRedirections: true,
    }),
    negated: leading.negated,
    outOfOrder: leading.outOfOrder,
    hiddenByEnv: hidesEnvCommand(leading.command),
    hiddenByRedirection: leading.hiddenByRedirection || redirectionHidesCommand(leading.command),
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
    const nested = [...segment.nested, ...segment.hereDocuments];
    const scripts = head === 'eval' ? [words.slice(1).join(' '), ...nested] : nested;
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
/**
 * Commands that read a here-document as data, not as shell. A here-document body is always judged
 * as shell; only when its reader is one of these, and the segment's output is not forwarded to
 * another command, is the brace-group rule relaxed, so `console.log({a: 1})` or a JSON file passes.
 * `psql` and `sqlite3` are not here: their meta-commands (`\!`, `.shell`) run shell.
 */
const DATA_READERS: ReadonlySet<string> = new Set([
  'cat',
  'tee',
  'python',
  'python3',
  'node',
  'jq',
  'ruby',
  'perl',
  'git',
]);

/** Reserved words that close a loop or a conditional; piped, the body's output reaches the pipe. */
const BODY_CLOSERS: ReadonlySet<string> = new Set(['done', 'fi', 'esac']);
const ANGLE = /[<>]/;

/**
 * Whether the command, its substitutions and here-documents included, sets output up to reach
 * another process in a way one segment does not show: a `>(…)` or `<(…)` anywhere, an `exec` with
 * a redirection, a `coproc`, or a loop or conditional whose close pipes onward. Then no
 * here-document in the whole command is data.
 */
function forwardsOutput(segments: readonly ShellSegment[]): boolean {
  return segments.some((segment) => {
    const exec = segment.words.findIndex((w) => commandName(w) === 'exec');
    return (
      segment.processSubstitution ||
      segment.words.includes('coproc') ||
      (exec !== -1 && segment.words.slice(exec + 1).some((w) => ANGLE.test(w))) ||
      (BODY_CLOSERS.has(segment.words[0] ?? '') && segment.separator === '|') ||
      [...segment.nested, ...segment.hereDocuments].some((body) =>
        forwardsOutput(parseShell(body).segments),
      )
    );
  });
}

interface NestedScript {
  /** The script is a here-document body read as data, so a brace in it is not group syntax. */
  readonly bracesAsData?: boolean;
  /**
   * The script's output reaches another command (a substitution body, a script a forwarding
   * segment runs, or anything `forwardsOutput` finds), so a here-document a data reader takes in it
   * may still run as shell elsewhere.
   */
  readonly forwarded?: boolean;
}

function judgeShell(
  input: GuardInput,
  command: string,
  depth = 0,
  start: readonly Dir[] = [input.repoPath],
  nested: NestedScript = {},
): GuardVerdict {
  const bracesAsData = nested.bracesAsData === true;
  const parse = parseShell(command);
  const forwarded = nested.forwarded === true || forwardsOutput(parse.segments);
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
  for (const { segment, words, negated, hiddenByEnv, hiddenByRedirection } of segments) {
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
    if (!segment.wordsCertain) return deny(UNREAD_WORDS);
    if (!bracesAsData && !segment.bracesCertain) return deny(UNREAD_WORDS);
    if (hiddenByRedirection) return deny(HIDDEN_BY_REDIRECTION);
    if (head === 'sudo') return deny('sudo is never allowed.');
    if (hiddenByEnv)
      return deny(
        'env -S, or an env option not spelled in full, hides the command it runs. Run the command itself instead.',
      );
    const scripts = [...segment.nested, ...segment.hereDocuments];
    // Substitutions always run as shell, and their output may reach a shell the guard does not
    // see (`watch "$(…)"`, a here-document a shell reads), so a here-document inside one is never
    // data.
    for (const body of segment.nested) {
      const verdict = judgeShell(input, body, depth, dirs, { forwarded: true });
      if (verdict.decision === 'deny') return verdict;
    }
    // A script this segment runs (`sh -c`, `find -exec`, `eval`) writes where the segment writes.
    const inner: NestedScript = {
      bracesAsData,
      forwarded: forwarded || segment.outputForwarded,
    };
    // A here-document body is always judged as shell. Its braces are data only when a known data
    // reader takes it and its output is not forwarded (a pipe, a process substitution, a group or
    // subshell that is piped, a substitution body, or anything `forwardsOutput` finds in the whole
    // command), so an interpreter reached through a wrapper or a pipeline, or a body
    // that reaches a shell through the reader's output, is still judged with the brace-group rule.
    const bodyIsData = DATA_READERS.has(head) && !segment.outputForwarded && !forwarded;
    for (const body of segment.hereDocuments) {
      const verdict = judgeShell(input, body, depth, dirs, {
        bracesAsData: bracesAsData || bodyIsData,
        forwarded,
      });
      if (verdict.decision === 'deny') return verdict;
    }
    // The brace-expanded words are checked as well as the text: `$ANTHRO{PIC,}_API_KEY` names a
    // credential only once expanded.
    const expanded = segment.words.join(' ');
    const accountRule =
      keychainRefusal(words) ??
      envDumpRefusal(segment.words, words) ??
      secretReferenceRefusal(segment.raw) ??
      secretReferenceRefusal(expanded) ??
      scriptRefusal(head, [segment.raw, expanded, ...scripts].join('\n')) ??
      firstRefusal(dirs, (dir) =>
        segmentPathRefusal(segment.raw, words, dir, input.protectedPaths, scripts),
      );
    if (accountRule) return deny(accountRule);
    if (SHELLS.has(head)) {
      if (piped) return deny('Piping into a shell runs commands the guard cannot see.');
      for (const script of shellScripts(words)) {
        if (depth >= 3) break;
        const verdict = judgeShell(input, script, depth + 1, dirs, inner);
        if (verdict.decision === 'deny') return verdict;
      }
    }
    if (head === 'find' && depth < 3) {
      for (const exec of findExecCommands(words)) {
        const verdict = judgeShell(input, exec.map(shellQuote).join(' '), depth + 1, dirs, inner);
        if (verdict.decision === 'deny') return verdict;
      }
    }
    if (head === 'eval' && depth < 3) {
      const script = words.slice(1).join(' ');
      const verdict = judgeShell(input, script, depth + 1, dirs, inner);
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
      const verdict = gitVerdict(words);
      if (verdict) return deny(verdict.deny);
    }
    if (head === 'gh') {
      const verdict = ghVerdict(words);
      if (verdict) return deny(verdict.deny);
    }
    if (head === 'rm') {
      const verdict = rmVerdict(input, words, afterCd, segment);
      if (verdict) return verdict;
    }
    if (DIRECTORY_CHANGES.has(head)) {
      afterCd = true;
      const moved = union(dirs.map((dir) => changedDirectory(segment.raw, words, dir)));
      possible = union(possible, moved);
      // After `! cd`, what follows `&&` runs when the cd failed.
      chained = negated ? union(dirs, moved) : moved;
    }
    const forms = commandForms(withoutRedirections(words));
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
  // The search path keeps its `..`, so a pattern under it is judged on each reading.
  const searchPath = stringField(input.toolInput, 'path') ?? '.';
  const base = isAbsolute(searchPath) ? searchPath : `${input.repoPath}${sep}${searchPath}`;
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
  if (input.fileAccess && PATH_READ_TOOLS.has(input.toolName)) {
    const verdict = input.fileAccess.read(input.toolName, input.toolInput);
    if (verdict !== 'ok') return deny(verdict.refuse);
  }
  if (FILE_TOOLS.has(input.toolName)) {
    if (input.readOnly) return deny(READ_ONLY_REFUSAL);
    const filePath =
      stringField(input.toolInput, 'file_path') ?? stringField(input.toolInput, 'notebook_path');
    if (filePath !== null && input.fileAccess) {
      const verdict = input.fileAccess.write(filePath);
      if (verdict !== 'ok') return deny(verdict.refuse);
    }
    return filePath === null ? ALLOW : judgeFile(input, filePath);
  }
  // Monitor runs its command in a shell like Bash does, so the same rules judge it. A read-only step
  // refuses it below, as it refuses every tool its list leaves out.
  if (input.toolName === 'Bash' || (input.toolName === 'Monitor' && !input.readOnly)) {
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
