import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintId } from '@10db/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGit } from '../src/git';
import { resolveSandboxRuntime } from '../src/paths';
import {
  createLaneSandbox,
  type LaneSandbox,
  type LaneSession,
  type SetupInput,
} from '../src/sandbox';
// The settings srt reads for a profile, as the gate and the repo servers hand it over.
import { srtSettings } from '../src/sandbox/srt-settings';
import { createTempRepo, type TempDir } from './fixtures';

/**
 * A lane's setup reads under the real sandbox: srt and Seatbelt, running commands under the profile the lane
 * sandbox builds for a session with a setup. Runs in `make gate` on macOS; skipped on Linux, which has no
 * Seatbelt, and inside a sandbox, where Seatbelt can't nest (`TENDB_SANDBOX=1`).
 */
const SEATBELT = process.platform === 'darwin' && process.env['TENDB_SANDBOX'] !== '1';

const git = createGit();

describe.skipIf(!SEATBELT)('the setup reads under the sandbox (Seatbelt)', () => {
  let root: string;
  let home: string;
  let outside: string;
  let repo: TempDir;
  let lanes: LaneSandbox;

  const write = (path: string, text: string): string => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    return path;
  };

  beforeAll(() => {
    // A short root: the lane temp dir's whole path must fit Claude Code's limit. The fake home in it
    // is a folder no grant opens: `/tmp` opens only its link, never what lies under `/private/tmp`.
    root = realpathSync(mkdtempSync('/tmp/sbs-'));
    home = join(root, 'home');
    outside = join(root, 'outside');
    for (const dir of ['t', 'r', 'home', 'outside']) mkdirSync(join(root, dir));
    write(join(home, '.claude/settings.json'), '{}');
    write(join(home, '.claude.json'), '{}');
    repo = createTempRepo();
    lanes = createLaneSandbox({
      home,
      dataDir: join(home, 'Library', 'Application Support', '10db'),
      loginConfigDir: null,
      gitDirs: (path) => git.gitDirs(path),
      tmpRoot: join(root, 't'),
      filesRoot: join(root, 'r'),
      systemPrefixes: [],
      runtime: resolveSandboxRuntime(),
      worktreeRoot: join(root, 'w'),
    });
  });

  afterAll(() => {
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  function forSession(setup?: SetupInput): Promise<LaneSession> {
    return lanes.forSession({
      project: {
        id: mintId('Project'),
        repoPath: repo.path,
        sandboxLoopback: false,
        gateCommand: 'make gate',
      },
      env: { PATH: '/usr/bin:/bin', HOME: home },
      rules: [],
      resumeProviderSessionId: null,
      configDir: join(home, '.claude'),
      checkouts: [repo.path],
      mcpServers: {},
      ...(setup === undefined ? {} : { setup }),
    });
  }

  /** Runs `command` under the session's profile through srt: "ok" when it exits 0, else "denied". */
  function probe(session: LaneSession, command: string): 'ok' | 'denied' {
    const settings = join(root, `settings-${String(Date.now())}-${String(Math.random())}.json`);
    writeFileSync(settings, JSON.stringify(srtSettings(session.spec.settings)));
    const runtime = resolveSandboxRuntime();
    const ran = spawnSync(runtime.node, [runtime.cli, '--settings', settings, '-c', command], {
      cwd: realpathSync(repo.path),
      env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CODE_TMPDIR: session.tmpDir },
      encoding: 'utf8',
      timeout: 30_000,
    });
    rmSync(settings, { force: true });
    return ran.status === 0 ? 'ok' : 'denied';
  }

  function skill(dir: string): string {
    write(join(dir, 'SKILL.md'), '---\nname: x\n---\n');
    return dir;
  }

  it('reads opened skills and plugins and nothing beside them', async () => {
    const s = skill(join(home, '.claude/skills/s'));
    write(join(s, 'run.sh'), 'exit 0\n');
    write(join(s, '.env'), 'TOKEN=x\n');
    const out = skill(join(outside, 'out'));
    symlinkSync(out, join(home, '.claude/skills/out'));
    write(join(home, '.ssh/id'), 'key\n');
    write(join(home, '.ssh/SKILL.md'), 'x\n');
    symlinkSync(join(home, '.ssh'), join(home, '.claude/skills/ssh'));
    const plugin = join(home, '.claude/plugins/cache/m/p/1');
    write(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'p' }));
    skill(join(plugin, 'skills/x'));
    const session = await forSession({
      skills: [
        { name: 's', path: s, skillFile: join(s, 'SKILL.md') },
        { name: 'out', path: join(home, '.claude/skills/out'), skillFile: join(out, 'SKILL.md') },
        {
          name: 'ssh',
          path: join(home, '.claude/skills/ssh'),
          skillFile: join(home, '.ssh/SKILL.md'),
        },
      ],
      plugins: [{ id: 'p@m', path: plugin }],
      projectFiles: [],
    });
    try {
      const setupDir = session.setup.reads[0] ?? '';
      const results = Object.fromEntries(
        Object.entries({
          'read-skill': `cat '${s}/SKILL.md'`,
          'run-skill-script': `sh '${s}/run.sh'`,
          'read-linked-skill': `cat '${home}/.claude/skills/out/SKILL.md'`,
          'read-plugin': `cat '${plugin}/skills/x/SKILL.md'`,
          'read-claude-settings': `cat '${home}/.claude/settings.json'`,
          'read-claude-json': `cat '${home}/.claude.json'`,
          'read-ssh-link': `cat '${home}/.claude/skills/ssh/id'`,
          'list-claude': `ls '${home}/.claude'`,
          'write-skill': `touch '${s}/x'`,
          'read-skill-env': `cat '${s}/.env'`,
          'read-setup-dir': `cat '${setupDir}/yours/skills/s/SKILL.md'`,
          'write-setup-dir': `touch '${setupDir}/yours/x'`,
        }).map(([name, command]) => [name, probe(session, command)]),
      );
      expect(results).toEqual({
        'read-skill': 'ok',
        'run-skill-script': 'ok',
        'read-linked-skill': 'ok',
        'read-plugin': 'ok',
        'read-claude-settings': 'denied',
        'read-claude-json': 'denied',
        'read-ssh-link': 'denied',
        'list-claude': 'denied',
        'write-skill': 'denied',
        'read-skill-env': 'denied',
        'read-setup-dir': 'ok',
        'write-setup-dir': 'denied',
      });
    } finally {
      session.dispose();
      rmSync(join(home, '.claude/skills'), { recursive: true, force: true });
      rmSync(join(home, '.claude/plugins'), { recursive: true, force: true });
    }
  }, 120_000);

  it('about 200 skills keep the profile small and every command runs', async () => {
    const skills = Array.from({ length: 200 }, (_, i) => {
      const dir = skill(join(home, `.claude/skills/s${String(i).padStart(3, '0')}`));
      return { name: `s${String(i)}`, path: dir, skillFile: join(dir, 'SKILL.md') };
    });
    const linked = Array.from({ length: 20 }, (_, i) => {
      const target = skill(join(outside, `group${String(i % 4)}/l${String(i)}`));
      const path = join(home, `.claude/skills/l${String(i)}`);
      symlinkSync(target, path);
      return { name: `l${String(i)}`, path, skillFile: join(target, 'SKILL.md') };
    });
    const plain = await forSession();
    const session = await forSession({
      skills: [...skills, ...linked],
      plugins: [],
      projectFiles: [],
    });
    try {
      const size = (s: LaneSession): number =>
        s.spec.settings.filesystem.allowRead.length + s.spec.settings.filesystem.denyRead.length;
      expect(size(session) - size(plain)).toBeLessThanOrEqual(25);
      expect(probe(session, `cat '${skills[0]?.path ?? ''}/SKILL.md'`)).toBe('ok');
      expect(probe(session, `cat '${skills.at(-1)?.path ?? ''}/SKILL.md'`)).toBe('ok');
      expect(probe(session, `cat '${linked.at(-1)?.path ?? ''}/SKILL.md'`)).toBe('ok');
    } finally {
      plain.dispose();
      session.dispose();
    }
  }, 120_000);
});
