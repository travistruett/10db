import {
  AccountKind,
  ConversationItemAuthor,
  ConversationItemKind,
  ShapeOrigin,
  type AgentAccountKind,
  type ConversationDeltaFrame,
  type ConversationState,
  type ProjectDto,
  type ShapeId,
} from '@10db/contracts';
import {
  createTestStore,
  insertItem,
  insertShape,
  listItems,
  recordAccountSecret,
  seedAccount,
  seedProject,
  shapeConversation,
  type ConversationItemRow,
  type ConversationRow,
  type Store,
} from '@10db/db';
import { z } from 'zod';
import { ManualClock } from '../src/clock';
import {
  createExploreEngine,
  pictureLimitsFor,
  type ExploreEngine,
  type ExploreEngineDeps,
  type ExploreOwnerHooks,
  type ExploreStart,
  type TurnEnd,
} from '../src/conversation';
import { createEventBus, createLiveFrames, createStateStore, type StateStore } from '../src/events';
import { silentLogger } from '../src/log';
import { mintSessionToken } from '../src/mcp';
import { FakeAdapter } from '../src/sessions';
import { tempDir, testPolicy } from './fixtures';

// One explore conversation on a real store, the fake adapter and a manual clock, with the smallest
// owner there is: its session is a plain explore spec, a starter sends its text, the digest joins the
// items. An owner is the engine's input, as Plan's and Sessions' are.

export const MODEL_LABELS: Readonly<Record<string, string>> = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
};

/** A promise and the function that resolves it, for a turn or a start the test lets go. */
export interface Gate {
  readonly promise: Promise<void>;
  release(): void;
}

