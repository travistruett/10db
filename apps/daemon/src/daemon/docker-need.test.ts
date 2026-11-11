import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempRepoWithOrigin, isolatedGitEnv } from '../../test/fixtures';
import { createGit } from '../git';
import { callsDocker, gateCallsDocker } from './docker-need';

/** A reader over an in-memory tree; a path not in it is absent. */
const tree =
  (files: Record<string, string>) =>
  (path: string): Promise<string | null> =>
    Promise.resolve(files[path] ?? null);

describe('callsDocker', () => {
  it('sees docker in the gate command itself', async () => {
    expect(await callsDocker('docker compose exec -T backend pytest', tree({}))).toBe(true);
    expect(await callsDocker('docker-compose run --rm app make test', tree({}))).toBe(true);
  });

  it('sees nothing in a command that does not call it', async () => {
    expect(await callsDocker('pnpm test', tree({}))).toBe(false);
    expect(await callsDocker('make gate', tree({ Makefile: 'gate:\n\tpnpm test\n' }))).toBe(false);
  });

  it('does not take a word that merely starts with docker for the CLI', async () => {
    expect(await callsDocker('cat dockerfile.txt .dockerignore', tree({}))).toBe(false);
  });

  it('reads the Makefile target the gate command names', async () => {
    const files = {
      Makefile: [
        'lint:',
        '\truff check .',
        '',
        'gate: lint',
        '\tcd amps/backend && ./gate.sh',
        '',
      ].join('\n'),
      'amps/backend/gate.sh':
        '#!/bin/sh\nset -e\ndocker compose exec -T backend ruff check .\ndocker compose exec -T backend pytest\n',
    };
    expect(await callsDocker('make gate', tree(files))).toBe(true);
  });

  it('sees docker in a recipe line of the target or of a target it needs', async () => {
    const own = tree({ Makefile: 'gate:\n\tdocker compose exec -T backend pytest\n' });
    expect(await callsDocker('make gate', own)).toBe(true);
    const needed = tree({
      Makefile: 'gate: backend-test\n\techo done\n\nbackend-test:\n\tdocker compose run app t\n',
    });
    expect(await callsDocker('make gate', needed)).toBe(true);
  });

  it('follows make -C into the directory’s Makefile', async () => {
    const files = {
      Makefile: 'gate:\n\t$(MAKE) -C amps/backend gate\n',
      'amps/backend/Makefile': 'gate:\n\tdocker compose exec -T backend pytest\n',
    };
    expect(await callsDocker('make gate', tree(files))).toBe(true);
    expect(await callsDocker('make -C amps/backend gate', tree(files))).toBe(true);
  });

  it('ignores a comment that only mentions docker', async () => {
    const files = {
      Makefile: '# runs in docker on CI\ngate:\n\t# docker is not used here\n\tpnpm test\n',
    };
    expect(await callsDocker('make gate', tree(files))).toBe(false);
  });

  it('reads a script the gate command runs directly', async () => {
    const files = { 'scripts/gate.sh': 'docker compose up -d\npnpm test\n' };
    expect(await callsDocker('./scripts/gate.sh', tree(files))).toBe(true);
    expect(await callsDocker('bash scripts/gate.sh', tree(files))).toBe(true);
    expect(await callsDocker('./scripts/other.sh', tree(files))).toBe(false);
  });

  it('stops following targets that call each other in a loop', async () => {
    const files = { Makefile: 'a: b\n\techo a\nb: a\n\techo b\n' };
    expect(await callsDocker('make a', tree(files))).toBe(false);
  });

  it('refuses to follow a path out of the repository', async () => {
    const files = { Makefile: 'gate:\n\t../outside.sh\n', '../outside.sh': 'docker ps\n' };
    expect(await callsDocker('make gate', tree(files))).toBe(false);
  });
});

describe('gateCallsDocker', () => {
  const env = isolatedGitEnv();
  const gitIn = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { env, stdio: 'pipe' })
      .toString()
      .trim();
  const commitMakefile = (dir: string, text: string, message: string) => {
    writeFileSync(join(dir, 'Makefile'), text);
    gitIn(dir, 'add', 'Makefile');
    gitIn(dir, 'commit', '-q', '-m', message);
  };

  it("reads origin's remote-tracking branch, never a local branch or tag that shares its short name", async () => {
    const pair = createTempRepoWithOrigin();
    try {
      const repo = pair.repo.path;
      commitMakefile(repo, 'gate:\n\tpnpm test\n', 'the gate');
      gitIn(repo, 'push', '-q', 'origin', 'main');
      // A lane can make a local branch named like the remote-tracking one; git prefers it to the
      // remote-tracking ref when the name is given short.
      gitIn(repo, 'checkout', '-q', '-b', 'origin/main');
      commitMakefile(repo, 'gate:\n\tdocker compose run --rm app pytest\n', 'a lane');
      gitIn(repo, 'checkout', '-q', 'main');
      const project = { repoPath: repo, baseBranch: 'main', gateCommand: 'make gate' };
      expect(await gateCallsDocker(createGit(), project)).toBe(false);

      gitIn(repo, 'tag', 'origin/main', 'origin/main');
      gitIn(repo, 'branch', '-D', 'origin/main');
      expect(await gateCallsDocker(createGit(), project)).toBe(false);
    } finally {
      pair.cleanup();
    }
  });

  it('reads the Makefile origin holds, and nothing with no remote-tracking branch', async () => {
    const pair = createTempRepoWithOrigin();
    try {
      const repo = pair.repo.path;
      commitMakefile(repo, 'gate:\n\tdocker compose run --rm app pytest\n', 'the gate');
      const project = { repoPath: repo, baseBranch: 'main', gateCommand: 'make gate' };
      expect(await gateCallsDocker(createGit(), project)).toBe(false);
      gitIn(repo, 'push', '-q', 'origin', 'main');
      expect(await gateCallsDocker(createGit(), project)).toBe(true);
      expect(await gateCallsDocker(createGit(), { ...project, baseBranch: 'none' })).toBe(false);
      // No remote-tracking branch `lane`, but a local branch named like it in full.
      gitIn(repo, 'branch', 'refs/remotes/origin/lane');
      expect(await gateCallsDocker(createGit(), { ...project, baseBranch: 'lane' })).toBe(false);
      // With no commit to read, the builder's own command still says it.
      const direct = { ...project, baseBranch: 'lane', gateCommand: 'docker compose run --rm t' };
      expect(await gateCallsDocker(createGit(), direct)).toBe(true);
    } finally {
      pair.cleanup();
    }
  });
});
