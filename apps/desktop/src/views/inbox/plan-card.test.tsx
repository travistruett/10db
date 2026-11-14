import { mintId, type InboxItemDto, type WorkstreamId } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { inboxItemDto } from '../../test/fixtures';

const projectId = mintId('Project');
const workstreamId: WorkstreamId = mintId('Workstream');

const PLAN = '1. Put the greeting in src/api/a.txt.\n2. Cover the empty state.';

const card: InboxItemDto = inboxItemDto({
  kind: 'plan',
  projectId,
  title: 'Plan ready for you to approve: Write the greeting',
  body: `${PLAN}\n\nApprove to start the build, or send the plan back with a note.`,
  options: [
    { label: 'approve', description: 'Build to this plan' },
    { label: 'send_back', description: 'Plan it again with my note' },
  ],
  detail: { workstreamId },
  targets: [{ workstreamId, sessionId: null }],
});

/** Serves the card and records the answers posted for it. */
function serve(): unknown[] {
  const answers: unknown[] = [];
  server.use(
    http.get(daemonUrl('/inbox'), () => HttpResponse.json(answers.length === 0 ? [card] : [])),
    http.post(daemonUrl('/inbox/:id/answer'), async ({ request }) => {
      answers.push(await request.json());
      return HttpResponse.json({ ...card, state: 'ANSWERED' });
    }),
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
  );
  return answers;
}

describe('PlanCard', () => {
  it('shows the plan and its title', async () => {
    serve();
    renderApp('/inbox');
    expect(await screen.findByText(/Plan ready for you to approve/)).toBeTruthy();
    expect(screen.getByText(/Put the greeting in src\/api\/a\.txt/)).toBeTruthy();
    expect(screen.getByText(/Cover the empty state/)).toBeTruthy();
  });

  it('Approve sends approve', async () => {
    const answers = serve();
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(answers).toEqual([{ choice: 'approve' }]);
    });
  });

  it('Send Back needs a note, then sends it', async () => {
    const answers = serve();
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Send Back' }));
    const send = screen.getByRole('button', { name: 'Send It Back' });
    expect(send.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'What needs to change in the plan' }), {
      target: { value: '  Name the test file  ' },
    });
    expect(send.hasAttribute('disabled')).toBe(false);
    fireEvent.click(send);
    await waitFor(() => {
      expect(answers).toEqual([{ choice: 'send_back', note: 'Name the test file' }]);
    });
  });

  it('Cancel closes the note and returns focus to Send Back', async () => {
    serve();
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Send Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const sendBack = await screen.findByRole('button', { name: 'Send Back' });
    await waitFor(() => {
      expect(document.activeElement).toBe(sendBack);
    });
  });
});
