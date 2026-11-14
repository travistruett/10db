import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { chatDto, chatServer, type ChatServerOptions } from '../../test/chat-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { inboxItemDto, projectViewDto } from '../../test/fixtures';

// Sessions' keys through the real shell and strip: ⌘T from anywhere, the rest only on Sessions.

const ampsio = projectViewDto({ name: 'ampsio' });

afterEach(() => {
  localStorage.clear();
});

function open(path: string, chats: ChatServerOptions, inbox: unknown[] = []) {
  const chat = chatServer(chats);
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([ampsio])),
    http.get(daemonUrl('/inbox'), () => HttpResponse.json(inbox)),
    ...chat.handlers,
    ...baseHandlers(),
  );
  return { chat, ...renderApp(path) };
}

const press = (key: string, mods: { metaKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean }) =>
  fireEvent.keyDown(document.body, { key, ...mods });

const three = () =>
  ['First', 'Second', 'Third'].map((title, i) =>
    chatDto({ projectId: ampsio.id, title, tabPosition: i }),
  );

describe('Sessions: the keyboard', () => {
  it('opens Sessions on a fresh tab with ⌘T from the Inbox', async () => {
    const { router } = open('/inbox', { chats: [] });
    await screen.findByRole('button', { name: 'Project: ampsio. Switch project' });
    press('t', { metaKey: true });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/sessions');
    });
    expect(router.state.location.search).toHaveProperty('fresh');
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeTruthy();
  });

  it('a first send in the tab ⌘T opened leaves that one tab, now a chat, and no second fresh tab', async () => {
    const { chat } = open('/inbox', { chats: [] });
    await screen.findByRole('button', { name: 'Project: ampsio. Switch project' });
    press('t', { metaKey: true });
    const box = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'First thought' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(chat.created).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getAllByRole('tab')).toHaveLength(1);
    });
  });

  it('leaves ⌘W, ⌘J and the digits to the page off Sessions', async () => {
    const { router } = open('/inbox', { chats: three() });
    await screen.findByRole('link', { name: 'Inbox' });
    for (const key of ['w', 'j', '2']) {
      const event = new KeyboardEvent('keydown', { key, metaKey: true, cancelable: true });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(router.state.location.pathname).toBe('/inbox');
  });

  it('goes to a tab by number, to the last with ⌘9, back with ⌘⇧[, and ⌘W closes the selected tab and moves right', async () => {
    const chats = three();
    const [first, second, third] = chats;
    const { chat, router } = open(`/sessions?chat=${first?.id ?? ''}`, { chats });
    await screen.findAllByRole('tab');
    press('2', { metaKey: true });
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ chat: second?.id });
    });
    press('9', { metaKey: true });
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ chat: third?.id });
    });
    press('{', { metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ chat: second?.id });
    });
    press('w', { metaKey: true });
    await waitFor(() => {
      expect(chat.patches).toEqual([{ chatId: second?.id, body: { tabPosition: null } }]);
    });
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ chat: third?.id });
    });
  });

  it('⌘J goes to the second tab that needs you, then the fourth, then the second again', async () => {
    const chats = ['A', 'B', 'C', 'D'].map((title, i) =>
      chatDto({
        projectId: ampsio.id,
        title,
        tabPosition: i,
        conversation: { state: i % 2 === 1 ? 'waiting_card' : 'idle_warm' },
      }),
    );
    const cards = [chats[1], chats[3]].map((c) =>
      inboxItemDto({ kind: 'permission', detail: { conversationId: c?.conversationId ?? '' } }),
    );
    const { router } = open(`/sessions?chat=${chats[0]?.id ?? ''}`, { chats }, cards);
    await waitFor(() => {
      expect(screen.getAllByRole('tab').filter((t) => t.dataset['ring'] === 'yellow')).toHaveLength(
        2,
      );
    });
    const want = [chats[1], chats[3], chats[1]];
    for (const chat of want) {
      press('j', { metaKey: true });
      await waitFor(() => {
        expect(router.state.location.search).toMatchObject({ chat: chat?.id });
      });
    }
  });
});
