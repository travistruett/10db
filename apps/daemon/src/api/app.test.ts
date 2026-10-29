import {
  BatchStartResult,
  ConflictError,
  HealthResponse,
  mintId,
  InboxAnswerRefused,
  NotFoundError,
  PROTOCOL_VERSION,
  WorkstreamDto,
  type DaemonEvent,
} from '@10db/contracts';
import { defineWebSocketHelper } from 'hono/ws';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import type { ApiServices } from './services';

const TOKEN = 'ui-token-for-tests';
const startedAt = new Date('2026-10-13T12:00:00.000Z');

const reached: string[] = [];
beforeEach(() => {
  reached.length = 0;
});
/** A stub that records the call and throws, so the route answers 500 after reaching the right service. */
const track = (name: string) => (): never => {
  reached.push(name);
  throw new Error(`reached ${name}`);
};

function stubServices(overrides: Partial<ApiServices> = {}): ApiServices {
  const none = (): never => {
    throw new Error('not stubbed');
  };
  return {
    listProjects: () => [],
    createProject: none,
    listTasks: () => [],
    createTask: none,
    startTask: none,
    listFlows: () => [],
    listWorkstreams: () => [],
    cancelWorkstream: none,
    retryWorkstream: none,
    listInbox: () => [],
    answerInbox: none,
    eventsAfter: () => [] as DaemonEvent[],
    subscribe: () => () => undefined,
    systemCheck: none,
    keepAwake: () => ({ mode: 'while_running', active: false }),
    setKeepAwake: none,
    eventsHead: () => 0,
    reviewProjectMcp: none,
    inspectFolder: none,
    listPersonas: track('listPersonas'),
    createPersona: track('createPersona'),
    patchPersona: track('patchPersona'),
    listPeople: track('listPeople'),
    createPerson: track('createPerson'),
    createFlow: track('createFlow'),
    patchFlow: track('patchFlow'),
    listModelProfiles: track('listModelProfiles'),
    patchModelProfile: track('patchModelProfile'),
    benchmarkStatus: track('benchmarkStatus'),
    syncBenchmarks: track('syncBenchmarks'),
    listAaModels: track('listAaModels'),
    patchProject: track('patchProject'),
    getTeam: track('getTeam'),
    setTeam: track('setTeam'),
    listRoutingRules: track('listRoutingRules'),
    setRoutingRules: track('setRoutingRules'),
    patchTask: track('patchTask'),
    stepPlan: track('stepPlan'),
    startBatch: track('startBatch'),
    listBatches: track('listBatches'),
    shipBatch: track('shipBatch'),
    abandonBatch: track('abandonBatch'),
    moveTask: track('moveTask'),
    listBoardColumns: track('listBoardColumns'),
    createBoardColumn: track('createBoardColumn'),
    patchBoardColumn: track('patchBoardColumn'),
    deleteBoardColumn: track('deleteBoardColumn'),
    proposeCandidates: track('proposeCandidates'),
    listAccounts: () => [],
    createAccount: track('createAccount'),
    patchAccount: track('patchAccount'),
    archiveAccount: track('archiveAccount'),
    setAccountSecret: track('setAccountSecret'),
    accountSignIn: track('accountSignIn'),
    accountIdentity: track('accountIdentity'),
    accountUsage: track('accountUsage'),
    ...overrides,
  };
}

// A helper that never upgrades: it answers 426 so a test can tell the route was reached.
const noUpgrade = defineWebSocketHelper(() => new Response(null, { status: 426 }));

function app(
  services = stubServices(),
  onUnexpectedError: (error: unknown) => void = () => undefined,
) {
  return createApp({
    onUnexpectedError,
    startedAt,
    allowedOrigins: ['http://localhost:1420'],
    token: TOKEN,
    services,
    upgradeWebSocket: noUpgrade,
    mcp: () => Promise.resolve(new Response('mcp')),
  });
}
const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };
const json = { headers: { ...auth.headers, 'content-type': 'application/json' } };

