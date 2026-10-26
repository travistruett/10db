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
import { abbreviates } from './git-rules';
import { expandBraceWord } from './braces';
import {
  isOverLongPath,
  isWithin,
  isWithinOnEveryReading,
  OVER_LONG_PATH_REFUSAL,
  realPathReadings,
} from './paths';

/**
 * Two kinds of rule live here. The shell-text rules (Keychain commands, environment dumps, secret
 * references and protected paths in shell text) are interim policy that keeps a cooperative agent
 * from casual reads; text matching cannot see everything a shell does. The lane sandbox is designed
 * but not built: once it is, the kernel sandbox is the lane boundary and these rules go.
 * `pathRefusal`, `protectedPaths` and `isOwnToolResult` are the resolved-path check on the file
 * tools, which the sandbox design keeps as part of the file-tool boundary
 * (`docs/architecture/03-trust-boundaries.md`).
 */

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

/** A `ps` option cluster that ends in a flag taking the next word as its value (`-o`, `-eo`, `-p`…). */
const PS_VALUE_FLAG = /^-[a-zA-Z]*[oOpuUgGt]$/;

/**
 * macOS `ps` prints each process's environment with `-E`, or with `e` in a BSD-style option word:
 * any word that is not a flag and not the value of one.
 */
function psShowsEnvironment(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg.startsWith('-')) {
      if (/^-[a-zA-Z]*E/.test(arg)) return true;
      if (PS_VALUE_FLAG.test(arg)) i += 1;
    } else if (/[eE]/.test(arg)) {
      return true;
    }
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
const ENV_READERS =
  /process\.env|Bun\.env|os\.environ|\bENVIRON\b|\bENV\b|\$ENV\b|getenv|system attribute/;
