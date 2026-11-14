import { describe, expect, it } from 'vitest';
import { Delivery, type KindDto } from '@10db/contracts';
import { placementAfterEdit } from './after-edit';

const project = {
  delivery: Delivery.PullRequest,
  workspaceMode: 'shared',
  isolate: ['migrations'],
} as const;
const known: readonly Pick<KindDto, 'key' | 'label' | 'ownCopy'>[] = [
  { key: 'migration', label: 'Migration', ownCopy: true },
  { key: 'docs', label: 'Docs', ownCopy: false },
];
const kinds = (...keys: string[]) => keys.map((key) => ({ key, source: 'rules' }) as const);

describe('placementAfterEdit', () => {
  it.each([
    {
      name: 'a kind that needs its own copy',
      areas: ['app'],
      taskKinds: kinds('migration'),
      want: { workspaceMode: 'worktree', reason: 'touches migrations' },
    },
    {
      name: 'an isolated area, whatever the kinds',
      areas: ['migrations'],
      taskKinds: kinds('docs'),
      want: { workspaceMode: 'worktree', reason: 'touches migrations' },
    },
    {
      name: 'a kind the builder deleted adds nothing',
      areas: ['app'],
      taskKinds: kinds('gone'),
      want: { workspaceMode: 'shared', reason: null },
    },
    {
      name: 'no match is the project default',
      areas: ['app'],
      taskKinds: kinds('docs'),
      want: { workspaceMode: 'shared', reason: null },
    },
  ])('$name', ({ areas, taskKinds, want }) => {
    expect(placementAfterEdit({ project, areas, kinds: taskKinds, known })).toEqual(want);
  });
});
