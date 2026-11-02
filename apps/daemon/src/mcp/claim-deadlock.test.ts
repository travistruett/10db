import { ClaimKind, type WorkstreamId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { deadlockAnswers } from './claim-deadlock';

const alpha = 'ws_alpha' as WorkstreamId;
const beta = 'ws_beta' as WorkstreamId;

describe('deadlockAnswers', () => {
  it('offers a yield and a cancel for each task that gives up a claim', () => {
    const { options } = deadlockAnswers([
      { workstreamId: alpha, title: 'Alpha', yields: [{ kind: ClaimKind.Area, name: 'api' }] },
      { workstreamId: beta, title: 'Beta', yields: [{ kind: ClaimKind.Area, name: 'ui' }] },
    ]);
    expect(options.map((o) => o.label)).toEqual([
      'Alpha yields area api',
      'Beta yields area ui',
      'Cancel Alpha',
      'Cancel Beta',
    ]);
  });

  it('leaves out the yield of a task that has no claim to give up', () => {
    const { options } = deadlockAnswers([
      { workstreamId: alpha, title: 'Alpha', yields: [] },
      { workstreamId: beta, title: 'Beta', yields: [{ kind: ClaimKind.Area, name: 'ui' }] },
    ]);
    const labels = options.map((o) => o.label);
    expect(labels).toEqual(['Beta yields area ui', 'Cancel Alpha', 'Cancel Beta']);
    expect(labels.some((l) => /yields\s*$/.test(l))).toBe(false);
  });
});
