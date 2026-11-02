import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { WorkspaceMode, type BatchDto, type TaskDto } from '@10db/contracts';
import {
  getBatch,
  getTask,
  insertWorkstream,
  listBatches,
  listWorkstreams,
  patchTask,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { isolatedGitEnv } from '../../test/fixtures';
import { jobKey, JobQueue } from './index';

// Per-task placement, T2 (docs/superpowers/specs/2026-10-29-10db-task-placement-design.md, P6, P8,
// P9 and §6, §7): a project holds a shared batch and copies at once, and a copy never writes the
// main checkout.

let h: DeliveryHarness;
beforeEach(() => {
  // A project whose default is Your folder: each task's own placement decides where it runs.
  h = createDeliveryHarness({}, { trigger: false });
});
afterEach(() => {
  h.close();
});

const shared = (title: string) => h.addTask(title, { workspaceMode: WorkspaceMode.Shared });
const copy = (title: string, areas = ['api']) =>
  h.addTask(title, { workspaceMode: WorkspaceMode.Worktree, areas });

/** Starts one task alone and waits for its cut. */
async function startedOne(task: TaskDto, title = task.title): Promise<BatchDto> {
  const [batch, ...rest] = h.starter.startBatch(h.project.id, { title, taskIds: [task.id] });
  if (batch === undefined || rest.length > 0) throw new Error('expected one batch');
  await h.jobs.idle();
  return getBatch(h.store.db, batch.id);
}

/** An OPEN copy's batch whose one lane is running. */
async function copyWithRunningLane(title = 'Copied'): Promise<BatchDto> {
  const batch = await startedOne(copy(title));
  expect(batch.worktreePath).not.toBeNull();
  const ws = h.only(listWorkstreams(h.store.db, { batchId: batch.id }));
  h.settle(ws.id, 'RUNNING');
  return batch;
}

/** A lane in the project's own checkout: a workstream with no batch, as a shared lane is. */
function sharedLane(): void {
  const other = h.addTask('Running in Your folder', {
    areas: ['ui'],
    workspaceMode: WorkspaceMode.Shared,
  });
  const ws = h.state.write((c) => insertWorkstream(c, other.id));
  h.settle(ws.id, 'RUNNING');
}

const sharedBatches = () => listBatches(h.store.db).filter((b) => b.worktreePath === null);

describe('the shared cut counts only lanes in the main checkout', () => {
  it("cuts while a copy's lane runs", async () => {
    const running = await copyWithRunningLane();
    const batch = await startedOne(shared('Alpha'));
    expect(batch.state).toBe('OPEN');
    expect(h.git$('branch', '--show-current')).toBe(batch.branch);
    expect(h.cards()).toEqual([]);
    // The copy's lane is untouched.
    expect(listWorkstreams(h.store.db, { batchId: running.id }).map((w) => w.state)).toEqual([
      'RUNNING',
    ]);
  });

  it('is refused while a shared lane runs, copies or no copies', async () => {
    await copyWithRunningLane();
    sharedLane();
    const before = h.git$('rev-parse', 'HEAD');
    const alpha = shared('Alpha');
    h.starter.startBatch(h.project.id, { title: 'Alpha', taskIds: [alpha.id] });
    await h.jobs.idle();
    expect(sharedBatches()).toEqual([]);
    expect(h.only(h.cards()).title).toContain('work is still running');
    expect(h.git$('branch', '--show-current')).toBe('main');
    expect(h.git$('rev-parse', 'HEAD')).toBe(before);
  });
});

describe('the switch back counts only lanes in the main checkout', () => {
  /** An OPEN shared batch with nothing committed, so abandoning it has nothing to keep. */
  async function openShared(): Promise<BatchDto> {
    const batch = await startedOne(shared('Alpha'));
    expect(batch.state).toBe('OPEN');
    return batch;
  }

  it("switches back while a copy's lane runs", async () => {
    const batch = await openShared();
    expect(h.git$('branch', '--show-current')).toBe(batch.branch);
    await copyWithRunningLane();
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    expect(h.git$('branch', '--show-current')).toBe('main');
    expect(h.cards().filter((c) => c.title.startsWith('Your checkout'))).toEqual([]);
  });

  it('leaves the checkout, with a card, while a shared lane runs beside a copy lane', async () => {
    const batch = await openShared();
    await copyWithRunningLane();
    sharedLane();
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    expect(h.git$('branch', '--show-current')).toBe(batch.branch);
    const card = h.only(h.cards().filter((c) => c.title.startsWith('Your checkout')));
    expect(card.title).toBe(
      `Your checkout stays on ${batch.branch ?? ''}: work is running in ${h.project.name}`,
    );
  });
});

/** Every file of the main checkout (not .git) with its content hash, as the builder's editor sees it. */
function filesOfMain(dir = h.repo, base = ''): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (base === '' && name === '.git') continue;
    const path = join(dir, name);
    const rel = base === '' ? name : `${base}/${name}`;
    if (statSync(path).isDirectory()) Object.assign(files, filesOfMain(path, rel));
    else
      files[rel] = `${createHash('sha256').update(readFileSync(path)).digest('hex')} ${String(
        statSync(path).mtimeMs,
      )}`;
  }
  return files;
}

