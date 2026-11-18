import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { baseHandlers, renderWithDaemon, server } from '../../test/daemon';
import { batchDto, taskDto, workstreamDto } from '../../test/fixtures';
import { TaskDrawer } from './task-drawer';

const peers = new Map();

interface Opts {
  readonly task?: Parameters<typeof taskDto>[0];
  readonly workstream?: ReturnType<typeof workstreamDto>;
  readonly batch?: ReturnType<typeof batchDto>;
  readonly workstreams?: ReturnType<typeof workstreamDto>[];
}

function open(opts: Opts = {}): void {
  renderWithDaemon(
    <TaskDrawer
      task={taskDto({ workstreamId: opts.workstream?.id ?? null, ...opts.task })}
      columnName="Ready"
      peers={peers}
      {...(opts.workstream ? { workstream: opts.workstream } : {})}
      {...(opts.batch ? { batch: opts.batch } : {})}
      {...(opts.workstreams ? { workstreams: opts.workstreams } : {})}
      onClose={() => undefined}
    />,
  );
}

/** The element's position relative to the other, as the document orders them. */
function follows(before: HTMLElement, after: HTMLElement): boolean {
  return (before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('TaskDrawer', () => {
  const FIFO = 'Reject FIFOs in the worktree walk';
  const withHeadline = {
    title: FIFO,
    headline: "Odd files can't freeze 10db",
    why: 'A FIFO could hang every lane.',
    acceptanceCriteria: ['A FIFO is skipped', 'A huge file is skipped'],
  };

  it('opens on Overview: headline and why, one status line, the tabs, then what it promises and the shared branch', async () => {
    server.use(...baseHandlers());
    const batch = batchDto({ prUrl: 'https://github.com/acme/widgets/pull/9' });
    const ws = workstreamDto({ batchId: batch.id, state: 'QUEUED' });
    const second = workstreamDto({ batchId: batch.id, state: 'QUEUED' });
    open({ task: withHeadline, workstream: ws, batch, workstreams: [ws, second] });
    const d = await screen.findByRole('dialog', { name: 'Task' });
    const headline = within(d).getByRole('heading', { name: "Odd files can't freeze 10db" });
    const why = within(d).getByText('A FIFO could hang every lane.');
    const status = within(d).getByTestId('status-line');
    expect(within(status).getByRole('link', { name: 'Pull request' })).toBeTruthy();
    const tabs = within(d).getByRole('tablist');
    const promises = within(d).getByText('What it promises');
    const title = within(d).getByText(FIFO);
    const abandon = within(d).getByRole('button', { name: 'Abandon' });
    expect(within(status).getByText('Queued')).toBeTruthy();
    expect(
      within(d)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['A FIFO is skipped', 'A huge file is skipped']);
    const inOrder = [headline, why, status, tabs, promises, title, abandon];
    for (let i = 1; i < inOrder.length; i += 1) {
      const before = inOrder[i - 1];
      const after = inOrder[i];
      expect(
        before && after && follows(before, after),
        `element ${String(i)} follows element ${String(i - 1)}`,
      ).toBe(true);
    }
    // The pull request link is on the status line alone: not again in the shared branch.
    expect(within(d).getAllByRole('link', { name: 'Pull request' })).toHaveLength(1);
    // The form is on the Edit tab, and the tab selected is Overview.
    expect(within(d).getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(within(d).queryByLabelText('Title')).toBeNull();
  });
});