export function gate(): Gate {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export interface EngineInstance {
  readonly engine: ExploreEngine;
  readonly adapter: FakeAdapter;
  readonly clock: ManualClock;
}

export interface ExploreWorld extends EngineInstance {
  readonly store: Store;
  readonly state: StateStore;
  readonly project: ProjectDto;
  readonly shapeId: ShapeId;
  readonly conv: ConversationRow;
  readonly dataDir: string;
  readonly frames: ConversationDeltaFrame[];
  /** Every turn end the owner was told, in order. */
  readonly ends: TurnEnd[];
  /** Every start the owner was asked to build a session for. */
  readonly starts: ExploreStart[];
  /** When set, a start waits for it before its session is built. */
  specGate: Promise<void> | null;
  /** The owner's hooks a test replaces, read at each call. */
  overrides: Partial<Pick<ExploreOwnerHooks, 'digest' | 'outgoing' | 'spec'>>;
  /** How often a launch was released. */
  released: number;
  /** What the owner was told, in order: `starting` before a turn's take, `state:<state>` after each reduce. */
  readonly hookLog: string[];
  /** What the owner answers `turnStarting`, and so what a session it opens afterwards is marked as. */
  writes: boolean;
  /** Stores a builder message and tells the engine, as an owner does (rule 1). */
  send(text: string): ConversationItemRow;
  /** Stores a builder message only, as a Redo's `post` does. */
  keep(text: string): ConversationItemRow;
  items(): ConversationItemRow[];
  stateOf(): ConversationState;
  /** Another Plan conversation in the project, on the same engine. */
  another(): { readonly conv: ConversationRow; send(text: string): ConversationItemRow };
  /** A second engine over the same store, with its own fake and clock, as a restart is. */
  restart(over?: Partial<ExploreEngineDeps>): EngineInstance;
  close(): void;
}

const Texted = z.union([z.object({ text: z.string() }), z.object({ prompt: z.string() })]);

/** What an item says: its text, or what a press asks for. */
const textOf = (item: ConversationItemRow): string => {
  const parsed = Texted.safeParse(item.body);
  if (!parsed.success) return '';
  return 'text' in parsed.data ? parsed.data.text : parsed.data.prompt;
};

export function exploreWorld(
  opts: {
    readonly accountKind?: AgentAccountKind;
    readonly deps?: Partial<ExploreEngineDeps>;
  } = {},
): ExploreWorld {
  const { store, close } = createTestStore();
  const kind = opts.accountKind ?? AccountKind.ClaudeSubscription;
  const metered =
    kind === AccountKind.ClaudeSubscription
      ? null
      : seedAccount(store, { kind: 'anthropic_api_key', label: 'Keyed' });
  if (metered !== null)
    store.write((ctx) => {
      recordAccountSecret(ctx, metered.id, 'sha256:0000000000000000');
    });
  const project = seedProject(store, {
    name: 'alpha',
    ...(metered === null ? {} : { accountId: metered.id }),
  });
  const shape = store.write((ctx) =>
    insertShape(ctx, project.id, { title: 'Board polish', origin: ShapeOrigin.App }),
  ).value;
  const bus = createEventBus();
  const state = createStateStore(store, bus);
  const conv = shapeConversation(state.db, shape.id);
  const dir = tempDir('explore');
  const frames: ConversationDeltaFrame[] = [];
  const ends: TurnEnd[] = [];
  const starts: ExploreStart[] = [];
  const accountKind = metered === null ? kind : AccountKind.AnthropicApiKey;

  const world: ExploreWorld = {
    store,
    state,
    project,
    shapeId: shape.id,
    conv,
    dataDir: dir.path,
    frames,
    ends,
    starts,
    specGate: null,
    overrides: {},
    released: 0,
    hookLog: [],
    writes: false,
    ...build({}),
    send(text) {
      const item = world.keep(text);
      world.engine.queued(conv.id);
      return item;
    },
    keep: (text) =>
      state.write((ctx) =>
        insertItem(ctx, conv.id, {
          author: ConversationItemAuthor.Builder,
          kind: ConversationItemKind.Message,
          body: { text },
        }),
      ),
    items: () => listItems(state.db, conv.id),
    another() {
      const other = store.write((ctx) =>
        insertShape(ctx, project.id, { title: 'Another', origin: ShapeOrigin.App }),
      ).value;
      const c = shapeConversation(state.db, other.id);
      return {
        conv: c,
        send(text) {
          const item = state.write((ctx) =>
            insertItem(ctx, c.id, {
              author: ConversationItemAuthor.Builder,
              kind: ConversationItemKind.Message,
              body: { text },
            }),
          );
          world.engine.queued(c.id);
          return item;
        },
      };
    },
    stateOf: () => world.engine.view(conv.id).state,
    restart(over = {}) {
      const next = build(over);
      Object.assign(world, next);
      return next;
    },
    close() {
      dir.cleanup();
      close();
    },
  };

  function owner(): ExploreOwnerHooks {
    return {
      freshAtContextPct: 70,
      async spec(c, start) {
        starts.push(start);
        if (world.specGate !== null) await world.specGate;
        if (world.overrides.spec !== undefined) return world.overrides.spec(c, start);
        return {
          spec: {
            sessionId: start.sessionId,
            conversationId: c.id,
            policy: testPolicy('plan'),
            profile: {
              kind: 'explore',
              shapeId: shape.id,
              systemPrompt: 'You are Plan.',
              tools: ['Read'],
              allowedTools: ['Read'],
              disallowedTools: ['Edit'],
              agents: {},
            },
            cwd: '/repo',
            prompt: start.first.text,
            model: 'claude-opus-5-5',
            effort: 'high',
            resumeProviderSessionId: start.resume,
            env: {},
            account: {
              accountId: project.accountId,
              label: 'Claude',
              kind: accountKind,
              identity: null,
            },
            mcp: { url: 'http://127.0.0.1:4317/mcp', token: start.mcpToken, toolTimeoutMs: 60_000 },
            sandbox: null,
            projectMcpServers: {},
            yourMcpServers: {},
            preToolUse: () => ({ decision: 'allow' }),
            canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'no', by: '10db' }),
          },
          limits: pictureLimitsFor(accountKind),
          writes: world.writes,
          expiresAt: null,
          accountId: project.accountId,
          model: 'claude-opus-5-5',
          release: () => {
            world.released += 1;
            return Promise.resolve();
          },
          track: () => undefined,
        };
      },
      digest: (c) =>
        world.overrides.digest?.(c) ??
        listItems(state.db, c.id)
          .map(textOf)
          .filter((t) => t !== '')
          .join('\n'),
      outgoing: (c, item, session) =>
        world.overrides.outgoing?.(c, item, session) ?? {
          text: textOf(item),
          images: [],
          blocks: [],
          sent: () => undefined,
        },
      turnStarting: () => {
        world.hookLog.push('starting');
        return { writes: world.writes };
      },
      onState: (_c, to) => {
        world.hookLog.push(`state:${to}`);
      },
      onTurnEnded: (_c, end) => {
        ends.push(end);
        return Promise.resolve();
      },
      readBackSpec: () =>
        Promise.resolve({
          account: {
            accountId: project.accountId,
            label: 'Claude',
            kind: accountKind,
            identity: null,
          },
          env: {},
          cwd: '/repo',
        }),
      describeModel: (_c, model) => {
        const id = model ?? 'claude-opus-5-5';
        return {
          model: id,
          label: MODEL_LABELS[id] ?? id,
          launchId: `launch:${id}`,
          effort: 'high',
        };
      },
    };
  }

  function build(over: Partial<ExploreEngineDeps>): EngineInstance {
    const adapter = new FakeAdapter({});
    const clock = new ManualClock();
    const live = createLiveFrames();
    live.subscribe((frame) => frames.push(frame));
    const engine = createExploreEngine({
      state,
      adapter,
      clock,
      log: silentLogger,
      dataDir: dir.path,
      frames: live,
      bus,
      mintToken: mintSessionToken,
      accountBlocked: () => null,
      defaultPauseMs: 30 * 60_000,
      ...opts.deps,
      ...over,
    });
    engine.register('shape', owner());
    return { engine, adapter, clock };
  }

  return world;
}