/** What the builder's tools see of the main checkout: HEAD, the index (as git and as bytes) and every file. */
function mainCheckout() {
  const gitDir = join(h.repo, '.git');
  return {
    head: readFileSync(join(gitDir, 'HEAD'), 'utf8'),
    branchRef: h.git$('rev-parse', 'HEAD'),
    index: h.git$('ls-files', '-s'),
    indexBytes: createHash('sha256')
      .update(readFileSync(join(gitDir, 'index')))
      .digest('hex'),
    files: filesOfMain(),
  };
}

/** git in a directory, as a builder's terminal would run it. */
const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();

/** A pnpm project, pushed to origin, with an ignored node_modules the builder installed. */
function withInstalledProject(): void {
  h.commit('.gitignore', 'node_modules/\n');
  h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  h.git$('push', '-q', 'origin', 'main');
  mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(h.repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
}

describe("a copy's whole life with a shared batch open beside it", () => {
  it("leaves the main checkout's HEAD, index and files as they were", async () => {
    withInstalledProject();

    // The shared batch is open, and its lane has written an uncommitted file in Your folder.
    const sharedBatch = await startedOne(shared('Alpha'));
    expect(sharedBatch.state).toBe('OPEN');
    writeFileSync(join(h.repo, 'in-progress.txt'), 'a shared lane is mid-edit\n');
    const before = mainCheckout();

    // Creation (the cut, with the project's other batch open), a lane's commit, a gate-time merge of
    // origin, the ship and the removal.
    const made = await startedOne(copy('Copied'));
    expect(made.state).toBe('OPEN');
    const path = made.worktreePath ?? '';
    expect(path).not.toBe('');
    expect(mainCheckout()).toEqual(before);

    const ws = h.only(listWorkstreams(h.store.db, { batchId: made.id }));
    const file = join(path, 'src/api/copied.txt');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'copied\n');
    await h.git.commit({
      repo: path,
      paths: ['src/api/copied.txt'],
      message: 'Add copied',
      opId: 'op-copied-commit',
      branch: made.branch ?? '',
    });
    expect(gitIn(path, 'log', '-1', '--format=%s')).toBe('Add copied');
    expect(mainCheckout()).toEqual(before);

    // origin moves on; the ship merges it into the copy's branch, not into Your folder.
    h.teammatePush('main', 'src/ui/teammate.txt');
    h.settle(ws.id, 'DONE');
    h.shipper.checkBatch(made.id);
    await h.jobs.idle();
    const shipped = getBatch(h.store.db, made.id);
    expect(shipped.state).toBe('SHIPPED');
    expect(shipped.worktreePath).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(mainCheckout()).toEqual(before);
    expect(h.git$('branch', '--show-current')).toBe(sharedBatch.branch);
  });
});

