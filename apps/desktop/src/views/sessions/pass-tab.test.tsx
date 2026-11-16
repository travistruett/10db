import { mintId, type PassViewDto } from '@10db/contracts';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseHandlers, renderWithDaemonAndRouter, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { pagesByStatus, PASS_NOW, passHandlers, passViewDto } from '../../test/pass-fixtures';
import { taskSessionDto, taskSessionHandlers } from '../../test/task-session-fixtures';
import { PassTab } from './pass-tab';

// A task in Your folder is a pass of one: its tab carries the Workbench's page controls and the pass's
// own close, and reads its pass's label for the whole project.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(PASS_NOW) });
});

afterEach(() => {
  vi.useRealTimers();
});

const { ready } = pagesByStatus();

async function renderTab(view: PassViewDto) {
  const page = view.pages[0];
  if (page === undefined) throw new Error('a pass of one has its page');
  const session = taskSessionDto({
    taskId: page.taskId,
    title: 'Fix the settings page',
    place: 'pass',
    branch: null,
    passId: view.pass.id,
    conversationId: page.conversationId,
  });
  server.use(
    ...passHandlers({ live: [view] }),
    ...taskSessionHandlers([session]),
    ...baseHandlers(),
  );
  await renderWithDaemonAndRouter(
    <PassTab session={session} project={projectViewDto({ id: view.pass.projectId })} />,
  );
}

const variant = (name: string): string | null =>
  screen.getByRole('button', { name }).getAttribute('data-variant');

describe('a pass of one’s tab', () => {
  it('names where it lands, and makes Sign Off the primary until something is typed', async () => {
    await renderTab(passViewDto({ pages: [ready] }));
    expect(await screen.findByText(/Task · Your folder · lands on/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close Pass…' })).toBeNull();
    expect(variant('Sign Off')).toBe('filled');
    fireEvent.change(screen.getByRole('textbox', { name: /Message to/ }), {
      target: { value: 'Make it blue' },
    });
    expect(variant('Send')).toBe('filled');
    expect(variant('Sign Off')).toBe('default');
  });

  it('offers Close Pass… once signed off, filled when nothing works, and opens the pass’s close', async () => {
    await renderTab(passViewDto({ pages: [{ ...ready, signOff: 'done' }] }));
    const close = await screen.findByRole('button', { name: 'Close Pass…' });
    expect(close.getAttribute('data-variant')).toBe('filled');
    fireEvent.click(close);
    expect(await screen.findByRole('dialog', { name: 'Finish' })).toBeTruthy();
  });

  it('keeps Abandon Pass… in the ⋯ menu, with the pass’s confirm', async () => {
    await renderTab(passViewDto({ pages: [ready] }));
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Abandon Pass…/ }));
    expect(await screen.findByRole('dialog', { name: 'Abandon' })).toBeTruthy();
  });

  it.each([
    { name: 'finished', board: 'done', line: 'Done · this task’s pass has finished.' },
    {
      name: 'abandoned',
      board: 'ready',
      line: 'Abandoned · its unfinished changes wait on this task on the Board.',
    },
  ])('says a pass that is gone is $name', async ({ board, line }) => {
    const session = taskSessionDto({ place: 'pass', branch: null, passId: mintId('Pass'), board });
    server.use(...passHandlers({ live: [] }), ...baseHandlers());
    await renderWithDaemonAndRouter(<PassTab session={session} project={projectViewDto()} />);
    expect(await screen.findByText(line)).toBeTruthy();
  });

  it('keeps loading, not saying Done, while a running task’s pass is not in the live list yet', async () => {
    const session = taskSessionDto({ place: 'pass', branch: null, passId: mintId('Pass') });
    server.use(...passHandlers({ live: [] }), ...baseHandlers());
    await renderWithDaemonAndRouter(<PassTab session={session} project={projectViewDto()} />);
    expect(await screen.findByRole('status', { name: 'Loading the task' })).toBeTruthy();
    expect(screen.queryByText(/Done ·/)).toBeNull();
  });

  it('shows a closed pass’s line instead of the composer', async () => {
    await renderTab(
      passViewDto({ pass: { state: 'CLOSED' }, pages: [{ ...ready, signOff: 'done' }] }),
    );
    expect(await screen.findByText(/Settings pass finished/)).toBeTruthy();
  });
});
