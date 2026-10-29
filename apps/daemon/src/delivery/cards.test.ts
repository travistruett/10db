import { BatchDto, mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { batchCardFields } from './batch-card';
import { shipCards, worktreeCards, wrongBranchCard, type Card } from './cards';

const AT = '2026-10-13T12:00:00.000Z';
const batch = BatchDto.parse({
  id: mintId('Batch'),
  projectId: mintId('Project'),
  title: 'Greetings',
  state: 'FAILED',
  branch: '10db/greetings-0a1b2c3d',
  baseBranch: 'main',
  baseSha: 'a'.repeat(40),
  repo: 'acme/widgets',
  prUrl: null,
  gateExitCode: 2,
  gateLogPath: '/data/logs/gate/b.log',
  failure: 'gate_failed',
  worktreePath: '/wt/greetings',
  createdAt: AT,
  updatedAt: AT,
});
const gate = {
  exitCode: 2,
  durationMs: 1000,
  tail: 'FAIL',
  logPath: '/data/logs/gate/b.log',
  timedOut: false,
  aborted: false,
};

// Every card that tells the builder to Retry or Abandon a batch from the Board.
const cards: Record<string, Card> = {
  'worktree missing, waits': worktreeCards.missing(batch, '/wt/greetings', 'waits'),
  'worktree missing, failed': worktreeCards.missing(batch, '/wt/greetings', 'failed'),
  'worktree in the way': worktreeCards.inTheWay(batch, '/wt/greetings', 'a file'),
  'worktree not reopened': worktreeCards.notReopened(batch, new Error('boom')),
  'worktree not whole': worktreeCards.notWhole(batch, '/wt/greetings', 'main', ['a.ts']),
  'wrong branch, waits': wrongBranchCard(batch, 'main', '/repo', 'waits'),
  'wrong branch, failed': wrongBranchCard(batch, 'main', '/repo', 'failed'),
  'wrong branch, not shipped': wrongBranchCard(batch, 'main', '/repo', 'not_shipped'),
  'dirty checkout': shipCards.dirtyCheckout(batch, ['a.ts']).card,
  'gate failed': shipCards.gateFailed(batch, gate).card,
  'gate timed out': shipCards.gateTimedOut(batch, 60_000, '/data/logs/gate/b.log').card,
  'push timed out': shipCards.pushTimedOut(batch, 60_000).card,
};

describe('batch cards', () => {
  // A batch of one task has no strip on the Board; its Retry and Abandon are in the task's drawer.
  it.each(Object.entries(cards))('%s points at the task drawer, not a strip', (_name, card) => {
    expect(card.body).not.toMatch(/strip/i);
    expect(card.body).toContain("task's drawer on the Board");
  });

  it('the failed-workstream card defers to the drawer, not a strip', () => {
    const fields = batchCardFields({ id: mintId('Workstream'), batchId: batch.id });
    const later = fields?.options.find((o) => o.label === 'Later');
    expect(later?.description).toBe("Leave the batch open; decide later in the task's drawer");
  });
});
