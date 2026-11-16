import type { ConversationDto } from '@10db/contracts';
import {
  mintId,
  type ConversationItemDto,
  type ConversationItemId,
  type LiveItemDto,
  type ToolCallView,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import {
  builderItem,
  conversationDto,
  replyItem,
  systemItem,
  toolItem,
} from '../../test/conversation-fixtures';
import { daemonEvent, projectViewDto } from '../../test/fixtures';
import { shapeDto, shapeViewDto } from '../../test/shape-fixtures';
import { commandCall } from '../../test/tool-call-fixtures';

// M4b Task 18 (sessions spec §6.5, UI spec §7.4, §7.5): Plan's transcript is its conversation's items,
// and a reply or a call streams in by live frames until the stored item replaces it, across a
// reconnect too. The daemon here is MSW playing the conversation routes and the event socket.

const project = projectViewDto();

type Client = Parameters<
  Parameters<typeof eventStream.addEventListener<'connection'>>[1]
>[0]['client'];

/** One Plan conversation as the daemon would serve it, with a socket the test speaks through. */
function planDaemon(
  opts: { readonly items?: readonly ConversationItemDto[]; readonly running?: boolean } = {},
) {
  const shape = shapeDto({ projectId: project.id });
  const view = shapeViewDto({
    shape,
    turn: {
      running: opts.running ?? false,
      queued: 0,
      proposing: false,
      rehearsing: false,
      waitingForUpdate: false,
    },
  });
  const id = view.conversationId;
  const world = {
    view,
    conversation: conversationDto({
      id,
      owner: { kind: 'shape', id: shape.id },
      state: opts.running === true ? 'running' : 'idle_warm',
    }),
    items: [...(opts.items ?? [builderItem(id, 'Make the board denser.')])],
    live: [] as LiveItemDto[],
    liveReads: 0,
    posted: [] as unknown[],
    sentNow: 0,
    clients: [] as Client[],
    seq: 0,
  };
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([shape])),
    http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(world.view)),
    http.get(daemonUrl('/conversations/:conversationId'), () =>
      HttpResponse.json(world.conversation),
    ),
    http.get(daemonUrl('/conversations/:conversationId/items'), () =>
      HttpResponse.json({ items: world.items, nextAfterSeq: null }),
    ),
    http.get(daemonUrl('/conversations/:conversationId/live'), () => {
      world.liveReads += 1;
      return HttpResponse.json({
        conversationId: id,
        items: world.live,
        waitingForFolder: false,
      });
    }),
    http.post(daemonUrl('/conversations/:conversationId/messages'), async ({ request }) => {
      const body: unknown = await request.json();
      world.posted.push(body);
      const text =
        typeof body === 'object' && body !== null && 'text' in body ? String(body.text) : '';
      const item = builderItem(id, text);
      world.items.push(item);
      return HttpResponse.json(item, { status: 202 });
    }),
    http.post(daemonUrl('/conversations/:conversationId/stop'), () => {
      world.conversation = { ...world.conversation, state: 'stopping' };
      return HttpResponse.json(world.conversation);
    }),
    http.post(daemonUrl('/conversations/:conversationId/send-now'), () => {
      world.sentNow += 1;
      world.items = world.items.map((item) =>
        item.kind === 'turn_marker' ? { ...item, resolvedAt: '2026-11-13T09:01:00.000Z' } : item,
      );
      world.conversation = { ...world.conversation, state: 'running', sendNow: false };
      return HttpResponse.json(world.conversation);
    }),
    eventStream.addEventListener('connection', ({ client }) => {
      world.clients.push(client);
    }),
    ...baseHandlers(),
  );
  const send = (data: unknown): void => {
    for (const client of world.clients) client.send(JSON.stringify(data));
  };
  return {
    world,
    open: () => renderApp(`/shape/${shape.id}`),
    frame(
      itemId: ConversationItemId,
      kind: 'agent_message' | 'tool_call',
      offset: number,
      part: { text?: string; view?: ToolCallView; output?: string },
    ) {
      send({
        live: true,
        type: 'conversation.delta',
        conversationId: id,
        itemId,
        kind,
        offset,
        ...(part.text === undefined ? {} : { text: part.text }),
        ...(kind === 'tool_call'
          ? {
              callPatch: {
                ...(part.view === undefined ? {} : { view: part.view }),
                ...(part.output === undefined ? {} : { output: part.output }),
              },
            }
          : {}),
      });
    },
    /** The daemon stored an item, or moved the conversation's state: the events it sends. */
    event(type: 'conversation.item_added' | 'conversation.state' | 'conversation.item_updated') {
      world.seq += 1;
      send(
        daemonEvent({ seq: world.seq, type, entityType: 'conversation', entityId: id, data: {} }),
      );
    },
    setState(state: ConversationDto['state']) {
      world.conversation = { ...world.conversation, state };
    },
    dropSocket() {
      const clients = world.clients;
      world.clients = [];
      for (const client of clients) client.close();
    },
  };
}

