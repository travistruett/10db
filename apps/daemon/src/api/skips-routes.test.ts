import { SkippedActionDto, type WorkstreamId } from '@10db/contracts';
import {
  createTestStore,
  getWorkstream,
  listSkipsForWorkstream,
  recordSkip,
  type Store,
} from '@10db/db';
import { defineWebSocketHelper } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { stubServices } from '../../test/api-stub';
import { seedWorkstream } from '../../test/fixtures';
import { createApp } from './app';

const TOKEN = 'ui-token';
let store: Store;
let close: () => void;
let request: (path: string) => Promise<Response>;

beforeEach(() => {
  ({ store, close } = createTestStore());
  const app = createApp({
    onUnexpectedError: () => undefined,
    startedAt: new Date(),
    allowedOrigins: [],
    token: TOKEN,
    services: stubServices({
      listWorkstreamSkips: (id) => {
        getWorkstream(store.db, id);
        return listSkipsForWorkstream(store.db, id);
      },
    }),
    upgradeWebSocket: defineWebSocketHelper(() => new Response(null, { status: 426 })),
    mcp: () => Promise.resolve(new Response('mcp')),
    builderMcp: () => Promise.resolve(new Response('builder')),
  });
  request = (path) =>
    Promise.resolve(app.request(path, { headers: { Authorization: `Bearer ${TOKEN}` } }));
});
afterEach(() => {
  close();
});

function skip(workstreamId: WorkstreamId, summary: string, toolUseId: string) {
  store.write((ctx) =>
    recordSkip(ctx, {
      workstreamId,
      sessionId: null,
      toolName: 'Bash',
      toolUseId,
      callKey: null,
      summary,
      summaryCut: false,
      kind: 'default_mode_card',
      limit: null,
      reason: 'nobody is watching',
      source: 'broker',
    }),
  );
}

// T4 Task 8: a task shows what its run skipped, and only its run's.
describe('GET /workstreams/:id/skips', () => {
  it("lists a run's skips oldest first", async () => {
    const one = seedWorkstream(store);
    const other = seedWorkstream(store, { project: one.project, title: 'Other' });
    skip(one.workstream.id, 'curl a', 'tu-1');
    skip(other.workstream.id, 'curl other', 'tu-2');
    skip(one.workstream.id, 'curl b', 'tu-3');

    const res = await request(`/workstreams/${one.workstream.id}/skips`);
    expect(res.status).toBe(200);
    const rows = z.array(SkippedActionDto).parse(await res.json());
    expect(rows.map((r) => r.summary)).toEqual(['curl a', 'curl b']);
  });
});
