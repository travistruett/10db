import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PassClosePageChoice,
  PassNoticeKind,
  TaskMessageAuthor,
  WorkstreamState,
  type PassTurnDto,
  type TaskDto,
} from '@10db/contracts';
import {
  getPass,
  getPassProgress,
  getProject,
  getWorkstream,
  listPassCheckPids,
  listPassTasks,
  listPassTurns,
  listTaskThread,
  openPassTurn,
  patchProject,
  setPassCheckPid,
  transitionWorkstream,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, waitFor, type TempDir } from '../../test/fixtures';
import { alive, orphanGateGroup } from '../../test/orphan-gate';
import { nothingKept, openPassWorld, PASS_PROJECT, type PassWorld } from '../../test/pass-world';
import { createPassPullRequests, passGateKind, type PassPullRequests } from '../delivery';
import { silentLogger } from '../log';
import { closeGateOf, createPassCloses, joinPass } from '../pass';
import { systemProcesses } from '../recovery';
import { createGateRunner, createGateSlots, limitGates } from '../verify';
import { SandboxProfileError, type GateSandbox } from '../sandbox';
import { endTurnSteps, finishEndedTurn } from './pass-turn';
import {
  startTurnChecks,
  TURN_CHECK_TIMEOUT_MS,
  withTurnChecks,
  type TurnChecks,
} from './turn-checks';

// Workbench spec §8.1, W16, D19, §12: after a page's turn ends Ready, the project's changed-files
// check runs in the folder as advice, one at a time through the gate slot, coalesced per pass. A
// failure is offered, never sent; a pass that leaves OPEN stops it; a restart stops a left one.

let w: PassWorld;
let dir: TempDir;
let started: { checks: TurnChecks; unsubscribe: () => void } | null = null;
let prs: PassPullRequests | null = null;
afterEach(async () => {
  started?.unsubscribe();
  await started?.checks.stopAll();
  started = null;
  await prs?.stop();
  prs = null;
  w.close();
  dir.cleanup();
});

/**
 * The project's changed-files check: a script outside the folder that takes a lock (exit 99 when
 * another run holds it), counts its run with `said`, waits for `go` while `hold` exists, then passes
 * once `pass` exists or fails naming `names`.
 */
function checkScript(names: string, said = 'run'): string {
  const d = dir.path;
  const script = join(d, 'check.sh');
  writeFileSync(
    script,
    [
      `D='${d}'`,
      'mkdir "$D/lock" 2>/dev/null || { echo collided >> "$D/collisions"; exit 99; }',
      `echo "${said}" >> "$D/runs"`,
      'if [ -f "$D/hold" ]; then while [ ! -f "$D/go" ]; do sleep 0.05; done; fi',
      'sleep 0.2',
      'rmdir "$D/lock"',
      '[ -f "$D/pass" ] && exit 0',
      `echo "${names}:3:1 - error TS2322: Type 'number' is not assignable"`,
      'exit 1',
    ].join('\n'),
  );
  return `sh '${script}'`;
}

const lines = (name: string): string[] => {
  const file = join(dir.path, name);
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
};
const touch = (name: string): void => {
  writeFileSync(join(dir.path, name), '');
};

async function world(command: () => string, more: { pages?: string[] } = {}) {
  dir = tempDir('turn-check');
  const pages = more.pages ?? [];
  w = await openPassWorld({
    project: {
      gateCommand: 'true',
      areas: [
        ...(PASS_PROJECT.areas ?? []),
        ...pages.map((name) => ({
          name,
          globs: [`pages/${name}/**`],
          role: 'page' as const,
          route: `/${name}`,
        })),
      ],
    },
  });
  w.h.state.write((ctx) => patchProject(ctx, w.h.project.id, { changedCheckCommand: command() }));
}

/** The service as start-up builds it: one gate slot, the real runner, the system's processes. */
async function start(
  opts: {
    readonly identify?: (pid: number) => Promise<string | null>;
    readonly timeoutMs?: number;
    readonly sandbox?: GateSandbox;
  } = {},
): Promise<TurnChecks> {
  started = await startTurnChecks({
    state: w.h.state,
    git: w.h.git,
    gate: limitGates(createGateRunner({ sandbox: opts.sandbox ?? null, logger: silentLogger }), {
      slots: createGateSlots(1),
      clock: w.h.ctx.clock,
      logger: silentLogger,
    }),
    logger: silentLogger,
    clock: w.h.ctx.clock,
    dataDir: w.h.dataDir,
    sessionEnv: () => ({ PATH: '/usr/bin:/bin' }),
    identifyProcess: opts.identify ?? ((pid) => systemProcesses.identify(pid)),
    timeoutMs: opts.timeoutMs ?? TURN_CHECK_TIMEOUT_MS,
    bus: w.h.bus,
    processes: systemProcesses,
  });
  return started.checks;
}

