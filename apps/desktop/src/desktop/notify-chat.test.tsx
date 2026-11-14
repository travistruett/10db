import type { DaemonEvent } from '@10db/contracts';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatKeys } from '../daemon/chat-queries';
import { chatDto, chatServer } from '../test/chat-fixtures';
import { replyItem } from '../test/conversation-fixtures';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../test/daemon';
import { daemonEvent, inboxItemDto, projectViewDto } from '../test/fixtures';
import { mockNative } from '../test/native-notifications';

// Sessions UI spec §5.7: a chat's card raises one notification, "{title} needs you", and a chat's reply
// raises "{title} replied" with its first line, both only while the window is not in front. A click on
// either opens the tab. The notification plugin is the native boundary and is mocked.

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const ampsio = projectViewDto({ name: 'ampsio' });

function open(chats: ReturnType<typeof chatDto>[], opts: { notifyReplies?: boolean } = {}) {
  const sockets: { send(data: string): void }[] = [];
  const served = chatServer({
    chats,
    items: Object.fromEntries(
      chats.map((c) => [
        c.conversationId,
        [replyItem(c.conversationId, '\nWorked it out.\nMore.')],
      ]),
    ),
  });
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([ampsio])),
    http.get(daemonUrl('/settings/sessions'), () =>
      HttpResponse.json({ notifyReplies: opts.notifyReplies ?? true }),
    ),
    ...served.handlers,
    ...baseHandlers(),
    eventStream.addEventListener('connection', ({ client }) => {
      sockets.push(client);
    }),
  );
  return { served, sockets };
}

const send = (
  sockets: { send(data: string): void }[],
  seq: number,
  type: DaemonEvent['type'],
  entityType: string,
  entityId: string,
) => {
  sockets[0]?.send(JSON.stringify(daemonEvent({ seq, type, entityType, entityId })));
};

describe('a chat’s notifications', () => {
  it('a chat’s new card sends exactly one notification, "{title} needs you", and its click opens the tab', async () => {
    const native = mockNative();
    const chat = chatDto({
      projectId: ampsio.id,
      title: 'Login fails',
      conversation: { state: 'waiting_card' },
    });
    const card = inboxItemDto({
      kind: 'permission',
      projectId: ampsio.id,
      title: 'Remove the builder’s task',
      detail: { conversationId: chat.conversationId },
      options: [
        { label: 'allow_once', description: '' },
        { label: 'deny', description: '' },
      ],
    });
    const { sockets } = open([chat]);
    server.use(http.get(daemonUrl('/inbox'), () => HttpResponse.json([card])));
    const { router } = renderApp('/factory');
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    send(sockets, 1, 'inbox.opened', 'inbox', card.id);
    await waitFor(() => {
      expect(native.sent).toHaveLength(1);
    });
    expect(native.sent[0]?.title).toBe('Login fails needs you');
    expect(native.sent[0]?.options.body).toBe('Remove the builder’s task');
    native.click(native.sent[0]?.options.id ?? -1);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/sessions');
    });
    expect(router.state.location.search).toMatchObject({ chat: chat.id });
    expect(native.sent).toHaveLength(1);
  });

  it('a reply, a chat going from running to idle, sends "{title} replied" with its first line', async () => {
    const native = mockNative();
    const chat = chatDto({
      projectId: ampsio.id,
      title: 'Login fails',
      conversation: { state: 'running' },
    });
    const { served, sockets } = open([chat]);
    const { queryClient } = renderApp('/factory');
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    // The first read of the open chats shows it running; the reply comes with the refetch.
    await waitFor(() => {
      expect(queryClient.getQueryData(chatKeys.open)).toHaveLength(1);
    });
    served.chats.splice(0, 1, chatDto({ ...chat, conversation: { state: 'idle_warm' } }));
    send(sockets, 1, 'chat.changed', 'chat', chat.id);
    await waitFor(() => {
      expect(native.sent).toHaveLength(1);
    });
    expect(native.sent[0]?.title).toBe('Login fails replied');
    expect(native.sent[0]?.options.body).toBe('Worked it out.');
  });

  it.each([
    { name: 'the window has focus', focused: true, notifyReplies: true },
    { name: 'the setting is off', focused: false, notifyReplies: false },
  ])('sends no reply notification when $name', async ({ focused, notifyReplies }) => {
    const native = mockNative();
    if (focused) vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const chat = chatDto({ projectId: ampsio.id, conversation: { state: 'running' } });
    const { served, sockets } = open([chat], { notifyReplies });
    const { queryClient } = renderApp('/factory');
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    await waitFor(() => {
      expect(queryClient.getQueryData(chatKeys.open)).toHaveLength(1);
    });
    served.chats.splice(0, 1, chatDto({ ...chat, conversation: { state: 'idle_cold' } }));
    send(sockets, 1, 'chat.changed', 'chat', chat.id);
    await waitFor(() => {
      expect(JSON.stringify(queryClient.getQueryData(chatKeys.open))).toContain('idle_cold');
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(native.sent).toEqual([]);
  });
});
