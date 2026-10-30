import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectDto } from '../../test/fixtures';

const project = projectDto({
  areas: [
    { name: 'api', globs: ['src/api/**'] },
    { name: 'ui', globs: ['src/ui/**'] },
  ],
  hazards: [{ name: 'deps', globs: ['**/package.json'], commands: ['pnpm add'] }],
});

function type(label: string, value: string): void {
  fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value } });
}

describe('the areas and hazards editor', () => {
  it('explains each area and hazard and shows paths as folder patterns with an example', async () => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      ...baseHandlers(),
    );
    renderApp('/settings/areas');
    expect(
      await screen.findByText(/Tasks in different areas can run at the same time/),
    ).toBeTruthy();
    expect(screen.getByText(/Only one task at a time may change these files/)).toBeTruthy();
    expect(
      screen.getAllByText(/may change files in src\/api\/ and everything inside it/),
    ).toHaveLength(1);
    expect(screen.getAllByText(/Example: src\/api\/folder\/file/)).toHaveLength(1);
    expect(screen.getByText(/package\.json in any folder/)).toBeTruthy();
  });

  it('saves renamed, added and removed areas and hazards in one patch', async () => {
    const patched: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json(project);
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/areas');
    await screen.findByRole('textbox', { name: 'Area 1 name' });
    expect(screen.getByRole('button', { name: 'Save areas and hazards' })).toHaveProperty(
      'disabled',
      true,
    );

    type('Area 1 name', 'server');
    type('Area 1 paths', 'src/server/**\nsrc/shared/**');
    fireEvent.click(screen.getByRole('button', { name: 'Remove area 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add area' }));
    type('Area 2 name', 'docs');
    type('Area 2 paths', 'docs/**');
    type('Hazard 1 commands', 'pnpm add\npnpm remove');
    fireEvent.click(screen.getByRole('button', { name: 'Add hazard' }));
    type('Hazard 2 name', 'lock');
    type('Hazard 2 paths', 'pnpm-lock.yaml');
    fireEvent.click(screen.getByRole('button', { name: 'Remove hazard 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save areas and hazards' }));

    await waitFor(() => {
      expect(patched).toEqual([
        {
          areas: [
            { name: 'server', globs: ['src/server/**', 'src/shared/**'] },
            { name: 'docs', globs: ['docs/**'] },
          ],
          hazards: [{ name: 'lock', globs: ['pnpm-lock.yaml'], commands: [], scope: 'project' }],
        },
      ]);
    });
  });

  it('shows which hazards are held per copy, keeps the choice on save, and lets the builder change it', async () => {
    const patched: unknown[] = [];
    const stored = projectDto({
      areas: project.areas,
      hazards: [
        // No scope stored, as before hazards had one: deps is read as per copy by its name.
        { name: 'deps', globs: ['**/package.json'], commands: ['pnpm add'] },
        { name: 'migrations', globs: ['**/migrations/**'], commands: [], scope: 'project' },
      ],
    });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([stored])),
      http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json(stored);
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/areas');
    const deps = await screen.findByRole('checkbox', { name: 'Hazard 1 is held per copy' });
    const migrations = screen.getByRole('checkbox', { name: 'Hazard 2 is held per copy' });
    expect(deps).toHaveProperty('checked', true);
    expect(migrations).toHaveProperty('checked', false);

    fireEvent.click(migrations);
    fireEvent.click(deps);
    fireEvent.click(screen.getByRole('button', { name: 'Save areas and hazards' }));
    await waitFor(() => {
      expect(patched).toMatchObject([
        {
          hazards: [
            { name: 'deps', scope: 'project' },
            { name: 'migrations', scope: 'copy' },
          ],
        },
      ]);
    });
  });

  it('refuses a bad path pattern before sending it', async () => {
    const patched: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json(project);
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/areas');
    await screen.findByRole('textbox', { name: 'Area 1 name' });
    type('Area 1 paths', '../outside/**');
    fireEvent.click(screen.getByRole('button', { name: 'Save areas and hazards' }));
    expect(await screen.findByText(/must not go up a folder/)).toBeTruthy();
    expect(patched).toEqual([]);
  });

  it("shows the daemon's refusal, naming the task that holds the area", async () => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.patch(daemonUrl('/projects/:projectId'), () =>
        HttpResponse.json(
          {
            error: 'conflict',
            message: 'Can\'t remove or rename area "api": the running task "Fix login" holds it.',
          },
          { status: 409 },
        ),
      ),
      ...baseHandlers(),
    );
    renderApp('/settings/areas');
    await screen.findByRole('textbox', { name: 'Area 1 name' });
    type('Area 1 name', 'server');
    fireEvent.click(screen.getByRole('button', { name: 'Save areas and hazards' }));
    expect(await screen.findByText(/the running task "Fix login" holds it/)).toBeTruthy();
  });
});
