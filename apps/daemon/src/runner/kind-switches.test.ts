import { Delivery, KindInput, StepRole, WorkspaceMode } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { proposalFiling } from '../inbox';
import { proposePlacement } from '../placement';
import { SEEDED_KINDS } from '../team';
import { shipsAtRetryLimit } from './limit-ship';
import { forcedReview } from './forced-review';

// What the four risk tags did before kinds: review forced for all four, a rejection at the limit failing
// security and auth, a separate copy for migration and dependency, and a card for every proposal that had one.
const BEFORE = {
  security: { review: true, failsAtLimit: true, ownCopy: false, card: true },
  auth: { review: true, failsAtLimit: true, ownCopy: false, card: true },
  migration: { review: true, failsAtLimit: false, ownCopy: true, card: true },
  dependency: { review: true, failsAtLimit: false, ownCopy: true, card: true },
  schema: { review: false, failsAtLimit: false, ownCopy: false, card: false },
  infra: { review: false, failsAtLimit: false, ownCopy: false, card: false },
  ui: { review: false, failsAtLimit: false, ownCopy: false, card: false },
  docs: { review: false, failsAtLimit: false, ownCopy: false, card: false },
} as const;

const seeded = SEEDED_KINDS.map((kind) => KindInput.parse(kind));
const gateRun = [{ kind: 'gate', exitCode: 0 }] as const;

describe('the seeded kinds carry the behaviour the risk tags had', () => {
  it.each(Object.entries(BEFORE))('%s', (key, before) => {
    const kind = seeded.find((k) => k.key === key);
    if (kind === undefined) throw new Error(`no seeded kind ${key}`);
    const task = { kinds: [kind] };
    expect(forcedReview(task.kinds, { files: [] }, []) !== null).toBe(before.review);
    expect(
      shipsAtRetryLimit({ role: StepRole.Review, kinds: task.kinds, evidence: [...gateRun] }),
    ).toBe(!before.failsAtLimit);
    const placement = proposePlacement(
      { delivery: Delivery.PullRequest, workspaceMode: WorkspaceMode.Shared, isolate: [] },
      { areas: [], kinds: [kind] },
    );
    expect(placement.workspaceMode === WorkspaceMode.Worktree).toBe(before.ownCopy);
    const filing = proposalFiling({
      kind: 'new_task',
      title: 'Reword the criterion',
      body: 'It is unclear.',
      kinds: [key],
      known: seeded,
      limit: 1200,
    });
    expect(!filing.file).toBe(before.card);
  });
});
