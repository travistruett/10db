import type { FoundHostDto, WebHostDto, WebHostSource } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectDto } from '../../test/fixtures';

const project = projectDto();
const AT = '2026-11-03T12:00:00.000Z';
const hostsPath = `/projects/${project.id}/web-hosts`;
const searchPath = `/projects/${project.id}/web-search`;

interface ServeOptions {
  readonly scan?: readonly FoundHostDto[];
  readonly searchOn?: boolean;
}

function serve(initial: readonly (readonly [string, WebHostSource])[], options: ServeOptions = {}) {
  let hosts: WebHostDto[] = initial.map(([host, source]) => ({ host, source, createdAt: AT }));
  let enabled = options.searchOn ?? true;
  const sent: { method: string; path: string; body: unknown }[] = [];
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl(hostsPath), () => HttpResponse.json(hosts)),
    http.get(daemonUrl(searchPath), () => HttpResponse.json({ enabled })),
    http.put(daemonUrl(searchPath), async ({ request }) => {
      const body = z.object({ enabled: z.boolean() }).parse(await request.json());
      sent.push({ method: 'PUT', path: searchPath, body });
      ({ enabled } = body);
      return HttpResponse.json(body);
    }),
    http.post(daemonUrl(`${hostsPath}/scan`), () => {
      sent.push({ method: 'POST', path: `${hostsPath}/scan`, body: null });
      return HttpResponse.json(options.scan ?? []);
    }),
    http.post(daemonUrl(hostsPath), async ({ request }) => {
      const body = z.object({ host: z.string() }).parse(await request.json());
      sent.push({ method: 'POST', path: hostsPath, body });
      if (body.host === 'localhost') {
        return HttpResponse.json(
          { error: 'invalid', message: 'localhost is not a public web host.' },
          { status: 400 },
        );
      }
      const added: WebHostDto = {
        host: body.host,
        source: { kind: 'builder' },
        createdAt: AT,
      };
      hosts = [...hosts, added];
      return HttpResponse.json(added, { status: 201 });
    }),
    http.delete(daemonUrl(`${hostsPath}/:host`), ({ params }) => {
      const host = z.string().parse(params['host']);
      sent.push({ method: 'DELETE', path: `${hostsPath}/${host}`, body: null });
      const gone = hosts.find((h) => h.host === host);
      hosts = hosts.filter((h) => h.host !== host);
      return HttpResponse.json(gone);
    }),
    ...baseHandlers(),
  );
  renderApp('/settings/web-access');
  return sent;
}

describe('WebAccessSection', () => {
  it('lists the read list, each host with where it came from', async () => {
    serve([
      ['github.com', { kind: 'start' }],
      ['react.dev', { kind: 'file', file: 'package.json' }],
      ['docs.rs', { kind: 'card' }],
      ['tauri.app', { kind: 'builder' }],
    ]);
    const list = await screen.findByRole('list', { name: 'Read list' });
    const items = await within(list).findAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'github.comOn every new listRemove',
      'react.devFound in package.jsonRemove',
      'docs.rsAllowed from a cardRemove',
      'tauri.appAdded by youRemove',
    ]);
  });

  it('says so when the list is empty', async () => {
    serve([]);
    expect(await screen.findByText('No hosts are on the read list.')).toBeTruthy();
  });

  it('adds a host and clears the field', async () => {
    const sent = serve([['github.com', { kind: 'start' }]]);
    const field = await screen.findByLabelText('Host');
    fireEvent.change(field, { target: { value: 'docs.rs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Host' }));
    await screen.findByText('docs.rs');
    expect(sent).toEqual([{ method: 'POST', path: hostsPath, body: { host: 'docs.rs' } }]);
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Host').value).toBe('');
    });
  });

  it('shows the daemon’s refusal in its own words', async () => {
    serve([]);
    fireEvent.change(await screen.findByLabelText('Host'), { target: { value: 'localhost' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Host' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'localhost is not a public web host.',
    );
  });

  it('removes a host', async () => {
    const sent = serve([['github.com', { kind: 'start' }]]);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove github.com' }));
    await screen.findByText('No hosts are on the read list.');
    expect(sent).toEqual([{ method: 'DELETE', path: `${hostsPath}/github.com`, body: null }]);
  });

  it('Look Again names what the files found, and adds a host only when the builder does', async () => {
    const sent = serve([['github.com', { kind: 'start' }]], {
      scan: [{ host: 'react.dev', file: 'package.json' }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Look Again' }));
    const found = await screen.findByRole('list', { name: 'Hosts the files name' });
    expect(within(found).getByText('react.dev')).toBeTruthy();
    expect(sent.filter((s) => s.path === hostsPath)).toEqual([]);
    fireEvent.click(within(found).getByRole('button', { name: 'Add react.dev' }));
    await within(await screen.findByRole('list', { name: 'Read list' })).findByText('react.dev');
    expect(sent.filter((s) => s.path === hostsPath)).toEqual([
      { method: 'POST', path: hostsPath, body: { host: 'react.dev' } },
    ]);
  });

  it('says so when Look Again finds nothing new', async () => {
    serve([['github.com', { kind: 'start' }]]);
    fireEvent.click(await screen.findByRole('button', { name: 'Look Again' }));
    expect(await screen.findByText('The project’s files name no other host.')).toBeTruthy();
  });

  it('turns web search off and on', async () => {
    const sent = serve([], { searchOn: true });
    const toggle = await screen.findByRole('switch', {
      name: 'Lanes search the web without a card',
    });
    await waitFor(() => {
      expect((toggle as HTMLInputElement).checked).toBe(true);
    });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(sent).toEqual([{ method: 'PUT', path: searchPath, body: { enabled: false } }]);
    });
    await waitFor(() => {
      expect((toggle as HTMLInputElement).checked).toBe(false);
    });
  });
});