const conversation = (): HTMLElement => screen.getByRole('region', { name: 'Conversation' });
const messages = (): HTMLElement => screen.getByRole('group', { name: 'Messages' });

/** The socket is open and the live store holds its first read, so frames are applied, not dropped. */
async function streamReady(d: ReturnType<typeof planDaemon>): Promise<void> {
  await within(await screen.findByRole('region', { name: 'Conversation' })).findByText(
    'Make the board denser.',
  );
  await waitFor(() => {
    expect(d.world.clients.length).toBeGreaterThan(0);
    expect(d.world.liveReads).toBeGreaterThan(0);
  });
}

describe('Plan: a reply that streams', () => {
  it('shows the text as it streams, writing, then the stored reply in its place with no doubled text', async () => {
    const d = planDaemon({ running: true });
    d.open();
    await streamReady(d);
    const reply = mintId('ConversationItem');
    d.frame(reply, 'agent_message', 0, { text: 'Half ' });
    d.frame(reply, 'agent_message', 5, { text: 'a sentence.' });
    expect(await within(conversation()).findByText('Half a sentence.')).toBeTruthy();
    expect(within(conversation()).getByText('Writing…')).toBeTruthy();
    expect(messages().getAttribute('aria-busy')).toBe('true');

    d.world.items.push(replyItem(d.world.view.conversationId, 'Half a sentence.', { id: reply }));
    d.event('conversation.item_added');
    d.setState('idle_warm');
    d.event('conversation.state');
    await waitFor(() => {
      expect(messages().getAttribute('aria-busy')).toBe('false');
    });
    expect(within(conversation()).getAllByText('Half a sentence.')).toHaveLength(1);
    expect(within(conversation()).queryByText('Writing…')).toBeNull();
  });

  it('shows the same text after a reconnect mid-reply, read again from /live', async () => {
    const d = planDaemon({ running: true });
    d.open();
    await streamReady(d);
    const reply = mintId('ConversationItem');
    d.frame(reply, 'agent_message', 0, { text: 'Half ' });
    await within(conversation()).findByText('Half');
    // While the socket is down the daemon streamed more; /live holds it.
    d.world.live = [{ itemId: reply, kind: 'agent_message', text: 'Half a sen' }];
    const reads = d.world.liveReads;
    d.dropSocket();
    await waitFor(
      () => {
        expect(d.world.clients.length).toBe(1);
        expect(d.world.liveReads).toBeGreaterThan(reads);
      },
      { timeout: 15_000 },
    );
    expect(await within(conversation()).findByText('Half a sen')).toBeTruthy();
    d.frame(reply, 'agent_message', 10, { text: 'tence.' });
    expect(await within(conversation()).findByText('Half a sentence.')).toBeTruthy();
    expect(within(conversation()).getAllByText(/Half a sen/)).toHaveLength(1);
  });

  it('goes on appending a long command after a reconnect, with no reading again in a loop', async () => {
    const d = planDaemon({ running: true });
    d.open();
    await streamReady(d);
    const item = mintId('ConversationItem');
    const call = commandCall({
      status: 'running',
      command: 'pnpm test',
      title: 'pnpm test',
      outputTail: '',
    });
    d.frame(item, 'tool_call', 0, { view: call, output: 'x'.repeat(5_000) });
    const row = await within(conversation()).findByRole('button', { name: /Running pnpm test/ });
    const output = 'x'.repeat(10_000);
    d.world.live = [
      {
        itemId: item,
        kind: 'tool_call',
        call,
        output: output.slice(-4_096),
        outputOffset: 10_000 - 4_096,
      },
    ];
    const reads = d.world.liveReads;
    d.dropSocket();
    await waitFor(
      () => {
        expect(d.world.clients.length).toBe(1);
        expect(d.world.liveReads).toBe(reads + 1);
      },
      { timeout: 15_000 },
    );
    d.frame(item, 'tool_call', 10_000, { output: 'DONE' });
    fireEvent.click(row);
    expect(await within(conversation()).findByText(/xDONE/)).toBeTruthy();
    expect(d.world.liveReads).toBe(reads + 1);
  });

  it('shows a call the agent makes as a tool row', async () => {
    const d = planDaemon({ running: true });
    d.open();
    await streamReady(d);
    d.frame(mintId('ConversationItem'), 'tool_call', 0, {
      view: commandCall({ status: 'running', command: 'ls', title: 'ls' }),
    });
    expect(await within(conversation()).findByRole('button', { name: /Running ls/ })).toBeTruthy();
    expect(within(conversation()).getByText(/Working · \d+ s · running ls/)).toBeTruthy();
  });
});

