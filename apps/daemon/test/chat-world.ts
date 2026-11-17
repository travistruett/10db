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
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createTestStore, seedProject, setChatWork, type Store } from '@10db/db';
import { ManualClock } from '../src/clock';
import {
  chatHooks,
  createBriefs,
  createChatLiveSessions,
  type Briefs,
  createChatService,
  createChatWorkService,
  type ChatWorkService,
  type ChatHooksDeps,
  type ChatService,
} from '../src/chat';
import { createFolderHold, type FolderHold } from '../src/folder-hold';
import { createPendingOpens } from '../src/pass';
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
import { createTakeoverService, prepareTakeover, type TakeoverService } from '../src/takeover';
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
  readonly work: ChatWorkService;
  readonly briefs: Briefs;
  readonly folderHold: FolderHold;
  readonly inbox: InboxService;
  readonly project: ProjectDto;
  readonly dataDir: string;
  readonly events: DaemonEvent[];
  /** The builder's terminal: Open in Terminal, Again, Copy the Command and Hand Back. */
  readonly takeover: TakeoverService;
  /** What the opener was asked to open, in order. */
  readonly opened: { readonly app: string; readonly script: string }[];
  /** The terminal side of the world, which a test sets. */
  readonly terminal: {
    app: 'terminal' | 'iterm' | 'copy';
    /** The opener fails with this. */
    openerFails: Error | null;
    /** The servers' preparation waits for this. */
    prepareGate: Promise<void> | null;
    /** What the project's checkout differs from HEAD in. */
    changed: string[];
    /** Reading what changed fails with this (a git failure). */
    changedFails: Error | null;
    /** Removing a set's servers throws. */
    removeFails: boolean;
    /** What the servers' preparation says it left out. */
    serverNotes: string[];
    setupNotes: string[];
  };
  /** Moves the project to an account of this kind: the next launch and the next `models` see it. */
  launchOn(kind: AgentAccountKind): void;
  /** Puts a chat where it works in the builder's checkout, as a choice of Here does. */
  here(chatId: ChatDto['id']): void;
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
  const work = createChatWorkService({
    state,
    engine,
    log: silentLogger,
    now: () => clock.now(),
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
      firstChange: (chatId) => {
        work.firstChange(chatId);
      },
      ...(opts.tendb === undefined ? {} : { judge: opts.tendb({ store }) }),
    }),
  );
  const briefs = createBriefs(clock);
  let takeoverService: TakeoverService | null = null;
  const chat = createChatService({
    state,
    engine,
    folderHold,
    pendingOpens: createPendingOpens({ state }),
    briefs,
    clock,
    dataDir: dir.path,
    log: silentLogger,
    now: () => clock.now(),
    modelsOf: () => ({
      default: 'claude-opus-5-5',
      offered: [
        { model: 'claude-opus-5-5', tier: null },
        { model: 'claude-sonnet-5-5', tier: null },
      ],
    }),
    webSearchOf: () => adapter.capabilities({ kind: launched.kind }, null).webSearch,
    takeover: () => takeoverService,
  });
  const terminal: ChatWorld['terminal'] = {
    app: 'copy',
    openerFails: null,
    prepareGate: null,
    changed: [],
    changedFails: null,
    removeFails: false,
    serverNotes: [],
    setupNotes: [],
  };
  const opened: { app: string; script: string }[] = [];
  const takeover = createTakeoverService({
    state,
    engine,
    folderHold,
    chats: () => chat,
    dataDir: dir.path,
    now: () => clock.now(),
    log: silentLogger,
    app: () => terminal.app,
    opener: (app, script) => {
      opened.push({ app, script });
      return terminal.openerFails === null
        ? Promise.resolve()
        : Promise.reject(terminal.openerFails);
    },
    sourceOf: () => ({
      cwd: opts.checkout ?? '/repo',
      kind: launched.kind,
      model: 'claude-opus-5-5',
      effort: 'high',
      launch: {
        set: {},
        unset: [],
        unsetPrefixes: ['TENDB_'],
        keychain: [],
        apiKeyHelperAccount: null,
        scrub: false,
        model: 'claude-opus-5-5',
      },
      web: false,
    }),
    prepare: (input, signal) =>
      prepareTakeover(
        {
          adapter,
          servers: async () => {
            await terminal.prepareGate;
            return {
              instructions: 'Be kind.',
              pluginDirs: [],
              projectMcpServers: {},
              yourMcpServers: {
                docs: {
                  connect: { type: 'http', url: 'https://docs.example/mcp', headers: null },
                  claudeOAuth: null,
                  codex: {
                    enabledTools: null,
                    disabledTools: [],
                    startupTimeoutSec: null,
                    toolTimeoutSec: null,
                  },
                },
              },
              notes: terminal.serverNotes,
              tempDirs: [join(dir.path, 'server-temp')],
              remove: () => {
                if (terminal.removeFails) throw new Error('could not remove a set');
              },
            };
          },
          onboard: () => Promise.resolve(),
          newSetId: () => randomBytes(4).toString('hex'),
        },
        input,
        signal,
      ),
    notesOf: () => adapter.takeoverNotes(),
    setupNotes: () => terminal.setupNotes,
    changedPaths: () =>
      terminal.changedFails === null
        ? Promise.resolve(terminal.changed)
        : Promise.reject(terminal.changedFails),
  });
  takeoverService = takeover;
  return {
    store,
    state,
    engine,
    adapter,
    clock,
    chat,
    work,
    briefs,
    folderHold,
    inbox,
    project,
    dataDir: dir.path,
    events,
    takeover,
    opened,
    terminal,
    launchOn(kind) {
      launched.kind = kind;
    },
    here(chatId) {
      store.write((ctx) => setChatWork(ctx, chatId, null, { place: 'here' }));
    },
    open: (tabPosition = 0) => chat.create({ projectId: project.id, model: null, tabPosition }),
    async close() {
      await engine.close();
      dir.cleanup();
      close();
    },
  };
}
