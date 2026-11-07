import { ProvenanceDto, ShapeOrigin, type ProjectDto } from '@10db/contracts';
import {
  createTestStore,
  insertDecision,
  insertSession,
  insertShape,
  insertSource,
  insertTask,
  insertWorkstream,
  retirePrinciple,
  seedProject,
  withdrawDecision,
  withdrawPrinciple,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { proposePrinciple } from './proposals';
import { decisionProvenance, principleProvenance } from './provenance';
import {
  createPrinciple,
  recordDecision,
  supersedeDecisionRecord,
  supersedePrincipleRecord,
} from './records';

let store: Store;
let close: () => void;
let project: ProjectDto;
beforeEach(() => {
  ({ store, close } = createTestStore());
  project = seedProject(store);
});
afterEach(() => {
  close();
});

const source = { via: 'claude_code', sessionId: 'cc-1', cwd: '/repo', quote: 'always wait' };
const decide = (withSource = false) =>
  store.write((ctx) =>
    recordDecision(ctx, project.id, {
      question: 'Which queue library?',
      choice: 'BullMQ',
      rationale: 'r',
      ...(withSource ? { source } : {}),
    }),
  ).value;
const rule = (withSource = false) =>
  store.write((ctx) =>
    createPrinciple(ctx, project.id, {
      statement: 'Never sleep in tests',
      kind: 'policy',
      topicKey: 'testing.no-sleeps',
      ...(withSource ? { source } : {}),
    }),
  ).value;

describe('provenance', () => {
  it('shows a claude_code origin with its session, directory and quote', () => {
    const d = decide(true);
    expect(decisionProvenance(store.db, d.id)).toMatchObject({
      id: d.id,
      kind: 'decision',
      state: 'current',
      sourceKind: 'builder',
      sourceRef: source,
      origin: { via: 'claude_code', sessionId: 'cc-1', cwd: '/repo' },
      quote: 'always wait',
      by: 'me',
      session: null,
      inbox: null,
      supersedes: null,
      supersededBy: null,
      retired: null,
      withdrawn: null,
    });
    expect(decisionProvenance(store.db, d.id).recordedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(principleProvenance(store.db, rule(true).id)).toMatchObject({
      kind: 'principle',
      origin: { via: 'claude_code' },
      quote: 'always wait',
      speaker: 'me',
      confirmedBy: 'me',
    });
  });

  it('shows a bare builder record with no origin', () => {
    expect(decisionProvenance(store.db, decide().id)).toMatchObject({
      sourceKind: 'builder',
      sourceRef: {},
      origin: null,
      quote: null,
    });
  });

  it('names the record in its own words, whatever its state', () => {
    expect(decisionProvenance(store.db, decide().id).text).toBe('Which queue library? → BullMQ');
    const withdrawn = rule();
    store.write((ctx) => withdrawPrinciple(ctx, withdrawn.id, 'me', 'wrong'));
    expect(principleProvenance(store.db, withdrawn.id)).toMatchObject({
      state: 'withdrawn',
      text: 'Never sleep in tests',
    });
  });

  it('links a decision to the one it replaced and the one that replaced it', () => {
    const a = decide();
    const b = store.write((ctx) => supersedeDecisionRecord(ctx, a.id, { choice: 'pg-boss' })).value;
    expect(decisionProvenance(store.db, a.id)).toMatchObject({
      state: 'superseded',
      supersedes: null,
      supersedesText: null,
      supersededBy: b.id,
      supersededByText: 'Which queue library? → pg-boss',
    });
    expect(decisionProvenance(store.db, b.id)).toMatchObject({
      supersedes: a.id,
      supersedesText: 'Which queue library? → BullMQ',
      supersededBy: null,
      supersededByText: null,
    });
  });

  it('shows who withdrew a decision, when and why', () => {
    const a = decide();
    store.write((ctx) => {
      withdrawDecision(ctx, a.id, { by: 'me', reason: 'recorded by mistake' });
    });
    expect(decisionProvenance(store.db, a.id)).toMatchObject({
      state: 'withdrawn',
      withdrawn: { by: 'me', reason: 'recorded by mistake' },
    });
    expect(decisionProvenance(store.db, a.id).withdrawn?.at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('shows a principle retire and withdraw with their reasons, and the link to its successor', () => {
    const a = rule();
    const b = store.write((ctx) =>
      supersedePrincipleRecord(ctx, a.id, { statement: 'Never sleep or poll in tests' }),
    ).value;
    store.write((ctx) => retirePrinciple(ctx, b.id, 'me', 'fake timers now'));
    expect(principleProvenance(store.db, b.id)).toMatchObject({
      state: 'retired',
      supersedes: a.id,
      supersedesText: 'Never sleep in tests',
      retired: { by: 'me', reason: 'fake timers now' },
      withdrawn: null,
    });
    expect(principleProvenance(store.db, a.id)).toMatchObject({
      state: 'superseded',
      supersededBy: b.id,
      supersededByText: 'Never sleep or poll in tests',
    });
    const c = rule();
    store.write((ctx) => withdrawPrinciple(ctx, c.id, 'me', 'wrong'));
    expect(principleProvenance(store.db, c.id)).toMatchObject({
      state: 'withdrawn',
      withdrawn: { by: 'me', reason: 'wrong' },
    });
  });

  describe('a record whose source names a session', () => {
    const sessionFields = {
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
      mode: 'managed',
      mcpTokenHash: 'h',
    } as const;
    const proposeFrom = (sessionId: string) =>
      principleProvenance(
        store.db,
        store.write((ctx) =>
          proposePrinciple(ctx, {
            projectId: project.id,
            title: 't',
            body: 'b',
            draft: { statement: 'Never sleep', kind: 'policy', scope: 'project', quote: 'flaky' },
            sourceId: insertSource(ctx, 'agent', { sessionId }),
            speaker: `agent:${sessionId}`,
          }),
        ).value.principle.id,
      );

    it('names the workstream of a lane session', () => {
      const task = store.write((ctx) =>
        insertTask(ctx, project.id, { title: 'A', acceptanceCriteria: ['x'], areas: ['api'] }),
      ).value;
      const workstream = store.write((ctx) =>
        insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
      ).value;
      const session = store.write((ctx) =>
        insertSession(ctx, { workstreamId: workstream.id, ...sessionFields }),
      ).value;
      expect(ProvenanceDto.parse(proposeFrom(session.id)).session).toEqual({
        id: session.id,
        workstreamId: workstream.id,
        shapeId: null,
        taskTitle: 'A',
        shapeTitle: null,
      });
    });

    it('names the conversation of a Shape session, with no workstream', () => {
      const shape = store.write((ctx) =>
        insertShape(ctx, project.id, { title: 'Density', origin: ShapeOrigin.App }),
      ).value;
      const session = store.write((ctx) =>
        insertSession(ctx, { shapeId: shape.id, ...sessionFields }),
      ).value;
      expect(ProvenanceDto.parse(proposeFrom(session.id)).session).toEqual({
        id: session.id,
        workstreamId: null,
        shapeId: shape.id,
        taskTitle: null,
        shapeTitle: 'Density',
      });
    });
  });

  describe('a record converted from a Plan conversation', () => {
    const convertedFrom = (shapeId: string) =>
      decisionProvenance(
        store.db,
        store.write((ctx) =>
          insertDecision(ctx, {
            projectId: project.id,
            question: 'Which queue library?',
            choice: 'BullMQ',
            rationale: 'r',
            decidedBy: 'builder',
            scope: 'project',
            area: null,
            sourceId: insertSource(ctx, 'builder', { shapeId, proposalKey: 'q1' }),
            supersedesId: null,
          }),
        ).value,
      );

    it('names the conversation by id and title', () => {
      const shape = store.write((ctx) =>
        insertShape(ctx, project.id, { title: 'Density', origin: ShapeOrigin.App }),
      ).value;
      const p = ProvenanceDto.parse(convertedFrom(shape.id));
      expect(p.conversation).toEqual({ id: shape.id, title: 'Density' });
      expect(p.session).toBeNull();
    });

    it('names no conversation for a shapeId that is not one', () => {
      expect(convertedFrom('shp_gone').conversation).toBeNull();
    });

    it('names no conversation for a record with no Shape source', () => {
      expect(decisionProvenance(store.db, decide(true).id).conversation).toBeNull();
    });
  });

  it('traces an agent principle to its session and who confirmed nothing yet', () => {
    const { principle } = store.write((ctx) =>
      proposePrinciple(ctx, {
        projectId: project.id,
        title: 't',
        body: 'b',
        draft: { statement: 'Never sleep', kind: 'policy', scope: 'project', quote: 'flaky' },
        sourceId: insertSource(ctx, 'agent', {}),
        speaker: 'agent:ses_x',
      }),
    ).value;
    expect(principleProvenance(store.db, principle.id)).toMatchObject({
      state: 'proposed',
      sourceKind: 'agent',
      origin: null,
      by: 'agent:ses_x',
      quote: 'flaky',
      confirmedBy: null,
    });
  });
});
