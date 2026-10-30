import { describe, expect, it } from 'vitest';
import { batchDto, projectDto, taskDto } from '../../test/fixtures';
import {
  draftFor,
  draftOf,
  landingChanged,
  landingFromDraft,
  landingLine,
  landingOptions,
} from './landing-draft';

describe('landing draft', () => {
  it.each([
    { name: 'merging project', project: 'merge', expected: { kind: 'base', branch: '' } },
    { name: 'holding project', project: 'hold', expected: { kind: 'hold', branch: '' } },
  ] as const)('starts from the project default: $name', ({ project, expected }) => {
    expect(draftFor(projectDto({ landing: project }))).toEqual(expected);
  });

  it.each([
    { name: 'base', landing: { kind: 'base' }, expected: { kind: 'base', branch: '' } },
    { name: 'hold', landing: { kind: 'hold' }, expected: { kind: 'hold', branch: '' } },
    {
      name: 'a branch',
      landing: { kind: 'branch', branch: 'feature/x' },
      expected: { kind: 'branch', branch: 'feature/x' },
    },
  ] as const)('reads a task landing: $name', ({ landing, expected }) => {
    expect(draftOf(landing)).toEqual(expected);
  });

  it.each([
    { name: 'base', draft: { kind: 'base', branch: 'ignored' }, expected: { kind: 'base' } },
    { name: 'hold', draft: { kind: 'hold', branch: '' }, expected: { kind: 'hold' } },
    {
      name: 'a branch, trimmed',
      draft: { kind: 'branch', branch: '  feature/x ' },
      expected: { kind: 'branch', branch: 'feature/x' },
    },
  ] as const)('sends $name', ({ draft, expected }) => {
    expect(landingFromDraft(draft)).toEqual({ ok: true, landing: expected });
  });

  it.each([
    { name: 'no name', branch: '', error: 'Name the branch this task merges into' },
    { name: 'blanks', branch: '   ', error: 'Name the branch this task merges into' },
    {
      name: 'an option',
      branch: '-d',
      error: 'Enter a branch name such as feature/search',
    },
    {
      name: 'a space',
      branch: 'my branch',
      error: 'Enter a branch name such as feature/search',
    },
  ])('refuses a branch with $name', ({ branch, error }) => {
    expect(landingFromDraft({ kind: 'branch', branch })).toEqual({ ok: false, error });
  });

  it('knows whether the draft differs from the task', () => {
    const task = { kind: 'branch', branch: 'dev' } as const;
    expect(landingChanged(task, { kind: 'branch', branch: 'dev' })).toBe(false);
    expect(landingChanged(task, { kind: 'branch', branch: ' dev ' })).toBe(false);
    expect(landingChanged(task, { kind: 'branch', branch: 'other' })).toBe(true);
    expect(landingChanged(task, { kind: 'hold', branch: 'dev' })).toBe(true);
    expect(landingChanged({ kind: 'base' }, { kind: 'base', branch: 'typed then dropped' })).toBe(
      false,
    );
  });

  it('names the base branch in the first choice', () => {
    expect(landingOptions('develop')).toEqual([
      { value: 'base', label: 'Merge into develop' },
      { value: 'branch', label: 'Merge into another branch' },
      { value: 'hold', label: 'Hold for my review' },
    ]);
  });
});

describe('landingLine', () => {
  it.each([
    {
      name: 'a task that merges into the base',
      task: taskDto({ landing: { kind: 'base' } }),
      batch: undefined,
      text: 'Merges into main when checks pass',
    },
    {
      name: 'a task that merges into another branch',
      task: taskDto({ landing: { kind: 'branch', branch: 'feature/x' } }),
      batch: undefined,
      text: 'Merges into feature/x when checks pass',
    },
    {
      name: 'a held task',
      task: taskDto({ landing: { kind: 'hold' } }),
      batch: undefined,
      text: 'Held for your review: pull request against main',
    },
    {
      name: 'a started task follows its batch',
      task: taskDto({ landing: { kind: 'base' } }),
      batch: batchDto({ baseBranch: 'release', autoMerge: true }),
      text: 'Merges into release when checks pass',
    },
    {
      name: 'a started task whose batch holds',
      task: taskDto({ landing: { kind: 'base' } }),
      batch: batchDto({ baseBranch: 'main', autoMerge: false }),
      text: 'Held for your review: pull request against main',
    },
  ])('says where $name lands', ({ task, batch, text }) => {
    expect(landingLine(task, batch, 'main')).toBe(text);
  });
});
