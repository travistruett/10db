import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { chatDto, chatServer, type ChatServerOptions } from '../../test/chat-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { inboxItemDto, projectViewDto } from '../../test/fixtures';
import { resetWindowWidth, windowWidth } from '../../test/window-width';

// The strip's anatomy: a tablist of pills, each saying its project, its title and one state.

const ampsio = projectViewDto({ name: 'ampsio' });
const billing = projectViewDto({ name: 'billing' });

afterEach(() => {
  localStorage.clear();
  resetWindowWidth();
});

function open(path: string, chats: ChatServerOptions, inbox: unknown[] = []) {
  const chat = chatServer(chats);
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([ampsio, billing])),
    http.get(daemonUrl('/inbox'), () => HttpResponse.json(inbox)),
    ...chat.handlers,
    ...baseHandlers(),
  );
  return { chat, ...renderApp(path) };
}

/** The tab at `index`; the test fails by name when there is none. */
function at(tabs: readonly HTMLElement[], index: number): HTMLElement {
  const tab = tabs[index];
  if (tab === undefined) throw new Error(`no tab at ${String(index)}`);
  return tab;
}

const named = (title: string, projectId = ampsio.id, position = 0, extra = {}) =>
  chatDto({ projectId, title, tabPosition: position, ...extra });

describe('Sessions: the tab strip', () => {
  it('draws a tablist of the open chats, each named by title, project and state, and the selected one controls the rendered panel', async () => {
    const a = named('Login fails', ampsio.id, 0);
    const b = named('Refund flow', billing.id, 1, { conversation: { state: 'running' } });
    const c = named('Invoice export', ampsio.id, 2);
    open(`/sessions?chat=${a.id}`, { chats: [a, b, c] });
    await screen.findAllByRole('tab');
    const list = screen.getByRole('tablist', { name: 'Sessions' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual([
      'Login fails, ampsio',
      'Refund flow, billing, working',
      'Invoice export, ampsio',
    ]);
    const selected = tabs[0];
    expect(selected?.getAttribute('aria-selected')).toBe('true');
    const panel = await screen.findByRole('tabpanel');
    expect(selected?.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(selected?.id);
  });

  it('shows only the tile and the state of an unselected tab at the compact width', async () => {
    windowWidth(800);
    const a = named('Login fails', ampsio.id, 0);
    const b = named('Refund flow', billing.id, 1);
    open(`/sessions?chat=${a.id}`, { chats: [a, b] });
    await screen.findAllByRole('tab');
    const tabs = screen.getAllByRole('tab');
    expect(within(at(tabs, 0)).queryByText('Login fails')).toBeTruthy();
    expect(within(at(tabs, 1)).queryByText('Refund flow')).toBeNull();
    expect(tabs[1]?.getAttribute('aria-label')).toBe('Refund flow, billing');
  });

  it('moves focus with the arrows, selects with Enter, and the address and the project follow', async () => {
    const a = named('Login fails', ampsio.id, 0);
    const b = named('Refund flow', billing.id, 1);
    const { router } = open(`/sessions?chat=${a.id}`, { chats: [a, b] });
    await screen.findAllByRole('tab');
    const [first, second] = [at(screen.getAllByRole('tab'), 0), at(screen.getAllByRole('tab'), 1)];
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(second);
    expect(router.state.location.search).toMatchObject({ chat: a.id });
    fireEvent.keyDown(second, { key: 'Enter' });
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ chat: b.id });
    });
    expect(JSON.parse(localStorage.getItem('tendb.project') ?? 'null')).toBe(billing.id);
  });

  it('closes the focused tab on Delete with PATCH tabPosition null, and moves to the tab on the right', async () => {
    const a = named('Login fails', ampsio.id, 0);
    const b = named('Refund flow', ampsio.id, 1);
    const { chat, router } = open(`/sessions?chat=${a.id}`, { chats: [a, b] });
    await screen.findAllByRole('tab');
    fireEvent.keyDown(at(screen.getAllByRole('tab'), 0), { key: 'Delete' });
    await waitFor(() => {
      expect(chat.patches).toEqual([{ chatId: a.id, body: { tabPosition: null } }]);
    });
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ chat: b.id });
    });
  });

  it('rings a tab whose conversation has an open card, and says so in its name', async () => {
    const a = named('Login fails', ampsio.id, 0, { conversation: { state: 'waiting_card' } });
    const card = inboxItemDto({
      kind: 'permission',
      title: 'Remove the builder’s task',
      detail: { conversationId: a.conversationId },
      options: [
        { label: 'Allow once', description: '' },
        { label: 'Deny', description: '' },
      ],
    });
    open(`/sessions?chat=${a.id}`, { chats: [a] }, [card]);
    await screen.findAllByRole('tab');
    await waitFor(() => {
      expect(screen.getByRole('tab').getAttribute('data-ring')).toBe('yellow');
    });
    expect(screen.getByRole('tab').getAttribute('aria-label')).toBe(
      'Login fails, ampsio, needs you: Remove the builder’s task',
    );
  });

  it('rings a tab stopped by an error red, with no card', async () => {
    const a = named('Login fails', ampsio.id, 0, { conversation: { state: 'ended_error' } });
    open(`/sessions?chat=${a.id}`, { chats: [a] });
    await screen.findAllByRole('tab');
    expect(screen.getByRole('tab').getAttribute('data-ring')).toBe('red');
  });

  it('counts, on All Tabs, the tabs scrolled out of the strip that need the builder', async () => {
    const chats = Array.from({ length: 12 }, (_, i) =>
      named(`Session ${String(i)}`, ampsio.id, i, {
        conversation: { state: i === 5 || i === 9 || i === 1 ? 'ended_error' : 'idle_warm' },
      }),
    );
    open(`/sessions?chat=${chats[0]?.id ?? ''}`, { chats });
    await screen.findAllByRole('tab');
    const list = screen.getByRole('tablist', { name: 'Sessions' });
    // jsdom does no layout: each tab is 100 px wide and the strip shows the first three.
    const index = (el: HTMLElement): number =>
      chats.findIndex((c) => `chat:${c.id}` === el.dataset['sessionTab']);
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
      configurable: true,
      get(this: HTMLElement) {
        return index(this) * 100;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset['sessionTab'] === undefined ? 0 : 100;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('role') === 'tablist' ? 300 : 0;
      },
    });
    try {
      fireEvent.scroll(list);
      const button = await screen.findByRole('button', { name: 'All Tabs, 2 hidden need you' });
      expect(button.textContent).toBe('2');
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetLeft');
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
      Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    }
  });
});
