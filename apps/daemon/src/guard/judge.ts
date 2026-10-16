import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import { ClaimKind, type AreaDef, type HazardDef } from '@10db/contracts';
import { z } from 'zod';
import { commandForms, startsWithWords } from './command-forms';
import { gitVerdict } from './git-rules';
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
      const verdict = gitVerdict(words);
      if (verdict) return deny(verdict.deny);
    }
    if (head === 'rm') {
      const verdict = rmVerdict(input, words, afterCd);
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
