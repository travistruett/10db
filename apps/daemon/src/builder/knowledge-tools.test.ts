import {
  BuilderToolName,
  DomainError,
  refusalText,
  type DecisionItem,
  type KnowledgeListDto,
  type PrincipleItem,
  type ProjectDto,
} from '@10db/contracts';
import { createTestStore, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { createKnowledgeServices } from '../daemon';
import { createEventBus, createStateStore } from '../events';
import { createBuilderTools, type BuilderServices } from './tools';

let store: Store;
let close: () => void;
let project: ProjectDto;
let tools: ReturnType<typeof createBuilderTools>;
let provenance: ReturnType<typeof createKnowledgeServices>;

beforeEach(() => {
  ({ store, close } = createTestStore());
  project = seedProject(store, { name: 'demo', areas: [{ name: 'api', globs: ['src/api/**'] }] });
  provenance = createKnowledgeServices({
    state: createStateStore(store, createEventBus()),
    searchAvailable: true,
  });
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
    expect(() =>
      call(BuilderToolName.ListProposals, {
        projectId: 'prj_00000000-0000-7000-8000-000000000000',
      }),
    ).toThrow(DomainError);
  });
});
