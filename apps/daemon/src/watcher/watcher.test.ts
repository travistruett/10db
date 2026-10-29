import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  WorkstreamState,
  type InboxItemDto,
  type ProjectDto,
  type TaskDto,
  type WorkstreamDto,
} from '@10db/contracts';
import {
  acquireClaims,
  claimRequestsForTask,
  createTestStore,
  insertBatch,
  insertTask,
  insertWorkstream,
  listInbox,
  patchBatch,
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
import { silentLogger } from '../log';
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
let fake: FakeWatch;
let watcher: Watcher;

beforeEach(() => {
  ({ store: base, close } = createTestStore());
  state = createStateStore(base, createEventBus());
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  repo = createTempRepo();
  project = seedProject(base, { repoPath: repo.path });
  clock = new ManualClock();
  fake = fakeWatch();
  watcher = createWatcher({
    state,
    inbox,
    git: createGit(),
    logger: silentLogger,
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

  describe("Claude Code's write staging directory", () => {
    const staging = '.claude/.cc-writes';
    const staged = `${staging}/settings.local.json.tmp`;
    const makeStaging = () => {
      mkdirSync(join(repo.path, staging), { recursive: true, mode: 0o700 });
    };

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
          const target = tempDir('claude-link').path;
          mkdirSync(join(target, '.cc-writes'));
          symlinkSync(target, join(repo.path, '.claude'));
        },
        events: ['.claude'],
        expected: ['.claude'],
      },
      {
        name: 'is judged against the claims when git reports a file left in it',
        ignore: '',
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
  ) {
    const dir = tempDir('worktree');
    dirs.push(dir);
    const path = join(dir.path, 'wt');
    execFileSync('git', ['-C', repo.path, 'worktree', 'add', '-q', '-b', `b-${title}`, path], {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    });
    const task = state.write((ctx) =>
      insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: [claim] }),
    );
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
    const workstream = state.write((ctx) => insertWorkstream(ctx, task.id, { batchId: batch.id }));
    state.write((ctx) => {
      acquireClaims(ctx, {
        projectId: project.id,
        workstreamId: workstream.id,
        requests: claimRequestsForTask(task, project),
        leaseExpiresAt: '2999-01-01T00:00:00.000Z',
        areaScope: batch.id,
      });
      transitionWorkstream(ctx, workstream.id, { to: WorkstreamState.Starting, fence: null });
      transitionWorkstream(ctx, workstream.id, { to: WorkstreamState.Running, fence: null });
      if (workstreamState !== WorkstreamState.Running)
        transitionWorkstream(ctx, workstream.id, { to: workstreamState, fence: null });
    });
    return { path, batch, task, workstream };
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

  it('counts a hazard claim held in another batch as held, and names its holder on a foreign write', async () => {
    const holder = inWorktree('Alpha', 'harness');
    const writer = inWorktree('Beta', 'api');
    watcher.sync();
    writeAt(writer.path, 'AGENTS.md');
    writeAt(writer.path, 'src/api/ok.ts');
    await watcher.flush();
    const open = flags();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      title: "Write inside another workstream's claim",
      body: `${writer.path}: AGENTS.md`,
    });
    expect(open[0]?.detail).toMatchObject({ claimedBy: [holder.workstream.id] });
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

  it('reads the worktree at a step end, scoped to its batch', async () => {
    const a = inWorktree('Alpha', 'ui');
    inWorktree('Beta', 'api');
    mkdirSync(join(a.path, 'src/ui'), { recursive: true });
    writeFileSync(join(a.path, 'src/ui/x.ts'), 'x');
    writeFileSync(join(a.path, 'src/api.ts'), 'x');
    expect(await watcher.stepEnd(a.workstream.id)).toEqual(['src/api.ts']);
    expect(flags().map((f) => f.body)).toEqual([`${a.path}: src/api.ts`]);
  });
});
