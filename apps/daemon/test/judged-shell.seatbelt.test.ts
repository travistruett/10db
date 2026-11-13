import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintId } from '@10db/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGit } from '../src/git';
import { resolveSandboxRuntime } from '../src/paths';
import { createLaneSandbox, type LaneSession } from '../src/sandbox';
// The settings srt reads for a profile, as the gate and the repo servers hand it over.
import { srtSettings } from '../src/sandbox/srt-settings';
import { createTempRepo, isolatedGitEnv, type TempDir } from './fixtures';

/**
 * What a command the guard hands to a judge can still do to git state, under the real sandbox: srt
 * and Seatbelt, running commands under the profile a lane session gets, in a linked worktree. The
 * guard stops refusing shell it cannot read only because this holds. Runs in `make gate` on macOS;
 * skipped on Linux, which has no Seatbelt, and inside a sandbox, where Seatbelt can't nest
 * (`TENDB_SANDBOX=1`).
 */
const SEATBELT = process.platform === 'darwin' && process.env['TENDB_SANDBOX'] !== '1';

describe.skipIf(!SEATBELT)('git state under a lane profile (Seatbelt)', () => {
  let root: string;
  let main: TempDir;
  let checkout: string;
  let commonDir: string;
  let gitDir: string;
  let session: LaneSession;

  beforeAll(async () => {
    // A short root: the lane temp dir's whole path must fit Claude Code's limit.
    root = realpathSync(mkdtempSync('/tmp/sbj-'));
    for (const dir of ['t', 'r', 'home']) mkdirSync(join(root, dir));
    // createTempRepo's local config turns git's background maintenance off before any commit.
    main = createTempRepo();
    const mainPath = realpathSync(main.path);
    commonDir = join(mainPath, '.git');
    checkout = join(root, 'wt');
    gitDir = join(commonDir, 'worktrees', 'wt');
    execFileSync('git', ['-C', mainPath, 'worktree', 'add', '-q', '-b', 'lane', checkout], {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    });
    const git = createGit();
    session = await createLaneSandbox({
      home: join(root, 'home'),
      dataDir: join(root, 'home', 'Library', 'Application Support', '10db'),
      loginConfigDir: null,
      gitDirs: (path) => git.gitDirs(path),
      tmpRoot: join(root, 't'),
      filesRoot: join(root, 'r'),
      runtime: resolveSandboxRuntime(),
      worktreeRoot: join(root, 'w'),
    }).forSession({
      project: {
        id: mintId('Project'),
        repoPath: checkout,
        sandboxLoopback: false,
        gateCommand: 'make gate',
      },
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: join(root, 'home') },
      rules: [],
      resumeProviderSessionId: null,
      configDir: join(root, 'home', '.claude'),
      checkouts: [checkout],
      mcpServers: {},
    });
    // It reads the toolchain and walks the checkout, which takes a while on a loaded machine.
  }, 60_000);

  afterAll(() => {
    session.dispose();
    main.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  /** Runs `command` under the session's profile through srt: "ok" when it exits 0, else "denied". */
  function probe(command: string): 'ok' | 'denied' {
    const settings = join(root, `settings-${String(Date.now())}-${String(Math.random())}.json`);
    const profile = srtSettings(session.spec.settings);
    // Claude Code opens the checkout for writing itself, and a linked worktree's git dirs with it.
    // The profile's denyWrite on git state is all that closes them again.
    writeFileSync(
      settings,
      JSON.stringify({
        ...profile,
        filesystem: {
          ...profile.filesystem,
          allowWrite: [...profile.filesystem.allowWrite, checkout, gitDir, commonDir],
        },
      }),
    );
    const runtime = resolveSandboxRuntime();
    const ran = spawnSync(runtime.node, [runtime.cli, '--settings', settings, '-c', command], {
      cwd: checkout,
      env: { ...isolatedGitEnv(), ...session.commandEnv, CLAUDE_CODE_TMPDIR: session.tmpDir },
      encoding: 'utf8',
      timeout: 30_000,
    });
    rmSync(settings, { force: true });
    return ran.status === 0 ? 'ok' : 'denied';
  }

  it('fails a git commit, a branch change and a removal of git state, and still writes the checkout', () => {
    const results = {
      // Controls: git runs under the profile, so a refusal below is the kernel's.
      'git-status': probe('git status'),
      'write-checkout': probe('echo x > a.txt'),
      'git-commit': probe('git commit --allow-empty -m x'),
      'git-branch': probe('git branch side'),
      'rm-git-file': probe('rm -rf .git'),
      'rm-common-dir': probe(`rm -rf '${commonDir}/refs'`),
    };
    expect(results).toEqual({
      'git-status': 'ok',
      'write-checkout': 'ok',
      'git-commit': 'denied',
      'git-branch': 'denied',
      'rm-git-file': 'denied',
      'rm-common-dir': 'denied',
    });
  }, 120_000);
});
