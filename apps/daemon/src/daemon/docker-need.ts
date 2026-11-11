import { posix } from 'node:path';
import type { ProjectDto } from '@10db/contracts';
import type { Git } from '../git';

/** The most of a Makefile or script read from the base to see whether a gate calls docker. */
export const MAX_DOCKER_SCAN_BYTES = 256 * 1024;

/** Reads a repository file as text, or null when it is absent; paths are relative to the repository root. */
export type ReadRepoFile = (path: string) => Promise<string | null>;

// `docker`, `docker-compose` and `docker compose` as a command; not `dockerfile`, `.dockerignore`
// or a directory named `docker/`.
const DOCKER = /(?<![\w.-])docker(?:-compose)?(?![\w./-])/;
const MAKEFILES = ['Makefile', 'makefile', 'GNUmakefile'];
const MAKE_CALL = /(?:^|[\s;&|(])(?:\$\(MAKE\)|make)(?=\s|$)([^\n;&|)]*)/g;
const SCRIPT_TOKEN = /(?:^|[\s;&|(])(\.\/[\w@./-]+|[\w@./-]+\.(?:sh|bash))(?=$|[\s;&|)])/g;
const CD_DIR = /(?:^|[\s;&|(])cd\s+([\w@./-]+)/g;
const MAX_DEPTH = 4;
const MAX_READS = 24;

/** The text without the lines that are only a comment (a recipe's too, whatever its prefix). */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*[@+-]*\s*#/.test(line))
    .join('\n');
}

/** `rel` under `dir`, or null when it leaves the repository or is absolute. */
function within(dir: string, rel: string): string | null {
  if (rel.startsWith('/')) return null;
  const joined = posix.normalize(posix.join(dir, rel));
  return joined === '..' || joined.startsWith('../') ? null : joined.replace(/^\.\/?/, '');
}

interface MakeRule {
  readonly prerequisites: readonly string[];
  readonly recipe: string;
}

