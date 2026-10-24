import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
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
    login(join(opts.home, '.claude.json')),
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

/**
 * Commands that print the environment, or one credential in it. `written` is the segment's words as
 * written (with `env` and assignments); `command` is what runs once those prefixes are stripped.
 */
export function envDumpRefusal(
  written: readonly string[],
  command: readonly string[],
): string | null {
  if (command.length === 0 && written.some((w) => basename(w) === 'env')) return ENV_DUMP;
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
      // macOS ps prints each process's environment with -e or -E, or `e` in a BSD-style word.
      return args.some((a) => (a.startsWith('-') ? /^-[a-zA-Z]*[eE]/.test(a) : a.includes('e')))
        ? ENV_DUMP
        : null;
    default:
      return null;
  }
}

/** `$NAME` or `${NAME…}` of a credential variable anywhere in the segment. */
export function secretReferenceRefusal(raw: string): string | null {
  const name = SECRET_VARIABLES.find((n) => new RegExp(`\\$\\{?${n}(?![A-Za-z0-9_])`).test(raw));
  return name ? secret(name) : null;
}

function expandHome(text: string): string {
  const home = homedir();
  return text
    .replaceAll('${HOME}', home)
    .replaceAll('$HOME', home)
    .replace(/(^|[\s=:])~(?=\/|$)/gm, `$1${home}`);
}

/** The path as given and as the file system resolves it (a temp directory is often a link). */
function forms(path: string): string[] {
  try {
    return [path, realpathSync.native(path)];
  } catch {
    return [path];
  }
}

/**
 * What may follow a path where the text names it: the end, a deeper path, whitespace, an assignment
 * or option separator, a quote or a shell operator. A sibling such as `~/.claude-work` or
 * `…/10db-backup` goes on with another character, so it is not the path.
 */
const PATH_END = /^(?:$|[\s/=:'"`;|&)<>])/;

/** Whether text names the path however it is quoted or escaped: `\ `, quotes, `~` or `$HOME`. */
export function mentionsPath(text: string, path: string): boolean {
  const plain = expandHome(text.replaceAll('\\ ', ' ').replace(/["']/g, '')).toLowerCase();
  return forms(path).some((form) => {
    const needle = form.toLowerCase();
    for (let at = plain.indexOf(needle); at !== -1; at = plain.indexOf(needle, at + 1))
      if (PATH_END.test(plain.slice(at + needle.length))) return true;
    return false;
  });
}

/** The refusal for a path, or a word that may be one, landing on a protected path from the repo. */
export function pathRefusal(
  value: string,
  repoPath: string,
  paths: readonly ProtectedPath[],
): string | null {
  if (value.startsWith('-')) return null;
  const target = resolve(repoPath, expandHome(value));
  return (
    paths.find((p) => isWithin(p.path, target) || mentionsPath(value, p.path))?.refusal ?? null
  );
}

/** A shell segment naming a protected path anywhere in its text, or in a word that resolves onto one. */
export function segmentPathRefusal(
  raw: string,
  words: readonly string[],
  repoPath: string,
  paths: readonly ProtectedPath[],
): string | null {
  const named = paths.find((p) => mentionsPath(raw, p.path));
  if (named) return named.refusal;
  for (const word of words) {
    const refusal = pathRefusal(word, repoPath, paths);
    if (refusal) return refusal;
  }
  return null;
}
