import { mintId, type InboxItemDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { inboxItemDto } from '../../test/fixtures';
import { pickOption } from '../../test/combobox';
import { openEveryRow, serveInboxPage, tableRows } from '../../test/inbox-page-fixtures';
import {
  BUILDER_PERSON,
  personDto,
  sendDto,
  slackConnection,
  slackContact,
} from '../../test/people-fixtures';

const mark = personDto({ name: 'Mark Ellis', handle: 'mark', slack: slackContact('U1') });
const ana = personDto({ name: 'Ana Ortiz', handle: 'ana', slack: slackContact('U2') });
const NOW = Date.now();
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const OPTIONS = [
  { label: 'Keep access for 7 days', description: '' },
  { label: 'Cut access at once', description: '' },
];

function card(send: Record<string, unknown>, over: Partial<InboxItemDto> = {}): InboxItemDto {
  const id = mintId('InboxItem');
  return inboxItemDto({
    id,
    title: 'How long should access last?',
    options: OPTIONS,
    assignees: ['mark'],
    routedBy: 'rule',
    send: sendDto({
      inboxItemId: id,
      state: 'sent',
      heldBy: null,
      sentAt: ago(3),
      people: [{ personId: mark.id, userId: 'U1', name: 'Mark Ellis', recipient: true }],
      ...send,
    }),
    ...over,
  });
}

/** Out with someone: sent and not brought back, as the daemon's Waiting page holds it. */
const isOut = (item: InboxItemDto): boolean =>
  item.send?.state === 'sent' && item.send.returnedAt === null;

/** Every query the Waiting page was asked with, since the last `serve`. */
let asked: Record<string, string>[] = [];

/** Serves `items` as the open cards and the ones out with someone as the Waiting page; returns the actions posted. */
function serve(
  items: InboxItemDto[],
  connection: Record<string, unknown> = { state: 'connected' },
) {
  const calls: { path: string; body?: unknown }[] = [];
  server.use(
    http.get(daemonUrl('/inbox'), () => HttpResponse.json(items)),
    http.get(daemonUrl('/people'), () =>
      HttpResponse.json([
        BUILDER_PERSON,
        mark,
        ana,
        personDto({ name: 'Priya Shah', handle: 'priya' }),
      ]),
    ),
    http.get(daemonUrl('/slack'), () => HttpResponse.json(slackConnection(connection))),
    http.post(daemonUrl('/inbox/:id/take-back'), ({ params }) => {
      calls.push({ path: `take-back:${String(params['id'])}` });
      return HttpResponse.json(items[0]);
    }),
    http.post(daemonUrl('/inbox/:id/keep-waiting'), ({ params }) => {
      calls.push({ path: `keep-waiting:${String(params['id'])}` });
      return HttpResponse.json(items[0]);
    }),
    http.post(daemonUrl('/inbox/:id/answer'), async ({ request }) => {
      calls.push({ path: 'answer', body: await request.json() });
      return HttpResponse.json(items[0]);
    }),
    ...baseHandlers(),
  );
  // After the base handlers, whose empty page it replaces.
  asked = serveInboxPage({ waiting: items.filter(isOut) });
  return calls;
}

const WAITING = 'Waiting questions';

const tabs = () => within(screen.getByRole('tablist', { name: 'Inbox view' }));

describe('the Waiting tab', () => {
  it('holds a sent card, in no count and none of Open', async () => {
    serve([card({}), inboxItemDto({ title: 'Needs me' })]);
    renderApp('/inbox');
    expect(await screen.findByText('Needs me')).toBeTruthy();
    expect(screen.queryByText('How long should access last?')).toBeNull();
    expect(tabs().getByText('Open')).toBeTruthy();
    // Open counts the card that needs the builder; Waiting shows its number in the neutral tone.
    expect(tabs().getByText('Open').parentElement?.textContent).toBe('Open1');
    // The Waiting count also waits on the Slack connection, which loads apart from the cards.
    await waitFor(() => {
      expect(tabs().getByText('Waiting').parentElement?.textContent).toBe('Waiting1');
    });
    fireEvent.click(tabs().getByRole('tab', { name: /Waiting/ }));
    expect(await screen.findByText('How long should access last?')).toBeTruthy();
    expect(screen.getByText('Mark Ellis')).toBeTruthy();
    expect(screen.getByText('sent 3h ago')).toBeTruthy();
    // One page from the daemon, the longest out first; never every sent card.
    expect(asked[0]).toEqual({
      state: 'waiting',
      sort: 'sentAt',
      dir: 'asc',
      page: '1',
      pageSize: '25',
    });
  });

  it('sends the Project filter in the URL and the With filter to the daemon', async () => {
    const only = mintId('Project');
    serve([card({})]);
    renderApp(`/inbox?project=${only}`);
    fireEvent.click(await screen.findByRole('tab', { name: /Waiting/ }));
    await tableRows(WAITING);
    for (const query of asked) expect(query['project']).toBe(only);
    fireEvent.click(screen.getByRole('button', { name: 'Filter With' }));
    await pickOption(await screen.findByRole('combobox', { name: 'With' }), 'Ana Ortiz');
    await waitFor(() => {
      expect(asked.at(-1)).toEqual({
        state: 'waiting',
        project: only,
        person: ana.id,
        sort: 'sentAt',
        dir: 'asc',
        page: '1',
        pageSize: '25',
      });
    });
  });

  it('opens a row with Enter for the message and its answers, and closes it with ←', async () => {
    serve([card({ text: 'Hi Mark, how long should access last?' })]);
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('tab', { name: /Waiting/ }));
    const [row] = await openEveryRow(WAITING);
    expect(await screen.findByText('Hi Mark, how long should access last?')).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: 'Answer Myself: Cut access at once' }),
    ).toBeTruthy();
    if (row === undefined) throw new Error('no row');
    fireEvent.keyDown(row, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(row.getAttribute('aria-expanded')).toBe('false');
    });
  });

  it('says Slack is not connected, and asks for no page, while it is not', async () => {
    serve([card({})], { state: 'off' });
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('tab', { name: /Waiting/ }));
    expect(
      await screen.findByText("Slack isn't connected, so questions sent there wait in Open."),
    ).toBeTruthy();
    expect(asked).toEqual([]);
  });

  it('keeps the Waiting count in the neutral badge, not the filled one', async () => {
    serve([card({})]);
    renderApp('/inbox');
    await screen.findByRole('tab', { name: /Waiting/ });
    const badge = await waitFor(() => {
      const found = tabs().getByText('Waiting').parentElement?.querySelector('.mantine-Badge-root');
      if (!found) throw new Error('no Waiting count yet');
      return found;
    });
    expect(badge.getAttribute('data-variant')).toBe('light');
    // Nothing needs the builder, so Open shows no count rather than an attention-coloured 0.
    expect(tabs().getByText('Open').parentElement?.textContent).toBe('Open');
  });

  it('says nothing is out with anyone when empty', async () => {
    serve([]);
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('tab', { name: /Waiting/ }));
    expect(await screen.findByText('Nothing is out with anyone.')).toBeTruthy();
  });

  it('a tie reads both names, a brought-in person adds "with", a reminded one says so', async () => {
    serve([
      card({
        people: [
          { personId: mark.id, userId: 'U1', name: 'Mark Ellis', recipient: true },
          { personId: ana.id, userId: 'U2', name: 'Ana Ortiz', recipient: true },
          { personId: null, userId: 'U9', name: 'Priya', recipient: false },
        ],
        remindedAt: ago(1),
      }),
    ]);
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('tab', { name: /Waiting/ }));
    expect(await screen.findByText('Mark Ellis + Ana Ortiz')).toBeTruthy();
    expect(screen.getByText('with Priya')).toBeTruthy();
    expect(screen.getByText('reminded 1h ago')).toBeTruthy();
  });

  it('expanding a row shows the conversation and an open proposal', async () => {
    serve([
      card({
        conversation: [
          { userId: 'U9', name: 'Priya', text: 'B is the only one legal signs', ts: '1.1' },
          { userId: 'U1', name: 'Mark Ellis', text: 'agreed, but send the email', ts: '1.2' },
        ],
        proposal: { choice: 'B', confidence: 0.9 },
      }),
    ]);
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('tab', { name: /Waiting/ }));
    fireEvent.click(await screen.findByText('How long should access last?'));
    expect(await screen.findByText(/B is the only one legal signs/)).toBeTruthy();
    expect(screen.getByText(/agreed, but send the email/)).toBeTruthy();
    expect(screen.getByText("Proposed B, waiting for Mark Ellis's ✅")).toBeTruthy();
  });

  it('the thread link opens the permalink', async () => {
    serve([card({ permalink: 'https://acme.slack.com/archives/D1/p1' })]);
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('tab', { name: /Waiting/ }));
    const link = await screen.findByRole('link', { name: 'Open in Slack' });
    expect(link.getAttribute('href')).toBe('https://acme.slack.com/archives/D1/p1');
  });

  it('Take Back from the row menu asks first, since it posts in Slack, then returns the card', async () => {
    const calls = serve([card({})]);
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('tab', { name: /Waiting/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'More for this question' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Take Back' }));
    const ask = await screen.findByRole('dialog', { name: 'Take this back from Mark Ellis?' });
    expect(within(ask).getByText(/tells them in the Slack thread/)).toBeTruthy();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'More for this question' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Take Back', hidden: true }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Take Back' }),
    );
    await waitFor(() => {
      expect(calls.map((c) => c.path.split(':')[0])).toEqual(['take-back']);
    });
  });

  it('Answer Myself answers with an option', async () => {
    const calls = serve([card({})]);
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('tab', { name: /Waiting/ }));
    fireEvent.click(await screen.findByText('How long should access last?'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Answer Myself: Cut access at once' }),
    );
    await waitFor(() => {
      expect(calls).toEqual([
        {
          path: 'answer',
          body: { choice: 'Cut access at once', record: null },
        },
      ]);
    });
  });
});

