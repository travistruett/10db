import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintId } from '@10db/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectAtCheckout } from '../src/delivery';
import { createGit } from '../src/git';
import { resolveSandboxRuntime } from '../src/paths';
import { createLaneSandbox, type LaneSandbox, type LaneSession } from '../src/sandbox';
import { srtSettings } from '../src/sandbox/srt-settings';
import { createTempRepo, isolatedGitEnv, type TempDir } from './fixtures';

/**
 * A session on its own branch under the real sandbox: srt and Seatbelt, with the profile
 * `forSession(projectAtCheckout(project, worktree))` gives it. It writes its worktree and is refused in the
 * builder's checkout. Runs in `make gate` on macOS; skipped on Linux, which has no Seatbelt, and inside a
 * sandbox, where Seatbelt can't nest (`TENDB_SANDBOX=1`).
 */
const SEATBELT = process.platform === 'darwin' && process.env['TENDB_SANDBOX'] !== '1';

type SessionProject = Parameters<LaneSandbox['forSession']>[0]['project'];

describe.skipIf(!SEATBELT)('a session on its own branch (Seatbelt)', () => {
  let root: string;
  let main: TempDir;
  let checkout: string;
  let worktree: string;
  let session: LaneSession;
  /** The control: the same session rooted at the checkout, as a session that never moved is. */
  let atCheckout: LaneSession;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync('/tmp/sbc-'));
    for (const dir of ['t', 'r', 'home']) mkdirSync(join(root, dir));
    main = createTempRepo();
    checkout = realpathSync(main.path);
    worktree = join(root, 'wt');
    execFileSync('git', ['-C', checkout, 'worktree', 'add', '-q', '-b', 'chat-branch', worktree], {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    });
    const git = createGit();
    const sandbox = createLaneSandbox({
      home: join(root, 'home'),
      dataDir: join(root, 'home', 'Library', 'Application Support', '10db'),
      loginConfigDir: null,
      gitDirs: (path) => git.gitDirs(path),
      tmpRoot: join(root, 't'),
      filesRoot: join(root, 'r'),
      runtime: resolveSandboxRuntime(),
      worktreeRoot: join(root, 'w'),
    });
    const input = (project: SessionProject) => ({
      project,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: join(root, 'home') },
      rules: [],
      resumeProviderSessionId: null,
      configDir: join(root, 'home', '.claude'),
      // Every checkout 10db knows: the builder's, and this session's own worktree.
      checkouts: [checkout, worktree],
      mcpServers: {},
      readOnly: false,
    });
    const project = {
      id: mintId('Project'),
      repoPath: checkout,
      sandboxLoopback: false,
      gateCommand: 'make gate',
    };
    session = await sandbox.forSession(input(projectAtCheckout(project, worktree)));
    atCheckout = await sandbox.forSession(input(project));
  }, 60_000);

  afterAll(async () => {
    await session.dispose();
    await atCheckout.dispose();
    main.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  /** Runs `command` in the worktree under the session's profile: "ok" when it exits 0, else "denied". */
  function probe(
    command: string,
    using: LaneSession = session,
    cwd: string = worktree,
  ): 'ok' | 'denied' {
    const settings = join(root, `settings-${String(Date.now())}-${String(Math.random())}.json`);
    const profile = srtSettings(using.spec.settings);
    // Claude Code opens its working directory for writing itself; the profile's denials are what close the rest.
    writeFileSync(
      settings,
      JSON.stringify({
        ...profile,
        filesystem: {
          ...profile.filesystem,
          allowWrite: [...profile.filesystem.allowWrite, cwd],
        },
      }),
    );
    const runtime = resolveSandboxRuntime();
    const ran = spawnSync(runtime.node, [runtime.cli, '--settings', settings, '-c', command], {
      cwd,
      env: { ...isolatedGitEnv(), ...using.commandEnv, CLAUDE_CODE_TMPDIR: using.tmpDir },
      encoding: 'utf8',
      timeout: 30_000,
    });
    rmSync(settings, { force: true });
    return ran.status === 0 ? 'ok' : 'denied';
  }

  it('writes its worktree, and is refused in the builder’s checkout', () => {
    expect({
      // The control: rooted at the checkout, the same command writes it.
      'control-checkout': probe(`echo x > '${checkout}/c.txt'`, atCheckout, checkout),
      'write-worktree': probe('echo x > a.txt'),
      'write-checkout': probe(`echo x > '${checkout}/b.txt'`),
      'new-dir-checkout': probe(`mkdir -p '${checkout}/newdir'`),
    }).toEqual({
      'control-checkout': 'ok',
      'write-worktree': 'ok',
      'write-checkout': 'denied',
      'new-dir-checkout': 'denied',
    });
  }, 120_000);
});
