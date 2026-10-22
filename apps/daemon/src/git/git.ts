import { execFile } from 'node:child_process';
import { isAbsolute, normalize, sep } from 'node:path';
import { promisify } from 'node:util';
import { InvalidError } from '@10db/contracts';
import { z } from 'zod';
import { resolveInRepo } from '../guard';
import { withoutGitRepoEnv } from './repo-env';

const run = promisify(execFile);

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const OP_TRAILER = '10db-Op';
const OP_SEARCH_DEPTH = 200;

class GitError extends Error {
  override readonly name = 'GitError';
  readonly args: readonly string[];
  readonly stderr: string;
  constructor(args: readonly string[], stderr: string) {
    super(`git ${args.join(' ')} failed: ${stderr.trim().slice(0, 500)}`);
    this.args = args;
    this.stderr = stderr;
  }
}

export interface Git {
  head(repo: string): Promise<string>;
  status(repo: string): Promise<{ code: string; path: string }[]>;
  /** Committed and uncommitted changes since `base`, sorted and unique. */
  changedFilesSince(repo: string, base: string): Promise<string[]>;
  commitsSince(repo: string, base: string): Promise<string[]>;
  commit(input: {
    repo: string;
    paths: readonly string[];
    message: string;
    opId: string;
  }): Promise<{ sha: string; alreadyCommitted: boolean }>;
}

async function git(repo: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', repo, ...args], {
      // -C names the repository; an inherited GIT_DIR or GIT_WORK_TREE would override it.
      // No optional locks: a read such as status would otherwise refresh the index under
      // index.lock, and a commit that runs meanwhile fails with "index.lock: File exists".
      env: {
        ...withoutGitRepoEnv(process.env),
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String(error.stderr)
        : String(error);
    const stdout =
      typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout) : '';
    throw new GitError(args, `${stderr}\n${stdout}`);
  }
}

async function revParseHead(repo: string): Promise<string> {
  return Sha.parse((await git(repo, ['rev-parse', 'HEAD'])).trim());
}

async function status(repo: string): Promise<{ code: string; path: string }[]> {
  // A repository's own config can name a core.fsmonitor program that git would run on every status.
  const out = await git(repo, [
    '-c',
    'core.fsmonitor=false',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  const fields = out.split('\0').filter(Boolean);
  const entries: { code: string; path: string }[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? '';
    entries.push({ code: entry.slice(0, 2), path: entry.slice(3) });
    // A rename or copy is followed by its source path as a bare field with no status code.
    if (entry.startsWith('R') || entry.startsWith('C') || entry[1] === 'R' || entry[1] === 'C') i++;
  }
  return entries;
}

/** Lexical checks first, then the guard's symlink-aware check, so `link/x` can't commit outside the repo. */
function checkPaths(repo: string, paths: readonly string[]): string[] {
  return paths.map((p) => {
    const clean = normalize(p);
    const lexicallyBad =
      p === '' || isAbsolute(p) || clean === '.' || clean === '..' || clean.startsWith(`..${sep}`);
    if (lexicallyBad || !resolveInRepo(repo, clean).inside) {
      throw new InvalidError(
        `Path ${JSON.stringify(p)} must be relative and inside the repository`,
      );
    }
    return clean;
  });
}

export function createGit(): Git {
  const locks = new Map<string, Promise<unknown>>();

  /** Runs `fn` after every earlier locked call for the same repo has settled. */
  function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(repo) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    locks.set(
      repo,
      next.catch(() => undefined),
    );
    return next;
  }

  async function findCommitByOp(repo: string, opId: string): Promise<string | null> {
    const out = await git(repo, [
      'log',
      '-n',
      String(OP_SEARCH_DEPTH),
      `--format=%H%x1f%(trailers:key=${OP_TRAILER},valueonly,separator=%x2c)%x1e`,
    ]);
    for (const record of out.split('\x1e')) {
      const [sha, ops] = record.trim().split('\x1f');
      if (
        sha &&
        ops
          ?.split(',')
          .map((o) => o.trim())
          .includes(opId)
      ) {
        return Sha.parse(sha);
      }
    }
    return null;
  }

  return {
    head: revParseHead,
    status,
    async changedFilesSince(repo, base) {
      const committed = (await git(repo, ['diff', '--name-only', `${base}..HEAD`]))
        .split('\n')
        .filter(Boolean);
      const working = (await status(repo)).map((s) => s.path);
      return [...new Set([...committed, ...working])].sort();
    },
    async commitsSince(repo, base) {
      return (await git(repo, ['rev-list', '--reverse', `${base}..HEAD`]))
        .split('\n')
        .filter(Boolean);
    },
    // async, so a rejected path becomes a rejected promise rather than a synchronous throw.
    async commit({ repo, paths, message, opId }) {
      const clean = checkPaths(repo, paths);
      return withRepoLock(repo, async () => {
        const existing = await findCommitByOp(repo, opId);
        if (existing) return { sha: existing, alreadyCommitted: true };
        try {
          await git(repo, ['add', '-A', '--', ...clean]);
        } catch (error) {
          if (error instanceof GitError && /pathspec .* did not match/i.test(error.stderr)) {
            throw new InvalidError(
              `No file or change at ${clean.join(', ')}: a path must exist or have been deleted since the last commit`,
            );
          }
          throw error;
        }
        try {
          await git(repo, [
            'commit',
            '-q',
            '-m',
            message,
            '--trailer',
            `${OP_TRAILER}: ${opId}`,
            '--',
            ...clean,
          ]);
        } catch (error) {
          if (
            error instanceof GitError &&
            /nothing (added )?to commit|no changes added/i.test(error.stderr)
          ) {
            throw new InvalidError(`Nothing to commit in ${clean.join(', ')}`);
          }
          throw error;
        }
        return { sha: await revParseHead(repo), alreadyCommitted: false };
      });
    },
  };
}
