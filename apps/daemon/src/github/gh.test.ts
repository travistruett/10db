import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDecoyRepo } from '../../test/decoy-repo';
import { createTempRepo, NETWORK_ENV, tempDir } from '../../test/fixtures';
import { realGit } from '../../test/git-wrapper';
import {
  createGh,
  createSystemGhExec,
  GhError,
  resolveGh,
  type GhCall,
  type GhExec,
} from './index';

const CALL: GhCall = { env: {}, timeoutMs: 5_000 };

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
      name: 'signed in',
      answer: { exitCode: 0, stdout: 'octocat\n' },
      expected: 'octocat',
    },
    {
      name: 'signed out by message',
      answer: { exitCode: 1, stderr: 'To get started with GitHub CLI, please run:  gh auth login' },
      expected: null,
    },
    {
      name: 'signed out by exit 4',
      answer: { exitCode: 4, stderr: '' },
      expected: null,
    },
    {
      name: 'no login in the answer',
      answer: { exitCode: 0, stdout: 'null\n' },
      kind: 'failed',
    },
    {
      name: 'several lines',
      answer: { exitCode: 0, stdout: 'octocat\nhubot\n' },
      kind: 'failed',
    },
    {
      name: 'timeout',
      answer: new GhError('timeout', 'gh api user gave no answer within 120 s'),
      kind: 'timeout',
    },
    {
      name: 'GitHub out of reach, which is not a sign-out',
      answer: { exitCode: 1, stderr: 'dial tcp: no such host' },
      kind: 'unreachable',
    },
    {
      name: 'a failure that is not a sign-out',
      answer: { exitCode: 1, stderr: 'HTTP 502' },
      kind: 'failed',
    },
  ])('authLogin: $name', async ({ answer, expected, kind }) => {
    const { exec, seen } = scripted({ 'api user': answer });
    const login = createGh(exec).authLogin(CALL);
    if (kind === undefined) await expect(login).resolves.toBe(expected);
    else await expect(login).rejects.toMatchObject({ name: 'GhError', kind });
    expect(seen).toEqual([['api', 'user', '--jq', '.login']]);
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

  it.each([
    {
      name: 'a trailing https line that is not a pull request',
      stdout: 'https://github.com/acme/widgets/pull/8\nhttps://github.com/notices/upgrade\n',
      url: 'https://github.com/acme/widgets/pull/8',
    },
    {
      name: 'an Enterprise host',
      stdout: 'https://git.acme.dev/acme/widgets/pull/9\n',
      url: 'https://git.acme.dev/acme/widgets/pull/9',
    },
    { name: 'only a non-pull-request https line', stdout: 'https://github.com/acme/widgets\n' },
    {
      name: "another repository's pull request",
      stdout: 'https://github.com/acme/gadgets/pull/8\n',
    },
    { name: 'a pull request over http', stdout: 'http://github.com/acme/widgets/pull/8\n' },
    {
      name: 'a pull request number that is not one',
      stdout: 'https://github.com/acme/widgets/pull/x\n',
    },
  ])('reads the pull request URL gh pr create prints: $name', async ({ stdout, url }) => {
    const { exec } = scripted({ 'pr create': { exitCode: 0, stdout } });
    const created = createGh(exec).prCreate(
      { repo: 'acme/widgets', base: 'main', head: '10db/x-0a1b2c3d', title: 't', bodyFile: '/b' },
      CALL,
    );
    if (url) await expect(created).resolves.toBe(url);
    else
      await expect(created).rejects.toMatchObject({
        name: 'GhError',
        kind: 'failed',
        message: 'gh pr create printed no pull request URL for acme/widgets',
      });
  });

  it('asks the repository whether it lets pull requests merge by themselves', async () => {
    const yes = scripted({ 'repo view': { exitCode: 0, stdout: '{"autoMergeAllowed":true}\n' } });
    await expect(createGh(yes.exec).repoAllowsAutoMerge('acme/widgets', CALL)).resolves.toBe(true);
    expect(yes.seen[0]).toEqual(['repo', 'view', 'acme/widgets', '--json', 'autoMergeAllowed']);
    const no = scripted({ 'repo view': { exitCode: 0, stdout: '{"autoMergeAllowed":false}' } });
    await expect(createGh(no.exec).repoAllowsAutoMerge('acme/widgets', CALL)).resolves.toBe(false);
    const odd = scripted({ 'repo view': { exitCode: 0, stdout: '{"other":1}' } });
    await expect(
      createGh(odd.exec).repoAllowsAutoMerge('acme/widgets', CALL),
    ).rejects.toMatchObject({ name: 'GhError', kind: 'failed' });
  });

  it('turns on squash auto-merge for a pull request, naming everything as its own argument', async () => {
    const { exec, seen } = scripted({ 'pr merge': { exitCode: 0 } });
    await createGh(exec).prAutoMerge(
      { repo: 'acme/widgets', url: 'https://github.com/acme/widgets/pull/8' },
      CALL,
    );
    expect(seen[0]).toEqual([
      'pr',
      'merge',
      'https://github.com/acme/widgets/pull/8',
      '-R',
      'acme/widgets',
      '--auto',
      '--squash',
    ]);
  });

  it.each([
    {
      name: 'a repository that does not allow it',
      stderr: 'GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)',
      kind: 'failed',
    },
    {
      name: 'a pull request with nothing to wait for',
      stderr: 'GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)',
      kind: 'failed',
    },
    {
      name: 'a signed-out gh',
      stderr: 'To get started with GitHub CLI, run: gh auth login',
      kind: 'signed_out',
    },
  ])('refuses auto-merge as a typed error: $name', async ({ stderr, kind }) => {
    const { exec } = scripted({ 'pr merge': { exitCode: 1, stderr } });
    await expect(
      createGh(exec).prAutoMerge(
        { repo: 'acme/widgets', url: 'https://github.com/acme/widgets/pull/8' },
        CALL,
      ),
    ).rejects.toMatchObject({ name: 'GhError', kind });
  });

  it('passes not-installed through from the exec', async () => {
    const missing = new GhError('not_installed', 'gh is not installed');
    await expect(createGh(scripted({ 'auth status': missing }).exec).authStatus(CALL)).rejects.toBe(
      missing,
    );
  });
});

