import type { ProjectDto, TaskDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { projectDto, taskDto } from '../../test/fixtures';
import { NewTaskForm } from './new-task-form';

async function open(project: ProjectDto, posted: unknown[] = []): Promise<void> {
  server.use(
    http.post(daemonUrl('/projects/:projectId/tasks'), async ({ request }) => {
      posted.push(await request.json());
      return HttpResponse.json(taskDto({ projectId: project.id }), { status: 201 });
    }),
    ...baseHandlers(),
  );
  const tasks: TaskDto[] = [];
  renderWithDaemon(
    <>
      <NewTaskForm
        formId="new-task"
        project={project}
        tasks={tasks}
        onStatus={() => undefined}
        onCreated={() => undefined}
      />
      <button type="submit" form="new-task">
        Create Task
      </button>
    </>,
  );
  await screen.findByLabelText('Title');
}

describe('NewTaskForm', () => {
  it('hides hazards from Areas', async () => {
    await open(
      projectDto({
        areas: [
          { name: 'api', globs: ['src/api/**'] },
          { name: 'ui', globs: ['src/ui/**'] },
        ],
        hazards: [{ name: 'migrations', globs: ['drizzle/**'], commands: [] }],
      }),
    );

    const [field] = await screen.findAllByLabelText(/^Areas/);
    if (!field) throw new Error('expected the Areas field');
    fireEvent.click(field);
    const options = await screen.findAllByRole('option', { hidden: true });
    expect(options.map((o) => o.textContent)).toEqual(['api', 'ui']);
  });

  it('hides Areas with one area and sends it', async () => {
    const posted: unknown[] = [];
    await open(projectDto({ areas: [{ name: 'repo', globs: ['**'] }] }), posted);

    expect(screen.queryByText('Areas')).toBeNull();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Beta' } });
    fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: 'Works' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    expect(posted[0]).toMatchObject({ areas: ['repo'] });
  });

  it('the criteria placeholder shows an example', async () => {
    await open(projectDto());

    const field = screen.getByLabelText('Acceptance criteria');
    expect(field.getAttribute('placeholder')).toBe(
      'One per line, for example:\nSearch shows results in under a second with 10,000 tasks',
    );
  });

  it('the criteria help names the gate command', async () => {
    await open(projectDto({ gateCommand: 'make verify-it' }));

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'About acceptance criteria' }));

    const card = await screen.findByText(/make verify-it/);
    expect(within(card.parentElement ?? card).getByText(/make verify-it/)).toBeTruthy();
  });

  it('the criteria help says the builder checks the work when the project has no gate', async () => {
    await open(projectDto({ gateCommand: null }));

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'About acceptance criteria' }));

    expect(await screen.findByText(/and you check the finished work yourself\./)).toBeTruthy();
    expect(screen.queryByText(/gate \(/)).toBeNull();
  });

  it('the description starts at one row', async () => {
    await open(projectDto());

    expect(screen.getByLabelText('Description').getAttribute('rows')).toBe('1');
  });
});
