import { FolderHolderKind, mintId } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { pickOption } from '../../test/combobox';
import {
  chatDto,
  chatModelsDto,
  chatServer,
  type ChatServerOptions,
} from '../../test/chat-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { folderKeys } from '../../daemon/project-folder-queries';
import { folderDto, folderHolder } from '../../test/folder-fixtures';
import { projectViewDto } from '../../test/fixtures';

// Sessions' first screen: a fresh tab that starts a chat, and Recent and Start from beneath it.

const ampsio = projectViewDto({ name: 'ampsio' });
const billing = projectViewDto({ name: 'billing' });

afterEach(() => {
  localStorage.clear();
});

function open(
  path: string,
  chats: ChatServerOptions = {},
  extra: Parameters<typeof server.use> = [],
) {
  const chat = chatServer(chats);
  server.use(
    ...extra,
    http.get(daemonUrl('/projects'), () => HttpResponse.json([ampsio, billing])),
    ...chat.handlers,
    ...baseHandlers(),
  );
  const app = renderApp(path);
  return { chat, ...app };
}

const composer = (): HTMLElement => screen.getByRole('textbox', { name: 'Message' });
const type = (text: string) => {
  fireEvent.change(composer(), { target: { value: text } });
};
const send = () => {
  fireEvent.keyDown(composer(), { key: 'Enter', metaKey: true });
};

