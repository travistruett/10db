import { lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { ClaimKind, Delivery, type AreaDef, type HazardDef } from '@10db/contracts';
import { z } from 'zod';
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
import { splitCommand, stripCommandPrefixes } from './shell-words';

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
/** A last segment with wildcards: no leading `.`, no character but these and `*` and `?`. */
const WILDCARD_SEGMENT = /^[A-Za-z0-9_\-*?][A-Za-z0-9_\-.*?]*$/;
const MAX_WILDCARDS = 4;
/** A redirection word, such as `2>/dev/null` or a bare `>` whose target is the next word. */
const REDIRECTION = /^\d*(?:&>>?|>\||>>?&?|<&?)/;
/** Text that can quote or escape a word, which the parser drops: a word in such a segment may only look like a redirection. */
const QUOTING = /['"\\`]/;
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
 * Judges each argument of an `rm -r`. An argument is judged only as a plain path or as a plain
 * directory followed by one wildcard segment; any other shell syntax (grouping, braces, classes,
 * escapes, `~user`, `=cmd`, deeper wildcards) is refused, and the lane names the paths instead.
 * Quotes are not a special case: the parser drops them and the same rules apply.
 */
function rmVerdict(
  input: GuardInput,
  words: readonly string[],
  afterCd: boolean,
  segment: { readonly raw: string; readonly separator: string },
): GuardVerdict | null {
  if (!isRecursiveRm(words)) return null;
  if (afterCd)
    return deny('rm -r after cd is not allowed: the working directory is not the repository.');
  // A `(` straight after the arguments is zsh glob grouping, never a subshell.
  if (segment.separator === '(') return deny(UNJUDGED_RM);
  const redirections = !QUOTING.test(segment.raw);
  const args = words.slice(1).filter((w) => !w.startsWith('-'));
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const redirection = redirections ? REDIRECTION.exec(arg) : null;
    if (redirection) {
      if (redirection[0] === arg) index += 1;
      continue;
    }
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

const SHELL_C_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;

function judgeShell(input: GuardInput, command: string, depth = 0): GuardVerdict {
  let afterCd = false;
  let previousSeparator = '';
  for (const segment of splitCommand(command)) {
    const words = stripCommandPrefixes(segment.words);
    const head = words[0] ?? '';
    const piped = previousSeparator === '|';
    previousSeparator = segment.separator;
    if (head === 'sudo') return deny('sudo is never allowed.');
    if (SHELLS.has(head)) {
      if (piped) return deny('Piping into a shell runs commands the guard cannot see.');
      const flagIndex = words.findIndex((w) => SHELL_C_FLAG.test(w));
      const inner = flagIndex === -1 ? undefined : words[flagIndex + 1];
      if (inner !== undefined && depth < 3) {
        const verdict = judgeShell(input, inner, depth + 1);
        if (verdict.decision === 'deny') return verdict;
      }
    }
    if (head === 'eval' && depth < 3) {
      const verdict = judgeShell(input, words.slice(1).join(' '), depth + 1);
      if (verdict.decision === 'deny') return verdict;
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
      const verdict = rmVerdict(input, words, afterCd, segment);
      if (verdict) return verdict;
    }
    if (head === 'cd' || head === 'pushd') afterCd = true;
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