describe('API', () => {
  it.each([
    { name: 'no query', query: '', status: 200, recheck: false },
    { name: 'recheck=1', query: '?recheck=1', status: 200, recheck: true },
    { name: 'recheck=yes', query: '?recheck=yes', status: 400, recheck: null },
    { name: 'recheck=0', query: '?recheck=0', status: 400, recheck: null },
  ])('GET /system with $name answers $status', async ({ query, status, recheck }) => {
    const asked: boolean[] = [];
    const services = stubServices({
      systemCheck: (options) => {
        asked.push(options.recheck);
        return Promise.resolve({
          loginEnv: { source: 'login_shell' as const, warning: null },
          claudeCode: { verifiedOn: '2.1.302', warning: null },
          tools: [],
          benchmarkSync: null,
        });
      },
    });
    expect((await app(services).request(`/system${query}`, auth)).status).toBe(status);
    expect(asked).toEqual(recheck === null ? [] : [recheck]);
  });

  it('serves the event head, keep-awake and the system check behind the token', async () => {
    const check = {
      loginEnv: { source: 'login_shell' as const, warning: null },
      claudeCode: { verifiedOn: '2.1.302', warning: null },
      tools: [
        {
          name: 'git' as const,
          path: '/usr/bin/git',
          version: 'git version 2.50.1',
          required: true,
          signedIn: null,
        },
      ],
      benchmarkSync: null,
    };
    const modes: string[] = [];
    const services = stubServices({
      eventsHead: () => 41,
      systemCheck: () => Promise.resolve(check),
      setKeepAwake: (mode) => {
        modes.push(mode);
        return { mode, active: mode === 'always' };
      },
    });
    expect((await app(services).request('/events/head')).status).toBe(401);
    expect(await (await app(services).request('/events/head', auth)).json()).toEqual({ seq: 41 });
    expect(await (await app(services).request('/settings/keep-awake', auth)).json()).toEqual({
      mode: 'while_running',
      active: false,
    });
    expect(await (await app(services).request('/system', auth)).json()).toEqual(check);

    const put = (body: unknown) =>
      app(services).request('/settings/keep-awake', {
        method: 'PUT',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect(await (await put({ mode: 'always' })).json()).toEqual({ mode: 'always', active: true });
    expect((await put({ mode: 'sometimes' })).status).toBe(400);
    expect(modes).toEqual(['always']);
  });

  it("reviews a project's repo MCP servers behind the token", async () => {
    const projectId = mintId('Project');
    const seen: string[] = [];
    const services = stubServices({
      reviewProjectMcp: (id) => {
        seen.push(id);
        return [];
      },
    });
    const review = (headers: Record<string, string> = {}) =>
      app(services).request(`/projects/${projectId}/mcp-servers/review`, {
        method: 'POST',
        headers,
      });
    expect((await review()).status).toBe(401);
    expect(await (await review(auth.headers)).json()).toEqual([]);
    expect(seen).toEqual([projectId]);
  });

  it('serves /health without a token', async () => {
    const res = await app().request('/health');
    expect(HealthResponse.parse(await res.json())).toEqual({
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      startedAt: startedAt.toISOString(),
    });
  });

  it('requires the UI token everywhere else', async () => {
    expect((await app().request('/projects')).status).toBe(401);
    expect(
      (await app().request('/projects', { headers: { Authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
    expect((await app().request('/projects', auth)).status).toBe(200);
  });

  it('takes the token from the query string on the event stream only', async () => {
    expect((await app().request('/events/stream')).status).toBe(401);
    expect((await app().request('/events/stream', auth)).status).toBe(401);
    expect((await app().request('/events/stream?token=wrong')).status).toBe(401);
    expect((await app().request(`/events/stream?token=${TOKEN}`)).status).toBe(426);
    expect((await app().request(`/projects?token=${TOKEN}`)).status).toBe(401);
  });

  it('passes /mcp through without the UI token', async () => {
    expect(await (await app().request('/mcp', { method: 'POST' })).text()).toBe('mcp');
  });

  it('answers 400 with issue paths for an invalid body', async () => {
    const res = await app().request('/projects', {
      method: 'POST',
      ...json,
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues.map((i) => i.path)).toContain('repoPath');
  });

  it('answers 400 for a body that is not JSON', async () => {
    const res = await app().request('/projects', { method: 'POST', ...json, body: '{nope' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ error: 'invalid' });
  });

  it('refuses an event-stream upgrade from a foreign origin', async () => {
    const upgrade = { Upgrade: 'websocket', Connection: 'Upgrade' };
    const foreign = await app().request(`/events/stream?token=${TOKEN}`, {
      headers: { ...upgrade, Origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    // The stubbed upgrader answers 426, so reaching it proves the allowed origin got through.
    const allowed = await app().request(`/events/stream?token=${TOKEN}`, {
      headers: { ...upgrade, Origin: 'http://localhost:1420' },
    });
    expect(allowed.status).toBe(426);
  });

  it('answers 400 with the API error shape for a JSON body sent without a content type', async () => {
    const res = await app().request('/projects', {
      method: 'POST',
      ...auth,
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid' });
  });

  it('answers 400, not 500, when an inbox answer fails the contract schema', async () => {
    const services = stubServices({
      answerInbox: () => {
        throw new Error('the service must not be reached');
      },
    });
    const res = await app(services).request(`/inbox/${mintId('InboxItem')}/answer`, {
      method: 'POST',
      ...json,
      body: JSON.stringify({ kind: 'nope' }),
    });
    expect(res.status).toBe(400);
  });

  it('answers 400 with the reason when an inbox answer is refused', async () => {
    const services = stubServices({
      answerInbox: () => {
        throw new InboxAnswerRefused('Send Back needs a note saying what to change');
      },
    });
    const res = await app(services).request(`/inbox/${mintId('InboxItem')}/answer`, {
      method: 'POST',
      ...json,
      body: JSON.stringify({ choice: 'send_back' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid',
      message: 'Send Back needs a note saying what to change',
    });
  });

  it('maps domain errors to 404 and 409', async () => {
    const services = stubServices({
      startTask: () => {
        throw new NotFoundError('task', 'tsk_x');
      },
      retryWorkstream: () => {
        throw new ConflictError('not failed');
      },
    });
    expect(
      (await app(services).request(`/tasks/${mintId('Task')}/start`, { method: 'POST', ...auth }))
        .status,
    ).toBe(404);
    expect(
      (
        await app(services).request(`/workstreams/${mintId('Workstream')}/retry`, {
          method: 'POST',
          ...auth,
        })
      ).status,
    ).toBe(409);
  });

  it('answers 409 with the task named when a patch removes an area a running task holds', async () => {
    const message = 'Can\'t remove or rename area "api": the running task "Fix login" holds it.';
    const services = stubServices({
      patchProject: () => {
        throw new ConflictError(message);
      },
    });
    const res = await app(services).request(`/projects/${mintId('Project')}`, {
      method: 'PATCH',
      ...json,
      body: JSON.stringify({ areas: [{ name: 'ui', globs: ['src/ui/**'] }] }),
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Fix login');
  });

  it('answers 500 for an unexpected error and reports that error to the hook', async () => {
    const boom = new Error('boom');
    const seen: unknown[] = [];
    const services = stubServices({
      listProjects: () => {
        throw boom;
      },
    });
    const res = await app(services, (error) => seen.push(error)).request('/projects', auth);
    expect(res.status).toBe(500);
    expect(seen).toEqual([boom]);
    expect(seen[0]).toBe(boom);
  });

  it('answers 400 for a malformed ID', async () => {
    expect(
      (await app().request('/tasks/not-an-id/start', { method: 'POST', ...auth })).status,
    ).toBe(400);
  });

  it('filters the inbox by a comma-separated state list, and rejects an unknown state', async () => {
    const seen: (readonly string[] | null)[] = [];
    const services = stubServices({
      listInbox: ({ states }) => {
        seen.push(states);
        return [];
      },
    });
    expect((await app(services).request('/inbox?state=OPEN,ANSWERED', auth)).status).toBe(200);
    expect((await app(services).request('/inbox', auth)).status).toBe(200);
    expect(seen).toEqual([['OPEN', 'ANSWERED'], null]);
    expect((await app(services).request('/inbox?state=NOPE', auth)).status).toBe(400);
  });

  it('keeps the CORS allow-list', async () => {
    const ok = await app().request('/health', { headers: { Origin: 'http://localhost:1420' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:1420');
    const no = await app().request('/health', { headers: { Origin: 'https://evil.example' } });
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('team, routing and benchmark routes', () => {
  const persona = {
    key: 'sec',
    name: 'Sec',
    role: 'review',
    tools: 'read_only',
    instructions: 'Check auth.',
  };
  const projectId = mintId('Project');
  const taskId = mintId('Task');
  it.each([
    {
      name: 'GET /personas',
      method: 'GET',
      path: '/personas',
      body: undefined,
      service: 'listPersonas',
    },
    {
      name: 'POST /personas',
      method: 'POST',
      path: '/personas',
      body: persona,
      service: 'createPersona',
    },
    {
      name: 'PATCH /personas/:id',
      method: 'PATCH',
      path: `/personas/${mintId('Persona')}`,
      body: { archived: true },
      service: 'patchPersona',
    },
    { name: 'GET /people', method: 'GET', path: '/people', body: undefined, service: 'listPeople' },
    {
      name: 'POST /people',
      method: 'POST',
      path: '/people',
      body: { handle: 'sam', name: 'Sam' },
      service: 'createPerson',
    },
    {
      name: 'POST /flows',
      method: 'POST',
      path: '/flows',
      body: { name: 'mine', steps: [{ role: 'implement', need: 40 }] },
      service: 'createFlow',
    },
    {
      name: 'PATCH /flows/:id',
      method: 'PATCH',
      path: `/flows/${mintId('Flow')}`,
      body: { steps: [{ role: 'implement', need: 40 }] },
      service: 'patchFlow',
    },
    {
      name: 'GET /model-profiles',
      method: 'GET',
      path: '/model-profiles',
      body: undefined,
      service: 'listModelProfiles',
    },
    {
      name: 'PATCH /model-profiles/:id',
      method: 'PATCH',
      path: `/model-profiles/${mintId('ModelProfile')}`,
      body: { enabled: false },
      service: 'patchModelProfile',
    },
    {
      name: 'GET /benchmarks/status',
      method: 'GET',
      path: '/benchmarks/status',
      body: undefined,
      service: 'benchmarkStatus',
    },
    {
      name: 'POST /benchmarks/sync',
      method: 'POST',
      path: '/benchmarks/sync',
      body: undefined,
      service: 'syncBenchmarks',
    },
    {
      name: 'GET /benchmarks/models',
      method: 'GET',
      path: '/benchmarks/models',
      body: undefined,
      service: 'listAaModels',
    },
    {
      name: 'PATCH /projects/:id',
      method: 'PATCH',
      path: `/projects/${projectId}`,
      body: { budgetCeiling: 2.5 },
      service: 'patchProject',
    },
    {
      name: 'PATCH /projects/:id with extra allowed commands',
      method: 'PATCH',
      path: `/projects/${projectId}`,
      body: { allowedCommands: ['pnpm exec prettier', 'pnpm test'] },
      service: 'patchProject',
    },
    {
      name: 'PATCH /projects/:id with new areas and hazards',
      method: 'PATCH',
      path: `/projects/${projectId}`,
      body: {
        areas: [{ name: 'core', globs: ['src/core/**'] }],
        hazards: [{ name: 'deps', globs: ['**/package.json'], commands: ['pnpm add'] }],
      },
      service: 'patchProject',
    },
    {
      name: 'PATCH /projects/:id with the localhost switch',
      method: 'PATCH',
      path: `/projects/${projectId}`,
      body: { sandboxLoopback: true },
      service: 'patchProject',
    },
    {
      name: 'GET /projects/:id/team',
      method: 'GET',
      path: `/projects/${projectId}/team`,
      body: undefined,
      service: 'getTeam',
    },
    {
      name: 'PUT /projects/:id/team',
      method: 'PUT',
      path: `/projects/${projectId}/team`,
      body: { bindings: [], members: [] },
      service: 'setTeam',
    },
    {
      name: 'GET /projects/:id/routing-rules',
      method: 'GET',
      path: `/projects/${projectId}/routing-rules`,
      body: undefined,
      service: 'listRoutingRules',
    },
    {
      name: 'PUT /projects/:id/routing-rules',
      method: 'PUT',
      path: `/projects/${projectId}/routing-rules`,
      body: { rules: [] },
      service: 'setRoutingRules',
    },
    {
      name: 'PATCH /tasks/:id',
      method: 'PATCH',
      path: `/tasks/${taskId}`,
      body: { riskTags: ['auth'] },
      service: 'patchTask',
    },
    {
      name: 'GET /tasks/:id/step-plan',
      method: 'GET',
      path: `/tasks/${taskId}/step-plan`,
      body: undefined,
      service: 'stepPlan',
    },
  ] as const)('routes $name to its service', async ({ method, path, body, service }) => {
    const res = await app().request(path, {
      method,
      ...(body === undefined ? auth : { ...json, body: JSON.stringify(body) }),
    });
    // The tracking stub throws after recording, so the API answers 500: the body passed validation.
    expect(res.status).toBe(500);
    expect(reached).toEqual([service]);
  });
  it.each<[string, string, string, unknown]>([
    ['createAccount', 'POST', '/accounts', { kind: 'claude_subscription', label: 'A' }],
    ['patchAccount', 'PATCH', '/accounts/{id}', { payer: 'x' }],
    ['archiveAccount', 'POST', '/accounts/{id}/archive', undefined],
    ['setAccountSecret', 'PUT', '/accounts/{id}/secret', { secret: 'sk-ant-api03-abcdef' }],
    ['accountSignIn', 'GET', '/accounts/{id}/signin', undefined],
    ['accountIdentity', 'GET', '/accounts/{id}/identity', undefined],
    ['accountUsage', 'GET', '/accounts/{id}/usage?month=2026-10', undefined],
  ])('routes %s behind the token', async (service, method, path, body) => {
    const request = (headers: Record<string, string>) =>
      app().request(path.replace('{id}', mintId('Account')), {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    expect((await request({})).status).toBe(401);
    expect(reached).toEqual([]);
    const res = await request({ Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(500);
    expect(reached).toEqual([service]);
  });

  it.each([
    {
      name: 'a reviewer persona that edits',
      method: 'POST',
      path: '/personas',
      body: { ...persona, tools: 'edit' },
    },
    { name: 'an empty project patch', method: 'PATCH', path: `/projects/${projectId}`, body: {} },
    {
      name: 'a negative budget ceiling',
      method: 'PATCH',
      path: `/projects/${projectId}`,
      body: { budgetCeiling: -1 },
    },
    {
      name: 'an area path pattern that goes up a folder',
      method: 'PATCH',
      path: `/projects/${projectId}`,
      body: { areas: [{ name: 'core', globs: ['../core/**'] }] },
    },
    {
      name: 'a hazard path pattern with an unclosed brace',
      method: 'PATCH',
      path: `/projects/${projectId}`,
      body: { hazards: [{ name: 'deps', globs: ['{a,b'], commands: [] }] },
    },
    {
      name: 'a localhost switch that is not a boolean',
      method: 'PATCH',
      path: `/projects/${projectId}`,
      body: { sandboxLoopback: 'on' },
    },
    {
      name: 'an allowed command with a flag',
      method: 'PATCH',
      path: `/projects/${projectId}`,
      body: { allowedCommands: ['pnpm --filter web test'] },
    },
    {
      name: 'an allowed command that runs a shell',
      method: 'PATCH',
      path: `/projects/${projectId}`,
      body: { allowedCommands: ['pnpm exec bash'] },
    },
    {
      name: 'an allowed command that runs an interpreter',
      method: 'PATCH',
      path: `/projects/${projectId}`,
      body: { allowedCommands: ['node'] },
    },
    {
      name: 'a PATCH /projects/:id seed name with a slash',
      method: 'PATCH',
      path: `/projects/${projectId}`,
      body: { worktreeSeed: ['node_modules/.cache'] },
    },
    {
      name: 'a flow with no implement step',
      method: 'POST',
      path: '/flows',
      body: { name: 'talk', steps: [{ role: 'review', need: 48 }] },
    },
    {
      name: 'a malformed persona id',
      method: 'PATCH',
      path: '/personas/nope',
      body: { archived: true },
    },
  ])('answers 400 for $name without calling a service', async ({ method, path, body }) => {
    const res = await app().request(path, { method, ...json, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
    expect(reached).toEqual([]);
  });
});

describe('batch routes', () => {
  const batch = {
    id: mintId('Batch'),
    projectId: mintId('Project'),
    title: 'Greetings',
    state: 'CUTTING',
    branch: null,
    baseBranch: 'main',
    baseSha: null,
    repo: null,
    prUrl: null,
    gateExitCode: null,
    gateLogPath: null,
    failure: null,
    worktreePath: null,
    createdAt: '2026-10-21T12:00:00.000Z',
    updatedAt: '2026-10-21T12:00:00.000Z',
  } as const;
  const post = (_path: string, body?: unknown) => ({
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  it("answers a project's batches through the service, and refuses a malformed project id", async () => {
    const path = `/projects/${batch.projectId}/batches`;
    const ok = await app(stubServices({ listBatches: () => [batch] })).request(path, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual([batch]);
    const bad = await app().request('/projects/not-a-project/batches', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
    expect(reached).toEqual([]);
  });

  it('POST /projects/:id/batches answers an array: 202 with every batch the start made, 400 for an empty start', async () => {
    const second = { ...batch, id: mintId('Batch'), title: 'Farewells' };
    const services = stubServices({ startBatch: () => [batch, second] });
    const path = `/projects/${batch.projectId}/batches`;
    const ok = await app(services).request(
      path,
      post(path, { title: 'Greetings', taskIds: [mintId('Task'), mintId('Task')] }),
    );
    expect(ok.status).toBe(202);
    expect(BatchStartResult.parse(await ok.json())).toEqual([batch, second]);
    expect(
      (await app(services).request(path, post(path, { title: 'x', taskIds: [] }))).status,
    ).toBe(400);
  });

  const workstream = WorkstreamDto.parse({
    id: mintId('Workstream'),
    taskId: mintId('Task'),
    projectId: batch.projectId,
    batchId: null,
    taskTitle: 'Alpha',
    state: 'QUEUED',
    nextAction: { kind: 'start' },
    attempt: 0,
    recoveryAttempts: 0,
    model: 'sonnet',
    effort: 'medium',
    steps: [],
    stepIndex: 0,
    currentSessionId: null,
    sessionCount: 0,
    contextPct: null,
    pausedUntil: null,
    failureReason: null,
    lastActivityAt: null,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  });
  it.each([
    {
      name: '201 with the workstream in a local project',
      started: { kind: 'workstream', workstream },
      status: 201,
      body: workstream,
    },
    {
      name: '202 with the batch in a pull-request project',
      started: { kind: 'batch', batch },
      status: 202,
      body: batch,
    },
  ] as const)('answers a task start with $name', async ({ started, status, body }) => {
    const res = await app(stubServices({ startTask: () => started })).request(
      `/tasks/${mintId('Task')}/start`,
      post(''),
    );
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
  });

  it.each([
    { path: 'ship', service: 'shipBatch' },
    { path: 'abandon', service: 'abandonBatch' },
  ])(
    'routes $path to $service, and refuses an id that is not a batch',
    async ({ path, service }) => {
      await app().request(`/batches/${mintId('Batch')}/${path}`, post(''));
      expect(reached).toEqual([service]);
      expect((await app().request(`/batches/not-a-batch/${path}`, post(''))).status).toBe(400);
    },
  );
});

describe('board routes', () => {
  const taskId = mintId('Task');
  const projectId = mintId('Project');
  const columnId = mintId('BoardColumn');
  it.each([
    {
      name: 'POST /tasks/:id/move',
      method: 'POST',
      path: `/tasks/${taskId}/move`,
      body: { to: null, after: mintId('Task'), before: null },
      service: 'moveTask',
    },
    {
      name: 'GET /projects/:id/board-columns',
      method: 'GET',
      path: `/projects/${projectId}/board-columns`,
      body: undefined,
      service: 'listBoardColumns',
    },
    {
      name: 'POST /projects/:id/board-columns',
      method: 'POST',
      path: `/projects/${projectId}/board-columns`,
      body: { name: 'Exploring' },
      service: 'createBoardColumn',
    },
    {
      name: 'PATCH /board-columns/:id',
      method: 'PATCH',
      path: `/board-columns/${columnId}`,
      body: { position: 0 },
      service: 'patchBoardColumn',
    },
    {
      name: 'POST /board-columns/:id/delete',
      method: 'POST',
      path: `/board-columns/${columnId}/delete`,
      body: { moveTasksTo: 'planned' },
      service: 'deleteBoardColumn',
    },
  ] as const)('routes $name to its service', async ({ method, path, body, service }) => {
    const res = await app().request(path, {
      method,
      ...(body === undefined ? auth : { ...json, body: JSON.stringify(body) }),
    });
    expect(res.status).toBe(500);
    expect(reached).toEqual([service]);
  });

  it.each([
    {
      name: 'a move between a task and itself',
      path: `/tasks/${taskId}/move`,
      method: 'POST',
      body: { to: null, after: taskId, before: taskId },
    },
    {
      name: 'a malformed task id',
      path: '/tasks/nope/move',
      method: 'POST',
      body: { to: null, after: null, before: null },
    },
    {
      name: 'an empty column name',
      path: `/projects/${projectId}/board-columns`,
      method: 'POST',
      body: { name: ' ' },
    },
    {
      name: 'an empty column patch',
      path: `/board-columns/${columnId}`,
      method: 'PATCH',
      body: {},
    },
    {
      name: 'a delete with no target',
      path: `/board-columns/${columnId}/delete`,
      method: 'POST',
      body: {},
    },
  ])('answers 400 for $name without calling a service', async ({ path, method, body }) => {
    const res = await app().request(path, { method, ...json, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
    expect(reached).toEqual([]);
  });

  it('answers 409 with the message when the board changed', async () => {
    const res = await app(
      stubServices({
        moveTask: () => {
          throw new ConflictError('The board changed while you were dragging; try again');
        },
      }),
    ).request(`/tasks/${taskId}/move`, {
      method: 'POST',
      ...json,
      body: JSON.stringify({ to: null, after: mintId('Task'), before: mintId('Task') }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      message: 'The board changed while you were dragging; try again',
    });
  });
});

describe('candidate routes', () => {
  const projectId = mintId('Project');
  it('routes GET /projects/:id/candidates with the size to its service', async () => {
    const seen: number[] = [];
    const res = await app(
      stubServices({
        proposeCandidates: (_id, size) => {
          seen.push(size);
          return { projectId, size, candidates: [] };
        },
      }),
    ).request(`/projects/${projectId}/candidates?size=3`, auth);
    expect(res.status).toBe(200);
    expect(seen).toEqual([3]);
  });

  it.each([
    { name: 'no size', query: '' },
    { name: 'a zero size', query: '?size=0' },
    { name: 'a size over the maximum', query: '?size=17' },
  ])('answers 400 for $name without calling the service', async ({ query }) => {
    const res = await app().request(`/projects/${projectId}/candidates${query}`, auth);
    expect(res.status).toBe(400);
    expect(reached).toEqual([]);
  });
});

describe('folder inspection route', () => {
  it('POST /folders/inspect refuses a relative path with 400', async () => {
    const res = await app().request('/folders/inspect', {
      method: 'POST',
      ...json,
      body: JSON.stringify({ path: 'relative/dir' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /folders/inspect answers a refusal as 200 with ok false', async () => {
    const refusal = {
      ok: false,
      reason: 'not_found',
      message: 'Nothing is at this path.',
    } as const;
    const seen: string[] = [];
    const res = await app(
      stubServices({
        inspectFolder: (path) => {
          seen.push(path);
          return Promise.resolve(refusal);
        },
      }),
    ).request('/folders/inspect', {
      method: 'POST',
      ...json,
      body: JSON.stringify({ path: '/nowhere' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(refusal);
    expect(seen).toEqual(['/nowhere']);
  });
});
