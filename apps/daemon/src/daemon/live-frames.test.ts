import {
  ChatDto,
  ConversationDeltaFrame,
  DaemonEvent,
  EventsHead,
  mintId,
  ProjectDto,
  ShapeId,
} from '@10db/contracts';
import { shapeConversation } from '@10db/db';
import { afterEach, beforeEach, expect, it, onTestFinished } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { apiClient } from '../../test/api-client';
import { createTempRepo, tempDir, waitFor } from '../../test/fixtures';
import { seedProfiles } from '../../test/seed-profiles';
import { createLiveFrames } from '../events';
import { devUiToken } from '../runtime-files';
import { FakeAdapter } from '../sessions';
import { startDaemon, type RunningDaemon } from './index';

const QUIET = { caffeinate: () => null, watch: false } as const;

let dir: ReturnType<typeof tempDir>;
let daemon: RunningDaemon | null = null;

beforeEach(() => {
  dir = tempDir('live-frames');
});

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  dir.cleanup();
});

async function connect(running: RunningDaemon, after: number, token = running.token) {
  const received: unknown[] = [];
  const client = new WebSocket(
    `ws://127.0.0.1:${String(running.port)}/events/stream?after=${String(after)}&token=${token}`,
  );
  client.on('message', (raw: Buffer) => received.push(JSON.parse(raw.toString('utf8'))));
  await new Promise<void>((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  return { client, received };
}

it('sends a live frame once the replay is live, and never replays one or counts it in the seq', async () => {
  const frames = createLiveFrames();
  daemon = await startDaemon({
    sandbox: null,
    dataDir: dir.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
    liveFrames: frames,
    ...QUIET,
  });
  const running = daemon;
  const first = await connect(running, 0);
  const head = EventsHead.parse(
    await (
      await fetch(`${running.url}/events/head`, {
        headers: { authorization: `Bearer ${running.token}` },
      })
    ).json(),
  ).seq;
  const frame = ConversationDeltaFrame.parse({
    live: true,
    type: 'conversation.delta',
    conversationId: mintId('Conversation'),
    itemId: mintId('ConversationItem'),
    kind: 'agent_message',
    offset: 0,
    text: 'Hel',
  });
  running.state.write((ctx) => {
    ctx.emit({ type: 'task.changed', entityType: 'task', entityId: 'tsk_x', data: {} });
  });
  frames.publish(frame);
  await waitFor(() => first.received.some((m) => (m as { live?: unknown }).live === true));
  const stored = first.received
    .filter((m) => (m as { live?: unknown }).live !== true)
    .map((m) => DaemonEvent.parse(m));
  const storedSeq = stored.at(-1)?.seq ?? 0;
  expect(storedSeq).toBe(head + 1);
  expect(first.received.filter((m) => (m as { live?: unknown }).live === true)).toEqual([frame]);
  first.client.close();

  const again = await connect(running, storedSeq);
  running.state.write((ctx) => {
    ctx.emit({ type: 'task.changed', entityType: 'task', entityId: 'tsk_y', data: {} });
  });
  await waitFor(() => again.received.length > 0);
  expect(again.received.map((m) => DaemonEvent.parse(m).seq)).toEqual([storedSeq + 1]);
  again.client.close();

  const headAfter = EventsHead.parse(
    await (
      await fetch(`${running.url}/events/head`, {
        headers: { authorization: `Bearer ${running.token}` },
      })
    ).json(),
  ).seq;
  expect(headAfter).toBe(storedSeq + 1);
});

it("sends the dev UI's socket a Plan's live words and never a chat's", async () => {
  const frames = createLiveFrames();
  const repo = createTempRepo();
  onTestFinished(() => {
    repo.cleanup();
  });
  daemon = await startDaemon({
    sandbox: null,
    dataDir: dir.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
    liveFrames: frames,
    devUiOrigin: 'http://localhost:1420',
    ...QUIET,
  });
  const running = daemon;
  seedProfiles(running.state);
  const api = apiClient(running.url, running.token);
  const project = await api.post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });
  const chat = await api.post('/chats', ChatDto, {
    projectId: project.id,
    model: null,
    tabPosition: 0,
  });
  const shape = await api.post(`/projects/${project.id}/shapes`, z.object({ id: ShapeId }), {
    title: 'Audit',
  });
  const plan = shapeConversation(running.state.db, shape.id).id;
  const ui = await connect(running, 0);
  const devUi = await connect(running, 0, devUiToken(dir.path));
  const delta = (conversationId: string) =>
    ConversationDeltaFrame.parse({
      live: true,
      type: 'conversation.delta',
      conversationId,
      itemId: mintId('ConversationItem'),
      kind: 'agent_message',
      offset: 0,
      text: 'Hel',
    });
  frames.publish(delta(chat.conversationId));
  frames.publish(delta(plan));
  // Frames and events reach a socket in the order they were sent, so one event after both frames
  // means any frame the socket would get has arrived.
  running.state.write((ctx) => {
    ctx.emit({ type: 'task.changed', entityType: 'task', entityId: 'tsk_last', data: {} });
  });
  const lastEvent = (m: unknown) => (m as { entityId?: unknown }).entityId === 'tsk_last';
  await waitFor(() => ui.received.some(lastEvent) && devUi.received.some(lastEvent));
  const liveTo = (received: unknown[]) =>
    received
      .filter((m) => (m as { live?: unknown }).live === true)
      .map((m) => ConversationDeltaFrame.parse(m).conversationId);
  expect(liveTo(ui.received)).toEqual([chat.conversationId, plan]);
  expect(liveTo(devUi.received)).toEqual([plan]);
  ui.client.close();
  devUi.client.close();
});
