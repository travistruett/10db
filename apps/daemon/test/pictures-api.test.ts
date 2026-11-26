import {
  InboxItemDto,
  PassOpenedDto,
  PicturesStatusDto,
  ProjectDto,
  SAVE_DEV_LOGIN_TOOL,
  SignInCheckDto,
  SignInSetupChoice,
  TaskDto,
  TaskScreensDto,
} from '@10db/contracts';
import { getProject, latestEventSeq } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { signInSetupTitle } from '../src/inbox';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { FakeCamera } from './fake-camera';
import { createTempRepo, tempDir, waitFor, waitForAsync, type TempDir } from './fixtures';
import { pngOfSize } from './png';

// Workbench spec §10, §11, §13: a daemon with a fake browser takes a task's pictures, serves them to the
// Workbench and the drawer by id, and says how its browser and sign-in stand. A task in Your folder gets
// its before ahead of its first edit and its after once done.

const APP = 'http://localhost:8800';
const PEOPLE = {
  name: 'people',
  globs: ['src/people/**'],
  role: 'page' as const,
  route: '/people',
};

let data: TempDir;
let repo: TempDir;
let daemon: RunningDaemon;
let cam: FakeCamera;
let adapter: FakeAdapter;
/** The dev login the sign-in setup task's lane writes once the test lets it. */
const WORKING_LOGIN = `echo ${APP}/people?token=abc`;
/** The event log's head as each shot was asked. */
let shotAtSeq: number[];

beforeEach(async () => {
  data = tempDir('pictures api');
  repo = createTempRepo();
  cam = new FakeCamera();
  shotAtSeq = [];
  cam.onShoot = () => {
    shotAtSeq.push(latestEventSeq(daemon.state.db));
  };
  daemon = await startDaemon();
});
/** The daemon on the test's data dir, with the fake browser; called again for a restart. */
function startDaemon(): Promise<RunningDaemon> {
  adapter = new FakeAdapter({
    [signInSetupTitle('demo')]: [
      [
        { do: 'consume' },
        { do: 'mcp', tool: SAVE_DEV_LOGIN_TOOL, args: { command: 'echo x; exit 3' } },
        {
          do: 'mcp',
          tool: SAVE_DEV_LOGIN_TOOL,
          args: { command: `echo --email ops@ampsio.com ${APP}/people` },
        },
        { do: 'await_signal', name: 'save-working' },
        { do: 'mcp', tool: SAVE_DEV_LOGIN_TOOL, args: { command: WORKING_LOGIN } },
        { do: 'turn_complete' },
      ],
    ],
    'People: UI work': [[{ do: 'consume' }, { do: 'await_message', contains: 'never sent' }]],
    'People: tidy': [
      [
        {
          do: 'tool',
          toolName: 'Write',
          input: { file_path: 'src/people/page.tsx', content: 'tidy\n' },
        },
        {
          do: 'mcp',
          tool: 'commit',
          args: {
            opId: 'op-pictures-01',
            paths: ['src/people/page.tsx'],
            message: 'Tidy people',
          },
        },
        { do: 'turn_complete' },
      ],
    ],
  });
  return startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter,
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    pictures: { kind: 'given', camera: cam, prepare: () => undefined },
  });
}

afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);
const get = (path: string) =>
  fetch(`${daemon.url}${path}`, { headers: { Authorization: `Bearer ${daemon.token}` } });

async function project(more: Record<string, unknown> = {}): Promise<ProjectDto> {
  const made = await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'test -d src',
    areas: [PEOPLE, { name: 'src', globs: ['src/**'], role: 'shared' }],
    ...more,
  });
  return api().patch(`/projects/${made.id}`, ProjectDto, { appUrl: APP });
}

