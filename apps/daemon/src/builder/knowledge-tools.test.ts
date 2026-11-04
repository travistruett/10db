import {
  BuilderToolName,
  DomainError,
  refusalText,
  type DecisionItem,
  type KnowledgeListDto,
  type PrincipleItem,
  type ProjectDto,
} from '@10db/contracts';
import { createTestStore, insertSource, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { createKnowledgeServices } from '../daemon';
import { createEventBus, createStateStore } from '../events';
import { proposePrinciple } from '../knowledge';
import { createBuilderTools, type BuilderServices } from './tools';

let store: Store;
let close: () => void;
let project: ProjectDto;
let tools: ReturnType<typeof createBuilderTools>;
let provenance: ReturnType<typeof createKnowledgeServices>;
let state: ReturnType<typeof createStateStore>;

beforeEach(() => {
  ({ store, close } = createTestStore());
  project = seedProject(store, { name: 'demo', areas: [{ name: 'api', globs: ['src/api/**'] }] });
  state = createStateStore(store, createEventBus());
  provenance = createKnowledgeServices({ state, searchAvailable: true });
  tools = createBuilderTools(provenance as unknown as BuilderServices);
});
afterEach(() => {
  close();
});

const call = (name: BuilderToolName, args: unknown) => tools[name](args);
const find = (args: Record<string, unknown> = {}) =>
  call(BuilderToolName.SearchKnowledge, { projectId: project.id, ...args }) as KnowledgeListDto;
const ids = (list: KnowledgeListDto) => list.items.map((item) => item.id);

const decide = (args: Record<string, unknown> = {}) =>
  call(BuilderToolName.SaveDecision, {
    projectId: project.id,
    question: 'Which queue library?',
    choice: 'BullMQ',
    rationale: 'Redis is already there',
    ...args,
  }) as DecisionItem;

const principle = (args: Record<string, unknown> = {}) =>
  call(BuilderToolName.SavePrinciple, {
    projectId: project.id,
    statement: 'Tests never sleep; they wait on a condition.',
    kind: 'policy',
    topicKey: 'testing.no-sleeps',
    ...args,
  }) as PrincipleItem;

const PROPOSAL_BODY = 'Seen in three flaky runs of the queue tests.';

/** A principle a managed session proposed: a pending proposal and the card that asks the builder. */
const propose = () =>
  state.write((ctx) =>
    proposePrinciple(ctx, {
      projectId: project.id,
      title: 'No sleeps in tests',
      body: PROPOSAL_BODY,
      draft: {
        statement: 'Tests never sleep; they wait on a condition.',
        kind: 'policy',
        scope: 'project',
        topicKey: 'testing.no-sleeps',
        quote: 'never sleep in a test',
      },
      sourceId: insertSource(ctx, 'agent', {}),
      speaker: 'agent:x',
    }),
  );

/** What a call answers when it is refused for its input, in the words the client reads. */
const refusal = (name: BuilderToolName, args: unknown): string => {
  try {
    call(name, args);
  } catch (error) {
    if (error instanceof ZodError) return refusalText(error.issues);
    throw error;
  }
  throw new Error(`${name} was not refused`);
};

describe('an unknown key', () => {
  it.each(['query', 'text'])('refuses a search that names the words %s', (key) => {
    decide();
    expect(refusal(BuilderToolName.SearchKnowledge, { projectId: project.id, [key]: 'x' })).toBe(
      `Unrecognized key: "${key}"`,
    );
  });

  it('refuses a proposal list with a key the API refuses', () => {
    expect(refusal(BuilderToolName.ListProposals, { projectId: project.id, state: 'x' })).toBe(
      'Unrecognized key: "state"',
    );
  });

  it('refuses a retire with a dry run, and the principle stays current', () => {
    const p = principle();
    expect(refusal(BuilderToolName.RetireKnowledge, { id: p.id, reason: 'x', dryRun: true })).toBe(
      'Unrecognized key: "dryRun"',
    );
    expect(ids(find())).toEqual([p.id]);
  });

  it('refuses a withdrawal with a dry run, and the record stays current', () => {
    const d = decide();
    expect(
      refusal(BuilderToolName.WithdrawKnowledge, { id: d.id, reason: 'x', dryRun: true }),
    ).toBe('Unrecognized key: "dryRun"');
    expect(ids(find())).toEqual([d.id]);
  });
});

describe('find_knowledge', () => {
  it('answers what the API’s list answers for the same words', () => {
    const d = decide();
    const p = principle();
    const viaTool = find({ q: 'queue' });
    expect(viaTool).toEqual(
      provenance.listKnowledge(project.id, { q: 'queue', history: false, limit: 100 }),
    );
    expect(ids(viaTool)).toEqual([d.id]);
    expect(ids(find({ q: 'sleep' }))).toEqual([p.id]);
    expect(ids(find({ kind: 'decision' }))).toEqual([d.id]);
    expect(ids(find({ kind: 'policy' }))).toEqual([p.id]);
    expect(ids(find({ scope: 'project' })).toSorted()).toEqual([d.id, p.id].toSorted());
  });

  it('finds a record from a whole question, not only its keywords', () => {
    const d = decide();
    expect(ids(find({ q: 'which queue should we use' }))).toEqual([d.id]);
  });

  it('leaves out replaced records until history is asked for', () => {
    const first = decide();
    const second = call(BuilderToolName.SupersedeKnowledge, {
      id: first.id,
      choice: 'pg-boss',
    }) as DecisionItem;
    expect(ids(find())).toEqual([second.id]);
    expect(ids(find({ history: true })).toSorted()).toEqual([first.id, second.id].toSorted());
  });

  it('refuses an unknown area in the API’s words', () => {
    expect(() => find({ area: 'billing' })).toThrow(DomainError);
    expect(() => find({ area: 'billing' })).toThrow('area: demo has no area named billing');
  });
});

describe('recording', () => {
  it('stores the builder’s MCP server and the quote as the source', () => {
    const d = decide({ quote: 'we use BullMQ' });
    const p = principle({ quote: 'never sleep in a test' });
    expect(provenance.decisionProvenance(d.id)).toMatchObject({
      sourceKind: 'builder',
      origin: { via: 'builder_mcp' },
      quote: 'we use BullMQ',
    });
    expect(provenance.principleProvenance(p.id)).toMatchObject({
      sourceKind: 'builder',
      origin: { via: 'builder_mcp' },
      quote: 'never sleep in a test',
    });
  });

  it('records without a quote, still with the builder’s MCP server as the source', () => {
    const d = decide();
    expect(provenance.decisionProvenance(d.id)).toMatchObject({
      origin: { via: 'builder_mcp' },
      quote: null,
    });
  });

  it('refuses an unknown area in the API’s words, and records nothing', () => {
    expect(() => decide({ scope: 'area', area: 'billing' })).toThrow(
      'area: demo has no area named billing',
    );
    expect(() => principle({ scope: 'area', area: 'billing' })).toThrow(
      'area: demo has no area named billing',
    );
    expect(ids(find({ history: true }))).toEqual([]);
  });

  it('names a field the API refuses', () => {
    try {
      decide({ question: '' });
      expect.unreachable('the API refuses an empty question');
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect(refusalText((error as ZodError).issues)).toMatch(/^question: /);
    }
  });

  it('replaces the current principle that holds the same key', () => {
    const first = principle();
    const second = principle({ statement: 'Tests wait on conditions, never on time.' });
    expect(second.supersedesId).toBe(first.id);
    expect(ids(find())).toEqual([second.id]);
  });
});

describe('superseding, retiring and withdrawing', () => {
  it('supersedes a principle by id, recording the quote on the successor', () => {
    const first = principle();
    const next = call(BuilderToolName.SupersedeKnowledge, {
      id: first.id,
      scope: 'area',
      area: 'api',
      quote: 'only for the api',
    }) as PrincipleItem;
    expect(next).toMatchObject({ supersedesId: first.id, scope: 'area', area: 'api' });
    expect(provenance.principleProvenance(next.id)).toMatchObject({
      origin: { via: 'builder_mcp' },
      quote: 'only for the api',
    });
  });

  it('says what to name when nothing changes', () => {
    const d = decide();
    expect(() => call(BuilderToolName.SupersedeKnowledge, { id: d.id })).toThrow(
      'name at least one field to change',
    );
  });

  it('refuses a field the record does not have', () => {
    const d = decide();
    expect(() =>
      call(BuilderToolName.SupersedeKnowledge, { id: d.id, statement: 'x', choice: 'y' }),
    ).toThrow(/statement/);
  });

  it('retires a principle and shows who asked on the retirement', () => {
    const p = principle();
    const retired = call(BuilderToolName.RetireKnowledge, {
      id: p.id,
      reason: 'The queue was removed.',
      quote: 'drop that rule',
    }) as PrincipleItem;
    expect(retired.state).toBe('retired');
    expect(ids(find())).toEqual([]);
    expect(ids(find({ history: true }))).toEqual([p.id]);
    expect(provenance.principleProvenance(p.id)).toMatchObject({
      retired: {
        reason: 'The queue was removed.',
        source: { via: 'builder_mcp', quote: 'drop that rule' },
      },
    });
  });

  it('refuses to retire a decision, which the API cannot', () => {
    const d = decide();
    expect(() => call(BuilderToolName.RetireKnowledge, { id: d.id, reason: 'x' })).toThrow(
      /^id: .*principle/,
    );
  });

  it('withdraws a decision and brings the one before it back', () => {
    const first = decide();
    const second = call(BuilderToolName.SupersedeKnowledge, {
      id: first.id,
      choice: 'pg-boss',
    }) as DecisionItem;
    const withdrawn = call(BuilderToolName.WithdrawKnowledge, {
      id: second.id,
      reason: 'Recorded by mistake.',
      quote: 'that was wrong',
    }) as DecisionItem;
    expect(withdrawn.state).toBe('withdrawn');
    expect(ids(find())).toEqual([first.id]);
    expect(provenance.decisionProvenance(second.id)).toMatchObject({
      withdrawn: { source: { via: 'builder_mcp', quote: 'that was wrong' } },
    });
  });

  it('refuses a record that is not current, naming the one that is', () => {
    const first = decide();
    const second = call(BuilderToolName.SupersedeKnowledge, {
      id: first.id,
      choice: 'pg-boss',
    }) as DecisionItem;
    expect(() => call(BuilderToolName.WithdrawKnowledge, { id: first.id, reason: 'x' })).toThrow(
      `(the current one is ${second.id})`,
    );
  });

  it('withdraws a principle by its id', () => {
    const p = principle();
    const withdrawn = call(BuilderToolName.WithdrawKnowledge, {
      id: p.id,
      reason: 'Wrong project.',
    }) as PrincipleItem;
    expect(withdrawn.state).toBe('withdrawn');
    expect(ids(find())).toEqual([]);
  });
});

describe('list_proposals', () => {
  it('answers an empty list when nothing waits', () => {
    expect(call(BuilderToolName.ListProposals, { projectId: project.id })).toEqual([]);
  });

  it('refuses an unknown project in the API’s words', () => {
    const projectId = 'prj_00000000-0000-7000-8000-000000000000';
    const viaApi = () =>
      provenance.listProposals(projectId as ProjectDto['id'], { status: 'pending' });
    expect(() => call(BuilderToolName.ListProposals, { projectId })).toThrow(DomainError);
    expect(() => call(BuilderToolName.ListProposals, { projectId })).toThrow(
      `project ${projectId} not found`,
    );
    expect(() => viaApi()).toThrow(`project ${projectId} not found`);
  });

  it('lists a pending principle proposal with its fields and without the card body', () => {
    const { proposalId, principle: proposed, card } = propose();
    const [listed, ...rest] = call(BuilderToolName.ListProposals, {
      projectId: project.id,
    }) as unknown[];
    expect(rest).toEqual([]);
    expect(listed).toEqual({
      id: proposalId,
      status: 'pending',
      title: 'No sleeps in tests',
      rationale: null,
      principle: {
        id: proposed.id,
        scope: 'project',
        area: null,
        statement: 'Tests never sleep; they wait on a condition.',
        kind: 'policy',
        topicKey: 'testing.no-sleeps',
      },
      createdAt: expect.any(String) as string,
    });
    // The card's body is what the session wrote for the builder to read: it is not in the answer.
    expect(card.body).toContain(PROPOSAL_BODY);
    const text = JSON.stringify(listed);
    expect(text).not.toContain(PROPOSAL_BODY);
    expect(text).not.toContain(card.body);
    expect(Object.keys(listed as object)).not.toContain('body');
  });

  it('lists a proposal under the status it holds, and under no other', () => {
    const { proposalId } = propose();
    const statuses = ['pending', 'accepted', 'rejected'] as const;
    const listedIn = (status: (typeof statuses)[number]) =>
      (
        call(BuilderToolName.ListProposals, { projectId: project.id, status }) as { id: string }[]
      ).map((p) => p.id);
    expect(statuses.map(listedIn)).toEqual([[proposalId], [], []]);

    provenance.acceptProposal(proposalId, { scope: 'project', note: 'Fits the house style.' });
    expect(statuses.map(listedIn)).toEqual([[], [proposalId], []]);
  });

  it('lists an accepted proposal with the note as its rationale', () => {
    const { proposalId } = propose();
    provenance.acceptProposal(proposalId, { scope: 'project', note: 'Fits the house style.' });
    const [listed] = call(BuilderToolName.ListProposals, {
      projectId: project.id,
      status: 'accepted',
    }) as unknown[];
    expect(listed).toMatchObject({
      id: proposalId,
      status: 'accepted',
      title: 'No sleeps in tests',
      rationale: 'Fits the house style.',
      principle: { statement: 'Tests never sleep; they wait on a condition.', scope: 'project' },
    });
    expect(Object.keys(listed as object)).not.toContain('body');
  });

  it('lists a rejected proposal with the note as its rationale', () => {
    const { proposalId } = propose();
    provenance.rejectProposal(proposalId, { note: 'We already have a rule for this.' });
    const [listed] = call(BuilderToolName.ListProposals, {
      projectId: project.id,
      status: 'rejected',
    }) as unknown[];
    expect(listed).toMatchObject({
      id: proposalId,
      status: 'rejected',
      title: 'No sleeps in tests',
      rationale: 'We already have a rule for this.',
      principle: { statement: 'Tests never sleep; they wait on a condition.' },
    });
    expect(Object.keys(listed as object)).not.toContain('body');
    expect(call(BuilderToolName.ListProposals, { projectId: project.id })).toEqual([]);
  });

  it('refuses a status the API refuses', () => {
    expect(() =>
      call(BuilderToolName.ListProposals, { projectId: project.id, status: 'open' }),
    ).toThrow(ZodError);
  });
});
