import { mintId, PASS_RETARGET_CHOICE, TaskId } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import {
  pagesByStatus,
  passCard,
  passNotice,
  passViewDto,
  taskMessageDto,
} from '../../test/pass-fixtures';
import { HeaderNotices } from './header-notices';

/** What the daemon was sent: Send to Agent by task and notice, card answers by card and body. */
function record() {
  const sent: { route: string; id: string; of: string; body?: unknown }[] = [];
  server.use(
    http.post(daemonUrl('/tasks/:taskId/thread/:messageId/send-to-agent'), ({ params }) => {
      const taskId = TaskId.parse(params['taskId']);
      // The daemon reads the id as Hono decodes it.
      const id = decodeURIComponent(String(params['messageId']));
      sent.push({ route: 'send', id, of: taskId });
      return HttpResponse.json(taskMessageDto(taskId), { status: 201 });
    }),
    http.post(daemonUrl('/inbox/:id/answer'), async ({ params, request }) => {
      sent.push({ route: 'answer', id: String(params['id']), of: '', body: await request.json() });
      return HttpResponse.json({});
    }),
    ...baseHandlers(),
  );
  return sent;
}

describe('HeaderNotices', () => {
  it('sends a sendable notice to the page the builder picks, and to no page before', async () => {
    const sent = record();
    const { ready, working } = pagesByStatus();
    const notice = passNotice({ id: 'finding:src/shared/form.tsx:12', kind: 'finding' });
    const view = passViewDto({ pages: [ready, working], rest: { notices: [notice] } });
    renderWithDaemon(<HeaderNotices view={view} inbox={[]} />);
    const shown = await screen.findByRole('listitem');
    expect(within(shown).getByText(notice.text)).toBeTruthy();
    fireEvent.click(within(shown).getByRole('button', { name: 'Send to Agent' }));
    const billing = await screen.findByRole('menuitem', { name: 'Billing', hidden: true });
    // Showing it, and asking which page, sends nothing.
    expect(sent).toEqual([]);
    fireEvent.click(billing);
    await waitFor(() => {
      expect(sent).toEqual([{ route: 'send', id: notice.id, of: working.taskId }]);
    });
    expect(await within(shown).findByText('Sent to Billing')).toBeTruthy();
  });

  it("announces the daemon's refusal of a Send to Agent", async () => {
    record();
    server.use(
      http.post(daemonUrl('/tasks/:taskId/thread/:messageId/send-to-agent'), () =>
        HttpResponse.json(
          { error: 'conflict', message: 'That notice offers nothing to send to the agent' },
          { status: 409 },
        ),
      ),
    );
    const { ready } = pagesByStatus();
    const view = passViewDto({ pages: [ready], rest: { notices: [passNotice()] } });
    renderWithDaemon(<HeaderNotices view={view} inbox={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Agent' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Settings', hidden: true }));
    expect(
      await within(await screen.findByRole('alert')).findByText(
        'That notice offers nothing to send to the agent',
      ),
    ).toBeTruthy();
  });

  it('offers no Send to Agent on a notice that is not sendable', async () => {
    record();
    const notice = passNotice({ id: 'pr-closed', kind: 'pr_closed', sendable: false });
    renderWithDaemon(
      <HeaderNotices view={passViewDto({ rest: { notices: [notice] } })} inbox={[]} />,
    );
    const shown = await screen.findByRole('listitem');
    expect(within(shown).queryByRole('button', { name: 'Send to Agent' })).toBeNull();
  });

  it("answers a stacked pass's Retarget card from its notice, naming the base", async () => {
    const sent = record();
    const view = passViewDto();
    const card = passCard(view, {
      kind: 'pass_retarget',
      passId: view.pass.id,
      stackedOn: mintId('Pass'),
      base: 'main',
    });
    const notice = passNotice({
      id: 'stack',
      kind: 'stack_unmerged',
      text: 'The pass this one was built on closed without merging.',
      sendable: false,
      cardId: card.id,
    });
    renderWithDaemon(<HeaderNotices view={{ ...view, notices: [notice] }} inbox={[card]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retarget to main' }));
    await waitFor(() => {
      expect(sent).toEqual([
        { route: 'answer', id: card.id, of: '', body: { choice: PASS_RETARGET_CHOICE } },
      ]);
    });
  });

  it.each([
    { state: 'OPEN', send: true, retarget: true },
    { state: 'CLOSING', send: false, retarget: false },
    { state: 'ABANDONING', send: false, retarget: false },
    // A closed pass's Retarget card is still the daemon's to take; its pages take no message.
    { state: 'CLOSED', send: false, retarget: true },
  ] as const)(
    'while the pass is $state, offers Send to Agent: $send, Retarget: $retarget',
    async ({ state, send, retarget }) => {
      record();
      const view = passViewDto({ pass: { state } });
      const card = passCard(view, {
        kind: 'pass_retarget',
        passId: view.pass.id,
        stackedOn: mintId('Pass'),
        base: 'main',
      });
      const notices = [
        passNotice(),
        passNotice({ id: 'stack', kind: 'stack_unmerged', sendable: false, cardId: card.id }),
      ];
      renderWithDaemon(<HeaderNotices view={{ ...view, notices }} inbox={[card]} />);
      expect(await screen.findByRole('button', { name: 'Send to Agent' })).toHaveProperty(
        'disabled',
        !send,
      );
      expect(screen.getByRole('button', { name: 'Retarget to main' })).toHaveProperty(
        'disabled',
        !retarget,
      );
    },
  );

  it('draws nothing while the pass has no notice', () => {
    record();
    renderWithDaemon(<HeaderNotices view={passViewDto()} inbox={[]} />);
    expect(screen.queryByRole('list', { name: 'Pass notices' })).toBeNull();
  });
});
