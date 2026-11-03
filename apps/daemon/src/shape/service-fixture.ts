import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintId, type DaemonEvent } from '@10db/contracts';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { FakeAdapter } from '../sessions';
import type { TrackedFiles } from './ceremony';
import { seedConversation, type ConversationFixture } from './conversation-fixture';
import { createShapeService, type ShapeService } from './service';

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
  /** Closes the service and builds a new one over the same database, as quitting and reopening 10db does. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export function createServiceFixture(opts: { trackedFiles?: TrackedFiles } = {}): ServiceFixture {
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
      // No git in a test: the project's checkout is not a repository, so nothing is one-way unless asked.
      trackedFiles: opts.trackedFiles ?? (() => []),
      mcp: { url: 'http://127.0.0.1:4317/mcp', toolTimeoutMs: 60_000 },
      launch: () => ({
        cwd: '/repo',
        model: 'opus',
        effort: 'high',
        env: {},
        account: {
          accountId: mintId('Account'),
          label: 'Claude plan',
          kind: 'claude_subscription',
          identity: null,
        },
        access: {
          checkout: '/repo',
          home: '/home',
          protectedReads: [],
          tempRoot: '/tmp/10db',
        },
      }),
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
