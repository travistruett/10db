import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatDto, chatServer } from '../../test/chat-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { closedTabs } from './closed-tabs';

// Close, Archive and Reopen: closing loses nothing, and ⌘⇧T restores the session and its draft.

const ampsio = projectViewDto({ name: 'ampsio' });

beforeEach(() => {
  localStorage.clear();
  closedTabs.reset();
});
afterEach(() => {
  localStorage.clear();
  closedTabs.reset();
});

function open(count = 3) {
  const chats = ['First', 'Second', 'Third']
    .slice(0, count)
    .map((title, i) => chatDto({ projectId: ampsio.id, title, tabPosition: i }));
  const chat = chatServer({ chats });
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([ampsio])),
    ...chat.handlers,
    ...baseHandlers(),
  );
  const app = renderApp(`/sessions?chat=${chats[1]?.id ?? chats[0]?.id ?? ''}`);
  return { chat, chats, ...app };
}

const press = (key: string, mods: { metaKey?: boolean; shiftKey?: boolean }) =>
  fireEvent.keyDown(document.body, { key, ...mods });
const rowNames = () => screen.queryAllByRole('option').map((t) => t.getAttribute('aria-label'));

describe('Sessions: close, archive and reopen', () => {
  it('closes a tab with a draft, and ⌘⇧T puts it back at its place with the draft', async () => {
    const { chat, chats } = open();
    const box = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'Half a thought' } });
    press('w', { metaKey: true });
    await waitFor(() => {
      expect(rowNames()).toEqual(['First, ampsio', 'Third, ampsio']);
    });
    press('T', { metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(rowNames()).toEqual(['First, ampsio', 'Second, ampsio', 'Third, ampsio']);
    });
    expect(chat.patches.at(-1)).toEqual({ chatId: chats[1]?.id, body: { tabPosition: 1 } });
    await waitFor(() => {
      expect(screen.getByDisplayValue('Half a thought')).toBeTruthy();
    });
  });

  it('Close from a row’s right-click menu closes that row and not the selected one', async () => {
    const { chat, chats } = open();
    await screen.findAllByRole('option');
    fireEvent.contextMenu(screen.getAllByRole('option')[2] ?? document.body);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close' }));
    await waitFor(() => {
      expect(rowNames()).toEqual(['First, ampsio', 'Second, ampsio']);
    });
    expect(chat.patches).toEqual([{ chatId: chats[2]?.id, body: { tabPosition: null } }]);
  });

  it('archives from the ⋯ menu, lists it under Recently closed, and Reopen unarchives it and brings it back', async () => {
    const { chat, chats } = open();
    await screen.findAllByRole('option');
    fireEvent.click(await screen.findByRole('button', { name: 'More session actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => {
      expect(rowNames()).toEqual(['First, ampsio', 'Third, ampsio']);
    });
    expect(chat.archived).toEqual([chats[1]?.id]);
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen Second' }));
    await waitFor(() => {
      expect(chat.unarchived).toEqual([chats[1]?.id]);
    });
    await waitFor(() => {
      expect(rowNames()).toContain('Second, ampsio');
    });
  });

  it('lists the last closed session under Recently closed with Reopen', async () => {
    const { chat, chats } = open();
    await screen.findAllByRole('option');
    press('w', { metaKey: true });
    await waitFor(() => {
      expect(rowNames()).toHaveLength(2);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen Second' }));
    await waitFor(() => {
      expect(rowNames()).toHaveLength(3);
    });
    expect(chat.patches.at(-1)?.chatId).toBe(chats[1]?.id);
  });
});
