import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LaneBrief } from '../../src/briefing';
import { EvalIsolationError, evalDaemonEnv } from './daemon-env';

const builder = {
  dataDir: '/Users/me/Library/Application Support/10db',
  worktreeBase: '/Users/me/.10db/worktrees',
};
const base = {
  work: '/tmp/eval-run',
  fakeBook: null,
  catalogueSnapshot: '/repo/apps/daemon/test/fixtures/catalogue.json',
  builder,
};

describe('evalDaemonEnv', () => {
  it("gives the daemon a data dir and worktree root of the run's own, with every outside switch off", () => {
    const env = evalDaemonEnv({
      ...base,
      inherited: {
        PATH: '/usr/bin',
        HOME: '/Users/me',
        TENDB_DATA_DIR: builder.dataDir,
        TENDB_WORKTREE_ROOT: builder.worktreeBase,
        TENDB_FAKE_SCRIPTS: '/elsewhere/book.json',
        ANTHROPIC_API_KEY: 'sk-x',
        AWS_PROFILE: 'p',
        CLAUDE_CODE_USE_BEDROCK: '1',
      },
    });
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      TENDB_DATA_DIR: '/tmp/eval-run/data',
      TENDB_WORKTREE_ROOT: '/tmp/eval-run/worktrees',
      TENDB_PORT: '0',
      TENDB_BENCHMARKS: 'off',
      TENDB_CATALOGUE: 'off',
      TENDB_JUDGE: 'off',
      TENDB_SLACK: 'off',
      TENDB_TAILSCALE: 'off',
      TENDB_PARENT_STDIN: '1',
      TENDB_LANE_TRANSCRIPT_DAYS: '30',
    });
    for (const name of [
      'TENDB_FAKE_SCRIPTS',
      'ANTHROPIC_API_KEY',
      'AWS_PROFILE',
      'CLAUDE_CODE_USE_BEDROCK',
    ])
      expect(env, name).not.toHaveProperty(name);
  });

  it.each([
    ['index', LaneBrief.Index, { TENDB_LANE_BRIEF: 'index' }],
    ['full', LaneBrief.Full, { TENDB_LANE_BRIEF: 'full' }],
  ])(
    "briefs the eval daemon's lanes as the run says (%s), never as the builder's own setting",
    (_n, brief, want) => {
      const env = evalDaemonEnv({
        ...base,
        brief,
        inherited: { TENDB_LANE_BRIEF: brief === LaneBrief.Index ? 'full' : 'index' },
      });
      expect(env).toMatchObject(want);
    },
  );

  it("leaves the brief unset when the run sets none, dropping the builder's own", () => {
    const env = evalDaemonEnv({ ...base, inherited: { TENDB_LANE_BRIEF: 'index' } });
    expect(env).not.toHaveProperty('TENDB_LANE_BRIEF');
  });

  it('runs the fake agent when given a script book', () => {
    expect(
      evalDaemonEnv({ ...base, fakeBook: '/tmp/eval-run/book.json', inherited: {} }),
    ).toMatchObject({
      TENDB_FAKE_SCRIPTS: '/tmp/eval-run/book.json',
    });
  });

  it.each([
    ['nothing trusted before', {}, '/tmp/eval-run/repos'],
    ['an empty value', { MISE_TRUSTED_CONFIG_PATHS: '' }, '/tmp/eval-run/repos'],
    [
      'paths trusted before',
      { MISE_TRUSTED_CONFIG_PATHS: '/a/b' },
      `/a/b${delimiter}/tmp/eval-run/repos`,
    ],
  ])(
    "runs the snapshot's pinned pnpm with no engine switch, given %s",
    (_name, inherited, trusted) => {
      expect(evalDaemonEnv({ ...base, inherited })).toMatchObject({
        MISE_TRUSTED_CONFIG_PATHS: trusted,
        pnpm_config_manage_package_manager_versions: 'false',
      });
    },
  );

  it.each([
    ['inside the data dir', `${builder.dataDir}/eval`],
    ['inside the worktree base', `${builder.worktreeBase}/eval`],
    ['holding the data dir', '/Users/me/Library'],
  ])("refuses a work dir %s of the builder's own 10db", (_name, work) => {
    expect(() => evalDaemonEnv({ ...base, work, inherited: {} })).toThrow(EvalIsolationError);
  });
});