describe("a copy's creation and a shared cut started together", () => {
  it('both finish, with both branches at the right commit', async () => {
    const a = shared('Alpha');
    const b = copy('Beta');
    const answered = h.starter.startBatch(h.project.id, { title: 'Mixed', taskIds: [a.id, b.id] });
    expect(answered).toHaveLength(2);
    await h.jobs.idle();
    const now = answered.map((x) => getBatch(h.store.db, x.id));
    expect(now.map((x) => x.state)).toEqual(['OPEN', 'OPEN']);
    const base = h.git$('rev-parse', 'refs/remotes/origin/main');
    for (const batch of now) {
      expect(batch.branch).not.toBeNull();
      expect(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`)).toBe(base);
      expect(batch.baseSha).toBe(base);
    }
    const sharedOne = now.find((x) => x.worktreePath === null);
    const copied = now.find((x) => x.worktreePath !== null);
    expect(h.git$('branch', '--show-current')).toBe(sharedOne?.branch);
    expect(gitIn(copied?.worktreePath ?? '', 'branch', '--show-current')).toBe(copied?.branch);
  });
});

describe('seeding a new copy', () => {
  const cloned = (batch: BatchDto) =>
    existsSync(join(batch.worktreePath ?? '', 'node_modules/pkg/index.js'));
  /** The installs that ran in the copy itself. */
  const installsIn = (batch: BatchDto) =>
    h.pnpm.calls().filter((call) => call.startsWith(`${realpathSync(batch.worktreePath ?? '')} |`));

  /** Holds the project's shared queue, so a shared cut started now stays pending until released. */
  function holdSharedQueue(): () => void {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.jobs.run(h.project.id, () => gate);
    return release;
  }

  it('clones the main checkout node_modules when no shared batch is unfinished', async () => {
    withInstalledProject();
    const batch = await startedOne(copy('Copied'));
    expect(batch.state).toBe('OPEN');
    expect(cloned(batch)).toBe(true);
    expect(readFileSync(join(batch.worktreePath ?? '', 'node_modules/pkg/index.js'), 'utf8')).toBe(
      'module.exports = 1;\n',
    );
    expect(installsIn(batch)).toHaveLength(1);
  });

  it('skips the clone and installs when a shared batch is OPEN', async () => {
    withInstalledProject();
    await startedOne(shared('Alpha'));
    const batch = await startedOne(copy('Copied'));
    expect(batch.state).toBe('OPEN');
    expect(cloned(batch)).toBe(false);
    expect(installsIn(batch)).toHaveLength(1);
    // The install made what the clone would have, so there is nothing to tell.
    expect(batch.notices).toEqual([]);
  });

  describe('install scripts the copy did not run', () => {
    /** What an install of `name` leaves in a pnpm virtual store, with `scripts` in its package.json. */
    const installed = (name: string, version: string, scripts: object): Record<string, string> => ({
      [`node_modules/.pnpm/${name.replace('/', '+')}@${version}/node_modules/${name}/package.json`]:
        JSON.stringify({ name, version, scripts }),
    });
    function allowing(workspace: string): void {
      h.commit('.gitignore', 'node_modules/\n');
      h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
      h.commit('pnpm-workspace.yaml', workspace);
      h.git$('push', '-q', 'origin', 'main');
      mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(h.repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    }

    it('names an allowed package whose install script was skipped', async () => {
      allowing('allowBuilds:\n  prisma: true\n  "@scope/native": true\n  sharp: false\n');
      h.pnpm.makes({
        ...installed('prisma', '6.0.0', { postinstall: 'node build.js' }),
        ...installed('@scope/native', '1.2.0', { install: 'node-gyp rebuild' }),
        ...installed('sharp', '0.30.0', { install: 'node install.js' }),
        ...installed('left-pad', '1.0.0', { postinstall: 'node x.js' }),
      });
      await startedOne(shared('Alpha'));
      const batch = await startedOne(copy('Copied'));
      expect(batch.state).toBe('OPEN');
      const notice = h.only(batch.notices);
      expect(notice).toMatchObject({ key: 'install-scripts-skipped', tone: 'warning' });
      expect(notice.line).toContain('prisma');
      expect(notice.line).toContain('@scope/native');
      expect(notice.line).not.toContain('sharp');
      expect(notice.line).not.toContain('left-pad');
      expect(notice.body).toContain('pnpm rebuild');
    });

    it('says nothing when an allowed package has no install script', async () => {
      allowing('allowBuilds:\n  prisma: true\n');
      h.pnpm.makes(installed('prisma', '6.0.0', { test: 'vitest' }));
      await startedOne(shared('Alpha'));
      const batch = await startedOne(copy('Copied'));
      expect(batch.notices).toEqual([]);
    });

    it('says nothing when the clone carried the built output', async () => {
      allowing('allowBuilds:\n  prisma: true\n');
      h.pnpm.makes(installed('prisma', '6.0.0', { postinstall: 'node build.js' }));
      const batch = await startedOne(copy('Copied'));
      expect(batch.notices).toEqual([]);
    });

    it('reads the older onlyBuiltDependencies list too', async () => {
      allowing('onlyBuiltDependencies:\n  - puppeteer\n');
      h.pnpm.makes(installed('puppeteer', '22.0.0', { postinstall: 'node install.js' }));
      await startedOne(shared('Alpha'));
      const batch = await startedOne(copy('Copied'));
      expect(h.only(batch.notices).line).toContain('puppeteer');
    });

    it('names every package with an install script when all builds are allowed', async () => {
      allowing('dangerouslyAllowAllBuilds: true\nignoredBuiltDependencies:\n  - sharp\n');
      h.pnpm.makes({
        ...installed('prisma', '6.0.0', { postinstall: 'node build.js' }),
        ...installed('@scope/native', '1.2.0', { install: 'node-gyp rebuild' }),
        ...installed('sharp', '0.30.0', { install: 'node install.js' }),
        ...installed('left-pad', '1.0.0', { test: 'x' }),
      });
      await startedOne(shared('Alpha'));
      const batch = await startedOne(copy('Copied'));
      const notice = h.only(batch.notices);
      expect(notice.key).toBe('install-scripts-skipped');
      expect(notice.line).toContain('prisma');
      expect(notice.line).toContain('@scope/native');
      expect(notice.line).not.toContain('sharp');
      expect(notice.line).not.toContain('left-pad');
    });

    describe('under pnpm 9 and earlier, which builds every package unless told not to', () => {
      /** What pnpm writes about itself in the node_modules it makes. */
      const madeBy = (version: string): Record<string, string> => ({
        'node_modules/.modules.yaml': `layoutVersion: 5\npackageManager: pnpm@${version}\nprefix: /x\n`,
      });
      const natives = {
        ...installed('prisma', '6.0.0', { postinstall: 'node build.js' }),
        ...installed('sharp', '0.30.0', { install: 'node install.js' }),
        ...installed('left-pad', '1.0.0', { test: 'x' }),
      };

      it('names every package with an install script when the project has no list', async () => {
        allowing('packages: []\n');
        h.pnpm.makes({ ...madeBy('9.15.0'), ...natives });
        await startedOne(shared('Alpha'));
        const batch = await startedOne(copy('Copied'));
        expect(batch.state).toBe('OPEN');
        const notice = h.only(batch.notices);
        expect(notice).toMatchObject({ key: 'install-scripts-skipped', tone: 'warning' });
        expect(notice.line).toContain('prisma');
        expect(notice.line).toContain('sharp');
        expect(notice.line).not.toContain('left-pad');
        expect(notice.body).toContain('pnpm rebuild');
        expect(notice.body).toContain('pnpm 9');
      });

      it('leaves out the packages neverBuiltDependencies names', async () => {
        h.commit(
          'package.json',
          JSON.stringify({ name: 'app', pnpm: { neverBuiltDependencies: ['sharp'] } }),
        );
        allowing('packages: []\n');
        h.pnpm.makes({ ...madeBy('8.6.0'), ...natives });
        await startedOne(shared('Alpha'));
        const batch = await startedOne(copy('Copied'));
        const notice = h.only(batch.notices);
        expect(notice.line).toContain('prisma');
        expect(notice.line).not.toContain('sharp');
      });

      it('names only the onlyBuiltDependencies list when the project has one', async () => {
        allowing('onlyBuiltDependencies:\n  - prisma\n');
        h.pnpm.makes({ ...madeBy('9.15.0'), ...natives });
        await startedOne(shared('Alpha'));
        const batch = await startedOne(copy('Copied'));
        const notice = h.only(batch.notices);
        expect(notice.line).toContain('prisma');
        expect(notice.line).not.toContain('sharp');
      });

      it('says nothing when the onlyBuiltDependencies list is empty: nothing builds', async () => {
        allowing('onlyBuiltDependencies: []\n');
        h.pnpm.makes({ ...madeBy('9.15.0'), ...natives });
        await startedOne(shared('Alpha'));
        const batch = await startedOne(copy('Copied'));
        expect(batch.notices).toEqual([]);
      });

      it('says nothing when the empty list is in package.json', async () => {
        h.commit(
          'package.json',
          JSON.stringify({ name: 'app', pnpm: { onlyBuiltDependencies: [] } }),
        );
        allowing('packages: []\n');
        h.pnpm.makes({ ...madeBy('9.15.0'), ...natives });
        await startedOne(shared('Alpha'));
        const batch = await startedOne(copy('Copied'));
        expect(batch.notices).toEqual([]);
      });

      it('says nothing when the list holds only names that are not packages', async () => {
        allowing('onlyBuiltDependencies:\n  - "../evil"\n  - "Bad Name"\n');
        h.pnpm.makes({ ...madeBy('9.15.0'), ...natives });
        await startedOne(shared('Alpha'));
        const batch = await startedOne(copy('Copied'));
        expect(batch.notices).toEqual([]);
      });

      it('says nothing when the list file is absent: nothing builds', async () => {
        allowing('onlyBuiltDependenciesFile: allowed.json\n');
        h.pnpm.makes({ ...madeBy('9.15.0'), ...natives });
        await startedOne(shared('Alpha'));
        const batch = await startedOne(copy('Copied'));
        expect(batch.notices).toEqual([]);
      });

      it('names the script-bearing packages the list file names', async () => {
        allowing('onlyBuiltDependenciesFile: allowed.json\n');
        h.commit('allowed.json', JSON.stringify(['prisma', 'left-pad']));
        h.git$('push', '-q', 'origin', 'main');
        h.pnpm.makes({ ...madeBy('9.15.0'), ...natives });
        await startedOne(shared('Alpha'));
        const batch = await startedOne(copy('Copied'));
        const notice = h.only(batch.notices);
        expect(notice).toMatchObject({ key: 'install-scripts-skipped', tone: 'warning' });
        expect(notice.line).toContain('prisma');
        expect(notice.line).not.toContain('sharp');
        expect(notice.line).not.toContain('left-pad');
      });

      it('does not apply ignoredBuiltDependencies, which pnpm 9 does not read', async () => {
        allowing('ignoredBuiltDependencies:\n  - sharp\n');
        h.pnpm.makes({ ...madeBy('9.15.0'), ...natives });
        await startedOne(shared('Alpha'));
        const batch = await startedOne(copy('Copied'));
        const notice = h.only(batch.notices);
        expect(notice.line).toContain('prisma');
        expect(notice.line).toContain('sharp');
      });

      it('ignores allowBuilds, which pnpm 9 does not read', async () => {
        allowing('allowBuilds:\n  prisma: true\n');
        h.pnpm.makes({ ...madeBy('9.15.0'), ...natives });
        await startedOne(shared('Alpha'));
        const batch = await startedOne(copy('Copied'));
        const notice = h.only(batch.notices);
        expect(notice.line).toContain('prisma');
        expect(notice.line).toContain('sharp');
      });

      it('says nothing under pnpm 10 with no list: nothing builds there by default', async () => {
        allowing('packages: []\n');
        h.pnpm.makes({ ...madeBy('10.4.0'), ...natives });
        await startedOne(shared('Alpha'));
        const batch = await startedOne(copy('Copied'));
        expect(batch.notices).toEqual([]);
      });

      it('says nothing when the install left no version to read', async () => {
        allowing('packages: []\n');
        h.pnpm.makes(natives);
        await startedOne(shared('Alpha'));
        const batch = await startedOne(copy('Copied'));
        expect(batch.notices).toEqual([]);
      });

      it('says nothing when the clone carried the built output', async () => {
        allowing('packages: []\n');
        h.pnpm.makes({ ...madeBy('9.15.0'), ...natives });
        const batch = await startedOne(copy('Copied'));
        expect(batch.notices).toEqual([]);
      });
    });

    it('reads dangerouslyAllowAllBuilds from package.json too, and caps a long list', async () => {
      h.commit(
        'package.json',
        JSON.stringify({ name: 'app', pnpm: { dangerouslyAllowAllBuilds: true } }),
      );
      allowing('packages: []\n');
      const many: Record<string, string> = {};
      for (let i = 0; i < 15; i++)
        Object.assign(
          many,
          installed(`pkg${String(i).padStart(2, '0')}`, '1.0.0', { postinstall: 'x' }),
        );
      h.pnpm.makes(many);
      await startedOne(shared('Alpha'));
      const batch = await startedOne(copy('Copied'));
      const notice = h.only(batch.notices);
      expect(notice.line).toContain('pkg00');
      expect(notice.line).not.toContain('pkg14');
      expect(notice.line).toContain('5 more');
    });
  });

  it('tells the batch when 10db cannot install what the clone would have brought', async () => {
    // npm's lockfile: 10db installs only pnpm projects, so the copy gets no node_modules.
    h.commit('.gitignore', 'node_modules/\n');
    h.commit('package-lock.json', '{}\n');
    h.git$('push', '-q', 'origin', 'main');
    mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(h.repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    await startedOne(shared('Alpha'));
    const batch = await startedOne(copy('Copied'));
    expect(batch.state).toBe('OPEN');
    expect(cloned(batch)).toBe(false);
    expect(installsIn(batch)).toEqual([]);
    const notice = h.only(batch.notices);
    expect(notice).toMatchObject({ key: 'seed-skipped', tone: 'warning' });
    expect(notice.line).toContain('node_modules');
    expect(notice.body).toContain('Your folder');
  });

  it('names a seed directory the install does not make, in a pnpm project', async () => {
    h.close();
    h = createDeliveryHarness({ worktreeSeed: ['node_modules', '.venv'] }, { trigger: false });
    h.commit('.gitignore', 'node_modules/\n.venv/\n');
    h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    h.git$('push', '-q', 'origin', 'main');
    mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(h.repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    mkdirSync(join(h.repo, '.venv', 'bin'), { recursive: true });
    writeFileSync(join(h.repo, '.venv', 'bin', 'python'), '#!/bin/sh\n');
    await startedOne(shared('Alpha'));
    const batch = await startedOne(copy('Copied'));
    expect(batch.state).toBe('OPEN');
    expect(existsSync(join(batch.worktreePath ?? '', '.venv'))).toBe(false);
    expect(installsIn(batch)).toHaveLength(1);
    const notice = h.only(batch.notices);
    expect(notice.key).toBe('seed-skipped');
    expect(notice.line).toContain('.venv');
    expect(notice.line).not.toContain('node_modules');
  });

  it('skips the clone and installs when a shared batch is still CUTTING', async () => {
    withInstalledProject();
    const release = holdSharedQueue();
    h.starter.startBatch(h.project.id, { title: 'Alpha', taskIds: [shared('Alpha').id] });
    expect(sharedBatches().map((b) => b.state)).toEqual(['CUTTING']);
    const [started] = h.starter.startBatch(h.project.id, {
      title: 'Copied',
      taskIds: [copy('Copied').id],
    });
    if (started === undefined) throw new Error('expected a batch');
    // The copy's own queue drains while the shared queue is held, so its cut has finished.
    await new Promise<void>((resolve) => {
      h.jobs.run(jobKey(started, JobQueue.Cut), () => {
        resolve();
        return Promise.resolve();
      });
    });
    const batch = getBatch(h.store.db, started.id);
    release();
    await h.jobs.idle();
    expect(batch.state).toBe('OPEN');
    expect(cloned(batch)).toBe(false);
    expect(installsIn(batch)).toHaveLength(1);
  });

  it('does not clone after a shared lane ran, even once its batch has ended', async () => {
    withInstalledProject();
    const sharedBatch = await startedOne(shared('Alpha'));
    const lane = h.only(listWorkstreams(h.store.db, { batchId: sharedBatch.id }));
    h.settle(lane.id, 'DONE');
    // The lane's write to a dependency in Your folder is still there after its batch is gone.
    writeFileSync(join(h.repo, 'node_modules/pkg/index.js'), 'module.exports = "lane";\n');
    h.shipper.abandon(sharedBatch.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, sharedBatch.id).state).toBe('ABANDONED');
    const batch = await startedOne(copy('Copied'));
    expect(batch.state).toBe('OPEN');
    expect(cloned(batch)).toBe(false);
    expect(installsIn(batch)).toHaveLength(1);
  });

  it('does not clone after a shared lane ran, even once its task has moved to a copy', async () => {
    withInstalledProject();
    const alpha = shared('Alpha');
    const sharedBatch = await startedOne(alpha);
    const lane = h.only(listWorkstreams(h.store.db, { batchId: sharedBatch.id }));
    h.settle(lane.id, 'FAILED');
    writeFileSync(join(h.repo, 'node_modules/pkg/index.js'), 'module.exports = "lane";\n');
    // Its run has ended and the task is still open, so the builder may send it to a copy.
    h.state.write((c) => patchTask(c, alpha.id, { workspaceMode: WorkspaceMode.Worktree }));
    expect(getTask(h.store.db, alpha.id).workspaceMode).toBe(WorkspaceMode.Worktree);
    h.shipper.abandon(sharedBatch.id);
    await h.jobs.idle();
    const batch = await startedOne(copy('Copied'));
    expect(batch.state).toBe('OPEN');
    expect(cloned(batch)).toBe(false);
    expect(installsIn(batch)).toHaveLength(1);
  });

  it('clones again once the shared batch has ended', async () => {
    withInstalledProject();
    const sharedBatch = await startedOne(shared('Alpha'));
    h.shipper.abandon(sharedBatch.id);
    await h.jobs.idle();
    const batch = await startedOne(copy('Copied'));
    expect(cloned(batch)).toBe(true);
  });
});