describe('what leaves Waiting for Open', () => {
  it('a send the timer returned says so and offers Answer Myself, Keep Waiting and Take Back', async () => {
    const calls = serve([card({ returnedAt: ago(0), returnedReason: 'timer' })]);
    renderApp('/inbox');
    expect(await screen.findByText("Mark Ellis hasn't answered in 8 hours")).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Keep access for 7 days/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep Waiting' }));
    await waitFor(() => {
      expect(calls.map((c) => c.path.split(':')[0])).toEqual(['keep-waiting']);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take Back' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Take Back' }),
    );
    await waitFor(() => {
      expect(calls.map((c) => c.path.split(':')[0])).toEqual(['keep-waiting', 'take-back']);
    });
  });

  it('a disagreement says who and quotes the conversation', async () => {
    serve([
      card(
        {
          people: [
            { personId: mark.id, userId: 'U1', name: 'Mark Ellis', recipient: true },
            { personId: ana.id, userId: 'U2', name: 'Ana Ortiz', recipient: true },
          ],
          returnedAt: ago(0),
          returnedReason: 'disagreed',
          conversation: [
            { userId: 'U1', name: 'Mark Ellis', text: 'B', ts: '1.1' },
            { userId: 'U2', name: 'Ana Ortiz', text: 'C', ts: '1.2' },
          ],
        },
        { assignees: ['mark', 'ana'] },
      ),
    ]);
    renderApp('/inbox');
    expect(await screen.findByText('Mark Ellis and Ana Ortiz disagree')).toBeTruthy();
    expect(screen.getByText(/Ana Ortiz: C/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep Waiting' })).toBeTruthy();
  });

  it.each([
    ['refused', /Slack refused 10db's token/],
    ['none', /token was removed/],
    ['off', /Slack is off/],
    ['unreachable', /can't be reached/],
  ])('a sent card is in Open with a notice while Slack is %s', async (state, notice) => {
    serve([card({})], { state });
    renderApp('/inbox');
    expect(await screen.findByText('How long should access last?')).toBeTruthy();
    expect((await screen.findAllByText(notice)).length).toBeGreaterThan(0);
  });

  it('a sent card in an outage can be taken back, after asking', async () => {
    const calls = serve([card({})], { state: 'refused' });
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Take Back' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Take Back' }),
    );
    await waitFor(() => {
      expect(calls.map((c) => c.path.split(':')[0])).toEqual(['take-back']);
    });
  });

  it('two people who have not answered read "haven\'t"', async () => {
    serve([
      card(
        {
          people: [
            { personId: mark.id, userId: 'U1', name: 'Mark Ellis', recipient: true },
            { personId: ana.id, userId: 'U2', name: 'Ana Ortiz', recipient: true },
          ],
          returnedAt: ago(0),
          returnedReason: 'timer',
        },
        { assignees: ['mark', 'ana'] },
      ),
    ]);
    renderApp('/inbox');
    expect(
      await screen.findByText("Mark Ellis and Ana Ortiz haven't answered in 8 hours"),
    ).toBeTruthy();
  });

  it('a sent card leaves Open for Waiting once Slack is connected', async () => {
    serve([card({})], { state: 'connected' });
    renderApp('/inbox');
    await screen.findByText('Nothing needs you right now.');
    expect(screen.queryByText('How long should access last?')).toBeNull();
  });
});

