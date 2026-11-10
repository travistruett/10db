import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InboxState, type ProjectInput, type TaskDto } from '@10db/contracts';
import {
  acquireClaims,
  claimRequestsForTask,
  endPassTurn,
  getPassTurn,
  getProject,
  getTask,
  insertPassTurn,
  listInbox,
  releaseClaims,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { openPass, type PassOpened, type PutBackKeptWork } from '../delivery';
import { PassFolderOffBranchError } from '../git';
import { silentLogger } from '../log';
import { keepTurnWork, keptWorkFacts, passFolderOn, passKeptRef, type PassWorkDeps } from './index';

// Workbench spec §9.1: at a turn's end the daemon keeps the task's page files at the task's ref,
// on the pass branch's tip, and the turn row names it.

const PROJECT: Partial<ProjectInput> = {
  areas: [
    { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
    { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
    { name: 'src', globs: ['src/**'], role: 'shared' },
  ],
  hazards: [{ name: 'deps', globs: ['pnpm-lock.yaml'], commands: ['pnpm install'] }],
};

const nothingKept: PutBackKeptWork = () => Promise.resolve({ applied: [], left: [] });

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

function deps(): PassWorkDeps {
  return {
    state: h.state,
    git: h.git,
    inbox: h.inbox,
    jobs: h.jobs,
    logger: silentLogger,
    clock: h.ctx.clock,
  };
}

function write(path: string, content: string): void {
  const file = join(h.repo, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

interface Opened {
  readonly opened: PassOpened;
  readonly settings: TaskDto;
  readonly people: TaskDto;
}

/** A pass on two pages, Settings (which also names the `deps` hazard) and People. */
async function openTwoPages(before?: () => void): Promise<Opened> {
  h = createDeliveryHarness(PROJECT);
  h.commit('src/settings/page.tsx', 'settings\n');
  h.commit('src/settings/old.tsx', 'old\n');
  h.commit('src/people/page.tsx', 'people\n');
  h.commit('src/shared.ts', 'shared\n');
  h.commit('pnpm-lock.yaml', 'lock: 1\n');
  before?.();
  const settings = h.addTask('Settings: UI work', { areas: ['settings', 'src', 'deps'] });
  const people = h.addTask('People: UI work', { areas: ['people'] });
  const opened = await openPass(
    h.ctx,
    { projectId: h.project.id, name: 'Polish', taskIds: [settings.id, people.id] },
    { leaseMs: 60_000, putBack: nothingKept },
  );
  return { opened, settings: getTask(h.store.db, settings.id), people };
}

const runOf = (task: TaskDto) => {
  const id = getTask(h.store.db, task.id).workstreamId;
  if (id === null) throw new Error(`${task.title} has no run`);
  return id;
};

function startTurn(task: TaskDto) {
  return h.state.write((c) =>
    insertPassTurn(c, {
      taskId: task.id,
      workstreamId: runOf(task),
      sessionId: null,
      messageId: null,
    }),
  );
}

const paths = (files: readonly { path: string }[]) => files.map((f) => f.path);

describe('keepTurnWork', () => {
  it("keeps the task's page files on the tip and names them on the turn; a turn that changed nothing keeps no commit", async () => {
    const { opened, settings } = await openTwoPages();
    const tip = opened.pass.startSha;
    const ref = passKeptRef(opened.pass.id, settings.id);
    const first = startTurn(settings);
    write('src/settings/page.tsx', 'settings\nedited\n');
    write('src/settings/new.tsx', 'new\n');
    unlinkSync(join(h.repo, 'src/settings/old.tsx'));
    write('src/people/page.tsx', "a neighbour's edit\n");
    write('src/shared.ts', 'a shared edit\n');

    const kept = await keepTurnWork(deps(), { workstreamId: runOf(settings), turnId: first.id });

    expect(kept).toMatchObject({ keptBaseSha: tip, made: true, fromBeforePass: [] });
    expect(kept.keptSha).toBe(h.git$('rev-parse', ref));
    expect(kept.turnFiles).toEqual([
      { path: 'src/settings/new.tsx', added: 1, removed: 0 },
      { path: 'src/settings/old.tsx', added: 0, removed: 1 },
      { path: 'src/settings/page.tsx', added: 1, removed: 0 },
    ]);
    expect(kept.pageFiles).toEqual(kept.turnFiles);
    // The neighbour's page and the shared file are not this task's work; the branch did not move.
    expect(h.git$('diff', '--name-only', tip, ref).split('\n')).toEqual(paths(kept.pageFiles));
    expect(h.git$('rev-parse', 'HEAD')).toBe(tip);
    expect(getPassTurn(h.store.db, first.id)).toMatchObject({
      keptSha: kept.keptSha,
      keptBaseSha: tip,
      sharedSeq: null,
    });

    h.state.write((c) => endPassTurn(c, first.id, { ending: 'ready', replyBody: null }));
    const second = startTurn(settings);
    const again = await keepTurnWork(deps(), {
      workstreamId: runOf(settings),
      turnId: second.id,
    });
    expect(again).toMatchObject({ keptSha: kept.keptSha, made: false, turnFiles: [] });
    expect(again.pageFiles).toEqual(kept.pageFiles);
    expect(h.git$('rev-parse', ref)).toBe(kept.keptSha);
    expect(getPassTurn(h.store.db, second.id)).toMatchObject({
      keptSha: kept.keptSha,
      keptBaseSha: tip,
    });
  });

  it('keeps a file under a hazard the task holds, and its pages once its claims are gone', async () => {
    const { settings } = await openTwoPages();
    const workstreamId = runOf(settings);
    // The scheduler claims the task's hazards when it launches.
    h.state.write((c) =>
      acquireClaims(c, {
        projectId: h.project.id,
        workstreamId,
        requests: claimRequestsForTask(settings, getProject(c.tx, h.project.id)),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    write('pnpm-lock.yaml', 'lock: 2\n');
    write('src/settings/page.tsx', 'edited\n');
    const kept = await keepTurnWork(deps(), { workstreamId, turnId: null });
    expect(paths(kept.pageFiles)).toEqual(['pnpm-lock.yaml', 'src/settings/page.tsx']);

    // A crash path released the claims: what the pass holds for the task still names its files.
    h.state.write((c) => releaseClaims(c, workstreamId));
    write('src/settings/page.tsx', 'edited again\n');
    const after = await keepTurnWork(deps(), { workstreamId, turnId: null });
    expect(after.made).toBe(true);
    expect(after.turnFiles).toEqual([{ path: 'src/settings/page.tsx', added: 1, removed: 1 }]);
    expect(paths(after.pageFiles)).toEqual(['pnpm-lock.yaml', 'src/settings/page.tsx']);
  });

  it('marks a page file still as it was before the pass', async () => {
    const { settings } = await openTwoPages(() => {
      write('src/settings/page.tsx', 'edited before the pass\n');
      write('src/settings/draft.tsx', 'a draft\n');
    });
    write('src/settings/draft.tsx', 'a draft, worked on\n');
    const kept = await keepTurnWork(deps(), { workstreamId: runOf(settings), turnId: null });
    expect(paths(kept.pageFiles)).toEqual(['src/settings/draft.tsx', 'src/settings/page.tsx']);
    expect(kept.fromBeforePass).toEqual(['src/settings/page.tsx']);
  });

  it('is refused while the folder is off the pass branch, and keeps nothing', async () => {
    const { opened, settings } = await openTwoPages();
    h.git$('switch', '-q', 'main');
    write('src/settings/page.tsx', 'edited on main\n');
    await expect(
      keepTurnWork(deps(), { workstreamId: runOf(settings), turnId: null }),
    ).rejects.toThrow(PassFolderOffBranchError);
    expect(h.git$('for-each-ref', `refs/10db/passes/${opened.pass.id}/${settings.id}`)).toBe('');
  });
});

describe('keptWorkFacts', () => {
  it("reads the latest turn's facts back without writing", async () => {
    const { settings } = await openTwoPages();
    const turn = startTurn(settings);
    write('src/settings/page.tsx', 'settings\nedited\n');
    const kept = await keepTurnWork(deps(), { workstreamId: runOf(settings), turnId: turn.id });
    const refs = h.git$('for-each-ref', 'refs/10db/');

    expect(await keptWorkFacts(deps(), settings.id)).toEqual(kept);
    expect(h.git$('for-each-ref', 'refs/10db/')).toBe(refs);
  });
});

describe('passFolderOn', () => {
  it('raises one card while the folder is off the pass branch, and withdraws it once it is back', async () => {
    const { opened } = await openTwoPages();
    const branch = h.git$('symbolic-ref', '--short', 'HEAD');
    const cards = () =>
      listInbox(h.store.db, { states: [InboxState.Open] }).filter(
        (item) => item.detail?.['passId'] === opened.pass.id,
      );
    expect(await passFolderOn(deps(), opened.pass.id)).toBe(true);
    expect(cards()).toEqual([]);

    h.git$('switch', '-q', 'main');
    expect(await passFolderOn(deps(), opened.pass.id)).toBe(false);
    expect(await passFolderOn(deps(), opened.pass.id)).toBe(false);
    const [card] = cards();
    expect(cards()).toHaveLength(1);
    expect(card?.body).toContain(branch);
    expect(card?.body).toContain('main');

    h.git$('switch', '-q', branch);
    expect(await passFolderOn(deps(), opened.pass.id)).toBe(true);
    expect(cards()).toEqual([]);
  });
});