const ENV_AS_A_WHOLE =
  /(?:process|Bun)\.env(?![\w$]|\s*[.[])|os\.environ(?![\w$]|\s*\[|\.get\b)|\bin\s+ENVIRON\b|%ENV\b|\bENV\b(?!\s*\[|\.fetch\b)/;

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

const USER_VARIABLE = /^(?:\$\{(HOME|USER|LOGNAME)\}|\$(HOME|USER|LOGNAME)(?![A-Za-z0-9_]))/;

/** The expansion of `$HOME`, `$USER` or `$LOGNAME` (braced or not) at the start of the text. */
function userVariable(text: string): { length: number; value: string } | null {
  const match = USER_VARIABLE.exec(text);
  if (!match) return null;
  const name = match[1] ?? match[2];
  return { length: match[0].length, value: name === 'HOME' ? homedir() : basename(homedir()) };
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
      const variable = userVariable(raw.slice(i));
      if (variable) {
        word += variable.value;
        open = true;
        i += variable.length - 1;
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

const GLOB_CHARACTERS = /[*?[{]/;
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

/** The target, as written, is the protected path or under it: for a protected path not created yet. */
function writtenWithin(protectedPath: ProtectedPath, target: string): boolean {
  return forms(protectedPath.path).some((form) => {
    const rel = relative(lower(form), lower(resolve(target)));
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
}

/**
 * The target is the protected path, inside it, or (for a family) a file named like it plus a
 * suffix, on any reading: as written, through its links as the kernel opens it, or with `..`
 * collapsed first.
 */
function touches(protectedPath: ProtectedPath, target: string): boolean {
  if (isWithin(protectedPath.path, target) || writtenWithin(protectedPath, target)) return true;
  if (!protectedPath.family) return false;
  return [resolve(target), ...realPathReadings(target).paths].some(
    (beside) =>
      lower(dirname(beside)) === lower(dirname(protectedPath.path)) &&
      lower(basename(beside)).startsWith(`${lower(basename(protectedPath.path))}.`),
  );
}

function globMatches(path: string, pattern: string): boolean {
  try {
    return matchesGlob(path, pattern);
  } catch {
    return false;
  }
}

/** The glob with its leading literal directories resolved through links, as the shell would open them. */
function throughLinks(pattern: string): string {
  const parts = pattern.split('/');
  const literal = parts.findIndex((part) => GLOB_CHARACTERS.test(part));
  const fixed = (literal === -1 ? parts : parts.slice(0, literal)).join('/');
  try {
    return [
      realpathSync.native(fixed || '/'),
      ...(literal === -1 ? [] : parts.slice(literal)),
    ].join('/');
  } catch {
    return pattern;
  }
}

/**
 * Whether a glob can expand to the protected path or into it. `**` and a walking command also
 * reach it from a parent: the part before a `**` matches the same depth of the path, and a walker
 * descends into any directory the pattern names.
 */
function globReaches(pattern: string, protectedPath: ProtectedPath, walking: boolean): boolean {
  return [resolve(pattern), throughLinks(pattern)].some((candidate) => {
    const pat = lower(candidate);
    const patternSegments = pat.split('/');
    const star = patternSegments.indexOf('**');
    return forms(protectedPath.path).some((form) => {
      const path = lower(form);
      const segments = path.split('/');
      const depth = star === -1 ? segments.length : Math.min(star, segments.length);
      const enough = star !== -1 || patternSegments.length >= segments.length;
      const prefix = (list: readonly string[]): string => list.slice(0, depth).join('/');
      if (enough && (depth <= 1 || globMatches(prefix(segments), prefix(patternSegments))))
        return true;
      if (
        globMatches(path, pat) ||
        globMatches(`${path}/x`, pat) ||
        (protectedPath.family === true && globMatches(`${path}.x`, pat))
      )
        return true;
      if (!walking) return false;
      for (let k = 2; k < segments.length; k += 1)
        if (globMatches(segments.slice(0, k).join('/'), pat)) return true;
      return false;
    });
  });
}

interface Reach {
  /** The word may name a directory that holds a protected path (a recursive reader walks into it). */
  readonly contains: boolean;
}

const unresolved = (word: string): string =>
  `${word} cannot be resolved here: a .. after a wildcard, or after a part that does not exist yet, could reach a protected path. Name the path plainly.`;

/** Whether a `..` follows a part with a wildcard. */
function climbsAfterGlob(word: string): boolean {
  const parts = word.split('/');
  const glob = parts.findIndex((part) => GLOB_CHARACTERS.test(part));
  return glob !== -1 && parts.slice(glob + 1).includes('..');
}

/** The word with `base` before it and its `..` kept, so each reading of it can be judged. */
function written(word: string, base: string): string {
  return isAbsolute(word) ? word : `${base}${sep}${word}`;
}

function reachRefusal(
  word: string,
  base: string | null,
  paths: readonly ProtectedPath[],
  reach: Reach,
): string | null {
  const target = base === null && !isAbsolute(word) ? null : written(word, base ?? '/');
  if (target === null) {
    // The working directory is unknown after a `cd` the guard cannot follow: a word that names a
    // protected path's last component is refused.
    const segments = lower(word).split('/');
    return paths.find((p) => segments.includes(lower(basename(p.path))))?.refusal ?? null;
  }
  // A `..` after a wildcard, or after a part that does not exist yet (a link the command makes
  // first may stand there), climbs from a place the guard cannot name.
  if (paths.length > 0 && isOverLongPath(target)) return OVER_LONG_PATH_REFUSAL;
  if (paths.length > 0 && (climbsAfterGlob(word) || !realPathReadings(target).complete))
    return unresolved(word);
  const glob = GLOB_CHARACTERS.test(word);
  for (const p of paths) {
    if (glob ? globReaches(target, p, reach.contains) : touches(p, target) || namesPath(word, p))
      return p.refusal;
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

const TAR_NAMES: ReadonlySet<string> = new Set(['tar', 'bsdtar', 'gtar']);
const RECURSIVE_READERS: ReadonlySet<string> = new Set(['rg', 'find', 'rsync', ...TAR_NAMES]);
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

/** Commands that run quoted code of their own, which may name a path the shell never sees as a word. */
function runsQuotedCode(command: readonly string[]): boolean {
  const head = command[0] ?? '';
  return head === 'ssh' || INTERPRETERS.has(head) || /^python3\.\d+$/.test(head);
}

/** Text with `$HOME`, `$USER` and a `~` after whitespace, a quote or `(` expanded, as code inside it would. */
function expandEmbedded(text: string): string {
  const variables = text.replace(
    /\$\{(?:HOME|USER|LOGNAME)\}|\$(?:HOME|USER|LOGNAME)(?![A-Za-z0-9_])/g,
    (found) => userVariable(found)?.value ?? found,
  );
  return variables.replace(
    /(^|[\s'"(`=])~([A-Za-z0-9_.-]*)(?=[/\s'")`]|$)/g,
    (_found, before: string, name: string) => before + homeOf(name),
  );
}

/** tar's mode letters: extract, create, list, append, update, diff and catenate. */
const TAR_MODE_LETTERS = 'xctruAd';
const TAR_MODES = /[xctruAd]/g;
/** Short options that take a value in GNU tar or bsdtar: the rest of their cluster, or the next word. */
const TAR_VALUE_LETTERS = 'bCfFgHIKLNsTVX';
const TAR_LONG_MODES: ReadonlySet<string> = new Set([
  '--create',
  '--list',
  '--append',
  '--update',
  '--diff',
  '--compare',
  '--delete',
  '--catenate',
  '--concatenate',
  '--test-label',
]);

/**
 * Whether tar extracts, from the first mode it is given: an old-style bundle such as `xzf`, a mode
 * letter in a `-…` cluster, `--extract` or `--get`, or another long mode. The values of options that
 * take one are skipped, and so is the word after any other long option without `=`, which may be its
 * value. With no mode before `--` or the end, it is not an extract.
 */
function tarExtracts(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--') return false;
    if (i === 0 && /^[A-Za-z]+$/.test(arg)) {
      const modes = arg.match(TAR_MODES) ?? [];
      return modes.length === 1 && modes[0] === 'x';
    }
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0] ?? arg;
      if (name === '--extract' || name === '--get') return true;
      if (TAR_LONG_MODES.has(name)) return false;
      if (!arg.includes('=')) i += 1;
      continue;
    }
    if (!arg.startsWith('-')) continue;
    for (let at = 1; at < arg.length; at += 1) {
      const letter = arg.charAt(at);
      if (TAR_MODE_LETTERS.includes(letter)) return letter === 'x';
      if (TAR_VALUE_LETTERS.includes(letter)) {
        if (at === arg.length - 1) i += 1;
        break;
      }
    }
  }
  return false;
}

/**
 * GNU cp names its destination with `-t`, alone or in a cluster, or with `--target-directory`,
 * however abbreviated.
 */
function namesTargetDirectory(arg: string): boolean {
  return /^-[^-]/.test(arg) ? arg.includes('t') : abbreviates(arg, '--target-directory');
}

/**
 * The index of the word a copy or extract writes to, which is not a source a walker reads. A copy has
 * one only with a destination operand after at least one source, and for cp no target directory; a
 * tar `-C` is one only when extracting, since a create reads from it.
 */
function destinationIndex(command: readonly string[], words: readonly string[]): number {
  const head = command[0] ?? '';
  const start = words.findIndex((w) => commandName(w) === head);
  const args = words.slice(start + 1);
  if (head === 'cp' || head === 'rsync') {
    // rsync's `-t` keeps modification times; it names no target.
    if (head === 'cp' && args.some(namesTargetDirectory)) return -1;
    const operands: number[] = [];
    for (let i = start + 1; i < words.length; i += 1) {
      if (!(words[i] ?? '').startsWith('-')) operands.push(i);
    }
    return operands.length >= 2 ? (operands[operands.length - 1] ?? -1) : -1;
  }
  if (TAR_NAMES.has(head) && tarExtracts(args)) {
    const flag = words.findIndex((w) => w === '-C' || w === '--directory');
    if (flag !== -1) return flag + 1;
  }
  return -1;
}

/**
 * A shell segment with a word that resolves onto a protected path from `cwd`, names one written out,
 * is a glob that can expand to one, or (for a recursive reader) names a directory that holds one;
 * a copy's or extract's destination is not a source. Text that merely mentions a path (a grep
 * pattern, a message) is not a word that names one. A command that runs quoted code (an interpreter,
 * ssh) also has the paths written inside its words and its nested scripts (code it reads from a
 * here-document) checked. `cwd` is null when the guard cannot name the directory.
 */
export function segmentPathRefusal(
  raw: string,
  command: readonly string[],
  cwd: string | null,
  paths: readonly ProtectedPath[],
  scripts: readonly string[] = [],
): string | null {
  const walks = walksDirectories(command);
  const code = runsQuotedCode(command);
  const words = shellWords(raw);
  const destination = destinationIndex(command, words);
  for (const [index, word] of words.entries()) {
    const reach = { contains: walks && index !== destination };
    // Brace expansion turns one word into several paths, as the shell does, so a path hidden in a
    // brace (`{~/.claude.json,}`) is judged. A `~` the braces reveal is expanded too; a word with
    // no brace keeps its spelling, so a quoted `~` mention stays unexpanded as before.
    const pieces = word.includes('{') ? (expandBraceWord(word) ?? [word]).map(expandTilde) : [word];
    for (const piece of pieces) {
      const tail = piece.includes('=') ? piece.slice(piece.indexOf('=') + 1).split(':') : [];
      const candidates = piece.startsWith('-') ? tail : [piece, ...tail];
      for (const candidate of candidates) {
        const refusal = reachRefusal(candidate, cwd, paths, reach);
        if (refusal) return refusal;
      }
    }
    if (code) {
      const text = expandEmbedded(word);
      const named = paths.find((p) => namesPath(text, p));
      if (named) return named.refusal;
    }
  }
  if (code) {
    for (const script of scripts) {
      const text = expandEmbedded(script);
      const named = paths.find((p) => namesPath(text, p));
      if (named) return named.refusal;
    }
  }
  return null;
}

/**
 * Where `cd`, `pushd` or `popd` goes from `cwd`; null when the target is not a plain path the guard
 * can follow, such as `popd`'s, which is on the directory stack.
 */
export function changedDirectory(
  raw: string,
  command: readonly string[],
  cwd: string | null,
): string | null {
  if (command[0] === 'popd') return null;
  const words = shellWords(raw);
  const target = words[words.findIndex((w) => commandName(w) === command[0]) + 1];
  if (target === undefined) return command[0] === 'cd' ? homedir() : null;
  if (target.startsWith('-') || /[$`*?[{]/.test(target)) return null;
  return cwd === null && !isAbsolute(target) ? null : resolve(cwd ?? '/', target);
}

/**
 * Whether a session's own saved tool output is what `value` names, on every reading (Claude Code
 * points the model at it).
 */
export function isOwnToolResult(
  session: { readonly configDir: string; readonly providerSessionId: string | null },
  value: string,
  baseDir: string,
): boolean {
  if (session.providerSessionId === null) return false;
  const path = written(expandTilde(value), baseDir);
  const parts = relative(session.configDir, resolve(path)).split(sep);
  const [projects, slug, id, results] = parts;
  if (projects !== 'projects' || slug === undefined || id !== session.providerSessionId)
    return false;
  if (results !== 'tool-results' || parts.includes('..')) return false;
  return isWithinOnEveryReading(
    join(session.configDir, 'projects', slug, id, 'tool-results'),
    path,
  );
}
