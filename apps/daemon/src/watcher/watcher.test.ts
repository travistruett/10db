import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ClaimKind,
  mintId,
  WorkstreamState,
  type BatchId,
  type InboxItemDto,
  type ProjectDto,
  type TaskDto,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  acquireClaims,
  claimRequestsForTask,
  copyHazardNames,
  createTestStore,
  insertBatch,
  insertPermissionRule,
  insertTask,
  insertWorkstream,
  listInbox,
  listPermissionRules,
  getProject,
  patchBatch,
  patchProject,
  patchWorkstream,
  renewClaimLeases,
  transitionBatch,
  releaseClaims,
  seedProject,
  transitionWorkstream,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTempRepo,
  isolatedGitEnv,
  seedWorkstream,
  tempDir,
  type TempDir,
  waitFor,
} from '../../test/fixtures';
import { ManualClock, systemClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger, type Logger } from '../log';
import { ANSWERED_CARDS_READ } from './allowed-writes';
import { STRAY_BULK_THRESHOLD } from './strays';
import { createWatcher, systemWatch, type WatchFn, type Watcher } from './index';

interface FakeWatch {
  readonly watch: WatchFn;
  readonly open: Map<string, { onChange(rel: string): void; onError(error: Error): void }>;
  readonly closed: string[];
}

function fakeWatch(): FakeWatch {
  const open = new Map<string, { onChange(rel: string): void; onError(error: Error): void }>();
  const closed: string[] = [];
  return {
    open,
    closed,
    watch: (root, onChange, onError) => {
      open.set(root, { onChange, onError });
      return {
        close() {
          open.delete(root);
          closed.push(root);
        },
      };
    },
  };
}

let close: () => void;
let base: ReturnType<typeof createTestStore>['store'];
let state: StateStore;
let inbox: InboxService;
let repo: { path: string; cleanup(): void };
let project: ProjectDto;
let clock: ManualClock;
let logged: { obj: Record<string, unknown>; msg: string | undefined }[];
let fake: FakeWatch;
let watcher: Watcher;

beforeEach(() => {
  ({ store: base, close } = createTestStore());
  const bus = createEventBus();
  state = createStateStore(base, bus);
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  repo = createTempRepo();
  project = seedProject(base, { repoPath: repo.path });
  clock = new ManualClock();
  fake = fakeWatch();
  logged = [];
  const recording: Logger = {
    ...silentLogger,
    info: (obj, msg) => logged.push({ obj: obj as Record<string, unknown>, msg }),
  };
  watcher = createWatcher({
    state,
    bus,
    inbox,
    git: createGit(),
    logger: recording,
    clock,
    watch: fake.watch,
    batchMs: 500,
  });
});
afterEach(() => {
  watcher.stop();
  close();
  repo.cleanup();
});

/** Claims the task's areas and moves the workstream to RUNNING, as the scheduler and runner would. */
function running(title = 'Alpha', areas = ['api']): { task: TaskDto; workstream: WorkstreamDto } {
  const seeded = seedWorkstream(base, { project, title, areas });
  state.write((ctx) => {
    acquireClaims(ctx, {
      projectId: project.id,
      workstreamId: seeded.workstream.id,
      requests: claimRequestsForTask(seeded.task, project),
      leaseExpiresAt: '2999-01-01T00:00:00.000Z',
    });
    transitionWorkstream(ctx, seeded.workstream.id, { to: WorkstreamState.Starting, fence: null });
    transitionWorkstream(ctx, seeded.workstream.id, { to: WorkstreamState.Running, fence: null });
  });
  return seeded;
}

const flags = (): InboxItemDto[] =>
  listInbox(base.db, { states: ['OPEN'] }).filter((i) => i.kind === 'flag');
const emit = (rel: string) => {
  fake.open.get(repo.path)?.onChange(rel);
};
const touch = (rel: string) => {
  mkdirSync(dirname(join(repo.path, rel)), { recursive: true });
  writeFileSync(join(repo.path, rel), 'x');
};

