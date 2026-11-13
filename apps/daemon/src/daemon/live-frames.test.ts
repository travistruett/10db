import { ConversationDeltaFrame, DaemonEvent, EventsHead, mintId } from '@10db/contracts';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { tempDir, waitFor } from '../../test/fixtures';
import { createLiveFrames } from '../events';
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

async function connect(running: RunningDaemon, after: number) {
  const received: unknown[] = [];
  const client = new WebSocket(
    `ws://127.0.0.1:${String(running.port)}/events/stream?after=${String(after)}&token=${running.token}`,
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
