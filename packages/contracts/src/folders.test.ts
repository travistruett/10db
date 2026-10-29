import { describe, expect, it } from 'vitest';
import { AreaProposalInput, AreaProposalResult, AreaProposalSource } from './folders';

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
