import {
  BatchStartResult,
  ConflictError,
  GoalDigestDto,
  GoalListDto,
  HazardAssessmentDto,
  HazardLookAgainResult,
  HealthResponse,
  HumanTouchDto,
  InvalidError,
  mintId,
  InboxAnswerRefused,
  NotFoundError,
  PROTOCOL_VERSION,
  WorkstreamDto,
  type AreaProposalResult,
  type DaemonEvent,
} from '@10db/contracts';
import { defineWebSocketHelper } from 'hono/ws';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, MAX_BODY_BYTES } from './app';
import type { ApiServices } from './services';
import { CODEX_VERIFIED_ON } from '../environment';

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
    holdTask: none,
    runNext: none,
    adoptGoal: none,
    getGoal: none,
    listFlows: () => [],
    listWorkstreams: () => [],
    cancelWorkstream: none,
    retryWorkstream: none,
    workstreamChanges: none,
    listInbox: () => [],
    answerInbox: none,
    eventsAfter: () => [] as DaemonEvent[],
    subscribe: () => () => undefined,
    systemCheck: none,
    keepAwake: () => ({ mode: 'while_running', active: false }),
    setKeepAwake: none,
    lanePermissions: () => ({ autoMode: true }),
    setLanePermissions: none,
    eventsHead: () => 0,
    reviewProjectMcp: none,
    inspectFolder: none,
    proposeAreas: none,
    listNetworkHosts: none,
    allowNetworkHost: none,
    removeNetworkHost: none,
    scanNetworkHosts: none,
    getHazardAssessment: none,
    lookAgainAtHazards: none,
    undoHazardAddition: none,
    listPersonas: track('listPersonas'),
    createPersona: track('createPersona'),
    patchPersona: track('patchPersona'),
    listPeople: track('listPeople'),
    createPerson: track('createPerson'),
    createFlow: track('createFlow'),
    patchFlow: track('patchFlow'),
    listModelProfiles: track('listModelProfiles'),
    patchModelProfile: track('patchModelProfile'),
    judgeStatus: track('judgeStatus'),
    patchJudge: track('patchJudge'),
    setJudgeKey: track('setJudgeKey'),
    removeJudgeKey: track('removeJudgeKey'),
    testJudge: track('testJudge'),
    listJudgeCalls: track('listJudgeCalls'),
    benchmarkStatus: track('benchmarkStatus'),
    syncBenchmarks: track('syncBenchmarks'),
    listAaModels: track('listAaModels'),
    getModelSettings: track('getModelSettings'),
    setGlobalModelSettings: track('setGlobalModelSettings'),
    setProjectModelSettings: track('setProjectModelSettings'),
    listModels: track('listModels'),
    listAccountOffers: track('listAccountOffers'),
    catalogueStatus: track('catalogueStatus'),
    refreshModels: track('refreshModels'),
    patchProject: track('patchProject'),
    getTeam: track('getTeam'),
    setTeam: track('setTeam'),
    listRoutingRules: track('listRoutingRules'),
    setRoutingRules: track('setRoutingRules'),
    patchTask: track('patchTask'),
    stepPlan: track('stepPlan'),
    startBatch: track('startBatch'),
    listBatches: track('listBatches'),
    openPass: track('openPass'),
    passView: track('passView'),
    takeOutPage: track('takeOutPage'),
    abandonPass: track('abandonPass'),
    livePasses: track('livePasses'),
    passStart: track('passStart'),
    addPassPages: track('addPassPages'),
    renamePass: track('renamePass'),
    discardKeptWork: track('discardKeptWork'),
    proposePageAreas: track('proposePageAreas'),
    listGoals: track('listGoals'),
    humanTouch: track('humanTouch'),
    openGoalDigest: track('openGoalDigest'),
    listShapes: track('listShapes'),
    createShape: track('createShape'),
    getShapeView: track('getShapeView'),
    sendShapeMessage: track('sendShapeMessage'),
    proposeShape: track('proposeShape'),
    stopShape: track('stopShape'),
    chooseShapeModel: track('chooseShapeModel'),
    convertShape: track('convertShape'),
    removeDraftGoal: track('removeDraftGoal'),
    withdrawShapeDecision: track('withdrawShapeDecision'),
    withdrawShapePrinciple: track('withdrawShapePrinciple'),
    resumeShape: track('resumeShape'),
    getGoalShape: track('getGoalShape'),
    getTaskShape: track('getTaskShape'),
    editShapeProposal: track('editShapeProposal'),
    unpinShapeProposal: track('unpinShapeProposal'),
    restoreShapeProposal: track('restoreShapeProposal'),
    dropShapeProposal: track('dropShapeProposal'),
    addShapeFile: track('addShapeFile'),
    taskThread: track('taskThread'),
    postTaskMessage: track('postTaskMessage'),
    stopPage: track('stopPage'),
    taskPicture: track('taskPicture'),
    startShape: track('startShape'),
    shapeMeasures: track('shapeMeasures'),
    getShapeJev: track('getShapeJev'),
    setShapeJev: track('setShapeJev'),
    getOneWayPaths: track('getOneWayPaths'),
    setOneWayPaths: track('setOneWayPaths'),
    getSmallProposalLimit: track('getSmallProposalLimit'),
    setSmallProposalLimit: track('setSmallProposalLimit'),
    rehearseShape: track('rehearseShape'),
    dismissShapeFinding: track('dismissShapeFinding'),
    listKnowledge: track('listKnowledge'),
    recordDecision: track('recordDecision'),
    supersedeDecision: track('supersedeDecision'),
    withdrawDecision: track('withdrawDecision'),
    decisionProvenance: track('decisionProvenance'),
    createPrinciple: track('createPrinciple'),
    supersedePrinciple: track('supersedePrinciple'),
    retirePrinciple: track('retirePrinciple'),
    withdrawPrinciple: track('withdrawPrinciple'),
    principleProvenance: track('principleProvenance'),
    listProposals: track('listProposals'),
    acceptProposal: track('acceptProposal'),
    rejectProposal: track('rejectProposal'),
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
    connectingAccount: () => null,
    connectAccount: track('connectAccount'),
    cancelAccountConnect: track('cancelAccountConnect'),
    accountUsage: track('accountUsage'),
    listAccountPauses: track('listAccountPauses'),
    resumeAccount: track('resumeAccount'),
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
    builderMcp: () => Promise.resolve(new Response('builder')),
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
          codex: { verifiedOn: CODEX_VERIFIED_ON, warning: null },
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
      codex: { verifiedOn: CODEX_VERIFIED_ON, warning: null },
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

  it('serves and sets the lane permission setting behind the token', async () => {
    const seen: boolean[] = [];
    const services = stubServices({
      setLanePermissions: (autoMode) => {
        seen.push(autoMode);
        return { autoMode };
      },
    });
    expect((await app(services).request('/settings/lane-permissions')).status).toBe(401);
    expect(await (await app(services).request('/settings/lane-permissions', auth)).json()).toEqual({
      autoMode: true,
    });
    const put = (body: unknown) =>
      app(services).request('/settings/lane-permissions', {
        method: 'PUT',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect(await (await put({ autoMode: false })).json()).toEqual({ autoMode: false });
    expect((await put({ autoMode: 'yes' })).status).toBe(400);
    expect(seen).toEqual([false]);
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
      commit: null,
    });
  });

  it('requires the UI token everywhere else', async () => {
    expect((await app().request('/projects')).status).toBe(401);
    expect(
      (await app().request('/projects', { headers: { Authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
    expect((await app().request('/projects', auth)).status).toBe(200);
  });

  it('serves /builder/mcp to the UI token only', async () => {
    const post = (headers: Record<string, string>) =>
      app().request('/builder/mcp', { method: 'POST', headers });
    expect((await post({})).status).toBe(401);
    // A managed session's token is not the UI token.
    expect((await post({ Authorization: 'Bearer lane-session-token' })).status).toBe(401);
    const ok = await post(auth.headers);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('builder');
  });

  it('answers 501 on /builder/mcp when the daemon has no builder endpoint', async () => {
    const bare = createApp({
      onUnexpectedError: () => undefined,
      startedAt,
      allowedOrigins: [],
      token: TOKEN,
      services: stubServices(),
      upgradeWebSocket: noUpgrade,
      mcp: () => Promise.resolve(new Response('mcp')),
    });
    expect((await bare.request('/builder/mcp', { method: 'POST', ...auth })).status).toBe(501);
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

  it.each([
    { name: 'a note', body: JSON.stringify({ note: 'Reuse the card.' }), note: 'Reuse the card.' },
    { name: 'a body with no note', body: JSON.stringify({}), note: undefined },
    { name: 'no body', body: undefined, note: undefined },
  ])('hands a retry $name to the service', async ({ body, note }) => {
    const seen: (string | undefined)[] = [];
    const services = stubServices({
      retryWorkstream: (_id, noted) => {
        seen.push(noted);
        throw new ConflictError('not failed');
      },
    });
    await app(services).request(`/workstreams/${mintId('Workstream')}/retry`, {
      method: 'POST',
      ...(body === undefined ? auth : json),
      ...(body === undefined ? {} : { body }),
    });
    expect(seen).toEqual([note]);
  });

  it('refuses a retry note over 4000 characters', async () => {
    const res = await app(stubServices({})).request(`/workstreams/${mintId('Workstream')}/retry`, {
      method: 'POST',
      ...json,
      body: JSON.stringify({ note: 'x'.repeat(4001) }),
    });
    expect(res.status).toBe(400);
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

  it("passes a project's app address to the patch, and refuses one that is not on this Mac", async () => {
    const sent: unknown[] = [];
    const services = stubServices({
      // The route's contract is what is under test: the service records the patch and refuses it.
      patchProject: (_id, patch) => {
        sent.push(patch);
        throw new ConflictError('recorded');
      },
    });
    const patch = (appUrl: string | null) =>
      app(services).request(`/projects/${mintId('Project')}`, {
        method: 'PATCH',
        ...json,
        body: JSON.stringify({ appUrl }),
      });
    expect((await patch('http://localhost:5173')).status).toBe(409);
    expect((await patch(null)).status).toBe(409);
    const refused = await patch('http://example.com');
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('An app address is an http origin on this Mac');
    expect(sent).toEqual([{ appUrl: 'http://localhost:5173' }, { appUrl: null }]);
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

  it('passes a recent count to the inbox list, and rejects one out of range', async () => {
    const seen: (number | null)[] = [];
    const services = stubServices({
      listInbox: ({ recent }) => {
        seen.push(recent);
        return [];
      },
    });
    expect((await app(services).request('/inbox?state=RESOLVED&recent=100', auth)).status).toBe(
      200,
    );
    expect((await app(services).request('/inbox', auth)).status).toBe(200);
    expect(seen).toEqual([100, null]);
    for (const bad of ['0', '1001', 'x', '2.5'])
      expect((await app(services).request(`/inbox?recent=${bad}`, auth)).status).toBe(400);
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
      name: 'GET /model-settings',
      method: 'GET',
      path: '/model-settings',
      body: undefined,
      service: 'getModelSettings',
    },
    {
      name: 'PUT /model-settings',
      method: 'PUT',
      path: '/model-settings',
      body: { roles: [{ role: 'review', setting: { kind: 'automatic' } }] },
      service: 'setGlobalModelSettings',
    },
    {
      name: 'GET /projects/:id/model-settings',
      method: 'GET',
      path: `/projects/${projectId}/model-settings`,
      body: undefined,
      service: 'getModelSettings',
    },
    {
      name: 'PUT /projects/:id/model-settings',
      method: 'PUT',
      path: `/projects/${projectId}/model-settings`,
      body: { roles: [{ role: 'review', setting: null }] },
      service: 'setProjectModelSettings',
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
    { name: 'GET /models', method: 'GET', path: '/models', body: undefined, service: 'listModels' },
    {
      name: 'GET /models/offers',
      method: 'GET',
      path: '/models/offers',
      body: undefined,
      service: 'listAccountOffers',
    },
    {
      name: 'GET /models/status',
      method: 'GET',
      path: '/models/status',
      body: undefined,
      service: 'catalogueStatus',
    },
    {
      name: 'POST /models/refresh',
      method: 'POST',
      path: '/models/refresh',
      body: undefined,
      service: 'refreshModels',
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
      name: 'PATCH /projects/:id with the Docker switch',
      method: 'PATCH',
      path: `/projects/${projectId}`,
      body: { sandboxDocker: true },
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
      name: 'POST /passes/:id/tasks/:id/take-out',
      method: 'POST',
      path: `/passes/${mintId('Pass')}/tasks/${taskId}/take-out`,
      body: { shared: [{ seq: 0, choice: 'keep' }] },
      service: 'takeOutPage',
    },
    {
      name: 'POST /passes/:id/abandon',
      method: 'POST',
      path: `/passes/${mintId('Pass')}/abandon`,
      body: undefined,
      service: 'abandonPass',
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
    ['connectAccount', 'POST', '/accounts/{id}/connect', undefined],
    ['cancelAccountConnect', 'DELETE', '/accounts/{id}/connect', undefined],
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
      name: 'a Docker switch that is not a boolean',
      method: 'PATCH',
      path: `/projects/${projectId}`,
      body: { sandboxDocker: 'on' },
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
      name: 'two page areas that can share a file',
      method: 'PATCH',
      path: `/projects/${projectId}`,
      body: {
        areas: [
          { name: 'people', globs: ['app/people/**'], role: 'page', route: '/people' },
          { name: 'pages', globs: ['app/**/page.tsx'], role: 'page' },
        ],
      },
    },
    {
      name: 'a route on an area that is not a page',
      method: 'POST',
      path: '/projects',
      body: {
        name: 'demo',
        repoPath: '/tmp/demo',
        areas: [{ name: 'ui', globs: ['ui/**'], role: 'shared', route: '/' }],
      },
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
    autoMerge: true,
    baseSha: null,
    repo: null,
    prUrl: null,
    pr: null,
    prRequired: null,
    prMergeBlocked: null,
    ciFixOf: null,
    ciFixHead: null,
    ciStopped: null,
    gateExitCode: null,
    gateLogPath: null,
    failure: null,
    worktreePath: null,
    notices: [] as never[],
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
    taskHeadline: '',
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
    runNextAt: null,
    notice: null,
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
    { name: 'no body', body: undefined, input: {} },
    { name: 'fresh', body: { fresh: true }, input: { fresh: true } },
  ])('hands a task start with $name to the service as $input', async ({ body, input }) => {
    const seen: unknown[] = [];
    const services = stubServices({
      startTask: (_id, got) => {
        seen.push(got);
        return { kind: 'workstream', workstream };
      },
    });
    const res = await app(services).request(`/tasks/${mintId('Task')}/start`, post('', body));
    expect(res.status).toBe(201);
    expect(seen).toEqual([input]);
  });

  it('refuses a task start whose body is not a start request', async () => {
    const res = await app(stubServices({})).request(
      `/tasks/${mintId('Task')}/start`,
      post('', { fresh: 'yes' }),
    );
    expect(res.status).toBe(400);
  });

  it('answers Run Next with the workstream and what it waits on, and refuses a bad task id', async () => {
    const result = { workstream, waitingOn: ['Fix the gate'] };
    const services = stubServices({ runNext: () => result });
    const res = await app(services).request(`/tasks/${mintId('Task')}/run-next`, post(''));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect((await app(services).request('/tasks/not-a-task/run-next', post(''))).status).toBe(400);
  });

  it("answers Run Next on a task that isn't queued with 409", async () => {
    const services = stubServices({
      runNext: () => {
        throw new ConflictError("Task a isn't waiting for a lane");
      },
    });
    const res = await app(services).request(`/tasks/${mintId('Task')}/run-next`, post(''));
    expect(res.status).toBe(409);
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

describe('goal routes', () => {
  const goalId = mintId('Goal');
  const projectId = mintId('Project');
  const digest = GoalDigestDto.parse({
    goalId,
    status: 'not_started',
    since: null,
    progress: { merged: 0, inReview: 0, total: 3, cancelled: [] },
    openPullRequests: 0,
    workingNow: [],
    team: [],
    waitingOn: { recent: [], earlier: [] },
    next: null,
    deviations: { recent: [], earlier: [] },
    decisions: { recent: [], earlier: [] },
    cost: { tokens: 0, dollars: null, sessions: 0 },
    ungrouped: null,
  });

  it('GET /goals/:goalId/digest opens the goal and answers its digest', async () => {
    const opened: string[] = [];
    const services = stubServices({
      openGoalDigest: (id) => {
        opened.push(id);
        return digest;
      },
    });
    const ok = await app(services).request(`/goals/${goalId}/digest`, auth);
    expect(ok.status).toBe(200);
    expect(GoalDigestDto.parse(await ok.json())).toEqual(digest);
    expect(opened).toEqual([goalId]);
    expect((await app(services).request('/goals/not-a-goal/digest', auth)).status).toBe(400);
  });

  it('answers 404 for a goal that does not exist', async () => {
    const services = stubServices({
      openGoalDigest: () => {
        throw new NotFoundError('goal', goalId);
      },
    });
    expect((await app(services).request(`/goals/${goalId}/digest`, auth)).status).toBe(404);
  });

  it('GET /projects/:projectId/goals answers the goal list', async () => {
    const list = { goals: [], ungrouped: null };
    const services = stubServices({ listGoals: () => list });
    const ok = await app(services).request(`/projects/${projectId}/goals`, auth);
    expect(ok.status).toBe(200);
    expect(GoalListDto.parse(await ok.json())).toEqual(list);
    expect((await app(services).request('/projects/not-a-project/goals', auth)).status).toBe(400);
  });

  it("serves a project's hazard assessment, looks again and undoes one addition", async () => {
    const assessment = { additions: [], assessedAt: null, commit: null, pendingRemovals: 0 };
    const undone: string[] = [];
    const services = stubServices({
      getHazardAssessment: () => assessment,
      lookAgainAtHazards: () => Promise.resolve({ ok: true, assessment, added: 2 }),
      undoHazardAddition: (_project, id) => {
        undone.push(id);
        return assessment;
      },
    });
    const base = `/projects/${projectId}/hazard-assessment`;
    const read = await app(services).request(base, auth);
    expect(HazardAssessmentDto.parse(await read.json())).toEqual(assessment);
    const look = await app(services).request(`${base}/look-again`, { ...auth, method: 'POST' });
    expect(HazardLookAgainResult.parse(await look.json())).toEqual({
      ok: true,
      assessment,
      added: 2,
    });
    const undo = await app(services).request(`${base}/additions/abc`, {
      ...auth,
      method: 'DELETE',
    });
    expect(undo.status).toBe(200);
    expect(undone).toEqual(['abc']);
    expect(
      (await app(services).request('/projects/not-a-project/hazard-assessment', auth)).status,
    ).toBe(400);
  });

  it('GET /projects/:projectId/human-touch answers the days of the project asked for', async () => {
    const asked: string[] = [];
    const day = {
      day: '2026-11-03',
      permission: 1,
      question: 0,
      workstreamFailed: 0,
      flag: 0,
      proposal: 0,
      review: 0,
      check: 0,
      cards: 1,
      tasksRan: 1,
      cardsPerTask: 1,
      waitingMinutes: 12.5,
      failedMinutes: 480,
    };
    const services = stubServices({
      humanTouch: (id) => {
        asked.push(id);
        return { days: [day] };
      },
    });
    const ok = await app(services).request(`/projects/${projectId}/human-touch`, auth);
    expect(ok.status).toBe(200);
    expect(HumanTouchDto.parse(await ok.json())).toEqual({ days: [day] });
    expect(asked).toEqual([projectId]);
    expect((await app(services).request('/projects/not-a-project/human-touch', auth)).status).toBe(
      400,
    );
  });
});

describe('shape routes', () => {
  const projectId = mintId('Project');
  const shapeId = mintId('Shape');
  const AT = '2026-11-02T12:00:00.000Z';
  const shape = {
    id: shapeId,
    projectId,
    title: 'New conversation',
    state: 'listening',
    origin: 'app',
    proposeUnlocked: false,
    round: 0,
    model: null,
    createdAt: AT,
    updatedAt: AT,
  } as const;
  const post = (body: unknown) => ({ method: 'POST', ...json, body: JSON.stringify(body) });

  it('lists a project’s conversations and opens one with a title or none', async () => {
    const made: unknown[] = [];
    const services = stubServices({
      listShapes: () => [shape],
      createShape: (_id, input) => {
        made.push(input);
        return shape;
      },
    });
    const list = await app(services).request(`/projects/${projectId}/shapes`, auth);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([shape]);
    expect((await app(services).request(`/projects/${projectId}/shapes`, post({}))).status).toBe(
      201,
    );
    await app(services).request(`/projects/${projectId}/shapes`, post({ title: 'Density' }));
    expect(made).toEqual([{}, { title: 'Density' }]);
    expect(
      (await app(services).request(`/projects/${projectId}/shapes`, post({ title: '' }))).status,
    ).toBe(400);
  });

  it('reopens a conversation with an event, refusing an empty one', async () => {
    const resumed: unknown[] = [];
    const note = {
      id: mintId('ShapeMessage'),
      shapeId,
      author: 'note',
      kind: 'event',
      body: 'Task a ran out of attempts.',
      createdAt: AT,
    } as const;
    const services = stubServices({
      resumeShape: (id, event) => {
        resumed.push([id, event]);
        return note;
      },
    });
    const ok = await app(services).request(
      `/shapes/${shapeId}/resume`,
      post({ event: 'Task a ran out of attempts.' }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(note);
    expect(resumed).toEqual([[shapeId, 'Task a ran out of attempts.']]);
    expect(
      (await app(services).request(`/shapes/${shapeId}/resume`, post({ event: '' }))).status,
    ).toBe(400);
  });

  it("names the conversation behind a goal's or a task's drawer, or none", async () => {
    const goalId = mintId('Goal');
    const taskId = mintId('Task');
    const services = stubServices({
      getGoalShape: (id) => ({ shapeId: id === goalId ? shapeId : null }),
      getTaskShape: () => ({ shapeId: null }),
    });
    const goal = await app(services).request(`/goals/${goalId}/shape`, auth);
    expect(await goal.json()).toEqual({ shapeId });
    const task = await app(services).request(`/tasks/${taskId}/shape`, auth);
    expect(await task.json()).toEqual({ shapeId: null });
  });

  it("reads and sets a project's Jev opt-in, refusing a body that is not one", async () => {
    const set: unknown[] = [];
    const services = stubServices({
      getShapeJev: () => ({ enabled: false }),
      setShapeJev: (_id, input) => {
        set.push(input);
        return input;
      },
    });
    const read = await app(services).request(`/projects/${projectId}/shape-jev`, auth);
    expect(await read.json()).toEqual({ enabled: false });
    const put = (body: unknown) =>
      app(services).request(`/projects/${projectId}/shape-jev`, {
        ...post(body),
        method: 'PUT',
      });
    expect((await put({ enabled: true })).status).toBe(200);
    expect((await put({ enabled: 'yes' })).status).toBe(400);
    expect(set).toEqual([{ enabled: true }]);
  });

  it('reads and sets a project’s one-way paths, refusing an empty glob', async () => {
    const set: unknown[] = [];
    const services = stubServices({
      getOneWayPaths: () => ({ paths: ['db/**'] }),
      setOneWayPaths: (_id, input) => {
        set.push(input);
        return input;
      },
    });
    const read = await app(services).request(`/projects/${projectId}/one-way-paths`, auth);
    expect(await read.json()).toEqual({ paths: ['db/**'] });
    const put = (body: unknown) =>
      app(services).request(`/projects/${projectId}/one-way-paths`, {
        ...post(body),
        method: 'PUT',
      });
    expect((await put({ paths: ['a/**', 'b.ts'] })).status).toBe(200);
    expect((await put({ paths: [''] })).status).toBe(400);
    expect(set).toEqual([{ paths: ['a/**', 'b.ts'] }]);
  });

  it('reads and sets a project’s small proposal limit, accepting zero and refusing a negative', async () => {
    const set: unknown[] = [];
    const services = stubServices({
      getSmallProposalLimit: () => ({ limit: 1200 }),
      setSmallProposalLimit: (_id, input) => {
        set.push(input);
        return input;
      },
    });
    const read = await app(services).request(`/projects/${projectId}/small-proposal-limit`, auth);
    expect(await read.json()).toEqual({ limit: 1200 });
    const put = (body: unknown) =>
      app(services).request(`/projects/${projectId}/small-proposal-limit`, {
        ...post(body),
        method: 'PUT',
      });
    expect((await put({ limit: 0 })).status).toBe(200);
    expect((await put({ limit: -1 })).status).toBe(400);
    expect((await put({ limit: 'big' })).status).toBe(400);
    expect(set).toEqual([{ limit: 0 }]);
  });

  it('Rehearse answers what it queued (202); a finding is dismissed (204)', async () => {
    const dismissed: unknown[] = [];
    const proposalId = mintId('ShapeProposal');
    const findingId = mintId('ShapeFinding');
    const services = stubServices({
      rehearseShape: (_id, input) => ({
        status: 'started',
        tasks: input.proposalIds?.length ?? 3,
      }),
      dismissShapeFinding: (_shape, id, input) => {
        dismissed.push([id, input]);
      },
    });
    const all = await app(services).request(`/shapes/${shapeId}/rehearse`, post({}));
    expect(all.status).toBe(202);
    expect(await all.json()).toEqual({ status: 'started', tasks: 3 });
    const some = await app(services).request(
      `/shapes/${shapeId}/rehearse`,
      post({ proposalIds: [proposalId] }),
    );
    expect(await some.json()).toEqual({ status: 'started', tasks: 1 });
    expect(
      (await app(services).request(`/shapes/${shapeId}/rehearse`, post({ proposalIds: [] })))
        .status,
    ).toBe(400);
    const dismiss = await app(services).request(
      `/shapes/${shapeId}/findings/${findingId}/dismiss`,
      post({ how: 'not needed' }),
    );
    expect(dismiss.status).toBe(204);
    expect(dismissed).toEqual([[findingId, { how: 'not needed' }]]);
  });

  it('answers a conversation’s view, 404 for an unknown one', async () => {
    const view = {
      shape,
      models: {
        default: 'claude-opus-5-5',
        offered: [{ model: 'claude-opus-5-5', tier: 'strongest' as const }],
      },
      messages: [],
      proposals: [],
      heard: [],
      files: [],
      turn: {
        running: false,
        queued: 0,
        proposing: false,
        rehearsing: false,
        waitingForUpdate: false,
      },
      sizes: [],
      ceremony: [],
      findings: [],
      rehearsals: [],
      preview: {
        lanes: [{ items: [] }, { items: [] }],
        criticalPath: [],
        clashes: [],
        tasks: 0,
        totalLaneHours: 0,
        scheduleHours: 0,
        nonLaneHoursPerTask: null,
        endEstimateHours: 0,
        landings: { pullRequests: 0, pullRequestsAlone: 0, ciRuns: 0, ciRunsAlone: 0 },
      },
      attachments: [],
      tokens: 0,
    };
    const services = stubServices({
      getShapeView: (id) => {
        if (id !== shapeId) throw new NotFoundError('shape', id);
        return view;
      },
    });
    const ok = await app(services).request(`/shapes/${shapeId}`, auth);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(view);
    expect((await app(services).request(`/shapes/${mintId('Shape')}`, auth)).status).toBe(404);
    expect((await app(services).request('/shapes/not-a-shape', auth)).status).toBe(400);
  });

  it('takes a message (202), refuses an empty one, and Propose answers started or ignored', async () => {
    const sent: string[] = [];
    const message = {
      id: mintId('ShapeMessage'),
      shapeId,
      author: 'builder',
      kind: 'text',
      body: 'Hi',
      createdAt: AT,
    };
    const services = stubServices({
      sendShapeMessage: (_id, text) => {
        sent.push(text);
        return message as never;
      },
      proposeShape: () => ({ status: 'ignored' }),
    });
    const ok = await app(services).request(`/shapes/${shapeId}/messages`, post({ text: 'Hi' }));
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual(message);
    expect(sent).toEqual(['Hi']);
    expect(
      (await app(services).request(`/shapes/${shapeId}/messages`, post({ text: '' }))).status,
    ).toBe(400);
    const propose = await app(services).request(`/shapes/${shapeId}/propose`, post({}));
    expect(propose.status).toBe(202);
    expect(await propose.json()).toEqual({ status: 'ignored' });
  });

  it('Stop answers 204', async () => {
    const stopped: string[] = [];
    const services = stubServices({
      stopShape: (id) => {
        stopped.push(id);
        return Promise.resolve();
      },
    });
    const res = await app(services).request(`/shapes/${shapeId}/stop`, post({}));
    expect(res.status).toBe(204);
    expect(stopped).toEqual([shapeId]);
  });

  it('runs the conversation on the model chosen, whatever its ID, refuses a blank one (400), and a change mid-turn (409)', async () => {
    const chosen: (string | null)[] = [];
    const services = stubServices({
      chooseShapeModel: (_id, model) => {
        if (model === 'opus') throw new ConflictError('a turn runs');
        chosen.push(model);
        return { ...shape, model };
      },
    });
    const put = (body: unknown) =>
      app(services).request(`/shapes/${shapeId}/model`, {
        method: 'PUT',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const ok = await put({ model: 'us.anthropic.claude-fable-5-1' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ...shape, model: 'us.anthropic.claude-fable-5-1' });
    expect((await put({ model: null })).status).toBe(200);
    expect((await put({ model: '  ' })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await put({ model: 'opus' })).status).toBe(409);
    expect(chosen).toEqual(['us.anthropic.claude-fable-5-1', null]);
  });

  describe('Convert', () => {
    const proposalId = mintId('ShapeProposal');
    it('answers what was created', async () => {
      const asked: unknown[] = [];
      const result = {
        createdNow: 1,
        results: [{ key: 'a', kind: 'task' as const, taskIds: [mintId('Task')] }],
      };
      const services = stubServices({
        convertShape: (_id, input) => {
          asked.push(input);
          return Promise.resolve({ kind: 'converted', result } as const);
        },
      });
      const res = await app(services).request(
        `/shapes/${shapeId}/convert`,
        post({ proposalIds: [proposalId], interrupt: true }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(result);
      expect(asked).toEqual([{ proposalIds: [proposalId], interrupt: true }]);
    });

    it('answers every refusal at once as a 400 {errors}', async () => {
      const services = stubServices({
        convertShape: () =>
          Promise.resolve({ kind: 'refused', errors: ['A depends on B', 'C is gone'] } as const),
      });
      const res = await app(services).request(
        `/shapes/${shapeId}/convert`,
        post({ proposalIds: [proposalId] }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ errors: ['A depends on B', 'C is gone'] });
    });

    it('answers 409 while Claude is still answering, and 400 for nothing selected', async () => {
      const services = stubServices({
        convertShape: () => Promise.reject(new ConflictError('Claude is still answering')),
      });
      const busy = await app(services).request(
        `/shapes/${shapeId}/convert`,
        post({ proposalIds: [proposalId] }),
      );
      expect(busy.status).toBe(409);
      expect(await busy.json()).toMatchObject({ message: 'Claude is still answering' });
      expect(
        (await app(services).request(`/shapes/${shapeId}/convert`, post({ proposalIds: [] })))
          .status,
      ).toBe(400);
    });
  });

  it('Remove Draft Goal and Withdraw Decision answer 204, with their refusals', async () => {
    const goalId = mintId('Goal');
    const decisionId = mintId('Decision');
    const calls: string[] = [];
    const services = stubServices({
      removeDraftGoal: (id) => {
        calls.push(`remove ${id}`);
        if (id !== goalId) throw new InvalidError('not a goal a conversation made');
      },
      withdrawShapeDecision: (_shape, id, reason) => {
        calls.push(`withdraw ${id} ${reason}`);
      },
    });
    expect((await app(services).request(`/goals/${goalId}/remove-draft`, post({}))).status).toBe(
      204,
    );
    expect(
      (await app(services).request(`/goals/${mintId('Goal')}/remove-draft`, post({}))).status,
    ).toBe(400);
    const withdrawn = await app(services).request(
      `/shapes/${shapeId}/decisions/${decisionId}/withdraw`,
      post({ reason: 'We chose differently' }),
    );
    expect(withdrawn.status).toBe(204);
    expect(calls).toContain(`withdraw ${decisionId} We chose differently`);
    expect(
      (
        await app(services).request(
          `/shapes/${shapeId}/decisions/${decisionId}/withdraw`,
          post({ reason: '' }),
        )
      ).status,
    ).toBe(400);
  });

  it('Withdraw Principle answers 204, and refuses a blank reason', async () => {
    const principleId = mintId('Principle');
    const calls: string[] = [];
    const services = stubServices({
      withdrawShapePrinciple: (shape, id, reason) => {
        calls.push(`withdraw ${shape} ${id} ${reason}`);
      },
    });
    const path = `/shapes/${shapeId}/principles/${principleId}/withdraw`;
    expect((await app(services).request(path, post({ reason: 'We allow it now' }))).status).toBe(
      204,
    );
    expect(calls).toEqual([`withdraw ${shapeId} ${principleId} We allow it now`]);
    expect((await app(services).request(path, post({ reason: '' }))).status).toBe(400);
  });

  describe('editing a row', () => {
    const proposalId = mintId('ShapeProposal');
    const path = `/shapes/${shapeId}/proposals/${proposalId}`;
    const patch = (body: unknown) => ({ method: 'PATCH', ...json, body: JSON.stringify(body) });

    it('edits, unpins, restores and drops a row, each answering 204', async () => {
      const calls: string[] = [];
      const services = stubServices({
        editShapeProposal: (s, p, fields) => {
          calls.push(`edit ${s} ${p} ${JSON.stringify(fields)}`);
        },
        unpinShapeProposal: (s, p, field) => {
          calls.push(`unpin ${s} ${p} ${field ?? '*'}`);
        },
        restoreShapeProposal: (s, p) => {
          calls.push(`restore ${s} ${p}`);
        },
        dropShapeProposal: (s, p) => {
          calls.push(`drop ${s} ${p}`);
        },
      });
      const request = (url: string, init: RequestInit) => app(services).request(url, init);
      expect((await request(path, patch({ fields: { size: 'M' } }))).status).toBe(204);
      expect((await request(`${path}/unpin`, post({ field: 'size' }))).status).toBe(204);
      expect((await request(`${path}/unpin`, post({}))).status).toBe(204);
      expect((await request(`${path}/restore`, post({}))).status).toBe(204);
      expect((await request(`${path}/drop`, post({}))).status).toBe(204);
      expect(calls).toEqual([
        `edit ${shapeId} ${proposalId} {"size":"M"}`,
        `unpin ${shapeId} ${proposalId} size`,
        `unpin ${shapeId} ${proposalId} *`,
        `restore ${shapeId} ${proposalId}`,
        `drop ${shapeId} ${proposalId}`,
      ]);
    });

    it('refuses an edit that sets nothing or names a malformed row, and passes on a service refusal', async () => {
      const services = stubServices({
        editShapeProposal: () => {
          throw new ConflictError('This proposal was converted');
        },
      });
      expect((await app(services).request(path, patch({ fields: {} }))).status).toBe(400);
      expect(
        (
          await app(services).request(
            `/shapes/${shapeId}/proposals/nope`,
            patch({ fields: { a: 1 } }),
          )
        ).status,
      ).toBe(400);
      const refused = await app(services).request(path, patch({ fields: { size: 'M' } }));
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ message: 'This proposal was converted' });
    });
  });

  describe('dropping a file', () => {
    const bytes = new TextEncoder().encode('# The brief');
    const upload = (body: Uint8Array = bytes, type = 'text/markdown') => ({
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': type },
      body,
    });
    const stored = (name: string) => ({
      id: mintId('ShapeFile'),
      shapeId,
      name,
      mediaType: 'text/markdown',
      size: bytes.length,
      storedPath: `/data/shapes/${shapeId}/files/${name}`,
      createdAt: AT,
    });

    it('passes the name, type and bytes to the service and answers 201 with the stored file', async () => {
      const seen: { name: string; mediaType: string; text: string }[] = [];
      const services = stubServices({
        addShapeFile: (_id, file) => {
          seen.push({
            name: file.name,
            mediaType: file.mediaType,
            text: new TextDecoder().decode(file.bytes),
          });
          return stored(file.name);
        },
      });
      const res = await app(services).request(
        `/shapes/${shapeId}/files?name=${encodeURIComponent('brief notes.md')}`,
        upload(),
      );
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ name: 'brief notes.md' });
      expect(seen).toEqual([
        { name: 'brief notes.md', mediaType: 'text/markdown', text: '# The brief' },
      ]);
    });

    it('takes a file up to 20 MB, past the limit every other body has', async () => {
      const services = stubServices({ addShapeFile: (_id, file) => stored(file.name) });
      const big = new Uint8Array(MAX_BODY_BYTES + 1024);
      const res = await app(services).request(
        `/shapes/${shapeId}/files?name=big.pdf`,
        upload(big, 'application/pdf'),
      );
      expect(res.status).toBe(201);
    });

    it('refuses a body past 20 MB without reading it on', async () => {
      const services = stubServices({ addShapeFile: (_id, file) => stored(file.name) });
      const tooBig = new Uint8Array(20 * 1024 * 1024 + 4096);
      const res = await app(services).request(
        `/shapes/${shapeId}/files?name=big.pdf`,
        upload(tooBig, 'application/pdf'),
      );
      expect(res.status).toBe(413);
    });

    it('needs a name, and says why a file is refused', async () => {
      const services = stubServices({
        addShapeFile: () => {
          throw new InvalidError(
            'run.sh can’t be added: drop Markdown, plain text, PDF, PNG, JPEG or WebP',
          );
        },
      });
      expect((await app(services).request(`/shapes/${shapeId}/files`, upload())).status).toBe(400);
      const refused = await app(services).request(`/shapes/${shapeId}/files?name=run.sh`, upload());
      expect(refused.status).toBe(400);
      expect(JSON.stringify(await refused.json())).toContain('run.sh');
    });
  });

  it('needs the token', async () => {
    for (const [method, path] of [
      ['GET', `/projects/${projectId}/shapes`],
      ['GET', `/shapes/${shapeId}`],
      ['POST', `/shapes/${shapeId}/messages`],
      ['POST', `/shapes/${shapeId}/convert`],
      ['POST', `/shapes/${shapeId}/files`],
      ['PATCH', `/shapes/${shapeId}/proposals/${mintId('ShapeProposal')}`],
    ] as const)
      expect((await app().request(path, { method })).status).toBe(401);
  });
});

describe('knowledge routes', () => {
  const pid = mintId('Project');
  const did = mintId('Decision');
  const pri = mintId('Principle');
  const prp = mintId('Proposal');
  const decision = { question: 'q', choice: 'c', rationale: 'r' };
  const principle = { statement: 's', kind: 'policy', topicKey: 'k' };
  const request = (method: string, path: string, body?: unknown) =>
    app().request(path, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  it.each([
    [
      'GET',
      `/projects/${pid}/knowledge?q=queue&shelf=all&kind=policy&kind=belief&page=2&pageSize=5`,
      undefined,
      'listKnowledge',
    ],
    ['POST', `/projects/${pid}/decisions`, decision, 'recordDecision'],
    ['POST', `/decisions/${did}/supersede`, { choice: 'x', dryRun: true }, 'supersedeDecision'],
    ['POST', `/decisions/${did}/withdraw`, { reason: 'x' }, 'withdrawDecision'],
    ['GET', `/decisions/${did}/provenance`, undefined, 'decisionProvenance'],
    ['POST', `/projects/${pid}/principles`, principle, 'createPrinciple'],
    ['POST', `/principles/${pri}/supersede`, { topicKey: 'new.key' }, 'supersedePrinciple'],
    ['POST', `/principles/${pri}/retire`, { reason: 'x' }, 'retirePrinciple'],
    ['POST', `/principles/${pri}/withdraw`, { reason: 'x' }, 'withdrawPrinciple'],
    ['GET', `/principles/${pri}/provenance`, undefined, 'principleProvenance'],
    ['GET', `/projects/${pid}/proposals?status=accepted`, undefined, 'listProposals'],
    ['POST', `/proposals/${prp}/accept`, { scope: 'you' }, 'acceptProposal'],
    ['POST', `/proposals/${prp}/reject`, { note: 'no' }, 'rejectProposal'],
  ] as const)('%s %s reaches %s', async (method, path, body, service) => {
    expect((await request(method, path, body)).status).toBe(500);
    expect(reached).toEqual([service]);
  });

  it.each([
    ['an unknown list parameter', 'GET', `/projects/${pid}/knowledge?quer=x`, undefined],
    ['an unknown kind', 'GET', `/projects/${pid}/knowledge?kind=rule`, undefined],
    ['an unknown scope', 'GET', `/projects/${pid}/knowledge?scope=team`, undefined],
    ['a blank withdraw reason', 'POST', `/decisions/${did}/withdraw`, { reason: ' ' }],
    ['a source with no tool', 'POST', `/projects/${pid}/decisions`, { ...decision, source: {} }],
    ['an unknown body field', 'POST', `/projects/${pid}/decisions`, { ...decision, colour: 'x' }],
    [
      'a principle with a bad topic key',
      'POST',
      `/projects/${pid}/principles`,
      { ...principle, topicKey: 'Bad Key' },
    ],
    ['an edit that changes nothing', 'POST', `/principles/${pri}/supersede`, { dryRun: true }],
    ['a malformed id', 'POST', '/decisions/nope/withdraw', { reason: 'x' }],
  ] as const)('answers 400 for %s', async (_name, method, path, body) => {
    expect((await request(method, path, body)).status).toBe(400);
    expect(reached).toEqual([]);
  });

  it('names the field of a refused body', async () => {
    const res = await request('POST', `/projects/${pid}/decisions`, { ...decision, colour: 'x' });
    expect(JSON.stringify(await res.json())).toContain('colour');
    const bad = await request('POST', `/projects/${pid}/principles`, {
      ...principle,
      topicKey: 'Bad Key',
    });
    expect(JSON.stringify(await bad.json())).toContain('topicKey');
  });

  it('needs the token', async () => {
    for (const [method, path] of [
      ['GET', `/projects/${pid}/knowledge`],
      ['POST', `/projects/${pid}/decisions`],
      ['GET', `/principles/${pri}/provenance`],
      ['POST', `/proposals/${prp}/accept`],
    ] as const)
      expect((await app().request(path, { method })).status).toBe(401);
  });
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

  it('passes a goalId to its service, and none when the query has none', async () => {
    const goalId = mintId('Goal');
    const seen: (string | undefined)[] = [];
    const services = stubServices({
      proposeCandidates: (_id, size, goal) => {
        seen.push(goal);
        return { projectId, size, candidates: [] };
      },
    });
    await app(services).request(`/projects/${projectId}/candidates?size=2&goalId=${goalId}`, auth);
    await app(services).request(`/projects/${projectId}/candidates?size=2`, auth);
    expect(seen).toEqual([goalId, undefined]);
  });

  it('answers 400 for a goalId of another project', async () => {
    const res = await app(
      stubServices({
        proposeCandidates: () => {
          throw new InvalidError('Goal is not in this project');
        },
      }),
    ).request(`/projects/${projectId}/candidates?size=2&goalId=${mintId('Goal')}`, auth);
    expect(res.status).toBe(400);
  });

  it('answers 400 for a malformed goalId without calling the service', async () => {
    const res = await app().request(
      `/projects/${projectId}/candidates?size=2&goalId=${mintId('Task')}`,
      auth,
    );
    expect(res.status).toBe(400);
    expect(reached).toEqual([]);
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

describe('area proposal route', () => {
  it('POST /folders/propose-areas refuses a relative path with 400', async () => {
    const res = await app().request('/folders/propose-areas', {
      method: 'POST',
      ...json,
      body: JSON.stringify({ path: 'relative/dir' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /folders/propose-areas answers the proposal the service makes for the path', async () => {
    const proposal: AreaProposalResult = {
      ok: true,
      proposal: {
        namedBy: 'structure',
        areas: [{ name: 'root', globs: ['*'], reason: 'The top of the repository.' }],
      },
    };
    const seen: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const res = await app(
      stubServices({
        proposeAreas: (path, signal) => {
          seen.push(path);
          signals.push(signal);
          return Promise.resolve(proposal);
        },
      }),
    ).request('/folders/propose-areas', {
      method: 'POST',
      ...json,
      body: JSON.stringify({ path: '/repo' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(proposal);
    expect(seen).toEqual(['/repo']);
    // The request's own signal, so a client that disconnects stops the proposal.
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('judge routes', () => {
  it.each([
    { route: 'GET /judge', method: 'GET', path: '/judge', service: 'judgeStatus' },
    {
      route: 'PATCH /judge',
      method: 'PATCH',
      path: '/judge',
      body: { enabled: false },
      service: 'patchJudge',
    },
    {
      route: 'PUT /judge/key',
      method: 'PUT',
      path: '/judge/key',
      body: { key: 'a-key' },
      service: 'setJudgeKey',
    },
    { route: 'DELETE /judge/key', method: 'DELETE', path: '/judge/key', service: 'removeJudgeKey' },
    { route: 'POST /judge/test', method: 'POST', path: '/judge/test', service: 'testJudge' },
    { route: 'GET /judge/calls', method: 'GET', path: '/judge/calls', service: 'listJudgeCalls' },
  ])('$route reaches $service behind the token', async ({ method, path, body, service }) => {
    const init = { ...json, method, ...(body ? { body: JSON.stringify(body) } : {}) };
    expect((await app().request(path, { method })).status).toBe(401);
    expect((await app().request(path, init)).status).toBe(500);
    expect(reached).toEqual([service]);
  });

  it.each([
    ['PATCH /judge with an unknown field', 'PATCH', '/judge', { nope: 1 }],
    [
      'PATCH /judge with a floor above one',
      'PATCH',
      '/judge',
      { decisions: { review_size: { floor: 2 } } },
    ],
    ['PUT /judge/key with an empty key', 'PUT', '/judge/key', { key: '' }],
    ['PUT /judge/key with a space in the key', 'PUT', '/judge/key', { key: 'a b' }],
    ['PUT /judge/key with an extra field', 'PUT', '/judge/key', { key: 'a-key', more: 1 }],
  ])('answers 400 for %s without reaching a service', async (_name, method, path, body) => {
    const res = await app().request(path, { ...json, method, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
    expect(reached).toEqual([]);
  });

  it.each([
    ['150', 100],
    ['7', 7],
    ['0', 20],
    ['x', 20],
  ])('asks for %s calls as %s', async (limit, asked) => {
    const seen: number[] = [];
    const services = stubServices({
      listJudgeCalls: (n) => {
        seen.push(n);
        return [];
      },
    });
    expect((await app(services).request(`/judge/calls?limit=${limit}`, auth)).status).toBe(200);
    expect(seen).toEqual([asked]);
  });

  describe('body size limit', () => {
    const adoptPath = `/projects/${mintId('Project')}/goals/adopt`;
    const oversize = 'x'.repeat(MAX_BODY_BYTES + 1);

    it('answers 413 for a body over the limit without parsing it or reaching the service', async () => {
      // Not JSON: a parse would answer 400, so a 413 shows the body was never parsed.
      const services = stubServices({ adoptGoal: track('adoptGoal') });
      const res = await app(services).request(adoptPath, {
        method: 'POST',
        ...json,
        body: oversize,
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: 'invalid' });
      expect(reached).toEqual([]);
    });

    it('answers 413 for a streamed body over the limit that declares no length', async () => {
      const services = stubServices({ adoptGoal: track('adoptGoal') });
      const chunk = new TextEncoder().encode('x'.repeat(1024 * 1024));
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent > MAX_BODY_BYTES) controller.close();
          else controller.enqueue(chunk);
          sent += chunk.length;
        },
      });
      const res = await app(services).request(adoptPath, {
        method: 'POST',
        ...json,
        body,
        duplex: 'half',
      });
      expect(res.status).toBe(413);
      expect(reached).toEqual([]);
    });

    it('answers 413 for a declared Content-Length over the limit without reading the body', async () => {
      const services = stubServices({ adoptGoal: track('adoptGoal') });
      let pulls = 0;
      // highWaterMark 0: the stream pulls only when something reads it.
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(new TextEncoder().encode('x'));
          },
        },
        { highWaterMark: 0 },
      );
      const res = await app(services).request(adoptPath, {
        method: 'POST',
        headers: { ...json.headers, 'content-length': String(MAX_BODY_BYTES + 1) },
        body,
        duplex: 'half',
      });
      expect(res.status).toBe(413);
      expect(pulls).toBe(0);
      expect(reached).toEqual([]);
    });

    it('answers 401 before 413 for a request without the token', async () => {
      const res = await app().request(adoptPath, { method: 'POST', body: oversize });
      expect(res.status).toBe(401);
    });

    it.each([
      ['plain text', 'a'.repeat(1024 * 1024)],
      ['text that escapes to two bytes a character', '\n'.repeat(1024 * 1024)],
      ['text that escapes to six bytes a character', '\u0001'.repeat(1024 * 1024)],
    ])('still accepts a 1 MiB brief of %s sent as JSON text', async (_name, text) => {
      const seen: number[] = [];
      const services = stubServices({
        adoptGoal: (_projectId, input) => {
          seen.push(input.text?.length ?? 0);
          return Promise.resolve({ kind: 'refused', errors: [{ path: 'brief', message: 'no' }] });
        },
      });
      const res = await app(services).request(adoptPath, {
        method: 'POST',
        ...json,
        body: JSON.stringify({ text }),
      });
      expect(res.status).toBe(400);
      expect(seen).toEqual([text.length]);
    });
  });
});