describe('watcher', () => {
  it('watches only projects with active work, and closes when the work ends', () => {
    watcher.sync();
    expect(fake.open.size).toBe(0);
    const { workstream } = running();
    watcher.sync();
    expect([...fake.open.keys()]).toEqual([repo.path]);
    state.write((ctx) =>
      transitionWorkstream(ctx, workstream.id, { to: WorkstreamState.Cancelled, fence: null }),
    );
    watcher.sync();
    expect(fake.open.size).toBe(0);
    expect(fake.closed).toEqual([repo.path]);
  });

  it('flags a write outside every claim once, naming the only active workstream', async () => {
    const { workstream } = running();
    watcher.sync();
    touch('src/api/fine.ts');
    touch('docs/stray.md');
    emit('src/api/fine.ts');
    emit('docs/stray.md');
    emit('docs/stray.md');
    clock.advance(500);
    await watcher.flush();
    emit('docs/stray.md');
    await watcher.flush();

    const open = flags();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      title: 'Write outside every claim',
      body: 'docs/stray.md',
      targets: [{ workstreamId: workstream.id, sessionId: null }],
    });
    expect(open[0]?.detail).toMatchObject({ path: 'docs/stray.md', candidates: [workstream.id] });
  });

  it('keeps a card open when another lane launches holding the area that covers it', async () => {
    const a = running('Alpha', ['api']);
    watcher.sync();
    touch('src/ui/x.ts');
    emit('src/ui/x.ts');
    await watcher.flush();
    expect(flags()[0]?.detail).toMatchObject({ candidates: [a.workstream.id] });
    running('Beta', ['ui']);
    await watcher.flush();
    expect(flags().map((f) => f.body)).toEqual(['src/ui/x.ts']);
  });

  it('lists every candidate when several workstreams are active', async () => {
    const a = running('Alpha', ['api']);
    const b = running('Beta', ['ui']);
    watcher.sync();
    touch('docs/stray.md');
    emit('docs/stray.md');
    await watcher.flush();
    const [card] = flags();
    expect(card?.targets).toEqual([]);
    const candidates = card?.detail?.['candidates'];
    expect(Array.isArray(candidates) ? [...candidates].sort() : candidates).toEqual(
      [a.workstream.id, b.workstream.id].sort(),
    );
  });

  it('drops .git, node_modules, .DS_Store, directories and gitignored paths', async () => {
    running();
    writeFileSync(join(repo.path, '.gitignore'), 'dist/\nnode_modules/\n');
    touch('dist/bundle.js');
    touch('docs/.DS_Store');
    touch('node_modules/react/index.js');
    watcher.sync();
    emit('.git/index');
    emit('node_modules/react/index.js');
    emit('apps/x/node_modules/y.js');
    emit('dist/bundle.js');
    emit('docs/.DS_Store');
    emit('docs');
    await watcher.flush();
    // The .gitignore edit itself is a write outside every claim, so it is the only flag.
    emit('.gitignore');
    await watcher.flush();
    expect(flags().map((f) => f.body)).toEqual(['.gitignore']);
  });

  it('folds a 10k-path churn into one bulk card', async () => {
    const strays = STRAY_BULK_THRESHOLD + 10;
    running();
    watcher.sync();
    for (let i = 0; i < 10_000; i += 1) emit(`node_modules/pkg/file-${String(i)}.js`);
    for (let i = 0; i < strays; i += 1) {
      touch(`generated/file-${String(i)}.ts`);
      emit(`generated/file-${String(i)}.ts`);
    }
    await watcher.flush();
    for (let i = 0; i < strays; i += 1) {
      touch(`generated/again-${String(i)}.ts`);
      emit(`generated/again-${String(i)}.ts`);
    }
    await watcher.flush();

    const open = flags();
    expect(open).toHaveLength(1);
    expect(open[0]?.title).toBe(`${String(strays)} writes outside every claim`);
    expect(open[0]?.body).toContain('generated/file-0.ts');
    expect(open[0]?.body).toContain(`and ${String(strays - 20)} more`);
    expect(open[0]?.body).not.toContain('node_modules');
    expect(open[0]?.detail?.['count']).toBe(strays);
  });

  it('does not flag a file that was committed and released before the batch ran', async () => {
    const alpha = running('Alpha', ['api']);
    running('Beta', ['ui']);
    watcher.sync();
    touch('src/api/done.ts');
    emit('src/api/done.ts');
    // Alpha commits through 10db, passes its gate and releases its claim inside one batch window.
    execFileSync('git', ['add', 'src/api/done.ts'], { cwd: repo.path, env: isolatedGitEnv() });
    execFileSync('git', ['commit', '-q', '-m', 'Add done.ts'], {
      cwd: repo.path,
      env: isolatedGitEnv(),
    });
    state.write((ctx) => {
      releaseClaims(ctx, alpha.workstream.id);
    });
    clock.advance(500);
    await watcher.flush();
    expect(flags()).toEqual([]);
  });

  it('survives the repo being deleted under it', async () => {
    running();
    watcher.sync();
    emit('docs/a.md');
    rmSync(repo.path, { recursive: true, force: true });
    await expect(watcher.flush()).resolves.toBeUndefined();
    expect(flags()).toEqual([]);
    expect(fake.closed).toEqual([repo.path]);
    expect(() => {
      watcher.sync();
    }).not.toThrow();
    expect(fake.open.size).toBe(0);
  });

  it('drops a watcher that errors, and watches again on the next sync', () => {
    running();
    watcher.sync();
    fake.open.get(repo.path)?.onError(new Error('EMFILE'));
    expect(fake.open.size).toBe(0);
    watcher.sync();
    expect([...fake.open.keys()]).toEqual([repo.path]);
  });

  it('flags a write under a nested node_modules that git reports', async () => {
    running();
    watcher.sync();
    touch('src/node_modules/index.js');
    emit('src/node_modules/index.js');
    await watcher.flush();
    expect(flags().map((f) => f.body)).toEqual(['src/node_modules/index.js']);
  });

  it.each(['.git/info/exclude', '.git/hooks/pre-commit', '.git/config'])(
    'flags a write to %s',
    async (rel) => {
      running();
      watcher.sync();
      touch(rel);
      emit(rel);
      emit('.git/index');
      emit('.git/refs/heads/main');
      await watcher.flush();
      expect(flags().map((f) => f.body)).toEqual([rel]);
    },
  );

  it('never runs a core.fsmonitor script from the repository config', async () => {
    running();
    const scripts = tempDir('fsmonitor').path;
    const marker = join(scripts, 'ran');
    const script = join(scripts, 'hook.sh');
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(script, 0o755);
    execFileSync('git', ['config', 'core.fsmonitor', script], {
      cwd: repo.path,
      env: isolatedGitEnv(),
    });
    watcher.sync();
    touch('docs/a.md');
    emit('docs/a.md');
    await watcher.flush();
    expect(flags().map((f) => f.body)).toEqual(['docs/a.md']);
    expect(existsSync(marker)).toBe(false);
  });

  it('flags a gitignored sensitive file but not an ordinary ignored one', async () => {
    running();
    writeFileSync(join(repo.path, '.gitignore'), 'dist/\n.env\n.claude/\n');
    touch('dist/x.js');
    touch('.env');
    touch('.claude/settings.local.json');
    watcher.sync();
    emit('dist/x.js');
    emit('.env');
    emit('.claude/settings.local.json');
    emit('.claude/gone.json');
    await watcher.flush();
    expect(
      flags()
        .map((f) => f.body)
        .sort(),
    ).toEqual(['.claude/settings.local.json', '.env']);
  });

  describe('a sensitive file a commit brought in', () => {
    /** Commits `rel` as a lane's commit-tool call does: the file arrives tracked, and the worktree equals HEAD. */
    const commitFile = (rel: string) => {
      touch(rel);
      execFileSync('git', ['add', rel], { cwd: repo.path, env: isolatedGitEnv() });
      execFileSync('git', ['commit', '-q', '-m', `Add ${rel}`], {
        cwd: repo.path,
        env: isolatedGitEnv(),
      });
    };

    it.each(['apps/daemon/.env.example', '.mcp.json', '.claude/settings.json'])(
      'still flags %s that a lane commits before its batch runs, since no base brought it',
      async (rel) => {
        running();
        watcher.sync();
        commitFile(rel);
        emit(rel);
        await watcher.flush();
        expect(flags().map((f) => f.body)).toEqual([rel]);
      },
    );

    it('still flags that file once a lane edits it', async () => {
      running();
      commitFile('apps/daemon/.env.example');
      watcher.sync();
      writeFileSync(join(repo.path, 'apps/daemon/.env.example'), 'KEY=lane');
      emit('apps/daemon/.env.example');
      await watcher.flush();
      expect(flags().map((f) => f.body)).toEqual(['apps/daemon/.env.example']);
    });

    it('still flags a lane that deletes it', async () => {
      running();
      commitFile('apps/daemon/.env.example');
      watcher.sync();
      rmSync(join(repo.path, 'apps/daemon/.env.example'));
      emit('apps/daemon/.env.example');
      await watcher.flush();
      expect(flags()).toHaveLength(1);
    });

    it('still flags a new .env.example the lane wrote that no commit holds', async () => {
      running();
      watcher.sync();
      touch('apps/daemon/.env.example');
      emit('apps/daemon/.env.example');
      await watcher.flush();
      expect(flags().map((f) => f.body)).toEqual(['apps/daemon/.env.example']);
    });
  });

  describe("Claude Code's write staging directory", () => {
    const staging = '.claude/.cc-writes';
    const staged = `${staging}/settings.local.json.tmp`;
    const makeStaging = () => {
      mkdirSync(join(repo.path, staging), { recursive: true, mode: 0o700 });
    };
    const outside: TempDir[] = [];
    /** A directory outside the repository for a link to point at, removed after the row. */
    const outsideDir = (prefix: string): string => {
      const dir = tempDir(prefix);
      outside.push(dir);
      return dir.path;
    };
    afterEach(() => {
      for (const dir of outside.splice(0)) dir.cleanup();
    });

    it.each<{
      name: string;
      ignore: string;
      setup: () => void;
      events: string[];
      expected: string[];
    }>([
      {
        name: 'is not flagged when a session creates it in an existing .claude, gitignored',
        ignore: `${staging}/\n`,
        setup: () => {
          touch('.claude/settings.json');
          makeStaging();
        },
        events: [staging],
        expected: [],
      },
      {
        name: 'is not flagged when it creates .claude, which holds nothing else',
        ignore: '',
        setup: makeStaging,
        events: ['.claude', staging],
        expected: [],
      },
      {
        name: 'leaves the settings file it stages a write for flagged',
        ignore: `${staging}/\n.claude/settings.local.json\n`,
        setup: () => {
          makeStaging();
          touch('.claude/settings.local.json');
        },
        events: [staging, staged, '.claude/settings.local.json'],
        expected: ['.claude/settings.local.json'],
      },
      {
        name: 'leaves a new .claude flagged when it holds config beside it',
        ignore: `${staging}/\n.claude/settings.local.json\n`,
        setup: () => {
          makeStaging();
          touch('.claude/settings.local.json');
        },
        events: ['.claude', staging],
        expected: ['.claude'],
      },
      {
        name: 'leaves a new, empty .claude flagged',
        ignore: '',
        setup: () => {
          mkdirSync(join(repo.path, '.claude'));
        },
        events: ['.claude'],
        expected: ['.claude'],
      },
      {
        name: 'leaves a .claude link flagged though its target holds only the staging directory',
        ignore: '.claude\n',
        setup: () => {
          const target = outsideDir('claude-link');
          mkdirSync(join(target, '.cc-writes'));
          symlinkSync(target, join(repo.path, '.claude'));
        },
        events: ['.claude'],
        expected: ['.claude'],
      },
      {
        name: 'is flagged as a link, and so is the new .claude holding it',
        ignore: `${staging}\n`,
        setup: () => {
          mkdirSync(join(repo.path, '.claude'));
          symlinkSync(outsideDir('cc-writes-link'), join(repo.path, staging));
        },
        events: ['.claude', staging],
        expected: ['.claude', staging],
      },
      {
        name: 'is flagged as a file, and so is the new .claude holding it',
        ignore: `${staging}\n`,
        setup: () => {
          touch(staging);
        },
        events: ['.claude', staging],
        expected: ['.claude', staging],
      },
      {
        name: 'is judged against the claims when git reports a file left in it',
        // Git reads the contributor's `~/.config/git/ignore`, where Claude Code adds this directory, whatever
        // `GIT_CONFIG_GLOBAL` names; the repository's own rule outranks it.
        ignore: `!${staging}/\n`,
        setup: () => {
          touch(staged);
        },
        events: [staging, staged],
        expected: [staged],
      },
    ])('$name', async ({ ignore, setup, events, expected }) => {
      running();
      writeFileSync(join(repo.path, '.gitignore'), ignore);
      setup();
      watcher.sync();
      events.forEach(emit);
      await watcher.flush();
      expect(
        flags()
          .map((f) => f.body)
          .sort(),
      ).toEqual(expected);
    });
  });

  describe("Claude Code's own bookkeeping files", () => {
    const lock = '.claude/scheduled_tasks.lock';
    const bookkeepingLogs = () =>
      logged.filter((l) => l.msg?.includes('Claude Code bookkeeping')).map((l) => l.obj['path']);

    it.each([
      { name: 'untracked', ignore: '' },
      { name: 'gitignored', ignore: '.claude/\n' },
    ])('raises no card for the lock when it is $name, and logs it', async ({ ignore }) => {
      running();
      writeFileSync(join(repo.path, '.gitignore'), ignore);
      touch(lock);
      watcher.sync();
      emit(lock);
      await watcher.flush();
      expect(flags()).toEqual([]);
      expect(bookkeepingLogs()).toEqual([lock]);
    });

    it('raises no card for the lock when the session ends and removes it', async () => {
      running();
      watcher.sync();
      emit(lock);
      await watcher.flush();
      expect(flags()).toEqual([]);
      expect(bookkeepingLogs()).toEqual([lock]);
    });

    it('logs the staging directory, and the new .claude holding only it, without a card', async () => {
      running();
      mkdirSync(join(repo.path, '.claude/.cc-writes'), { recursive: true, mode: 0o700 });
      watcher.sync();
      emit('.claude');
      emit('.claude/.cc-writes');
      await watcher.flush();
      expect(flags()).toEqual([]);
      expect(bookkeepingLogs()).toEqual(['.claude', '.claude/.cc-writes']);
      const writtenBy = logged.find((l) => l.obj['path'] === '.claude/.cc-writes')?.obj[
        'writtenBy'
      ];
      expect(writtenBy).toContain('atomic-write staging directory');
    });

    it.each([
      { name: 'untracked', ignore: '' },
      { name: 'gitignored', ignore: '.claude/\n' },
    ])('still flags the lock as a hard link to the settings, $name', async ({ ignore }) => {
      running();
      writeFileSync(join(repo.path, '.gitignore'), ignore);
      touch('.claude/settings.local.json');
      linkSync(join(repo.path, '.claude/settings.local.json'), join(repo.path, lock));
      watcher.sync();
      emit(lock);
      await watcher.flush();
      expect(flags().map((f) => f.body)).toEqual([lock]);
      expect(bookkeepingLogs()).toEqual([]);
    });

    it('raises no card for the lock at the end of a step, and logs it', async () => {
      const { workstream } = running();
      touch(lock);
      expect(await watcher.stepEnd(workstream.id)).toEqual([]);
      expect(flags()).toEqual([]);
      expect(bookkeepingLogs()).toEqual([lock]);
    });

    it('still flags the lock as a link', async () => {
      running();
      mkdirSync(join(repo.path, '.claude'));
      symlinkSync(join(repo.path, 'elsewhere'), join(repo.path, lock));
      watcher.sync();
      emit(lock);
      await watcher.flush();
      expect(flags().map((f) => f.body)).toEqual([lock]);
    });

    it.each([
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/hooks/pre.sh',
      '.claude/agents/a.md',
      '.claude/skills/s/SKILL.md',
    ])('still flags %s beside the lock', async (rel) => {
      running();
      touch(lock);
      touch(rel);
      watcher.sync();
      emit(lock);
      emit(rel);
      await watcher.flush();
      expect(flags().map((f) => f.body)).toEqual([rel]);
      expect(bookkeepingLogs()).toEqual([lock]);
    });
  });

  it('flags a write inside the claim of a workstream that is not running', async () => {
    const a = running('Alpha', ['api']);
    const idle = seedWorkstream(base, { project, title: 'Beta', areas: ['ui'] });
    state.write((ctx) => {
      acquireClaims(ctx, {
        projectId: project.id,
        workstreamId: idle.workstream.id,
        requests: claimRequestsForTask(idle.task, project),
        leaseExpiresAt: '2999-01-01T00:00:00.000Z',
      });
    });
    watcher.sync();
    touch('src/ui/b.tsx');
    touch('src/api/a.ts');
    emit('src/ui/b.tsx');
    emit('src/api/a.ts');
    await watcher.flush();
    const open = flags();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      body: 'src/ui/b.tsx',
      targets: [{ workstreamId: a.workstream.id, sessionId: null }],
    });
    expect(open[0]?.detail).toMatchObject({
      path: 'src/ui/b.tsx',
      claimedBy: [idle.workstream.id],
    });
  });

  it('does not flag writes inside the claims of running workstreams', async () => {
    running('Alpha', ['api']);
    running('Beta', ['ui']);
    watcher.sync();
    touch('src/api/a.ts');
    touch('src/ui/b.tsx');
    emit('src/api/a.ts');
    emit('src/ui/b.tsx');
    await watcher.flush();
    expect(flags()).toEqual([]);
  });

  it('flags a directory moved into .git/hooks, which arrives as one rename event', async () => {
    running();
    watcher.sync();
    const staged = join(tempDir('hooks').path, 'h');
    mkdirSync(staged);
    writeFileSync(join(staged, 'pre-commit'), 'x');
    rmSync(join(repo.path, '.git', 'hooks'), { recursive: true, force: true });
    renameSync(staged, join(repo.path, '.git', 'hooks'));
    emit('.git/hooks');
    await watcher.flush();
    expect(flags().map((f) => f.body)).toEqual(['.git/hooks']);
  });

  it('flags a dangling symlink written into .git/hooks', async () => {
    running();
    watcher.sync();
    symlinkSync(join(repo.path, 'not-yet'), join(repo.path, '.git', 'hooks', 'pre-commit'));
    emit('.git/hooks/pre-commit');
    await watcher.flush();
    expect(flags().map((f) => f.body)).toEqual(['.git/hooks/pre-commit']);
  });

  it('keeps a sensitive write on its own card beside a bulk card', async () => {
    running();
    watcher.sync();
    for (let i = 0; i < STRAY_BULK_THRESHOLD + 1; i += 1) {
      touch(`generated/file-${String(i)}.ts`);
      emit(`generated/file-${String(i)}.ts`);
    }
    touch('.git/hooks/pre-commit');
    emit('.git/hooks/pre-commit');
    await watcher.flush();
    const open = flags();
    expect(open.map((f) => f.body).filter((b) => b === '.git/hooks/pre-commit')).toHaveLength(1);
    const bulk = open.find((f) => f.title.endsWith('writes outside every claim'));
    expect(bulk?.title).toBe(`${String(STRAY_BULK_THRESHOLD + 1)} writes outside every claim`);
    expect(bulk?.body).not.toContain('.git/hooks');
  });

  it('does not blame a lane that moved on within the batch window for its own claim', async () => {
    const { workstream } = running('Alpha', ['api']);
    watcher.sync();
    touch('src/api/a.ts');
    emit('src/api/a.ts');
    state.write((ctx) =>
      transitionWorkstream(ctx, workstream.id, { to: WorkstreamState.Verifying, fence: null }),
    );
    await watcher.flush();
    expect(flags()).toEqual([]);
  });

  it.each([
    WorkstreamState.WaitingHuman,
    WorkstreamState.PausedLimit,
    WorkstreamState.Recovering,
    WorkstreamState.Queued,
  ])(
    "does not blame a step's end for writes inside the claim of a lane that is %s",
    async (idle) => {
      const a = running('Alpha', ['api']);
      const b = running('Beta', ['ui']);
      // B edited inside its own claim, then stopped to wait; A's step ends later.
      touch('src/ui/b.tsx');
      state.write((ctx) => {
        if (idle === WorkstreamState.Queued) {
          transitionWorkstream(ctx, b.workstream.id, {
            to: WorkstreamState.Recovering,
            fence: null,
          });
        }
        transitionWorkstream(ctx, b.workstream.id, { to: idle, fence: null });
      });
      touch('src/api/ok.ts');
      expect(await watcher.stepEnd(a.workstream.id)).toEqual([]);
      expect(flags()).toEqual([]);
    },
  );

  it('flags a step-end write inside the claim of a taken-over workstream', async () => {
    const a = running('Alpha', ['api']);
    const b = running('Beta', ['ui']);
    state.write((ctx) =>
      transitionWorkstream(ctx, b.workstream.id, { to: WorkstreamState.TakenOver, fence: null }),
    );
    touch('src/api/ok.ts');
    touch('src/ui/b.tsx');
    expect(await watcher.stepEnd(a.workstream.id)).toEqual(['src/ui/b.tsx']);
  });

  describe('sensitive writes on the foreign-claim route', () => {
    function idleHolder(areas: string[]) {
      const idle = seedWorkstream(base, { project, title: 'Beta', areas });
      state.write((ctx) => {
        acquireClaims(ctx, {
          projectId: project.id,
          workstreamId: idle.workstream.id,
          requests: claimRequestsForTask(idle.task, project),
          leaseExpiresAt: '2999-01-01T00:00:00.000Z',
        });
      });
    }
    const bulkTitle = (n: number) => `${String(n)} writes inside another workstream's claim`;
    const touchMany = (prefix: string) => {
      for (let i = 0; i < STRAY_BULK_THRESHOLD + 1; i += 1) {
        touch(`src/api/${prefix}-${String(i)}.ts`);
        emit(`src/api/${prefix}-${String(i)}.ts`);
      }
    };

    it('keeps a sensitive write on its own card beside the foreign bulk card', async () => {
      running('Alpha', ['ui']);
      idleHolder(['api', 'harness']);
      watcher.sync();
      touchMany('a');
      touch('.claude/settings.json');
      emit('.claude/settings.json');
      await watcher.flush();
      const open = flags();
      expect(open.filter((f) => f.body === '.claude/settings.json')).toHaveLength(1);
      const bulk = open.find((f) => f.title === bulkTitle(STRAY_BULK_THRESHOLD + 1));
      expect(bulk?.detail?.['count']).toBe(STRAY_BULK_THRESHOLD + 1);
      expect(bulk?.body).not.toContain('.claude');
    });

    it('still raises the sensitive card when a foreign bulk card is already open', async () => {
      running('Alpha', ['ui']);
      idleHolder(['api', 'harness']);
      watcher.sync();
      touchMany('a');
      await watcher.flush();
      touchMany('b');
      touch('.claude/settings.json');
      emit('.claude/settings.json');
      await watcher.flush();
      expect(flags().map((f) => f.body)).toContain('.claude/settings.json');
    });
  });

  it('diffs git status against the claims at the end of a step', async () => {
    const { workstream } = running();
    touch('src/api/ok.ts');
    touch('docs/stray.md');
    expect(await watcher.stepEnd(workstream.id)).toEqual(['docs/stray.md']);
    expect(flags()).toEqual([
      expect.objectContaining({
        body: 'docs/stray.md',
        targets: [{ workstreamId: workstream.id, sessionId: null }],
      }),
    ]);
    expect(flags()[0]?.detail).toMatchObject({ path: 'docs/stray.md' });
  });
});

