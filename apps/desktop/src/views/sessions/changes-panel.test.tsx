import {
  mintId,
  WorkstreamChangesDto,
  type PassViewDto,
  type TaskSessionDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemonAndRouter, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { pagesByStatus, PASS_NOW, passHandlers, passViewDto } from '../../test/pass-fixtures';
import { taskSessionDto, taskSessionHandlers } from '../../test/task-session-fixtures';
import { resetWindowWidth, windowWidth } from '../../test/window-width';
import { TaskTab } from './task-tab';
import { TaskTabPlace } from './task-tabs';

// A task's tab reads its workstream's changes: the bar says how much, ⌘⇧D or a click opens the panel
// beside the thread, and a line number quotes the line into the composer.

const DIFF = [
  'diff --git a/src/api/client.ts b/src/api/client.ts',
  '--- a/src/api/client.ts',
  '+++ b/src/api/client.ts',
  '@@ -42,2 +42,2 @@',
  ' keep',
  '-if (res.status === 401) {',
  '+if (res.status === 401 && req.retried) {',
  '',
].join('\n');

function changesDto(): WorkstreamChangesDto {
  return WorkstreamChangesDto.parse({
    baseHead: '4e1a9c2'.padEnd(40, '0'),
    head: 'b'.repeat(40),
    commits: ['c'.repeat(40)],
    diff: DIFF,
    truncated: false,
    files: [{ path: 'src/api/client.ts', added: 41, removed: 6 }],
  });
}

const { ready } = pagesByStatus();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(PASS_NOW) });
});
afterEach(() => {
  vi.useRealTimers();
  resetWindowWidth();
});

interface Served {
  readonly scopes: string[];
}

async function renderTask(options: {
  readonly view?: PassViewDto;
  readonly session?: Partial<TaskSessionDto>;
  readonly changes?: () => Response;
}): Promise<Served> {
  const view = options.view ?? passViewDto({ pages: [ready] });
  const page = view.pages[0];
  if (page === undefined) throw new Error('a pass of one has its page');
  const session = taskSessionDto({
    taskId: page.taskId,
    title: 'Fix the settings page',
    place: 'pass',
    branch: null,
    passId: view.pass.id,
    conversationId: page.conversationId,
    workstreamId: page.workstreamId,
    ...options.session,
  });
  const scopes: string[] = [];
  server.use(
    http.get(daemonUrl('/workstreams/:id/changes'), ({ request }) => {
      scopes.push(new URL(request.url).searchParams.get('scope') ?? '');
      return options.changes?.() ?? HttpResponse.json(changesDto());
    }),
    ...passHandlers({ live: [view] }),
    ...taskSessionHandlers([session]),
    ...baseHandlers(),
  );
  const project = projectViewDto({ id: view.pass.projectId });
  await renderWithDaemonAndRouter(
    <TaskTab
      tab={{
        taskId: session.taskId,
        projectId: project.id,
        title: session.title,
        place: TaskTabPlace.Pass,
        position: 0,
      }}
      project={project}
    />,
  );
  return { scopes };
}

describe('a task’s Changes', () => {
  it('says how much changed in the bar, and opens the panel on a click', async () => {
    windowWidth(900);
    await renderTask({});
    const button = await screen.findByRole('button', { name: /^Changes\s*\+41\s*−6/ });
    expect(screen.queryByRole('complementary', { name: 'Changes' })).toBeNull();
    fireEvent.click(button);
    const panel = await screen.findByRole('complementary', { name: 'Changes' });
    expect(within(panel).getAllByText('src/api/client.ts').length).toBeGreaterThan(0);
  });

  it('opens by itself once at 1100 px, then keeps the builder’s choice', async () => {
    windowWidth(1200);
    await renderTask({});
    expect(await screen.findByRole('complementary', { name: 'Changes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Changes/ }));
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Changes' })).toBeNull();
    });
  });

  it('asks for the last turn when Last Turn is picked, and ⌘⇧D toggles the panel', async () => {
    windowWidth(900);
    const served = await renderTask({});
    await screen.findByRole('button', { name: /^Changes/ });
    fireEvent.keyDown(document.body, { key: 'D', metaKey: true, shiftKey: true });
    const panel = await screen.findByRole('complementary', { name: 'Changes' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Last Turn' }));
    await waitFor(() => {
      expect(served.scopes).toContain('last');
    });
    fireEvent.keyDown(document.body, { key: 'D', metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Changes' })).toBeNull();
    });
  });

  it('quotes a clicked line into the composer', async () => {
    windowWidth(900);
    await renderTask({});
    fireEvent.click(await screen.findByRole('button', { name: /^Changes/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Quote line 42 of src/api/client.ts' }),
    );
    const box = await screen.findByRole('textbox', { name: /Message to/ });
    expect(box).toHaveProperty('value', expect.stringContaining('@src/api/client.ts:42'));
  });

  it('says a finished copy is gone and points at its pull request', async () => {
    windowWidth(900);
    await renderTask({
      session: {
        place: 'copy',
        passId: null,
        board: 'in_review',
        branch: '10db/x',
        workstreamId: mintId('Workstream'),
        pullRequest: { url: 'https://github.com/o/r/pull/5', state: 'open' },
      },
      changes: () =>
        HttpResponse.json({ error: 'not_found', message: 'No checkout' }, { status: 404 }),
    });
    await screen.findByRole('button', { name: /^Changes/ });
    fireEvent.keyDown(document.body, { key: 'D', metaKey: true, shiftKey: true });
    expect(
      await screen.findByText('This task’s copy is gone. Its pull request has the changes.'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('complementary', { name: 'Changes' })).getByRole('link', {
        name: 'Open Pull Request',
      }),
    ).toBeTruthy();
  });
});
