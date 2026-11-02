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
import {
  isOverLongPath,
  isWithin,
  isWithinOnEveryReading,
  OVER_LONG_PATH_REFUSAL,
  realPathReadings,
} from './paths';

/**
 * The resolved-path check on the file tools (Read, Grep, Glob, LS and the edit tools), which the
 * lane sandbox design keeps as part of the file-tool boundary
 * (`docs/architecture/03-trust-boundaries.md`). The guard no longer reads shell text for
 * credentials: Keychain commands, environment dumps, secret variables and protected paths in a
 * Bash command are the kernel sandbox's to deny (D12).
 */

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

function homeOf(name: string): string {
  const home = homedir();
  return name === '' || name === basename(home) ? home : join(dirname(home), name);
}

/** A `~` or `~name` at the start of the text, as the shell expands it. */
function expandTilde(text: string): string {
  const match = /^~([A-Za-z0-9_.-]*)(?=\/|$)/.exec(text);
  return match ? homeOf(match[1] ?? '') + text.slice(match[0].length) : text;
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
