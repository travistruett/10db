import type { BoardColumnDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { boardColumnDto, projectDto, taskDto } from '../../test/fixtures';
import { HUMAN_HINT, SYSTEM_HINT } from '../board/column-hints';

const project = projectDto();
const icebox = boardColumnDto({ projectId: project.id, name: 'Icebox', position: 0 });
const exploring = boardColumnDto({ projectId: project.id, name: 'Exploring', position: 1 });

function serve(
  columns: BoardColumnDto[],
  tasks = [taskDto({ projectId: project.id, title: 'Idea', boardColumnId: icebox.id })],
) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const record = async (method: string, request: Request) => {
    sent.push({ method, path: new URL(request.url).pathname, body: await request.json() });
  };
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json(columns)),
    http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(tasks)),
    http.post(daemonUrl('/projects/:projectId/board-columns'), async ({ request }) => {
      await record('POST', request);
      return HttpResponse.json(
        boardColumnDto({ projectId: project.id, name: 'Needs spec', position: 2 }),
        { status: 201 },
      );
    }),
    http.patch(daemonUrl('/board-columns/:columnId'), async ({ request }) => {
      await record('PATCH', request);
      return HttpResponse.json(columns);
    }),
    http.post(daemonUrl('/board-columns/:columnId/delete'), async ({ request }) => {
      await record('DELETE', request);
      return HttpResponse.json(
        columns.filter((c) => !new URL(request.url).pathname.includes(c.id)),
      );
    }),
    ...baseHandlers(),
  );
  renderApp('/settings/board-columns');
  return sent;
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
      `Icebox${HUMAN_HINT}`,
      `Exploring${HUMAN_HINT}`,
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

  it('your columns lead with up and down arrows', async () => {
    serve([icebox, exploring]);
    const table = await screen.findByRole('table', { name: 'Board columns' });
    const row = (await within(table).findByText('Exploring')).closest('tr');
    if (!row) throw new Error('no row');
    const first = within(row).getAllByRole('cell')[0];
    if (!first) throw new Error('no first cell');
    expect(within(first).getByRole('button', { name: 'Move Exploring up' })).toBeTruthy();
    expect(within(first).getByRole('button', { name: 'Move Exploring down' })).toBeTruthy();
  });

  it('adds a column', async () => {
    const sent = serve([icebox]);
    fireEvent.change(await screen.findByLabelText('New column'), {
      target: { value: 'Needs spec' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Column' }));
    await waitFor(() => {
      expect(sent).toEqual([
        {
          method: 'POST',
          path: `/projects/${project.id}/board-columns`,
          body: { name: 'Needs spec' },
        },
      ]);
    });
  });

  it('adds a name padded past 40 characters, limited after cleanup as the daemon does', async () => {
    const sent = serve([icebox]);
    fireEvent.change(await screen.findByLabelText('New column'), {
      target: { value: `Needs spec${' '.repeat(31)}` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Column' }));
    await waitFor(() => {
      expect(sent).toEqual([
        {
          method: 'POST',
          path: `/projects/${project.id}/board-columns`,
          body: { name: 'Needs spec' },
        },
      ]);
    });
  });

  it("shows the daemon's message for a duplicate name", async () => {
    serve([icebox]);
    // The latest server.use wins, so this refusal overrides serve()'s create handler.
    server.use(
      http.post(daemonUrl('/projects/:projectId/board-columns'), () =>
        HttpResponse.json(
          { error: 'conflict', message: 'This project already has a column named "Icebox"' },
          { status: 409 },
        ),
      ),
    );
    fireEvent.change(await screen.findByLabelText('New column'), { target: { value: 'Icebox' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Column' }));
    expect(
      await screen.findByText('This project already has a column named "Icebox"'),
    ).toBeTruthy();
  });

  it('renames a column and moves it down, and offers no move up for the first', async () => {
    const sent = serve([icebox, exploring]);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Icebox' }));
    fireEvent.change(screen.getByLabelText('Name for Icebox'), { target: { value: 'Someday' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Name' }));
    expect(screen.getByRole('button', { name: 'Move Icebox up' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Move Icebox down' }));
    await waitFor(() => {
      expect(sent).toEqual([
        { method: 'PATCH', path: `/board-columns/${icebox.id}`, body: { name: 'Someday' } },
        { method: 'PATCH', path: `/board-columns/${icebox.id}`, body: { position: 1 } },
      ]);
    });
  });

  it.each([
    { name: 'an empty name', typed: '', message: 'Enter a name' },
    { name: 'only spaces', typed: '   ', message: 'Enter a name' },
    { name: 'a 41-character name', typed: 'x'.repeat(41), message: 'Use at most 40 characters' },
  ])('checks a rename as Add does, and sends nothing for $name', async ({ typed, message }) => {
    const sent = serve([icebox, exploring]);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Icebox' }));
    fireEvent.change(screen.getByLabelText('Name for Icebox'), { target: { value: typed } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Name' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByLabelText('Name for Icebox').getAttribute('aria-invalid')).toBe('true');
    expect(sent).toEqual([]);
  });

  it('sends a renamed column’s name cleaned, as Add does', async () => {
    const sent = serve([icebox, exploring]);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Icebox' }));
    fireEvent.change(screen.getByLabelText('Name for Icebox'), {
      target: { value: '  Some   day ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Name' }));
    await waitFor(() => {
      expect(sent).toEqual([
        { method: 'PATCH', path: `/board-columns/${icebox.id}`, body: { name: 'Some day' } },
      ]);
    });
  });

  it('deletes an empty column after confirming', async () => {
    const sent = serve([icebox, exploring]);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Exploring' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Exploring' });
    expect(within(dialog).queryByLabelText('Move its tasks to')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Keep It' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Column' }));
    await waitFor(() => {
      expect(sent).toEqual([
        {
          method: 'DELETE',
          path: `/board-columns/${exploring.id}/delete`,
          body: { moveTasksTo: 'planned' },
        },
      ]);
    });
  });

  it.each([
    { choice: 'Exploring', expected: () => exploring.id },
    { choice: 'Planned (Backlog or Ready)', expected: () => 'planned' },
  ])("asks where a non-empty column's tasks go: $choice", async ({ choice, expected }) => {
    const sent = serve([icebox, exploring]);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Icebox' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Icebox' });
    expect(within(dialog).getByText('Icebox holds 1 task. Where should it go?')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Delete Column' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(within(dialog).getByLabelText('Move its tasks to'));
    fireEvent.click(await screen.findByRole('option', { name: choice, hidden: true }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Column' }));
    await waitFor(() => {
      expect(sent).toEqual([
        {
          method: 'DELETE',
          path: `/board-columns/${icebox.id}/delete`,
          body: { moveTasksTo: expected() },
        },
      ]);
    });
  });

  it('keeps Delete disabled until the tasks have loaded, so an unknown count is never treated as empty', async () => {
    serve([icebox, exploring]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(daemonUrl('/projects/:projectId/tasks'), async () => {
        await gate;
        return HttpResponse.json([]);
      }),
    );
    const remove = await screen.findByRole('button', { name: 'Delete Exploring' });
    expect(remove).toHaveProperty('disabled', true);
    release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete Exploring' })).toHaveProperty(
        'disabled',
        false,
      );
    });
  });
});
