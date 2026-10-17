import { ProjectDto, WorkstreamDto } from '@10db/contracts';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { daemonUrl, server, TEST_CONNECTION } from '../test/daemon';
import { workstreamDto } from '../test/fixtures';
import { createDaemonClient, readJson } from './client';

const client = createDaemonClient(TEST_CONNECTION);
const projectInput = {
  name: 'x',
  repoPath: '/tmp/x',
  gateCommand: 'true',
  areas: [{ name: 'src', globs: ['src/**'] }],
};

describe('the daemon client', () => {
  it('sends the UI token', async () => {
    server.use(
      http.get(daemonUrl('/projects'), ({ request }) =>
        request.headers.get('authorization') === 'Bearer test-token'
          ? HttpResponse.json([])
          : HttpResponse.json({ error: 'unauthorized' }, { status: 401 }),
      ),
    );
    expect(await readJson(await client.projects.$get(), z.array(ProjectDto))).toEqual([]);
  });

  it('passes typed query parameters', async () => {
    const finished = workstreamDto({ state: 'DONE' });
    server.use(
      http.get(daemonUrl('/workstreams'), ({ request }) =>
        HttpResponse.json(
          new URL(request.url).searchParams.get('active') === 'false' ? [finished] : [],
        ),
      ),
    );
    expect(
      await readJson(
        await client.workstreams.$get({ query: { active: 'false' } }),
        z.array(WorkstreamDto),
      ),
    ).toEqual([finished]);
  });

  it('sends typed JSON bodies', async () => {
    let received: unknown = null;
    server.use(
      http.post(daemonUrl('/projects'), async ({ request }) => {
        received = await request.json();
        return HttpResponse.json(
          { error: 'invalid', message: '/tmp/x is not a git repository' },
          { status: 400 },
        );
      }),
    );
    const res = await client.projects.$post({ json: projectInput });
    await expect(readJson(res, ProjectDto)).rejects.toMatchObject({
      name: 'DaemonRequestError',
      status: 400,
      message: '/tmp/x is not a git repository',
    });
    expect(received).toEqual(projectInput);
  });

  it('lists validation issues as the message', async () => {
    server.use(
      http.post(daemonUrl('/projects'), () =>
        HttpResponse.json(
          { error: 'invalid', issues: [{ path: 'name', message: 'Too small' }] },
          { status: 400 },
        ),
      ),
    );
    await expect(
      readJson(await client.projects.$post({ json: projectInput }), ProjectDto),
    ).rejects.toMatchObject({
      message: 'name: Too small',
    });
  });

  it('rejects a response that does not match the schema', async () => {
    server.use(http.get(daemonUrl('/projects'), () => HttpResponse.json([{ nope: 1 }])));
    await expect(readJson(await client.projects.$get(), z.array(ProjectDto))).rejects.toThrow();
  });
});
