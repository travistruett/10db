import { toTaskRow, type BoardColumnDto, type TaskDto } from '@10db/contracts';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { boardColumnDto, projectDto, taskDto } from '../../test/fixtures';
import { SYSTEM_HINT } from '../board/column-hints';

const project = projectDto();
const icebox = boardColumnDto({ projectId: project.id, name: 'Icebox', position: 0 });
const exploring = boardColumnDto({ projectId: project.id, name: 'Exploring', position: 1 });

function serve(columns: BoardColumnDto[], tasks: TaskDto[]) {
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json(columns)),
    http.get(daemonUrl('/projects/:projectId/tasks'), () =>
      HttpResponse.json(tasks.map(toTaskRow)),
    ),
    ...baseHandlers(),
  );
  renderApp('/settings/board-columns');
}

describe('BoardColumnsSection', () => {
  it('lists the state columns after yours, dimmed, with counts and their hint, and no arrows', async () => {
    serve(
      [icebox, exploring],
      [
        taskDto({ projectId: project.id, title: 'Idea', boardColumnId: icebox.id }),
        taskDto({
          projectId: project.id,
          title: 'Next',
          boardColumnId: null,
          boardStatus: 'ready',
        }),
      ],
    );
    const table = await screen.findByRole('table', { name: 'Board columns' });
    await within(table).findByText('Exploring');
    const rows = within(table).getAllByRole('row').slice(1);
    const names = rows.map((r) => within(r).getAllByRole('cell')[1]?.textContent);
    expect(names).toEqual([
      'Icebox',
      'Exploring',
      `Backlog${SYSTEM_HINT.backlog}`,
      `Ready${SYSTEM_HINT.ready}`,
      `In progress${SYSTEM_HINT.in_progress}`,
      `In review${SYSTEM_HINT.in_review}`,
      `Blocked${SYSTEM_HINT.blocked}`,
      `Done${SYSTEM_HINT.done}`,
    ]);
    const ready = rows[3];
    if (!ready) throw new Error('no Ready row');
    expect(within(ready).getAllByRole('cell')[2]?.textContent).toBe('1');
    expect(within(ready).queryAllByRole('button')).toEqual([]);
    expect(ready.getAttribute('style')).toContain('dimmed');
    expect(within(rows[0] ?? ready).getAllByRole('cell')[2]?.textContent).toBe('1');
  });
});
