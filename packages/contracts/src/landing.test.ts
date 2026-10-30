import { describe, expect, it } from 'vitest';
import { ProjectInput, ProjectPatch, TaskInput, TaskPatch } from './entities';
import {
  DEFAULT_PROJECT_LANDING,
  landingTarget,
  landingText,
  ProjectLanding,
  sameLanding,
  TaskLanding,
  taskLandingFor,
} from './landing';

describe('where a task lands', () => {
  it.each([
    { name: 'base', value: { kind: 'base' }, ok: true },
    { name: 'hold', value: { kind: 'hold' }, ok: true },
    { name: 'branch', value: { kind: 'branch', branch: 'feature/x' }, ok: true },
    { name: 'branch without a name', value: { kind: 'branch' }, ok: false },
    {
      name: 'branch with an option for a name',
      value: { kind: 'branch', branch: '-d' },
      ok: false,
    },
    { name: 'unknown kind', value: { kind: 'squash' }, ok: false },
  ])('$name', ({ value, ok }) => {
    expect(TaskLanding.safeParse(value).success).toBe(ok);
  });

  it('starts from merging into the base branch', () => {
    expect(DEFAULT_PROJECT_LANDING).toBe(ProjectLanding.Merge);
    const project = ProjectInput.parse({
      name: 'p',
      repoPath: '/tmp/p',
      areas: [{ name: 'api', globs: ['src/**'] }],
    });
    expect(project.landing).toBe('merge');
  });

  it('lets a project hold and a task name its landing or leave it to the project', () => {
    expect(ProjectPatch.parse({ landing: 'hold' })).toEqual({ landing: 'hold' });
    expect(ProjectPatch.safeParse({ landing: 'squash' }).success).toBe(false);
    const task = { title: 't', acceptanceCriteria: ['c'], areas: ['api'] };
    expect(TaskInput.parse(task).landing).toBeUndefined();
    expect(
      TaskInput.parse({ ...task, landing: { kind: 'branch', branch: 'dev' } }).landing,
    ).toEqual({ kind: 'branch', branch: 'dev' });
    expect(TaskPatch.parse({ landing: { kind: 'hold' } })).toEqual({ landing: { kind: 'hold' } });
  });

  it.each([
    { project: 'merge', expected: { kind: 'base' } },
    { project: 'hold', expected: { kind: 'hold' } },
  ] as const)('a task follows a project that $project', ({ project, expected }) => {
    expect(taskLandingFor(project)).toEqual(expected);
  });

  it.each([
    {
      name: 'base merges into the project base',
      landing: { kind: 'base' },
      expected: { baseBranch: 'main', autoMerge: true },
    },
    {
      name: 'hold waits on the project base',
      landing: { kind: 'hold' },
      expected: { baseBranch: 'main', autoMerge: false },
    },
    {
      name: 'a branch is both base and target',
      landing: { kind: 'branch', branch: 'feature/x' },
      expected: { baseBranch: 'feature/x', autoMerge: true },
    },
    {
      name: 'the project base named as a branch is the base',
      landing: { kind: 'branch', branch: 'main' },
      expected: { baseBranch: 'main', autoMerge: true },
    },
  ] as const)('$name', ({ landing, expected }) => {
    expect(landingTarget(landing, 'main')).toEqual(expected);
  });

  it('compares what two tasks would do, not how they were chosen', () => {
    expect(sameLanding({ kind: 'base' }, { kind: 'branch', branch: 'main' }, 'main')).toBe(true);
    expect(sameLanding({ kind: 'base' }, { kind: 'hold' }, 'main')).toBe(false);
    expect(sameLanding({ kind: 'base' }, { kind: 'branch', branch: 'dev' }, 'main')).toBe(false);
    expect(
      sameLanding({ kind: 'branch', branch: 'dev' }, { kind: 'branch', branch: 'dev' }, 'main'),
    ).toBe(true);
  });

  it.each([
    { landing: { kind: 'base' }, text: 'Merges into main when checks pass' },
    {
      landing: { kind: 'branch', branch: 'feature/x' },
      text: 'Merges into feature/x when checks pass',
    },
    { landing: { kind: 'hold' }, text: 'Held for your review: pull request against main' },
  ] as const)('says $text', ({ landing, text }) => {
    expect(landingText(landing, 'main')).toBe(text);
  });
});
