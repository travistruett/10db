import { describe, expect, it } from 'vitest';
import {
  CONTRACT_SCHEMAS,
  mintId,
  PlanDraft,
  ShapeDto,
  ShapeMessageDto,
  ShapeProposalBody,
  ShapeProposalKind,
  ShapeToolInputs,
  ShapeToolName,
} from './index';

// Shape spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md §5.5, §6, §13.

const message = mintId('ShapeMessage');

/** The six-item list of the spec's §1, cut down: a goal, a loose task, a landing, a record, a question. */
const DRAFT = {
  goals: [
    {
      key: 'density',
      title: 'Compact density',
      objective: 'The board fits more on a laptop screen.',
      ceremony: 'direct',
      sourceMessageIds: [message],
      tasks: [
        {
          key: 'density-setting',
          title: 'Add a density setting',
          areas: ['desktop'],
          size: 'S',
        },
        {
          key: 'density-cards',
          title: 'Compact cards',
          areas: ['desktop'],
          depends_on: ['density-setting'],
          dependsOnOutside: ['thin-scrollbars'],
          basis: [mintId('Task')],
        },
      ],
    },
  ],
  looseTasks: [
    {
      key: 'thin-scrollbars',
      title: 'Thin scrollbars',
      criteria: ['Scrollbars are 6 px'],
      areas: ['desktop'],
      size: 'M',
      ceremony: 'direct',
      sourceMessageIds: [message],
    },
  ],
  landings: [
    {
      key: 'density-landing',
      title: 'Density',
      keys: ['density-setting', 'density-cards'],
      sourceMessageIds: [message],
    },
  ],
  records: [
    {
      key: 'one-density',
      kind: 'decision',
      question: 'How many densities?',
      choice: 'Two',
      rationale: 'More is clutter.',
      scope: 'project',
      sourceMessageIds: [message],
    },
  ],
  questions: [
    {
      key: 'ask-mark',
      text: 'Which screens matter?',
      for: 'designer',
      sourceMessageIds: [message],
    },
  ],
};

describe('PlanDraft', () => {
  it('parses a whole plan and defaults the lists it leaves out', () => {
    const draft = PlanDraft.parse(DRAFT);
    expect(draft.additions).toEqual([]);
    expect(draft.changes).toEqual([]);
    expect(draft.removals).toEqual([]);
    expect(draft.goals[0]?.tasks[1]?.dependsOnOutside).toEqual(['thin-scrollbars']);
    expect(draft.looseTasks[0]?.dependsOn).toEqual([]);
    expect(draft.looseTasks[0]?.annotations).toEqual([]);
  });

  it('parses an empty draft', () => {
    expect(PlanDraft.parse({})).toMatchObject({ goals: [], looseTasks: [], records: [] });
  });

  const loose = DRAFT.looseTasks[0];
  it.each([
    ['a task with both basis and size', { ...loose, basis: [mintId('Task')] }],
    ['a task with neither basis nor size', { ...loose, size: undefined }],
    ['a task with an empty basis', { ...loose, size: undefined, basis: [] }],
    ['an empty list of source messages', { ...loose, sourceMessageIds: [] }],
    ['a source that is not a message id', { ...loose, sourceMessageIds: [mintId('Task')] }],
    ['a key that is not a brief key', { ...loose, key: 'Thin Scrollbars' }],
    ['an unknown ceremony', { ...loose, ceremony: 'review' }],
    ['an annotation, which is reserved', { ...loose, annotations: [{ kind: 'eval' }] }],
  ])('refuses %s', (_, task) => {
    expect(PlanDraft.safeParse({ looseTasks: [task] }).success).toBe(false);
  });

  it('takes a task with no source messages, which keeps its stored ones', () => {
    const task = { ...loose, sourceMessageIds: undefined };
    expect(PlanDraft.safeParse({ looseTasks: [task] }).success).toBe(true);
  });

  const record = DRAFT.records[0];
  it.each([
    ['an area record with no area', { ...record, scope: 'area' }],
    ['a project record naming an area', { ...record, area: 'desktop' }],
    ['a decision with no choice', { ...record, choice: undefined }],
    ['a supersede that is not a decision id', { ...record, supersedes: mintId('Task') }],
  ])('refuses %s', (_, bad) => {
    expect(PlanDraft.safeParse({ records: [bad] }).success).toBe(false);
  });

  it('takes a principle, an area record and a supersede', () => {
    const draft = PlanDraft.parse({
      records: [
        {
          key: 'no-modals',
          kind: 'principle',
          statement: 'Never open a modal for a single field.',
          rationale: 'Modals break flow.',
          scope: 'area',
          area: 'desktop',
          sourceMessageIds: [message],
        },
        { ...record, scope: 'you', supersedes: mintId('Decision') },
      ],
    });
    expect(draft.records.map((r) => r.kind)).toEqual(['principle', 'decision']);
  });

  it('takes an addition, a change and a removal of converted work', () => {
    const taskId = mintId('Task');
    const draft = PlanDraft.parse({
      additions: [{ ...loose, key: 'late', goalId: mintId('Goal') }],
      changes: [{ taskId, title: 'Thinner scrollbars', sourceMessageIds: [message] }],
      removals: [{ taskId, why: 'Not needed after all', sourceMessageIds: [message] }],
    });
    expect(draft.changes[0]?.title).toBe('Thinner scrollbars');
    expect(PlanDraft.safeParse({ removals: [{ taskId, why: '' }] }).success).toBe(false);
    expect(PlanDraft.safeParse({ changes: [{ taskId }] }).success).toBe(false);
    expect(PlanDraft.safeParse({ additions: [loose] }).success).toBe(false);
  });

  it('takes a goal eval', () => {
    const goal = {
      ...DRAFT.goals[0],
      eval: {
        objective: 'Fewer clicks per triage',
        baseline: ['12 clicks today'],
        models: ['claude-opus-5-5'],
        constraints: ['No new dependencies'],
      },
    };
    expect(PlanDraft.parse({ goals: [goal] }).goals[0]?.eval?.objective).toBe(
      'Fewer clicks per triage',
    );
  });
});

