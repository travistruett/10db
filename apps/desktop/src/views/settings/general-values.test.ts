import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { projectDto } from '../../test/fixtures';
import { checkGeneral, generalValues, type GeneralValues } from './general-values';

const project = projectDto({ name: 'demo', gateCommand: 'make gate', budgetCeiling: null });
const base = generalValues(project);
const flowId = mintId('Flow');

describe('checkGeneral', () => {
  it.each<{
    name: string;
    change: Partial<GeneralValues>;
    expected: ReturnType<typeof checkGeneral>;
  }>([
    { name: 'nothing changed', change: {}, expected: { ok: true, patch: null } },
    {
      name: 'a new name, trimmed',
      change: { name: '  demo2 ' },
      expected: { ok: true, patch: { name: 'demo2' } },
    },
    {
      name: 'a ceiling',
      change: { budgetCeiling: 2.5 },
      expected: { ok: true, patch: { budgetCeiling: 2.5 } },
    },
    {
      name: 'localhost on',
      change: { sandboxLoopback: true },
      expected: { ok: true, patch: { sandboxLoopback: true } },
    },
    {
      name: 'a worktree per task',
      change: { delivery: 'pull_request', prTitlePrefix: 'feat(app)', workspaceMode: 'worktree' },
      expected: {
        ok: true,
        patch: { delivery: 'pull_request', prTitlePrefix: 'feat(app)', workspaceMode: 'worktree' },
      },
    },
    {
      name: 'a new seed, trimmed and without blanks',
      change: { worktreeSeed: [' node_modules ', '.venv', ''] },
      expected: { ok: true, patch: { worktreeSeed: ['node_modules', '.venv'] } },
    },
    {
      name: 'a seed name with a slash',
      change: { worktreeSeed: ['a/b'] },
      expected: {
        ok: false,
        errors: { worktreeSeed: 'Name one directory: no slash, ".", ".." or ".git"' },
      },
    },
    {
      name: 'more seed names than the contract allows',
      change: { worktreeSeed: Array.from({ length: 33 }, (_, i) => `d${String(i)}`) },
      expected: { ok: false, errors: { worktreeSeed: expect.any(String) as string } },
    },
    {
      name: 'a worktree per task in local delivery',
      change: { workspaceMode: 'worktree' },
      expected: {
        ok: false,
        errors: { workspaceMode: 'A worktree per task needs pull request delivery' },
      },
    },
    { name: 'a flow', change: { flowId }, expected: { ok: true, patch: { flowId } } },
    {
      name: 'the lane cap and wait',
      change: { maxLanes: 4, humanWaitMinutes: 30 },
      expected: { ok: true, patch: { maxLanes: 4, humanWaitMinutes: 30 } },
    },
    {
      name: 'an empty name',
      change: { name: ' ' },
      expected: { ok: false, errors: { name: 'Enter a name' } },
    },
    {
      name: 'an empty gate',
      change: { gateCommand: '' },
      expected: { ok: false, errors: { gateCommand: 'Enter the gate command' } },
    },
    {
      name: 'an empty lane cap',
      change: { maxLanes: '' },
      expected: { ok: false, errors: { maxLanes: 'Enter the lane cap' } },
    },
    {
      name: 'an empty handoff',
      change: { handoffPct: '' },
      expected: { ok: false, errors: { handoffPct: 'Enter the handoff percentage' } },
    },
    {
      name: 'a nudge at the handoff',
      change: { handoffPct: 50, nudgePct: 50 },
      expected: { ok: false, errors: { nudgePct: 'The nudge must come after the handoff' } },
    },
    {
      name: 'a zero ceiling',
      change: { budgetCeiling: 0 },
      expected: {
        ok: false,
        errors: { budgetCeiling: 'Enter a ceiling above $0, or leave it empty for none' },
      },
    },
    {
      name: 'pull-request delivery with a prefix, trimmed',
      change: { delivery: 'pull_request', prTitlePrefix: ' feat(app) ' },
      expected: { ok: true, patch: { delivery: 'pull_request', prTitlePrefix: 'feat(app)' } },
    },
    {
      name: 'pull-request delivery without a prefix',
      change: { delivery: 'pull_request' },
      expected: {
        ok: false,
        errors: { prTitlePrefix: 'Enter a PR title prefix such as feat(app)' },
      },
    },
    {
      name: 'a prefix that is not a Conventional Commit type',
      change: { prTitlePrefix: 'Feature' },
      expected: {
        ok: false,
        errors: { prTitlePrefix: 'Enter a PR title prefix such as feat(app)' },
      },
    },
    {
      name: 'a new base branch',
      change: { baseBranch: 'develop' },
      expected: { ok: true, patch: { baseBranch: 'develop' } },
    },
    {
      name: 'a base branch that is an option',
      change: { baseBranch: '-x' },
      expected: { ok: false, errors: { baseBranch: 'Enter the base branch, such as main' } },
    },
  ])('answers $name', ({ change, expected }) => {
    expect(checkGeneral(project, { ...base, ...change })).toEqual(expected);
  });

  it('clears a ceiling when the field is emptied', () => {
    const capped = projectDto({ budgetCeiling: 3 });
    expect(checkGeneral(capped, { ...generalValues(capped), budgetCeiling: '' })).toEqual({
      ok: true,
      patch: { budgetCeiling: null },
    });
  });

  it('clears a prefix when the field is emptied in local delivery', () => {
    const prefixed = projectDto({ prTitlePrefix: 'feat(app)' });
    expect(checkGeneral(prefixed, { ...generalValues(prefixed), prTitlePrefix: '' })).toEqual({
      ok: true,
      patch: { prTitlePrefix: null },
    });
  });

  it.each<{ name: string; allowedCommands: string; expected: ReturnType<typeof checkGeneral> }>([
    {
      name: 'a list, one command per line, trimmed and without blank lines',
      allowedCommands: ' pnpm test \n\npnpm exec prettier\n',
      expected: { ok: true, patch: { allowedCommands: ['pnpm test', 'pnpm exec prettier'] } },
    },
    {
      name: 'the same command twice',
      allowedCommands: 'pnpm test\npnpm test',
      expected: { ok: false, errors: { allowedCommands: 'List each command once' } },
    },
  ])('answers $name', ({ allowedCommands, expected }) => {
    expect(checkGeneral(project, { ...base, allowedCommands })).toEqual(expected);
  });

  it('names the first line that is not a plain command prefix', () => {
    const checked = checkGeneral(project, { ...base, allowedCommands: 'pnpm test\npnpm --run' });
    expect(checked.ok).toBe(false);
    expect(checked.ok ? undefined : checked.errors.allowedCommands).toMatch(/^Line 2: /);
  });

  it('shows the project list as one command per line', () => {
    const listed = projectDto({ allowedCommands: ['pnpm test', 'pnpm exec prettier'] });
    expect(generalValues(listed).allowedCommands).toBe('pnpm test\npnpm exec prettier');
  });

  it('sends nothing for the list when it is unchanged, and clears it when emptied', () => {
    const listed = projectDto({ allowedCommands: ['pnpm test'] });
    const values = generalValues(listed);
    expect(checkGeneral(listed, values)).toEqual({ ok: true, patch: null });
    expect(checkGeneral(listed, { ...values, allowedCommands: '' })).toEqual({
      ok: true,
      patch: { allowedCommands: [] },
    });
  });
});
