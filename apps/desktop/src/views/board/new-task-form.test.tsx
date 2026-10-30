import type { ProjectDto, TaskDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { projectDto, taskDto } from '../../test/fixtures';
import { NewTaskForm } from './new-task-form';

async function open(
  project: ProjectDto,
  posted: unknown[] = [],
  onStatus: (status: { pending: boolean; error: string | null }) => void = () => undefined,
): Promise<void> {
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
        onStatus={onStatus}
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

  describe('where the work lands', () => {
    const pr: Partial<ProjectDto> = {
      delivery: 'pull_request',
      areas: [{ name: 'repo', globs: ['**'] }],
    };

    /** Fills the required fields and presses Create Task. */
    function create(): void {
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Beta' } });
      fireEvent.change(screen.getByLabelText('Acceptance criteria'), {
        target: { value: 'Works' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    }
    const choice = (name: string) => screen.getByRole<HTMLInputElement>('radio', { name });

    it.each([
      { name: 'merging project', project: pr, checked: 'Merge into main' },
      {
        name: 'holding project',
        project: { ...pr, landing: 'hold' } satisfies Partial<ProjectDto>,
        checked: 'Hold for my review',
      },
    ])('starts from the project default: $name', async ({ project, checked }) => {
      await open(projectDto(project));
      expect(choice(checked).checked).toBe(true);
      expect(screen.getAllByRole('radio')).toHaveLength(3);
    });

    it('names the project base branch in the first choice', async () => {
      await open(projectDto({ ...pr, baseBranch: 'develop' }));
      expect(choice('Merge into develop').checked).toBe(true);
    });

    it.each([
      {
        name: 'the default',
        pick: () => undefined,
        sent: { kind: 'base' },
      },
      {
        name: 'hold',
        pick: () => fireEvent.click(choice('Hold for my review')),
        sent: { kind: 'hold' },
      },
      {
        name: 'another branch, named',
        pick: () => {
          fireEvent.click(choice('Merge into another branch'));
          fireEvent.change(screen.getByLabelText('Branch to merge into'), {
            target: { value: ' feature/search ' },
          });
        },
        sent: { kind: 'branch', branch: 'feature/search' },
      },
    ])('sends $name', async ({ pick, sent }) => {
      const posted: unknown[] = [];
      await open(projectDto(pr), posted);
      pick();
      create();
      await waitFor(() => {
        expect(posted).toHaveLength(1);
      });
      expect(posted[0]).toMatchObject({ landing: sent });
    });

    it('asks for the branch before sending anything', async () => {
      const posted: unknown[] = [];
      await open(projectDto(pr), posted);
      fireEvent.click(choice('Merge into another branch'));
      create();
      expect(await screen.findByText('Name the branch this task merges into')).toBeTruthy();
      expect(posted).toEqual([]);
    });

    it("hands the footer the daemon's reason for refusing a branch", async () => {
      const statuses: (string | null)[] = [];
      await open(projectDto(pr), [], (status) => statuses.push(status.error));
      server.use(
        http.post(daemonUrl('/projects/:projectId/tasks'), () =>
          HttpResponse.json(
            {
              error: 'invalid',
              message:
                'origin has no branch named feature/nope. Create it on origin, or choose another place for this task to land.',
            },
            { status: 400 },
          ),
        ),
      );
      fireEvent.click(choice('Merge into another branch'));
      fireEvent.change(screen.getByLabelText('Branch to merge into'), {
        target: { value: 'feature/nope' },
      });
      create();
      await waitFor(() => {
        expect(statuses).toContain(
          'origin has no branch named feature/nope. Create it on origin, or choose another place for this task to land.',
        );
      });
    });

    it('offers nothing to a project that commits directly', async () => {
      const posted: unknown[] = [];
      await open(projectDto({ areas: [{ name: 'repo', globs: ['**'] }] }), posted);
      expect(screen.queryByRole('radio')).toBeNull();
      create();
      await waitFor(() => {
        expect(posted).toHaveLength(1);
      });
      expect(posted[0]).not.toHaveProperty('landing');
    });
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
