import { AskSomeoneInput, mintId, type InboxItemDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { inboxItemDto, taskDto, workstreamDto } from '../../test/fixtures';
import { pickOption } from '../../test/combobox';
import { BUILDER_PERSON, personDto, slackContact } from '../../test/people-fixtures';

const mark = personDto({ name: 'Mark', handle: 'mark', slack: slackContact('U1') });
const sarah = personDto({ name: 'Sarah', handle: 'sarah', slack: slackContact('U3') });
const priya = personDto({ name: 'Priya', handle: 'priya' });
const goalId = mintId('Goal');
const task = taskDto({ goalId });
const workstream = workstreamDto({ taskId: task.id });

function serve(
  item: InboxItemDto,
  options: { copyForAfterAsk?: string[]; people?: unknown[] } = {},
) {
  let current = item;
  const asked: unknown[] = [];
  server.use(
    http.get(daemonUrl('/inbox'), () => HttpResponse.json([current])),
    http.get(daemonUrl('/people'), () =>
      HttpResponse.json(options.people ?? [BUILDER_PERSON, mark, sarah, priya]),
    ),
    http.get(daemonUrl('/workstreams'), () => HttpResponse.json([workstream])),
    http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([task])),
    http.post(daemonUrl('/inbox/:id/ask'), async ({ request }) => {
      asked.push(AskSomeoneInput.parse(await request.json()));
      current = {
        ...item,
        routedBy: 'builder',
        assignees: ['me'],
        copyFor: options.copyForAfterAsk ?? [],
      };
      return HttpResponse.json(current);
    }),
    http.get(daemonUrl('/inbox/:id/compose'), () =>
      HttpResponse.json({ text: 'Travis asks Priya: how long?', hits: [] }),
    ),
    ...baseHandlers(),
  );
  renderApp('/inbox');
  return asked;
}

const unrouted = () =>
  inboxItemDto({
    title: 'How long?',
    options: [{ label: 'Seven days', description: '' }],
    category: 'product',
    targets: [{ workstreamId: workstream.id, sessionId: null }],
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Ask Someone', () => {
  it('with nobody but the builder, says where to add someone instead of an empty list', async () => {
    serve(unrouted(), { people: [BUILDER_PERSON] });
    fireEvent.click(await screen.findByRole('button', { name: 'Ask Someone' }));
    const popover = await screen.findByRole('dialog');
    expect(within(popover).getByText('There is nobody to ask yet.')).toBeTruthy();
    expect(
      within(popover)
        .getByRole('link', { name: 'Add someone in Settings › People' })
        .getAttribute('href'),
    ).toBe('/settings/people');
    expect(within(popover).queryByLabelText('Person')).toBeNull();
  });

  it('offers Product, Design and Business; ticking Design too writes both at the goal scope', async () => {
    const asked = serve(unrouted());
    fireEvent.click(await screen.findByRole('button', { name: 'Ask Someone' }));
    const popover = await screen.findByRole('dialog');
    await within(popover).findByLabelText('Person', { selector: 'input' });
    await pickOption(within(popover).getByLabelText('Person', { selector: 'input' }), /Mark/);
    expect(await within(popover).findByRole('checkbox', { name: /Product/ })).toHaveProperty(
      'checked',
      true,
    );
    fireEvent.click(within(popover).getByRole('checkbox', { name: /Design/ }));
    expect(within(popover).getByRole('checkbox', { name: /Business/ })).toHaveProperty(
      'checked',
      false,
    );
    fireEvent.click(await within(popover).findByRole('button', { name: 'Ask Mark' }));
    await waitFor(() => {
      expect(asked).toEqual([
        {
          personIds: [mark.id],
          always: { categories: ['product', 'design'], goalId, taskId: null },
        },
      ]);
    });
  });

  it('unticking Always asks just this once', async () => {
    const asked = serve(unrouted());
    fireEvent.click(await screen.findByRole('button', { name: 'Ask Someone' }));
    const popover = await screen.findByRole('dialog');
    await within(popover).findByLabelText('Person', { selector: 'input' });
    await pickOption(within(popover).getByLabelText('Person', { selector: 'input' }), /Mark/);
    fireEvent.click(await within(popover).findByRole('checkbox', { name: /Always send/ }));
    fireEvent.click(await within(popover).findByRole('button', { name: 'Ask Mark' }));
    await waitFor(() => {
      expect(asked).toEqual([{ personIds: [mark.id], always: null }]);
    });
  });

  it('can scope Always to this task or to the whole project', async () => {
    const asked = serve(unrouted());
    fireEvent.click(await screen.findByRole('button', { name: 'Ask Someone' }));
    const popover = await screen.findByRole('dialog');
    await within(popover).findByLabelText('Person', { selector: 'input' });
    await pickOption(within(popover).getByLabelText('Person', { selector: 'input' }), /Mark/);
    await pickOption(within(popover).getByLabelText('On', { selector: 'input' }), /this task/);
    fireEvent.click(await within(popover).findByRole('button', { name: 'Ask Mark' }));
    await waitFor(() => {
      expect(asked).toEqual([
        {
          personIds: [mark.id],
          always: { categories: ['product'], goalId: null, taskId: task.id },
        },
      ]);
    });
  });

  it('a suggestion shows beside the button and opens the popover on that person, Always unticked', async () => {
    const asked = serve({
      ...unrouted(),
      routeSuggestion: { personIds: [sarah.id], confidence: 0.64 },
    });
    expect(await screen.findByText('Suggested: Sarah (64%)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask Someone' }));
    const popover = await screen.findByRole('dialog');
    await within(popover).findByLabelText('Person', { selector: 'input' });
    expect(within(popover).getByLabelText('Person', { selector: 'input' })).toHaveProperty(
      'value',
      'Sarah · Slack',
    );
    expect(await within(popover).findByRole('checkbox', { name: /Always send/ })).toHaveProperty(
      'checked',
      false,
    );
    fireEvent.click(await within(popover).findByRole('button', { name: 'Ask Sarah' }));
    await waitFor(() => {
      expect(asked).toEqual([{ personIds: [sarah.id], always: null }]);
    });
  });
});

describe('a card asked of someone not in Slack', () => {
  it('makes the primary Copy for Priya, which copies the composed message and leaves the card open', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    // The daemon keeps such a card with the builder and names her in copyFor.
    serve(unrouted(), { copyForAfterAsk: ['priya'] });
    fireEvent.click(await screen.findByRole('button', { name: 'Ask Someone' }));
    const popover = await screen.findByRole('dialog');
    await pickOption(
      await within(popover).findByLabelText('Person', { selector: 'input' }),
      /Priya/,
    );
    fireEvent.click(await within(popover).findByRole('button', { name: 'Ask Priya' }));
    const copy = await screen.findByRole('button', { name: 'Copy for Priya' });
    expect(screen.getByText('Product question → Priya · chosen by you')).toBeTruthy();
    await waitFor(() => {
      expect(copy).toHaveProperty('disabled', false);
    });
    fireEvent.click(copy);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('Travis asks Priya: how long?');
    });
    expect(screen.getByRole('radio', { name: /Seven days/ })).toBeTruthy();
  });
});