describe('Plan: Stop, Send now and Allow This', () => {
  it('says Stopping… once Stop is pressed, and nothing once the turn has stopped', async () => {
    const d = planDaemon({ running: true });
    d.open();
    await streamReady(d);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await within(conversation()).findByText('Stopping…')).toBeTruthy();
    d.setState('idle_warm');
    d.event('conversation.state');
    await waitFor(() => {
      expect(within(conversation()).queryByText('Stopping…')).toBeNull();
    });
  });

  it('sends what waited under the Send now line after a restart, and the line goes', async () => {
    const d = planDaemon();
    d.world.items.push(
      systemItem(d.world.view.conversationId, {
        kind: 'turn_marker',
        marker: 'send_now',
        resolvedAt: null,
      }),
    );
    d.setState('idle_cold');
    d.open();
    await streamReady(d);
    fireEvent.click(await within(conversation()).findByRole('button', { name: 'Send Now' }));
    await waitFor(() => {
      expect(d.world.sentNow).toBe(1);
    });
    d.event('conversation.item_updated');
    await waitFor(() => {
      expect(within(conversation()).queryByRole('button', { name: 'Send Now' })).toBeNull();
    });
  });

  it.each([
    { soft: true, offered: true },
    { soft: false, offered: false },
  ])(
    'offers Allow This on a judge’s soft hold only (soft: $soft), sending the go-ahead once',
    async ({ soft, offered }) => {
      const conversationId = mintId('Conversation');
      const held = toolItem(
        conversationId,
        commandCall({
          title: 'curl https://example.com',
          command: 'curl https://example.com',
          status: 'denied',
          deniedBy: 'judge',
          limit: 'sends_data_out',
          soft,
        }),
      );
      const d = planDaemon({
        items: [builderItem(conversationId, 'Make the board denser.'), held],
      });
      d.open();
      await streamReady(d);
      const allow = within(conversation()).queryByRole('button', { name: 'Allow This' });
      expect(allow !== null).toBe(offered);
      if (allow === null) return;
      fireEvent.click(allow);
      await waitFor(() => {
        expect(d.world.posted).toEqual([{ text: 'Go ahead: curl https://example.com' }]);
      });
      expect(within(conversation()).queryByRole('button', { name: 'Allow This' })).toBeNull();
    },
  );
});