describe('createSystemGhExec', () => {
  let bin: { path: string; cleanup(): void };
  beforeEach(() => {
    bin = tempDir('gh-bin');
  });
  afterEach(() => {
    bin.cleanup();
  });
  function fakeGh(script: string, dir = bin.path): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'gh');
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return path;
  }
  /** Runs the fake gh in `bin`, with the git the daemon resolved. */
  const systemGhExec: GhExec = (args, c) =>
    createSystemGhExec({ gh: join(bin.path, 'gh'), git: realGit() })(args, c);
  const call = (overrides: Partial<GhCall> = {}): GhCall => ({
    env: { PATH: '/usr/bin:/bin' },
    timeoutMs: 5_000,
    ...overrides,
  });

  it('turns prompts off whatever the environment says', async () => {
    fakeGh('echo "$GH_PROMPT_DISABLED $GH_NO_UPDATE_NOTIFIER $GIT_TERMINAL_PROMPT $*"');
    const env = {
      PATH: '/usr/bin:/bin',
      GH_PROMPT_DISABLED: '0',
      GIT_TERMINAL_PROMPT: '1',
    };
    const out = await systemGhExec(['auth', 'status'], call({ env }));
    expect(out).toMatchObject({ exitCode: 0 });
    expect(out.stdout.trim()).toBe('1 1 0 auth status');
  });

  it('runs gh in an empty directory of its own, where no git finds a repository', async () => {
    fakeGh('pwd; ls -A | wc -l; git rev-parse --git-dir 2>/dev/null || echo no-repository');
    const env = NETWORK_ENV;
    const out = await systemGhExec(['pr', 'view'], call({ env }));
    const [dir = '', count = '', repo = ''] = out.stdout.trim().split('\n');
    expect(dir).toMatch(/10db-gh-/);
    expect(count.trim()).toBe('0');
    expect(repo).toBe('no-repository');
  });

  it("drops a hook's repository variables and keeps git settings", async () => {
    // A daemon started from a git hook may have captured GIT_DIR and friends, which would aim any
    // git gh runs at another repository.
    const decoy = createDecoyRepo();
    try {
      fakeGh('echo "${GIT_DIR:-none} $GIT_SSH_COMMAND"');
      const env = {
        ...NETWORK_ENV,
        ...decoy.hookVariables,
        GIT_SSH_COMMAND: 'ssh -i key',
      };
      const out = await systemGhExec(['pr', 'view'], call({ env }));
      expect(out).toMatchObject({ exitCode: 0 });
      expect(out.stdout).toBe('none ssh -i key\n');
    } finally {
      decoy.cleanup();
    }
  });

  it('turns hooks and fsmonitor off for the git gh runs, keeping the login config', async () => {
    const repo = createTempRepo();
    try {
      fakeGh(
        `cd '${repo.path}' && git config core.hooksPath; git config core.fsmonitor; git config user.name`,
      );
      const env = {
        ...NETWORK_ENV,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'user.name',
        GIT_CONFIG_VALUE_0: 'builder',
      };
      const out = await systemGhExec(['pr', 'view'], call({ env }));
      expect(out.stdout).toBe('/dev/null\nfalse\nbuilder\n');
    } finally {
      repo.cleanup();
    }
  });

  it.each(['DEVELOPER_DIR', 'SDKROOT', 'TOOLCHAINS'])(
    "drops %s, so any git gh runs through Xcode's shim is the one the daemon probed",
    async (name) => {
      fakeGh(`echo "\${${name}-unset}"`);
      const out = await systemGhExec(
        ['pr', 'view'],
        call({ env: { ...NETWORK_ENV, [name]: '/nonexistent/Xcode.app' } }),
      );
      expect(out.stdout).toBe('unset\n');
    },
  );

  it('returns a non-zero exit with its stderr', async () => {
    fakeGh('echo "HTTP 502" >&2; exit 3');
    expect(await systemGhExec(['pr', 'view'], call())).toMatchObject({
      exitCode: 3,
      stderr: 'HTTP 502\n',
    });
  });

  it('runs the gh it was given, never one on PATH', async () => {
    const ran = join(bin.path, 'path-gh-ran');
    const onPath = join(bin.path, 'on-path');
    fakeGh(`touch '${ran}'`, onPath);
    fakeGh('echo given');
    const out = await systemGhExec(['auth', 'status'], call({ env: { PATH: onPath } }));
    expect(out.stdout).toBe('given\n');
    expect(existsSync(ran)).toBe(false);
  });

  it("puts the resolved git's directory first on gh's PATH, so any git it runs is that one", async () => {
    const resolved = join(bin.path, 'resolved');
    const other = join(bin.path, 'other');
    for (const dir of [resolved, other]) {
      mkdirSync(dir, { recursive: true });
      symlinkSync(realGit(), join(dir, 'git'));
    }
    const gh = fakeGh('command -v git', join(bin.path, 'gh-dir'));
    const out = await createSystemGhExec({ gh, git: join(resolved, 'git') })(
      ['pr', 'view'],
      call({ env: { PATH: `${other}:/usr/bin:/bin` } }),
    );
    expect(out.stdout).toBe(`${join(resolved, 'git')}\n`);
  });

  it('reports a gh found in no install prefix as not installed', async () => {
    const answer = createSystemGhExec({ gh: null, git: realGit() })(['auth', 'status'], call());
    await expect(answer).rejects.toMatchObject({ kind: 'not_installed' });
    await expect(answer).rejects.toThrow(
      '10db found no gh in /opt/homebrew/bin, /usr/local/bin and /usr/bin.',
    );
  });

  it('times out a gh that hangs', async () => {
    fakeGh('sleep 5');
    await expect(systemGhExec(['pr', 'create'], call({ timeoutMs: 300 }))).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it.each([
    { name: 'gh still running', script: 'yes x | head -c 5000000; sleep 5' },
    { name: 'gh already exited', script: 'yes x | head -c 5000000' },
  ])(
    'reports output over the limit as a failure, not a timeout or an exit code: $name',
    async ({ script }) => {
      fakeGh(script);
      const answer = systemGhExec(['pr', 'view'], call());
      await expect(answer).rejects.toMatchObject({ kind: 'failed' });
      await expect(answer).rejects.toThrow(/^gh pr view printed more than 4 MB/);
    },
  );
});

