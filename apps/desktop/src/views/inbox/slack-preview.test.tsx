import { mintId, type InboxItemDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { inboxItemDto } from '../../test/fixtures';
import { BUILDER_PERSON, personDto, sendDto, slackContact } from '../../test/people-fixtures';

const mark = personDto({ name: 'Mark', handle: 'mark', slack: slackContact('U1') });
const ana = personDto({ name: 'Ana', handle: 'ana', slack: slackContact('U2') });
const priya = personDto({ name: 'Priya', handle: 'priya' });

const OPTIONS = [
  { label: 'Keep access for 7 days', description: '' },
  { label: 'Cut access at once', description: '' },
];

function card(send: Record<string, unknown>, over: Partial<InboxItemDto> = {}): InboxItemDto {
  const id = mintId('InboxItem');
  return inboxItemDto({
    id,
    title: 'How long should access last?',
    body: 'The spec is silent.',
    options: OPTIONS,
    category: 'product',
    routedBy: 'rule',
    assignees: ['mark'],
    send: sendDto({
      inboxItemId: id,
      people: [{ personId: mark.id, userId: 'U1', name: 'Mark', recipient: true }],
      ...send,
    }),
    ...over,
  });
}

function serve(item: InboxItemDto, builder = BUILDER_PERSON) {
  const posted: { path: string; body: unknown }[] = [];
  server.use(
    http.get(daemonUrl('/inbox'), () => HttpResponse.json([item])),
    http.get(daemonUrl('/people'), () => HttpResponse.json([builder, mark, ana, priya])),
    http.post(daemonUrl('/inbox/:id/send'), async ({ request }) => {
      posted.push({ path: 'send', body: await request.json() });
      return HttpResponse.json(item.send);
    }),
    http.post(daemonUrl('/inbox/:id/answer'), async ({ request }) => {
      posted.push({ path: 'answer', body: await request.json() });
      return HttpResponse.json({ ...item, state: 'ANSWERED' });
    }),
    ...baseHandlers(),
  );
  renderApp('/inbox');
  return posted;
}

const key = (k: string, init: { metaKey?: boolean } = {}): void => {
  fireEvent.keyDown(document.body, { key: k, ...init });
};

describe('a card with a draft', () => {
  it('opens on what Mark will get, with the draft text, and not on the options', async () => {
    serve(card({ text: 'Travis asks: how long?' }));
    expect(await screen.findByText('Mark will get')).toBeTruthy();
    expect(screen.getByText(/Travis asks: how long\?/)).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Keep access for 7 days/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Send to Mark/ })).toBeTruthy();
  });

  it('⌘↵ sends with no text; a bare Enter or a digit does nothing', async () => {
    const posted = serve(card({}));
    await screen.findByText('Mark will get');
    key('Enter');
    key('1');
    key('2');
    expect(posted).toEqual([]);
    key('Enter', { metaKey: true });
    await waitFor(() => {
      expect(posted).toEqual([{ path: 'send', body: {} }]);
    });
  });

  it('Edit then Done sends the edited text', async () => {
    const posted = serve(card({ text: 'old text' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'new text' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: /Send to Mark/ }));
    await waitFor(() => {
      expect(posted).toEqual([{ path: 'send', body: { text: 'new text' } }]);
    });
  });

  it("Answer Myself shows today's options, and Enter answers; Send to Mark instead swaps back", async () => {
    const posted = serve(card({}));
    fireEvent.click(await screen.findByRole('button', { name: 'Answer Myself' }));
    expect(await screen.findByRole('radio', { name: /Keep access for 7 days/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send to Mark instead' }));
    expect(await screen.findByText('Mark will get')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Answer Myself' }));
    await screen.findByRole('radio', { name: /Keep access for 7 days/ });
    key('1');
    key('Enter');
    await waitFor(() => {
      expect(posted).toEqual([
        {
          path: 'answer',
          body: { choice: 'Keep access for 7 days', record: { area: null, scope: 'project' } },
        },
      ]);
    });
  });

  it('a scan hold shows the alert and disables Send', async () => {
    const posted = serve(
      card({ heldBy: 'scan', hits: [{ pattern: 'aws_access_key', line: 3, severity: 'hold' }] }),
    );
    expect(await screen.findByText(/This looks like an AWS access key \(line 3\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Send to Mark/ })).toHaveProperty('disabled', true);
    key('Enter', { metaKey: true });
    expect(posted).toEqual([]);
  });

  it('Edit alone does not release a scan hold; changing the text does, and changing it back holds again', async () => {
    const held = 'key AKIA-ish on line 3';
    const posted = serve(
      card({
        text: held,
        heldBy: 'scan',
        hits: [{ pattern: 'aws_access_key', line: 3, severity: 'hold' }],
      }),
    );
    const send = await screen.findByRole('button', { name: /Send to Mark/ });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(send).toHaveProperty('disabled', true);
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'safe words' } });
    expect(send).toHaveProperty('disabled', false);
    fireEvent.change(box, { target: { value: held } });
    expect(send).toHaveProperty('disabled', true);
    fireEvent.change(box, { target: { value: 'safe words' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(send);
    await waitFor(() => {
      expect(posted).toEqual([{ path: 'send', body: { text: 'safe words' } }]);
    });
  });

  it('a limit hold says so and Send Anyway overrides it', async () => {
    const posted = serve(card({ heldBy: 'limit' }));
    expect(await screen.findByText(/Mark has had 10 new questions today/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send Anyway' }));
    await waitFor(() => {
      expect(posted).toEqual([{ path: 'send', body: { overrideLimit: true } }]);
    });
  });

  it('a first send says to check it before it goes', async () => {
    serve(card({ heldBy: 'first_send' }));
    expect(await screen.findByText('First message to Mark: check it before it goes')).toBeTruthy();
  });

  it('a review hold shows the plain preview, no alert', async () => {
    serve(card({ heldBy: 'review' }));
    await screen.findByText('Mark will get');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a warning dims a line and leaves Send enabled', async () => {
    serve(card({ hits: [{ pattern: 'file_path', line: 2, severity: 'warn' }] }));
    expect(await screen.findByText(/looks like a file path \(line 2\)/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Send to Mark/ })).toHaveProperty('disabled', false);
  });

  it('a tie reads Mark and Ana will get, and Send to Mark and Ana', async () => {
    serve(
      card(
        {
          people: [
            { personId: mark.id, userId: 'U1', name: 'Mark', recipient: true },
            { personId: ana.id, userId: 'U2', name: 'Ana', recipient: true },
          ],
        },
        { assignees: ['mark', 'ana'] },
      ),
    );
    expect(await screen.findByText('Mark and Ana will get')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send to Mark and Ana' })).toBeTruthy();
  });

  it("a failed send shows Slack's words, Send again, and Change as its one way to reroute", async () => {
    // The daemon stores the bare code and hands a failed card back to the builder.
    const posted = serve(
      card(
        { state: 'failed', error: 'channel_not_found' },
        { assignees: ['me'], routedBy: 'builder' },
      ),
    );
    expect(
      await screen.findByText(
        'Slack refused: channel_not_found. Mark may have left the workspace.',
      ),
    ).toBeTruthy();
    // It still names who the message was for, not the builder it fell back to.
    expect(screen.getByText('Product question → Mark')).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: /Ask Someone/ })).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: 'Change' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Send to Mark/ }));
    await waitFor(() => {
      expect(posted).toEqual([{ path: 'send', body: {} }]);
    });
  });

  it('the route line names who and why, and Change is the only way to reroute', async () => {
    serve(card({}));
    const line = await screen.findByText('Product question → Mark');
    expect(line).toBeTruthy();
    expect(within(document.body).queryAllByRole('button', { name: /Ask Someone/ })).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();
  });
});

describe('a draft while the builder is not yet bound to Slack', () => {
  it('shows the Integrations callout instead of a message from You', async () => {
    const posted = serve(card({ text: "You's 10db build of *Demo* has a question for you." }), {
      ...BUILDER_PERSON,
      name: 'You',
    });
    expect(await screen.findByText(/Finish setting up Slack/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Integrations' }).getAttribute('href')).toBe(
      '/settings/integrations',
    );
    expect(screen.queryByText(/You's/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Send to Mark/ })).toBeNull();
    // The builder can still answer it themselves.
    expect(screen.getByRole('button', { name: 'Answer Myself' })).toBeTruthy();
    key('Enter', { metaKey: true });
    expect(posted).toEqual([]);
  });
});

describe('a card still being triaged', () => {
  it("says it is finding who answers and keeps today's options", async () => {
    serve(
      inboxItemDto({
        title: 'Which?',
        options: OPTIONS,
        routedBy: 'triage_pending',
        assignees: ['travis'],
      }),
    );
    expect(await screen.findByText('Finding who answers…')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Keep access for 7 days/ })).toBeTruthy();
  });
});
