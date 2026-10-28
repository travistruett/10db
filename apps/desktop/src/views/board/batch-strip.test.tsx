import { mintId, type BatchDto, type WorkstreamDto } from '@10db/contracts';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { batchDto, taskDto, workstreamDto } from '../../test/fixtures';
import { BatchStrip } from './batch-strip';

const batch = batchDto();
const member = (taskTitle: string, state: WorkstreamDto['state']) =>
  workstreamDto({ batchId: batch.id, projectId: batch.projectId, taskTitle, state });

describe('BatchStrip', () => {
  it.each<{
    name: string;
    batch: BatchDto;
    workstreams: WorkstreamDto[];
    texts: string[];
    absent?: string[];
    buttons: string[];
    link?: string;
  }>([
    {
      name: 'cutting',
      batch: batchDto({ state: 'CUTTING', branch: null, baseSha: null }),
      workstreams: [],
      texts: ['Greetings', 'Cutting branch'],
      buttons: [],
    },
    {
      name: 'open with work running',
      batch,
      workstreams: [member('Alpha', 'RUNNING'), member('Beta', 'DONE')],
      texts: ['Open', '10db/greetings-0a1b2c3d', 'Alpha', 'Running'],
      absent: ['Beta'],
      buttons: ['Abandon'],
    },
    {
      name: 'open with a failed workstream',
      batch,
      workstreams: [member('Alpha', 'FAILED'), member('Beta', 'DONE')],
      texts: ['Alpha', 'Failed'],
      absent: ['Beta'],
      buttons: ['Ship anyway', 'Abandon'],
    },
    {
      name: 'open with every member settled',
      batch,
      workstreams: [member('Alpha', 'DONE'), member('Beta', 'CANCELLED')],
      texts: ['Open'],
      absent: ['Alpha', 'Beta'],
      buttons: ['Abandon'],
    },
    {
      name: 'shipping',
      batch: batchDto({ state: 'SHIPPING' }),
      workstreams: [],
      texts: ['Shipping'],
      buttons: [],
    },
    {
      name: 'shipped',
      batch: batchDto({ state: 'SHIPPED', prUrl: 'https://github.com/acme/widgets/pull/7' }),
      workstreams: [],
      texts: ['Shipped'],
      buttons: [],
      link: 'https://github.com/acme/widgets/pull/7',
    },
    {
      name: 'closed',
      batch: batchDto({ state: 'CLOSED' }),
      workstreams: [],
      texts: ['Closed: no changes'],
      buttons: [],
    },
    {
      name: 'failed',
      batch: batchDto({ state: 'FAILED', failure: 'gate_failed' }),
      workstreams: [member('Alpha', 'DONE')],
      texts: ['Not shipped', 'The gate failed'],
      buttons: ['Retry', 'Abandon'],
    },
    {
      name: 'failed with unfinished work',
      batch: batchDto({ ...batch, state: 'FAILED', failure: 'wrong_branch' }),
      workstreams: [member('Alpha', 'QUEUED'), member('Beta', 'DONE')],
      texts: ['Not shipped', 'The checkout is not on the batch branch', 'Alpha', 'Queued'],
      absent: ['Beta'],
      buttons: ['Retry', 'Abandon'],
    },
    {
      name: 'abandoned',
      batch: batchDto({ state: 'ABANDONED' }),
      workstreams: [],
      texts: ['Abandoned'],
      buttons: [],
    },
  ])('$name', async ({ batch: b, workstreams, texts, absent = [], buttons, link }) => {
    server.use(...baseHandlers());
    renderWithDaemon(<BatchStrip batch={b} workstreams={workstreams} />);
    for (const text of texts) expect(await screen.findByText(text)).toBeTruthy();
    for (const text of absent) expect(screen.queryByText(text)).toBeNull();
    expect(screen.queryAllByRole('button').map((x) => x.textContent)).toEqual(buttons);
    if (link)
      expect(screen.getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe(link);
  });
});

describe('BatchStrip actions', () => {
  const failed = batchDto({ state: 'FAILED', failure: 'gate_failed' });
  const refusal = (message: string) =>
    HttpResponse.json({ error: 'conflict', message }, { status: 409 });

  it.each([
    {
      name: 'a refused Retry once Abandon succeeds',
      first: 'Retry',
      then: 'Abandon',
      ship: () => refusal('Batch "Greetings" is shipping'),
      abandon: () => HttpResponse.json({ ...failed, state: 'ABANDONED' }),
      stale: 'Batch "Greetings" is shipping',
    },
    {
      name: 'a refused Abandon once Retry succeeds',
      first: 'Abandon',
      then: 'Retry',
      ship: () => HttpResponse.json({ ...failed, state: 'SHIPPING', failure: null }),
      abandon: () => refusal('Batch "Greetings" is shipped'),
      stale: 'Batch "Greetings" is shipped',
    },
  ])('clears $name', async ({ first, then, ship, abandon, stale }) => {
    server.use(
      http.post(daemonUrl('/batches/:batchId/ship'), ship),
      http.post(daemonUrl('/batches/:batchId/abandon'), abandon),
      ...baseHandlers(),
    );
    renderWithDaemon(<BatchStrip batch={failed} workstreams={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: first }));
    expect(await screen.findByText(stale)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: then }));
    await waitFor(() => {
      expect(screen.queryByText(stale)).toBeNull();
    });
  });
});

