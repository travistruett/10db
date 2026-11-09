// The tests read the daemon's JSON answers field by field and assert on what they read, so the
// answers are `any` here; the contract schemas the routes parse with are tested in packages/contracts.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-explicit-any */
import { join } from 'node:path';
import { mintId, ProjectDto, ShapeOrigin, type KnowledgeItemDto } from '@10db/contracts';
import { insertSession, insertShape, insertSource } from '@10db/db';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { proposePrinciple } from '../src/knowledge';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir } from './fixtures';

// The builder-facing knowledge routes, over real HTTP (docs/knowledge-api.md).

let data: ReturnType<typeof tempDir>;
let repo: ReturnType<typeof createTempRepo>;
let daemon: RunningDaemon | null = null;
beforeEach(() => {
  data = tempDir('knowledge api');
  repo = createTempRepo();
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  repo.cleanup();
  data.cleanup();
});

const launch = () =>
  startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
  });

// A parsed JSON answer: the tests below read it field by field and assert on what they read.
type Body = any;

async function start() {
  daemon = await launch();
  const project = await apiClient(daemon.url, daemon.token).post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'api', globs: ['src/api/**'] }],
  });
  return { project, state: daemon.state, call: caller(daemon) };
}

function caller(d: RunningDaemon) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${d.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${d.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: z.any().parse(await res.json()) };
  };
}

function running(): RunningDaemon {
  if (!daemon) throw new Error('the daemon is not started');
  return daemon;
}

const sourceCount = (d: RunningDaemon) =>
  (d.state.db.$client.prepare('SELECT count(*) AS n FROM sources').get() as { n: number }).n;

type Caller = ReturnType<typeof caller>;

function proposeRule(project: { id: z.infer<typeof ProjectDto>['id'] }, key = 'testing.no-sleeps') {
  return running().state.write((ctx) =>
    proposePrinciple(ctx, {
      projectId: project.id,
      title: 'No sleeps',
      body: 'b',
      draft: {
        statement: 'Never sleep in tests',
        kind: 'policy',
        scope: 'project',
        topicKey: key,
      },
      sourceId: insertSource(ctx, 'agent', {}),
      speaker: 'agent:x',
    }),
  );
}