/** The page's run is working, as a launch for a message makes it, and its next turn is open. */
function turnOf(task: TaskDto): PassTurnDto {
  const id = w.runOf(task);
  const state = getWorkstream(w.h.store.db, id).state;
  w.h.state.write((ctx) => {
    const path =
      state === WorkstreamState.WaitingHuman
        ? [WorkstreamState.Running]
        : state === WorkstreamState.Running
          ? []
          : [WorkstreamState.Starting, WorkstreamState.Running];
    for (const to of path) transitionWorkstream(ctx, id, { to, fence: null });
  });
  return w.startTurn(task);
}

/** The page takes a turn that writes `path`, and the turn ends Ready as the runner ends it. */
async function readyTurn(task: TaskDto, path: string): Promise<void> {
  turnOf(task);
  w.write(path, `${task.title} ${String(Date.now())}\n`);
  await endTurnSteps(w.deps, {
    workstreamId: w.runOf(task),
    ending: 'ready',
    reply: null,
    fence: null,
    providerSessionId: null,
    reason: '',
  });
}

const passId = () => w.opened.pass.id;
const header = () =>
  getPassProgress(w.h.store.db, passId()).notices.filter(
    (n) => n.kind === PassNoticeKind.TurnCheck,
  );
const checkNotices = (task: TaskDto) =>
  listTaskThread(w.h.store.db, task.id).filter(
    (m) => m.author === TaskMessageAuthor.System && m.body.startsWith('Check failed'),
  );
const checks = () => listPassTurns(w.h.store.db, passId()).map((t) => t.check);
const attempts = () =>
  [w.settings, w.people].map((t) => getWorkstream(w.h.store.db, w.runOf(t)).attempt);

