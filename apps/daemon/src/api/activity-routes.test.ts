import { ActivityPageDto, type ProjectId, type TaskId } from '@10db/contracts';
import {
  createTestStore,
  insertTask,
  pageActivity,
  pageInbox,
  seedProject,
  type Store,
} from '@10db/db';
import { defineWebSocketHelper } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubServices } from '../../test/api-stub';
import { CardTier, postNotice } from '../inbox';
import { createApp } from './app';

const TOKEN = 'ui-token';
let store: Store;
let close: () => void;
let request: (path: string) => Promise<Response>;
let projectId: ProjectId;
let taskId: TaskId;

beforeEach(() => {
  ({ store, close } = createTestStore());
  projectId = seedProject(store).id;
  taskId = store.write((ctx) =>
    insertTask(ctx, projectId, { title: 'T', acceptanceCriteria: ['x'], areas: ['api'] }),
  ).value.id;
  const app = createApp({
    onUnexpectedError: () => undefined,
    startedAt: new Date(),
    allowedOrigins: [],
    token: TOKEN,
    services: stubServices({
      pageActivity: (query) => pageActivity(store.db, query),
      pageInbox: (query) => pageInbox(store.db, query),
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

function post(key: string, task: TaskId | null): void {
  store.write((ctx) => {
    postNotice(ctx, {
      tier: CardTier.Notice,
      projectId,
      taskId: task,
      key,
      tone: 'info',
      line: `line ${key}`,
      body: '',
    });
  });
}

async function page(path: string): Promise<ActivityPageDto> {
  const res = await request(path);
  expect(res.status).toBe(200);
  return ActivityPageDto.parse(await res.json());
}

describe('GET /activity/page', () => {
  it('answers the posted notices newest first', async () => {
    post('a', null);
    post('b', taskId);
    const dto = await page('/activity/page');
    expect(dto.rows.map((r) => r.key)).toEqual(['b', 'a']);
    expect(dto.next).toBeNull();
  });

  it("answers only a task's notices for ?task", async () => {
    post('a', null);
    post('b', taskId);
    const dto = await page(`/activity/page?task=${taskId}`);
    expect(dto.rows.map((r) => r.key)).toEqual(['b']);
  });

  it.each([
    ['a project and a task together', () => `?project=${projectId}&task=${taskId}`],
    ['a page size over 100', () => '?pageSize=101'],
  ])('refuses %s with a 400', async (_name, query) => {
    expect((await request(`/activity/page${query()}`)).status).toBe(400);
  });

  it('does not move the open Inbox count', async () => {
    const total = async (): Promise<number> => {
      const res = await request('/inbox/page?state=open&pageSize=1');
      return ((await res.json()) as { total: number }).total;
    };
    const before = await total();
    post('a', taskId);
    expect(await total()).toBe(before);
  });
});