describe('one list for decisions and principles', () => {
  it('returns both kinds, builder-wide ones too, each with its id, kind, scope, area, state and date', async () => {
    const { project, call } = await start();
    const decision = await call('POST', `/projects/${project.id}/decisions`, {
      question: 'Which queue library?',
      choice: 'BullMQ',
      rationale: 'Redis is there',
    });
    const rule = await call('POST', `/projects/${project.id}/principles`, {
      scope: 'you',
      statement: 'Never sleep in tests',
      kind: 'policy',
      topicKey: 'testing.no-sleeps',
      rationale: 'flaky',
    });
    expect([decision.status, rule.status]).toEqual([201, 201]);
    const list = await call('GET', `/projects/${project.id}/knowledge`);
    expect(list.status).toBe(200);
    const items = z
      .array(z.looseObject({ id: z.string(), kind: z.string() }))
      .parse(list.body.items);
    expect(items.map((i) => i.id).toSorted()).toEqual([decision.body.id, rule.body.id].toSorted());
    expect(list.body.items.find((i: Body) => i.kind === 'principle')).toMatchObject({
      scope: 'you',
      area: null,
      state: 'current',
      principleKind: 'policy',
      topicKey: 'testing.no-sleeps',
      statement: 'Never sleep in tests',
      rationale: 'flaky',
      createdAt: expect.any(String),
    });
    expect(list.body.search).toEqual({ available: true, message: null });
    // a second project sees the builder-wide principle only
    const second = createTempRepo();
    try {
      const other = await apiClient(running().url, running().token).post('/projects', ProjectDto, {
        name: 'other',
        repoPath: second.path,
        gateCommand: 'true',
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
      const theirs = await call('GET', `/projects/${other.id}/knowledge`);
      expect(theirs.body.items.map((i: Body) => i.id)).toEqual([rule.body.id]);
    } finally {
      second.cleanup();
    }
  });

  it('filters by text, kind, scope, area and shelf', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const d = (
      await call('POST', `${base}/decisions`, {
        question: 'Which queue?',
        choice: 'a',
        rationale: 'r',
      })
    ).body;
    const old = (
      await call('POST', `${base}/principles`, {
        statement: 'Never sleep',
        kind: 'policy',
        topicKey: 'k.sleep',
      })
    ).body;
    const next = (
      await call('POST', `${base}/principles`, {
        statement: 'Never sleep or poll',
        kind: 'policy',
        topicKey: 'k.sleep',
      })
    ).body;
    const area = (
      await call('POST', `${base}/principles`, {
        scope: 'area',
        area: 'api',
        statement: 'Validate with zod',
        kind: 'heuristic',
        topicKey: 'api.zod',
      })
    ).body;
    const ids = async (query: string) =>
      (await call('GET', `${base}/knowledge${query}`)).body.items.map((i: Body) => i.id).toSorted();
    expect(await ids('?q=queue')).toEqual([d.id]);
    expect(await ids('?q=sleep')).toEqual([next.id]);
    expect(await ids('?q=sleep&shelf=all')).toEqual([old.id, next.id].toSorted());
    expect(await ids('?q=sleep&shelf=past')).toEqual([old.id]);
    expect(await ids('?kind=decision')).toEqual([d.id]);
    expect(await ids('?kind=heuristic')).toEqual([area.id]);
    expect(await ids('?kind=decision&kind=heuristic')).toEqual([d.id, area.id].toSorted());
    expect(await ids('?scope=area&area=api')).toEqual([area.id]);
    expect(await ids('?scope=you')).toEqual([]);
  });

  it.each([
    ['an area the project lacks', '?area=billing', 400, /billing/],
    ['an unknown kind', '?kind=rule', 400, /kind/],
    ['a page larger than the largest', '?pageSize=101', 400, /pageSize/],
    ['an unknown parameter', '?quer=x', 400, /quer/],
  ])('answers 400 for %s', async (_name, query, status, message) => {
    const { project, call } = await start();
    const res = await call('GET', `/projects/${project.id}/knowledge${query}`);
    expect(res.status).toBe(status);
    expect(JSON.stringify(res.body)).toMatch(message);
  });

  it('answers 404 for an unknown project', async () => {
    const { call } = await start();
    expect((await call('GET', `/projects/${mintId('Project')}/knowledge`)).status).toBe(404);
  });
});

describe('writing and reading back', () => {
  it('records a decision with a claude_code source and shows it in provenance', async () => {
    const { project, call } = await start();
    const source = { via: 'claude_code', sessionId: 'cc-7', cwd: repo.path, quote: 'use BullMQ' };
    const made = await call('POST', `/projects/${project.id}/decisions`, {
      question: 'Which queue library?',
      choice: 'BullMQ',
      rationale: 'Redis is there',
      source,
    });
    expect(made.status).toBe(201);
    const prov = await call('GET', `/decisions/${made.body.id}/provenance`);
    expect(prov.body).toMatchObject({
      kind: 'decision',
      sourceKind: 'builder',
      sourceRef: source,
      origin: { via: 'claude_code', sessionId: 'cc-7', cwd: repo.path },
      quote: 'use BullMQ',
      by: 'me',
      recordedAt: expect.any(String),
    });
  });

  it('names the Shape conversation of a record whose source is a Shape session, with no workstream', async () => {
    const { project, state, call } = await start();
    const shape = state.write((ctx) =>
      insertShape(ctx, project.id, { title: 'Density', origin: ShapeOrigin.App }),
    );
    const session = state.write((ctx) =>
      insertSession(ctx, {
        shapeId: shape.id,
        provider: 'claude',
        model: 'sonnet',
        effort: 'medium',
        mode: 'managed',
        mcpTokenHash: 'h',
      }),
    );
    const { principle } = state.write((ctx) =>
      proposePrinciple(ctx, {
        projectId: project.id,
        title: 'No sleeps',
        body: 'b',
        draft: {
          statement: 'Never sleep in tests',
          kind: 'policy',
          scope: 'project',
          topicKey: 'testing.no-sleeps',
        },
        sourceId: insertSource(ctx, 'agent', { sessionId: session.id }),
        speaker: `agent:${session.id}`,
      }),
    );
    const prov = await call('GET', `/principles/${principle.id}/provenance`);
    expect(prov.status).toBe(200);
    expect(prov.body.session).toEqual({
      id: session.id,
      workstreamId: null,
      shapeId: shape.id,
      taskTitle: null,
      shapeTitle: 'Density',
    });
  });

  it('supersedes and withdraws a decision, each showing in the next list and in provenance', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const first = (
      await call('POST', `${base}/decisions`, {
        question: 'Which queue?',
        choice: 'BullMQ',
        rationale: 'r',
      })
    ).body;
    const next = await call('POST', `/decisions/${first.id}/supersede`, {
      choice: 'pg-boss',
      rationale: 'one database',
    });
    expect(next.status).toBe(201);
    expect(next.body).toMatchObject({
      choice: 'pg-boss',
      question: 'Which queue?',
      supersedesId: first.id,
    });
    const states = async () =>
      Object.fromEntries(
        (await call('GET', `${base}/knowledge?q=queue&shelf=all`)).body.items.map((i: Body) => [
          i.id,
          i.state,
        ]),
      );
    expect(await states()).toEqual({ [first.id]: 'superseded', [next.body.id]: 'current' });
    const again = await call('POST', `/decisions/${first.id}/supersede`, { choice: 'x' });
    expect(again.status).toBe(409);
    expect(again.body.message).toContain(next.body.id);
    const early = await call('POST', `/decisions/${first.id}/withdraw`, { reason: 'x' });
    expect(early.status).toBe(409);
    expect(early.body.message).toContain(next.body.id);
    const gone = await call('POST', `/decisions/${next.body.id}/withdraw`, { reason: 'reverted' });
    expect(gone.status).toBe(200);
    expect(await states()).toEqual({ [first.id]: 'current', [next.body.id]: 'withdrawn' });
    expect((await call('GET', `/decisions/${next.body.id}/provenance`)).body).toMatchObject({
      state: 'withdrawn',
      supersedes: first.id,
      withdrawn: { by: 'me', reason: 'reverted' },
    });
    expect((await call('GET', `/decisions/${first.id}/provenance`)).body.supersededBy).toBeNull();
  });

  it('supersedes a principle into a new statement, kind, key and scope', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const old = (
      await call('POST', `${base}/principles`, {
        statement: 'Never sleep',
        kind: 'policy',
        topicKey: 'k.sleep',
      })
    ).body;
    const next = await call('POST', `/principles/${old.id}/supersede`, {
      statement: 'Wait on conditions',
      kind: 'heuristic',
      topicKey: 'k.wait',
      scope: 'you',
      source: { via: 'claude_code', sessionId: 'cc-1' },
    });
    expect(next.status).toBe(201);
    expect(next.body).toMatchObject({
      statement: 'Wait on conditions',
      principleKind: 'heuristic',
      topicKey: 'k.wait',
      scope: 'you',
      projectId: null,
      supersedesId: old.id,
    });
    const prov = (await call('GET', `/principles/${old.id}/provenance`)).body;
    expect(prov).toMatchObject({
      state: 'superseded',
      supersededBy: next.body.id,
      supersededByText: 'Wait on conditions',
    });
    expect((await call('GET', `/principles/${next.body.id}/provenance`)).body).toMatchObject({
      supersedes: old.id,
      origin: { via: 'claude_code', sessionId: 'cc-1' },
    });
  });

  it('answers 409 naming the holder of a taken key, for the write and for its dry run', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const a = (
      await call('POST', `${base}/principles`, {
        statement: 'Rule a',
        kind: 'policy',
        topicKey: 'a.rule',
      })
    ).body;
    const b = (
      await call('POST', `${base}/principles`, {
        statement: 'Rule b',
        kind: 'policy',
        topicKey: 'b.rule',
      })
    ).body;
    for (const dryRun of [false, true]) {
      const res = await call('POST', `/principles/${a.id}/supersede`, {
        topicKey: 'b.rule',
        dryRun,
      });
      expect(res.status).toBe(409);
      expect(res.body.message).toContain(b.id);
    }
  });

  it('retires and withdraws a principle with a reason, and the next list shows it', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const a = (
      await call('POST', `${base}/principles`, {
        statement: 'Rule a',
        kind: 'policy',
        topicKey: 'a.rule',
      })
    ).body;
    const b = (
      await call('POST', `${base}/principles`, {
        statement: 'Rule b',
        kind: 'policy',
        topicKey: 'b.rule',
      })
    ).body;
    expect((await call('POST', `/principles/${a.id}/retire`, {})).status).toBe(400);
    const retired = await call('POST', `/principles/${a.id}/retire`, { reason: 'obsolete' });
    expect(retired.body).toMatchObject({ state: 'retired', retiredReason: 'obsolete' });
    const withdrawn = await call('POST', `/principles/${b.id}/withdraw`, { reason: 'wrong' });
    expect(withdrawn.body).toMatchObject({ state: 'withdrawn', withdrawnReason: 'wrong' });
    expect((await call('GET', `${base}/knowledge`)).body.items).toEqual([]);
    const all = (await call('GET', `${base}/knowledge?shelf=all`)).body.items;
    expect(all.map((i: KnowledgeItemDto) => i.state).toSorted()).toEqual(['retired', 'withdrawn']);
    const again = await call('POST', `/principles/${a.id}/retire`, { reason: 'twice' });
    expect(again.status).toBe(409);
    expect((await call('GET', `/principles/${a.id}/provenance`)).body).toMatchObject({
      retired: { by: 'me', reason: 'obsolete' },
    });
  });

  it('names the current principle when a replaced one is superseded, retired or withdrawn', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const old = (
      await call('POST', `${base}/principles`, {
        statement: 'Never sleep',
        kind: 'policy',
        topicKey: 'k.sleep',
      })
    ).body;
    const next = (
      await call('POST', `${base}/principles`, {
        statement: 'Never sleep or poll',
        kind: 'policy',
        topicKey: 'k.sleep',
      })
    ).body;
    for (const [path, body] of [
      ['supersede', { statement: 'x' }],
      ['retire', { reason: 'x' }],
      ['withdraw', { reason: 'x' }],
    ] as const) {
      const res = await call('POST', `/principles/${old.id}/${path}`, body);
      expect(res.status).toBe(409);
      expect(res.body.message).toContain(next.id);
    }
  });

  it('answers 400 naming an unknown area, and 404 for an unknown record', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const area = await call('POST', `${base}/decisions`, {
      scope: 'area',
      area: 'billing',
      question: 'q',
      choice: 'c',
      rationale: 'r',
    });
    expect(area.status).toBe(400);
    expect(area.body.message).toContain('billing');
    const missing = await call('POST', `${base}/principles`, { scope: 'area', statement: 's' });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/^area:/);
    const stray = await call('POST', `${base}/decisions`, {
      question: 'q',
      choice: 'c',
      rationale: 'r',
      colour: 'x',
    });
    expect(stray.status).toBe(400);
    for (const [method, path, body] of [
      ['POST', `/decisions/${mintId('Decision')}/supersede`, { choice: 'x' }],
      ['POST', `/decisions/${mintId('Decision')}/withdraw`, { reason: 'x' }],
      ['GET', `/decisions/${mintId('Decision')}/provenance`, undefined],
      ['POST', `/principles/${mintId('Principle')}/supersede`, { statement: 'x' }],
      ['POST', `/principles/${mintId('Principle')}/retire`, { reason: 'x' }],
      ['POST', `/principles/${mintId('Principle')}/withdraw`, { reason: 'x' }],
      ['GET', `/principles/${mintId('Principle')}/provenance`, undefined],
      ['POST', `/proposals/${mintId('Proposal')}/accept`, {}],
      ['POST', `/proposals/${mintId('Proposal')}/reject`, {}],
    ] as const) {
      expect((await call(method, path, body)).status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('a 409 names the live record', () => {
  const decide = async (call: Caller, base: string) =>
    (await call('POST', `${base}/decisions`, { question: 'q', choice: 'a', rationale: 'r' })).body;
  const state = async (call: Caller, id: string) =>
    (await call('GET', `/${id.startsWith('dec_') ? 'decisions' : 'principles'}/${id}/provenance`))
      .body.state;
  const rule = async (call: Caller, base: string) =>
    (await call('POST', `${base}/principles`, { statement: 'Rule', topicKey: 'k.rule' })).body;

  it('walks back from a withdrawn decision to the one that is current again', async () => {
    const { project, call } = await start();
    const a = await decide(call, `/projects/${project.id}`);
    const b = (await call('POST', `/decisions/${a.id}/supersede`, { choice: 'b' })).body;
    await call('POST', `/decisions/${b.id}/withdraw`, { reason: 'wrong' });
    for (const [path, body] of [
      ['supersede', { choice: 'c' }],
      ['withdraw', { reason: 'again' }],
    ] as const) {
      const res = await call('POST', `/decisions/${b.id}/${path}`, body);
      expect(res.status).toBe(409);
      expect(res.body.message).toContain(`the current one is ${a.id}`);
    }
  });

  it('walks back from a withdrawn principle to the one that is current again', async () => {
    const { project, call } = await start();
    const a = await rule(call, `/projects/${project.id}`);
    const b = (await call('POST', `/principles/${a.id}/supersede`, { statement: 'Next' })).body;
    await call('POST', `/principles/${b.id}/withdraw`, { reason: 'wrong' });
    for (const [path, body] of [
      ['supersede', { statement: 'x' }],
      ['retire', { reason: 'x' }],
      ['withdraw', { reason: 'again' }],
    ] as const) {
      const res = await call('POST', `/principles/${b.id}/${path}`, body);
      expect(res.status).toBe(409);
      expect(res.body.message).toContain(`the current one is ${a.id}`);
    }
  });

  it('says none is current rather than naming a retired head', async () => {
    const { project, call } = await start();
    const a = await rule(call, `/projects/${project.id}`);
    const b = (await call('POST', `/principles/${a.id}/supersede`, { statement: 'Next' })).body;
    await call('POST', `/principles/${b.id}/retire`, { reason: 'obsolete' });
    expect([await state(call, a.id), await state(call, b.id)]).toEqual(['superseded', 'retired']);
    for (const [path, body] of [
      ['supersede', { statement: 'x' }],
      ['retire', { reason: 'x' }],
      ['withdraw', { reason: 'x' }],
    ] as const) {
      const res = await call('POST', `/principles/${a.id}/${path}`, body);
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('none is current');
      expect(res.body.message).not.toContain(`the current one is ${b.id}`);
    }
  });

  it('says none is current for a withdrawn decision with nothing behind it', async () => {
    const { project, call } = await start();
    const a = await decide(call, `/projects/${project.id}`);
    await call('POST', `/decisions/${a.id}/withdraw`, { reason: 'wrong' });
    const res = await call('POST', `/decisions/${a.id}/withdraw`, { reason: 'again' });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('none is current');
  });
});

describe('dry runs of a retire or a withdrawal', () => {
  const snapshot = async (call: Caller, base: string) => ({
    list: (await call('GET', `${base}/knowledge?shelf=all`)).body,
    sources: sourceCount(running()),
  });

  it('say what a retire would change, and write nothing', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const made = await call('POST', `${base}/principles`, { statement: 'Rule', topicKey: 'k.r' });
    const before = await snapshot(call, base);
    const dry = await call('POST', `/principles/${made.body.id}/retire`, {
      reason: 'obsolete',
      dryRun: true,
      source: { via: 'claude_code' },
    });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({
      dryRun: true,
      wouldWrite: { kind: 'principle', state: 'retired', retiredReason: 'obsolete' },
      replaces: { id: made.body.id, state: 'current' },
      restores: null,
    });
    expect(await snapshot(call, base)).toEqual(before);
  });

  it('say which principle a withdrawal would make current again', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const a = (await call('POST', `${base}/principles`, { statement: 'A', topicKey: 'k.r' })).body;
    const b = (await call('POST', `/principles/${a.id}/supersede`, { statement: 'B' })).body;
    const before = await snapshot(call, base);
    const dry = await call('POST', `/principles/${b.id}/withdraw`, {
      reason: 'wrong',
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({
      dryRun: true,
      wouldWrite: { state: 'withdrawn', withdrawnReason: 'wrong' },
      replaces: { id: b.id, state: 'current' },
      restores: { id: a.id, state: 'current' },
    });
    expect(await snapshot(call, base)).toEqual(before);
  });

  it('say which decision a withdrawal would make current again', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const a = (
      await call('POST', `${base}/decisions`, { question: 'q', choice: 'a', rationale: 'r' })
    ).body;
    const b = (await call('POST', `/decisions/${a.id}/supersede`, { choice: 'b' })).body;
    const before = await snapshot(call, base);
    const dry = await call('POST', `/decisions/${b.id}/withdraw`, {
      reason: 'wrong',
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({
      wouldWrite: { kind: 'decision', state: 'withdrawn' },
      replaces: { id: b.id, state: 'current' },
      restores: { id: a.id, state: 'current', choice: 'a' },
    });
    expect(await snapshot(call, base)).toEqual(before);
  });

  it('answer the 400 and the 409 the write would', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const a = (await call('POST', `${base}/principles`, { statement: 'A', topicKey: 'k.a' })).body;
    const b = (await call('POST', `/principles/${a.id}/supersede`, { statement: 'B' })).body;
    expect((await call('POST', `/principles/${b.id}/retire`, { dryRun: true })).status).toBe(400);
    for (const path of ['retire', 'withdraw']) {
      const res = await call('POST', `/principles/${a.id}/${path}`, { reason: 'x', dryRun: true });
      expect(res.status).toBe(409);
      expect(res.body.message).toContain(b.id);
    }
    const unknown = await call('POST', `/decisions/${mintId('Decision')}/withdraw`, {
      reason: 'x',
      dryRun: true,
    });
    expect(unknown.status).toBe(404);
  });

  it('answer the 409 of a withdrawal that would revive a clash', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const a = (await call('POST', `${base}/principles`, { statement: 'A', topicKey: 'k.a' })).body;
    const b = (
      await call('POST', `/principles/${a.id}/supersede`, { statement: 'B', topicKey: 'k.b' })
    ).body;
    const c = (await call('POST', `${base}/principles`, { statement: 'C', topicKey: 'k.a' })).body;
    const res = await call('POST', `/principles/${b.id}/withdraw`, { reason: 'x', dryRun: true });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain(c.id);
  });
});

describe('a source on every write', () => {
  const source = {
    via: 'claude_code',
    sessionId: 'cc-9',
    cwd: '/repo',
    quote: 'that is out of date',
  };
  const shown = {
    via: 'claude_code',
    sessionId: 'cc-9',
    cwd: '/repo',
    quote: 'that is out of date',
    recordedAt: expect.any(String),
  };

  it('shows a retire, and a principle withdrawal, in provenance with their source', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const a = (await call('POST', `${base}/principles`, { statement: 'A', topicKey: 'k.a' })).body;
    const b = (await call('POST', `${base}/principles`, { statement: 'B', topicKey: 'k.b' })).body;
    const before = sourceCount(running());
    const retired = await call('POST', `/principles/${a.id}/retire`, { reason: 'old', source });
    const gone = await call('POST', `/principles/${b.id}/withdraw`, { reason: 'wrong', source });
    expect([retired.status, gone.status]).toEqual([200, 200]);
    expect(sourceCount(running())).toBe(before + 2);
    expect((await call('GET', `/principles/${a.id}/provenance`)).body).toMatchObject({
      retired: { by: 'me', reason: 'old', source: shown },
      withdrawn: null,
    });
    expect((await call('GET', `/principles/${b.id}/provenance`)).body).toMatchObject({
      withdrawn: { by: 'me', reason: 'wrong', source: shown },
    });
    expect((await call('GET', `${base}/knowledge`)).body.items).toEqual([]);
    const history = (await call('GET', `${base}/knowledge?shelf=all`)).body.items;
    expect(history.map((i: Body) => i.state).toSorted()).toEqual(['retired', 'withdrawn']);
  });

  it('shows a decision withdrawal in provenance with its source', async () => {
    const { project, call } = await start();
    const d = (
      await call('POST', `/projects/${project.id}/decisions`, {
        question: 'q',
        choice: 'a',
        rationale: 'r',
      })
    ).body;
    await call('POST', `/decisions/${d.id}/withdraw`, { reason: 'wrong', source });
    expect((await call('GET', `/decisions/${d.id}/provenance`)).body).toMatchObject({
      confirmedSource: null,
      withdrawn: { by: 'me', reason: 'wrong', source: shown },
    });
    expect((await call('GET', `/projects/${project.id}/knowledge`)).body.items).toEqual([]);
  });

  it('writes no source row for a retire that names none, and shows null', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const a = (await call('POST', `${base}/principles`, { statement: 'A', topicKey: 'k.a' })).body;
    const before = sourceCount(running());
    await call('POST', `/principles/${a.id}/retire`, { reason: 'old' });
    expect(sourceCount(running())).toBe(before);
    expect((await call('GET', `/principles/${a.id}/provenance`)).body.retired.source).toBeNull();
  });

  it('shows the source of an accepted proposal, keeping the proposal own source', async () => {
    const { project, call } = await start();
    const { proposalId, principle } = proposeRule(project);
    await call('POST', `/proposals/${proposalId}/accept`, { source });
    expect((await call('GET', `/principles/${principle.id}/provenance`)).body).toMatchObject({
      sourceKind: 'agent',
      confirmedBy: 'me',
      confirmedSource: shown,
      withdrawn: null,
    });
    const found = await call('GET', `/projects/${project.id}/knowledge?q=sleep`);
    expect(found.body.items.map((i: Body) => i.id)).toEqual([principle.id]);
  });

  it('shows the source of a rejected proposal on the withdrawal', async () => {
    const { project, call } = await start();
    const { proposalId, principle } = proposeRule(project);
    await call('POST', `/proposals/${proposalId}/reject`, { note: 'no', source });
    expect((await call('GET', `/principles/${principle.id}/provenance`)).body).toMatchObject({
      sourceKind: 'agent',
      confirmedSource: null,
      withdrawn: { reason: 'no', source: shown },
    });
    const found = await call('GET', `/projects/${project.id}/knowledge?q=sleep&shelf=all`);
    expect(found.body.items.map((i: Body) => i.state)).toEqual(['withdrawn']);
  });

  it('keeps the source of the principle replaced to itself: a quote is the words of its own write', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const old = (
      await call('POST', `${base}/principles`, {
        statement: 'Never sleep',
        topicKey: 'k.sleep',
        quote: 'never sleep',
      })
    ).body;
    const next = (await call('POST', `/principles/${old.id}/supersede`, { kind: 'belief' })).body;
    expect(next.sourceQuote).toBeNull();
    expect((await call('GET', `/principles/${next.id}/provenance`)).body).toMatchObject({
      quote: null,
      supersedes: old.id,
    });
    expect((await call('GET', `/principles/${old.id}/provenance`)).body.quote).toBe('never sleep');
  });
});