describe('BatchStrip pull request link', () => {
  const url = 'https://github.com/acme/widgets/pull/7';
  const shipped = batchDto({ state: 'SHIPPED', prUrl: url });
  afterEach(() => {
    clearMocks();
    // clearMocks leaves the internals object behind, which would make later tests look like the desktop app.
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('is a plain link to a new tab in a browser', async () => {
    server.use(...baseHandlers());
    renderWithDaemon(<BatchStrip batch={shipped} workstreams={[]} />);
    const link = await screen.findByRole('link', { name: 'Pull request' });
    expect(link.getAttribute('href')).toBe(url);
    expect(link.getAttribute('target')).toBe('_blank');
    // Not prevented: the browser follows the link itself.
    expect(fireEvent.click(link)).toBe(true);
  });

  it('opens in the default browser through the opener plugin in the desktop app', async () => {
    const opened: unknown[] = [];
    mockIPC((cmd, payload) => {
      if (cmd === 'plugin:opener|open_url') opened.push(payload);
    });
    server.use(...baseHandlers());
    renderWithDaemon(<BatchStrip batch={shipped} workstreams={[]} />);
    // The webview would follow nothing, so the click is the opener's.
    expect(fireEvent.click(await screen.findByRole('link', { name: 'Pull request' }))).toBe(false);
    await waitFor(() => {
      expect(opened).toEqual([{ url }]);
    });
  });

  it('says why when the desktop app cannot open the link', async () => {
    mockIPC((cmd) => {
      // The real plugin rejects with a string, for example when the URL is outside the capability's scope.
      if (cmd === 'plugin:opener|open_url') return Promise.reject(new Error('not allowed'));
      return undefined;
    });
    server.use(...baseHandlers());
    renderWithDaemon(<BatchStrip batch={shipped} workstreams={[]} />);
    fireEvent.click(await screen.findByRole('link', { name: 'Pull request' }));
    expect(await screen.findByText(`Couldn't open ${url}: not allowed`)).toBeTruthy();
  });
});

describe('BatchStrip in worktree mode', () => {
  const path = '/Users/me/.10db/worktrees/abc/bat_1';
  const open = batchDto({ worktreePath: path });

  it('shows the worktree path', async () => {
    server.use(...baseHandlers());
    renderWithDaemon(<BatchStrip batch={open} workstreams={[]} workspaceMode="worktree" />);
    expect(await screen.findByText(path)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy worktree path' })).toBeTruthy();
  });

  it('offers no fix task on a batch that is shipping', async () => {
    server.use(...baseHandlers());
    renderWithDaemon(
      <BatchStrip
        batch={batchDto({ state: 'SHIPPING', worktreePath: path })}
        workstreams={[]}
        workspaceMode="worktree"
      />,
    );
    await screen.findByText(path);
    expect(screen.queryByRole('button', { name: 'Add a fix task' })).toBeNull();
  });

  it('Add a fix task posts the batch id', async () => {
    const parked = taskDto({ projectId: open.projectId, title: 'Parked', boardColumnId: null });
    const free = taskDto({ projectId: open.projectId, title: 'Free' });
    const running = taskDto({ projectId: open.projectId, title: 'Running' });
    const active = workstreamDto({ taskId: running.id, projectId: open.projectId });
    const sent: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects/:projectId/tasks'), () =>
        HttpResponse.json([
          free,
          { ...parked, boardColumnId: mintId('BoardColumn') },
          { ...running, workstreamId: active.id },
        ]),
      ),
      http.post(daemonUrl('/projects/:projectId/batches'), async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json([open], { status: 202 });
      }),
      ...baseHandlers(),
    );
    renderWithDaemon(<BatchStrip batch={open} workstreams={[active]} workspaceMode="worktree" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a fix task' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a fix task' });
    const select = await within(dialog).findByLabelText('Task');
    fireEvent.click(select);
    const options = await screen.findAllByRole('option', { hidden: true });
    expect(options.map((o) => o.textContent)).toEqual(['Free']);
    fireEvent.click(options[0] ?? document.body);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add fix task' }));
    await waitFor(() => {
      expect(sent).toEqual([{ title: open.title, taskIds: [free.id], batchId: open.id }]);
    });
  });
});