describe('the check after each turn', () => {
  it('runs one at a time for four pages ending together, offers the failure and sends nothing; a pass clears it', async () => {
    await world(() => checkScript('src/settings/page.tsx'), { pages: ['billing', 'admin'] });
    await joinPass(
      w.h.ctx,
      passId(),
      { pages: ['billing', 'admin'], taskIds: [], firstMessage: null },
      { leaseMs: 60_000, putBack: nothingKept },
    );
    const pageOf = (area: string): TaskDto => {
      const task = listPassTasks(w.h.store.db, passId()).find((t) => t.areas.includes(area));
      if (!task) throw new Error(`no task for ${area}`);
      return task;
    };
    const [billing, admin] = [pageOf('billing'), pageOf('admin')];
    await start();
    const before = attempts();
    // The first check runs until every page has ended its turn.
    touch('hold');

    await Promise.all([
      readyTurn(w.settings, 'src/settings/page.tsx'),
      readyTurn(w.people, 'src/people/page.tsx'),
      readyTurn(billing, 'pages/billing/page.tsx'),
      readyTurn(admin, 'pages/admin/page.tsx'),
    ]);
    touch('go');
    await waitFor(() => checks().every((c) => c === 'failed'));

    expect(lines('collisions')).toEqual([]);
    expect(lines('runs')).toEqual(['run', 'run']);
    // Each run names Settings' file, and the newer offer replaces the older one.
    expect(checkNotices(w.settings).map((m) => [m.body, m.sendable])).toEqual([
      ['Check failed: names `src/settings/page.tsx`', false],
      ['Check failed: names `src/settings/page.tsx`', true],
    ]);
    for (const other of [w.people, billing, admin]) expect(checkNotices(other)).toEqual([]);
    expect(header()).toMatchObject([{ kind: PassNoticeKind.TurnCheck, sendable: true }]);
    expect(header()[0]?.text).toContain("error TS2322: Type 'number' is not assignable");
    // Advice: no turn started, no attempt moved, the pages wait for the builder.
    for (const task of [w.settings, w.people, billing, admin])
      expect(openPassTurn(w.h.store.db, task.id)).toBeUndefined();
    expect(attempts()).toEqual(before);
    expect(listPassCheckPids(w.h.store.db)).toEqual([]);

    // A check that passes clears the header and takes back every offer.
    touch('pass');
    await readyTurn(w.people, 'src/people/page.tsx');
    await waitFor(() => checks().at(-1) === 'passed');
    expect(header()).toEqual([]);
    expect(checkNotices(w.settings).map((m) => m.sendable)).toEqual([false, false]);
    expect(lines('runs')).toHaveLength(3);
  });

  it('says in the header that a run that threw could not run, offering nothing, and the next Ready runs', async () => {
    await world(() => checkScript('src/settings/page.tsx'));
    let psRefuses = true;
    // ps could not be asked for the check's process: the runner kills the group and rejects.
    await start({
      identify: (pid) => {
        if (psRefuses) throw new Error('ps is not there');
        return systemProcesses.identify(pid);
      },
    });

    await readyTurn(w.settings, 'src/settings/page.tsx');
    await waitFor(() => header().length === 1);

    expect(header()).toMatchObject([
      {
        kind: PassNoticeKind.TurnCheck,
        sendable: false,
        text: 'The changed-files check after a turn could not run: ps is not there',
      },
    ]);
    expect(checks()).toEqual(['none']);
    expect(checkNotices(w.settings)).toEqual([]);
    psRefuses = false;
    await readyTurn(w.people, 'src/people/page.tsx');
    await waitFor(() => checks().at(-1) === 'failed');
    expect(header()).toMatchObject([{ sendable: true }]);
  });

  it("takes back an older failure's offers on every page, not only the pages the newer one names", async () => {
    await world(() => checkScript('$(cat "$D/names")'));
    await start();
    writeFileSync(join(dir.path, 'names'), 'src/settings/page.tsx');
    await readyTurn(w.settings, 'src/settings/page.tsx');
    await waitFor(() => checks().at(-1) === 'failed');
    expect(checkNotices(w.settings).map((m) => m.sendable)).toEqual([true]);

    writeFileSync(join(dir.path, 'names'), 'src/people/page.tsx');
    await readyTurn(w.people, 'src/people/page.tsx');
    await waitFor(() => checks().filter((c) => c === 'failed').length === 2);

    expect(checkNotices(w.settings).map((m) => m.sendable)).toEqual([false]);
    expect(checkNotices(w.people).map((m) => m.sendable)).toEqual([true]);
  });

  it.each<{
    name: string;
    hold?: boolean;
    timeoutMs?: number;
    sandbox?: () => GateSandbox;
    text: string;
  }>([
    {
      name: 'a check that timed out',
      hold: true,
      timeoutMs: 300,
      text: 'The changed-files check after a turn timed out after 0.3 s',
    },
    {
      name: 'a check whose sandbox could not start (exit 126)',
      sandbox: () => ({
        forRun: () => Promise.reject(new SandboxProfileError('network', 'no such host list')),
      }),
      text: "The changed-files check after a turn could not run: 10db could not start the gate's sandbox: no such host list",
    },
    {
      name: 'a check whose docker call the sandbox refused',
      sandbox: () => ({
        forRun: (input) =>
          Promise.resolve({
            file: '/bin/sh',
            args: ['-c', input.command],
            env: { PATH: '/usr/bin:/bin' },
            cwd: input.project.repoPath,
            tmpDir: input.project.repoPath,
            commandEnv: {},
            commandLines: 1,
            dockerRefused: () => true,
            dispose: () => Promise.resolve(),
          }),
      }),
      text: 'The changed-files check after a turn could not run: Docker is off for this project',
    },
  ])(
    'says in the header, offering nothing, that $name, and leaves the turn unchecked',
    async ({ hold, timeoutMs, sandbox, text }) => {
      await world(() => checkScript('src/settings/page.tsx'));
      if (hold === true) touch('hold');
      await start({
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(sandbox === undefined ? {} : { sandbox: sandbox() }),
      });

      await readyTurn(w.settings, 'src/settings/page.tsx');
      await waitFor(() => header().length === 1);

      expect(header()).toMatchObject([{ kind: PassNoticeKind.TurnCheck, sendable: false, text }]);
      expect(checks()).toEqual(['none']);
      expect(checkNotices(w.settings)).toEqual([]);
      touch('go');
    },
  );

  it('runs and reports a check whose process group ps could not be asked for, recording no pid', async () => {
    await world(() => checkScript('src/settings/page.tsx'));
    await start({ identify: () => Promise.reject(new Error('ps failed')) });

    await readyTurn(w.settings, 'src/settings/page.tsx');
    await waitFor(() => checks().at(-1) === 'failed');

    expect(listPassCheckPids(w.h.store.db)).toEqual([]);
    expect(header()).toMatchObject([{ sendable: true }]);
  });

  it("keeps a newer check's pid when a stopped check ends after it started", async () => {
    await world(() => checkScript('src/settings/page.tsx'));
    touch('hold');
    let first = 0;
    let letFirstAnswer = (): void => undefined;
    const firstAnswer = new Promise<void>((resolve) => {
      letFirstAnswer = resolve;
    });
    // ps answers the first check late, after the next one has started and been recorded.
    const turnChecks = await start({
      identify: async (pid) => {
        if (first === 0) {
          first = pid;
          await firstAnswer;
        }
        return systemProcesses.identify(pid);
      },
    });
    await readyTurn(w.settings, 'src/settings/page.tsx');
    await waitFor(() => first !== 0);

    const stopped = turnChecks.stop(passId());
    await readyTurn(w.people, 'src/people/page.tsx');
    const [newer] = await waitFor(() => {
      const pids = listPassCheckPids(w.h.store.db);
      return pids.length === 1 ? pids : undefined;
    });
    letFirstAnswer();
    await stopped;

    expect(newer?.pid).not.toBe(first);
    expect(listPassCheckPids(w.h.store.db).map((p) => p.pid)).toEqual([newer?.pid]);
    touch('go');
  });

  it('stops a check a stopped daemon left running before recovery settles a Ready turn, which is checked once', async () => {
    const orphan = await orphanGateGroup();
    try {
      await world(() =>
        checkScript(
          'src/settings/page.tsx',
          `$(kill -0 ${String(orphan.pid)} 2>/dev/null && echo alive || echo dead)`,
        ),
      );
      // The daemon stopped between the turn's end and its settling, with a check running.
      const turn = turnOf(w.settings);
      w.write('src/settings/page.tsx', 'changed\n');
      w.endTurn(turn);
      w.h.state.write((ctx) => {
        setPassCheckPid(ctx, passId(), { pid: orphan.pid, start: orphan.startedAt });
      });

      await start();

      expect(alive(orphan.pid)).toBe(false);
      expect(listPassCheckPids(w.h.store.db)).toEqual([]);
      expect(lines('runs')).toEqual([]);
      const ended = listPassTurns(w.h.store.db, passId()).find((t) => t.id === turn.id);
      if (!ended) throw new Error('no turn');
      // Recovery's own finish of the turn raises its Ready, which asks for the check.
      await finishEndedTurn(w.deps, ended, { fence: null, providerSessionId: null, reason: '' });
      await waitFor(() => checks().at(-1) === 'failed');
      expect(lines('runs')).toEqual(['dead']);
    } finally {
      orphan.cleanup();
    }
  });

  it('stops a running check when Close Pass begins, and its late result writes nothing', async () => {
    await world(() => checkScript('src/settings/page.tsx'));
    touch('hold');
    const turnChecks = await start();
    await readyTurn(w.settings, 'src/settings/page.tsx');
    await readyTurn(w.people, 'src/people/page.tsx');
    const [running] = await waitFor(() => {
      const pids = listPassCheckPids(w.h.store.db);
      return pids.length === 1 ? pids : undefined;
    });
    prs = createPassPullRequests({
      ...w.h.ctx,
      state: w.h.state,
      gate: createGateRunner({ sandbox: null, logger: silentLogger }),
      dataDir: w.h.dataDir,
      sessionEnv: () => ({ PATH: '/usr/bin:/bin' }),
      identifyProcess: (pid) => systemProcesses.identify(pid),
      review: null,
    });
    const closes = createPassCloses({
      ...w.deps,
      stopLane: () => Promise.resolve(),
      wrote: () => Promise.resolve(),
      ship: withTurnChecks(prs, turnChecks),
      gateWhere: (pass) => closeGateOf(passGateKind(getProject(w.h.store.db, pass.projectId))),
    });
    const shown = await closes.preview(passId());

    await closes.close(passId(), {
      token: shown.token,
      pages: [
        { taskId: w.settings.id, choice: PassClosePageChoice.SignOff },
        { taskId: w.people.id, choice: PassClosePageChoice.TakeOut },
      ],
      files: [],
      shared: [],
    });
    await w.h.jobs.idle();
    touch('go');

    expect(getPass(w.h.store.db, passId()).state).toBe('CLOSED');
    expect(running && alive(running.pid)).toBe(false);
    expect(lines('runs')).toEqual(['run']);
    expect(listPassCheckPids(w.h.store.db)).toEqual([]);
    expect(header()).toEqual([]);
    expect(checks()).toEqual(['none', 'none']);
    expect([...checkNotices(w.settings), ...checkNotices(w.people)]).toEqual([]);
  });
});
