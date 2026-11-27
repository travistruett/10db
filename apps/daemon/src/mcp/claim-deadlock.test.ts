import { ClaimKind, InboxOption, type WorkstreamId } from '@10db/contracts';
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

  it('keeps every label short enough to parse, and distinct, when the titles are long', () => {
    // The titles of a real deadlock whose labels ran past the contract and emptied the Resolved list.
    const contact = `Resolve the open findings of "A contact's function and seniority are suggested from their title"`;
    const { options } = deadlockAnswers([
      { workstreamId: alpha, title: contact, yields: [{ kind: ClaimKind.Area, name: 'ingest' }] },
      {
        workstreamId: beta,
        title: 'Provide supported recovery replay for retained applied company reads',
        yields: [{ kind: ClaimKind.Area, name: 'sources' }],
      },
      { workstreamId: 'ws_gamma' as WorkstreamId, title: `${contact} again`, yields: [] },
    ]);
    for (const option of options) expect(InboxOption.safeParse(option).success).toBe(true);
    const labels = options.map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toMatch(/ yields area ingest$/);
    expect(options[0]?.description).toContain(contact);
  });
});