describe('ShapeDto and ShapeMessageDto', () => {
  const AT = '2026-11-02T12:00:00.000Z';
  it('parses a conversation and its messages', () => {
    const shapeId = mintId('Shape');
    expect(
      ShapeDto.parse({
        id: shapeId,
        projectId: mintId('Project'),
        title: 'Density',
        state: 'listening',
        origin: 'app',
        proposeUnlocked: false,
        round: 0,
        createdAt: AT,
        updatedAt: AT,
      }).state,
    ).toBe('listening');
    expect(
      ShapeMessageDto.parse({
        id: message,
        shapeId,
        author: 'builder',
        kind: 'text',
        body: 'Make the board denser',
        createdAt: AT,
      }).author,
    ).toBe('builder');
    expect(
      ShapeMessageDto.safeParse({
        id: message,
        shapeId,
        author: 'jev',
        kind: 'text',
        body: 'x',
        createdAt: AT,
      }).success,
    ).toBe(false);
  });
});

describe('proposal bodies', () => {
  it('has a body schema for every proposal kind', () => {
    expect(Object.keys(ShapeProposalBody).sort()).toEqual(Object.values(ShapeProposalKind).sort());
  });

  it('reads a task body with or without its goal', () => {
    const task = DRAFT.looseTasks[0];
    expect(ShapeProposalBody.task.safeParse(task).success).toBe(true);
    expect(ShapeProposalBody.task.safeParse({ ...task, goalId: mintId('Goal') }).success).toBe(
      true,
    );
  });
});

describe('the Shape MCP tool inputs', () => {
  const input = (tool: ShapeToolName, value: unknown) =>
    ShapeToolInputs[tool].safeParse(value).success;

  it('caps what note_heard echoes at 12 items of 80 characters', () => {
    expect(input('note_heard', { items: ['compact density'] })).toBe(true);
    expect(input('note_heard', { items: Array.from({ length: 13 }, () => 'x') })).toBe(false);
    expect(input('note_heard', { items: ['x'.repeat(81)] })).toBe(false);
  });

  it('takes the whole plan in propose_plan', () => {
    expect(input('propose_plan', { draft: DRAFT })).toBe(true);
    expect(input('propose_plan', { draft: { looseTasks: [{ key: 'x' }] } })).toBe(false);
  });

  it.each([
    ['a Mermaid diagram', { kind: 'mermaid', source: 'graph TD; A-->B' }, true],
    ['an HTML mockup', { kind: 'mockup', html: '<p>Hi</p>' }, true],
    [
      'a chart with inline values',
      { kind: 'chart', spec: { mark: 'bar', data: { values: [{ a: 1 }] } } },
      true,
    ],
    [
      'a chart that loads its data from a URL',
      { kind: 'chart', spec: { mark: 'bar', data: { url: 'https://example.com/x.json' } } },
      false,
    ],
    [
      'a chart with a URL deeper in',
      {
        kind: 'chart',
        spec: {
          data: { values: [] },
          layer: [{ mark: { type: 'image' }, encoding: { url: { field: 'u' } } }],
        },
      },
      false,
    ],
    ['a chart with an href', { kind: 'chart', spec: { data: { values: [] }, href: 'x' } }, false],
  ])('attach: %s', (_, attachment, ok) => {
    expect(input('attach', { target: { key: 'density' }, attachment })).toBe(ok);
  });

  it('takes a finding, a question and a none from a reviewer', () => {
    const effortKey = 'density';
    expect(
      input('report_finding', {
        effortKey,
        finding: { kind: 'finding', severity: 'high', text: 'No migration named' },
      }),
    ).toBe(true);
    expect(
      input('report_finding', {
        effortKey,
        taskKey: 'density-cards',
        finding: { kind: 'question', text: 'Which density?' },
      }),
    ).toBe(true);
    expect(input('report_finding', { effortKey, finding: { kind: 'none' } })).toBe(true);
    expect(input('report_finding', { effortKey, finding: { kind: 'question', text: '' } })).toBe(
      false,
    );
  });

  it.each([
    ['similar_tasks', { query: 'density' }, { query: '' }],
    ['find_records', { query: 'density' }, { query: '' }],
    ['write_spec', { effortKey: 'density', markdown: '# Spec' }, { effortKey: 'density' }],
    [
      'resolve_finding',
      { findingId: mintId('ShapeFinding'), how: 'Split the task' },
      { findingId: mintId('ShapeFinding'), how: '' },
    ],
  ] as const)('%s takes a good input and refuses a bad one', (tool, good, bad) => {
    expect(input(tool, good)).toBe(true);
    expect(input(tool, bad)).toBe(false);
  });

  it('registers PlanDraft, the DTOs and every tool input as JSON Schema', () => {
    expect(Object.keys(CONTRACT_SCHEMAS)).toEqual(
      expect.arrayContaining([
        'plan-draft',
        'shape-dto',
        'shape-message-dto',
        ...Object.values(ShapeToolName).map((t) => `shape-mcp-${t.replaceAll('_', '-')}-input`),
      ]),
    );
  });
});
