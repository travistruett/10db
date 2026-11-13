import { mintId, TaskPlanContextDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { PlanContextDisclosure } from './plan-context-disclosure';

// The task drawer's Plan context: exactly the block its lane got, kept when it was packed, and the
// checks of the anchors it cites, Current only when found at the line.

const taskId = mintId('Task');
const PACKED = 'Your section (p1#task-12):\n## Task 12: Revoke a device\nRevoke it.  \n';

function context(over: Partial<TaskPlanContextDto>): TaskPlanContextDto {
  return TaskPlanContextDto.parse({
    context: { shapeId: mintId('Shape'), title: 'Remote host', ref: 'p1#task-12', revision: 1 },
    packed: { at: '2026-11-12T08:00:00.000Z', workstreamId: mintId('Workstream'), text: PACKED },
    checks: [
      {
        entryKey: 'f1',
        entryVersion: 1,
        anchorIndex: 0,
        result: 'moved',
        line: 2001,
        checkedCommit: '0123456789abcdef',
        note: null,
        workstreamId: mintId('Workstream'),
        at: '2026-11-12T08:00:00.000Z',
      },
      {
        entryKey: 'f2',
        entryVersion: 1,
        anchorIndex: 0,
        result: 'current',
        line: 18,
        checkedCommit: '0123456789abcdef',
        note: null,
        workstreamId: mintId('Workstream'),
        at: '2026-11-12T08:00:00.000Z',
      },
    ],
    ...over,
  });
}

const serve = (answer: TaskPlanContextDto) => {
  server.use(
    http.get(daemonUrl('/tasks/:taskId/plan-context'), () => HttpResponse.json(answer)),
    ...baseHandlers(),
  );
};

describe('PlanContextDisclosure', () => {
  it('the drawer shows what the lane got and its anchor checks', async () => {
    serve(context({}));
    renderWithDaemon(<PlanContextDisclosure taskId={taskId} />);
    const toggle = await screen.findByRole('button', {
      name: 'Plan context · p1#task-12 · revision 1',
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const sent = await screen.findByLabelText('What the lane got');
    // Byte for byte, its trailing spaces and newline included.
    expect(sent.textContent).toBe(PACKED);
    const moved = screen.getByText('f1 · anchor 1').closest('li');
    expect(moved?.textContent).toContain('Moved');
    expect(moved?.textContent).not.toContain('Current');
    expect(screen.getByText('f2 · anchor 1').closest('li')?.textContent).toContain('Current');
  });

  it('says Not sent yet before the lane was packed', async () => {
    serve(context({ packed: null, checks: [] }));
    renderWithDaemon(<PlanContextDisclosure taskId={taskId} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Plan context/ }));
    expect(await screen.findByText('Not sent yet')).toBeTruthy();
  });

  it('a task with no Plan has no disclosure', async () => {
    serve(TaskPlanContextDto.parse({ context: null, packed: null, checks: [] }));
    const { queryClient } = renderWithDaemon(<PlanContextDisclosure taskId={taskId} />);
    await waitFor(() => {
      expect(queryClient.getQueryState(['tasks', 'plan-context', taskId])?.status).toBe('success');
    });
    expect(screen.queryByRole('button', { name: /Plan context/ })).toBeNull();
  });
});