describe("a task's pictures over HTTP", () => {
  it('lists them, serves one as a private PNG, and answers 404 once it is pruned', async () => {
    const p = await project();
    const task = await api().post(`/projects/${p.id}/tasks`, TaskDto, {
      title: 'People: UI work',
      acceptanceCriteria: ['x'],
      areas: ['people'],
    });
    await api().post(`/projects/${p.id}/passes`, PassOpenedDto, {
      name: 'Polish',
      taskIds: [task.id],
    });
    const listed = await waitForAsync(async () => {
      const screens = await api().get(`/tasks/${task.id}/screens`, TaskScreensDto);
      return screens.screens.length > 0 ? screens : undefined;
    });
    expect(listed).toMatchObject({ taskId: task.id, fromGoal: [] });
    expect(listed.screens.map((s) => [s.kind, s.route, s.width, s.height])).toEqual([
      ['before', '/people', 1440, 900],
    ]);
    const id = listed.screens[0]?.id ?? '';

    const res = await get(`/screens/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(pngOfSize(1440, 900, 1));

    daemon.state.db.$client
      .prepare('UPDATE task_screens SET pruned_at = ? WHERE task_id = ?')
      .run(daemon.state.now(), task.id);
    expect((await get(`/screens/${id}`)).status).toBe(404);
    expect((await api().get(`/tasks/${task.id}/screens`, TaskScreensDto)).screens).toEqual([]);
  });

  it("says how the project's browser and sign-in stand", async () => {
    const p = await project();
    expect(await api().get(`/projects/${p.id}/pictures`, PicturesStatusDto)).toEqual({
      browser: { state: 'ready', problem: null },
      signIn: null,
    });
  });
});

describe("a project's sign-in check", () => {
  const signInCards = async () =>
    (await api().get('/inbox?state=OPEN', z.array(InboxItemDto))).filter((i) =>
      i.title.includes("can't sign in"),
    );
  const check = (id: string) =>
    api().post(`/projects/${id}/pictures/sign-in-check`, SignInCheckDto, {});
  const setLogin = (id: string, devLoginCommand: string) =>
    api().patch(`/projects/${id}`, ProjectDto, { devLoginCommand });

  it('loads the first routed page signed in, and a failure raises one card that the next success withdraws', async () => {
    const p = await project();
    await setLogin(p.id, `echo ${APP}/people?token=secret123456789 boom; exit 3`);
    const failed = await check(p.id);
    expect(failed).toMatchObject({ state: 'failed', exitCode: 3, picture: null });
    expect(failed.output).not.toContain('secret123456789');
    await check(p.id);
    expect(await signInCards()).toHaveLength(1);
    expect(cam.signIns).toEqual([]);

    // A changed command is checked by itself: the card goes once it signs in. It is told the address
    // it signs in on.
    await setLogin(p.id, `test "$TENDB_APP_URL" = "${APP}" && echo ${APP}/people?token=abc`);
    await waitForAsync(async () => ((await signInCards()).length === 0 ? true : undefined));
    const ok = await check(p.id);
    expect(ok).toMatchObject({ state: 'signed_in', problem: null, route: '/people' });
    expect(ok.picture).toBe(pngOfSize(1440, 900, 1).toString('base64'));
    expect(cam.shots.at(-1)).toMatchObject({ appUrl: APP, route: '/people' });
  });

  it('offers a project with no dev login a setup task, and saves only a command that signs in', async () => {
    const p = await project({ defaultRigor: 'light' });
    const offer = await waitForAsync(async () =>
      (await api().get('/inbox?state=OPEN', z.array(InboxItemDto))).find(
        (i) => i.projectId === p.id && i.options.some((o) => o.label === SignInSetupChoice.SetUp),
      ),
    );
    await api().post(`/inbox/${offer.id}/answer`, InboxItemDto, {
      choice: SignInSetupChoice.SetUp,
    });

    // A command that fails its check, and one naming a real person's email, are not saved.
    await waitFor(() =>
      adapter.observations.filter((o) => o.kind === 'mcp_result').length === 2 ? true : undefined,
    );
    expect(getProject(daemon.state.db, p.id).devLoginCommand).toBeNull();
    expect(cam.signIns).toEqual([]);

    adapter.signal('save-working');
    await waitFor(() =>
      getProject(daemon.state.db, p.id).devLoginCommand === WORKING_LOGIN ? true : undefined,
    );
    // Once the saved command signs in, the project's one sign-in card is gone.
    await waitForAsync(async () =>
      (await api().get('/inbox?state=OPEN', z.array(InboxItemDto))).some(
        (i) => i.projectId === p.id && i.title.includes('sign'),
      )
        ? undefined
        : true,
    );
  });

  it("never runs against an address that is not the project's own", async () => {
    const p = await project();
    // A command that prints another host's address, or the daemon's own port, is not signed in at.
    await setLogin(p.id, `echo http://localhost:${new URL(daemon.url).port}/people`);
    expect(await check(p.id)).toMatchObject({ state: 'failed', picture: null });
    await setLogin(p.id, 'echo http://elsewhere.example/people');
    expect(await check(p.id)).toMatchObject({ state: 'failed', picture: null });
    expect(cam.signIns).toEqual([]);
    expect(cam.shots).toEqual([]);
  });
});
