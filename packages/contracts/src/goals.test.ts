import { describe, expect, it } from 'vitest';
import {
  CONTRACT_SCHEMAS,
  CriterionCheck,
  EventType,
  GoalAdoptError,
  GoalAdoptInput,
  GoalBrief,
  GoalDigestDto,
  GoalDto,
  GoalId,
  GoalState,
  GoalStatus,
  mintId,
  TaskDto,
} from './index';

/** The example brief of the goals spec §11, as the front matter parses. */
const EXAMPLE_BRIEF = {
  title: 'Real areas',
  objective:
    '10db proposes a project’s areas from its repository, proposes each task’s areas, and lets the builder edit them.',
  cares_most: 'Areas a non-engineer can read; no task blocked by an area it doesn’t touch.',
  criteria: [
    {
      text: 'A new project gets proposed areas it can edit before saving',
      check: 'task',
      task: 'propose-project-areas',
    },
    { text: 'The builder accepts the area names after seeing them', check: 'accept' },
  ],
  tasks: [
    {
      key: 'task-patch-route',
      title: 'Patch a task’s areas and dependencies',
      areas: ['repo'],
      criteria: ['PATCH /tasks/:id changes areas and dependencies, and refuses unknown areas'],
    },
    {
      key: 'drawer-editor',
      title: 'Edit areas and dependencies in the task drawer',
      areas: ['repo'],
      depends_on: ['task-patch-route'],
    },
    {
      key: 'propose-project-areas',
      title: 'Propose a new project’s areas from its repository',
      areas: ['repo'],
    },
  ],
};

describe('goal ids and states', () => {
  it('mints goal ids with the gol prefix', () => {
    const id = mintId('Goal');
    expect(id).toMatch(/^gol_/);
    expect(GoalId.safeParse(id).success).toBe(true);
    expect(GoalId.safeParse(mintId('Task')).success).toBe(false);
  });

  it('has the six states of the spec', () => {
    expect(Object.values(GoalState).sort()).toEqual(
      ['cancelled', 'done', 'draft', 'paused', 'running', 'waiting'].sort(),
    );
  });

  it('has the four check kinds of the spec', () => {
    expect(Object.values(CriterionCheck).sort()).toEqual(
      ['accept', 'command', 'merged', 'task'].sort(),
    );
  });
});

describe('GoalBrief', () => {
  it('accepts the example brief of the spec', () => {
    const brief = GoalBrief.parse(EXAMPLE_BRIEF);
    expect(brief.title).toBe('Real areas');
    expect(brief.tasks.map((t) => t.key)).toEqual([
      'task-patch-route',
      'drawer-editor',
      'propose-project-areas',
    ]);
    expect(brief.tasks[1]?.depends_on).toEqual(['task-patch-route']);
    expect(brief.tasks[2]?.depends_on).toEqual([]);
    expect(brief.tasks[2]?.criteria).toEqual([]);
    expect(brief.criteria[0]).toMatchObject({ check: 'task', task: 'propose-project-areas' });
    expect(brief.people).toEqual([]);
  });

  it.each(['title', 'objective', 'tasks'] as const)('refuses a brief missing %s', (field) => {
    const rest = Object.fromEntries(Object.entries(EXAMPLE_BRIEF).filter(([k]) => k !== field));
    const result = GoalBrief.safeParse(rest);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual([field]);
  });

  it('names every missing field at once', () => {
    const result = GoalBrief.safeParse({ criteria: [] });
    expect(result.error?.issues.map((i) => i.path.join('.')).sort()).toEqual([
      'objective',
      'tasks',
      'title',
    ]);
  });

  it('refuses an empty task list', () => {
    expect(GoalBrief.safeParse({ ...EXAMPLE_BRIEF, tasks: [] }).success).toBe(false);
  });

  it('names the path of a bad task', () => {
    const result = GoalBrief.safeParse({
      ...EXAMPLE_BRIEF,
      tasks: [EXAMPLE_BRIEF.tasks[0], { key: 'x', areas: ['repo'] }],
    });
    expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual(['tasks.1.title']);
  });

  it('needs a task key on a task or merged criterion, not on an accept one', () => {
    const base = { ...EXAMPLE_BRIEF, criteria: [] as unknown[] };
    expect(
      GoalBrief.safeParse({ ...base, criteria: [{ text: 'x', check: 'task' }] }).error?.issues.map(
        (i) => i.path.join('.'),
      ),
    ).toEqual(['criteria.0.task']);
    expect(
      GoalBrief.safeParse({ ...base, criteria: [{ text: 'x', check: 'merged' }] }).success,
    ).toBe(false);
    expect(
      GoalBrief.safeParse({ ...base, criteria: [{ text: 'x', check: 'accept' }] }).success,
    ).toBe(true);
    expect(
      GoalBrief.safeParse({ ...base, criteria: [{ text: 'x', check: 'command' }] }).success,
    ).toBe(true);
    expect(
      GoalBrief.safeParse({ ...base, criteria: [{ text: 'x', check: 'psychic' }] }).success,
    ).toBe(false);
  });

  it('takes a budget and proposed people', () => {
    const brief = GoalBrief.parse({
      ...EXAMPLE_BRIEF,
      budget: { tokens: 2_000_000, dollars: 40 },
      people: [{ name: 'Mark', role: 'stakeholder' }],
    });
    expect(brief.budget).toEqual({ tokens: 2_000_000, dollars: 40 });
    expect(brief.people[0]).toMatchObject({ name: 'Mark', role: 'stakeholder' });
  });
});

