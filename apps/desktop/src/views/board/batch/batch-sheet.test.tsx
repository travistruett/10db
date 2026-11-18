import { PickerProposalDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../../test/daemon';
import { candidate, projectViewDto, taskDto, workstreamDto } from '../../../test/fixtures';

const local = projectViewDto({ maxLanes: 2, gateCommand: 'make gate', delivery: 'local' });
const one = taskDto({ projectId: local.id, title: 'One', boardStatus: 'ready', boardOrder: 1 });
const two = taskDto({ projectId: local.id, title: 'Two', boardStatus: 'ready', boardOrder: 2 });

describe('BatchSheet', () => {
  it('in a local project, shows the proposal at the lane cap and starts each ticked task in order', async () => {
    const sizes: number[] = [];
    const sent: string[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([local])),
      http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([one, two])),
      http.get(daemonUrl('/projects/:projectId/candidates'), ({ request }) => {
        const size = Number(new URL(request.url).searchParams.get('size'));
        sizes.push(size);
        return HttpResponse.json(
          PickerProposalDto.parse({
            projectId: local.id,
            size,
            candidates: [
              candidate(one),
              candidate(two, {
                proposed: false,
                conflict: 'Area src is shared with One, picked before it',
              }),
            ],
          }),
        );
      }),
      http.post(daemonUrl('/tasks/:taskId/start'), ({ request, params }) => {
        sent.push(new URL(request.url).pathname);
        const taskId = String(params['taskId']) === one.id ? one.id : two.id;
        return HttpResponse.json(workstreamDto({ taskId, projectId: local.id }), { status: 201 });
      }),
      ...baseHandlers(),
    );
    renderApp('/board');
    fireEvent.click(await screen.findByRole('button', { name: 'More board actions' }));
    // The item is disabled until the tasks load, so wait for the count before clicking it.
    fireEvent.click(await screen.findByRole('menuitem', { name: /\d+ ready/, hidden: true }));
    const sheet = await screen.findByRole('dialog', { name: 'Start a batch' });

    expect(await within(sheet).findByRole('checkbox', { name: 'One' })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(sheet).getByRole('checkbox', { name: 'Two' })).toHaveProperty('checked', false);
    expect(within(sheet).getByText('Area src is shared with One, picked before it')).toBeTruthy();
    expect(within(sheet).getByText('make gate')).toBeTruthy();
    expect(within(sheet).getByText(/The PM review isn’t built yet/)).toBeTruthy();
    expect(within(sheet).queryByLabelText('Batch title')).toBeNull();
    // No ticked task names a page area, so none can go to the Workbench.
    expect(within(sheet).queryByRole('button', { name: 'Work on These' })).toBeNull();
    expect(sizes[0]).toBe(2);

    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Two' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Start 2 tasks' }));
    await waitFor(() => {
      expect(sent).toEqual([`/tasks/${one.id}/start`, `/tasks/${two.id}/start`]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Start a batch' })).toBeNull();
    });
  });
});
