import {
  EventType,
  mintId,
  PassClosePageChoice,
  type PassTurnDto,
  type TaskDto,
  type TaskScreenDto,
} from '@10db/contracts';
import {
  closePass,
  getTask,
  insertSession,
  listTaskScreens,
  listTaskThread,
  patchProject,
  renamePass,
  setClosePlan,
  setPassTurnKept,
  settlePassTurn,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, waitFor, type TempDir } from '../../test/fixtures';
import { captureLogs, type LogCapture } from '../../test/log-capture';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { FakeCamera } from '../../test/fake-camera';
import { silentLogger } from '../log';
import { createGateRunner } from '../verify';
import { ManualClock } from '../clock';
import { BEFORE_WAIT_MS, ELSEWHERE_NOTICE, startPictures, type Pictures } from './pictures';

// Workbench spec §10, §12, plan B5: the service end to end on a real pass in a real folder and
// database, with a fake camera standing in for the browser, a child process 10db does not own.

const APP = 'http://localhost:8800';

let w: PassWorld;
let dir: TempDir;
let cam: FakeCamera;
let logs: LogCapture;
let pictures: Pictures | null = null;
let prepared = 0;
let clock: ManualClock;

afterEach(async () => {
  await pictures?.stop();
  pictures = null;
  w.close();
  dir.cleanup();
});

async function world(project: { devLoginCommand?: string } = {}): Promise<void> {
  dir = tempDir('pictures');
  w = await openPassWorld();
  w.h.state.write((ctx) => patchProject(ctx, w.h.project.id, { appUrl: APP, ...project }));
  cam = new FakeCamera();
  clock = new ManualClock(new Date('2026-11-10T12:00:00.000Z'));
  logs = captureLogs();
  prepared = 0;
}

function start(): Pictures {
  pictures = startPictures({
    state: w.h.state,
    bus: w.h.bus,
    camera: cam,
    prepareBrowser: () => {
      prepared += 1;
    },
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
  });
  return pictures;
}

/** Waits until `n` captures have ended. */
const ended = (n: number) =>
  waitFor(() => logs.lines().filter((l) => l['msg'] === 'a capture ended').length >= n);

const screensOf = (task: TaskDto): TaskScreenDto[] => listTaskScreens(w.h.store.db, task.id);
const kinds = (task: TaskDto) =>
  screensOf(task).map((s) => `${s.kind}${s.turnSeq === null ? '' : String(s.turnSeq)}`);

/** A Ready turn of the page that kept `keptSha` (null: it changed nothing). */
function readyTurn(task: TaskDto, keptSha: string | null): PassTurnDto {
  const turn = w.startTurn(task);
  w.endTurn(turn);
  return w.h.state.write((ctx) => {
    setPassTurnKept(ctx, turn.id, { keptSha, keptBaseSha: 'b'.repeat(40), sharedSeq: null });
    return settlePassTurn(ctx, turn.id);
  });
}

/** A session of the page's run reports a tool call, as the session's activity does. */
function toolCall(task: TaskDto, tool: string): void {
  const workstreamId = w.runOf(task);
  w.h.state.write((ctx) => {
    const session = insertSession(ctx, {
      workstreamId,
      provider: 'claude',
      model: 'm',
      effort: 'low',
      mode: 'managed',
      mcpTokenHash: mintId('Session'),
    });
    ctx.emit({
      type: EventType.SessionActivity,
      entityType: 'session',
      entityId: session.id,
      data: {
        workstreamId,
        kind: 'tool',
        summary: 'x',
        tool: { name: tool, target: 'x' },
        turn: null,
      },
    });
  });
}