describe('watcher on the real file system', () => {
  it('sees a write through fs.watch and flags it', async () => {
    const real = createWatcher({
      state,
      inbox,
      git: createGit(),
      logger: silentLogger,
      clock: systemClock,
      watch: systemWatch,
      batchMs: 50,
    });
    try {
      running();
      mkdirSync(join(repo.path, 'docs'), { recursive: true });
      real.sync();
      // FSEvents can take a moment to start delivering; keep writing until a flag appears.
      await waitFor(() => {
        writeFileSync(join(repo.path, 'docs', 'real.md'), String(Date.now()));
        return flags().find((f) => f.body === 'docs/real.md');
      }, 15_000);
    } finally {
      real.stop();
    }
  });
});

describe('worktree checkouts', () => {
  let dirs: TempDir[];
  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const dir of dirs) dir.cleanup();
  });

  /** A real git worktree of the project's checkout, its OPEN batch and one workstream claiming `claim`. */
  function inWorktree(
    title: string,
    claim: string,
    workstreamState: WorkstreamState = WorkstreamState.Running,
    /** False launches it holding nothing, as the scheduler launches a task with no areas. */
    claimed = true,
  ) {
    const dir = tempDir('worktree');
    dirs.push(dir);
    const path = join(dir.path, 'wt');
    execFileSync('git', ['-C', repo.path, 'worktree', 'add', '-q', '-b', `b-${title}`, path], {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    });
    const batch = state.write((ctx) => {
      const b = insertBatch(ctx, {
        projectId: project.id,
        title,
        baseBranch: 'main',
        worktreePath: path,
      });
      transitionBatch(ctx, b.id, { to: 'OPEN' });
      patchBatch(ctx, b.id, { branch: `b-${title}`, baseSha: 'a'.repeat(40) });
      return b;
    });
    return { path, batch, ...launchIn(batch, title, claim, workstreamState, claimed) };
  }
  /** A workstream of a new task in `batch`, launched as the scheduler launches one: its claims and STARTING in one write. */
  function launchIn(
    batch: { readonly id: BatchId },
    title: string,
    claim: string,
    workstreamState: WorkstreamState = WorkstreamState.Running,
    claimed = true,
  ) {
    const task = state.write((ctx) =>
      insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: [claim] }),
    );
    const workstream = state.write((ctx) => insertWorkstream(ctx, task.id, { batchId: batch.id }));
    state.write((ctx) => {
      acquireClaims(ctx, {
        projectId: project.id,
        workstreamId: workstream.id,
        requests: claimed ? claimRequestsForTask(task, project) : [],
        leaseExpiresAt: '2999-01-01T00:00:00.000Z',
        areaScope: batch.id,
        copyHazards: copyHazardNames(project),
      });
      transitionWorkstream(ctx, workstream.id, { to: WorkstreamState.Starting, fence: null });
      transitionWorkstream(ctx, workstream.id, { to: WorkstreamState.Running, fence: null });
      if (workstreamState !== WorkstreamState.Running)
        transitionWorkstream(ctx, workstream.id, { to: workstreamState, fence: null });
    });
    return { task, workstream };
  }
  const writeAt = (root: string, rel: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), 'x');
    fake.open.get(root)?.onChange(rel);
  };

  it('watches each live worktree with work in it and stops when its work ends', () => {
    const a = inWorktree('Alpha', 'api');
    const b = inWorktree('Beta', 'ui');
    watcher.sync();
    expect([...fake.open.keys()].sort()).toEqual([a.path, b.path].sort());
    state.write((ctx) =>
      transitionWorkstream(ctx, a.workstream.id, { to: WorkstreamState.Cancelled, fence: null }),
    );
    watcher.sync();
    expect([...fake.open.keys()]).toEqual([b.path]);
    expect(fake.closed).toEqual([a.path]);
  });

  it("judges a write in a worktree by its batch's areas", async () => {
    const a = inWorktree('Alpha', 'ui');
    const b = inWorktree('Beta', 'api');
    watcher.sync();
    writeAt(a.path, 'src/ui/x.ts');
    writeAt(b.path, 'src/ui/x.ts');
    await watcher.flush();
    const open = flags();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      title: 'Write outside every claim',
      body: `${b.path}: src/ui/x.ts`,
      targets: [{ workstreamId: b.workstream.id, sessionId: null }],
    });
    expect(open[0]?.detail).toMatchObject({ path: 'src/ui/x.ts', candidates: [b.workstream.id] });
  });

  it('raises two cards when two worktrees write the same stray path', async () => {
    const a = inWorktree('Alpha', 'api');
    const b = inWorktree('Beta', 'api');
    watcher.sync();
    writeAt(a.path, 'docs/stray.md');
    writeAt(b.path, 'docs/stray.md');
    await watcher.flush();
    expect(
      flags()
        .map((f) => f.body)
        .sort(),
    ).toEqual([`${a.path}: docs/stray.md`, `${b.path}: docs/stray.md`].sort());
  });

  it('counts a per-project hazard claim held in another batch as held, and names its holder on a foreign write', async () => {
    const holder = inWorktree('Alpha', 'migrations');
    const writer = inWorktree('Beta', 'api');
    watcher.sync();
    writeAt(writer.path, 'db/migrations/0001.sql');
    writeAt(writer.path, 'src/api/ok.ts');
    await watcher.flush();
    const open = flags();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      title: "Write inside another workstream's claim",
      body: `${writer.path}: db/migrations/0001.sql`,
    });
    expect(open[0]?.detail).toMatchObject({ claimedBy: [holder.workstream.id] });
  });

  it("judges AGENTS.md in each worktree by that worktree's own claim, with no foreign write", async () => {
    const holder = inWorktree('Alpha', 'harness');
    const other = inWorktree('Beta', 'harness');
    const bystander = inWorktree('Gamma', 'api');
    watcher.sync();
    writeAt(holder.path, 'AGENTS.md');
    writeAt(other.path, 'apps/daemon/AGENTS.md');
    await watcher.flush();
    expect(flags()).toEqual([]);
    writeAt(bystander.path, 'AGENTS.md');
    await watcher.flush();
    const open = flags();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      title: 'Write outside every claim',
      body: `${bystander.path}: AGENTS.md`,
    });
  });

  it("does not let a worktree batch's area claim excuse a write in the main checkout", async () => {
    const shared = running('Alpha', ['api']);
    inWorktree('Beta', 'ui');
    watcher.sync();
    touch('src/ui/x.ts');
    emit('src/ui/x.ts');
    await watcher.flush();
    const open = flags();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: 'Write outside every claim', body: 'src/ui/x.ts' });
    expect(open[0]?.detail).toMatchObject({ candidates: [shared.workstream.id] });
  });

  it("keeps a lane's card open when another lane launches in its copy holding the area that covers it", async () => {
    const a = inWorktree('Alpha', 'api');
    watcher.sync();
    writeAt(a.path, 'src/ui/x.ts');
    await watcher.flush();
    expect(flags()[0]?.detail).toMatchObject({ candidates: [a.workstream.id] });
    launchIn(a.batch, 'Beta', 'ui');
    await watcher.flush();
    expect(flags().map((f) => f.body)).toEqual([`${a.path}: src/ui/x.ts`]);
  });

  describe('a lane holding the whole-repo area in its own copy', () => {
    const WHOLE_REPO = [
      'tests/repo/src/git-hook-variables.test.ts',
      'apps/daemon/test/fixtures.ts',
      'tests/git-isolation.setup.ts',
    ];
    const SENSITIVE = ['.env.local', '.mcp.json', '.claude/settings.json'];
    beforeEach(() => {
      state.write((ctx) =>
        patchProject(ctx, project.id, { areas: [{ name: 'repo', globs: ['**'] }] }),
      );
      project = getProject(base.db, project.id);
    });

    it('raises no card for a write inside its own claim', async () => {
      const lane = inWorktree('Alpha', 'repo');
      watcher.sync();
      for (const rel of WHOLE_REPO) writeAt(lane.path, rel);
      await watcher.flush();
      expect(flags()).toEqual([]);
    });

    it('raises no card for a write while the claim lease is renewed', async () => {
      const lane = inWorktree('Alpha', 'repo');
      watcher.sync();
      for (const rel of WHOLE_REPO) writeAt(lane.path, rel);
      state.write((ctx) => {
        renewClaimLeases(ctx, [lane.workstream.id], '2999-06-01T00:00:00.000Z');
      });
      await watcher.flush();
      expect(flags()).toEqual([]);
    });

    /**
     * The 2026-10-31 cards. Every watched lane state is entered through the scheduler's acquire of the
     * task's areas, and nothing releases an area claim while a lane runs, so a lane only lacks the claim
     * when its task named none (a task filed from an accepted proposal has no areas) and it takes the
     * claim later through request_claim. The writes the watcher saw before the grant were carded, and
     * those cards stayed open beside a lane that by then held a claim covering every one of them.
     */
    it('resolves the cards for its writes once it takes the claim that covers them', async () => {
      const lane = inWorktree('Alpha', 'repo', WorkstreamState.Running, false);
      watcher.sync();
      for (const rel of [...WHOLE_REPO, '.env.local']) writeAt(lane.path, rel);
      await watcher.flush();
      expect(flags()).toHaveLength(WHOLE_REPO.length + 1);
      expect(flags()[0]?.detail).toMatchObject({ candidates: [lane.workstream.id] });
      state.write((ctx) =>
        acquireClaims(ctx, {
          projectId: project.id,
          workstreamId: lane.workstream.id,
          requests: [{ kind: ClaimKind.Area, name: 'repo' }],
          leaseExpiresAt: '2999-01-01T00:00:00.000Z',
          areaScope: lane.batch.id,
        }),
      );
      await watcher.flush();
      expect(flags().map((f) => f.body)).toEqual([`${lane.path}: .env.local`]);
    });

    describe('the bulk card for a lane that wrote past the threshold before its grant', () => {
      const grant = (
        lane: { workstream: { id: WorkstreamId }; batch: { id: BatchId } },
        name: string,
      ) =>
        state.write((ctx) =>
          acquireClaims(ctx, {
            projectId: project.id,
            workstreamId: lane.workstream.id,
            requests: [{ kind: ClaimKind.Area, name }],
            leaseExpiresAt: '2999-01-01T00:00:00.000Z',
            areaScope: lane.batch.id,
          }),
        );
      beforeEach(() => {
        state.write((ctx) =>
          patchProject(ctx, project.id, {
            areas: [
              { name: 'repo', globs: ['**'] },
              { name: 'ui', globs: ['src/ui/**'] },
            ],
          }),
        );
        project = getProject(base.db, project.id);
      });
      const bulk = () => flags().filter((f) => f.title.endsWith('writes outside every claim'));
      const writeMany = (root: string, dir: string, count: number) => {
        for (let i = 0; i < count; i += 1)
          writeAt(root, `${dir}/file-${String(i).padStart(3, '0')}.ts`);
      };

      it('resolves once the lane takes a claim covering every path', async () => {
        const lane = inWorktree('Alpha', 'repo', WorkstreamState.Running, false);
        watcher.sync();
        writeMany(lane.path, 'docs/gen', STRAY_BULK_THRESHOLD + 10);
        await watcher.flush();
        expect(bulk()).toHaveLength(1);
        grant(lane, 'repo');
        await watcher.flush();
        expect(flags()).toEqual([]);
      });

      it('stays open when a path the card lists is not covered', async () => {
        const lane = inWorktree('Alpha', 'ui', WorkstreamState.Running, false);
        watcher.sync();
        writeMany(lane.path, 'docs/gen', STRAY_BULK_THRESHOLD + 10);
        await watcher.flush();
        grant(lane, 'ui');
        await watcher.flush();
        expect(bulk()).toHaveLength(1);
      });

      it('stays open when a path the card does not list is not covered', async () => {
        const lane = inWorktree('Alpha', 'ui', WorkstreamState.Running, false);
        watcher.sync();
        writeMany(lane.path, 'src/ui', STRAY_BULK_THRESHOLD + 10);
        writeAt(lane.path, 'zzz/last.ts');
        await watcher.flush();
        expect(bulk()[0]?.detail?.['paths']).not.toContain('zzz/last.ts');
        grant(lane, 'ui');
        await watcher.flush();
        expect(bulk()).toHaveLength(1);
      });

      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, { cwd, env: isolatedGitEnv(), stdio: 'pipe' });
      const baseAt = (lane: { workstream: { id: WorkstreamId }; path: string }) => {
        const head = git(lane.path, 'rev-parse', 'HEAD').toString().trim();
        state.write((ctx) => {
          patchWorkstream(ctx, lane.workstream.id, null, { baseHead: head });
        });
      };
      /** Commits `rel` as the commit tool would. */
      const commit = (root: string, rel: string) => {
        git(root, 'add', rel);
        git(root, 'commit', '-q', '-m', `Add ${rel}`);
      };

      it('stays open when an unlisted path the lane committed is not covered', async () => {
        const lane = inWorktree('Alpha', 'ui', WorkstreamState.Running, false);
        baseAt(lane);
        watcher.sync();
        writeMany(lane.path, 'src/ui', STRAY_BULK_THRESHOLD + 10);
        writeAt(lane.path, 'zzz/last.ts');
        await watcher.flush();
        expect(bulk()[0]?.detail?.['paths']).not.toContain('zzz/last.ts');
        commit(lane.path, 'zzz/last.ts');
        grant(lane, 'ui');
        await watcher.flush();
        expect(bulk()).toHaveLength(1);
      });

      it('resolves once a claim covers every path, the committed ones too', async () => {
        const lane = inWorktree('Alpha', 'ui', WorkstreamState.Running, false);
        baseAt(lane);
        watcher.sync();
        writeMany(lane.path, 'src/ui', STRAY_BULK_THRESHOLD + 10);
        await watcher.flush();
        commit(lane.path, 'src/ui/file-029.ts');
        grant(lane, 'ui');
        await watcher.flush();
        expect(flags()).toEqual([]);
      });

      describe("in a copy shared with another lane that commits in that lane's own area", () => {
        beforeEach(() => {
          state.write((ctx) =>
            patchProject(ctx, project.id, {
              areas: [
                { name: 'ui', globs: ['src/ui/**'] },
                { name: 'docs', globs: ['docs/**'] },
              ],
            }),
          );
          project = getProject(base.db, project.id);
        });

        it("resolves once the lane's claim covers all its writes", async () => {
          const lane = inWorktree('Alpha', 'ui', WorkstreamState.Running, false);
          baseAt(lane);
          launchIn(lane.batch, 'Beta', 'docs');
          watcher.sync();
          writeMany(lane.path, 'src/ui', STRAY_BULK_THRESHOLD + 10);
          await watcher.flush();
          expect(bulk()).toHaveLength(1);
          writeAt(lane.path, 'docs/b.md');
          commit(lane.path, 'docs/b.md');
          grant(lane, 'ui');
          await watcher.flush();
          expect(flags()).toEqual([]);
        });

        it('stays open when an unlisted write, committed or not, is covered by no claim', async () => {
          const lane = inWorktree('Alpha', 'ui', WorkstreamState.Running, false);
          baseAt(lane);
          launchIn(lane.batch, 'Beta', 'docs');
          watcher.sync();
          writeMany(lane.path, 'src/ui', STRAY_BULK_THRESHOLD + 10);
          writeAt(lane.path, 'zzz/last.ts');
          await watcher.flush();
          expect(bulk()[0]?.detail?.['paths']).not.toContain('zzz/last.ts');
          writeAt(lane.path, 'docs/b.md');
          commit(lane.path, 'docs/b.md');
          commit(lane.path, 'zzz/last.ts');
          grant(lane, 'ui');
          await watcher.flush();
          expect(bulk()).toHaveLength(1);
        });

        it("still judges a listed path by the granted lane's own claims", async () => {
          const lane = inWorktree('Alpha', 'ui', WorkstreamState.Running, false);
          baseAt(lane);
          launchIn(lane.batch, 'Beta', 'docs');
          // A card from before Beta's claim, listing a path only Beta's claim covers.
          inbox.flag({
            projectId: project.id,
            workstreamId: lane.workstream.id,
            title: `${String(STRAY_BULK_THRESHOLD + 1)} writes outside every claim`,
            body: `${lane.path}: docs/a.md\n…and 1 more`,
            detail: {
              count: STRAY_BULK_THRESHOLD + 1,
              paths: ['docs/a.md'],
              candidates: [lane.workstream.id],
            },
            foldKey: `stray-write:${lane.batch.id}:bulk`,
          });
          watcher.sync();
          grant(lane, 'ui');
          await watcher.flush();
          expect(bulk()).toHaveLength(1);
        });
      });

      it('stays open when a path it lists is sensitive', async () => {
        const lane = inWorktree('Alpha', 'repo', WorkstreamState.Running, false);
        inbox.flag({
          projectId: project.id,
          workstreamId: lane.workstream.id,
          title: `${String(STRAY_BULK_THRESHOLD + 1)} writes outside every claim`,
          body: `${lane.path}: .mcp.json\n…and 1 more`,
          detail: {
            count: STRAY_BULK_THRESHOLD + 1,
            paths: ['.mcp.json'],
            candidates: [lane.workstream.id],
          },
          foldKey: `stray-write:${lane.batch.id}:bulk`,
        });
        watcher.sync();
        grant(lane, 'repo');
        await watcher.flush();
        expect(bulk()).toHaveLength(1);
      });

      it("stays open when the claim is another lane's", async () => {
        const lane = inWorktree('Alpha', 'repo', WorkstreamState.Running, false);
        const other = inWorktree('Beta', 'repo', WorkstreamState.Running, false);
        watcher.sync();
        writeMany(lane.path, 'docs/gen', STRAY_BULK_THRESHOLD + 10);
        await watcher.flush();
        grant(other, 'repo');
        await watcher.flush();
        expect(bulk()).toHaveLength(1);
      });
    });

    it("keeps a card that a claim taken in another copy doesn't cover", async () => {
      const lane = inWorktree('Alpha', 'repo', WorkstreamState.Running, false);
      const other = inWorktree('Beta', 'repo', WorkstreamState.Running, false);
      watcher.sync();
      writeAt(lane.path, 'docs/stray.md');
      await watcher.flush();
      state.write((ctx) =>
        acquireClaims(ctx, {
          projectId: project.id,
          workstreamId: other.workstream.id,
          requests: [{ kind: ClaimKind.Area, name: 'repo' }],
          leaseExpiresAt: '2999-01-01T00:00:00.000Z',
          areaScope: other.batch.id,
        }),
      );
      await watcher.flush();
      expect(flags().map((f) => f.body)).toEqual([`${lane.path}: docs/stray.md`]);
    });

    it('still flags a write no held claim covers', async () => {
      const lane = inWorktree('Alpha', 'repo');
      const idle = inWorktree('Beta', 'repo');
      state.write((ctx) => {
        releaseClaims(ctx, lane.workstream.id);
        releaseClaims(ctx, idle.workstream.id);
      });
      watcher.sync();
      writeAt(lane.path, 'docs/stray.md');
      writeAt(idle.path, 'docs/stray.md');
      await watcher.flush();
      expect(
        flags()
          .map((f) => f.body)
          .sort(),
      ).toEqual([`${lane.path}: docs/stray.md`, `${idle.path}: docs/stray.md`].sort());
    });

    it('still flags sensitive paths whatever the claims say', async () => {
      const lane = inWorktree('Alpha', 'repo');
      watcher.sync();
      for (const rel of SENSITIVE) writeAt(lane.path, rel);
      await watcher.flush();
      expect(
        flags()
          .map((f) => f.body)
          .sort(),
      ).toEqual(SENSITIVE.map((rel) => `${lane.path}: ${rel}`).sort());
    });
  });

  it('flags a sensitive write at a step end even inside the workstream’s own claim', async () => {
    state.write((ctx) =>
      patchProject(ctx, project.id, { areas: [{ name: 'repo', globs: ['**'] }] }),
    );
    const lane = inWorktree('Alpha', 'repo');
    mkdirSync(join(lane.path, 'src'), { recursive: true });
    writeFileSync(join(lane.path, 'src/ok.ts'), 'x');
    writeFileSync(join(lane.path, '.mcp.json'), '{}');
    expect(await watcher.stepEnd(lane.workstream.id)).toEqual(['.mcp.json']);
    expect(flags().map((f) => f.body)).toEqual([`${lane.path}: .mcp.json`]);
  });

  it('reads the worktree at a step end, scoped to its batch', async () => {
    const a = inWorktree('Alpha', 'ui');
    inWorktree('Beta', 'api');
    mkdirSync(join(a.path, 'src/ui'), { recursive: true });
    writeFileSync(join(a.path, 'src/ui/x.ts'), 'x');
    writeFileSync(join(a.path, 'src/api.ts'), 'x');
    expect(await watcher.stepEnd(a.workstream.id)).toEqual(['src/api.ts']);
    expect(flags().map((f) => f.body)).toEqual([`${a.path}: src/api.ts`]);
  });

  describe("10db's own base merge into the copy", () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, env: isolatedGitEnv(), stdio: 'pipe' }).toString().trim();
    const MERGED = ['apps/daemon/.env.example', '.mcp.json', 'src/api/new.ts'];
    const bodies = () =>
      flags()
        .map((f) => f.body)
        .sort();

    /**
     * Commits `files` on a copy of main and points `refs/remotes/origin/main` at it, as a fetch of
     * origin's newer commits does.
     */
    function upstream(files: readonly string[]): void {
      const dir = tempDir('upstream');
      dirs.push(dir);
      const at = join(dir.path, 'up');
      git(repo.path, 'worktree', 'add', '-q', '--detach', at, 'main');
      for (const rel of files) {
        mkdirSync(dirname(join(at, rel)), { recursive: true });
        writeFileSync(join(at, rel), `base ${rel}`);
      }
      git(at, 'add', '--', ...files);
      git(at, 'commit', '-q', '-m', 'upstream work');
      git(repo.path, 'update-ref', 'refs/remotes/origin/main', git(at, 'rev-parse', 'HEAD'));
    }
    /** Merges origin/main into the copy's branch, as base-update does, and reports each path it wrote. */
    function mergeBase(path: string, written: readonly string[]): void {
      git(path, 'merge', '-q', '--no-edit', 'refs/remotes/origin/main');
      for (const rel of written) fake.open.get(path)?.onChange(rel);
    }
    /** Commits `rel` in the copy as the lane's commit-tool call does. */
    function laneCommit(path: string, rel: string, text = 'lane'): void {
      mkdirSync(dirname(join(path, rel)), { recursive: true });
      writeFileSync(join(path, rel), text);
      git(path, 'add', '--', rel);
      git(path, 'commit', '-q', '-m', `lane ${rel}`);
      fake.open.get(path)?.onChange(rel);
    }

    it('raises no card for any merged file, .env.example included, after a merge commit', async () => {
      const lane = inWorktree('Alpha', 'ui');
      watcher.sync();
      laneCommit(lane.path, 'src/ui/mine.ts');
      upstream(MERGED);
      mergeBase(lane.path, MERGED);
      await watcher.flush();
      expect(bodies()).toEqual([]);
    });

    it('raises no card for any merged file after a fast-forward to the base', async () => {
      const lane = inWorktree('Alpha', 'ui');
      watcher.sync();
      upstream(MERGED);
      mergeBase(lane.path, MERGED);
      await watcher.flush();
      expect(bodies()).toEqual([]);
    });

    it('raises no card for a new directory under .claude/ that the merge brought in', async () => {
      const lane = inWorktree('Alpha', 'ui');
      watcher.sync();
      upstream(['.claude/skills/new-skill/SKILL.md', '.claude/skills/new-skill/refs/a.md']);
      mergeBase(lane.path, [
        '.claude/skills/new-skill',
        '.claude/skills/new-skill/refs',
        '.claude/skills/new-skill/SKILL.md',
        '.claude/skills/new-skill/refs/a.md',
      ]);
      await watcher.flush();
      expect(bodies()).toEqual([]);
    });

    it('still flags a merged .claude/ directory once a lane adds an untracked file to it', async () => {
      const lane = inWorktree('Alpha', 'ui');
      watcher.sync();
      upstream(['.claude/skills/new-skill/SKILL.md']);
      mergeBase(lane.path, []);
      writeAt(lane.path, '.claude/skills/new-skill/extra.md');
      fake.open.get(lane.path)?.onChange('.claude/skills/new-skill');
      await watcher.flush();
      expect(bodies()).toEqual([
        `${lane.path}: .claude/skills/new-skill`,
        `${lane.path}: .claude/skills/new-skill/extra.md`,
      ]);
    });

    it('still flags a new .claude/ directory a lane made and committed', async () => {
      const lane = inWorktree('Alpha', 'ui');
      watcher.sync();
      laneCommit(lane.path, '.claude/skills/mine/SKILL.md');
      fake.open.get(lane.path)?.onChange('.claude/skills/mine');
      await watcher.flush();
      expect(bodies()).toEqual([
        `${lane.path}: .claude/skills/mine`,
        `${lane.path}: .claude/skills/mine/SKILL.md`,
      ]);
    });

    it('still flags a .mcp.json the lane commits before its batch runs', async () => {
      const lane = inWorktree('Alpha', 'ui');
      watcher.sync();
      laneCommit(lane.path, '.mcp.json');
      await watcher.flush();
      expect(bodies()).toEqual([`${lane.path}: .mcp.json`]);
    });

    it('still flags a lane commit that changes a .mcp.json the merge brought in', async () => {
      const lane = inWorktree('Alpha', 'ui');
      watcher.sync();
      upstream(['.mcp.json']);
      mergeBase(lane.path, ['.mcp.json']);
      await watcher.flush();
      expect(bodies()).toEqual([]);
      laneCommit(lane.path, '.mcp.json', '{"lane":true}');
      await watcher.flush();
      expect(bodies()).toEqual([`${lane.path}: .mcp.json`]);
    });
  });

  describe('a write a permission card allowed', () => {
    const SENSITIVE_FILE = '.mcp.json';

    /**
     * The Allow Edit card the broker raises for a lane's edit of `rel`, answered with `choice`. A `summary`
     * that is no absolute path gives a card whose choice stores no rule, so the card alone stands for it.
     */
    function editCard(
      lane: { workstream: WorkstreamDto },
      rel: string,
      choice: string,
      root = repo.path,
      summary: string | null = null,
      owner: ProjectDto = project,
    ): void {
      const path = join(root, rel);
      const { item } = inbox.ask({
        projectId: owner.id,
        workstreamId: lane.workstream.id,
        sessionId: mintId('Session'),
        kind: 'permission',
        title: 'Allow Edit?',
        body: path,
        options: [
          { label: 'allow_once', description: '' },
          { label: 'allow_workstream', description: '' },
          { label: 'allow_project', description: '' },
          { label: 'deny', description: '' },
        ],
        recommendation: null,
        category: 'environment',
        urgency: 'normal',
        detail: { toolName: 'Edit', summary: summary ?? path, path },
        signal: new AbortController().signal,
      });
      inbox.answer(item.id, { choice });
    }
    const write = async (rel: string): Promise<void> => {
      touch(rel);
      emit(rel);
      await watcher.flush();
    };

    it('raises no stray card for an Edit its Allow Edit card allowed once', async () => {
      const lane = running();
      watcher.sync();
      editCard(lane, SENSITIVE_FILE, 'allow_once');
      await write(SENSITIVE_FILE);
      expect(flags()).toEqual([]);
    });

    it('still raises the stray card for a sensitive write no card allowed', async () => {
      running();
      watcher.sync();
      await write(SENSITIVE_FILE);
      expect(flags().map((f) => f.body)).toEqual([SENSITIVE_FILE]);
    });

    it('cards a write after an allowed one when nothing allowed it', async () => {
      const lane = running();
      watcher.sync();
      editCard(lane, SENSITIVE_FILE, 'allow_once');
      await write(SENSITIVE_FILE);
      expect(flags()).toEqual([]);
      await write(SENSITIVE_FILE);
      expect(flags().map((f) => f.body)).toEqual([SENSITIVE_FILE]);
    });

    it('lets a second allowed card excuse the second write', async () => {
      const lane = running();
      watcher.sync();
      editCard(lane, SENSITIVE_FILE, 'allow_once');
      await write(SENSITIVE_FILE);
      editCard(lane, SENSITIVE_FILE, 'allow_once');
      await write(SENSITIVE_FILE);
      expect(flags()).toEqual([]);
    });

    it('cards a write whose permission card was denied', async () => {
      const lane = running();
      watcher.sync();
      editCard(lane, SENSITIVE_FILE, 'deny');
      await write(SENSITIVE_FILE);
      expect(flags().map((f) => f.body)).toEqual([SENSITIVE_FILE]);
    });

    it('cards a write to another file than the one allowed', async () => {
      const lane = running();
      watcher.sync();
      editCard(lane, SENSITIVE_FILE, 'allow_once');
      await write('.env');
      expect(flags().map((f) => f.body)).toEqual(['.env']);
    });

    it('excuses an ordinary stray the card allowed too', async () => {
      const lane = running();
      watcher.sync();
      editCard(lane, 'docs/stray.md', 'allow_once');
      await write('docs/stray.md');
      expect(flags()).toEqual([]);
    });

    it('keeps excusing every later write after an allow for the workstream', async () => {
      const lane = running();
      watcher.sync();
      editCard(lane, SENSITIVE_FILE, 'allow_workstream');
      await write(SENSITIVE_FILE);
      await write(SENSITIVE_FILE);
      expect(flags()).toEqual([]);
    });

    it('excuses one write after an allow for the workstream that stored no rule, then cards the next', async () => {
      const lane = running();
      watcher.sync();
      const globFile = 'docs/a[1].md';
      editCard(lane, globFile, 'allow_workstream');
      await write(globFile);
      expect(flags()).toEqual([]);
      await write(globFile);
      expect(flags().map((f) => f.body)).toEqual([globFile]);
    });

    it('does not let a card allowed for another lane excuse this one', async () => {
      const a = running('Alpha', ['api']);
      const b = running('Beta', ['ui']);
      watcher.sync();
      editCard(a, SENSITIVE_FILE, 'allow_once');
      editCard(b, 'docs/other.md', 'allow_once');
      await write('docs/other.md');
      await write(SENSITIVE_FILE);
      expect(flags()).toEqual([]);
      await write(SENSITIVE_FILE);
      expect(flags().map((f) => f.body)).toEqual([SENSITIVE_FILE]);
    });

    it('keeps excusing every later write on an allow-for-workstream card that stored no rule', async () => {
      const lane = running();
      watcher.sync();
      editCard(lane, SENSITIVE_FILE, 'allow_workstream', repo.path, 'the manifest');
      // The choice stored a rule for the tool but none scoped to the file.
      expect(
        listPermissionRules(base.db, project.id, lane.workstream.id).map((r) => r.pattern),
      ).toEqual([null]);
      await write(SENSITIVE_FILE);
      await write(SENSITIVE_FILE);
      expect(flags()).toEqual([]);
    });

    it.each([
      ['for the workstream', true],
      ['for the whole project', false],
    ])('keeps excusing every later write on a stored rule %s, with no card', async (_name, own) => {
      const lane = running();
      watcher.sync();
      state.write((ctx) =>
        insertPermissionRule(ctx, {
          projectId: project.id,
          workstreamId: own ? lane.workstream.id : null,
          toolName: 'Edit',
          pattern: join(repo.path, SENSITIVE_FILE),
          sourceInboxId: null,
        }),
      );
      await write(SENSITIVE_FILE);
      await write(SENSITIVE_FILE);
      expect(flags()).toEqual([]);
    });

    it('cards a write when the stored rule names another file', async () => {
      const lane = running();
      watcher.sync();
      state.write((ctx) =>
        insertPermissionRule(ctx, {
          projectId: project.id,
          workstreamId: lane.workstream.id,
          toolName: 'Edit',
          pattern: join(repo.path, '.env'),
          sourceInboxId: null,
        }),
      );
      await write(SENSITIVE_FILE);
      expect(flags().map((f) => f.body)).toEqual([SENSITIVE_FILE]);
    });

    it.each([['allow_once'], ['allow_workstream']])(
      'does not let a card (%s) of a lane that finished excuse a write in the copy it shared',
      async (choice) => {
        const done = inWorktree('Alpha', 'ui');
        launchIn(done.batch, 'Beta', 'api');
        editCard(done, SENSITIVE_FILE, choice, done.path, 'the manifest');
        state.write((ctx) =>
          transitionWorkstream(ctx, done.workstream.id, {
            to: WorkstreamState.Cancelled,
            fence: null,
          }),
        );
        watcher.sync();
        writeAt(done.path, SENSITIVE_FILE);
        await watcher.flush();
        expect(flags().map((f) => f.body)).toEqual([`${done.path}: ${SENSITIVE_FILE}`]);
      },
    );

    it.each([['allow_once'], ['allow_workstream']])(
      "does not let a card (%s) of another workstream excuse this one's step end",
      async (choice) => {
        const mine = running('Alpha', ['api']);
        const other = running('Beta', ['ui']);
        editCard(other, SENSITIVE_FILE, choice, repo.path, 'the manifest');
        touch(SENSITIVE_FILE);
        expect(await watcher.stepEnd(mine.workstream.id)).toEqual([SENSITIVE_FILE]);
        expect(flags().map((f) => f.body)).toEqual([SENSITIVE_FILE]);
      },
    );

    describe('a checkout reached through a symlink', () => {
      /** A project whose checkout is a link to the repository, and a card naming the file by its real path. */
      function linked() {
        const link = join(tempDir('link').path, 'checkout');
        symlinkSync(repo.path, link);
        const owner = seedProject(base, { repoPath: link });
        const seeded = seedWorkstream(base, { project: owner, title: 'Linked', areas: ['api'] });
        state.write((ctx) => {
          acquireClaims(ctx, {
            projectId: owner.id,
            workstreamId: seeded.workstream.id,
            requests: claimRequestsForTask(seeded.task, owner),
            leaseExpiresAt: '2999-01-01T00:00:00.000Z',
          });
          transitionWorkstream(ctx, seeded.workstream.id, {
            to: WorkstreamState.Starting,
            fence: null,
          });
          transitionWorkstream(ctx, seeded.workstream.id, {
            to: WorkstreamState.Running,
            fence: null,
          });
        });
        const real = realpathSync(repo.path);
        expect(real).not.toBe(link);
        return { link, real, owner, lane: seeded };
      }

      it("excuses a live write by the card's real path", async () => {
        const { link, real, owner, lane } = linked();
        watcher.sync();
        editCard(lane, SENSITIVE_FILE, 'allow_once', real, null, owner);
        writeFileSync(join(link, SENSITIVE_FILE), 'x');
        fake.open.get(link)?.onChange(SENSITIVE_FILE);
        await watcher.flush();
        expect(flags()).toEqual([]);
      });

      it("excuses a step end write by the card's real path", async () => {
        const { link, real, owner, lane } = linked();
        editCard(lane, SENSITIVE_FILE, 'allow_once', real, null, owner);
        writeFileSync(join(link, SENSITIVE_FILE), 'x');
        expect(await watcher.stepEnd(lane.workstream.id)).toEqual([]);
        expect(flags()).toEqual([]);
      });

      it('still cards a write whose card names another file', async () => {
        const { link, real, owner, lane } = linked();
        editCard(lane, '.env', 'allow_once', real, null, owner);
        writeFileSync(join(link, SENSITIVE_FILE), 'x');
        expect(await watcher.stepEnd(lane.workstream.id)).toEqual([SENSITIVE_FILE]);
      });
    });

    it("excuses an allowed edit in a worktree, by the card's path in that copy", async () => {
      const lane = inWorktree('Alpha', 'ui');
      watcher.sync();
      editCard(lane, SENSITIVE_FILE, 'allow_once', lane.path);
      writeAt(lane.path, SENSITIVE_FILE);
      await watcher.flush();
      expect(flags()).toEqual([]);
    });

    it('does not let a card allowed in the main checkout excuse a write in a worktree copy', async () => {
      const lane = inWorktree('Alpha', 'ui');
      watcher.sync();
      editCard(lane, SENSITIVE_FILE, 'allow_once', repo.path);
      writeAt(lane.path, SENSITIVE_FILE);
      await watcher.flush();
      expect(flags().map((f) => f.body)).toEqual([`${lane.path}: ${SENSITIVE_FILE}`]);
    });

    it('reports no stray at the step end for an edit its card allowed', async () => {
      const lane = running();
      editCard(lane, SENSITIVE_FILE, 'allow_once');
      touch(SENSITIVE_FILE);
      expect(await watcher.stepEnd(lane.workstream.id)).toEqual([]);
      expect(flags()).toEqual([]);
    });

    it('reports a step end sensitive write that no card allowed', async () => {
      const lane = running();
      touch(SENSITIVE_FILE);
      expect(await watcher.stepEnd(lane.workstream.id)).toEqual([SENSITIVE_FILE]);
    });

    it('cards at the step end a later write the live watcher never processed', async () => {
      const lane = running();
      watcher.sync();
      editCard(lane, SENSITIVE_FILE, 'allow_once');
      await write(SENSITIVE_FILE);
      expect(flags()).toEqual([]);
      writeFileSync(join(repo.path, SENSITIVE_FILE), 'rewritten by a command');
      expect(await watcher.stepEnd(lane.workstream.id)).toEqual([SENSITIVE_FILE]);
      expect(flags().map((f) => f.body)).toEqual([SENSITIVE_FILE]);
    });

    it('excuses at the step end an allowed write, and the live batch after it raises no card', async () => {
      const lane = running();
      watcher.sync();
      editCard(lane, SENSITIVE_FILE, 'allow_once');
      touch(SENSITIVE_FILE);
      expect(await watcher.stepEnd(lane.workstream.id)).toEqual([]);
      emit(SENSITIVE_FILE);
      await watcher.flush();
      expect(flags()).toEqual([]);
    });

    it('still excuses the write at the step end after the live watcher used the card', async () => {
      const lane = running();
      watcher.sync();
      editCard(lane, SENSITIVE_FILE, 'allow_once');
      await write(SENSITIVE_FILE);
      expect(await watcher.stepEnd(lane.workstream.id)).toEqual([]);
      expect(flags()).toEqual([]);
    });

    describe('a directory the allowed write created', () => {
      const FILE = '.codex/rules/new.rules';
      const emitBoth = async (): Promise<void> => {
        touch(FILE);
        emit('.codex/rules');
        emit(FILE);
        await watcher.flush();
      };

      it('raises no stray card for the new directory that holds only the allowed file', async () => {
        const lane = running();
        watcher.sync();
        editCard(lane, FILE, 'allow_once');
        await emitBoth();
        expect(flags()).toEqual([]);
      });

      it('raises no stray card when only the directory is reported', async () => {
        const lane = running();
        watcher.sync();
        editCard(lane, FILE, 'allow_once');
        touch(FILE);
        emit('.codex/rules');
        await watcher.flush();
        expect(flags()).toEqual([]);
      });

      it('still cards the directory that holds a file no card allowed', async () => {
        const lane = running();
        watcher.sync();
        editCard(lane, FILE, 'allow_once');
        touch('.codex/rules/other.rules');
        await emitBoth();
        expect(flags().map((f) => f.body)).toContain('.codex/rules');
      });

      it('cards the directory again when a later write no card allowed lands in it', async () => {
        const lane = running();
        watcher.sync();
        editCard(lane, FILE, 'allow_once');
        await emitBoth();
        expect(flags()).toEqual([]);
        await emitBoth();
        expect(
          flags()
            .map((f) => f.body)
            .sort(),
        ).toEqual(['.codex/rules', FILE]);
      });
    });

    describe('a folded Allow Edit card', () => {
      /** Both lanes ask to edit `rel`; the inbox folds the two asks into one card, answered once. */
      function foldedCard(
        lanes: readonly { workstream: WorkstreamDto }[],
        rel: string,
        choice: string,
      ): void {
        const path = join(repo.path, rel);
        const items = lanes.map(
          (lane) =>
            inbox.ask({
              projectId: project.id,
              workstreamId: lane.workstream.id,
              sessionId: mintId('Session'),
              kind: 'permission',
              title: 'Allow Edit?',
              body: path,
              options: [
                { label: 'allow_once', description: '' },
                { label: 'deny', description: '' },
              ],
              recommendation: null,
              category: 'environment',
              urgency: 'normal',
              detail: { toolName: 'Edit', summary: path, path },
              signal: new AbortController().signal,
            }).item,
        );
        expect(new Set(items.map((i) => i.id)).size).toBe(1);
        const first = items[0];
        if (!first) throw new Error('no card');
        inbox.answer(first.id, { choice });
      }

      it('excuses one write per lane it targets, and cards the next', async () => {
        const a = running('Alpha', ['api']);
        const b = running('Beta', ['ui']);
        watcher.sync();
        foldedCard([a, b], SENSITIVE_FILE, 'allow_once');
        await write(SENSITIVE_FILE);
        await write(SENSITIVE_FILE);
        expect(flags()).toEqual([]);
        await write(SENSITIVE_FILE);
        expect(flags().map((f) => f.body)).toEqual([SENSITIVE_FILE]);
      });
    });

    it('cards a write that a card answered before the watcher started, whatever other projects hold', async () => {
      const lane = running();
      editCard(lane, SENSITIVE_FILE, 'allow_once');
      // Another project answers more cards than one read takes, all newer than the card above, so the card
      // is among its own project's latest answered but not among the latest across every project.
      const other = seedProject(base, { repoPath: join(repo.path, 'other') });
      const otherLane = seedWorkstream(base, { project: other, title: 'Other', areas: ['api'] });
      for (let i = 0; i < ANSWERED_CARDS_READ + 20; i++) {
        const { item } = inbox.ask({
          projectId: other.id,
          workstreamId: otherLane.workstream.id,
          sessionId: mintId('Session'),
          kind: 'permission',
          title: 'Allow Edit?',
          body: `other ${String(i)}`,
          options: [{ label: 'deny', description: '' }],
          recommendation: null,
          category: 'environment',
          urgency: 'normal',
          detail: null,
          signal: new AbortController().signal,
        });
        inbox.answer(item.id, { choice: 'deny' });
      }
      watcher.stop();
      watcher = createWatcher({
        state,
        inbox,
        git: createGit(),
        logger: silentLogger,
        clock,
        watch: fake.watch,
        batchMs: 500,
      });
      watcher.sync();
      await write(SENSITIVE_FILE);
      expect(flags().map((f) => f.body)).toEqual([SENSITIVE_FILE]);
    });
  });
});
