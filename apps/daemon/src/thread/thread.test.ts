import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mintId, TaskMessageDto, TaskThreadDto, type TaskId } from '@10db/contracts';
import { createTestStore, insertTask, seedProject } from '@10db/db';
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
let data: TempDir;
let app: ReturnType<typeof createApp>;
let taskId: TaskId;
let otherTaskId: TaskId;
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  data = tempDir('thread');
  const project = seedProject(test.store, { name: 'alpha' });
  const task = (title: string) =>
    test.store.write((ctx) =>
      insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: ['ui'] }),
    ).value.id;
  taskId = task('Settings page');
  otherTaskId = task('Board page');
  const thread = createThreadService({
    state: createStateStore(test.store, createEventBus()),
    dataDir: data.path,
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
      throw error;
    },
  });
});
afterEach(() => {
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