describe('pictures of a pass', () => {
  it('takes befores of the open pages, then a picture per Ready turn that changed something', async () => {
    await world();
    start();
    await ended(2);
    expect(kinds(w.settings)).toEqual(['before']);
    expect(kinds(w.people)).toEqual(['before']);
    expect(screensOf(w.settings)[0]).toMatchObject({
      route: '/settings',
      viewport: { width: 1440, height: 900 },
    });
    expect(prepared).toBe(1);

    const kept = 'a'.repeat(40);
    cam.version = 2;
    readyTurn(w.settings, kept);
    await ended(3);
    expect(kinds(w.settings)).toEqual(['before', 'turn1']);
    expect(screensOf(w.settings)[1]?.keptSha).toBe(kept);

    // A turn that kept nothing new is not shot.
    readyTurn(w.settings, kept);
    // A turn that kept a new commit, with the same bytes, stores nothing new.
    readyTurn(w.settings, 'c'.repeat(40));
    await ended(4);
    expect(cam.shots).toHaveLength(4);
    expect(kinds(w.settings)).toEqual(['before', 'turn1']);
  });

  it("drops a turn picture that loads when the page's next turn starts", async () => {
    await world();
    start();
    await ended(2);
    cam.hold();
    readyTurn(w.people, 'a'.repeat(40));
    await waitFor(() => cam.holding);
    w.startTurn(w.people);
    await ended(3);
    expect(kinds(w.people)).toEqual(['before']);
  });

  it("takes the after at sign-off, and holds a closing pass's after until the pass closes", async () => {
    await world();
    start();
    await ended(2);
    const signedOff = (task: TaskDto): void => {
      w.h.state.write((ctx) => {
        ctx.emit({
          type: EventType.PassPageSignedOff,
          entityType: 'pass',
          entityId: w.opened.pass.id,
          data: {
            passId: w.opened.pass.id,
            taskId: task.id,
            landedSha: null,
            files: [],
            sharedLanded: [],
          },
        });
      });
    };
    cam.version = 3;
    signedOff(w.settings);
    await ended(3);
    expect(kinds(w.settings)).toEqual(['before', 'after']);

    w.h.state.write((ctx) => {
      setClosePlan(ctx, w.opened.pass.id, {
        token: 't',
        pages: [{ taskId: w.people.id, choice: PassClosePageChoice.SignOff }],
        files: [],
        shared: [],
      });
    });
    signedOff(w.people);
    expect(kinds(w.people)).toEqual(['before']);
    w.h.state.write((ctx) => closePass(ctx, w.opened.pass.id, { settled: false }));
    await ended(4);
    expect(kinds(w.people)).toEqual(['before', 'after']);
  });
});

describe('the before rule', () => {
  it('drops a before the page wrote ahead of, and asks no other', async () => {
    await world();
    cam.hold();
    start();
    await waitFor(() => cam.holding);
    const first = cam.shots[0]?.route === '/settings' ? w.settings : w.people;
    w.startTurn(first);
    toolCall(first, 'Write');
    cam.release();
    await ended(2);
    expect(kinds(first)).toEqual([]);
    w.h.state.write((ctx) => renamePass(ctx, w.opened.pass.id, 'Polish again'));
    await ended(2);
    expect(cam.shots.filter((s) => s.route === cam.shots[0]?.route)).toHaveLength(1);
  });

  it('keeps a before when the page only read before it was taken', async () => {
    await world();
    cam.hold();
    start();
    await waitFor(() => cam.holding);
    const first = cam.shots[0]?.route === '/settings' ? w.settings : w.people;
    toolCall(first, 'Read');
    cam.release();
    await ended(2);
    expect(kinds(first)).toEqual(['before']);
  });

  it('holds the befores while the browser downloads and takes them once it is ready', async () => {
    await world();
    const ready = cam.fetching();
    start();
    expect(cam.shots).toEqual([]);
    ready();
    await ended(2);
    expect(kinds(w.settings)).toEqual(['before']);
    expect(kinds(w.people)).toEqual(['before']);
    expect(cam.shotWhile).toEqual(['ready', 'ready']);
  });
});

