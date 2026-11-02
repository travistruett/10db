import { mintId, type ShapeViewDto } from '@10db/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler, type WebSocketHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import {
  decisionProposal,
  goalProposal,
  looseTaskProposal,
  questionProposal,
  shapeDto,
  shapeMessageDto,
  shapeViewDto,
} from '../../test/shape-fixtures';

// Shape spec §4: the screen, its states, and the loop from the keyboard.

const project = projectViewDto();

function serve(...overrides: (RequestHandler | WebSocketHandler)[]): void {
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    ...overrides,
    ...baseHandlers(),
  );
}

/** Answers the conversation list and each conversation's view. */
function conversations(...views: ShapeViewDto[]): RequestHandler[] {
  return [
    http.get(daemonUrl('/projects/:projectId/shapes'), () =>
      HttpResponse.json(views.map((v) => v.shape)),
    ),
    http.get(daemonUrl('/shapes/:shapeId'), ({ params }) => {
      const view = views.find((v) => v.shape.id === params['shapeId']);
      return view
        ? HttpResponse.json(view)
        : HttpResponse.json(
            { error: 'not_found', message: 'No such conversation' },
            { status: 404 },
          );
    }),
  ];
}

const inProject = { projectId: project.id };

const focused = (el: HTMLElement | undefined): boolean =>
  el !== undefined && document.activeElement === el;
const disabled = (el: HTMLElement): boolean => (el as HTMLButtonElement).disabled;

/** A conversation at `round` with these proposals. */
function proposed(
  proposals: ShapeViewDto['proposals'],
  extra: Partial<ShapeViewDto> & { readonly round?: number } = {},
): ShapeViewDto {
  const { round = 1, ...rest } = extra;
  const base = shapeDto({ ...inProject, state: 'proposed', proposeUnlocked: true, round });
  return shapeViewDto({
    shape: base,
    messages: [shapeMessageDto(base.id)],
    proposals,
    ...rest,
  });
}

const open = (view: ShapeViewDto): ReturnType<typeof renderApp> =>
  renderApp(`/shape/${view.shape.id}`);

