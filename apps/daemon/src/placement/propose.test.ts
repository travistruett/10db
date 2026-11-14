import { describe, expect, it } from 'vitest';
import { Delivery, WorkspaceMode, type KindDto } from '@10db/contracts';
import { proposePlacement } from './propose';

interface Row {
  readonly name: string;
  readonly project?: {
    readonly delivery?: Delivery;
    readonly workspaceMode?: WorkspaceMode;
    readonly isolate?: readonly string[];
    readonly passHoldsFolder?: boolean;
  };
  readonly task: {
    readonly areas?: readonly string[];
    /** Kind keys, read against `KINDS`. */
    readonly kinds?: readonly string[];
    readonly workspaceMode?: WorkspaceMode;
  };
  readonly mode: WorkspaceMode;
  readonly reason: string | null;
}

/** The kinds the builder has, in their order. */
const KINDS: readonly Pick<KindDto, 'key' | 'label' | 'ownCopy'>[] = [
  { key: 'security', label: 'Security', ownCopy: false },
  { key: 'auth', label: 'Auth', ownCopy: false },
  { key: 'migration', label: 'Migration', ownCopy: true },
  { key: 'dependency', label: 'Dependency', ownCopy: true },
  { key: 'payments', label: 'Payments', ownCopy: true },
  { key: 'billing', label: 'Billing', ownCopy: true },
];
const kindsNamed = (keys: readonly string[]) => KINDS.filter((k) => keys.includes(k.key));

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
    name: 'a migration kind',
    task: { areas: ['app'], kinds: ['migration'] },
    mode: 'worktree',
    reason: 'touches migrations',
  },
  {
    name: 'a dependency kind',
    task: { areas: ['app'], kinds: ['dependency'] },
    mode: 'worktree',
    reason: 'touches dependencies',
  },
  {
    name: 'a custom kind that asks for its own copy',
    task: { areas: ['app'], kinds: ['payments'] },
    mode: 'worktree',
    reason: 'touches Payments',
  },
  {
    name: 'a custom kind whose label does not end in s, read as written',
    task: { areas: ['app'], kinds: ['billing'] },
    mode: 'worktree',
    reason: 'touches Billing',
  },
  {
    name: 'a kind that was deleted asks for nothing',
    task: { areas: ['app'], kinds: ['gone'] },
    mode: 'shared',
    reason: null,
  },
  {
    name: 'two kinds name both in the builder’s order, whatever order the task lists them',
    task: { areas: ['app'], kinds: ['dependency', 'migration'] },
    mode: 'worktree',
    reason: 'touches migrations, dependencies',
  },
  {
    name: 'kinds that ask for nothing are no match',
    task: { areas: ['app'], kinds: ['security', 'auth'] },
    mode: 'shared',
    reason: null,
  },
  {
    name: 'two matches name both, each once',
    task: { areas: ['deps', 'migrations'], kinds: ['migration'] },
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
    name: 'an emptied list leaves only the kinds',
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
    name: 'a kind match beats an explicit shared',
    task: { areas: ['app'], kinds: ['dependency'], workspaceMode: 'shared' },
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
    name: 'a pass holding Your folder sends an explicit shared to a copy',
    project: { passHoldsFolder: true },
    task: { areas: ['app'], workspaceMode: 'shared' },
    mode: 'worktree',
    reason: 'Your folder is in a UI Workbench pass',
  },
  {
    name: 'a pass holding Your folder sends a shared default to a copy',
    project: { passHoldsFolder: true },
    task: { areas: ['app'] },
    mode: 'worktree',
    reason: 'Your folder is in a UI Workbench pass',
  },
  {
    name: 'a pass holding Your folder keeps the isolate reason',
    project: { passHoldsFolder: true },
    task: { areas: ['migrations'] },
    mode: 'worktree',
    reason: 'touches migrations',
  },
  {
    name: 'a pass holding Your folder leaves a local project shared: its tasks wait instead',
    project: { delivery: 'local', passHoldsFolder: true },
    task: { areas: ['app'] },
    mode: 'shared',
    reason: null,
  },
  {
    name: 'local delivery is always shared, even for a match',
    project: { delivery: 'local' },
    task: { areas: ['migrations'], kinds: ['migration'], workspaceMode: 'worktree' },
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
        { areas: [], ...task, kinds: kindsNamed(task.kinds ?? []) },
      ),
    ).toEqual({ workspaceMode: mode, reason });
  });
});
