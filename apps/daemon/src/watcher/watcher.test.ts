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
  ConflictError,
  WorkstreamState,
  type BatchId,
  type InboxItemDto,
  type ProjectDto,
  type TaskDto,
  type WorkstreamDto,
} from '@10db/contracts';
import {
  acquireClaims,
  claimRequestsForTask,
  copyHazardNames,
  createTestStore,
  insertBatch,
  insertTask,
  insertWorkstream,
  listInbox,
  getProject,
  patchBatch,
  patchProject,
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
import { createInboxService, stampFile, trustedWrites, type InboxService } from '../inbox';
import { silentLogger, type Logger } from '../log';
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

const openFlags = (): InboxItemDto[] =>
  listInbox(base.db, { states: ['OPEN'] }).filter((i) => i.kind === 'flag');
// A stamped card ends its body with the short stamp of the version it shows; most tests are about the rest.
const VERSION_LINE = /\nVersion [0-9a-f]{12}$/;
const flags = (): InboxItemDto[] =>
  openFlags().map((i) => ({ ...i, body: i.body.replace(VERSION_LINE, '') }));
const emit = (rel: string) => {
  fake.open.get(repo.path)?.onChange(rel);
};
const touch = (rel: string) => {
  mkdirSync(dirname(join(repo.path, rel)), { recursive: true });
  writeFileSync(join(repo.path, rel), 'x');
};

describe('watcher', () => {
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
      expect(flags().map((f) => f.body.split('\n')[0])).toEqual([rel]);
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
        expect(flags().map((f) => f.body.split('\n')[0])).toEqual([rel]);
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
        return flags().find((f) => f.body.split('\n')[0] === 'docs/real.md');
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
    const workstream = state.write((ctx) =>
      insertWorkstream(ctx, task.id, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
        batchId: batch.id,
      }),
    );
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

  describe('a lane holding the whole-repo area in its own copy', () => {
    const SENSITIVE = ['.env.local', '.mcp.json', '.claude/settings.json'];
    beforeEach(() => {
      state.write((ctx) =>
        patchProject(ctx, project.id, { areas: [{ name: 'repo', globs: ['**'] }] }),
      );
      project = getProject(base.db, project.id);
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
});

describe('stray writes in .git', () => {
  const HOOK = '.git/hooks/pre-commit';
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env: isolatedGitEnv(), encoding: 'utf8' });
  const writeHook = (text: string) => {
    mkdirSync(join(repo.path, '.git/hooks'), { recursive: true });
    writeFileSync(join(repo.path, HOOK), text);
    emit(HOOK);
  };
  const trust = (id: InboxItemDto['id']) => inbox.answer(id, { choice: 'Trust This Version' });

  it('trusts a hook version once, and raises a card again for any other', async () => {
    running();
    watcher.sync();
    writeHook('#!/bin/sh\necho a\n');
    await watcher.flush();
    const [card] = flags();
    expect(card?.detail?.['sha256']).toBe(stampFile(repo.path, HOOK));
    expect(openFlags()[0]?.body).toMatch(
      new RegExp(`\\nVersion ${String(stampFile(repo.path, HOOK)).slice(0, 12)}$`),
    );
    expect(card?.options.map((o) => o.label)).toEqual(['Trust This Version', 'Dismiss']);

    trust(card?.id ?? ('' as InboxItemDto['id']));
    expect(flags()).toEqual([]);
    expect(trustedWrites(base.db, project.id)).toMatchObject([{ path: HOOK }]);

    writeHook('#!/bin/sh\necho a\n');
    await watcher.flush();
    expect(flags()).toEqual([]);

    writeHook('#!/bin/sh\necho b\n');
    await watcher.flush();
    expect(flags().map((f) => f.body.split('\n')[0])).toEqual([HOOK]);
  });

  it('does not trust a hook rewritten while its card was open, and shows the new version', async () => {
    running();
    watcher.sync();
    writeHook('#!/bin/sh\necho a\n');
    await watcher.flush();
    const [card] = flags();
    // Rewritten after the card, before the watcher's next batch: the answer stamps the file itself.
    writeFileSync(join(repo.path, HOOK), '#!/bin/sh\necho b\n');
    trust(card?.id ?? ('' as InboxItemDto['id']));

    expect(trustedWrites(base.db, project.id)).toEqual([]);
    const open = flags();
    expect(open).toHaveLength(1);
    expect(open[0]?.id).not.toBe(card?.id);
    expect(open[0]?.detail?.['sha256']).toBe(stampFile(repo.path, HOOK));

    // A rewrite seen by the watcher replaces the open card with one holding the new stamp.
    writeHook('#!/bin/sh\necho c\n');
    await watcher.flush();
    expect(flags()[0]?.detail?.['sha256']).toBe(stampFile(repo.path, HOOK));
  });

  it('raises nothing for what a real worktree add and push -u write to the config', async () => {
    const origin = tempDir('origin');
    git(origin.path, 'init', '--bare', '-q');
    git(origin.path, 'config', 'receive.autogc', 'false');
    git(repo.path, 'remote', 'add', 'origin', origin.path);
    const branch = git(repo.path, 'branch', '--show-current').trim();
    running();
    watcher.sync();
    const worktrees = tempDir('worktrees');
    git(repo.path, 'worktree', 'add', '-q', join(worktrees.path, 'w'), '-b', 'feat/x');
    emit('.git/config');
    emit('.git/worktrees/w/HEAD');
    await watcher.flush();
    git(repo.path, 'push', '-q', '-u', 'origin', branch);
    emit('.git/config');
    await watcher.flush();
    expect(git(repo.path, 'config', `branch.${branch}.remote`).trim()).toBe('origin');
    expect(flags()).toEqual([]);
    worktrees.cleanup();
    origin.cleanup();
  });

  it('raises a card naming the key a real git config call changed', async () => {
    running();
    watcher.sync();
    git(repo.path, 'config', 'core.hooksPath', 'x');
    emit('.git/config');
    await watcher.flush();
    const [card] = flags();
    expect(card?.body).toContain('.git/config');
    expect(card?.body.toLowerCase()).toContain('core.hookspath');
  });

  it('names the keys of the first config change when a second write refreshes the card', async () => {
    running();
    watcher.sync();
    git(repo.path, 'config', 'core.hooksPath', 'x');
    emit('.git/config');
    await watcher.flush();
    const [first] = flags();
    git(repo.path, 'config', 'user.name', 'someone');
    emit('.git/config');
    await watcher.flush();
    const open = flags();
    expect(open).toHaveLength(1);
    expect(open[0]?.id).not.toBe(first?.id);
    expect(open[0]?.body.toLowerCase()).toContain('core.hookspath');
    expect(open[0]?.body.toLowerCase()).toContain('user.name');
  });

  it('cards a config that is a link, since it can not be read as a file', async () => {
    running();
    watcher.sync();
    const config = join(repo.path, '.git/config');
    renameSync(config, join(repo.path, '.git/config.real'));
    symlinkSync(join(repo.path, '.git/config.real'), config);
    emit('.git/config');
    await watcher.flush();
    const [card] = flags();
    expect(card?.body).toContain('Could not be read');
    expect(card?.options.map((o) => o.label) ?? []).not.toContain('Trust This Version');
  });

  it('never closes a card silently when its file became a link before the answer', async () => {
    running();
    watcher.sync();
    writeHook('#!/bin/sh\necho a\n');
    await watcher.flush();
    const [card] = flags();
    rmSync(join(repo.path, HOOK));
    symlinkSync(join(repo.path, 'README.md'), join(repo.path, HOOK));
    trust(card?.id ?? ('' as InboxItemDto['id']));
    expect(trustedWrites(base.db, project.id)).toEqual([]);
    const open = flags();
    expect(open).toHaveLength(1);
    expect(open[0]?.options.map((o) => o.label) ?? []).not.toContain('Trust This Version');
  });

  it('refuses an answer to a card whose file has since been rewritten and re-carded', async () => {
    running();
    watcher.sync();
    writeHook('#!/bin/sh\necho a\n');
    await watcher.flush();
    const [old] = flags();
    writeHook('#!/bin/sh\necho b\n');
    await watcher.flush();
    expect(() => trust(old?.id ?? ('' as InboxItemDto['id']))).toThrow(ConflictError);
    expect(trustedWrites(base.db, project.id)).toEqual([]);
  });

  it('leaves a config card open when its lane is cancelled, and still names the key afterwards', async () => {
    const lane = running();
    watcher.sync();
    git(repo.path, 'config', 'core.hooksPath', 'scripts/h');
    emit('.git/config');
    await watcher.flush();
    expect(flags()).toHaveLength(1);

    inbox.cancelForWorkstream(lane.workstream.id);
    expect(flags()).toHaveLength(1);

    git(repo.path, 'config', 'branch.main.merge', 'refs/heads/main');
    emit('.git/config');
    await watcher.flush();
    expect(flags()[0]?.body.toLowerCase()).toContain('core.hookspath');
  });

  it('cards a config key again after its card was withdrawn rather than answered', async () => {
    running();
    watcher.sync();
    git(repo.path, 'config', 'core.hooksPath', 'scripts/h');
    emit('.git/config');
    await watcher.flush();
    inbox.withdraw(flags()[0]?.id ?? ('' as InboxItemDto['id']));
    expect(flags()).toEqual([]);

    git(repo.path, 'config', 'branch.main.merge', 'refs/heads/main');
    emit('.git/config');
    await watcher.flush();
    expect(flags()[0]?.body.toLowerCase()).toContain('core.hookspath');
  });

  it('accepts a config key once its card was dismissed', async () => {
    running();
    watcher.sync();
    git(repo.path, 'config', 'core.hooksPath', 'scripts/h');
    emit('.git/config');
    await watcher.flush();
    inbox.answer(flags()[0]?.id ?? ('' as InboxItemDto['id']), { choice: 'Dismiss' });

    git(repo.path, 'config', 'branch.main.merge', 'refs/heads/main');
    emit('.git/config');
    await watcher.flush();
    expect(flags()).toEqual([]);
  });
});