describe('Resolved cards answered in Slack', () => {
  const answered = (send: Record<string, unknown>, answer: Record<string, unknown>) =>
    card(
      {
        state: 'answered',
        sentAt: ago(5),
        answeredAt: ago(3),
        permalink: 'https://acme.slack.com/archives/D1/p1',
        ...send,
      },
      {
        state: 'ANSWERED',
        answer: { choice: 'Cut access at once', answeredBy: 'mark', via: 'slack', ...answer },
      },
    );

  it.each([
    [
      'an option',
      { readAs: 'option' },
      {},
      ['Answered by Mark Ellis in Slack · 2h after asking', 'Read as B'],
    ],
    [
      'own words',
      { readAs: 'own_words' },
      { words: 'Cut it, but email first' },
      ['In their own words', 'Cut it, but email first'],
    ],
    [
      'an approval with others',
      { readAs: 'approved' },
      { with: ['priya'] },
      ['Approved B · with Priya Shah'],
    ],
  ])('%s', async (_name, send, answer, texts) => {
    const item = answered(send, answer);
    serve([]);
    serveInboxPage({ resolved: [{ ...item, state: 'RESOLVED' }] });
    renderApp('/inbox');
    fireEvent.click(await screen.findByRole('tab', { name: 'Resolved' }));
    const [row] = await tableRows('Resolved cards');
    expect(row?.textContent).toContain('Slack Answer');
    expect(screen.queryByText(new RegExp(texts[0] ?? ''))).toBeNull();
    await openEveryRow('Resolved cards');
    for (const text of texts) expect(await screen.findByText(new RegExp(text))).toBeTruthy();
    // The thread it was answered in.
    const thread = await screen.findByRole('link', { name: 'Open in Slack' });
    expect(thread.getAttribute('href')).toBe('https://acme.slack.com/archives/D1/p1');
  });
});
