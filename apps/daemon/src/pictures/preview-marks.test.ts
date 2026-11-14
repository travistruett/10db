import {
  EventType,
  InboxState,
  PASS_MOVE_TO_COPY_CHOICE,
  PassMoveToCopyDetail,
  PassNoticeKind,
  type PassTurnDto,
  type ProjectInput,
  type TaskDto,
} from '@10db/contracts';
import {
  getPassProgress,
  getWorkstream,
  listEventsAfter,
  listInbox,
  listPassTurns,
  listTaskThread,
  patchProject,
  setPassTurnKept,
  settlePassTurn,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, waitFor, type TempDir } from '../../test/fixtures';
import { captureLogs, type LogCapture } from '../../test/log-capture';
import { FakeCamera } from '../../test/fake-camera';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import { grantSharedHold, passView } from '../pass';
import { createGateRunner } from '../verify';
import type { ShotOutcome } from './camera';
import { startPictures, type Pictures } from './index';
import { routeLoad } from './preview-marks';

// Workbench spec §8.2, §8.4, plan P3 (S3's shape): a page's turn that loads its route broken after a
// clean load marks that page, offered to its agent and never sent; two turns running offer a separate
// copy where copies are allowed; a clean turn mends it. Real pass, folder and database; a fake camera
// stands in for the browser, a child process 10db does not own.

const APP = 'http://localhost:8800';

let w: PassWorld;
let dir: TempDir;
let cam: FakeCamera;
let logs: LogCapture;
let pictures: Pictures | null = null;
let clock: ManualClock;
let sha = 0;
/** The projects whose preview a load that found nothing answering asked to start. */
const asked: string[] = [];

afterEach(async () => {
  await pictures?.stop();
  pictures = null;
  w.close();
  dir.cleanup();
});

/** A pass on Settings and People, its befores taken with `befores` as the camera answers them. */
async function world(
  befores: (ShotOutcome | 'camera_failed')[] = [],
  project: Partial<ProjectInput> = {},
  previewCommand: string | null = null,
): Promise<void> {
  dir = tempDir('preview');
  w = await openPassWorld({ project });
  w.h.state.write((ctx) => patchProject(ctx, w.h.project.id, { appUrl: APP, previewCommand }));
  asked.length = 0;
  cam = new FakeCamera();
  cam.outcomes = [...befores];
  clock = new ManualClock(new Date('2026-11-10T12:00:00.000Z'));
  logs = captureLogs();
  pictures = startPictures({
    devUi: null,
    state: w.h.state,
    bus: w.h.bus,
    camera: cam,
    daemonPort: Promise.resolve(4317),
    prepareBrowser: () => undefined,
    git: w.h.git,
    signIn: {
      gate: createGateRunner({ sandbox: null, logger: silentLogger }),
      dataDir: dir.path,
      now: () => clock.now().getTime(),
      sessionEnv: () => ({ PATH: '/usr/bin:/bin' }),
      rules: () => [],
      checkouts: () => [w.h.repo],
    },
    dataDir: dir.path,
    clock,
    logger: logs.logger,
    onNoAnswer: (projectId) => {
      asked.push(projectId);
    },
  });
  await ended(2);
}

const ended = (n: number) =>
  waitFor(() => logs.lines().filter((l) => l['msg'] === 'a capture ended').length >= n);
let captures = 2;

/**
 * A Ready turn of the page that kept a new commit, its picture loading as `outcome`; with `changed`
 * false, it keeps the commit its last turn kept, so it changed nothing.
 */
async function turnLoads(
  task: TaskDto,
  outcome: ShotOutcome | 'camera_failed',
  changed = true,
): Promise<PassTurnDto> {
  cam.outcomes = [outcome];
  const turn = w.startTurn(task);
  w.endTurn(turn);
  if (changed) sha += 1;
  const settled = w.h.state.write((ctx) => {
    setPassTurnKept(ctx, turn.id, {
      keptSha: sha.toString(16).padStart(40, '0'),
      keptBaseSha: 'b'.repeat(40),
      sharedSeq: null,
    });
    return settlePassTurn(ctx, turn.id);
  });
  captures += 1;
  await ended(captures);
  return settled;
}

const page = (task: TaskDto) => {
  const found = passView(w.h.store.db, w.opened.pass.id).pages.find((p) => p.taskId === task.id);
  if (found === undefined) throw new Error(`${task.title} is not a page`);
  return found;
};
const previewNotices = (task: TaskDto) =>
  listTaskThread(w.h.store.db, task.id).filter((m) => m.body.startsWith('The preview of `'));