describe('an unknown project', () => {
  it.each([
    ['decisions', { scope: 'you', question: 'q', choice: 'c', rationale: 'r' }],
    ['principles', { scope: 'you', statement: 'Rule', topicKey: 'k.r' }],
    ['decisions', { question: 'q', choice: 'c', rationale: 'r' }],
    ['principles', { statement: 'Rule', topicKey: 'k.r' }],
  ])('answers 404 on a create of %s and writes nothing', async (collection, body) => {
    const { project, call } = await start();
    const res = await call('POST', `/projects/${mintId('Project')}/${collection}`, body);
    expect(res.status).toBe(404);
    expect((await call('GET', `/projects/${project.id}/knowledge?shelf=all`)).body.items).toEqual(
      [],
    );
    const dry = await call('POST', `/projects/${mintId('Project')}/${collection}`, {
      ...body,
      dryRun: true,
    });
    expect(dry.status).toBe(404);
  });
});

describe('dry runs', () => {
  it('write nothing and say what would be written and replaced', async () => {
    const { project, call } = await start();
    const base = `/projects/${project.id}`;
    const old = (
      await call('POST', `${base}/principles`, {
        statement: 'Never sleep',
        kind: 'policy',
        topicKey: 'k.sleep',
      })
    ).body;
    const decision = (
      await call('POST', `${base}/decisions`, {
        question: 'Which queue?',
        choice: 'a',
        rationale: 'r',
      })
    ).body;
    const before = {
      list: (await call('GET', `${base}/knowledge?shelf=all`)).body,
      sources: sourceCount(running()),
    };
    const create = await call('POST', `${base}/principles`, {
      statement: 'Never sleep or poll',
      kind: 'policy',
      topicKey: 'k.sleep',
      dryRun: true,
    });
    expect(create.status).toBe(200);
    expect(create.body).toMatchObject({
      dryRun: true,
      wouldWrite: {
        kind: 'principle',
        statement: 'Never sleep or poll',
        state: 'current',
        supersedesId: old.id,
      },
      replaces: { id: old.id, state: 'current', statement: 'Never sleep' },
    });
    expect(create.body.wouldWrite.id).toBeUndefined();
    const plain = await call('POST', `${base}/decisions`, {
      question: 'q',
      choice: 'c',
      rationale: 'r',
      dryRun: true,
    });
    expect(plain.body).toMatchObject({
      dryRun: true,
      wouldWrite: { kind: 'decision' },
      replaces: null,
    });
    const edit = await call('POST', `/decisions/${decision.id}/supersede`, {
      choice: 'b',
      dryRun: true,
    });
    expect(edit.body).toMatchObject({
      wouldWrite: { choice: 'b', supersedesId: decision.id },
      replaces: { id: decision.id, choice: 'a', state: 'current' },
    });
    const principleEdit = await call('POST', `/principles/${old.id}/supersede`, {
      kind: 'belief',
      dryRun: true,
    });
    expect(principleEdit.body).toMatchObject({
      wouldWrite: { principleKind: 'belief' },
      replaces: { id: old.id },
    });
    expect({
      list: (await call('GET', `${base}/knowledge?shelf=all`)).body,
      sources: sourceCount(running()),
    }).toEqual(before);
  });

  it('answer the 409 the write would, and write nothing', async () => {
    const { project, call } = await start();
    const first = (
      await call('POST', `/projects/${project.id}/decisions`, {
        question: 'q',
        choice: 'a',
        rationale: 'r',
      })
    ).body;
    await call('POST', `/decisions/${first.id}/supersede`, { choice: 'b' });
    const res = await call('POST', `/decisions/${first.id}/supersede`, {
      choice: 'c',
      dryRun: true,
    });
    expect(res.status).toBe(409);
  });
});

