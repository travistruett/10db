import { mintId, type ConversationId, type InboxItemDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemonAndRouter, server } from '../test/daemon';
import { inboxItemDto } from '../test/fixtures';
import { escapeIsTaken } from './escape';
import { PermissionRequest, useConversationCards } from './permission-request';

// Sessions UI spec §7.7: a conversation's card is the Inbox's, answered in place.

const conversationId: ConversationId = mintId('Conversation');

const options = [
  { label: 'allow_once', description: 'Allow this call once' },
  { label: 'allow_workstream', description: 'Allow for the rest of this session' },
  { label: 'deny', description: 'Deny; your note is passed to the agent' },
];

const card = (over: Partial<InboxItemDto> = {}): InboxItemDto =>
  inboxItemDto({
    kind: 'permission',
    title: 'Run a command',
    body: 'pnpm vitest run',
    category: 'access',
    options,
    detail: { conversationId },
    ...over,
  });

function Cards() {
  const items = useConversationCards(conversationId);
  return <PermissionRequest items={items} />;
}

function serve(items: InboxItemDto[]): { answers: { id: string; body: unknown }[] } {
  const answers: { id: string; body: unknown }[] = [];
  server.use(
    http.get(daemonUrl('/inbox'), () =>
      HttpResponse.json(items.filter((i) => !answers.some((a) => a.id === i.id))),
    ),
    http.post(daemonUrl('/inbox/:id/answer'), async ({ params, request }) => {
      answers.push({ id: String(params['id']), body: await request.json() });
      return HttpResponse.json({ ...items[0], state: 'ANSWERED' });
    }),
    ...baseHandlers(),
  );
  return { answers };
}

describe('PermissionRequest', () => {
  it('shows only this conversation’s card, as "Allow for this session" with its Inbox note', async () => {
    serve([
      card(),
      card({ title: 'Someone else’s', detail: { conversationId: mintId('Conversation') } }),
    ]);
    await renderWithDaemonAndRouter(<Cards />);
    const region = await screen.findByRole('region', { name: 'Waiting for your answer' });
    expect(within(region).getByRole('radio', { name: /Allow for this session/ })).toBeTruthy();
    expect(within(region).getByText('Also in your Inbox.')).toBeTruthy();
    expect(screen.queryByText('Someone else’s')).toBeNull();
  });

  it('pressing 2 then ⌘↩ answers through /inbox/:id/answer', async () => {
    const { answers } = serve([card()]);
    await renderWithDaemonAndRouter(<Cards />);
    const region = await screen.findByRole('region', { name: 'Waiting for your answer' });
    const root = region.querySelector('[data-waiting-card]');
    expect(root).not.toBeNull();
    if (root === null) return;
    fireEvent.keyDown(root, { key: '2' });
    fireEvent.keyDown(root, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(answers).toHaveLength(1);
    });
    expect(answers[0]?.body).toEqual({ choice: 'allow_workstream' });
  });

  it('takes Esc while focus is in its note', async () => {
    serve([card()]);
    await renderWithDaemonAndRouter(<Cards />);
    const note = await screen.findByRole('textbox', { name: /Note for the agent/ });
    note.focus();
    expect(escapeIsTaken(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
  });
});
