import { matchesGlob } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PathPattern } from './entities';
import {
  AreaProposalInput,
  AreaProposalResult,
  AreaProposalSource,
  WHOLE_REPOSITORY_GLOBS,
} from './folders';

const area = { name: 'daemon', globs: ['apps/daemon/**'], reason: 'The daemon app.' };

describe('AreaProposalResult', () => {
  it('holds areas with their globs and a reason', () => {
    const parsed = AreaProposalResult.parse({
      ok: true,
      proposal: { areas: [area], namedBy: AreaProposalSource.Model },
    });
    expect(parsed.ok && parsed.proposal.areas[0]?.reason).toBe('The daemon app.');
  });

  it('refuses an area with no reason, no globs or a name the project would not accept', () => {
    const wrap = (a: unknown) => ({
      ok: true,
      proposal: { areas: [a], namedBy: AreaProposalSource.Structure },
    });
    expect(AreaProposalResult.safeParse(wrap({ ...area, reason: '' })).success).toBe(false);
    expect(AreaProposalResult.safeParse(wrap({ ...area, globs: [] })).success).toBe(false);
    expect(AreaProposalResult.safeParse(wrap({ ...area, name: 'Daemon App' })).success).toBe(false);
  });

  it('refuses a proposal of no areas', () => {
    const result = AreaProposalResult.safeParse({
      ok: true,
      proposal: { areas: [], namedBy: AreaProposalSource.Structure },
    });
    expect(result.success).toBe(false);
  });

  it('can say why nothing was proposed', () => {
    expect(
      AreaProposalResult.parse({ ok: false, message: "This isn't a git repository." }),
    ).toEqual({ ok: false, message: "This isn't a git repository." });
  });
});

describe('AreaProposalInput', () => {
  it('takes an absolute path', () => {
    expect(AreaProposalInput.safeParse({ path: '/Users/me/app' }).success).toBe(true);
    expect(AreaProposalInput.safeParse({ path: 'app' }).success).toBe(false);
  });
});

describe('WHOLE_REPOSITORY_GLOBS', () => {
  it.each([
    'README.md',
    'apps/web/src/a.ts',
    '.gitignore',
    'apps/web/.env.example',
    '.github/workflows/ci.yml',
    'apps/web/.storybook/main.ts',
  ])('takes in %s', (file) => {
    expect(WHOLE_REPOSITORY_GLOBS.some((glob) => matchesGlob(file, glob))).toBe(true);
  });

  it('holds only globs a project accepts', () => {
    for (const glob of WHOLE_REPOSITORY_GLOBS)
      expect(PathPattern.safeParse(glob).success, glob).toBe(true);
  });
});