describe('proposals', () => {
  it('refuses to withdraw a proposed principle, naming the proposal, so the proposal stays decidable', async () => {
    const { project, call } = await start();
    const { proposalId, principle } = proposeRule(project);
    for (const dryRun of [false, true]) {
      const res = await call('POST', `/principles/${principle.id}/withdraw`, {
        reason: 'x',
        dryRun,
      });
      expect(res.status).toBe(409);
      expect(res.body.message).toContain(proposalId);
    }
    // The refusal changed nothing: the proposal is still pending, and rejecting it closes the card.
    expect((await call('GET', `/projects/${project.id}/proposals`)).body).toHaveLength(1);
    const rejected = await call('POST', `/proposals/${proposalId}/reject`, { note: 'no' });
    expect(rejected.status).toBe(200);
    expect(
      (await call('GET', '/inbox?state=OPEN')).body.filter((c: Body) => c.kind === 'proposal'),
    ).toEqual([]);
  });

  it.each([
    ['supersede', { statement: 'x' }],
    ['retire', { reason: 'x' }],
  ] as const)('names the proposal when asked to %s a proposed principle', async (path, body) => {
    const { project, call } = await start();
    const { proposalId, principle } = proposeRule(project);
    const res = await call('POST', `/principles/${principle.id}/${path}`, body);
    expect(res.status).toBe(409);
    expect(res.body.message).toContain(proposalId);
  });

  it('lists pending proposals, accepts one with edits, closes its card and answers 409 to a second verdict', async () => {
    const { project, call } = await start();
    const { proposalId } = proposeRule(project);
    const listed = await call('GET', `/projects/${project.id}/proposals`);
    expect(listed.body.map((p: Body) => p.id)).toEqual([proposalId]);
    const dry = await call('POST', `/proposals/${proposalId}/accept`, {
      scope: 'you',
      dryRun: true,
    });
    expect(dry.body).toMatchObject({
      dryRun: true,
      wouldWrite: { scope: 'you', state: 'current' },
      replaces: null,
    });
    expect((await call('GET', `/projects/${project.id}/proposals`)).body).toHaveLength(1);
    const accepted = await call('POST', `/proposals/${proposalId}/accept`, {
      scope: 'you',
      topicKey: 'testing.no-sleeps-ever',
      note: 'everywhere',
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      status: 'accepted',
      principle: { state: 'current', scope: 'you', topicKey: 'testing.no-sleeps-ever' },
    });
    expect((await call('GET', `/projects/${project.id}/proposals`)).body).toEqual([]);
    const cards = await call('GET', '/inbox?state=OPEN');
    expect(cards.body.filter((c: Body) => c.kind === 'proposal')).toEqual([]);
    expect(
      (await call('GET', `/projects/${project.id}/knowledge?q=sleep`)).body.items.map(
        (i: Body) => i.topicKey,
      ),
    ).toEqual(['testing.no-sleeps-ever']);
    expect((await call('POST', `/proposals/${proposalId}/accept`, {})).status).toBe(409);
    expect((await call('POST', `/proposals/${proposalId}/reject`, {})).status).toBe(409);
  });

  it('shows what accepting would replace, and refuses an area the project lacks', async () => {
    const { project, call } = await start();
    const existing = (
      await call('POST', `/projects/${project.id}/principles`, {
        statement: 'Old',
        kind: 'policy',
        topicKey: 'testing.no-sleeps',
      })
    ).body;
    const { proposalId } = proposeRule(project);
    const dry = await call('POST', `/proposals/${proposalId}/accept`, { dryRun: true });
    expect(dry.body.replaces).toMatchObject({ id: existing.id });
    const bad = await call('POST', `/proposals/${proposalId}/accept`, {
      scope: 'area',
      area: 'billing',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('billing');
  });

  it('rejects a proposal, withdrawing its principle and closing its card', async () => {
    const { project, call } = await start();
    const { proposalId, principle } = proposeRule(project);
    const res = await call('POST', `/proposals/${proposalId}/reject`, { note: 'too strict' });
    expect(res.body).toMatchObject({ status: 'rejected' });
    expect(res.body.principle).toMatchObject({
      id: principle.id,
      state: 'withdrawn',
      withdrawnReason: 'too strict',
    });
    expect(
      (await call('GET', '/inbox?state=OPEN')).body.filter((c: Body) => c.kind === 'proposal'),
    ).toEqual([]);
  });
});

describe('a damaged search index', () => {
  it('is rebuilt at start; when it cannot be, the daemon serves, lists without search and raises no card', async () => {
    const { project, call } = await start();
    await call('POST', `/projects/${project.id}/decisions`, {
      question: 'Which queue?',
      choice: 'a',
      rationale: 'r',
    });
    await daemon?.stop();
    daemon = null;
    // Defensive mode keeps FTS5 shadow tables read-only; unsafe mode lets the test corrupt one so the
    // next start's rebuild fails.
    const raw = new Database(join(data.path, '10db.sqlite'));
    raw.unsafeMode(true);
    raw.exec('DROP TABLE decisions_fts_data; CREATE TABLE decisions_fts_data(x)');
    raw.close();
    daemon = await launch();
    const next = caller(daemon);
    const search = await next('GET', `/projects/${project.id}/knowledge?q=queue`);
    expect(search.status).toBe(200);
    expect(search.body.items).toEqual([]);
    expect(search.body.search.available).toBe(false);
    expect(search.body.search.message).toMatch(/search/i);
    const plain = await next('GET', `/projects/${project.id}/knowledge`);
    expect(plain.body.items).toHaveLength(1);
    expect(plain.body.search.available).toBe(false);
    expect((await next('GET', '/inbox?state=OPEN')).body).toEqual([]);
  });

  it('rebuilds an index that disagrees with its table, so search works again', async () => {
    const { project, call } = await start();
    await call('POST', `/projects/${project.id}/decisions`, {
      question: 'Which queue?',
      choice: 'a',
      rationale: 'r',
    });
    await daemon?.stop();
    daemon = null;
    const raw = new Database(join(data.path, '10db.sqlite'));
    raw.exec('DROP TRIGGER decisions_fts_insert');
    // A row the dropped trigger never indexed: the index and its table now disagree.
    const manual = mintId('Decision');
    raw
      .prepare(
        "INSERT INTO decisions (id, project_id, question, choice, rationale, decided_by, scope, source_id, created_at, updated_at) SELECT ?, project_id, 'Manual queue', 'b', 'r', 'me', 'project', source_id, created_at, updated_at FROM decisions LIMIT 1",
      )
      .run(manual);
    raw.close();
    daemon = await launch();
    const found = await caller(daemon)('GET', `/projects/${project.id}/knowledge?q=manual`);
    expect(found.body.search.available).toBe(true);
    expect(found.body.items.map((i: Body) => i.id)).toEqual([manual]);
  });
});
