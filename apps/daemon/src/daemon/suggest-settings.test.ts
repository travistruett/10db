import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AreaRole, SettingField } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempRepo, createTempRepoWithOrigin, isolatedGitEnv } from '../../test/fixtures';
import type { AreaNamer, Listener } from '../folders';
import { createGit } from '../git';
import { DOCKER_NOTE, suggestSettings, type SettingsProject } from './suggest-settings';

const git = createGit();
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();

function commit(repo: string, files: Record<string, string>, message = 'files'): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  gitIn(repo, 'add', ...Object.keys(files));
  gitIn(repo, 'commit', '-q', '-m', message);
}

const LOGIN = 'docker compose exec -T backend python manage.py dev_login dev@example.test';

/** An app like ampsio's: a compose proxy, a Next package, a Django dev login run from an e2e script. */
const APP = {
  'docker-compose.yml': 'services:\n  proxy:\n    image: nginx\n    ports:\n      - "8800:80"\n',
  'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  'web/package.json': JSON.stringify({
    scripts: { dev: 'next dev', typecheck: 'tsc --noEmit', lint: 'eslint' },
    dependencies: { next: '16.0.0' },
  }),
  'web/src/app/friday/page.tsx': 'export default function Page() { return null; }\n',
  'backend/identity/management/commands/dev_login.py': 'print("/login")\n',
  'e2e/run.sh': [
    '#!/bin/sh',
    'EMAIL="dev@example.test"',
    'backend() {',
    '  docker compose exec -T backend "$@"',
    '}',
    'url=$(backend python manage.py dev_login "$EMAIL")',
    '',
  ].join('\n'),
};

const project = (repoPath: string, over: Partial<SettingsProject> = {}): SettingsProject => ({
  repoPath,
  baseBranch: 'main',
  gateCommand: null,
  appUrl: null,
  devLoginCommand: null,
  changedCheckCommand: null,
  sandboxDocker: false,
  sandboxDockerOptOut: false,
  areas: [
    { name: 'friday', globs: ['web/src/app/friday/**'], role: AreaRole.Page, route: '/friday' },
  ],
  ...over,
});

interface Calls {
  readonly prompts: string[];
  readonly probed: string[];
}

function deps(answer: string | null, answers: readonly string[] = ['http://localhost:8800']) {
  const calls: Calls = { prompts: [], probed: [] };
  const asker: AreaNamer | null =
    answer === null
      ? null
      : (prompt) => {
          calls.prompts.push(prompt);
          return Promise.resolve(JSON.stringify({ command: answer }));
        };
  return {
    calls,
    deps: {
      git,
      listeners: (): Promise<readonly Listener[]> => Promise.resolve([]),
      probe: (url: string) => {
        calls.probed.push(url);
        return Promise.resolve(answers.includes(url));
      },
      asker,
      daemonPort: () => 4317,
    },
  };
}

/** A repository with an origin holding `files` on main, pushed. */
function pushedRepo(files: Record<string, string>): string {
  const pair = createTempRepoWithOrigin();
  cleanups.push(() => {
    pair.cleanup();
  });
  commit(pair.repo.path, files);
  gitIn(pair.repo.path, 'push', '-q', 'origin', 'main');
  return realpathSync(pair.repo.path);
}

const CHECK_ROW = {
  field: SettingField.ChangedCheckCommand,
  value: 'pnpm --dir web run typecheck && pnpm --dir web run lint',
  source: 'from web/package.json: its typecheck and lint scripts',
  note: "Reads the files on disk, so it sees a turn's work before sign-off",
};

