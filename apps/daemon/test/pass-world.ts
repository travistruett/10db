import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  mintId,
  PASS_SIGN_OFF_CHOICE,
  type ChatId,
  type PassId,
  WorkstreamState,
  type PassTurnDto,
  type ProjectInput,
  type TaskDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  createStore,
  endPassTurn,
  getTask,
  getWorkstreamRow,
  insertChat,
  insertConversation,
  insertInboxItem,
  insertPassTurn,
  listPassTasks,
  openDatabase,
  openPassTurn,
  transitionWorkstream,
} from '@10db/db';
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

/** What a world's work in the folder needs, a sign-off's included. */
export type WorldDeps = PassWorkDeps & { readonly committed: (passId: PassId) => void };

export interface PassWorld {
  readonly h: DeliveryHarness;
  readonly opened: PassOpened;
  /** The pass's branch. */
  readonly branch: string;
  /** Names `settings`, the shared `src` and the `deps` hazard. */
  readonly settings: TaskDto;
  readonly people: TaskDto;
  /** The pass's work in the folder, and a sign-off's `committed`, which records the pass it names. */
  readonly deps: WorldDeps;
  /** Each pass a sign-off asked to push, in order. */
  readonly committed: readonly PassId[];
  /** Writes `content` at `path` in the folder. */
  write(path: string, content: string): void;
  /** The task's run. */
  runOf(task: TaskDto): WorkstreamId;
  /** Starts the task's next turn, as a message going into its session does, or answers the open one. */
  startTurn(task: TaskDto): PassTurnDto;
  /** Ends the turn as Ready. */
  endTurn(turn: PassTurnDto): void;
  /** The page's run waits on the builder with an open `check` item, as a Ready page does. */
  ready(task: TaskDto): void;
  /**
   * What a daemon started again on the same database and folder works with: a new connection to the
   * database file, and a new event bus, inbox, job queue and git, so nothing the last one held in
   * memory carries over. The world's own `h` reads the same file.
   */
  restart(): WorldDeps;
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
    /** The pass's page cap; else the default. */
    readonly pageCap?: number;
    /** People is a page the pass makes its task for, as Start Pass's pages do, not a Board task. */
    readonly peopleByPass?: boolean;
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
  const boardPeople =
    opts.peopleByPass === true ? null : h.addTask('People: UI work', { areas: ['people'] });
  const opened = await openPass(
    h.ctx,
    {
      projectId: h.project.id,
      name: 'Polish',
      taskIds: boardPeople === null ? [settings.id] : [settings.id, boardPeople.id],
      ...(boardPeople === null ? { pages: ['people'] } : {}),
      ...(opts.pageCap === undefined ? {} : { pageCap: opts.pageCap }),
    },
    { leaseMs: 60_000, putBack: opts.putBack ?? nothingKept },
  );
  const people =
    boardPeople ??
    listPassTasks(h.store.db, opened.pass.id).find((t) => t.areas.includes('people'));
  if (!people) throw new Error('the pass made no People task');
  return {
    ...bindWorld(h, opened, write),
    settings: getTask(h.store.db, settings.id),
    people: getTask(h.store.db, people.id),
  };
}

/** What a pass world shares whatever its pages: the folder's writes, the turns and the restart. */
function bindWorld(
  h: DeliveryHarness,
  opened: PassOpened,
  write: (path: string, content: string) => void,
): Omit<PassWorld, 'settings' | 'people'> {
  const reopened: (() => void)[] = [];
  const committed: PassId[] = [];
  const record = (passId: PassId): void => {
    committed.push(passId);
  };
  const runOf = (task: TaskDto): WorkstreamId => {
    const id = getTask(h.store.db, task.id).workstreamId;
    if (id === null) throw new Error(`${task.title} has no run`);
    return id;
  };
  return {
    h,
    opened,
    branch: h.git$('symbolic-ref', '--short', 'HEAD'),
    deps: {
      state: h.state,
      git: h.git,
      inbox: h.inbox,
      jobs: h.jobs,
      logger: silentLogger,
      clock: h.ctx.clock,
      committed: record,
    },
    committed,
    write,
    runOf,
    startTurn: (task) =>
      h.state.write(
        (c) =>
          openPassTurn(c.tx, task.id) ??
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
    ready: (task) => {
      const ws = runOf(task);
      h.state.write((ctx) => {
        // A page waiting on the builder runs again when a message starts its next turn.
        const path =
          getWorkstreamRow(ctx.tx, ws).state === WorkstreamState.WaitingHuman
            ? [WorkstreamState.Running]
            : [WorkstreamState.Starting, WorkstreamState.Running];
        for (const to of path) transitionWorkstream(ctx, ws, { to, fence: null });
        const item = insertInboxItem(ctx, {
          projectId: h.project.id,
          kind: 'check',
          title: `Ready: ${task.title}`,
          body: 'Ready.',
          options: [{ label: PASS_SIGN_OFF_CHOICE, description: 'The page is right' }],
          recommendation: null,
          category: 'product',
          urgency: 'normal',
          detail: null,
          foldKey: null,
          targets: [{ workstreamId: ws, sessionId: null }],
        });
        transitionWorkstream(ctx, ws, {
          to: WorkstreamState.WaitingHuman,
          fence: null,
          patch: { nextAction: { kind: 'pass_review', inboxId: item.id } },
        });
      });
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
        committed: record,
      };
    },
    close: () => {
      for (const close of reopened) close();
      h.close();
    },
  };
}

export interface WholeProjectWorld extends PassWorld {
  /** The pass's one task, whose page is the whole project; `settings` and `people` are it too. */
  readonly task: TaskDto;
  readonly chatId: ChatId;
}

/**
 * A pass of one on Your folder of a real repository and database, opened for a chat as Do It opens it. The
 * project has the Settings, People and shared `src` areas and the `deps` hazard, but the pass holds none of them.
 */
export async function openWholeProjectWorld(
  opts: {
    readonly before?: (world: Pick<PassWorld, 'write'>) => void;
    readonly project?: Partial<ProjectInput>;
  } = {},
): Promise<WholeProjectWorld> {
  const h = createDeliveryHarness({ ...PASS_PROJECT, ...opts.project });
  const write = (path: string, content: string): void => {
    const file = join(h.repo, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  h.commit('src/settings/page.tsx', 'settings\n');
  h.commit('src/people/page.tsx', 'people\n');
  h.commit('src/shared.ts', 'shared\n');
  h.commit('pnpm-lock.yaml', 'lock: 1\n');
  opts.before?.({ write });
  const chatId = mintId('Chat');
  h.store.write((ctx) => {
    const conv = insertConversation(ctx, {
      projectId: h.project.id,
      owner: { kind: ConversationOwnerKind.Chat, id: chatId },
      profile: ConversationProfile.Explore,
      state: ConversationState.IdleCold,
    });
    insertChat(ctx, {
      id: chatId,
      projectId: h.project.id,
      conversationId: conv.id,
      title: 'A chat',
      tabPosition: 0,
    });
  });
  const opened = await openPass(
    h.ctx,
    {
      projectId: h.project.id,
      name: 'Knock it out',
      taskIds: [],
      wholeProject: { title: 'Knock it out', brief: 'Do the thing.', chatId },
    },
    { leaseMs: 60_000, putBack: nothingKept },
  );
  const [task] = listPassTasks(h.store.db, opened.pass.id);
  if (!task) throw new Error('the pass of one made no task');
  return { ...bindWorld(h, opened, write), settings: task, people: task, task, chatId };
}