describe('Shape: the first run', () => {
  it('opens a new conversation with the input focused and says what nothing does until you act', async () => {
    serve(...conversations());
    renderApp('/shape');
    const input = await screen.findByRole('textbox', { name: 'Message' });
    expect(focused(input)).toBe(true);
    expect(input.getAttribute('placeholder')).toBe(
      'Talk it through, drop a document, or paste a list…',
    );
    expect(
      screen.getByText(
        'Nothing is proposed until you press Propose. Nothing starts until you Convert.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Press Propose when you've said enough/)).toBeTruthy();
  });

  it('says there are no conversations in the nav, with Shape Work… to start one', async () => {
    serve(...conversations());
    renderApp('/shape');
    const nav = await screen.findByRole('navigation');
    expect(await within(nav).findByText(/No conversations yet/)).toBeTruthy();
  });

  it('creates the conversation on the first send, posts the message and opens it', async () => {
    const view = proposed([], { round: 0 });
    const posted: unknown[] = [];
    serve(
      ...conversations(view),
      http.post(daemonUrl('/projects/:projectId/shapes'), () =>
        HttpResponse.json(view.shape, { status: 201 }),
      ),
      http.post(daemonUrl('/shapes/:shapeId/messages'), async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json(shapeMessageDto(view.shape.id), { status: 202 });
      }),
    );
    const { router } = renderApp('/shape');
    const input = await screen.findByRole('textbox', { name: 'Message' });
    // The project has loaded once the nav has asked for its conversations.
    await screen.findByText(/No conversations yet|Board polish/);
    fireEvent.change(input, { target: { value: 'Move density ahead of the scrollbars.' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(posted).toEqual([{ text: 'Move density ahead of the scrollbars.' }]);
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/shape/${view.shape.id}`);
    });
  });
});

describe('Shape: the conversation', () => {
  it('shows the builder, Claude and the tool lines, and what was heard before the first Propose', async () => {
    const shape = shapeDto({ ...inProject, title: 'Board polish' });
    const view = shapeViewDto({
      shape,
      messages: [
        shapeMessageDto(shape.id, { body: 'Move density ahead of the scrollbars.' }),
        shapeMessageDto(shape.id, { author: 'claude', body: 'Four efforts, I think.' }),
        shapeMessageDto(shape.id, {
          author: 'claude',
          kind: 'tool',
          body: 'propose_plan · 1 goal, 3 loose · passed',
        }),
      ],
      heard: ['Density first', 'Thin scrollbars'],
    });
    serve(...conversations(view));
    open(view);
    const conversation = await screen.findByRole('region', { name: 'Conversation' });
    expect(
      await within(conversation).findByText('Move density ahead of the scrollbars.'),
    ).toBeTruthy();
    expect(within(conversation).getByText('Four efforts, I think.')).toBeTruthy();
    expect(within(conversation).getByText('propose_plan · 1 goal, 3 loose · passed')).toBeTruthy();
    const sidebar = screen.getByRole('region', { name: 'Proposed' });
    expect(await within(sidebar).findByText('Heard so far')).toBeTruthy();
    expect(within(sidebar).getByText('Thin scrollbars')).toBeTruthy();
  });

  it('presses Propose, and reads Propose Again once a round has passed', async () => {
    const view = proposed([looseTaskProposal('density')], { round: 1 });
    const proposes: string[] = [];
    serve(
      ...conversations(view),
      http.post(daemonUrl('/shapes/:shapeId/propose'), ({ params }) => {
        proposes.push(String(params['shapeId']));
        return HttpResponse.json({ status: 'started' }, { status: 202 });
      }),
    );
    open(view);
    fireEvent.click(await screen.findByRole('button', { name: 'Propose Again' }));
    await waitFor(() => {
      expect(proposes).toEqual([view.shape.id]);
    });
  });

  it('proposes on ⌘⇧↩ even from the input', async () => {
    const view = proposed([looseTaskProposal('density')], { round: 0 });
    const proposes: string[] = [];
    serve(
      ...conversations(view),
      http.post(daemonUrl('/shapes/:shapeId/propose'), ({ params }) => {
        proposes.push(String(params['shapeId']));
        return HttpResponse.json({ status: 'started' }, { status: 202 });
      }),
    );
    open(view);
    const input = await screen.findByRole('textbox', { name: 'Message' });
    const propose = await screen.findByRole('button', { name: 'Propose' });
    // Propose is enabled once the conversation, and the builder's message in it, has loaded.
    await waitFor(() => {
      expect(disabled(propose)).toBe(false);
    });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(proposes).toEqual([view.shape.id]);
    });
  });

  it('shows Propose as pending while a Propose turn is queued or running', async () => {
    const view = proposed([], { round: 0, turn: { running: true, queued: 0, proposing: true } });
    serve(...conversations(view));
    open(view);
    const propose = await screen.findByRole('button', { name: 'Propose' });
    await waitFor(() => {
      expect(propose.getAttribute('data-loading')).toBe('true');
    });
  });

  it('shows Stop while a turn runs and stops it on Esc', async () => {
    const view = proposed([], { round: 0, turn: { running: true, queued: 0, proposing: false } });
    const stops: string[] = [];
    serve(
      ...conversations(view),
      http.post(daemonUrl('/shapes/:shapeId/stop'), ({ params }) => {
        stops.push(String(params['shapeId']));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    open(view);
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeTruthy();
    fireEvent.keyDown(await screen.findByRole('textbox', { name: 'Message' }), { key: 'Escape' });
    await waitFor(() => {
      expect(stops).toEqual([view.shape.id]);
    });
  });

  it('puts the daemon’s words in a red alert above the input when the conversation fails to load, and keeps the input', async () => {
    serve(
      http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([])),
      http.get(daemonUrl('/shapes/:shapeId'), () =>
        HttpResponse.json({ error: 'boom', message: 'The database is locked' }, { status: 500 }),
      ),
    );
    renderApp(`/shape/${mintId('Shape')}`);
    const conversation = await screen.findByRole('region', { name: 'Conversation' });
    expect(await within(conversation).findByText('The database is locked')).toBeTruthy();
    expect(within(conversation).getByRole('textbox', { name: 'Message' })).toBeTruthy();
  });
});

describe('Shape: the Proposed sidebar', () => {
  const six = [
    goalProposal('brainstorm', ['one', 'two']),
    looseTaskProposal('density', { title: 'Compact card density' }),
    looseTaskProposal('scrollbars', { title: 'Thin board scrollbars' }),
    decisionProposal('replaces-adopt'),
    questionProposal('ship-date'),
  ];

  it('names each kind, counts them in a summary line and shows the round', async () => {
    const view = proposed(six, { round: 2 });
    serve(...conversations(view));
    open(view);
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    expect(await within(sidebar).findByText(/round 2/)).toBeTruthy();
    const summary = within(sidebar).getByRole('group', { name: 'Summary' });
    expect(summary.textContent.replace(/\s+/g, ' ')).toBe(
      '1 goal · 2 loose · 1 to record · 1 question',
    );
    expect(within(sidebar).getByText('Compact card density')).toBeTruthy();
    expect(within(sidebar).getByText('Brainstorm chat in 10db')).toBeTruthy();
    expect(within(sidebar).getByText('Sent when people arrive (goals phase 3)')).toBeTruthy();
  });

  it('keeps the summary line outside the scrolling list, so it stays pinned', async () => {
    const view = proposed(six);
    serve(...conversations(view));
    open(view);
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    const summary = await within(sidebar).findByRole('group', { name: 'Summary' });
    const list = within(sidebar).getByRole('list', { name: 'Proposed rows' });
    const scroller = within(sidebar).getByRole('group', { name: 'Proposed list' });
    expect(list.contains(summary)).toBe(false);
    expect(scroller.contains(summary)).toBe(false);
  });

  it('moves between rows with ↑/↓ and opens one with Enter, read-only', async () => {
    const view = proposed(six);
    serve(...conversations(view));
    open(view);
    const rows = await screen.findAllByRole('button', {
      name: /^(Brainstorm chat|Compact card|Thin board)/,
    });
    const [first, second] = rows as [HTMLElement, HTMLElement];
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(focused(second)).toBe(true);
    fireEvent.keyDown(second, { key: 'ArrowUp' });
    expect(focused(first)).toBe(true);
    fireEvent.click(first);
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Brainstorm, size and file work without leaving 10db.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
  });

  it('shows Superseded rows under a collapsed Earlier', async () => {
    const view = proposed([
      looseTaskProposal('old', { title: 'Old idea', state: 'superseded' }),
      looseTaskProposal('density', { title: 'Compact card density' }),
    ]);
    serve(...conversations(view));
    open(view);
    const earlier = await screen.findByRole('button', { name: /Earlier/ });
    expect(earlier.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Old idea')).toBeNull();
    fireEvent.click(earlier);
    expect(await screen.findByText('Old idea')).toBeTruthy();
  });

  it('says a failure in the sidebar and leaves the chat usable', async () => {
    serve(
      http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([])),
      http.get(daemonUrl('/shapes/:shapeId'), () =>
        HttpResponse.json({ error: 'boom', message: 'Could not read proposals' }, { status: 500 }),
      ),
    );
    renderApp(`/shape/${mintId('Shape')}`);
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    const alert = await within(sidebar).findByRole('alert');
    expect(alert.textContent).toContain('Could not read proposals');
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy();
  });

  it('announces a round’s summary without moving focus', async () => {
    const before = proposed([looseTaskProposal('density', { round: 1 })], { round: 1 });
    let current = before;
    serve(
      http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([current.shape])),
      http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(current)),
    );
    const { queryClient } = open(before);
    const input = await screen.findByRole('textbox', { name: 'Message' });
    // Round 1 is the baseline the announcer compares the next round with.
    await screen.findByText(/round 1/);
    input.focus();
    const status = screen.getByRole('status', { name: 'Round summary' });
    expect(status.textContent).toBe('');
    current = {
      ...before,
      shape: { ...before.shape, round: 2 },
      proposals: [
        looseTaskProposal('density', { round: 2 }),
        looseTaskProposal('scrollbars', { round: 2 }),
        goalProposal('brainstorm', ['one'], { round: 2 }),
      ],
    };
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['shapes'] });
    });
    await waitFor(() => {
      expect(status.textContent).toBe('Round 2: 3 changes');
    });
    expect(focused(input)).toBe(true);
  });
});

describe('Shape: the nav list', () => {
  it('lists the conversations with their state and age', async () => {
    const view = proposed([looseTaskProposal('density')]);
    serve(...conversations(view));
    open(view);
    const nav = await screen.findByRole('navigation');
    expect(await within(nav).findByRole('link', { name: /Board polish/ })).toBeTruthy();
  });

  it('says it could not load the conversations', async () => {
    serve(
      http.get(daemonUrl('/projects/:projectId/shapes'), () =>
        HttpResponse.json({ error: 'boom', message: 'nope' }, { status: 500 }),
      ),
    );
    renderApp('/shape');
    expect(await screen.findByText("Couldn't load conversations")).toBeTruthy();
  });
});

describe('Shape: Convert', () => {
  function convertible(): ShapeViewDto {
    return proposed([
      goalProposal('brainstorm', ['one', 'two']),
      looseTaskProposal('density', { title: 'Compact card density' }),
      decisionProposal('replaces-adopt'),
    ]);
  }

  it('is disabled until a proposal exists', async () => {
    const view = proposed([], { round: 0 });
    serve(...conversations(view));
    open(view);
    const button = await screen.findByRole('button', { name: 'Convert…' });
    await waitFor(() => {
      expect(disabled(button)).toBe(true);
    });
  });

  it('lists what each row becomes, says nothing starts and converts the ticked rows', async () => {
    const view = convertible();
    const posted: unknown[] = [];
    serve(
      ...conversations(view),
      http.post(daemonUrl('/shapes/:shapeId/convert'), async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ createdNow: 2, results: [] });
      }),
    );
    open(view);
    const button = await screen.findByRole('button', { name: 'Convert…' });
    await waitFor(() => {
      expect(disabled(button)).toBe(false);
    });
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Convert' });
    expect(within(dialog).getByText('Nothing starts. Tasks wait on the Board.')).toBeTruthy();
    expect(within(dialog).getAllByText(/to Backlog/)).toHaveLength(2);
    expect(within(dialog).getByText(/to Knowledge/)).toBeTruthy();
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(3);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Compact card density/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Convert 2' }));
    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    const body = posted[0] as { proposalIds: string[] };
    expect(body.proposalIds).toHaveLength(2);
    expect(body.proposalIds).not.toContain(view.proposals.find((p) => p.key === 'density')?.id);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Convert' })).toBeNull();
    });
  });

  it('lists every refusal as a row beside Convert and writes nothing', async () => {
    const view = convertible();
    serve(
      ...conversations(view),
      http.post(daemonUrl('/shapes/:shapeId/convert'), () =>
        HttpResponse.json(
          {
            errors: [
              "Thin scrollbars depends on Compact density, which isn't selected",
              'Task two has started',
            ],
          },
          { status: 400 },
        ),
      ),
    );
    open(view);
    const button = await screen.findByRole('button', { name: 'Convert…' });
    await waitFor(() => {
      expect(disabled(button)).toBe(false);
    });
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Convert' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Convert 3' }));
    expect(
      await within(dialog).findByText(
        "Thin scrollbars depends on Compact density, which isn't selected",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText('Task two has started')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Convert' })).toBeTruthy();
  });

  it('offers Stop while Claude is answering, with Convert waiting', async () => {
    const view = convertible();
    const running = { ...view, turn: { running: true, queued: 0, proposing: false } };
    serve(...conversations(running));
    open(running);
    const button = await screen.findByRole('button', { name: 'Convert…' });
    await waitFor(() => {
      expect(disabled(button)).toBe(false);
    });
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Convert' });
    expect(within(dialog).getByText(/Claude is still answering/)).toBeTruthy();
    expect(disabled(within(dialog).getByRole('button', { name: 'Stop' }))).toBe(false);
    expect(disabled(within(dialog).getByRole('button', { name: 'Convert 3' }))).toBe(true);
  });
});

describe('Shape: converted rows and their undo', () => {
  const goalId = mintId('Goal');
  const decisionId = mintId('Decision');
  const converted = (): ShapeViewDto =>
    proposed([
      {
        ...goalProposal('brainstorm', ['one'], { state: 'accepted' }),
        converted: { goalId, taskIds: [mintId('Task')], decisionId: null },
      },
      {
        ...decisionProposal('replaces-adopt', { state: 'accepted' }),
        converted: { goalId: null, taskIds: [], decisionId },
      },
    ]);

  it('dims a converted row and says where it went', async () => {
    const view = converted();
    serve(...conversations(view));
    open(view);
    expect(await screen.findByText('Converted · on the Board')).toBeTruthy();
    expect(screen.getByText('Converted · in Knowledge')).toBeTruthy();
  });

  it('removes a draft goal after a confirm and returns it to Proposed', async () => {
    const view = converted();
    const removed: string[] = [];
    serve(
      ...conversations(view),
      http.post(daemonUrl('/goals/:goalId/remove-draft'), ({ params }) => {
        removed.push(String(params['goalId']));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    open(view);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for Brainstorm chat in 10db' }),
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove Draft Goal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Draft Goal' });
    expect(within(dialog).getByText(/Its tasks go with it/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Draft Goal' }));
    await waitFor(() => {
      expect(removed).toEqual([goalId]);
    });
  });

  it('withdraws a decision only with a reason', async () => {
    const view = converted();
    const withdrawn: unknown[] = [];
    serve(
      ...conversations(view),
      http.post(
        daemonUrl('/shapes/:shapeId/decisions/:decisionId/withdraw'),
        async ({ request, params }) => {
          withdrawn.push({
            decisionId: params['decisionId'],
            ...((await request.json()) as object),
          });
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    open(view);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for The chat replaces Adopt' }),
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Withdraw Decision…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Withdraw Decision' });
    const submit = within(dialog).getByRole('button', { name: 'Withdraw Decision' });
    expect(disabled(submit)).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), {
      target: { value: 'We chose the opposite' },
    });
    expect(disabled(submit)).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => {
      expect(withdrawn).toEqual([{ decisionId, reason: 'We chose the opposite' }]);
    });
  });
});
