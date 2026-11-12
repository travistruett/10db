import { mintId, type InboxItemDto, type ShapeViewDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { inboxItemDto, projectViewDto } from '../../test/fixtures';
import { shapeDto, shapeMessageDto, shapeViewDto } from '../../test/shape-fixtures';

// A Plan turn that waits on a permission card shows the card in the conversation, and answering it
// there resolves the same Inbox card.

const project = projectViewDto();
const base = shapeDto({ projectId: project.id, state: 'listening' });
const view: ShapeViewDto = shapeViewDto({
  shape: base,
  messages: [
    shapeMessageDto(base.id),
    shapeMessageDto(base.id, {
      author: 'claude',
      kind: 'tool',
      body: 'Allow Bash? · waiting for your answer in the Inbox',
    }),
  ],
  turn: {
    running: true,
    queued: 0,
    proposing: false,
    rehearsing: false,
    waitingForUpdate: false,
  },
});

const options = [
  { label: 'allow_once', description: 'Allow this call once' },
  { label: 'allow_project', description: 'Always allow in this project (records a decision)' },
  { label: 'deny', description: 'Deny; your note is passed to the agent' },
];

function card(overrides: Partial<InboxItemDto> = {}, owner = base.id): InboxItemDto {
  return inboxItemDto({
    kind: 'permission',
    projectId: project.id,
    title: 'Allow Bash?',
    body: 'curl -s https://example.com',
    category: 'access',
    options,
    detail: { shapeId: owner },
    ...overrides,
  });
}

/** Serves the conversation and these open cards; an answered card leaves the list. */
function serve(items: InboxItemDto[]): {
  answers: { id: string; body: unknown }[];
  /** Closes a card as the Inbox would, without an answer from the conversation. */
  closeElsewhere: (id: string) => void;
} {
  const answers: { id: string; body: unknown }[] = [];
  const closed = new Set<string>();
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([base])),
    http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(view)),
    http.get(daemonUrl('/inbox'), () =>
      HttpResponse.json(
        items.filter((i) => !answers.some((a) => a.id === i.id) && !closed.has(i.id)),
      ),
    ),
    http.post(daemonUrl('/inbox/:id/answer'), async ({ params, request }) => {
      const id = String(params['id']);
      answers.push({ id, body: await request.json() });
      return HttpResponse.json({ ...items.find((i) => i.id === id), state: 'ANSWERED' });
    }),
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
  );
  return {
    answers,
    closeElsewhere: (id) => {
      closed.add(id);
    },
  };
}

const waiting = (): HTMLElement => screen.getByRole('region', { name: 'Waiting for your answer' });

describe('A permission card in the conversation', () => {
  it('shows the call and its options where the turn waits', async () => {
    serve([card()]);
    renderApp(`/shape/${base.id}`);

    const region = await screen.findByRole('region', { name: 'Waiting for your answer' });
    expect(within(region).getByText('Allow Bash?')).toBeTruthy();
    expect(within(region).getByText('curl -s https://example.com')).toBeTruthy();
    for (const name of ['Allow once', 'Always allow in this project', 'Deny']) {
      expect(within(region).getByRole('radio', { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
    expect(within(region).getByRole('textbox', { name: /Note for the agent/ })).toBeTruthy();
  });

  it('sends the chosen value, as the Inbox does, and the card leaves', async () => {
    const { answers } = serve([card()]);
    renderApp(`/shape/${base.id}`);

    fireEvent.click(await screen.findByRole('radio', { name: /^Always allow in this project/ }));
    fireEvent.click(within(waiting()).getByRole('button', { name: 'Send answer' }));
    await waitFor(() => {
      expect(answers).toHaveLength(1);
    });
    expect(answers[0]?.body).toEqual({ choice: 'allow_project' });
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Waiting for your answer' })).toBeNull();
    });
  });

  it('sends a Deny with its note', async () => {
    const { answers } = serve([card()]);
    renderApp(`/shape/${base.id}`);

    fireEvent.click(await screen.findByRole('radio', { name: /^Deny/ }));
    fireEvent.change(within(waiting()).getByRole('textbox', { name: /Note for the agent/ }), {
      target: { value: '  not on the network  ' },
    });
    fireEvent.click(within(waiting()).getByRole('button', { name: 'Send answer' }));
    await waitFor(() => {
      expect(answers).toHaveLength(1);
    });
    expect(answers[0]?.body).toEqual({ choice: 'deny', note: 'not on the network' });
  });

  it('can be answered from the keyboard: the options are radios and ⌘↩ in the note sends', async () => {
    const { answers } = serve([card()]);
    renderApp(`/shape/${base.id}`);

    const once = await screen.findByRole('radio', { name: /^Allow once/ });
    once.focus();
    expect(document.activeElement).toBe(once);
    fireEvent.click(once);
    const note = within(waiting()).getByRole('textbox', { name: /Note for the agent/ });
    fireEvent.keyDown(note, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(answers).toEqual([
        { id: expect.any(String) as string, body: { choice: 'allow_once' } },
      ]);
    });
  });

  it('asks for a choice before it sends', async () => {
    const { answers } = serve([card()]);
    renderApp(`/shape/${base.id}`);

    await screen.findByRole('region', { name: 'Waiting for your answer' });
    fireEvent.click(within(waiting()).getByRole('button', { name: 'Send answer' }));
    expect(await screen.findByText('Choose an option first.')).toBeTruthy();
    expect(answers).toEqual([]);
  });

  it('shows card text as plain text', async () => {
    serve([card({ title: 'Allow <b>Bash</b>?', body: '<img src=x onerror=alert(1)>' })]);
    renderApp(`/shape/${base.id}`);

    const region = await screen.findByRole('region', { name: 'Waiting for your answer' });
    expect(within(region).getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(within(region).getByText('Allow <b>Bash</b>?')).toBeTruthy();
    expect(region.querySelector('img, b')).toBeNull();
  });

  it('stops offering its options once the Inbox has closed the card', async () => {
    const item = card();
    const { closeElsewhere } = serve([item]);
    const { queryClient } = renderApp(`/shape/${base.id}`);

    await screen.findByRole('region', { name: 'Waiting for your answer' });
    closeElsewhere(item.id);
    await queryClient.invalidateQueries({ queryKey: ['inbox'] });
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Waiting for your answer' })).toBeNull();
    });
    expect(screen.queryByRole('radio', { name: /^Allow once/ })).toBeNull();
  });

  it('shows no card another conversation or another kind of card owns', async () => {
    serve([
      card({}, mintId('Shape')),
      card({ kind: 'question', title: 'Which greeting?' }),
      card({ detail: null, title: 'A lane asked' }),
    ]);
    renderApp(`/shape/${base.id}`);

    await screen.findByRole('textbox', { name: 'Message' });
    await waitFor(() => {
      expect(screen.getByText(/waiting for your answer in the Inbox/)).toBeTruthy();
    });
    expect(screen.queryByRole('region', { name: 'Waiting for your answer' })).toBeNull();
  });

  it('keeps the card in the Inbox too', async () => {
    serve([card()]);
    renderApp('/inbox');
    expect(await screen.findByText('Allow Bash?')).toBeTruthy();
  });
});
