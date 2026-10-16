import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { ClaimKind, type AreaDef, type HazardDef } from '@10db/contracts';
import { z } from 'zod';
import { classifyPath, resolveInRepo } from './paths';
import { splitCommand, stripCommandPrefixes } from './shell-words';

export interface GuardInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly repoPath: string;
  readonly areas: readonly AreaDef[];
  readonly hazards: readonly HazardDef[];
  readonly claims: readonly { readonly kind: ClaimKind; readonly name: string }[];
}

export type GuardVerdict =
  { readonly decision: 'allow' } | { readonly decision: 'deny'; readonly reason: string };

const ALLOW: GuardVerdict = { decision: 'allow' };
const deny = (reason: string): GuardVerdict => ({ decision: 'deny', reason });

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_ONLY_GIT = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'rev-parse',
  'ls-files',
  'grep',
  'describe',
  'shortlog',
  'cat-file',
  'ls-tree',
  'rev-list',
]);
const BANNED_GIT = new Set([
  'checkout',
  'switch',
  'reset',
  'stash',
  'commit',
  'add',
  'rm',
  'mv',
  'restore',
  'clean',
  'rebase',
  'merge',
  'cherry-pick',
  'revert',
  'pull',
  'am',
  'apply',
  'filter-branch',
  'update-ref',
  'worktree',
  'gc',
  'prune',
]);
const PROTECTED_BRANCHES = new Set(['main', 'master']);
const DEPLOY = [
  /^(vercel|netlify)\b.*\b(deploy|--prod)\b/,
  /^fly (deploy|launch)\b/,
  /^kubectl (apply|delete|rollout)\b/,
  /^terraform (apply|destroy)\b/,
  /^(npm|pnpm|yarn) publish\b/,
  /^cargo publish\b/,
  /^gh release create\b/,
];
const SHELLS = new Set(['sh', 'bash', 'zsh']);
/** Flags whose next word is their value, so it is not mistaken for the subcommand. */
const VALUE_FLAGS = new Set([
  '--filter',
  '-F',
  '--dir',
  '-C',
  '--prefix',
  '--workspace',
  '--manifest-path',
  '-p',
  '--package',
  '--config',
]);
/** Runners whose remaining words are themselves a command (`pnpm exec drizzle-kit generate`). */
const RUNNERS: readonly (readonly string[])[] = [
  ['npx'],
  ['pnpm', 'exec'],
  ['pnpm', 'dlx'],
  ['npm', 'exec'],
  ['yarn', 'dlx'],
];

/** The command's words without flags or flag values: `pnpm --filter x add zod` → `pnpm add zod`. */
function withoutFlags(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] ?? '';
    if (!w.startsWith('-')) out.push(w);
    else if (VALUE_FLAGS.has(w)) i += 1;
  }
  return out;
}

/** The command itself, plus what it runs when it is a runner such as `npx` or `pnpm exec`. */
function commandForms(words: readonly string[]): string[][] {
  const bare = withoutFlags(words);
  const runner = RUNNERS.find((r) => startsWithWords(bare, r));
  return runner ? [bare, bare.slice(runner.length)] : [bare];
}

function startsWithWords(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.every((p, i) => words[i] === p);
}

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

function gitVerdict(words: readonly string[]): GuardVerdict | null {
  let i = 1;
  while (i < words.length && (words[i] ?? '').startsWith('-'))
    i += words[i] === '-C' || words[i] === '-c' ? 2 : 1;
  const verb = words[i] ?? '';
  const args = words.slice(i + 1);
  if (verb === '' || READ_ONLY_GIT.has(verb)) return null;
  if (verb === 'commit')
    return deny('Direct git commit is not allowed. Use the 10db commit tool with explicit paths.');
  if (BANNED_GIT.has(verb))
    return deny(
      `git ${verb} changes the shared checkout and is not allowed. Only read-only git is allowed; commit through the 10db commit tool.`,
    );
  if (
    verb === 'branch' &&
    args.some((a) => !['-a', '-r', '--list', '-v', '-vv', '--show-current'].includes(a))
  ) {
    return deny('Creating or deleting branches is not allowed in the shared checkout.');
  }
  if (verb === 'push') {
    if (
      args.some(
        (a) => a === '-f' || a.startsWith('--force') || a === '--delete' || a.startsWith('+'),
      )
    )
      return deny('Force pushes and remote deletes are never allowed.');
    const targets = args
      .filter((a) => !a.startsWith('-'))
      .slice(1)
      .map((ref) => ref.split(':').at(-1) ?? ref);
    if (targets.some((t) => PROTECTED_BRANCHES.has(t.replace(/^refs\/heads\//, ''))))
      return deny('Pushing to a protected branch is never allowed.');
  }
  return null;
}

function rmVerdict(input: GuardInput, words: readonly string[]): GuardVerdict | null {
  const flags = words.filter((w) => w.startsWith('-')).join('');
  if (!/[rR]/.test(flags)) return null;
  for (const arg of words.slice(1).filter((w) => !w.startsWith('-'))) {
    const expanded = arg.startsWith('~') ? arg.replace(/^~/, homedir()) : arg;
    const where = resolveInRepo(
      input.repoPath,
      isAbsolute(expanded) ? expanded : resolve(input.repoPath, expanded),
    );
    if (!where.inside)
      return deny(`rm -r of ${arg} reaches outside the repository (or is the repository itself).`);
  }
  return null;
}

function judgeShell(input: GuardInput, command: string, depth = 0): GuardVerdict {
  for (const segment of splitCommand(command)) {
    const words = stripCommandPrefixes(segment.words);
    const head = words[0] ?? '';
    const line = words.join(' ');
    if (head === 'sudo') return deny('sudo is never allowed.');
    if (SHELLS.has(head) && words.includes('-c') && depth < 3) {
      const inner = words[words.indexOf('-c') + 1];
      if (inner !== undefined) {
        const verdict = judgeShell(input, inner, depth + 1);
        if (verdict.decision === 'deny') return verdict;
      }
    }
    if (head === 'eval' && depth < 3) {
      const verdict = judgeShell(input, words.slice(1).join(' '), depth + 1);
      if (verdict.decision === 'deny') return verdict;
    }
    if (head === 'git') {
      const verdict = gitVerdict(words);
      if (verdict) return verdict;
    }
    if (head === 'rm') {
      const verdict = rmVerdict(input, words);
      if (verdict) return verdict;
    }
    if (DEPLOY.some((re) => re.test(line)))
      return deny('Deploy and publish commands are never run by agents.');
    const forms = commandForms(words);
    for (const hazard of input.hazards) {
      if (
        hazard.commands.some((c) => forms.some((f) => startsWithWords(f, c.split(' ')))) &&
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

/** The PreToolUse decision for a managed session (spec §8.2). Rules only; never an LLM. */
export function judgeToolUse(input: GuardInput): GuardVerdict {
  if (FILE_TOOLS.has(input.toolName)) {
    const filePath =
      stringField(input.toolInput, 'file_path') ?? stringField(input.toolInput, 'notebook_path');
    return filePath === null ? ALLOW : judgeFile(input, filePath);
  }
  if (input.toolName === 'Bash') {
    const command = stringField(input.toolInput, 'command');
    return command === null ? ALLOW : judgeShell(input, command);
  }
  return ALLOW;
}
