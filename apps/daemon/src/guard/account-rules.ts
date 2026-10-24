import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
  sep,
} from 'node:path';
import { SECRET_VARIABLES } from '../environment';
import { isWithin } from './paths';

const KEYCHAIN = 'Keychain commands are never run by agents: 10db keeps account secrets there.';
const ENV_DUMP =
  'Printing the environment would show account credentials. Read the one variable you need, if it holds no credential.';
const secret = (name: string): string =>
  `${name} holds an account credential; agents never read it.`;

/** A path no agent may touch, and the reason the guard gives. */
export interface ProtectedPath {
  readonly path: string;
  readonly refusal: string;
  /** Also protects `<path>.<suffix>` files beside it, such as a backup of a sign-in file. */
  readonly family?: boolean;
}

/**
 * 10db's data directory, which holds every other account's config directory, and the default
 * account's own sign-in outside it: Claude Code's default directory and file, and the login
 * shell's own directory.
 */
export function protectedPaths(opts: {
  readonly dataDir: string;
  readonly home: string;
  readonly loginConfigDir: string | null;
}): ProtectedPath[] {
  const login = (path: string): ProtectedPath => ({
    path,
    refusal: `${path} holds Claude Code's own sign-in, which the default account runs on; agents never read or write it.`,
  });
  return [
    {
      path: opts.dataDir,
      refusal: `${opts.dataDir} is 10db's data directory, which holds every account's sign-in; agents never read or write it.`,
    },
    login(join(opts.home, '.claude')),
    { ...login(join(opts.home, '.claude.json')), family: true },
    ...(opts.loginConfigDir === null ? [] : [login(opts.loginConfigDir)]),
  ];
}

/** `security` in any form, and AppleScript that names the Keychain. */
export function keychainRefusal(command: readonly string[]): string | null {
  const [head = '', ...args] = command;
  if (head === 'security') return KEYCHAIN;
  if (head === 'osascript' && args.some((a) => /keychain|\bsecurity\b/i.test(a))) return KEYCHAIN;
  return null;
}

const isSecretName = (word: string): boolean => SECRET_VARIABLES.includes(word.split('=')[0] ?? '');
const commandName = (word: string): string => basename(word.replace(/^\\+/, ''));

/** `ps` options whose next word is a value, not a flag. */
const PS_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-o',
  '-O',
  '-p',
  '-u',
  '-U',
  '-g',
  '-G',
  '-t',
]);

/** macOS `ps` prints each process's environment with `-E`, or `e` in a BSD-style first word. */
function psShowsEnvironment(args: readonly string[]): boolean {
  const first = args[0];
  if (first !== undefined && !first.startsWith('-') && first.includes('e')) return true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (PS_VALUE_FLAGS.has(arg)) i += 1;
    else if (/^-[a-zA-Z]*E/.test(arg)) return true;
  }
  return false;
}

/**
 * Commands that print the environment, or one credential in it. `written` is the segment's words as
 * written (with `env` and assignments); `command` is what runs once those prefixes are stripped.
 */
export function envDumpRefusal(
  written: readonly string[],
  command: readonly string[],
): string | null {
  if (command.length === 0 && written.some((w) => commandName(w) === 'env')) return ENV_DUMP;
  const [head = '', ...args] = command;
  const names = args.filter((a) => !a.startsWith('-'));
  switch (head) {
    case 'printenv':
      return ENV_DUMP;
    case 'set':
      return args.length === 0 ? ENV_DUMP : null;
    case 'export':
    case 'declare':
    case 'typeset':
    case 'readonly': {
      const credential = names.find(isSecretName);
      if (credential) return secret(credential.split('=')[0] ?? credential);
      return names.length === 0 ? ENV_DUMP : null;
    }
    case 'compgen':
      return args.some((a) => /^-[a-zA-Z]*[ev]/.test(a)) ? ENV_DUMP : null;
    case 'ps':
      return psShowsEnvironment(args) ? ENV_DUMP : null;
    default:
      return null;
  }
}

/** `$NAME` or `${NAME…}` of a credential variable anywhere in the segment. */
export function secretReferenceRefusal(raw: string): string | null {
  const name = SECRET_VARIABLES.find((n) => new RegExp(`\\$\\{?${n}(?![A-Za-z0-9_])`).test(raw));
  return name ? secret(name) : null;
}