describe('GoalAdoptInput', () => {
  it('takes a path or text, with dryRun defaulting to false', () => {
    expect(GoalAdoptInput.parse({ path: '/tmp/brief.md' })).toEqual({
      path: '/tmp/brief.md',
      dryRun: false,
    });
    expect(GoalAdoptInput.parse({ text: '---\n---', dryRun: true })).toEqual({
      text: '---\n---',
      dryRun: true,
    });
  });

  it('refuses neither and both', () => {
    expect(GoalAdoptInput.safeParse({}).success).toBe(false);
    expect(GoalAdoptInput.safeParse({ path: '/a', text: 'b' }).success).toBe(false);
  });

  it('shapes an error list with a path and a message', () => {
    const body = {
      errors: [{ path: 'Task 3, depends on', message: 'no task has the key drawer-editr' }],
    };
    expect(GoalAdoptError.parse(body)).toEqual(body);
    expect(GoalAdoptError.safeParse({ errors: [{ path: 'x' }] }).success).toBe(false);
  });
});

describe('GoalDigestDto', () => {
  const goalId = mintId('Goal');
  const taskId = mintId('Task');
  const workstreamId = mintId('Workstream');
  const digest = {
    goalId,
    status: 'running',
    since: '2026-10-29T09:00:00.000Z',
    progress: { done: 6, total: 11, cancelled: [] },
    openPullRequests: 1,
    workingNow: [
      {
        workstreamId,
        taskId,
        taskTitle: 'Task patch route',
        persona: 'Implementer',
        model: 'sonnet-5.5',
        effort: 'high',
        stepNumber: 2,
        stepCount: 3,
      },
    ],
    team: [{ persona: 'Planner', model: 'fable-5.1', effort: 'high' }],
    waitingOn: {
      recent: [
        {
          inboxItemId: mintId('InboxItem'),
          taskId,
          title: 'Which name reads best?',
          assigneeId: null,
          assigneeName: 'You',
          at: '2026-10-29T10:00:00.000Z',
        },
      ],
      earlier: [],
    },
    next: {
      taskId,
      title: 'Edit areas in the drawer',
      waitsOn: [{ taskId, title: 'Task patch route' }],
    },
    deviations: {
      recent: [
        {
          id: mintId('Deviation'),
          taskId,
          summary: 'Split “Propose task areas” in two',
          at: '2026-10-29T10:00:00.000Z',
        },
      ],
      earlier: [],
    },
    decisions: {
      recent: [],
      earlier: [
        {
          id: mintId('Decision'),
          question: 'How are areas named?',
          choice: 'Areas follow workspace packages, not folders',
          at: '2026-10-28T10:00:00.000Z',
        },
      ],
    },
    cost: { tokens: 412_000, dollars: null, sessions: 14 },
    ungrouped: {
      goalId: null,
      status: 'running',
      running: 2,
      failed: 0,
      workstreams: [{ workstreamId, taskId, taskTitle: 'Loose task', state: 'RUNNING' }],
    },
  };

  it('carries every row of the digest table and the Ungrouped group', () => {
    const parsed = GoalDigestDto.parse(digest);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'goalId',
        'status',
        'since',
        'progress',
        'openPullRequests',
        'workingNow',
        'team',
        'waitingOn',
        'next',
        'deviations',
        'decisions',
        'cost',
        'ungrouped',
      ].sort(),
    );
    expect(parsed.ungrouped?.goalId).toBeNull();
  });

  it('accepts a first visit with no window, no next task and no Ungrouped group', () => {
    expect(
      GoalDigestDto.safeParse({ ...digest, since: null, next: null, ungrouped: null }).success,
    ).toBe(true);
  });

  it('has the status values, including Not started and Shipping', () => {
    expect(Object.values(GoalStatus).sort()).toEqual(
      [
        'done',
        'failed',
        'not_started',
        'paused',
        'running',
        'shipping',
        'waiting_on_someone',
        'waiting_on_you',
      ].sort(),
    );
    for (const status of Object.values(GoalStatus)) {
      expect(GoalDigestDto.safeParse({ ...digest, status }).success).toBe(true);
    }
    expect(GoalDigestDto.safeParse({ ...digest, status: 'blocked' }).success).toBe(false);
  });

  it('refuses a digest missing a row', () => {
    const rest = Object.fromEntries(Object.entries(digest).filter(([k]) => k !== 'cost'));
    expect(GoalDigestDto.safeParse(rest).success).toBe(false);
  });
});

