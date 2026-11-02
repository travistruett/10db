import { describe, expect, it } from 'vitest';
import { Delivery, WorkspaceMode, type RiskTag } from '@10db/contracts';
import { proposePlacement } from './propose';

interface Row {
  readonly name: string;
  readonly project?: {
    readonly delivery?: Delivery;
    readonly workspaceMode?: WorkspaceMode;
    readonly isolate?: readonly string[];
  };
  readonly task: {
    readonly areas?: readonly string[];
    readonly riskTags?: readonly RiskTag[];
    readonly workspaceMode?: WorkspaceMode;
  };
  readonly mode: WorkspaceMode;
  readonly reason: string | null;
}

const rows: readonly Row[] = [
  {
    name: 'no match takes the project default',
    task: { areas: ['app'] },
    mode: 'shared',
    reason: null,
  },
  {
    name: 'no match takes a worktree project default',
    project: { workspaceMode: 'worktree' },
    task: { areas: ['app'] },
    mode: 'worktree',
    reason: null,
  },
  {
    name: 'an area in the isolate list',
    task: { areas: ['app', 'migrations'] },
    mode: 'worktree',
    reason: 'touches migrations',
  },
  { name: 'the deps hazard', task: { areas: ['deps'] }, mode: 'worktree', reason: 'touches deps' },
  {
    name: 'a migration risk tag',
    task: { areas: ['app'], riskTags: ['migration'] },
    mode: 'worktree',
    reason: 'touches migrations',
  },
  {
    name: 'a dependency risk tag',
    task: { areas: ['app'], riskTags: ['dependency'] },
    mode: 'worktree',
    reason: 'touches dependencies',
  },
  {
    name: 'a security risk tag is no match',
    task: { areas: ['app'], riskTags: ['security', 'auth'] },
    mode: 'shared',
    reason: null,
  },
  {
    name: 'two matches name both, each once',
    task: { areas: ['deps', 'migrations'], riskTags: ['migration'] },
    mode: 'worktree',
    reason: 'touches deps, migrations',
  },
  {
    name: 'contracts with the stock list is no match',
    task: { areas: ['contracts'] },
    mode: 'shared',
    reason: null,
  },
  {
    name: 'contracts in the project list is a match',
    project: { isolate: ['migrations', 'deps', 'contracts'] },
    task: { areas: ['contracts'] },
    mode: 'worktree',
    reason: 'touches contracts',
  },
  {
    name: 'an emptied list leaves only the risk tags',
    project: { isolate: [] },
    task: { areas: ['migrations'] },
    mode: 'shared',
    reason: null,
  },
  {
    name: 'a match beats an explicit shared',
    task: { areas: ['migrations'], workspaceMode: 'shared' },
    mode: 'worktree',
    reason: 'touches migrations',
  },
  {
    name: 'a risk tag match beats an explicit shared',
    task: { areas: ['app'], riskTags: ['dependency'], workspaceMode: 'shared' },
    mode: 'worktree',
    reason: 'touches dependencies',
  },
  {
    name: 'no match takes an explicit worktree, with no reason',
    task: { areas: ['app'], workspaceMode: 'worktree' },
    mode: 'worktree',
    reason: null,
  },
  {
    name: 'no match takes an explicit shared in a worktree project',
    project: { workspaceMode: 'worktree' },
    task: { areas: ['app'], workspaceMode: 'shared' },
    mode: 'shared',
    reason: null,
  },
  {
    name: 'local delivery is always shared, even for a match',
    project: { delivery: 'local' },
    task: { areas: ['migrations'], riskTags: ['migration'], workspaceMode: 'worktree' },
    mode: 'shared',
    reason: null,
  },
];

describe('proposePlacement', () => {
  it.each(rows)('$name', ({ project, task, mode, reason }) => {
    expect(
      proposePlacement(
        {
          delivery: Delivery.PullRequest,
          workspaceMode: WorkspaceMode.Shared,
          isolate: ['migrations', 'deps'],
          ...project,
        },
        { areas: [], riskTags: [], ...task },
      ),
    ).toEqual({ workspaceMode: mode, reason });
  });
});
