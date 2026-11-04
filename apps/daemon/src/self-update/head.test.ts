import { describe, expect, it } from 'vitest';
import type { GhExec, GhOutput } from '../github';
import { githubHeadOfMain, githubMainIsAhead } from './head';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const call = () => ({ env: {}, timeoutMs: 1000 });

function exec(output: Partial<GhOutput>): { run: GhExec; args: () => readonly string[] } {
  let seen: readonly string[] = [];
  return {
    run: (args) => {
      seen = args;
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', ...output });
    },
    args: () => seen,
  };
}

describe('githubHeadOfMain', () => {
  it('asks GitHub for main of the repository and returns the commit', async () => {
    const gh = exec({ stdout: `${A}\n` });
    expect(await githubHeadOfMain(gh.run, call)('o/10db')).toBe(A);
    expect(gh.args()).toEqual(['api', 'repos/o/10db/commits/main', '--jq', '.sha']);
  });

  it.each([
    { name: 'gh fails', output: { exitCode: 1, stderr: 'no route' } },
    { name: 'it answers something that is no commit', output: { stdout: '<html>sign in</html>' } },
  ])('rejects when $name', async ({ output }) => {
    await expect(githubHeadOfMain(exec(output).run, call)('o/10db')).rejects.toThrow();
  });

  it('rejects a repository name gh could read as an option, without asking', async () => {
    const gh = exec({ stdout: A });
    await expect(githubHeadOfMain(gh.run, call)('--hostname=x/y')).rejects.toThrow('not a GitHub');
    expect(gh.args()).toEqual([]);
  });

  it.each([
    {
      name: 'gh is signed out',
      output: { exitCode: 4, stderr: 'To get started with GitHub CLI, please run: gh auth login' },
      kind: 'signed_out',
    },
    {
      name: 'the machine is offline',
      output: { exitCode: 1, stderr: 'error connecting to api.github.com' },
      kind: 'unreachable',
    },
    {
      name: 'GitHub answers 404',
      output: { exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' },
      kind: 'failed',
    },
    {
      name: 'GitHub rate limits',
      output: { exitCode: 1, stderr: 'gh: API rate limit exceeded (HTTP 403)' },
      kind: 'failed',
    },
    { name: 'it answers no commit', output: { stdout: '<html>' }, kind: 'failed' },
  ])('rejects with gh’s own class of failure when $name', async ({ output, kind }) => {
    await expect(githubHeadOfMain(exec(output).run, call)('o/10db')).rejects.toMatchObject({
      name: 'GhError',
      kind,
    });
  });
});

describe('githubMainIsAhead', () => {
  it.each([
    ['ahead', true],
    ['behind', false],
    ['identical', false],
    ['diverged', false],
  ])('answers %s for a comparison that says so', async (status, expected) => {
    const gh = exec({ stdout: `${status}\n` });
    expect(await githubMainIsAhead(gh.run, call)('o/10db', A, B)).toBe(expected);
    expect(gh.args()).toEqual(['api', `repos/o/10db/compare/${A}...${B}`, '--jq', '.status']);
  });

  it('answers false for a commit GitHub does not have, as a build nobody pushed is', async () => {
    const gh = exec({ exitCode: 1, stderr: 'gh: No commit found for SHA (HTTP 404)' });
    expect(await githubMainIsAhead(gh.run, call)('o/10db', A, B)).toBe(false);
  });

  it.each([
    { name: 'gh cannot reach GitHub', output: { exitCode: 1, stderr: 'dial tcp: no route' } },
    { name: 'GitHub answers something else', output: { stdout: 'maybe' } },
  ])('rejects when $name, so the check is tried again', async ({ output }) => {
    await expect(githubMainIsAhead(exec(output).run, call)('o/10db', A, B)).rejects.toThrow();
  });

  it.each([
    {
      name: 'gh is signed out',
      output: { exitCode: 4, stderr: 'gh auth login' },
      kind: 'signed_out',
    },
    {
      name: 'it cannot connect',
      output: { exitCode: 1, stderr: 'dial tcp: i/o timeout' },
      kind: 'unreachable',
    },
    { name: 'GitHub rate limits', output: { exitCode: 1, stderr: 'HTTP 403' }, kind: 'failed' },
    { name: 'it answers no comparison', output: { stdout: 'maybe' }, kind: 'failed' },
  ])('rejects with gh’s own class of failure when $name', async ({ output, kind }) => {
    await expect(githubMainIsAhead(exec(output).run, call)('o/10db', A, B)).rejects.toMatchObject({
      name: 'GhError',
      kind,
    });
  });

  it('rejects commits that are not full SHAs, without asking', async () => {
    const gh = exec({ stdout: 'ahead' });
    await expect(githubMainIsAhead(gh.run, call)('o/10db', 'main', B)).rejects.toThrow('SHA');
    expect(gh.args()).toEqual([]);
  });
});
