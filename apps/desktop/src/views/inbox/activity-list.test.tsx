import { mintId } from '@10db/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { activityRowDto, serveActivity } from '../../test/activity-fixtures';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { daemonEvent } from '../../test/fixtures';
import { lastInboxSearch, rememberScroll, rememberSelected } from './inbox-search';

const sockets: { send(data: string): void }[] = [];

function serve(rows: ReturnType<typeof activityRowDto>[]) {
  server.use(
    eventStream.addEventListener('connection', ({ client }) => {
      sockets.push(client);
    }),
    ...baseHandlers(),
  );
  // After the base handlers, whose empty page it replaces.
  return serveActivity(rows);
}

afterEach(() => {
  sockets.length = 0;
  lastInboxSearch.set({});
  for (const state of ['open', 'waiting', 'resolved', 'activity'] as const) {
    rememberSelected(state, null);
    rememberScroll(state, 0);
  }
});

const rows = (): HTMLElement[] =>
  within(screen.getByRole('listbox', { name: 'Activity' })).queryAllByRole('option');

const findRow = (text: string): Promise<HTMLElement> =>
  waitFor(() => {
    const row = rows().find((candidate) => candidate.textContent.includes(text));
    if (row === undefined) throw new Error(`no row holds ${text}`);
    return row;
  });

const switchBar = () => within(screen.getByRole('radiogroup', { name: 'Inbox state' }));

describe('Activity in the Inbox', () => {
  it('is a fourth item with no count, though notices exist', async () => {
    serve([activityRowDto(), activityRowDto()]);
    renderApp('/inbox');
    await screen.findByRole('radiogroup', { name: 'Inbox state' });
    expect(
      ['Open', 'Waiting', 'Resolved', 'Activity'].map((name) => switchBar().getByText(name)).length,
    ).toBe(4);
    fireEvent.click(switchBar().getByRole('radio', { name: 'Activity' }));
    await findRow('Something happened');
    expect(switchBar().getByText('Activity').parentElement?.textContent).toBe('Activity');
  });

  it('lists notices, and a selected grouped one shows its body, its span and Open Task', async () => {
    const taskId = mintId('Task');
    const projectId = mintId('Project');
    serve([
      activityRowDto({
        projectId,
        taskId,
        tone: 'warning',
        line: 'Task "Add badge" was resized',
        body: 'It grew from small to large.\nSecond line.',
        count: 3,
        firstAt: '2026-10-13T12:00:00.000Z',
        at: '2026-10-13T12:08:00.000Z',
      }),
      activityRowDto({ line: 'Your folder stays on main', projectId: null }),
    ]);
    renderApp('/inbox?state=activity');
    const row = await findRow('Task "Add badge" was resized');
    expect(row.textContent).toContain('NOTICE');
    expect(row.textContent).toContain('×3');
    const plain = await findRow('Your folder stays on main');
    expect(plain.textContent).toContain('10db');
    fireEvent.click(row);
    const content = await screen.findByTestId('activity-content');
    expect(content.textContent).toContain('It grew from small to large.');
    expect(content.textContent).toMatch(/3 times, from .* to /);
    const link = within(content).getByRole('link', { name: 'Open Task' });
    expect(link.getAttribute('href')).toBe(`/board?task=${taskId}`);
    expect(within(content).queryByRole('button', { name: /Dismiss/ })).toBeNull();
  });

  it('says nothing has happened on an empty page', async () => {
    serve([]);
    renderApp('/inbox?state=activity');
    expect(await screen.findByText('Nothing has happened yet')).toBeTruthy();
  });

  it('sends the search text, and an empty answer says no matches', async () => {
    const asked = serve([activityRowDto({ line: 'Branch deleted' })]);
    renderApp('/inbox?state=activity&q=zzz');
    expect(await screen.findByText('No matches')).toBeTruthy();
    expect(asked.some((query) => query['q'] === 'zzz')).toBe(true);
    expect(rows()).toHaveLength(0);
  });

  it('refetches on a notice.posted event and shows the new row', async () => {
    const notices = [activityRowDto({ line: 'First notice' })];
    const asked = serve(notices);
    renderApp('/inbox?state=activity');
    await findRow('First notice');
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const before = asked.length;
    notices.push(activityRowDto({ line: 'Second notice' }));
    act(() => {
      sockets[0]?.send(
        JSON.stringify(
          daemonEvent({
            seq: 1,
            type: 'notice.posted',
            entityType: 'app',
            entityId: 'app',
          }),
        ),
      );
    });
    await findRow('Second notice');
    expect(asked.length).toBeGreaterThan(before);
    expect(rows()).toHaveLength(2);
  });

  it('sends no request for e on a row', async () => {
    serve([activityRowDto({ line: 'Only notice' })]);
    const posts: string[] = [];
    server.use(
      http.post(daemonUrl('/inbox/:id/dismiss'), ({ params }) => {
        posts.push(String(params['id']));
        return HttpResponse.json({});
      }),
    );
    renderApp('/inbox?state=activity');
    const row = await findRow('Only notice');
    row.focus();
    fireEvent.keyDown(row, { key: 'e' });
    fireEvent.keyDown(document.body, { key: 'e' });
    expect(posts).toEqual([]);
  });
});
