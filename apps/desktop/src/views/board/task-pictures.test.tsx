import { mintId, TaskScreensDto } from '@10db/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { taskScreenDto } from '../../test/pass-fixtures';
import { TaskPictures } from './task-pictures';

// Workbench spec §10 "Where they show": a task's drawer shows each page's before beside its after.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const taskId = mintId('Task');

function serve(screens: ReturnType<typeof taskScreenDto>[]) {
  server.use(
    http.get(daemonUrl('/tasks/:taskId/screens'), () =>
      HttpResponse.json(TaskScreensDto.parse({ taskId, screens, fromGoal: [] })),
    ),
    http.get(
      daemonUrl('/screens/:screenId'),
      () => new HttpResponse(PNG, { headers: { 'content-type': 'image/png' } }),
    ),
    ...baseHandlers(),
  );
}

describe('TaskPictures', () => {
  it('shows before beside after per route, viewport and theme, and says when there is no before', async () => {
    serve([
      taskScreenDto({ taskId, route: '/people', kind: 'before' }),
      taskScreenDto({ taskId, route: '/people', kind: 'turn', turnSeq: 1, sha256: 'b'.repeat(64) }),
      taskScreenDto({ taskId, route: '/people', kind: 'after', sha256: 'c'.repeat(64) }),
      taskScreenDto({
        taskId,
        route: '/people',
        kind: 'after',
        theme: 'dark',
        sha256: 'd'.repeat(64),
      }),
    ]);
    renderWithDaemon(<TaskPictures taskId={taskId} />);
    const people = await screen.findByRole('group', { name: '/people, 1440 by 900' });
    await waitFor(() => {
      expect(
        within(people)
          .getAllByRole('img')
          .map((img) => img.getAttribute('alt')),
      ).toEqual(['/people before, 1440 by 900', '/people after sign-off, 1440 by 900']);
    });
    const dark = screen.getByRole('group', { name: '/people, 1440 by 900, dark theme' });
    expect(within(dark).getByText('No before picture')).toBeTruthy();
    expect((await within(dark).findAllByRole('img')).map((img) => img.getAttribute('alt'))).toEqual(
      ['/people after sign-off, 1440 by 900, dark theme'],
    );
  });
});