describe('Sessions: a fresh tab', () => {
  it('opens on a fresh tab with its words and a composer, never a blank page', async () => {
    open('/sessions');
    expect(
      await screen.findByText(/A chat reads ampsio, runs commands and searches the web\./),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Uses ampsio's account\. Reads the code, runs commands and searches the web\. Asks before anything that crosses a limit\./,
      ),
    ).toBeTruthy();
    expect(composer().getAttribute('placeholder')).toBe('Ask about ampsio…');
    expect(screen.getByText('↵ sends · ⇧↵ new line · @ files')).toBeTruthy();
  });

  it('on an agent that cannot search the web never says the chat does', async () => {
    open('/sessions', { models: chatModelsDto({ webSearch: false }) });
    expect(await screen.findByText(/A chat reads ampsio and runs commands\./)).toBeTruthy();
    expect(screen.queryByText(/searches the web/)).toBeNull();
  });

  it('lists Sessions third in the sidebar, after Inbox and Factory, with no badge', async () => {
    open('/sessions');
    await screen.findByRole('textbox', { name: 'Message' });
    const nav = screen.getAllByRole('link').map((link) => link.textContent);
    const top = nav.filter((name) => ['Inbox', 'Factory', 'Sessions'].includes(name));
    expect(top).toEqual(['Inbox', 'Factory', 'Sessions']);
    const link = screen.getAllByRole('link').find((l) => l.textContent === 'Sessions');
    expect(link?.querySelector('.mantine-Badge-root')).toBeNull();
  });

  it('lists the daemon’s Start from lines with their icons and no dismiss; a click fills the composer and posts nothing', async () => {
    const { chat } = open('/sessions', {
      starts: [
        { kind: 'failed_task', text: 'Why did “Retry export” fail?' },
        { kind: 'base_commits', text: 'What changed on main since yesterday?' },
        { kind: 'recent_area', text: 'How does billing/export work?' },
      ],
    });
    const region = await screen.findByRole('region', { name: 'Start from' });
    const buttons = within(region).getAllByRole('button');
    expect(buttons).toHaveLength(3);
    expect(buttons.map((b) => b.querySelector('svg')?.getAttribute('class') ?? '')).toEqual([
      expect.stringContaining('tabler-icon-alert-circle'),
      expect.stringContaining('tabler-icon-git-commit'),
      expect.stringContaining('tabler-icon-folder'),
    ]);
    expect(within(region).queryByRole('button', { name: /dismiss|close/i })).toBeNull();
    fireEvent.click(buttons[1] ?? region);
    expect((composer() as HTMLTextAreaElement).value).toBe('What changed on main since yesterday?');
    expect(chat.created).toHaveLength(0);
    expect(chat.messages).toHaveLength(0);
  });

  it('lists the project’s recent sessions, and a click opens one in this tab', async () => {
    const earlier = chatDto({
      projectId: ampsio.id,
      title: 'Invoice export',
      tabPosition: null,
      tasksFiled: 2,
    });
    const { router } = open('/sessions', { recent: [earlier], chats: [earlier] });
    const region = await screen.findByRole('region', { name: 'Recent' });
    expect(within(region).getByText('Invoice export')).toBeTruthy();
    expect(within(region).getByText(/Chat · .* · 2 tasks filed/)).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: /Invoice export/ }));
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ chat: earlier.id });
    });
  });

  it('changing the project re-reads Recent and Start from for it, and selects it', async () => {
    const recentOfBilling = chatDto({
      projectId: billing.id,
      title: 'Refund flow',
      tabPosition: null,
    });
    const startsSeen: string[] = [];
    open('/sessions', { recent: [recentOfBilling], chats: [recentOfBilling] }, [
      http.get(daemonUrl('/projects/:projectId/session-starts'), ({ params }) => {
        startsSeen.push(String(params['projectId']));
        return HttpResponse.json([]);
      }),
    ]);
    await screen.findByRole('textbox', { name: 'Message' });
    expect(screen.queryByText('Refund flow')).toBeNull();
    await pickOption(screen.getByRole('combobox', { name: 'Project' }), /billing/);
    expect(await screen.findByText('Refund flow')).toBeTruthy();
    expect(startsSeen).toContain(billing.id);
    expect(localStorage.getItem('tendb.project')).toContain(billing.id);
    expect(composer().getAttribute('placeholder')).toBe('Ask about billing…');
  });

  it('the first send makes one chat, opens it, and posts the message to its conversation; a failed post goes again to the same one', async () => {
    const { chat, router } = open('/sessions', {}, [
      http.post(daemonUrl('/conversations/:conversationId/messages'), () =>
        HttpResponse.json(
          { error: 'failed', message: 'The daemon could not take it.' },
          { status: 500 },
        ),
      ),
    ]);
    await screen.findByRole('textbox', { name: 'Message' });
    type('Why does login fail?');
    send();
    await waitFor(() => {
      expect(JSON.stringify(router.state.location.search)).toMatch(/"chat":"cht_/);
    });
    expect(chat.created).toHaveLength(1);
    expect(await screen.findByText('The daemon could not take it.')).toBeTruthy();
    expect((composer() as HTMLTextAreaElement).value).toBe('Why does login fail?');

    // The daemon takes it this time.
    server.use(...chat.handlers);
    send();
    await waitFor(() => {
      expect(chat.messages).toHaveLength(1);
    });
    expect(chat.created).toHaveLength(1);
    expect(chat.messages[0]).toMatchObject({
      conversationId: chat.chats[0]?.conversationId,
      body: { text: 'Why does login fail?' },
    });
  });

  it.each([
    { button: 'Wait for It', folder: 'wait' },
    { button: 'Send Reading Only', folder: 'read_only' },
  ])(
    'with Your folder held, the first message makes and posts nothing until a choice: $button sends folder $folder',
    async ({ button, folder }) => {
      const { chat, queryClient } = open('/sessions', {}, [
        http.get(daemonUrl('/projects/:projectId/folder'), () =>
          HttpResponse.json(
            folderDto({
              projectId: ampsio.id,
              holders: [folderHolder(FolderHolderKind.Lane, 'Bump vite')],
            }),
          ),
        ),
      ]);
      await screen.findByRole('textbox', { name: 'Message' });
      await waitFor(() => {
        expect(queryClient.getQueryData(folderKeys.of(ampsio.id))).toBeDefined();
      });
      type('Why does login fail?');
      send();
      expect(
        await screen.findByText('Your folder is in use by the task ‘Bump vite’.'),
      ).toBeTruthy();
      expect(chat.created).toHaveLength(0);
      expect(chat.messages).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'File as Tasks' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: button }));
      await waitFor(() => {
        expect(chat.messages).toHaveLength(1);
      });
      expect(chat.created).toHaveLength(1);
      expect(chat.messages[0]?.body).toEqual({ text: 'Why does login fail?', folder });
    },
  );

  it('a first @ makes the chat before any send, then lists the files of its conversation', async () => {
    const { chat, router } = open('/sessions', {
      files: [{ path: 'src/login.ts', matches: [[4, 9]] }],
    });
    await screen.findByRole('textbox', { name: 'Message' });
    type('look at @');
    await waitFor(() => {
      expect(JSON.stringify(router.state.location.search)).toMatch(/"chat":"cht_/);
    });
    expect(chat.created).toHaveLength(1);
    expect(chat.messages).toHaveLength(0);
    expect((composer() as HTMLTextAreaElement).value).toBe('look at @');
    // The chat's composer takes over the words; the next key lists the files of its conversation.
    type('look at @log');
    expect(await screen.findByRole('option', { name: /login\.ts/, hidden: true })).toBeTruthy();
    expect(chat.fileQueries).toEqual([{ conversationId: chat.chats[0]?.conversationId, q: 'log' }]);
    expect(screen.queryByRole('combobox', { name: 'Project' })).toBeNull();
  });

  it('shows a refused create beside Send and makes nothing', async () => {
    const { chat } = open('/sessions', {
      createRefusal: 'The project is gone.',
    });
    await screen.findByRole('textbox', { name: 'Message' });
    type('hello');
    send();
    expect(await screen.findByText('The project is gone.')).toBeTruthy();
    expect(chat.chats).toHaveLength(0);
  });

  it('puts the strip in the header on Sessions and leaves other views’ header as it was', async () => {
    const first = open('/sessions');
    expect(await screen.findByRole('tablist', { name: 'Sessions' })).toBeTruthy();
    expect(document.querySelector('header [data-header-slot] [role="tablist"]')).not.toBeNull();
    first.router.history.push('/factory');
    await waitFor(() => {
      expect(screen.queryByRole('tablist', { name: 'Sessions' })).toBeNull();
    });
    expect(document.querySelector('header[data-tauri-drag-region]')).not.toBeNull();
    expect(mintId('Chat')).toMatch(/^cht_/);
  });
});
