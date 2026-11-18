import { mintId, type ChatDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickOption } from '../../test/combobox';
import {
  chatDto,
  chatModelsDto,
  chatServer,
  type ChatServerOptions,
} from '../../test/chat-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { closedTabs } from './closed-tabs';

// Sessions' first screen: a fresh tab that starts a chat, and Recent and Start from beneath it.

const ampsio = projectViewDto({ name: 'ampsio' });
const billing = projectViewDto({ name: 'billing' });

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
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
      work: null,
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

  it('draws the panel on Sessions and takes it out on other views', async () => {
    const first = open('/sessions');
    expect(await screen.findByRole('navigation', { name: 'Sessions panel' })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    first.router.history.push('/factory');
    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: 'Sessions panel' })).toBeNull();
    });
    expect(document.querySelector('[data-title-row][data-tauri-drag-region]')).not.toBeNull();
    expect(mintId('Chat')).toMatch(/^cht_/);
  });
});

const rowNames = (): (string | null)[] =>
  screen.queryAllByRole('option').map((row) => row.getAttribute('aria-label'));

const chatIn = (
  project: typeof ampsio,
  title: string,
  tabPosition: number,
  more: Parameters<typeof chatDto>[0] = {},
): ChatDto => chatDto({ projectId: project.id, title, tabPosition, ...more });

