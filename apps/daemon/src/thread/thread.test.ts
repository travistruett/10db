import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictError, mintId, TaskMessageDto, TaskThreadDto, type TaskId } from '@10db/contracts';
import {
  createTestStore,
  endPassTurn,
  getPassTurn,
  getTask,
  insertPass,
  insertPassTurn,
  insertTask,
  insertWorkstream,
  seedProject,
  settlePassTurn,
  type Store,
} from '@10db/db';
import { defineWebSocketHelper } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tempDir, type TempDir } from '../../test/fixtures';
import { jpegOfSize } from '../../test/jpeg';
import { pngOfSize } from '../../test/png';
import { webpImage } from '../../test/webp';
import { createApp, type ApiServices } from '../api';
import { createEventBus, createStateStore } from '../events';
import { createThreadService } from './index';

// Workbench spec §4.3, §11, §12, §13: a task's thread over HTTP. The builder's message and its pasted
// pictures are kept, each picture checked by its bytes and stored under the task's own directory in
// the data directory, and read back by id from that task only.

const TOKEN = 'ui';
const auth = { Authorization: `Bearer ${TOKEN}` };

let close: () => void;
let store: Store;
let data: TempDir;
let app: ReturnType<typeof createApp>;
let taskId: TaskId;
let otherTaskId: TaskId;
/** What the API answered 500 for; a test that expects one takes it out. */
let unexpected: unknown[];
/** How a message reaches a page of a pass, as the runner hands it. */
let deliver: Parameters<typeof createThreadService>[0]['pages']['deliver'];
beforeEach(() => {
  unexpected = [];
  const test = createTestStore();
  close = test.close;
  store = test.store;
  data = tempDir('thread');
  const project = seedProject(test.store, { name: 'alpha' });
  const task = (title: string) =>
    test.store.write((ctx) =>
      insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: ['ui'] }),
    ).value.id;
  taskId = task('Settings page');
  otherTaskId = task('Board page');
  // These tasks are in no pass, so no message is handed to a page unless a test puts one in one.
  deliver = () => Promise.reject(new Error('no page takes a message here'));
  const thread = createThreadService({
    state: createStateStore(test.store, createEventBus()),
    dataDir: data.path,
    pages: { deliver: (...a) => deliver(...a) },
  });
  app = createApp({
    startedAt: new Date(),
    allowedOrigins: [],
    token: TOKEN,
    // Only the thread's routes are reached; every other service is absent.
    services: thread as ApiServices,
    upgradeWebSocket: defineWebSocketHelper(() => undefined as never) as never,
    mcp: () => Promise.resolve(new Response()),
    onUnexpectedError: (error) => {
      unexpected.push(error);
    },
  });
});
afterEach(() => {
  expect(unexpected).toEqual([]);
  close();
  data.cleanup();
});