describe('signing in', () => {
  it('signs in again once when a page lands elsewhere, and says so once per task', async () => {
    await world({ devLoginCommand: 'echo /api/auth/dev-login/tok/' });
    cam.outcomes = ['elsewhere', 'elsewhere', 'elsewhere', 'elsewhere'];
    const p = start();
    await ended(2);
    // A first sign-in at the first capture, then one again for each page that landed elsewhere.
    expect(cam.signIns.every((u) => u === `${APP}/api/auth/dev-login/tok/`)).toBe(true);
    expect(cam.signIns).toHaveLength(3);
    const notices = (task: TaskDto) =>
      listTaskThread(w.h.store.db, task.id).filter((m) => m.body.startsWith(ELSEWHERE_NOTICE));
    expect(notices(w.settings)).toHaveLength(1);
    expect(kinds(w.settings)).toEqual([]);
    expect(p.status(w.h.project.id).signIn?.problem).toMatch(/landed on another page/);

    cam.outcomes = ['elsewhere', 'elsewhere'];
    readyTurn(w.settings, 'a'.repeat(40));
    await ended(3);
    expect(notices(w.settings)).toHaveLength(1);
  });

  it('takes no picture when the dev login fails, says why, and runs it again next time', async () => {
    await world({ devLoginCommand: 'echo nothing here; exit 2' });
    const p = start();
    await ended(2);
    expect(cam.shots).toEqual([]);
    expect(p.status(w.h.project.id).signIn?.problem).toBe('The dev login command failed (exit 2)');
    w.h.state.write((ctx) => patchProject(ctx, w.h.project.id, { devLoginCommand: 'echo /login' }));
    readyTurn(w.settings, 'a'.repeat(40));
    await ended(3);
    expect(cam.signIns).toEqual([`${APP}/login`]);
    expect(kinds(w.settings)).toEqual(['turn1']);
    expect(p.status(w.h.project.id).signIn?.problem).toBeNull();
  });
});

describe('what stops a capture', () => {
  it('aborts a shot when the app address changes, and writes nothing', async () => {
    await world();
    cam.hold();
    start();
    await waitFor(() => cam.holding);
    w.h.state.write((ctx) =>
      patchProject(ctx, w.h.project.id, { appUrl: 'http://localhost:5173' }),
    );
    await ended(1);
    expect([...screensOf(w.settings), ...screensOf(w.people)]).toEqual([]);
  });

  it('leaves no row for a capture in flight when the daemon stops', async () => {
    await world();
    cam.hold();
    const p = start();
    await waitFor(() => cam.holding);
    await p.stop();
    pictures = null;
    expect([...screensOf(w.settings), ...screensOf(w.people)]).toEqual([]);
  });
});

describe("a page's first launch", () => {
  it('waits for its before while it loads, and goes on once it is kept', async () => {
    await world();
    cam.hold();
    const p = start();
    await waitFor(() => cam.holding);
    const first = cam.shots[0]?.route === '/settings' ? w.settings : w.people;
    let went = false;
    const waiting = p
      .awaitBefore(getTask(w.h.store.db, first.id), new AbortController().signal)
      .then(() => {
        went = true;
      });
    await Promise.resolve();
    expect(went).toBe(false);
    cam.release();
    await waiting;
    expect(kinds(first)).toEqual(['before']);
  });

  it(`goes on after ${String(BEFORE_WAIT_MS / 1000)} seconds without it`, async () => {
    await world();
    cam.hold();
    const p = start();
    await waitFor(() => cam.holding);
    const first = cam.shots[0]?.route === '/settings' ? w.settings : w.people;
    let went = false;
    const waiting = p
      .awaitBefore(getTask(w.h.store.db, first.id), new AbortController().signal)
      .then(() => {
        went = true;
      });
    clock.advance(BEFORE_WAIT_MS - 1);
    await Promise.resolve();
    expect(went).toBe(false);
    clock.advance(1);
    await waiting;
    expect(cam.holding).toBe(true);
    cam.release();
  });
});