describe('GoalDto', () => {
  it('describes a draft goal with its criteria', () => {
    const goalId = mintId('Goal');
    const dto = {
      id: goalId,
      projectId: mintId('Project'),
      title: 'Real areas',
      objective: 'Areas, proposed and editable',
      caresMost: null,
      description: '',
      ownerId: mintId('Person'),
      state: 'draft',
      budget: null,
      criteria: [
        {
          id: mintId('GoalCriterion'),
          goalId,
          text: 'The builder accepts the area names',
          check: 'accept',
          taskId: null,
          command: null,
          commandApproved: false,
          personId: null,
          state: 'unproven',
          proof: [],
          provenAt: null,
          provenBy: null,
        },
      ],
      taskIds: [mintId('Task')],
      createdAt: '2026-10-29T12:00:00.000Z',
      updatedAt: '2026-10-29T12:00:00.000Z',
    };
    expect(GoalDto.parse(dto)).toEqual(dto);
    expect(GoalDto.safeParse({ ...dto, state: 'finished' }).success).toBe(false);
  });
});

describe('goal events and TaskDto', () => {
  it('has goal events', () => {
    expect(EventType.GoalCreated).toBe('goal.created');
    expect(EventType.GoalChanged).toBe('goal.changed');
  });

  it('gives TaskDto an optional goalId', () => {
    const shape = TaskDto.shape;
    expect(shape.goalId.safeParse(undefined).success).toBe(true);
    expect(shape.goalId.safeParse(null).success).toBe(true);
    expect(shape.goalId.safeParse(mintId('Goal')).success).toBe(true);
    expect(shape.goalId.safeParse(mintId('Task')).success).toBe(false);
  });

  it('registers the goal schemas for JSON Schema generation', () => {
    for (const stem of [
      'goal-brief',
      'goal-dto',
      'goal-criterion-dto',
      'goal-digest-dto',
      'goal-adopt-input',
      'goal-adopt-error',
    ]) {
      expect(Object.keys(CONTRACT_SCHEMAS)).toContain(stem);
    }
  });
});