/** The rules of one Makefile by target name; a target named twice keeps both recipes. */
function parseRules(text: string): Map<string, MakeRule[]> {
  const rules = new Map<string, MakeRule[]>();
  let current: { names: string[]; prerequisites: string[]; recipe: string[] } | null = null;
  const close = (): void => {
    if (current === null) return;
    const rule = { prerequisites: current.prerequisites, recipe: current.recipe.join('\n') };
    for (const name of current.names) rules.set(name, [...(rules.get(name) ?? []), rule]);
    current = null;
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('\t')) {
      current?.recipe.push(line);
      continue;
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    close();
    const head = /^([^\s:=#][^:=#]*):(?!=)([^=]*)$/.exec(line.replace(/#.*$/, ''));
    if (head === null) continue;
    current = {
      names: (head[1] ?? '').trim().split(/\s+/),
      // What follows `|` is order-only and needs no scan.
      prerequisites: (head[2] ?? '')
        .split('|', 1)
        .flatMap((normal) => normal.trim().split(/\s+/))
        .filter((name) => name !== ''),
      recipe: [],
    };
  }
  close();
  return rules;
}

/**
 * Whether a gate command is seen to call Docker: it says so itself, or the Makefile target or script
 * it runs does, followed a few levels deep (`make -C dir target`, `$(MAKE)`, the targets a target
 * needs, a script named in a recipe). `read` is given repository-relative paths; the caller reads the
 * committed base, never the working tree, which a lane can write: a lane's own edit must not be what
 * turns Docker on. A path that leaves the repository is not followed. Comments are not read.
 */
export async function callsDocker(command: string, read: ReadRepoFile): Promise<boolean> {
  // What was visited (targets), and each file read once, so a loop ends and a long chain is bounded.
  const seen = new Set<string>();
  const files = new Map<string, string | null>();
  const readOnce = async (path: string): Promise<string | null> => {
    if (files.has(path)) return files.get(path) ?? null;
    if (files.size >= MAX_READS) return null;
    const text = await read(path);
    files.set(path, text);
    return text;
  };

  async function scanText(text: string, dir: string, depth: number): Promise<boolean> {
    const code = withoutComments(text);
    if (DOCKER.test(code)) return true;
    if (depth >= MAX_DEPTH) return false;
    // The directories a command line says it works in: its own, and each `cd` in it.
    const dirs = [dir, ...[...code.matchAll(CD_DIR)].map((m) => within(dir, m[1] ?? ''))].filter(
      (d): d is string => d !== null,
    );
    for (const call of code.matchAll(MAKE_CALL)) {
      const words = (call[1] ?? '')
        .trim()
        .split(/\s+/)
        .filter((w) => w !== '');
      let makeDir = dir;
      const targets: string[] = [];
      for (let i = 0; i < words.length; i++) {
        const word = words[i] ?? '';
        if (word === '-C' || word === '--directory') {
          makeDir = within(dir, words[++i] ?? '') ?? makeDir;
        } else if (word.startsWith('--directory=')) {
          makeDir = within(dir, word.slice('--directory='.length)) ?? makeDir;
        } else if (!word.startsWith('-') && !word.includes('=')) {
          targets.push(word);
        }
      }
      for (const target of targets) if (await scanTarget(makeDir, target, depth + 1)) return true;
    }
    for (const token of code.matchAll(SCRIPT_TOKEN)) {
      for (const base of dirs) {
        const path = within(base, token[1] ?? '');
        if (path === null) continue;
        const script = await readOnce(path);
        if (script !== null && (await scanText(script, posix.dirname(path), depth + 1)))
          return true;
      }
    }
    return false;
  }

  async function scanTarget(dir: string, target: string, depth: number): Promise<boolean> {
    if (depth > MAX_DEPTH) return false;
    let rules: Map<string, MakeRule[]> | null = null;
    for (const name of MAKEFILES) {
      const path = within(dir, name);
      const text = path === null ? null : await readOnce(path);
      if (text !== null) {
        rules = parseRules(text);
        break;
      }
    }
    const key = `target:${dir}:${target}`;
    if (rules === null || seen.has(key)) return false;
    seen.add(key);
    for (const rule of rules.get(target) ?? []) {
      if (await scanText(rule.recipe, dir, depth)) return true;
      for (const needed of rule.prerequisites)
        if (await scanTarget(dir, needed, depth + 1)) return true;
    }
    return false;
  }

  return scanText(command, '', 0);
}

/**
 * The commit `refs/remotes/origin/<base>` is at, found by that exact name (`Git.remoteTrackingCommit`),
 * or null when there is none. Never a guessed name: git takes a local branch or tag named
 * `origin/<base>`, or `refs/remotes/origin/<base>` under `refs/heads/`, for a short or missing one,
 * and a lane can make either.
 */
export async function originBaseCommit(
  git: Git,
  repoPath: string,
  baseBranch: string,
): Promise<string | null> {
  try {
    return await git.remoteTrackingCommit(repoPath, baseBranch);
  } catch {
    return null;
  }
}

/**
 * Whether the project's gate is seen to call Docker in `origin/<base>`, as the auto switch reads it
 * before a gate runs (`callsDocker`), its files read from the remote-tracking branch's commit only;
 * with no such branch only the command's own text, the builder's, counts. False with no gate and
 * when git can't say.
 */
export async function gateCallsDocker(
  git: Git,
  project: Pick<ProjectDto, 'repoPath' | 'baseBranch' | 'gateCommand'>,
): Promise<boolean> {
  if (project.gateCommand === null) return false;
  const commit = await originBaseCommit(git, project.repoPath, project.baseBranch);
  const read: ReadRepoFile = async (path) => {
    // With no remote-tracking commit no file is read: only the command's own text counts.
    if (commit === null) return null;
    try {
      const file = await git.fileAt(project.repoPath, commit, path, MAX_DOCKER_SCAN_BYTES);
      return file.kind === 'file' ? file.text : null;
    } catch {
      return null;
    }
  };
  try {
    return await callsDocker(project.gateCommand, read);
  } catch {
    return false;
  }
}
