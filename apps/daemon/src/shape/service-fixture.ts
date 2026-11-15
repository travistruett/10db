import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountKind, type DaemonEvent, type AgentAccountKind, type Effort } from '@10db/contracts';
import { ManualClock } from '../clock';
import { createExploreEngine, type ExploreEngine } from '../conversation';
import type { Judge } from '../judge';
import { createEventBus, createLiveFrames, createStateStore, type StateStore } from '../events';
import { mintSessionToken } from '../mcp';
import { silentLogger } from '../log';
import type { ScreenService } from '../screens';
import { FakeAdapter } from '../sessions';
import type { Hold } from '../verify';
import type { TrackedFiles } from './ceremony';
import { shapeAgentModels } from './agent-models';
import { seedConversation, type ConversationFixture } from './conversation-fixture';
import type { JoiningProblem } from './convert';
import {
  createShapeService,
  type ShapeLaunch,
  type ShapeService,
  type ShapeServiceDeps,
} from './service';
import type { PictureLimits } from '../conversation';

/** A conversation served by a real shape service on the fake adapter, with a files directory of its own. */
export interface ServiceFixture {
  readonly c: ConversationFixture;
  readonly state: StateStore;
  readonly adapter: FakeAdapter;
  /** The service running now; `restart` replaces it. */
  readonly service: ShapeService;
  /** The explore engine the service runs on now; `restart` replaces it too. */
  readonly engine: ExploreEngine;
  /** The root the service keeps each conversation's dropped files under. */
  readonly filesDir: string;
  readonly events: DaemonEvent[];
  /** Moves the project to an account of this kind, as a plan falling back to Bedrock does: the next start sees it. */
  launchOn(kind: AgentAccountKind): void;
  /**
   * Closes the service and its engine and builds new ones over the same database, as quitting and
   * reopening 10db does: the new engine recovers before anything is asked of it.
   */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export function createServiceFixture(
  opts: {
    trackedFiles?: TrackedFiles;
    hold?: Hold;
    joiningProblem?: JoiningProblem;
    home?: string;
    checkout?: string;
    prepare?: ShapeServiceDeps['prepare'];
    models?: ShapeServiceDeps['models'];
    /** What the account launches a model with, when that is not the model's own ID. */
    launchId?: (model: string) => string;
    /** Told the model each launch is resolved for: the conversation's choice, or null. */
    onLaunch?: (model: string | null, effort: Effort | null) => void;
    /** The picture limits of an account kind; the real ones by default (`pictureLimitsFor`). */
    limitsFor?: (kind: AccountKind) => PictureLimits;
    /** The kind of the account the project launches on; a Claude plan by default. */
    accountKind?: AgentAccountKind;
    /** 10db's judge for a Plan on an account auto mode doesn't judge; none by default. */
    judge?: (state: StateStore) => Judge;
    /** Draws screens for `see_screen`; none by default. */
    screens?: Pick<ScreenService, 'see'>;
  } = {},
): ServiceFixture {
  const launched = { kind: opts.accountKind ?? AccountKind.ClaudeSubscription };
  const c = seedConversation();
  const bus = createEventBus();
  const events: DaemonEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const state = createStateStore(c.store, bus);
  const adapter = new FakeAdapter({});
  const filesDir = mkdtempSync(join(tmpdir(), 'shape-files-'));
  const clock = new ManualClock();
  const engineOf = (): ExploreEngine =>
    createExploreEngine({
      state,
      adapter,
      clock,
      log: silentLogger,
      dataDir: filesDir,
      frames: createLiveFrames(),
      bus,
      mintToken: mintSessionToken,
      accountBlocked: () => null,
      defaultPauseMs: 30 * 60_000,
      ...(opts.hold === undefined ? {} : { hold: opts.hold }),
    });
  let engine = engineOf();
  const make = (): ShapeService =>
    createShapeService({
      state,
      adapter,
      engine,
      clock,
      log: silentLogger,
      filesDir,
      joiningProblem: opts.joiningProblem ?? (() => null),
      ...(opts.hold === undefined ? {} : { hold: opts.hold }),
      ...(opts.prepare === undefined ? {} : { prepare: opts.prepare }),
      ...(opts.models === undefined ? {} : { models: opts.models }),
      // No git in a test: the project's checkout is not a repository, so nothing is one-way unless asked.
      trackedFiles: opts.trackedFiles ?? (() => []),
      mcp: { url: 'http://127.0.0.1:4317/mcp', toolTimeoutMs: 60_000 },
      ...(opts.limitsFor === undefined ? {} : { limitsFor: opts.limitsFor }),
      ...(opts.screens === undefined ? {} : { screens: opts.screens }),
      ...(opts.judge === undefined ? {} : { judge: opts.judge(state) }),
      launch: (_projectId, chosen, effort) => {
        opts.onLaunch?.(chosen, effort);
        return launchFor(chosen, effort);
      },
    });
  const launchFor = (chosen: string | null, effort: Effort | null = null): ShapeLaunch => ({
    cwd: '/repo',
    model: opts.launchId?.(chosen ?? 'claude-opus-5-5') ?? chosen ?? 'claude-opus-5-5',
    modelId: chosen ?? 'claude-opus-5-5',
    effort: effort ?? 'high',
    agentModels: shapeAgentModels(launched.kind),
    env: {},
    account: {
      accountId: c.project.accountId,
      label: launched.kind === AccountKind.Bedrock ? 'Bedrock' : 'Claude plan',
      kind: launched.kind,
      identity: null,
    },
    access: {
      checkout: opts.checkout ?? '/repo',
      home: opts.home ?? '/home',
      protectedReads: [],
      sandboxRoots: ['/tmp/10db'],
    },
  });
  let service = make();
  return {
    c,
    state,
    adapter,
    get service() {
      return service;
    },
    get engine() {
      return engine;
    },
    filesDir,
    events,
    launchOn(kind) {
      launched.kind = kind;
    },
    async restart() {
      await service.close();
      engine = engineOf();
      service = make();
      await engine.recover();
    },
    async close() {
      await service.close();
      c.close();
      rmSync(filesDir, { recursive: true, force: true });
    },
  };
}
