import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatDto, chatServer } from '../../test/chat-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { serveOpenRows } from '../../test/inbox-page-fixtures';
import { inboxItemDto, projectViewDto } from '../../test/fixtures';
import { closedTabs } from './closed-tabs';

// "Needs you" mirrors the Inbox: a tab, the sidebar's badge and the Inbox's card read the same cards.

const ampsio = projectViewDto({ name: 'ampsio' });

beforeEach(() => {
  localStorage.clear();
  closedTabs.reset();
});
afterEach(() => {
  localStorage.clear();
  closedTabs.reset();
});

const permissionFor = (conversationId: string) =>
  inboxItemDto({
    kind: 'permission',
    projectId: ampsio.id,
    title: 'Remove the builder’s task',
    body: 'remove_task',
    category: 'access',
    options: [
      { label: 'allow_once', description: 'Allow this call once' },
      { label: 'deny', description: 'Deny' },
    ],
    detail: { conversationId },
  });

describe('Sessions: needs you mirrors the Inbox', () => {
  it('rings the tab and counts it in the sidebar while a card is open, and answering in the tab clears both', async () => {
    const chat = chatDto({
      projectId: ampsio.id,
      title: 'Login fails',
      conversation: { state: 'waiting_card' },
    });
    let card = permissionFor(chat.conversationId);
    let open = true;
    const served = chatServer({ chats: [chat] });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([ampsio])),
      http.get(daemonUrl('/inbox'), () => HttpResponse.json(open ? [card] : [])),
      http.post(daemonUrl('/inbox/:id/answer'), () => {
        open = false;
        card = { ...card, state: 'ANSWERED' };
        return HttpResponse.json(card);
      }),
      ...served.handlers,
      ...baseHandlers(),
    );
    serveOpenRows(() => (open ? [card] : []));
    renderApp(`/sessions?chat=${chat.id}`);
    await waitFor(() => {
      expect(screen.getByRole('option').getAttribute('data-ring')).toBe('needs_you');
    });
    const sessions = screen.getAllByRole('link').find((l) => l.textContent.startsWith('Sessions'));
    expect(sessions?.textContent).toContain('1 session needs you');
    const region = await screen.findByRole('region', { name: 'Waiting for your answer' });
    fireEvent.click(within(region).getByRole('radio', { name: /Allow once/ }));
    fireEvent.click(within(region).getByRole('button', { name: 'Send answer' }));
    await waitFor(() => {
      expect(screen.getByRole('option').getAttribute('data-ring')).toBeNull();
    });
    await waitFor(() => {
      expect(
        screen.getAllByRole('link').find((l) => l.textContent.startsWith('Sessions'))?.textContent,
      ).toBe('Sessions');
    });
  });

  it('counts a chat stopped by an error in the badge with no Inbox card', async () => {
    const chat = chatDto({ projectId: ampsio.id, conversation: { state: 'ended_error' } });
    const served = chatServer({ chats: [chat] });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([ampsio])),
      ...served.handlers,
      ...baseHandlers(),
    );
    renderApp(`/sessions?chat=${chat.id}`);
    await waitFor(() => {
      expect(
        screen.getAllByRole('link').find((l) => l.textContent.startsWith('Sessions'))?.textContent,
      ).toContain('1 session needs you');
    });
  });

  it('the badge walks the sessions in the panel’s order, by project, as ⌘J does', async () => {
    const billing = projectViewDto({ name: 'billing' });
    const theirs = chatDto({
      projectId: billing.id,
      title: 'Theirs',
      tabPosition: 0,
      conversation: { state: 'ended_error' },
    });
    const mine = chatDto({
      projectId: ampsio.id,
      title: 'Mine',
      tabPosition: 1,
      conversation: { state: 'ended_error' },
    });
    const served = chatServer({ chats: [theirs, mine] });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([ampsio, billing])),
      ...served.handlers,
      ...baseHandlers(),
    );
    const { router } = renderApp('/inbox');
    fireEvent.click(await screen.findByText('2'));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/sessions');
    });
    expect(router.state.location.search).toMatchObject({ chat: mine.id });
  });

  it('shows Open Session on the Inbox card, which lands on the tab; for a closed tab it first reopens it at its place', async () => {
    const [first, second] = ['First', 'Second'].map((title, i) =>
      chatDto({ projectId: ampsio.id, title, tabPosition: i }),
    );
    if (first === undefined || second === undefined) throw new Error('fixture');
    const card = permissionFor(second.conversationId);
    const served = chatServer({ chats: [first, second], recent: [first, second] });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([ampsio])),
      http.get(daemonUrl('/inbox'), () => HttpResponse.json([card])),
      ...served.handlers,
      ...baseHandlers(),
    );
    serveOpenRows(() => [card]);
    // The second tab was closed at place 1 before the card arrived.
    closedTabs.push({ chatId: second.id, projectId: ampsio.id, title: 'Second', position: 1 });
    served.chats.splice(1, 1, chatDto({ ...second, tabPosition: null }));
    const { router } = renderApp('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Open Session' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/sessions');
    });
    expect(router.state.location.search).toMatchObject({ chat: second.id });
    expect(served.patches).toEqual([{ chatId: second.id, body: { tabPosition: 1 } }]);
    expect(await screen.findAllByRole('option')).toHaveLength(2);
  });
});
