import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountKind, mintId, type DaemonEvent, type SupportedAccountKind } from '@10db/contracts';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import type { PictureLimits, ScreenService } from '../screens';
import { FakeAdapter } from '../sessions';
import type { Hold } from '../verify';
import type { TrackedFiles } from './ceremony';
import { seedConversation, type ConversationFixture } from './conversation-fixture';
import type { JoiningProblem } from './convert';
import {
  createShapeService,
  type ShapeLaunch,
  type ShapeService,
  type ShapeServiceDeps,
} from './service';

/** A conversation served by a real shape service on the fake adapter, with a files directory of its own. */
export interface ServiceFixture {
  readonly c: ConversationFixture;
  readonly state: StateStore;
  readonly adapter: FakeAdapter;
  /** The service running now; `restart` replaces it. */
  readonly service: ShapeService;
  /** The root the service keeps each conversation's dropped files under. */
  readonly filesDir: string;
  readonly events: DaemonEvent[];
  /** Moves the project to an account of this kind, as a plan falling back to Bedrock does: the next start sees it. */
  launchOn(kind: SupportedAccountKind): void;
  /** Closes the service and builds a new one over the same database, as quitting and reopening 10db does. */
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
    /** Told the model each launch is resolved for: the conversation's choice, or null. */
    onLaunch?: (model: string | null) => void;
    /** The picture limits of an account kind; the real ones by default (`pictureLimitsFor`). */
    limitsFor?: (kind: AccountKind) => PictureLimits;
    /** The kind of the account the project launches on; a Claude plan by default. */
    accountKind?: SupportedAccountKind;
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
  const make = (): ShapeService =>
    createShapeService({
      state,
      adapter,
      clock: new ManualClock(),
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
      launch: (_projectId, chosen) => {
        opts.onLaunch?.(chosen);
        return launchFor(chosen);
      },
    });
  const launchFor = (chosen: string | null): ShapeLaunch => ({
    cwd: '/repo',
    model: chosen ?? 'opus',
    effort: 'high',
    env: {},
    account: {
      accountId: mintId('Account'),
      label: launched.kind === AccountKind.Bedrock ? 'Bedrock' : 'Claude plan',
      kind: launched.kind,
      identity: null,
    },
    access: {
      checkout: opts.checkout ?? '/repo',
      home: opts.home ?? '/home',
      protectedReads: [],
      tempRoot: '/tmp/10db',
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
    filesDir,
    events,
    launchOn(kind) {
      launched.kind = kind;
    },
    async restart() {
      await service.close();
      service = make();
    },
    async close() {
      await service.close();
      c.close();
      rmSync(filesDir, { recursive: true, force: true });
    },
  };
}