describe('resolveGh', () => {
  let dir: { path: string; cleanup(): void };
  beforeEach(() => {
    dir = tempDir('gh-prefixes');
  });
  afterEach(() => {
    dir.cleanup();
  });
  function place(sub: string, mode = 0o755): string {
    mkdirSync(join(dir.path, sub), { recursive: true });
    const path = join(dir.path, sub, 'gh');
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, mode);
    return path;
  }

  it.each([
    {
      name: 'takes the first executable candidate, skipping one that is not executable',
      setup: () => {
        place('a', 0o644);
        return { candidates: ['a', 'b', 'c'], expected: place('b') };
      },
    },
    {
      name: 'keeps a link as found, so an upgrade that repoints it changes nothing',
      setup: () => {
        const target = place('cellar');
        mkdirSync(join(dir.path, 'prefix'));
        const link = join(dir.path, 'prefix', 'gh');
        symlinkSync(target, link);
        return { candidates: ['prefix', 'cellar'], expected: link };
      },
    },
    {
      name: 'finds none when no candidate exists',
      setup: () => ({ candidates: ['a', 'b'], expected: null }),
    },
  ])('$name', ({ setup }) => {
    const { candidates, expected } = setup();
    expect(resolveGh(candidates.map((sub) => join(dir.path, sub, 'gh')))).toBe(expected);
  });

  it('looks only in the fixed install prefixes, never PATH', () => {
    const onPath = place('path');
    const found = resolveGh();
    expect(found).not.toBe(onPath);
    if (found !== null)
      expect(['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']).toContain(found);
  });
});