const INTERPRETERS: ReadonlySet<string> = new Set([
  'node',
  'nodejs',
  'bun',
  'deno',
  'python',
  'python3',
  'perl',
  'ruby',
  'php',
  'osascript',
  'awk',
  'gawk',
  'nawk',
]);
const ENV_READERS = /process\.env|os\.environ|\bENVIRON\b|getenv|system attribute/;
const ENV_AS_A_WHOLE =
  /process\.env(?![\w$]|\s*[.[])|os\.environ(?![\w$]|\s*\[|\.get\b)|\bin\s+ENVIRON\b/;

/**
 * Shell indirection that expands a variable named at run time, and a one-line script that reads a
 * credential or the whole environment.
 */
export function scriptRefusal(head: string, raw: string): string | null {
  if (raw.includes('${!')) return ENV_DUMP;
  if (!INTERPRETERS.has(head) && !/^python3\.\d+$/.test(head)) return null;
  const name = SECRET_VARIABLES.find((n) => raw.includes(n));
  if (name && ENV_READERS.test(raw)) return secret(name);
  return ENV_AS_A_WHOLE.test(raw) ? ENV_DUMP : null;
}

function homeOf(name: string): string {
  const home = homedir();
  return name === '' || name === basename(home) ? home : join(dirname(home), name);
}

/** What follows `$HOME` or `${HOME}` at `at` in the text, or null when it is some other variable. */
function homeVariableAt(text: string, at: number): { replaced: number } | null {
  if (text.startsWith('${HOME}', at)) return { replaced: 7 };
  if (text.startsWith('$HOME', at) && !/[A-Za-z0-9_]/.test(text.charAt(at + 5)))
    return { replaced: 5 };
  return null;
}

/** A `~` or `~name` at the start of the text, as the shell expands it. */
function expandTilde(text: string): string {
  const match = /^~([A-Za-z0-9_.-]*)(?=\/|$)/.exec(text);
  return match ? homeOf(match[1] ?? '') + text.slice(match[0].length) : text;
}

const WORD_BREAK = new Set([' ', '\t', '\n', '<', '>', '(', ')', '|', ';', '&', '`']);

/**
 * The words of a shell segment as the shell would pass them on: quotes removed, escapes resolved,
 * `$HOME` outside single quotes and a leading `~` outside any quotes expanded, and a redirection or
 * substitution starting a new word. A `~` inside quotes stays a `~`.
 */
function shellWords(raw: string): string[] {
  const words: string[] = [];
  let word = '';
  let open = false;
  let quote: "'" | '"' | null = null;
  const flush = (): void => {
    if (open) words.push(word);
    word = '';
    open = false;
  };
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (ch === '\\') {
      word += raw.charAt(i + 1);
      open = true;
      i += 1;
      continue;
    }
    if (ch === '$') {
      const home = homeVariableAt(raw, i);
      if (home) {
        word += homedir();
        open = true;
        i += home.replaced - 1;
        continue;
      }
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      open = true;
      continue;
    }
    if (WORD_BREAK.has(ch)) {
      flush();
      continue;
    }
    if (ch === '~' && (word === '' || /[=:]$/.test(word))) {
      const named = /^~([A-Za-z0-9_.-]*)(?=\/|$|[\s:;|&<>()])/.exec(raw.slice(i));
      if (named) {
        word += homeOf(named[1] ?? '');
        open = true;
        i += named[0].length - 1;
        continue;
      }
    }
    word += ch;
    open = true;
  }
  flush();
  return words;
}

const GLOB_CHARACTERS = /[*?[]/;
const lower = (text: string): string => text.toLowerCase();

/** The path as given and as the file system resolves it (a temp directory is often a link). */
function forms(path: string): string[] {
  try {
    return [path, realpathSync.native(path)];
  } catch {
    return [path];
  }
}

/**
 * What may follow a path where a word names it: the end, a deeper path, whitespace, an assignment
 * or option separator, a quote or a shell operator. A sibling such as `~/.claude-work` or
 * `…/10db-backup` goes on with another character, so it is not the path.
 */
const PATH_END = /^(?:$|[\s/=:'"`;|&)<>])/;
const FAMILY_END = /^(?:$|[\s/=:'"`;|&)<>.])/;

/** Whether text contains the protected path, written out, ending where a path ends. */
function namesPath(text: string, protectedPath: ProtectedPath): boolean {
  const plain = lower(text);
  const end = protectedPath.family ? FAMILY_END : PATH_END;
  return forms(protectedPath.path).some((form) => {
    const needle = lower(form);
    for (let at = plain.indexOf(needle); at !== -1; at = plain.indexOf(needle, at + 1))
      if (end.test(plain.slice(at + needle.length))) return true;
    return false;
  });
}

/** The target is the protected path, inside it, or (for a family) a file named like it plus a suffix. */
function touches(protectedPath: ProtectedPath, target: string): boolean {
  if (isWithin(protectedPath.path, target)) return true;
  if (!protectedPath.family) return false;
  const beside = resolve(target);
  return (
    lower(dirname(beside)) === lower(dirname(protectedPath.path)) &&
    lower(basename(beside)).startsWith(`${lower(basename(protectedPath.path))}.`)
  );
}

function globMatches(path: string, pattern: string): boolean {
  try {
    return matchesGlob(path, pattern);
  } catch {
    return false;
  }
}

/** Whether a glob can expand to the protected path or to something inside it. */
function globReaches(pattern: string, protectedPath: ProtectedPath): boolean {
  const pat = lower(pattern);
  const patternSegments = pat.split('/');
  return forms(protectedPath.path).some((form) => {
    const path = lower(form);
    const segments = path.split('/');
    if (patternSegments.length >= segments.length) {
      const prefix = patternSegments.slice(0, segments.length);
      if (!prefix.includes('**') && globMatches(path, prefix.join('/'))) return true;
    }
    return (
      globMatches(path, pat) ||
      globMatches(`${path}/x`, pat) ||
      (protectedPath.family === true && globMatches(`${path}.x`, pat))
    );
  });
}

interface Reach {
  /** The word may name a directory that holds a protected path (a recursive reader walks into it). */
  readonly contains: boolean;
}

function reachRefusal(
  word: string,
  base: string | null,
  paths: readonly ProtectedPath[],
  reach: Reach,
): string | null {
  const target = base === null && !isAbsolute(word) ? null : resolve(base ?? '/', word);
  if (target === null) {
    // The working directory is unknown after a `cd` the guard cannot follow: a word that names a
    // protected path's last component is refused.
    const segments = lower(word).split('/');
    return paths.find((p) => segments.includes(lower(basename(p.path))))?.refusal ?? null;
  }
  const glob = GLOB_CHARACTERS.test(word);
  for (const p of paths) {
    if (glob ? globReaches(target, p) : touches(p, target) || namesPath(word, p)) return p.refusal;
    if (!glob && reach.contains && isWithin(target, p.path)) return p.refusal;
  }
  return null;
}

/**
 * The refusal for a path a tool names, from `baseDir`: inside a protected path, a glob that can
 * reach one, or (for a search root) a directory that holds one.
 */
export function pathRefusal(
  value: string,
  baseDir: string,
  paths: readonly ProtectedPath[],
  reach: Reach,
): string | null {
  return reachRefusal(expandTilde(value), baseDir, paths, reach);
}

const RECURSIVE_READERS: ReadonlySet<string> = new Set(['rg', 'find', 'tar', 'rsync']);
const RECURSIVE_FLAG: Readonly<Record<string, RegExp>> = {
  grep: /^(?:-[a-zA-Z]*[rR]|--recursive$)/,
  egrep: /^(?:-[a-zA-Z]*[rR]|--recursive$)/,
  fgrep: /^(?:-[a-zA-Z]*[rR]|--recursive$)/,
  cp: /^(?:-[a-zA-Z]*[rRa]|--recursive$)/,
};

/** Commands that walk every directory they are given. */
function walksDirectories(command: readonly string[]): boolean {
  const [head = '', ...args] = command;
  if (RECURSIVE_READERS.has(head)) return true;
  const flag = RECURSIVE_FLAG[head];
  return flag !== undefined && args.some((a) => flag.test(a));
}

/**
 * A shell segment with a word that resolves onto a protected path from `cwd`, names one written out,
 * is a glob that can expand to one, or (for a recursive reader) is a directory that holds one. A
 * word mentioned inside a longer quoted text is not a path. `cwd` is null after a `cd` the guard
 * cannot resolve.
 */
export function segmentPathRefusal(
  raw: string,
  command: readonly string[],
  cwd: string | null,
  paths: readonly ProtectedPath[],
): string | null {
  const reach = { contains: walksDirectories(command) };
  for (const word of shellWords(raw)) {
    const tail = word.includes('=') ? word.slice(word.indexOf('=') + 1).split(':') : [];
    const candidates = word.startsWith('-') ? tail : [word, ...tail];
    for (const candidate of candidates) {
      const refusal = reachRefusal(candidate, cwd, paths, reach);
      if (refusal) return refusal;
    }
  }
  return null;
}

/** Where `cd` or `pushd` goes from `cwd`; null when the target is not a plain path the guard can follow. */
export function changedDirectory(
  raw: string,
  command: readonly string[],
  cwd: string | null,
): string | null {
  const words = shellWords(raw);
  const target = words[words.findIndex((w) => commandName(w) === command[0]) + 1];
  if (target === undefined) return homedir();
  if (cwd === null || target.startsWith('-') || /[$`*?[]/.test(target)) return null;
  return resolve(cwd, target);
}

/** Whether a session's own saved tool output is what `value` names (Claude Code points the model at it). */
export function isOwnToolResult(
  session: { readonly configDir: string; readonly providerSessionId: string | null },
  value: string,
  baseDir: string,
): boolean {
  if (session.providerSessionId === null) return false;
  const target = resolve(baseDir, expandTilde(value));
  const parts = relative(session.configDir, target).split(sep);
  const [projects, slug, id, results] = parts;
  if (projects !== 'projects' || slug === undefined || id !== session.providerSessionId)
    return false;
  if (results !== 'tool-results' || parts.includes('..')) return false;
  return isWithin(join(session.configDir, 'projects', slug, id, 'tool-results'), target);
}
