import {
  mintId,
  PASS_RETRY_TURN_CHOICE,
  PASS_SIGN_OFF_CHOICE,
  PassTurnEnding,
  PassViewDto,
  WorkstreamState as S,
  type InboxKind,
  type PassDto,
  type ProjectDto,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  acquireClaims,
  createTestStore,
  insertHold,
  insertSignOffWait,
  setClosePlan,
  setPassNotice,
  setPassPullRequest,
  upsertSharedChange,
  endPassTurn,
  insertBuilderMessage,
  insertInboxItem,
  insertPass,
  insertPassTurn,
  insertTask,
  insertWorkstream,
  leavePass,
  patchWorkstream,
  seedProject,
  settlePassTurn,
  transitionWorkstream,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { passView } from './index';

// Workbench spec §4.3, §4.5, §6.1: what the Workbench reads of a pass, from its rows.

let store: Store;
let close: () => void;
let clock = new Date('2026-11-09T12:00:00.000Z');
let project: ProjectDto;

beforeEach(() => {
  clock = new Date('2026-11-09T12:00:00.000Z');
  ({ store, close } = createTestStore(() => clock));
  project = seedProject(store, {
    delivery: 'local',
    areas: [
      { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
      { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
      { name: 'billing', globs: ['src/billing/**'], role: 'page' },
      { name: 'home', globs: ['src/home/**'], role: 'page', route: '/' },
      { name: 'shared-ui', globs: ['src/ui/**'], role: 'shared' },
    ],
  });
});
afterEach(() => {
  close();
});

const later = (minutes: number): void => {
  clock = new Date(clock.getTime() + minutes * 60_000);
};

const task = (title: string, area: string): TaskId =>
  store.write((ctx) =>
    insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: [area] }),
  ).value.id;

function openPass(taskIds: readonly TaskId[]): { pass: PassDto; runs: WorkstreamId[] } {
  return store.write((ctx) => {
    const { pass, batch } = insertPass(ctx, {
      id: mintId('Pass'),
      projectId: project.id,
      name: 'Polish',
      pageCap: 4,
      returnBranch: 'main',
      startSha: 'a'.repeat(40),
      branch: '10db/polish-abc123',
      baseBranch: 'main',
      repo: null,
      taskIds,
      dirt: [],
    });
    const runs = taskIds.map(
      (id) =>
        insertWorkstream(ctx, id, {
          batchId: batch.id,
          first: { model: 'claude-sonnet-5-5', effort: 'medium' },
        }).id,
    );
    return { pass, runs };
  }).value;
}

/** One turn from the builder's message to its end, settled; the run waits on the item it raised. */
function turn(taskId: TaskId, ws: WorkstreamId, ending: PassTurnEnding, item: InboxKind) {
  return store.write((ctx) => {
    transitionWorkstream(ctx, ws, { to: S.Starting, fence: null });
    transitionWorkstream(ctx, ws, { to: S.Running, fence: null });
    const message = insertBuilderMessage(ctx, taskId, { body: 'make it blue', files: [] });
    const started = insertPassTurn(ctx, {
      taskId,
      workstreamId: ws,
      sessionId: null,
      messageId: message.id,
    });
    endPassTurn(ctx, started.id, { ending, replyBody: 'done' });
    const settled = settlePassTurn(ctx, started.id);
    const raised = insertInboxItem(ctx, {
      projectId: project.id,
      kind: item,
      title: 'Ready',
      body: '',
      options: [
        {
          label: item === 'check' ? PASS_SIGN_OFF_CHOICE : PASS_RETRY_TURN_CHOICE,
          description: '',
        },
      ],
      recommendation: null,
      category: 'other',
      urgency: 'normal',
      detail: null,
      foldKey: null,
      targets: [{ workstreamId: ws, sessionId: null }],
    });
    transitionWorkstream(ctx, ws, { to: S.WaitingHuman, fence: null });
    patchWorkstream(ctx, ws, null, {
      nextAction: { kind: 'pass_review', inboxId: raised.id },
      ...(ending === PassTurnEnding.Failed ? { failureKind: 'session_failed' } : {}),
    });
    return { turn: settled, item: raised };
  }).value;
}

describe('the view of a pass', () => {
  it('has a page for each task in the pass, open, Ready or failed, and every turn of the pass', () => {
    const settings = task('Settings: UI work', 'settings');
    const people = task('People: UI work', 'people');
    const billing = task('Billing: UI work', 'billing');
    const home = task('Home: UI work', 'home');
    const { pass, runs } = openPass([settings, people, billing, home]);
    const [, peopleRun, billingRun, homeRun] = runs;
    if (!peopleRun || !billingRun || !homeRun) throw new Error('a run is missing');
    later(1);
    const ready = turn(people, peopleRun, PassTurnEnding.Ready, 'check');
    later(1);
    const failed = turn(billing, billingRun, PassTurnEnding.Failed, 'flag');
    later(1);
    const takenOut = turn(home, homeRun, PassTurnEnding.Ready, 'check');
    store.write((ctx) => {
      leavePass(ctx, home);
    });

    const view = PassViewDto.parse(passView(store.db, pass.id));

    expect(view.pass.id).toBe(pass.id);
    // The page taken out of the pass is not one of its pages; its turn is still one of the pass's.
    expect(view.pages.map((p) => p.taskId)).toEqual([settings, people, billing]);
    const [open, readyPage, failedPage] = view.pages;
    expect(open).toEqual({
      taskId: settings,
      title: 'Settings: UI work',
      area: 'settings',
      route: '/settings',
      workstreamId: runs[0],
      state: S.Queued,
      nextActionKind: 'start',
      spokenTo: false,
      turn: null,
      pausedUntil: null,
      failure: null,
      signOff: 'none',
      waitsFor: null,
      preview: null,
    });
    expect(readyPage).toMatchObject({
      area: 'people',
      route: '/people',
      state: S.WaitingHuman,
      nextActionKind: 'pass_review',
      spokenTo: true,
      turn: {
        id: ready.turn.id,
        seq: 1,
        startedAt: ready.turn.startedAt,
        endedAt: ready.turn.endedAt,
        readyAt: ready.turn.readyAt,
        activity: null,
      },
      failure: null,
    });
    expect(readyPage?.turn?.readyAt).not.toBeNull();
    expect(failedPage).toMatchObject({
      area: 'billing',
      route: null,
      nextActionKind: 'pass_review',
      turn: { id: failed.turn.id, readyAt: null },
      failure: { failureKind: 'session_failed', retryItemId: failed.item.id },
    });
    expect(view.turns).toEqual(
      [ready.turn, failed.turn, takenOut.turn].map((t) => ({
        taskId: t.taskId,
        seq: t.seq,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        readyAt: t.readyAt,
        openedAt: null,
        answeredAt: null,
      })),
    );
  });
});

describe("the view of a pass's close", () => {
  it('names the page a sign-off waits for, marks a signed-off page done, and reads the chain, pull request, step and notices', () => {
    const settings = task('Settings: UI work', 'settings');
    const people = task('People: UI work', 'people');
    const home = task('Home: UI work', 'home');
    const { pass, runs } = openPass([settings, people, home]);
    const [, peopleRun, homeRun] = runs;
    if (!peopleRun || !homeRun) throw new Error('a run is missing');
    const hold = store.write((ctx) => {
      const granted = acquireClaims(ctx, {
        projectId: project.id,
        workstreamId: peopleRun,
        requests: [{ kind: 'area', name: 'shared-ui' }],
        leaseExpiresAt: '2026-11-09T13:00:00.000Z',
      });
      const claim = granted.ok ? granted.claims[0] : undefined;
      if (claim === undefined) throw new Error('claim not granted');
      const made = insertHold(ctx, {
        claimId: claim.id,
        passId: pass.id,
        taskId: people,
        workstreamId: peopleRun,
        area: 'shared-ui',
        recordSha: 'b'.repeat(40),
        record: [],
      });
      upsertSharedChange(ctx, {
        passId: pass.id,
        seq: made.seq,
        sha: 'c'.repeat(40),
        files: [{ path: 'src/ui/Button.tsx', blob: 'd'.repeat(40) }],
        dirtyKept: false,
      });
      insertSignOffWait(ctx, { taskId: settings, passId: pass.id, waitsFor: claim.id });
      for (const to of [S.Starting, S.Running, S.Verifying, S.Done])
        transitionWorkstream(ctx, homeRun, { to, fence: null });
      setPassPullRequest(ctx, pass.id, { url: 'https://github.com/o/r/pull/3', draft: true });
      setPassNotice(ctx, pass.id, {
        id: 'checks',
        kind: 'checks',
        text: 'build fails',
        sendable: true,
        cardId: null,
        at: clock.toISOString(),
      });
      setClosePlan(ctx, pass.id, { token: 't', pages: [], files: [], shared: [] });
      return made;
    }).value;

    const view = PassViewDto.parse(passView(store.db, pass.id));

    expect(view.pages.map((p) => [p.taskId, p.signOff, p.waitsFor])).toEqual([
      [settings, 'waiting', { taskId: people, title: 'People: UI work' }],
      [people, 'none', null],
      [home, 'done', null],
    ]);
    expect(view.holds).toEqual([hold]);
    expect(view.sharedChanges).toMatchObject([
      { seq: hold.seq, taskId: people, paths: ['src/ui/Button.tsx'], landedSha: null },
    ]);
    expect(view.signOffWaits).toMatchObject([{ taskId: settings, waitsForTaskId: people }]);
    expect(view.pullRequest).toEqual({
      url: 'https://github.com/o/r/pull/3',
      draft: true,
      state: null,
      failingChecks: [],
    });
    expect(view.checks).toEqual({
      gate: { state: 'not_run', logPath: null },
      review: { reviewedSha: null },
    });
    expect(view.closeStep).toBe(1);
    expect(view.stackedOn).toBeNull();
    expect(view.notices.map((n) => n.text)).toEqual(['build fails']);
  });
});