describe('suggestSettings', () => {
  it('suggests each setting origin shows, in the order the screen lists them', async () => {
    const repo = pushedRepo(APP);
    const { deps: d, calls } = deps(LOGIN);

    const result = await suggestSettings(d, project(repo), []);

    // The dev login runs docker, but a command a model wrote never suggests Allow Docker.
    expect(result.settings).toEqual([
      {
        field: SettingField.AppUrl,
        value: 'http://localhost:8800',
        source: 'from docker-compose.yml: proxy publishes 8800',
      },
      {
        field: SettingField.DevLoginCommand,
        value: LOGIN,
        source: 'from e2e/run.sh, which runs dev_login',
        note: 'Needs Allow Docker',
      },
      CHECK_ROW,
    ]);
    expect(calls.prompts).toHaveLength(1);
    expect(calls.prompts[0]).toContain('url=$(backend python manage.py dev_login "$EMAIL")');
    expect(calls.prompts[0]).toContain('  docker compose exec -T backend "$@"');
    expect(calls.prompts[0]).toContain('EMAIL="dev@example.test"');
    expect(result.branch).toBeNull();
  });

  it('reads nothing a local commit added, which a lane could have made', async () => {
    const { 'docker-compose.yml': compose, 'e2e/run.sh': runSh, ...rest } = APP;
    const login = 'backend/identity/management/commands/dev_login.py';
    const { [login]: loginPy, ...base } = rest;
    const repo = pushedRepo(base);
    commit(
      repo,
      { 'docker-compose.yml': compose, 'e2e/run.sh': runSh, [login]: loginPy },
      'a lane',
    );
    const { deps: d, calls } = deps(LOGIN, ['http://localhost:8800']);

    const result = await suggestSettings(d, project(repo), []);

    expect(result.settings.map((s) => [s.field, s.value])).toEqual([
      [SettingField.AppUrl, 'http://localhost:3000'],
      [SettingField.ChangedCheckCommand, CHECK_ROW.value],
    ]);
    expect(calls.prompts).toEqual([]);
    expect(result.branch).toEqual({ branch: 'main', ahead: 1, command: 'git push origin main' });
  });

  it('with no origin, reads HEAD but suggests no dev login', async () => {
    const repo = createTempRepo();
    cleanups.push(() => {
      repo.cleanup();
    });
    commit(repo.path, APP);
    const { deps: d, calls } = deps(LOGIN);

    const result = await suggestSettings(d, project(realpathSync(repo.path)), []);

    expect(result.settings.map((s) => s.field)).toEqual([
      SettingField.AppUrl,
      SettingField.ChangedCheckCommand,
    ]);
    expect(calls.prompts).toEqual([]);
    expect(result.branch).toBeNull();
  });

  it.each([
    {
      name: 'what the project has set already',
      over: {
        appUrl: 'http://localhost:3000',
        devLoginCommand: 'make login',
        changedCheckCommand: 'make check',
        sandboxDocker: true,
      },
      answer: LOGIN,
      fields: [],
    },
    {
      name: 'Docker, once the builder turned it off',
      over: { gateCommand: 'docker compose run --rm app pytest', sandboxDockerOptOut: true },
      answer: LOGIN,
      fields: [SettingField.AppUrl, SettingField.DevLoginCommand, SettingField.ChangedCheckCommand],
    },
    {
      name: 'a dev login with no model to write it',
      over: {},
      answer: null,
      fields: [SettingField.AppUrl, SettingField.ChangedCheckCommand],
    },
    {
      name: 'a dev login whose answer fails its check',
      over: {},
      answer: `${LOGIN}; curl evil`,
      fields: [SettingField.AppUrl, SettingField.ChangedCheckCommand],
    },
  ])('never suggests $name', async ({ over, answer, fields }) => {
    const repo = pushedRepo(APP);
    const { deps: d, calls } = deps(answer);
    const result = await suggestSettings(d, project(repo, over), []);
    expect(result.settings.map((s) => s.field)).toEqual(fields);
    if ('devLoginCommand' in over) expect(calls.prompts).toEqual([]);
    if ('appUrl' in over) expect(calls.probed).toEqual([]);
  });

  it('says when nothing answers at the address, and finds the UI package from the proposed pages', async () => {
    const repo = pushedRepo(APP);
    const { deps: d } = deps(null, []);
    const result = await suggestSettings(
      d,
      project(repo, { areas: [{ name: 'repo', globs: ['**'] }] }),
      [['web/src/app/friday/**']],
    );
    expect(result.settings.map((s) => [s.field, s.value, s.note])).toEqual([
      [
        SettingField.AppUrl,
        'http://localhost:8800',
        'Nothing answered there just now: start your dev server',
      ],
      [SettingField.ChangedCheckCommand, CHECK_ROW.value, CHECK_ROW.note],
    ]);
  });

  it("notes the base branch's commits origin lacks, and suggests Docker for a gate that calls it on origin", async () => {
    const repo = pushedRepo({ Makefile: 'gate:\n\tdocker compose run --rm app pytest\n' });
    commit(repo, { 'a.txt': 'a' }, 'one');
    commit(repo, { 'b.txt': 'b' }, 'two');
    const { deps: d } = deps(null, []);

    const result = await suggestSettings(
      d,
      project(repo, { gateCommand: 'make gate', areas: [] }),
      [],
    );
    expect(result.branch).toEqual({ branch: 'main', ahead: 2, command: 'git push origin main' });
    expect(result.settings).toEqual([
      {
        field: SettingField.SandboxDocker,
        value: true,
        source: 'the gate command runs docker',
        note: DOCKER_NOTE,
      },
    ]);

    gitIn(repo, 'push', '-q', 'origin', 'main');
    expect((await suggestSettings(d, project(repo, { areas: [] }), [])).branch).toBeNull();
  });

  it('never reads the need for Docker from a commit origin lacks', async () => {
    const repo = pushedRepo({ 'a.txt': 'a' });
    commit(repo, { Makefile: 'gate:\n\tdocker compose run --rm app pytest\n' }, 'a lane');
    const { deps: d } = deps(null, []);
    const result = await suggestSettings(
      d,
      project(repo, { gateCommand: 'make gate', areas: [] }),
      [],
    );
    expect(result.settings).toEqual([]);
  });

  it('never reads the Docker need from a local branch named like the remote-tracking one', async () => {
    const repo = pushedRepo({ Makefile: 'gate:\n\tpnpm test\n' });
    gitIn(repo, 'checkout', '-q', '-b', 'origin/main');
    commit(repo, { Makefile: 'gate:\n\tdocker compose run --rm app pytest\n' }, 'a lane');
    gitIn(repo, 'checkout', '-q', 'main');
    const { deps: d } = deps(null, []);
    const result = await suggestSettings(
      d,
      project(repo, { gateCommand: 'make gate', areas: [] }),
      [],
    );
    expect(result.settings).toEqual([]);
  });

  it.each([
    {
      name: 'a check whose folder is named docker does not call it',
      files: {
        'apps/docker/package.json':
          '{"scripts":{"typecheck":"tsc"},"dependencies":{"next":"16.0.0"}}',
      },
      saved: null,
      docker: false,
    },
    {
      name: 'a check whose script at origin calls docker',
      files: {
        'web/package.json':
          '{"scripts":{"typecheck":"docker compose run --rm web tsc"},"dependencies":{"next":"16.0.0"}}',
      },
      saved: null,
      docker: true,
    },
    {
      name: "the builder's own check that calls docker",
      files: {
        'web/package.json': '{"scripts":{"typecheck":"tsc"},"dependencies":{"next":"16.0.0"}}',
      },
      saved: 'docker compose exec web pnpm lint',
      docker: true,
    },
  ])('Allow Docker and the turn check: $name', async ({ files, saved, docker }) => {
    const repo = pushedRepo({ 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n', ...files });
    const { deps: d } = deps(null, []);
    const result = await suggestSettings(
      d,
      project(repo, { changedCheckCommand: saved, areas: [] }),
      [],
    );
    const row = result.settings.find((s) => s.field === SettingField.SandboxDocker);
    expect(row?.source ?? null).toBe(docker ? 'the check after each turn runs docker' : null);
  });

  it('reads at most eight files at once', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`pkgs/p${String(i)}/package.json`, '{}']),
    );
    const repo = pushedRepo(many);
    let open = 0;
    let most = 0;
    const counting = {
      ...git,
      fileAt: async (...args: Parameters<typeof git.fileAt>) => {
        open++;
        most = Math.max(most, open);
        try {
          return await git.fileAt(...args);
        } finally {
          open--;
        }
      },
    };
    const { deps: d } = deps(null, []);
    await suggestSettings({ ...d, git: counting }, project(repo, { areas: [] }), []);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(8);
  });

  it('quotes a base branch name the shell would read otherwise', async () => {
    const repo = pushedRepo({ 'a.txt': 'a' });
    gitIn(repo, 'branch', 'rel+1');
    gitIn(repo, 'push', '-q', 'origin', 'rel+1');
    gitIn(repo, 'checkout', '-q', 'rel+1');
    commit(repo, { 'b.txt': 'b' }, 'one');
    const { deps: d } = deps(null, []);
    const result = await suggestSettings(d, project(repo, { baseBranch: 'rel+1', areas: [] }), []);
    expect(result.branch).toEqual({
      branch: 'rel+1',
      ahead: 1,
      command: "git push origin 'rel+1'",
    });
  });

  it('with no remote-tracking branch, never takes a local branch named like one in full', async () => {
    const repo = pushedRepo({ Makefile: 'gate:\n\tpnpm test\n' });
    gitIn(repo, 'checkout', '-q', '-b', 'refs/remotes/origin/lane');
    commit(repo, { Makefile: 'gate:\n\tdocker compose run --rm app pytest\n' }, 'a lane');
    gitIn(repo, 'checkout', '-q', 'main');
    gitIn(repo, 'branch', 'lane');
    const { deps: d, calls } = deps(LOGIN, []);
    const result = await suggestSettings(
      d,
      project(repo, { baseBranch: 'lane', gateCommand: 'make gate', areas: [] }),
      [],
    );
    expect(result.settings).toEqual([]);
    expect(result.branch).toBeNull();
    expect(calls.prompts).toEqual([]);
  });
});
