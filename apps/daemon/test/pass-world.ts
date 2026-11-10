import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PassTurnDto, ProjectInput, TaskDto, WorkstreamId } from '@10db/contracts';
import { createStore, endPassTurn, getTask, insertPassTurn, openDatabase } from '@10db/db';
import {
  createDeliveryJobs,
  openPass,
  type PassOpened,
  type PutBackKeptWork,
} from '../src/delivery';
import { createEventBus, createStateStore } from '../src/events';
import { createGit } from '../src/git';
import { createInboxService } from '../src/inbox';
import { silentLogger } from '../src/log';
import type { PassWorkDeps } from '../src/pass';
import { createDeliveryHarness, type DeliveryHarness } from './delivery-harness';

// A Workbench pass on Your folder of a real repository and database: two pages, Settings and People,
// a shared `src` area and a `deps` hazard, for the tests of a pass's work in the folder.

export const PASS_PROJECT: Partial<ProjectInput> = {
  areas: [
    { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
    { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
    { name: 'src', globs: ['src/**'], role: 'shared' },
  ],
  hazards: [{ name: 'deps', globs: ['pnpm-lock.yaml'], commands: ['pnpm install'] }],
};

/** A put-back for tasks with no kept work. */
export const nothingKept: PutBackKeptWork = () => Promise.resolve({ applied: [], left: [] });

export interface PassWorld {
  readonly h: DeliveryHarness;
  readonly opened: PassOpened;
  /** The pass's branch. */
  readonly branch: string;
  /** Names `settings`, the shared `src` and the `deps` hazard. */
  readonly settings: TaskDto;
  readonly people: TaskDto;
  readonly deps: PassWorkDeps;
  /** Writes `content` at `path` in the folder. */
  write(path: string, content: string): void;
  /** The task's run. */
  runOf(task: TaskDto): WorkstreamId;
  /** Starts the task's next turn, as a message going into its session does. */
  startTurn(task: TaskDto): PassTurnDto;
  /** Ends the turn as Ready. */
  endTurn(turn: PassTurnDto): void;
  /**
   * What a daemon started again on the same database and folder works with: a new connection to the
   * database file, and a new event bus, inbox, job queue and git, so nothing the last one held in
   * memory carries over. The world's own `h` reads the same file.
   */
  restart(): PassWorkDeps;
  close(): void;
}

/**
 * Commits the pages' files, runs `before` (to leave dirt in the folder), and opens a pass on both
 * pages with `putBack`.
 */
export async function openPassWorld(
  opts: {
    readonly before?: (world: Pick<PassWorld, 'write'>) => void;
    readonly putBack?: PutBackKeptWork;
    /** Laid over the pass project's areas and hazards. */
    readonly project?: Partial<ProjectInput>;
  } = {},
): Promise<PassWorld> {
  const h = createDeliveryHarness({ ...PASS_PROJECT, ...opts.project });
  const write = (path: string, content: string): void => {
    const file = join(h.repo, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  h.commit('src/settings/page.tsx', 'settings\n');
  h.commit('src/settings/old.tsx', 'old\n');
  h.commit('src/people/page.tsx', 'people\n');
  h.commit('src/shared.ts', 'shared\n');
  h.commit('pnpm-lock.yaml', 'lock: 1\n');
  opts.before?.({ write });
  const settings = h.addTask('Settings: UI work', { areas: ['settings', 'src', 'deps'] });
  const people = h.addTask('People: UI work', { areas: ['people'] });
  const opened = await openPass(
    h.ctx,
    { projectId: h.project.id, name: 'Polish', taskIds: [settings.id, people.id] },
    { leaseMs: 60_000, putBack: opts.putBack ?? nothingKept },
  );
  const reopened: (() => void)[] = [];
  const runOf = (task: TaskDto): WorkstreamId => {
    const id = getTask(h.store.db, task.id).workstreamId;
    if (id === null) throw new Error(`${task.title} has no run`);
    return id;
  };
  return {
    h,
    opened,
    branch: h.git$('symbolic-ref', '--short', 'HEAD'),
    settings: getTask(h.store.db, settings.id),
    people: getTask(h.store.db, people.id),
    deps: {
      state: h.state,
      git: h.git,
      inbox: h.inbox,
      jobs: h.jobs,
      logger: silentLogger,
      clock: h.ctx.clock,
    },
    write,
    runOf,
    startTurn: (task) =>
      h.state.write((c) =>
        insertPassTurn(c, {
          taskId: task.id,
          workstreamId: runOf(task),
          sessionId: null,
          messageId: null,
        }),
      ),
    endTurn: (turn) => {
      h.state.write((c) => endPassTurn(c, turn.id, { ending: 'ready', replyBody: null }));
    },
    restart: () => {
      const db = openDatabase(h.store.db.$client.name);
      reopened.push(() => {
        db.$client.close();
      });
      const state = createStateStore(createStore(db), createEventBus());
      return {
        state,
        git: createGit(),
        inbox: createInboxService({ state, onParkedAnswer: () => undefined }),
        jobs: createDeliveryJobs(silentLogger),
        logger: silentLogger,
        clock: h.ctx.clock,
      };
    },
    close: () => {
      for (const close of reopened) close();
      h.close();
    },
  };
}
