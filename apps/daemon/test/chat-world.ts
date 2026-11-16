import {
  AccountKind,
  JudgeKind,
  type AgentAccountKind,
  type ChatDto,
  type DaemonEvent,
  type Effort,
  type ProjectDto,
  type ProjectInput,
} from '@10db/contracts';
import { join } from 'node:path';
import { createTestStore, seedProject, type Store } from '@10db/db';
import { ManualClock } from '../src/clock';
import {
  chatHooks,
  createBriefs,
  createChatLiveSessions,
  type Briefs,
  createChatService,
  type ChatHooksDeps,
  type ChatService,
} from '../src/chat';
import { createFolderHold, type FolderHold } from '../src/folder-hold';
import { createExploreEngine, pictureLimitsFor, type ExploreEngine } from '../src/conversation';
import { createEventBus, createLiveFrames, createStateStore, type StateStore } from '../src/events';
import { createInboxService, type InboxService } from '../src/inbox';
import type { Judge } from '../src/judge';
import { silentLogger } from '../src/log';
import { mintSessionToken } from '../src/mcp';
import { fileAccessJudge } from '../src/sandbox';
import { FakeAdapter, type FakeScriptBook } from '../src/sessions';
import type { ShapeLaunch } from '../src/shape';
import { shapeAgentModels } from '../src/shape';
import { tempDir } from './fixtures';

// A project's chats on a real store, the explore engine and the fake adapter: the chat service and
// its hooks as the daemon wires them, with a launch that needs no account on disk.

export interface ChatWorld {
  readonly store: Store;
  readonly state: StateStore;
  readonly engine: ExploreEngine;
  readonly adapter: FakeAdapter;
  readonly clock: ManualClock;
  readonly chat: ChatService;
  readonly briefs: Briefs;
  readonly folderHold: FolderHold;
  readonly inbox: InboxService;
  readonly project: ProjectDto;
  readonly dataDir: string;
  readonly events: DaemonEvent[];
  /** Moves the project to an account of this kind: the next launch and the next `models` see it. */
  launchOn(kind: AgentAccountKind): void;
  /** A chat in its tab at `tabPosition`. */
  open(tabPosition?: number): ChatDto;
  close(): Promise<void>;
}

export function chatWorld(
  opts: {
    readonly prepare?: ChatHooksDeps['prepare'];
    /** The fake adapter's scripts, by `Chat: <first message>`. */
    readonly book?: FakeScriptBook;
    readonly judge?: JudgeKind;
    /** 10db's judge, made over the world's store; absent, a `tendb` chat is on the rules. */
    readonly tendb?: (world: { readonly store: Store }) => Judge;
    /** A daemon restart: a new engine, hold and service over the earlier world's store and folders. */
    readonly over?: ChatWorld;
    /** The project's checkout the session works in: a real repository, where a test reads what landed. */
    readonly checkout?: string;
    /** The project's own fields, such as the real `repoPath` a git-reading test needs. */
    readonly project?: Partial<ProjectInput>;
  } = {},
): ChatWorld {
  const { store, close } =
    opts.over === undefined
      ? createTestStore()
      : { store: opts.over.store, close: () => undefined };
  const project = opts.over?.project ?? seedProject(store, { name: 'alpha', ...opts.project });
  const bus = createEventBus();
  const events: DaemonEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const state = createStateStore(store, bus);
  const folderHold = createFolderHold({ state, bus });
  const adapter = new FakeAdapter(opts.book ?? {});
  const clock = new ManualClock();
  const dir =
    opts.over === undefined
      ? tempDir('chat')
      : { path: opts.over.dataDir, cleanup: () => undefined };
  const inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  const launched = { kind: AccountKind.ClaudeSubscription as AgentAccountKind };
  const engine = createExploreEngine({
    state,
    adapter,
    clock,
    log: silentLogger,
    dataDir: dir.path,
    frames: createLiveFrames(),
    bus,
    mintToken: mintSessionToken,
    accountBlocked: () => null,
    defaultPauseMs: 30 * 60_000,
    withdrawCard: (id) => {
      inbox.withdraw(id);
    },
  });
  const launch = (model: string | null, effort: Effort | null): ShapeLaunch => ({
    cwd: opts.checkout ?? '/repo',
    model: model ?? 'claude-opus-5-5',
    modelId: model ?? 'claude-opus-5-5',
    effort: effort ?? 'high',
    agentModels: shapeAgentModels(launched.kind),
    env: {},
    account: {
      accountId: project.accountId,
      label: 'Claude plan',
      kind: launched.kind,
      identity: null,
    },
    access: {
      checkout: opts.checkout ?? '/repo',
      home: '/home',
      protectedReads: [],
      sandboxRoots: ['/tmp/10db'],
      // A real checkout is judged on its real paths, as a session's file access is.
      ...(opts.checkout === undefined
        ? {}
        : {
            commands: {
              protectedPaths: [],
              fileAccess: fileAccessJudge({
                checkout: opts.checkout,
                home: '/home',
                protectedReads: [],
                readList: [],
                systemDocRoots: [],
                configDir: join(dir.path, 'no-claude-config'),
                providerSessionId: null,
                sandboxTemp: { roots: ['/tmp/10db'], own: '/tmp/10db/own' },
              }),
            },
          }),
    },
  });
  engine.register(
    'chat',
    chatHooks({
      live: createChatLiveSessions(),
      state,
      folderHold,
      log: silentLogger,
      dataDir: dir.path,
      now: () => clock.now(),
      mcp: { url: 'http://127.0.0.1:4317/mcp' },
      launch: (_projectId, model, effort) => launch(model, effort),
      ...(opts.prepare === undefined ? {} : { prepare: opts.prepare }),
      limitsFor: pictureLimitsFor,
      judgeOf: () => opts.judge ?? JudgeKind.Native,
      webSearchOf: (kind, model) => adapter.capabilities({ kind }, model).webSearch,
      clock,
      ...(opts.tendb === undefined ? {} : { judge: opts.tendb({ store }) }),
    }),
  );
  const briefs = createBriefs(clock);
  const chat = createChatService({
    state,
    engine,
    folderHold,
    briefs,
    clock,
    dataDir: dir.path,
    now: () => clock.now(),
    modelsOf: () => ({
      default: 'claude-opus-5-5',
      offered: [
        { model: 'claude-opus-5-5', tier: null },
        { model: 'claude-sonnet-5-5', tier: null },
      ],
    }),
    webSearchOf: () => adapter.capabilities({ kind: launched.kind }, null).webSearch,
  });
  return {
    store,
    state,
    engine,
    adapter,
    clock,
    chat,
    briefs,
    folderHold,
    inbox,
    project,
    dataDir: dir.path,
    events,
    launchOn(kind) {
      launched.kind = kind;
    },
    open: (tabPosition = 0) => chat.create({ projectId: project.id, model: null, tabPosition }),
    async close() {
      await engine.close();
      dir.cleanup();
      close();
    },
  };
}
