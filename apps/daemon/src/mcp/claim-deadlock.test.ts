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
    expect(options.map((o) => o.label)).toEqual(['A Waits', 'B Waits', 'Cancel A', 'Cancel B']);
  });

  it('leaves out the yield of a task that has no claim to give up', () => {
    const { options } = deadlockAnswers([
      { workstreamId: alpha, title: 'Alpha', yields: [] },
      { workstreamId: beta, title: 'Beta', yields: [{ kind: ClaimKind.Area, name: 'ui' }] },
    ]);
    const labels = options.map((o) => o.label);
    expect(labels).toEqual(['B Waits', 'Cancel A', 'Cancel B']);
  });

  it('letters the tasks, so every label stays short and distinct however long the titles are', () => {
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
    expect(labels).toEqual(['A Waits', 'B Waits', 'Cancel A', 'Cancel B', 'Cancel C']);
    expect(options[0]?.description).toContain(contact);
  });
});
