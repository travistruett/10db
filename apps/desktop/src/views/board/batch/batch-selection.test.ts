import { PickerProposalDto, type TaskId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { candidate, projectDto, taskDto } from '../../../test/fixtures';
import { initialSelection, orderedSelection, startBlockers, toggle } from './batch-selection';
import type { SheetMode } from './sheet-mode';

const project = projectDto();
const one = taskDto({ projectId: project.id, title: 'One' });
const two = taskDto({ projectId: project.id, title: 'Two' });
const three = taskDto({ projectId: project.id, title: 'Three' });
const proposal = PickerProposalDto.parse({
  projectId: project.id,
  size: 2,
  candidates: [
    candidate(one),
    candidate(two, { proposed: false, conflict: 'Area src is shared with One, picked before it' }),
    candidate(three, {
      proposed: false,
      plan: { rigor: 'standard', steps: [], overBudget: [0] },
      conflict: 'Over the budget ceiling: step 1 (implement)',
    }),
  ],
});
const LOCAL: SheetMode = { kind: 'local' };
const NEW: SheetMode = { kind: 'new_batch' };
const CUTTING = 'Fix the login is still cutting its branch; start when it is open';
const SHIPPING = 'Fix the login is shipping; start once it has shipped';

describe('batch selection', () => {
  it('starts with the proposed tasks ticked', () => {
    expect([...initialSelection(proposal)]).toEqual([one.id]);
  });

  it('keeps the picker’s order whatever order the builder ticked in', () => {
    expect(orderedSelection(proposal, toggle(toggle(new Set<TaskId>(), two.id), one.id))).toEqual([
      one.id,
      two.id,
    ]);
  });

  it('unticks a ticked task', () => {
    expect([...toggle(new Set([one.id, two.id]), one.id)]).toEqual([two.id]);
  });

  it('drops a ticked task that is no longer a candidate', () => {
    expect(orderedSelection(proposal, new Set([one.id, taskDto().id]))).toEqual([one.id]);
  });

  it.each([
    {
      name: 'nothing ticked',
      ticked: [],
      mode: LOCAL,
      title: '',
      blockers: ['Tick at least one task'],
    },
    { name: 'a proposed task, local', ticked: [one], mode: LOCAL, title: '', blockers: [] },
    {
      name: 'a task sharing an area (it waits its turn)',
      ticked: [one, two],
      mode: LOCAL,
      title: '',
      blockers: [],
    },
    {
      name: 'an over-budget task',
      ticked: [three],
      mode: LOCAL,
      title: '',
      blockers: ['Three is over the budget ceiling'],
    },
    { name: 'a new batch with a title', ticked: [one], mode: NEW, title: 'One', blockers: [] },
    {
      name: 'a new batch with no title',
      ticked: [one],
      mode: NEW,
      title: '  ',
      blockers: ['Name the batch'],
    },
    {
      name: 'joining an open batch',
      ticked: [one],
      mode: { kind: 'join', title: 'Fix the login' },
      title: '',
      blockers: [],
    },
    {
      name: 'fixing a failed batch',
      ticked: [one],
      mode: { kind: 'fix', title: 'Fix the login' },
      title: '',
      blockers: [],
    },
    {
      name: 'a batch cutting its branch',
      ticked: [one],
      mode: { kind: 'busy', title: 'Fix the login', reason: CUTTING },
      title: '',
      blockers: [CUTTING],
    },
    {
      name: 'a shipping batch',
      ticked: [one],
      mode: { kind: 'busy', title: 'Fix the login', reason: SHIPPING },
      title: '',
      blockers: [SHIPPING],
    },
  ] satisfies {
    name: string;
    ticked: (typeof one)[];
    mode: SheetMode;
    title: string;
    blockers: string[];
  }[])('answers the blockers for $name', ({ ticked, mode, title, blockers }) => {
    const selection = new Set(ticked.map((t) => t.id));
    expect(startBlockers(proposal, selection, mode, title)).toEqual(blockers);
  });

  describe('a ticked task that depends on a ticked task in the other placement', () => {
    const base = taskDto({ projectId: project.id, title: 'Base' });
    const top = (workspaceMode: 'shared' | 'worktree', baseMode: 'shared' | 'worktree') => {
      const dep = { ...base, workspaceMode: baseMode };
      const dependent = {
        ...taskDto({ projectId: project.id, title: 'Top' }),
        workspaceMode,
        dependsOn: [dep.id],
      };
      return {
        dep,
        dependent,
        proposal: PickerProposalDto.parse({
          projectId: project.id,
          size: 2,
          candidates: [candidate(dep), candidate(dependent)],
        }),
      };
    };

    it.each([
      ['a separate copy', 'Your folder', 'worktree', 'shared'],
      ['Your folder', 'a separate copy', 'shared', 'worktree'],
    ] as const)('says %s needs a task in %s', (where, depWhere, mode, baseMode) => {
      const { dep, dependent, proposal: p } = top(mode, baseMode);
      expect(startBlockers(p, new Set([dep.id, dependent.id]), NEW, 'Base')).toEqual([
        `Top runs in ${where} but needs Base, which runs in ${depWhere}. Tasks that depend on each other must run in the same place: change where one of them runs.`,
      ]);
    });

    it('is not a blocker when both run in the same place', () => {
      const { dep, dependent, proposal: p } = top('worktree', 'worktree');
      expect(startBlockers(p, new Set([dep.id, dependent.id]), NEW, 'Base')).toEqual([]);
    });

    it('is not a blocker while the dependency is not ticked', () => {
      const { dependent, proposal: p } = top('worktree', 'shared');
      expect(startBlockers(p, new Set([dependent.id]), NEW, 'Top')).toEqual([]);
    });

    it('is not a blocker in a local project, which has no placement', () => {
      const { dep, dependent, proposal: p } = top('worktree', 'shared');
      expect(startBlockers(p, new Set([dep.id, dependent.id]), LOCAL, '')).toEqual([]);
    });
  });

  it('names a task whose plan failed', () => {
    const failed = PickerProposalDto.parse({
      projectId: project.id,
      size: 1,
      candidates: [
        candidate(one, {
          plan: null,
          planError: 'The standard flow is missing; restart 10db to seed it',
        }),
      ],
    });
    expect(startBlockers(failed, new Set([one.id]), LOCAL, '')).toEqual([
      'One: The standard flow is missing; restart 10db to seed it',
    ]);
  });
});