describe('Sessions: the panel', () => {
  it('groups sessions by project in the project list’s order, each by its place, with a fresh row on top of its project', async () => {
    const chats = [
      chatIn(billing, 'Refund flow', 0),
      chatIn(ampsio, 'Second', 2),
      chatIn(ampsio, 'First', 1),
    ];
    const fresh = [{ id: 'abc', projectId: billing.id, model: null, effort: null, position: 9 }];
    localStorage.setItem('tendb.sessions.fresh', JSON.stringify(fresh));
    open(`/sessions?chat=${chats[2]?.id ?? ''}`, { chats });
    await screen.findByRole('option', { name: 'Refund flow, billing' });
    expect(rowNames()).toEqual([
      'First, ampsio',
      'Second, ampsio',
      'New session, billing',
      'Refund flow, billing',
    ]);
    const panel = screen.getByRole('navigation', { name: 'Sessions panel' });
    expect(within(panel).getByText('ampsio')).toBeTruthy();
    expect(within(panel).getByText('billing')).toBeTruthy();
    expect(
      screen.getByRole('option', { name: 'First, ampsio' }).getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('shows a running turn, a choice waiting and an error each as its own mark, never by colour alone', async () => {
    const chats = [
      chatIn(ampsio, 'Running', 0, { conversation: { state: 'running' } }),
      chatIn(ampsio, 'Choosing', 1, {
        work: { place: 'choosing', branch: null, base: null, worktree: null, askedAt: null },
      }),
      chatIn(ampsio, 'Broken', 2, { conversation: { state: 'ended_error' } }),
    ];
    open(`/sessions?chat=${chats[0]?.id ?? ''}`, { chats });
    const running = await screen.findByRole('option', { name: 'Running, ampsio, working' });
    expect(running.querySelector('[data-mark="working"]')).not.toBeNull();
    const choosing = screen.getByRole('option', {
      name: 'Choosing, ampsio, needs you: choose where it works',
    });
    expect(choosing.querySelector('[data-mark="needs_you"]')).not.toBeNull();
    expect(choosing.getAttribute('data-ring')).toBe('needs_you');
    const broken = screen.getByRole('option', { name: /^Broken, ampsio, needs you/ });
    expect(broken.querySelector('[data-mark="error"]')).not.toBeNull();
  });

  it('a row says where its session works: reading, here, on a branch', async () => {
    const work = (place: 'here' | 'branch') => ({
      place,
      branch: place === 'branch' ? 'fix-login' : null,
      base: null,
      worktree: null,
      askedAt: null,
    });
    const chats = [
      chatIn(ampsio, 'Reads', 0),
      chatIn(ampsio, 'Edits here', 1, { work: work('here') }),
      chatIn(ampsio, 'On a branch', 2, { work: work('branch') }),
    ];
    open(`/sessions?chat=${chats[0]?.id ?? ''}`, { chats });
    await screen.findByRole('option', { name: 'Reads, ampsio' });
    const places = screen.getAllByRole('option').map((row) => row.getAttribute('data-place'));
    expect(places).toEqual(['reading', 'here', 'branch']);
  });

  it('the ⌄ switcher lists open sessions by project, then New Session, and picks one', async () => {
    const chats = [chatIn(ampsio, 'First', 0), chatIn(billing, 'Refund flow', 1)];
    const { router } = open(`/sessions?chat=${chats[0]?.id ?? ''}`, { chats });
    fireEvent.click(await screen.findByRole('button', { name: 'Switch session' }));
    expect(
      (await screen.findAllByRole('menuitem', { hidden: true })).map((i) => i.textContent),
    ).toEqual(['First', 'Refund flow', 'New Session⌘T']);
    fireEvent.click((await screen.findAllByRole('menuitem', { hidden: true }))[1] ?? document.body);
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ chat: chats[1]?.id });
    });
  });

  it('search finds a session by title in any state, and keeps the old rows while the next search is read', async () => {
    const closedOne = chatIn(ampsio, 'Login flow', 0, { tabPosition: null });
    const chats = [chatIn(ampsio, 'Login fails', 0), closedOne, chatIn(ampsio, 'Invoices', 1)];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    open(`/sessions?chat=${chats[0]?.id ?? ''}`, { chats }, [
      http.get(daemonUrl('/chats/search'), async ({ request }) => {
        const q = new URL(request.url).searchParams.get('q') ?? '';
        calls.push(q);
        if (q === 'login fa') await held;
        return HttpResponse.json({
          rows: chats.filter((c) => c.title.toLowerCase().includes(q.toLowerCase())),
          next: null,
        });
      }),
    ]);
    const box = await screen.findByRole('textbox', { name: 'Search sessions' });
    fireEvent.change(box, { target: { value: 'login' } });
    const results = await screen.findByRole('list', { name: 'Search results' });
    await within(results).findByRole('button', { name: 'Login flow, ampsio, closed' });
    expect(within(results).getAllByRole('listitem')).toHaveLength(2);
    expect(within(results).getAllByRole('button')).toHaveLength(2);
    fireEvent.change(box, { target: { value: 'login fa' } });
    await waitFor(() => {
      expect(calls).toContain('login fa');
    });
    // The second read is held: the first one's rows are still drawn.
    expect(within(results).getAllByRole('button')).toHaveLength(2);
    release();
    await waitFor(() => {
      expect(within(results).getAllByRole('button')).toHaveLength(1);
    });
  });

  it('a closed session opened from search leaves Recently closed', async () => {
    const closedOne = chatIn(ampsio, 'Login flow', 0, { tabPosition: null });
    const chats = [chatIn(ampsio, 'Login fails', 0), closedOne];
    closedTabs.reset();
    closedTabs.push({
      chatId: closedOne.id,
      projectId: ampsio.id,
      title: closedOne.title,
      position: 1,
    });
    open(`/sessions?chat=${chats[0]?.id ?? ''}`, { chats }, [
      http.get(daemonUrl('/chats/search'), () =>
        HttpResponse.json({ rows: [closedOne], next: null }),
      ),
    ]);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search sessions' }), {
      target: { value: 'login flow' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Login flow, ampsio, closed' }));
    await waitFor(() => {
      expect(closedTabs.list()).toEqual([]);
    });
    closedTabs.reset();
  });

  it('puts one row in the Tab order, the selected one, and the arrow keys move between rows', async () => {
    const chats = [
      chatIn(ampsio, 'First', 0),
      chatIn(ampsio, 'Second', 1),
      chatIn(ampsio, 'Third', 2),
    ];
    open(`/sessions?chat=${chats[1]?.id ?? ''}`, { chats });
    await screen.findByRole('option', { name: /^Second/ });
    const rows = screen.getAllByRole('option');
    expect(rows.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    rows[1]?.focus();
    fireEvent.keyDown(rows[1] ?? document.body, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(rows[2] ?? document.body, { key: 'Home' });
    expect(document.activeElement).toBe(rows[0]);
  });

  it('scrolls the selected row into view when another row is selected', async () => {
    const scrolled = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(scrolled);
    const chats = [chatIn(ampsio, 'First', 0), chatIn(ampsio, 'Second', 1)];
    const { router } = open(`/sessions?chat=${chats[0]?.id ?? ''}`, { chats });
    await screen.findByRole('option', { name: /^First/ });
    scrolled.mockClear();
    const second = chats[1];
    if (second === undefined) throw new Error('fixture');
    await router.navigate({ to: '/sessions', search: { chat: second.id } });
    await waitFor(() => {
      expect(scrolled).toHaveBeenCalled();
    });
  });

  it('scrolls a virtual list to the selected row, which is not drawn yet', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(260);
    // jsdom lays nothing out: the list is given the height of its 1,001 rows to scroll within.
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(30_030);
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: scrollTo,
    });
    const chats = Array.from({ length: 1000 }, (_, i) => chatIn(ampsio, `Session ${String(i)}`, i));
    open(`/sessions?chat=${chats[700]?.id ?? ''}`, { chats });
    await screen.findByRole('option', { name: /^Session 0, ampsio/ });
    await waitFor(() => {
      const tops = scrollTo.mock.calls.map((call): unknown => call[0]);
      expect(
        tops.some((arg) => z.object({ top: z.number().gt(10_000) }).safeParse(arg).success),
      ).toBe(true);
    });
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  });

  it('dragging a row onto another moves it to that place', async () => {
    const chats = [
      chatIn(ampsio, 'First', 0),
      chatIn(ampsio, 'Second', 1),
      chatIn(ampsio, 'Third', 2),
    ];
    const { chat } = open(`/sessions?chat=${chats[0]?.id ?? ''}`, { chats });
    await screen.findByRole('option', { name: /^Third/ });
    // jsdom lays nothing out: each row is given a 30 px slot in the order it is drawn.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const index = [...document.querySelectorAll('[data-session-row]')].indexOf(this);
      const top = index < 0 ? 0 : index * 30;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 200,
        bottom: top + 30,
        width: 200,
        height: 30,
        toJSON: () => ({}),
      };
    });
    const rows = screen.getAllByRole('option');
    const third = rows[2];
    if (third === undefined) throw new Error('rows');
    fireEvent.pointerDown(third, {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 10,
      clientY: 75,
    });
    fireEvent.pointerMove(document, { isPrimary: true, pointerId: 1, clientX: 10, clientY: 40 });
    fireEvent.pointerMove(document, { isPrimary: true, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(document, { isPrimary: true, pointerId: 1, clientX: 10, clientY: 10 });
    await waitFor(() => {
      expect(chat.patches).toEqual([{ chatId: chats[2]?.id, body: { tabPosition: 0 } }]);
    });
  });

  it('draws fewer than 250 rows for 1,000 sessions', async () => {
    // jsdom does no layout: the panel is given a height to draw rows in.
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(260);
    const chats = Array.from({ length: 1000 }, (_, i) => chatIn(ampsio, `Session ${String(i)}`, i));
    open(`/sessions?chat=${chats[0]?.id ?? ''}`, { chats });
    await screen.findByRole('option', { name: /^Session 0, ampsio/ });
    expect(screen.getAllByRole('option').length).toBeLessThan(250);
  });
});

describe('Sessions: Make a Board Task… from a row of another project', () => {
  it('selects that row’s project before the Board opens, so the task is filed there', async () => {
    const mine = chatDto({ projectId: ampsio.id, title: 'Mine', tabPosition: 0 });
    const theirs = chatDto({ projectId: billing.id, title: 'Theirs', tabPosition: 1 });
    const { router } = open(`/sessions?chat=${mine.id}`, { chats: [mine, theirs] }, [
      http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([])),
    ]);
    await screen.findByRole('textbox', { name: 'Message' });
    const row = (await screen.findAllByRole('option')).find((o) =>
      o.getAttribute('aria-label')?.startsWith('Theirs'),
    );
    fireEvent.contextMenu(row ?? document.body);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make a Board Task…' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/board');
    });
    expect(JSON.parse(localStorage.getItem('tendb.project') ?? 'null')).toBe(billing.id);
  });
});
