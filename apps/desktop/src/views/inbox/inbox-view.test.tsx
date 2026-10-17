import type { InboxItemDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler, type WebSocketHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { inboxItemDto } from '../../test/fixtures';

function serve(...overrides: (RequestHandler | WebSocketHandler)[]): void {
  server.use(
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
  );
  server.use(...overrides);
}

/** Serves `items` as the open inbox and records every answer posted. */
function inbox(items: InboxItemDto[]): { answers: { id: string; body: unknown }[] } {
  const answers: { id: string; body: unknown }[] = [];
  serve(
    http.get(daemonUrl('/inbox'), () =>
      HttpResponse.json(items.filter((item) => !answers.some((a) => a.id === item.id))),
    ),
    http.post(daemonUrl('/inbox/:id/answer'), async ({ params, request }) => {
      const id = String(params['id']);
      answers.push({ id, body: await request.json() });
      const item = items.find((i) => i.id === id);
      return HttpResponse.json({ ...item, state: 'ANSWERED' });
    }),
  );
  return { answers };
}

const key = (k: string): void => {
  fireEvent.keyDown(document.body, { key: k });
};

const color = inboxItemDto({
  kind: 'question',
  title: 'Which badge color?',
  body: 'Color',
  options: [
    { label: 'Teal', description: 'Matches the theme' },
    { label: 'Red', description: 'Stands out' },
  ],
});
const corners = inboxItemDto({
  kind: 'question',
  title: 'Round or square corners?',
  body: '',
  options: [
    { label: 'Round', description: '' },
    { label: 'Square', description: '' },
  ],
});

describe('InboxView', () => {
  it('says so when the inbox is empty', async () => {
    inbox([]);
    renderApp('/inbox');
    expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy();
  });

  it('moves with j/k, chooses with a digit and sends with Enter', async () => {
    const { answers } = inbox([color, corners]);
    renderApp('/inbox');
    expect(await screen.findByText('Which badge color?')).toBeTruthy();
    expect(
      screen.getByText('j/k to move · 1–4 to choose · n to add a note · Enter to send'),
    ).toBeTruthy();

    key('j');
    expect(await screen.findByRole('radio', { name: /Square/ })).toBeTruthy();
    key('k');
    const red = await screen.findByRole('radio', { name: /Red/ });
    key('2');
    await waitFor(() => {
      expect(red.getAttribute('aria-checked')).toBe('true');
    });
    key('Enter');

    await waitFor(() => {
      expect(answers).toEqual([{ id: color.id, body: { choice: 'Red' } }]);
    });
    expect(await screen.findByRole('radio', { name: /Square/ })).toBeTruthy();
  });

  it('focuses the note with n and sends it with ⌘Enter', async () => {
    const { answers } = inbox([color]);
    renderApp('/inbox');
    await screen.findByText('Which badge color?');

    key('1');
    key('n');
    const note = screen.getByLabelText('Note for the agent (optional)');
    await waitFor(() => {
      expect(document.activeElement).toBe(note);
    });
    if (!(note instanceof HTMLTextAreaElement)) throw new Error('the note is not a textarea');
    expect(note.value).toBe('');
    fireEvent.change(note, { target: { value: 'Teal matches the logo' } });
    fireEvent.keyDown(note, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(answers).toEqual([
        { id: color.id, body: { choice: 'Teal', note: 'Teal matches the logo' } },
      ]);
    });
  });

  it('asks for a choice before sending', async () => {
    const { answers } = inbox([color]);
    renderApp('/inbox');
    await screen.findByText('Which badge color?');
    key('Enter');
    expect(await screen.findByText('Choose an option first (1–4).')).toBeTruthy();
    expect(answers).toEqual([]);
  });

  it('shows the four permission choices in words and sends the chosen value', async () => {
    const permission = inboxItemDto({
      kind: 'permission',
      title: 'Allow Bash?',
      body: 'curl -s https://example.com',
      category: 'environment',
      options: [
        { label: 'allow_once', description: 'Allow this call once' },
        { label: 'allow_workstream', description: 'Allow for the rest of this workstream' },
        {
          label: 'allow_project',
          description: 'Always allow in this project (records a decision)',
        },
        { label: 'deny', description: 'Deny; your note is passed to the agent' },
      ],
    });
    const { answers } = inbox([permission]);
    renderApp('/inbox');

    expect(await screen.findByText('curl -s https://example.com')).toBeTruthy();
    for (const name of [
      'Allow once',
      'Allow for this workstream',
      'Always allow in this project',
      'Deny',
    ]) {
      expect(screen.getByRole('radio', { name: new RegExp(`^\\d?\\s*${name}`) })).toBeTruthy();
    }
    expect(screen.getByText('Always allow in this project (records a decision)')).toBeTruthy();
    expect(screen.queryByText('allow_workstream')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /Allow for this workstream/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() => {
      expect(answers).toEqual([{ id: permission.id, body: { choice: 'allow_workstream' } }]);
    });
  });

  it('renders markup in a card as literal text', async () => {
    const hostile = inboxItemDto({
      kind: 'question',
      title: '<b>Bold</b> question',
      body: '<img src=x onerror=alert(1)>',
      options: [
        { label: '<script>x</script>', description: '<i>desc</i>' },
        { label: 'Plain', description: '' },
      ],
    });
    inbox([hostile]);
    renderApp('/inbox');

    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(screen.getByText('<b>Bold</b> question')).toBeTruthy();
    expect(screen.getByText('<script>x</script>')).toBeTruthy();
    expect(screen.getByText('<i>desc</i>')).toBeTruthy();
    expect(document.body.querySelector('img')).toBeNull();
    expect(document.body.querySelector('main b, main i, main script')).toBeNull();
  });

  it('dismisses a flag card, which has no options', async () => {
    const flag = inboxItemDto({
      kind: 'flag',
      title: 'Write outside every claim',
      body: 'docs/notes.md',
      options: [],
    });
    const { answers } = inbox([flag]);
    renderApp('/inbox');

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(answers).toEqual([{ id: flag.id, body: { choice: 'dismissed' } }]);
    });
  });

  it('explains a card answered elsewhere and refreshes the list', async () => {
    let gets = 0;
    serve(
      http.get(daemonUrl('/inbox'), () => {
        gets += 1;
        return HttpResponse.json([color]);
      }),
      http.post(daemonUrl('/inbox/:id/answer'), () =>
        HttpResponse.json(
          { error: 'conflict', message: `Inbox item ${color.id} is already ANSWERED` },
          { status: 409 },
        ),
      ),
    );
    renderApp('/inbox');
    await screen.findByText('Which badge color?');
    const getsBefore = gets;

    key('1');
    key('Enter');
    expect(await screen.findByText('This card was already answered.')).toBeTruthy();
    await waitFor(() => {
      expect(gets).toBeGreaterThan(getsBefore);
    });
  });

  it('selects a collapsed card when clicked', async () => {
    inbox([color, corners]);
    renderApp('/inbox');
    await screen.findByText('Which badge color?');

    const collapsed = screen.getByRole('button', { name: /Round or square corners\?/ });
    fireEvent.click(collapsed);
    const card = await screen.findByRole('radiogroup');
    expect(within(card).getByRole('radio', { name: /Square/ })).toBeTruthy();
  });
});
