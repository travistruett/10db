import { mintId, PASS_RETARGET_CHOICE, PassCloseContinueDto, TaskId } from '@10db/contracts';
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
    // Sent once, it is not offered to send again.
    expect(within(shown).getByRole('button', { name: 'Send to Agent' })).toHaveProperty(
      'disabled',
      true,
    );
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
    { state: 'OPEN', send: 'enabled', retarget: true },
    // No page takes a message while the pass ends, so nothing offers to send one.
    { state: 'CLOSING', send: 'hidden', retarget: false },
    { state: 'ABANDONING', send: 'hidden', retarget: false },
    // A closed pass's Retarget card is still the daemon's to take; it holds no page to send to.
    { state: 'CLOSED', send: 'hidden', retarget: true },
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
      expect(await screen.findByRole('button', { name: 'Retarget to main' })).toHaveProperty(
        'disabled',
        !retarget,
      );
      const sendButton = screen.queryByRole('button', { name: 'Send to Agent' });
      if (send === 'hidden') expect(sendButton).toBeNull();
      else expect(sendButton).toHaveProperty('disabled', false);
    },
  );

  it('shows a long notice by its first line, and the rest, lines kept, behind Show More', async () => {
    record();
    const tail = 'FAIL src/form.test.ts\n  expected 2 to be 3\n    at form.test.ts:12';
    const notice = passNotice({
      id: 'gate',
      kind: 'gate_failed',
      text: `The gate on 1a2b3c4 failed.\n${tail}`,
    });
    renderWithDaemon(
      <HeaderNotices view={passViewDto({ rest: { notices: [notice] } })} inbox={[]} />,
    );
    const shown = await screen.findByRole('listitem');
    expect(within(shown).getByText('The gate on 1a2b3c4 failed.')).toBeTruthy();
    expect(within(shown).queryByText(/expected 2 to be 3/)).toBeNull();
    const toggle = within(shown).getByRole('button', { name: 'Show More' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const rest = within(shown).getByText(/expected 2 to be 3/);
    expect(toggle.getAttribute('aria-controls')).toBe(rest.id);
    expect(rest.textContent).toBe(tail);
    expect(rest.style.whiteSpace).toBe('pre-wrap');
    fireEvent.click(within(shown).getByRole('button', { name: 'Show Less' }));
    expect(within(shown).queryByText(/expected 2 to be 3/)).toBeNull();
  });

  it('offers no Show More on a notice of one line', async () => {
    record();
    renderWithDaemon(
      <HeaderNotices view={passViewDto({ rest: { notices: [passNotice()] } })} inbox={[]} />,
    );
    const shown = await screen.findByRole('listitem');
    expect(within(shown).queryByRole('button', { name: 'Show More' })).toBeNull();
  });

  /** A close that stopped, as its notice reads, while the pass is in `state`. */
  const stopped = (state: 'OPEN' | 'CLOSING' | 'CLOSED') => {
    const view = passViewDto({ pass: { state } });
    const notice = passNotice({
      id: 'close',
      kind: 'close',
      text: 'The close stopped: git failed. Close Pass goes on from where it stopped.',
      sendable: false,
    });
    return { view: { ...view, notices: [notice] }, notice };
  };

  it.each([
    { state: 'OPEN', offered: false },
    { state: 'CLOSING', offered: true },
    { state: 'CLOSED', offered: false },
  ] as const)(
    'offers Continue Close on a stopped close while the pass is $state: $offered',
    async ({ state, offered }) => {
      record();
      const { view } = stopped(state);
      renderWithDaemon(<HeaderNotices view={view} inbox={[]} />);
      await screen.findByRole('listitem');
      expect(screen.queryByRole('button', { name: 'Continue Close' }) !== null).toBe(offered);
    },
  );

  it('offers no Continue Close on any other notice of a closing pass', async () => {
    record();
    renderWithDaemon(
      <HeaderNotices
        view={passViewDto({ pass: { state: 'CLOSING' }, rest: { notices: [passNotice()] } })}
        inbox={[]}
      />,
    );
    await screen.findByRole('listitem');
    expect(screen.queryByRole('button', { name: 'Continue Close' })).toBeNull();
  });

  it("continues the close from where it stopped, and says the daemon's refusal", async () => {
    record();
    const posted: string[] = [];
    let status = 202;
    const { view } = stopped('CLOSING');
    server.use(
      http.post(daemonUrl('/passes/:passId/close/continue'), ({ params }) => {
        posted.push(String(params['passId']));
        return status === 202
          ? HttpResponse.json(PassCloseContinueDto.parse({ outcome: 'closing', pass: view.pass }), {
              status,
            })
          : HttpResponse.json(
              { error: 'conflict', message: 'The pass is not closing' },
              { status },
            );
      }),
    );
    renderWithDaemon(<HeaderNotices view={view} inbox={[]} />);
    const shown = await screen.findByRole('listitem');
    fireEvent.click(within(shown).getByRole('button', { name: 'Continue Close' }));
    await waitFor(() => {
      expect(posted).toEqual([view.pass.id]);
    });
    const again = within(shown).getByRole('button', { name: 'Continue Close' });
    await waitFor(() => {
      expect(again).toHaveProperty('disabled', false);
    });
    status = 409;
    fireEvent.click(again);
    expect(
      await within(await within(shown).findByRole('alert')).findByText('The pass is not closing'),
    ).toBeTruthy();
    expect(posted).toEqual([view.pass.id, view.pass.id]);
  });

  it('draws nothing while the pass has no notice', () => {
    record();
    renderWithDaemon(<HeaderNotices view={passViewDto()} inbox={[]} />);
    expect(screen.queryByRole('list', { name: 'Pass notices' })).toBeNull();
  });
});
