import type { NetworkHostDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectDto } from '../../test/fixtures';

const project = projectDto();
const AT = '2026-10-13T12:00:00.000Z';

function serve(initial: string[]) {
  let hosts: NetworkHostDto[] = initial.map((host) => ({ host, createdAt: AT }));
  const sent: { method: string; path: string; body: unknown }[] = [];
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/network-hosts'), () => HttpResponse.json(hosts)),
    http.post(daemonUrl('/projects/:projectId/network-hosts'), async ({ request }) => {
      const body = z.object({ host: z.string() }).parse(await request.json());
      sent.push({ method: 'POST', path: new URL(request.url).pathname, body });
      if (body.host === 'localhost') {
        return HttpResponse.json(
          {
            error: 'invalid',
            message:
              "localhost is this machine: use the project's Allow localhost setting instead.",
          },
          { status: 400 },
        );
      }
      const added = { host: body.host, createdAt: AT };
      hosts = [...hosts, added];
      return HttpResponse.json(added, { status: 201 });
    }),
    http.delete(daemonUrl('/projects/:projectId/network-hosts/:host'), ({ request }) => {
      const host = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '');
      sent.push({ method: 'DELETE', path: new URL(request.url).pathname, body: host });
      const gone = hosts.find((h) => h.host === host);
      hosts = hosts.filter((h) => h.host !== host);
      return gone
        ? HttpResponse.json(gone)
        : HttpResponse.json({ error: 'not_found', message: 'x' }, { status: 404 });
    }),
    ...baseHandlers(),
  );
  renderApp('/settings/network-hosts');
  return sent;
}

describe('NetworkHostsSection', () => {
  it('says what a host is for and lists the allowed hosts', async () => {
    serve(['index.crates.io', 'static.crates.io']);
    expect(
      await screen.findByText("Hosts this project's tasks and checks may reach."),
    ).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Network hosts' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((i) => i.textContent),
    ).toEqual(['index.crates.ioRemove', 'static.crates.ioRemove']);
  });

  it('says so when no host is allowed', async () => {
    serve([]);
    expect(await screen.findByText('No hosts are allowed yet.')).toBeTruthy();
  });

  it('adds a host, clears the field and shows the new host', async () => {
    const sent = serve(['index.crates.io']);
    const field = await screen.findByLabelText('Host');
    fireEvent.change(field, { target: { value: 'static.crates.io' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Host' }));

    await screen.findByText('static.crates.io');
    expect(sent).toEqual([
      {
        method: 'POST',
        path: `/projects/${project.id}/network-hosts`,
        body: { host: 'static.crates.io' },
      },
    ]);
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Host').value).toBe('');
    });
  });

  it("shows the daemon's refusal beside the button, keeps what was typed and adds nothing", async () => {
    serve(['index.crates.io']);
    const field = await screen.findByLabelText('Host');
    fireEvent.change(field, { target: { value: 'localhost' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Host' }));

    const refusal = await screen.findByRole('alert');
    expect(refusal.textContent).toBe(
      "localhost is this machine: use the project's Allow localhost setting instead.",
    );
    expect(screen.getByLabelText<HTMLInputElement>('Host').value).toBe('localhost');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('removes a host', async () => {
    const sent = serve(['index.crates.io', 'static.crates.io']);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove index.crates.io' }));

    await waitFor(() => {
      expect(screen.queryByText('index.crates.io')).toBeNull();
    });
    expect(screen.getByText('static.crates.io')).toBeTruthy();
    expect(sent).toEqual([
      {
        method: 'DELETE',
        path: '/projects/' + project.id + '/network-hosts/index.crates.io',
        body: 'index.crates.io',
      },
    ]);
  });
});