const headerNotice = () =>
  getPassProgress(w.h.store.db, w.opened.pass.id).notices.filter(
    (n) => n.kind === PassNoticeKind.Preview,
  );
const moveCards = () =>
  listInbox(w.h.store.db, { states: [InboxState.Open] }).filter(
    (item) => PassMoveToCopyDetail.safeParse(item.detail).success,
  );
const eventsOf = (type: EventType) =>
  listEventsAfter(w.h.store.db, 0, 10_000).filter((e) => e.type === type);

describe('a page that breaks the preview', () => {
  it('is marked and offered, a neighbour is not blamed, two turns offer a copy, and a clean turn mends it', async () => {
    captures = 2;
    await world();
    const attempts = () =>
      [w.settings, w.people].map((t) => getWorkstream(w.h.store.db, w.runOf(t)).attempt);
    const before = attempts();
    cam.overlayText = 'Failed to compile: ./src/shared.ts';

    const first = await turnLoads(w.settings, 'overlay');
    expect(page(w.settings).preview).toMatchObject({
      route: '/settings',
      overlay: 'Failed to compile: ./src/shared.ts',
      turns: 1,
    });
    expect(passView(w.h.store.db, w.opened.pass.id).preview).toBe('broken');
    const [notice, ...more] = previewNotices(w.settings);
    expect(more).toEqual([]);
    expect(notice?.body).toContain(`broke after turn ${String(first.seq)}`);
    expect(notice?.body).toContain('Failed to compile');
    expect(notice?.sendable).toBe(true);
    expect(eventsOf(EventType.PassPreviewBroken).map((e) => e.data)).toEqual([
      { passId: w.opened.pass.id, taskId: w.settings.id, route: '/settings' },
    ]);
    // Offered, never sent: no turn starts and no run's attempt moves.
    expect(listPassTurns(w.h.store.db, w.opened.pass.id).filter((t) => t.endedAt === null)).toEqual(
      [],
    );
    expect(attempts()).toEqual(before);

    // People breaks it too while Settings' mark is open: Settings is named, People is not.
    await turnLoads(w.people, 'overlay');
    expect(page(w.people).preview).toBeNull();
    expect(previewNotices(w.people)).toEqual([]);
    expect(headerNotice()).toEqual([]);

    // Settings' second broken turn running offers the move, once.
    expect(moveCards()).toEqual([]);
    await turnLoads(w.settings, 'failed');
    expect(page(w.settings).preview?.turns).toBe(2);
    const [card, ...others] = moveCards();
    expect(others).toEqual([]);
    expect(card?.options.map((o) => o.label)).toContain(PASS_MOVE_TO_COPY_CHOICE);
    expect(PassMoveToCopyDetail.parse(card?.detail)).toMatchObject({
      taskId: w.settings.id,
      hazard: null,
      route: '/settings',
    });
    expect(card?.body).toContain('broke the preview');
    await turnLoads(w.settings, 'overlay');
    expect(moveCards()).toHaveLength(1);
    expect(attempts()).toEqual(before);

    // A clean turn mends it; the preview is clean again, the stale offer taken back.
    clock.advance(7 * 60_000);
    await turnLoads(w.settings, 'clean');
    expect(page(w.settings).preview).toBeNull();
    expect(passView(w.h.store.db, w.opened.pass.id).preview).toBe('clean');
    expect(eventsOf(EventType.PassPreviewMended).map((e) => e.data)).toEqual([
      { passId: w.opened.pass.id, taskId: w.settings.id },
    ]);
    expect(previewNotices(w.settings).every((m) => !m.sendable)).toBe(true);
    // The mended page is offered a separate copy no more.
    expect(moveCards()).toEqual([]);
    expect(logs.lines().find((l) => l['msg'] === 'the preview mended')).toMatchObject({
      taskId: w.settings.id,
      route: '/settings',
    });
  });

  it('mends the mark on a clean turn that changed nothing, as when the break was fixed elsewhere', async () => {
    captures = 2;
    await world();
    await turnLoads(w.settings, 'overlay');
    expect(page(w.settings).preview).not.toBeNull();
    await turnLoads(w.settings, 'clean', false);
    expect(page(w.settings).preview).toBeNull();
    expect(passView(w.h.store.db, w.opened.pass.id).preview).toBe('clean');
  });

  it('opens no mark when the browser, not the app, failed the load', async () => {
    captures = 2;
    await world();
    await turnLoads(w.settings, 'camera_failed');
    expect(page(w.settings).preview).toBeNull();
    expect(passView(w.h.store.db, w.opened.pass.id).preview).toBe('clean');
    expect(previewNotices(w.settings)).toEqual([]);
  });

  it('offers no copy on a project with no separate copies; the page stays marked', async () => {
    captures = 2;
    await world([], { delivery: 'local' });
    await turnLoads(w.settings, 'overlay');
    await turnLoads(w.settings, 'overlay');
    expect(page(w.settings).preview?.turns).toBe(2);
    expect(moveCards()).toEqual([]);
  });

  it('ignores a load while another page holds a shared area', async () => {
    captures = 2;
    await world();
    w.startTurn(w.settings);
    await grantSharedHold(w.deps, { workstreamId: w.runOf(w.settings), area: 'src' });
    await turnLoads(w.people, 'overlay');
    expect(page(w.people).preview).toBeNull();
    expect(passView(w.h.store.db, w.opened.pass.id).preview).toBe('clean');
  });

  it('names no turn for a preview that was broken before, says so once, and clears it on a clean load', async () => {
    captures = 2;
    await world(['overlay', 'overlay']);
    expect(passView(w.h.store.db, w.opened.pass.id).preview).toBe('broken');
    expect(headerNotice()).toEqual([]);
    await turnLoads(w.settings, 'overlay');
    expect(page(w.settings).preview).toBeNull();
    const [said] = headerNotice();
    expect(said).toMatchObject({ sendable: false });
    expect(said?.text).toContain('/settings');
    await turnLoads(w.people, 'overlay');
    expect(headerNotice()).toEqual([said]);
    await turnLoads(w.people, 'clean');
    expect(headerNotice()).toEqual([]);
    expect(passView(w.h.store.db, w.opened.pass.id).preview).toBe('clean');
  });
});

