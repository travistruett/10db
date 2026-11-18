import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  archivePreviewDto,
  chatDto,
  chatServer,
  type ChatServerOptions,
} from '../../test/chat-fixtures';
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

function open(count = 3, chatOptions: Omit<ChatServerOptions, 'chats'> = {}) {
  const chats = ['First', 'Second', 'Third']
    .slice(0, count)
    .map((title, i) => chatDto({ projectId: ampsio.id, title, tabPosition: i }));
  const chat = chatServer({ chats, ...chatOptions });
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

  describe('Archive asks before it deletes files that are saved nowhere else', () => {
    const lost = archivePreviewDto({
      uncommitted: ['src/a.ts', 'src/b.ts'],
      ignored: ['.env.local'],
    });
    const archiveFromMenu = async () => {
      await screen.findAllByRole('option');
      fireEvent.click(await screen.findByRole('button', { name: 'More session actions' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    };

    it('archives at once when nothing would be lost', async () => {
      const { chat, chats } = open();
      await archiveFromMenu();
      await waitFor(() => {
        expect(chat.archived).toEqual([chats[1]?.id]);
      });
      expect(chat.archiveBodies).toEqual([null]);
      expect(screen.queryByRole('dialog', { name: 'Archive this session?' })).toBeNull();
    });

    it('names the files, keeps the session until confirmed, and sends the lists it showed', async () => {
      const { chat, chats } = open(3, { archiveAsks: [lost] });
      await archiveFromMenu();
      const dialog = await screen.findByRole('dialog', { name: 'Archive this session?' });
      for (const path of [...lost.uncommitted, ...lost.ignored])
        expect(within(dialog).getByText(path)).toBeTruthy();
      expect(dialog.textContent).toContain('Your commits stay on the branch.');
      expect(chat.archived).toEqual([]);
      expect(rowNames()).toHaveLength(3);
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Archive and Delete These Files' }),
      );
      await waitFor(() => {
        expect(chat.archived).toEqual([chats[1]?.id]);
      });
      expect(chat.archiveBodies.at(-1)).toEqual({
        uncommitted: lost.uncommitted,
        ignored: lost.ignored,
      });
      await waitFor(() => {
        expect(rowNames()).toEqual(['First, ampsio', 'Third, ampsio']);
      });
    });

    it('a 409 that is not the files answer shows the daemon’s words, not a parse dump', async () => {
      const { chat } = open();
      server.use(
        http.post(daemonUrl('/chats/:chatId/archive'), () =>
          HttpResponse.json(
            { error: 'conflict', message: 'Wait for the move to finish.' },
            { status: 409 },
          ),
        ),
      );
      await archiveFromMenu();
      expect(await screen.findByText('Wait for the move to finish.')).toBeTruthy();
      expect(chat.archived).toEqual([]);
      expect(screen.queryByRole('dialog', { name: 'Archive this session?' })).toBeNull();
    });

    it('Cancel archives nothing', async () => {
      const { chat } = open(3, { archiveAsks: [lost] });
      await archiveFromMenu();
      const dialog = await screen.findByRole('dialog', { name: 'Archive this session?' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Archive this session?' })).toBeNull();
      });
      expect(chat.archived).toEqual([]);
      expect(rowNames()).toHaveLength(3);
    });

    it('asks again with the new lists when files appeared after the first answer', async () => {
      const later = archivePreviewDto({ uncommitted: ['src/a.ts', 'src/c.ts'], ignored: [] });
      const { chat } = open(3, { archiveAsks: [lost, later] });
      await archiveFromMenu();
      let dialog = await screen.findByRole('dialog', { name: 'Archive this session?' });
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Archive and Delete These Files' }),
      );
      await waitFor(() => {
        expect(screen.getByText('src/c.ts')).toBeTruthy();
      });
      expect(chat.archived).toEqual([]);
      dialog = screen.getByRole('dialog', { name: 'Archive this session?' });
      expect(within(dialog).queryByText('.env.local')).toBeNull();
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Archive and Delete These Files' }),
      );
      await waitFor(() => {
        expect(chat.archived).toHaveLength(1);
      });
      expect(chat.archiveBodies.at(-1)).toEqual({ uncommitted: later.uncommitted, ignored: [] });
    });
  });
});
