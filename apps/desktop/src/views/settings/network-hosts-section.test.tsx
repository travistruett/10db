import type { FoundHostDto, NetworkHostDto, NetworkHostSource } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectDto } from '../../test/fixtures';

const project = projectDto();
const AT = '2026-10-13T12:00:00.000Z';
const BUILDER: NetworkHostSource = { kind: 'builder' };

type Initial = string | readonly [string, NetworkHostSource];

interface ServeOptions {
  /** The hosts a scan finds that are not allowed; a scan allows none of them. */
  readonly scan?: readonly FoundHostDto[];
  readonly failRemoving?: string;
}

function serve(initial: readonly Initial[], options: ServeOptions = {}) {
  let hosts: NetworkHostDto[] = initial.map((entry) => {
    const [host, source] = typeof entry === 'string' ? [entry, BUILDER] : entry;
    return { host, source, createdAt: AT };
  });
  const sent: { method: string; path: string; body: unknown }[] = [];
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/network-hosts'), () => HttpResponse.json(hosts)),
    http.post(daemonUrl('/projects/:projectId/network-hosts/scan'), ({ request }) => {
      sent.push({ method: 'POST', path: new URL(request.url).pathname, body: null });
      return HttpResponse.json(options.scan ?? []);
    }),
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
      const added = { host: body.host, source: BUILDER, createdAt: AT };
      hosts = [...hosts, added];
      return HttpResponse.json(added, { status: 201 });
    }),
    http.delete(daemonUrl('/projects/:projectId/network-hosts/:host'), ({ request }) => {
      const host = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '');
      sent.push({ method: 'DELETE', path: new URL(request.url).pathname, body: host });
      if (host === options.failRemoving) {
        return HttpResponse.json(
          { error: 'internal', message: 'The database is locked.' },
          { status: 500 },
        );
      }
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
  it('says what a host is for and lists the allowed hosts, each with where it came from', async () => {
    serve([
      ['index.crates.io', { kind: 'file', file: 'Cargo.lock' }],
      ['static.crates.io', { kind: 'card' }],
      ['typed.example.com', { kind: 'builder' }],
    ]);
    expect(
      await screen.findByText("Hosts this project's tasks and checks may reach."),
    ).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Network hosts' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((i) => i.textContent),
    ).toEqual([
      'index.crates.ioFound in Cargo.lockRemove',
      'static.crates.ioAllowed from a cardRemove',
      'typed.example.comAdded by youRemove',
    ]);
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

  it('draws Remove as a default button, not red text', async () => {
    serve(['index.crates.io']);
    const remove = await screen.findByRole('button', { name: 'Remove index.crates.io' });
    expect(remove.getAttribute('data-variant')).toBe('default');
    expect(remove.outerHTML).not.toMatch(/red/);
  });

  it('shows a failed removal beside its host, keeps the host, and not beside the others', async () => {
    serve(['index.crates.io', 'static.crates.io'], { failRemoving: 'index.crates.io' });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove index.crates.io' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The database is locked.');
    const items = screen.getAllByRole('listitem');
    expect(within(items.at(0) ?? document.body).getByRole('alert')).toBe(alert);
    expect(within(items.at(1) ?? document.body).queryByRole('alert')).toBeNull();
    expect(items).toHaveLength(2);
  });

  describe('Look Again', () => {
    it('lists the hosts the files name that are not allowed, each with its file, and allows none', async () => {
      const sent = serve(['index.crates.io'], {
        scan: [
          { host: 'rubygems.org', file: 'Gemfile.lock' },
          { host: 'exfil.example.net', file: '.npmrc' },
        ],
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Look Again' }));

      const found = await screen.findByRole('list', { name: 'Hosts the files name' });
      const items = within(found).getAllByRole('listitem');
      expect(items.map((item) => item.textContent)).toEqual([
        'rubygems.orgFound in Gemfile.lockAllow',
        'exfil.example.netFound in .npmrcAllow',
      ]);
      expect(
        within(screen.getByRole('list', { name: 'Network hosts' }))
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['index.crates.ioAdded by youRemove']);
      expect(sent).toEqual([
        { method: 'POST', path: `/projects/${project.id}/network-hosts/scan`, body: null },
      ]);
    });

    it('allows only the host the builder chooses, and takes it off the found list', async () => {
      const sent = serve([], {
        scan: [
          { host: 'rubygems.org', file: 'Gemfile.lock' },
          { host: 'exfil.example.net', file: '.npmrc' },
        ],
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Look Again' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Allow rubygems.org' }));

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Allow rubygems.org' })).toBeNull();
      });
      expect(
        within(await screen.findByRole('list', { name: 'Network hosts' }))
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['rubygems.orgAdded by youRemove']);
      expect(screen.getByRole('button', { name: 'Allow exfil.example.net' })).toBeTruthy();
      expect(sent.slice(1)).toEqual([
        {
          method: 'POST',
          path: `/projects/${project.id}/network-hosts`,
          body: { host: 'rubygems.org' },
        },
      ]);
    });

    it('shows a refused Allow beside that found host', async () => {
      serve([], { scan: [{ host: 'localhost', file: '.npmrc' }] });
      fireEvent.click(await screen.findByRole('button', { name: 'Look Again' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Allow localhost' }));

      const found = await screen.findByRole('list', { name: 'Hosts the files name' });
      expect((await within(found).findByRole('alert')).textContent).toBe(
        "localhost is this machine: use the project's Allow localhost setting instead.",
      );
    });

    it('says so when the files name no host that is not allowed', async () => {
      serve(['index.crates.io']);
      fireEvent.click(await screen.findByRole('button', { name: 'Look Again' }));
      expect(
        await screen.findByText("The project's files name no host that isn't allowed."),
      ).toBeTruthy();
    });
  });
});