describe('a preview with nothing answering at the app address', () => {
  it('blames no page, says so once in the header, and clears it once the app answers', async () => {
    captures = 2;
    await world();
    await turnLoads(w.settings, 'no_answer');
    expect(page(w.settings).preview).toBeNull();
    expect(previewNotices(w.settings)).toEqual([]);
    expect(passView(w.h.store.db, w.opened.pass.id).preview).toBe('clean');
    const [said] = headerNotice();
    expect(said).toMatchObject({ sendable: false });
    expect(said?.text).toContain(`Nothing answers at ${APP}`);
    await turnLoads(w.people, 'no_answer');
    await turnLoads(w.people, 'no_answer');
    expect(headerNotice()).toEqual([said]);
    expect(page(w.people).preview).toBeNull();
    expect(moveCards()).toEqual([]);
    await turnLoads(w.people, 'clean');
    expect(headerNotice()).toEqual([]);
  });

  it('with a preview command, asks 10db to start the preview instead of saying nothing answers', async () => {
    captures = 2;
    await world([], {}, 'pnpm dev');
    await turnLoads(w.settings, 'no_answer');
    expect(asked).toEqual([w.h.project.id]);
    expect(headerNotice()).toEqual([]);
    expect(page(w.settings).preview).toBeNull();
  });
});

describe('routeLoad', () => {
  const shot = (outcome: ShotOutcome, cameraFailed = false) => ({
    outcome,
    overlayText: outcome === 'overlay' ? 'Failed to compile' : null,
    reason: outcome === 'failed' ? 'HTTP 500' : null,
    cameraFailed,
  });
  it.each([
    { name: 'a clean load', shots: [shot('clean')], outcome: 'clean' },
    { name: 'a failed document', shots: [shot('clean'), shot('failed')], outcome: 'failed' },
    { name: 'an overlay', shots: [shot('overlay')], outcome: 'overlay' },
    {
      name: 'only a load the browser failed: nothing to judge',
      shots: [shot('failed', true)],
      outcome: null,
    },
    {
      name: 'a load the browser failed beside a clean one',
      shots: [shot('failed', true), shot('clean')],
      outcome: 'clean',
    },
    { name: 'nothing loaded', shots: [], outcome: null },
    {
      name: 'nothing answering beside a clean load: the app went away',
      shots: [shot('clean'), shot('no_answer')],
      outcome: 'no_answer',
    },
    {
      name: 'nothing answering beside an overlay: the app is down, not broken',
      shots: [shot('overlay'), shot('no_answer')],
      outcome: 'no_answer',
    },
  ])('$name', ({ shots, outcome }) => {
    expect(routeLoad('/settings', shots)?.outcome ?? null).toBe(outcome);
  });
});