interface Picture {
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

function post(task: TaskId, text: string | null, pictures: readonly Picture[] = []) {
  const form = new FormData();
  if (text !== null) form.set('text', text);
  for (const p of pictures) form.append('picture', new File([p.bytes], p.name));
  return app.request(`/tasks/${task}/thread`, { method: 'POST', body: form, headers: auth });
}

const get = (path: string) => app.request(path, { headers: auth });
const filesDir = (task: TaskId) => join(data.path, 'tasks', task, 'files');
const PNG = new Uint8Array(pngOfSize(120, 80));

describe('a task thread over HTTP', () => {
  it('keeps a message with its picture, lists the thread oldest first and serves the picture back', async () => {
    const res = await post(taskId, 'Make the header smaller', [{ name: 'shot.png', bytes: PNG }]);
    expect(res.status).toBe(201);
    const first = TaskMessageDto.parse(await res.json());
    expect(first).toMatchObject({ body: 'Make the header smaller', author: 'builder' });
    expect(first.files).toEqual([
      expect.objectContaining({
        name: 'shot.png',
        mediaType: 'image/png',
        size: PNG.length,
        sha256: createHash('sha256').update(PNG).digest('hex'),
        messageId: first.id,
      }),
    ]);
    expect((await post(taskId, 'And the footer')).status).toBe(201);

    const thread = TaskThreadDto.parse(await (await get(`/tasks/${taskId}/thread`)).json());
    expect(thread.messages.map((m) => [m.body, m.files.length])).toEqual([
      ['Make the header smaller', 1],
      ['And the footer', 0],
    ]);

    const fileId = first.files[0]?.id ?? '';
    const picture = await get(`/tasks/${taskId}/thread/pictures/${fileId}`);
    expect(picture.status).toBe(200);
    expect(picture.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await picture.arrayBuffer())).toEqual(PNG);

    // Under the task's own directory, readable by the daemon's user alone, and no temporary left.
    expect(statSync(filesDir(taskId)).mode & 0o777).toBe(0o700);
    const kept = readdirSync(filesDir(taskId));
    expect(kept).toHaveLength(1);
    expect(statSync(join(filesDir(taskId), kept[0] ?? '')).mode & 0o777).toBe(0o600);
  });

  it('takes JPEG and WebP pictures, and a picture with no words', async () => {
    const res = await post(taskId, '', [
      { name: 'a.jpg', bytes: new Uint8Array(jpegOfSize(10, 10)) },
      { name: 'b.webp', bytes: new Uint8Array(webpImage('lossy', 10, 10)) },
    ]);
    expect(res.status).toBe(201);
    expect(TaskMessageDto.parse(await res.json()).files.map((f) => f.mediaType)).toEqual([
      'image/jpeg',
      'image/webp',
    ]);
  });

  const Refusal = z.object({ error: z.string(), message: z.string().optional() });
  it.each([
    ['an empty message', 'own', '   ', [], 400, 'words or a picture'],
    ['a message with no text part and no picture', 'own', null, [], 400, 'words or a picture'],
    [
      'a file that is no picture by its name',
      'own',
      'see this',
      [{ name: 'notes.txt', bytes: new TextEncoder().encode('hello') }],
      400,
      'PNG, JPEG or WebP',
    ],
    [
      'a PNG whose bytes are a JPEG',
      'own',
      'see this',
      [{ name: 'shot.png', bytes: new Uint8Array(jpegOfSize(10, 10)) }],
      400,
      "isn't really a PNG",
    ],
    [
      'a picture whose bytes are text',
      'own',
      'see this',
      [{ name: 'shot.webp', bytes: new TextEncoder().encode('not a picture at all') }],
      400,
      "isn't really a WebP",
    ],
    [
      'more pictures than a message carries',
      'own',
      'all of these',
      Array.from({ length: 11 }, (_, i) => ({ name: `${String(i)}.png`, bytes: PNG })),
      400,
      'at most 10 pictures',
    ],
    [
      'a picture whose name is longer than a name may be',
      'own',
      'see this',
      [{ name: `${'a'.repeat(252)}.png`, bytes: PNG }],
      400,
      "A picture's name is at most 255 characters",
    ],
    ['an unknown task', 'unknown', 'hello', [{ name: 'shot.png', bytes: PNG }], 404, 'not found'],
  ] satisfies [string, 'own' | 'unknown', string | null, Picture[], number, string][])(
    'refuses %s and keeps nothing',
    async (_, which, text, pictures, status, says) => {
      const task = which === 'own' ? taskId : mintId('Task');
      const res = await post(task, text, pictures);
      expect(res.status).toBe(status);
      expect(Refusal.parse(await res.json()).message).toContain(says);
      expect(existsSync(join(data.path, 'tasks'))).toBe(false);
      if (which === 'own')
        expect(
          TaskThreadDto.parse(await (await get(`/tasks/${taskId}/thread`)).json()).messages,
        ).toEqual([]);
    },
  );

  it('takes a picture whose name is as long as a name may be', async () => {
    const res = await post(taskId, 'see this', [{ name: `${'a'.repeat(251)}.png`, bytes: PNG }]);
    expect(res.status).toBe(201);
  });

  /** Every write to the database fails from now on, as it would on a full disk. */
  const refuseWrites = () => {
    store.db.$client.exec(
      "CREATE TRIGGER refuse_messages BEFORE INSERT ON task_messages BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
  };

  it('removes the pictures it kept when the write of their message fails', async () => {
    refuseWrites();
    const res = await post(taskId, 'see these', [
      { name: 'shot.png', bytes: PNG },
      { name: 'a.jpg', bytes: new Uint8Array(jpegOfSize(10, 10)) },
    ]);
    expect(res.status).toBe(500);
    expect(unexpected.splice(0)).toEqual([expect.objectContaining({ message: 'disk full' })]);
    expect(readdirSync(filesDir(taskId))).toEqual([]);
  });

  it('keeps a picture an earlier message holds when a later message of the same picture fails', async () => {
    const first = TaskMessageDto.parse(
      await (await post(taskId, 'one', [{ name: 'shot.png', bytes: PNG }])).json(),
    );
    expect((await post(taskId, 'two', [{ name: 'again.png', bytes: PNG }])).status).toBe(201);
    refuseWrites();
    expect((await post(taskId, 'three', [{ name: 'third.png', bytes: PNG }])).status).toBe(500);
    expect(unexpected.splice(0)).toEqual([expect.objectContaining({ message: 'disk full' })]);
    const picture = await get(`/tasks/${taskId}/thread/pictures/${first.files[0]?.id ?? ''}`);
    expect(picture.status).toBe(200);
    expect(new Uint8Array(await picture.arrayBuffer())).toEqual(PNG);
  });

  it('answers 404 for a picture whose file is gone', async () => {
    const posted = TaskMessageDto.parse(
      await (await post(taskId, 'mine', [{ name: 'shot.png', bytes: PNG }])).json(),
    );
    rmSync(filesDir(taskId), { recursive: true });
    const res = await get(`/tasks/${taskId}/thread/pictures/${posted.files[0]?.id ?? ''}`);
    expect(res.status).toBe(404);
  });

  it('serves a picture to its own task alone', async () => {
    const posted = TaskMessageDto.parse(
      await (await post(taskId, 'mine', [{ name: 'shot.png', bytes: PNG }])).json(),
    );
    const fileId = posted.files[0]?.id ?? '';
    expect((await get(`/tasks/${otherTaskId}/thread/pictures/${fileId}`)).status).toBe(404);
    expect((await get(`/tasks/${taskId}/thread/pictures/${mintId('TaskFile')}`)).status).toBe(404);
    expect((await get(`/tasks/${mintId('Task')}/thread`)).status).toBe(404);
  });
});

// Workbench spec §6.3, plan A4: a message a page refuses is not kept, whenever the refusal comes.
describe('a message to a page of a pass', () => {
  it('keeps nothing when the page leaves its pass as the message goes in, so a retry is one message', async () => {
    const ready = store.write((ctx) => {
      const task = getTask(ctx.tx, taskId);
      const { batch } = insertPass(ctx, {
        id: mintId('Pass'),
        projectId: task.projectId,
        name: 'Polish',
        pageCap: 4,
        returnBranch: 'main',
        startSha: 'a'.repeat(40),
        branch: '10db/polish-abc123',
        baseBranch: 'main',
        repo: null,
        taskIds: [taskId],
        dirt: [],
      });
      // The page is Ready: the builder's next word answers it.
      const run = insertWorkstream(ctx, taskId, {
        batchId: batch.id,
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
      const turn = insertPassTurn(ctx, {
        taskId,
        workstreamId: run.id,
        sessionId: null,
        messageId: null,
      });
      endPassTurn(ctx, turn.id, { ending: 'ready', replyBody: null });
      return settlePassTurn(ctx, turn.id);
    }).value;
    // A take-out finished while the message went in: the runner refuses to hand it over.
    deliver = () =>
      Promise.reject(new ConflictError('Settings page is no longer in a Workbench pass'));

    const res = await post(taskId, 'Make it bigger', [{ name: 'shot.png', bytes: PNG }]);

    expect(res.status).toBe(409);
    const thread = TaskThreadDto.parse(await (await get(`/tasks/${taskId}/thread`)).json());
    expect(thread.messages).toEqual([]);
    expect(readdirSync(filesDir(taskId))).toEqual([]);
    // Nothing answered the Ready page either.
    expect(getPassTurn(store.db, ready.id).answeredAt).toBeNull();
  });
});
