import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDecoyRepo } from '../../test/decoy-repo';
import { createTempRepo, NETWORK_ENV, tempDir } from '../../test/fixtures';
import { createGh, GhError, systemGhExec, type GhCall, type GhExec } from './index';

const CALL: GhCall = { cwd: '/tmp', env: {}, timeoutMs: 5_000 };

/** A scripted exec: answers each call with the output for its first two arguments. */
function scripted(
  answers: Record<string, { exitCode: number; stdout?: string; stderr?: string } | GhError>,
) {
  const seen: (readonly string[])[] = [];
  const exec: GhExec = (args) => {
    seen.push(args);
    const answer = answers[args.slice(0, 2).join(' ')];
    if (answer === undefined) return Promise.reject(new Error(`unexpected gh ${args.join(' ')}`));
    if (answer instanceof GhError) return Promise.reject(answer);
    return Promise.resolve({ stdout: '', stderr: '', ...answer });
  };
  return { exec, seen };
}

describe('createGh', () => {
  it('passes a signed-in check and refuses a signed-out one', async () => {
    await expect(
      createGh(scripted({ 'auth status': { exitCode: 0 } }).exec).authStatus(CALL),
    ).resolves.toBeUndefined();
    await expect(
      createGh(
        scripted({
          'auth status': {
            exitCode: 1,
            stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login',
          },
        }).exec,
      ).authStatus(CALL),
    ).rejects.toMatchObject({ name: 'GhError', kind: 'signed_out' });
  });

  it.each([
    {
      name: 'the owner and name',
      answer: { exitCode: 0, stdout: '{"nameWithOwner":"acme/widgets"}\n' },
      expected: 'acme/widgets',
    },
    { name: 'output that is not JSON', answer: { exitCode: 0, stdout: 'oops' }, kind: 'failed' },
    {
      name: 'a name without an owner',
      answer: { exitCode: 0, stdout: '{"nameWithOwner":"widgets"}' },
      kind: 'failed',
    },
    {
      name: 'no GitHub remote',
      answer: {
        exitCode: 1,
        stderr:
          'none of the git remotes configured for this repository point to a known GitHub host',
      },
      kind: 'failed',
    },
    {
      name: 'authentication required',
      answer: { exitCode: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' },
      kind: 'signed_out',
    },
  ])('repoView: $name', async ({ answer, expected, kind }) => {
    const view = createGh(scripted({ 'repo view': answer }).exec).repoView(CALL);
    if (kind) await expect(view).rejects.toMatchObject({ kind });
    else await expect(view).resolves.toBe(expected);
  });

  it.each([
    {
      name: 'an open PR',
      answer: {
        exitCode: 0,
        stdout: '{"state":"OPEN","url":"https://github.com/acme/widgets/pull/7"}',
      },
      expected: { state: 'OPEN', url: 'https://github.com/acme/widgets/pull/7' },
    },
    {
      name: 'a merged PR',
      answer: {
        exitCode: 0,
        stdout: '{"state":"MERGED","url":"https://github.com/acme/widgets/pull/7"}',
      },
      expected: { state: 'MERGED', url: 'https://github.com/acme/widgets/pull/7' },
    },
    {
      name: 'no PR for the branch',
      answer: { exitCode: 1, stderr: 'no pull requests found for branch "10db/x-0a1b2c3d"' },
      expected: null,
    },
    {
      name: 'a signed-out gh',
      answer: { exitCode: 4, stderr: 'gh auth login' },
      kind: 'signed_out',
    },
    { name: 'any other failure', answer: { exitCode: 1, stderr: 'HTTP 502' }, kind: 'failed' },
  ])('prView: $name', async ({ answer, expected, kind }) => {
    const { exec, seen } = scripted({ 'pr view': answer });
    const view = createGh(exec).prView({ repo: 'acme/widgets', ref: '10db/x-0a1b2c3d' }, CALL);
    if (kind) await expect(view).rejects.toMatchObject({ kind });
    else await expect(view).resolves.toEqual(expected);
    expect(seen[0]).toEqual([
      'pr',
      'view',
      '10db/x-0a1b2c3d',
      '-R',
      'acme/widgets',
      '--json',
      'url,state',
    ]);
  });

  it('creates a PR with every value as its own argument and returns the URL gh prints', async () => {
    const { exec, seen } = scripted({
      'pr create': {
        exitCode: 0,
        stdout:
          'Creating pull request for 10db/x-0a1b2c3d into main\n\nhttps://github.com/acme/widgets/pull/8\n',
      },
    });
    const title = `feat(app): say "hi" and $(whoami)`;
    const url = await createGh(exec).prCreate(
      {
        repo: 'acme/widgets',
        base: 'main',
        head: '10db/x-0a1b2c3d',
        title,
        bodyFile: '/tmp/body.md',
      },
      CALL,
    );
    expect(url).toBe('https://github.com/acme/widgets/pull/8');
    expect(seen[0]).toEqual([
      'pr',
      'create',
      '-R',
      'acme/widgets',
      '--base',
      'main',
      '--head',
      '10db/x-0a1b2c3d',
      '--title',
      title,
      '--body-file',
      '/tmp/body.md',
    ]);
  });

  it('passes not-installed through from the exec', async () => {
    const missing = new GhError('not_installed', 'gh is not installed');
    await expect(createGh(scripted({ 'auth status': missing }).exec).authStatus(CALL)).rejects.toBe(
      missing,
    );
  });
});

describe('systemGhExec', () => {
  let bin: { path: string; cleanup(): void };
  beforeEach(() => {
    bin = tempDir('gh-bin');
  });
  afterEach(() => {
    bin.cleanup();
  });
  function fakeGh(script: string): void {
    mkdirSync(bin.path, { recursive: true });
    const path = join(bin.path, 'gh');
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
  }
  const call = (overrides: Partial<GhCall> = {}): GhCall => ({
    cwd: bin.path,
    env: { PATH: `${bin.path}:/usr/bin:/bin` },
    timeoutMs: 5_000,
    ...overrides,
  });

  it('turns prompts off whatever the environment says, and runs in the given directory', async () => {
    fakeGh('echo "$GH_PROMPT_DISABLED $GH_NO_UPDATE_NOTIFIER $GIT_TERMINAL_PROMPT $(pwd) $*"');
    const env = {
      PATH: `${bin.path}:/usr/bin:/bin`,
      GH_PROMPT_DISABLED: '0',
      GIT_TERMINAL_PROMPT: '1',
    };
    const out = await systemGhExec(['auth', 'status'], call({ env }));
    expect(out).toMatchObject({ exitCode: 0 });
    // macOS resolves /var to /private/var in pwd.
    expect(out.stdout.trim()).toMatch(
      new RegExp(`^1 1 0 \\S*${bin.path.split('/').pop() ?? ''} auth status$`),
    );
  });

  it('runs gh where the git it calls finds the repository it runs in, keeping git settings', async () => {
    // gh runs git in its working directory to read the remotes. A daemon started from a git hook
    // may have captured GIT_DIR and friends, which would aim that git at another repository.
    const repo = createTempRepo();
    const decoy = createDecoyRepo();
    try {
      fakeGh('git rev-parse --absolute-git-dir; echo "$GIT_SSH_COMMAND"');
      const env = {
        ...NETWORK_ENV,
        PATH: `${bin.path}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
        ...decoy.hookVariables,
        GIT_SSH_COMMAND: 'ssh -i key',
      };
      const out = await systemGhExec(['repo', 'view'], call({ cwd: repo.path, env }));
      expect(out).toMatchObject({ exitCode: 0 });
      expect(out.stdout).toBe(`${join(realpathSync(repo.path), '.git')}\nssh -i key\n`);
    } finally {
      decoy.cleanup();
      repo.cleanup();
    }
  });

  it('returns a non-zero exit with its stderr', async () => {
    fakeGh('echo "HTTP 502" >&2; exit 3');
    expect(await systemGhExec(['pr', 'view'], call())).toMatchObject({
      exitCode: 3,
      stderr: 'HTTP 502\n',
    });
  });

  it('reports gh missing from the PATH as not installed', async () => {
    // An empty directory, not /usr/bin: GitHub's Ubuntu runners ship /usr/bin/gh.
    const empty = tempDir('no-gh');
    try {
      await expect(
        systemGhExec(['auth', 'status'], call({ env: { PATH: empty.path } })),
      ).rejects.toMatchObject({ kind: 'not_installed' });
    } finally {
      empty.cleanup();
    }
  });

  it('times out a gh that hangs', async () => {
    fakeGh('sleep 5');
    await expect(systemGhExec(['pr', 'create'], call({ timeoutMs: 300 }))).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});
