import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGit, resolveGit, runPassGit } from '../src/git';
import { passGitCall } from '../src/guard';
import { silentLogger } from '../src/log';
import { resolveSandboxRuntime } from '../src/paths';
import {
  claimSandboxTempRoot,
  createGateSandbox,
  ensurePrivateRoot,
  laneTempRoot,
  type GateSandbox,
} from '../src/sandbox';
import { createTempRepo, isolatedGitEnv } from './fixtures';

/**
 * A pass's commit the builder allowed, under the real sandbox: the hooks it starts read files a
 * lane writes, so they run contained. Skipped where Seatbelt can't run or nest (see
 * `gate-sandbox.seatbelt.test.ts`).
 */
const SEATBELT = process.platform === 'darwin' && process.env['TENDB_SANDBOX'] !== '1';

describe.skipIf(!SEATBELT)("a pass's approved commit under the sandbox (Seatbelt)", () => {
  const token = randomBytes(8).toString('hex');
  // Outside the checkout, where a hook that ran as the builder could write.
  const outside = join(homedir(), `.10db-pass-git-${token}`);
  let root: string;
  let claim: ReturnType<typeof claimSandboxTempRoot>;
  let gate: GateSandbox;
  let gitBin: string;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync('/tmp/sbq-'));
    const tmpRoot = ensurePrivateRoot(laneTempRoot());
    claim = claimSandboxTempRoot(tmpRoot);
    mkdirSync(join(root, 'r'));
    const git = createGit();
    gate = createGateSandbox({
      home: homedir(),
      dataDir: join(homedir(), 'Library', 'Application Support', '10db'),
      loginConfigDir: null,
      gitDirs: (path) => git.gitDirs(path),
      tmpRoot,
      filesRoot: join(root, 'r'),
      codexLaneTempRoot: join(root, 'l'),
      log: silentLogger,
      runtime: resolveSandboxRuntime(),
    });
    gitBin = await resolveGit();
  });

  afterAll(() => {
    claim.release();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  });

  const env = (): Record<string, string> => ({
    ...Object.fromEntries(
      Object.entries(process.env).flatMap(([name, value]) =>
        value === undefined || name.startsWith('GIT_') ? [] : [[name, value]],
      ),
    ),
    ANTHROPIC_API_KEY: `sk-${token}`,
  });

  // Each row is a hook runner reading what a lane wrote: husky's `.husky/` (the builder's config
  // points git at it) and a builder's hook that runs a script from `node_modules/.bin`.
  // A merge runs its own hook (`pre-merge-commit`) and writes MERGE_HEAD and ORIG_HEAD beside it.
  it.each([
    ['husky', 'git config core.hooksPath .husky', '.husky/pre-commit', 'commit'],
    ['a hook that runs a lane-written bin', null, 'node_modules/.bin/lint', 'commit'],
    ["husky's merge hook", 'git config core.hooksPath .husky', '.husky/pre-merge-commit', 'merge'],
  ] as const)(
    'runs %s contained: nothing outside the checkout, and no hook, config, HEAD or other ref, is written',
    async (_name, setup, planted, verb) => {
      const repo = createTempRepo();
      try {
        const checkout = realpathSync(repo.path);
        const git = (...args: string[]) =>
          execFileSync('git', ['-C', checkout, ...args], {
            env: isolatedGitEnv(),
            encoding: 'utf8',
          }).trim();
        // Another lane's branch, and the session's own: `main`, where 10db lands the work, and the
        // other branch are not the ones it moves.
        git('switch', '-q', '-c', '10db/other');
        git('commit', '-q', '--allow-empty', '-m', 'other');
        git('switch', '-q', '-c', 'feat/page', 'main');
        if (setup !== null) git(...setup.split(' ').slice(1));
        else
          writeFileSync(
            join(checkout, '.git', 'hooks', 'pre-commit'),
            '#!/bin/sh\nexec node_modules/.bin/lint\n',
            { mode: 0o755 },
          );
        mkdirSync(join(checkout, planted, '..'), { recursive: true });
        // What the lane planted: it tries each escape, then marks that it ran.
        writeFileSync(
          join(checkout, planted),
          [
            '#!/bin/sh',
            `touch '${outside}' 2>/dev/null`,
            `printf '#!/bin/sh\\ntouch ${outside}\\n' > .git/hooks/post-commit 2>/dev/null`,
            "printf '[core]\\n\\thooksPath = /tmp\\n' >> .git/config 2>/dev/null",
            'touch .git/commondir 2>/dev/null',
            'echo 0000000000000000000000000000000000000000 > .git/refs/heads/main 2>/dev/null',
            'echo 0000000000000000000000000000000000000000 > .git/refs/heads/10db/other 2>/dev/null',
            // Switching the pass onto `main` would open its ref to the next approved commit.
            "printf 'ref: refs/heads/main\\n' > .git/HEAD 2>/dev/null",
            'mkdir .git/rebase-merge .git/rebase-apply .git/sequencer 2>/dev/null',
            'env > hook-env.txt',
            'exit 0',
            '',
          ].join('\n'),
          { mode: 0o755 },
        );
        const before = git('rev-parse', 'HEAD');
        const main = git('rev-parse', 'refs/heads/main');
        const other = git('rev-parse', 'refs/heads/10db/other');
        const config = git('config', '--local', '--list');
        const call = passGitCall(
          verb === 'commit'
            ? 'git commit --allow-empty -m contained'
            : 'git merge --no-ff -m contained 10db/other',
          'main',
        );
        if (call?.kind !== 'run') throw new Error('not a call a pass runs');
        const ran = await runPassGit(call, {
          checkout,
          baseBranch: 'main',
          env: env(),
          signal: new AbortController().signal,
          bins: { git: gitBin, gh: null },
          sandbox: {
            gate,
            input: {
              project: { repoPath: checkout, sandboxLoopback: false, sandboxDocker: false },
              env: env(),
              rules: [],
              checkouts: [checkout],
            },
            home: homedir(),
          },
        });
        expect(ran, JSON.stringify(ran)).toMatchObject({ exitCode: 0 });
        // The hook ran, inside the checkout, and the commit landed in the git dir.
        expect(existsSync(join(checkout, 'hook-env.txt'))).toBe(true);
        expect(git('rev-parse', 'HEAD')).not.toBe(before);
        expect(git('log', '-1', '--format=%s')).toBe('contained');
        // Nothing it tried past that held.
        expect(existsSync(outside)).toBe(false);
        expect(existsSync(join(checkout, '.git', 'hooks', 'post-commit'))).toBe(false);
        expect(existsSync(join(checkout, '.git', 'commondir'))).toBe(false);
        expect(git('rev-parse', 'refs/heads/main')).toBe(main);
        expect(git('rev-parse', 'refs/heads/10db/other')).toBe(other);
        expect(git('symbolic-ref', 'HEAD')).toBe('refs/heads/feat/page');
        for (const dir of ['rebase-merge', 'rebase-apply', 'sequencer'])
          expect(existsSync(join(checkout, '.git', dir)), dir).toBe(false);
        expect(git('config', '--local', '--list')).toBe(config);
        expect(
          execFileSync('cat', [join(checkout, 'hook-env.txt')], { encoding: 'utf8' }),
        ).not.toContain(token);
      } finally {
        repo.cleanup();
      }
    },
    60_000,
  );
});
