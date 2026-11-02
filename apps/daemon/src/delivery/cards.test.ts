import { BatchDto, mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { batchCardFields } from './batch-card';
import { GhError } from '../github';
import {
  checkoutCards,
  prCards,
  shipCards,
  worktreeCards,
  wrongBranchCard,
  type Card,
  type ShipFailure,
} from './cards';

const AT = '2026-10-13T12:00:00.000Z';
const batch = BatchDto.parse({
  id: mintId('Batch'),
  projectId: mintId('Project'),
  title: 'Greetings',
  state: 'FAILED',
  branch: '10db/greetings-0a1b2c3d',
  baseBranch: 'main',
  autoMerge: true,
  baseSha: 'a'.repeat(40),
  repo: 'acme/widgets',
  prUrl: null,
  pr: null,
  prRequired: null,
  prMergeBlocked: null,
  ciFixOf: null,
  ciFixHead: null,
  ciStopped: null,
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
  blockedHosts: [],
};

// A worktree card carries its own answers, which the daemon acts on, so it names no drawer.
const worktreeAnswered: Record<string, { card: Card; labels: string[] }> = {
  'worktree missing, waits': {
    card: worktreeCards.missing(batch, '/wt/greetings', 'waits'),
    labels: ['Abandon batch'],
  },
  'worktree missing, failed': {
    card: worktreeCards.missing(batch, '/wt/greetings', 'failed'),
    labels: ['Retry', 'Abandon batch'],
  },
  'worktree in the way': {
    card: worktreeCards.inTheWay(batch, '/wt/greetings', 'a file'),
    labels: ['Retry', 'Abandon batch'],
  },
  'worktree not reopened': {
    card: worktreeCards.notReopened(batch, new Error('boom')),
    labels: ['Retry', 'Abandon batch'],
  },
  'worktree not whole': {
    card: worktreeCards.notWhole(batch, '/wt/greetings', 'main', ['a.ts']),
    labels: ['Retry', 'Abandon batch'],
  },
};

// Every card that tells the builder to Retry or Abandon a batch from the Board.
const cards: Record<string, Card> = {
  'wrong branch, waits': wrongBranchCard(batch, 'main', '/repo', 'waits'),
  'wrong branch, failed': wrongBranchCard(batch, 'main', '/repo', 'failed'),
  'wrong branch, not shipped': wrongBranchCard(batch, 'main', '/repo', 'not_shipped'),
  'dirty checkout': shipCards.dirtyCheckout(batch, ['a.ts']).card,
  'gate failed': shipCards.gateFailed(batch, gate).card,
  'gate failed twice, unrelated': shipCards.gateFailedUnrelated(batch, null, [
    { name: 'test', command: 'pnpm test', logPath: '/repo/.gate/test.log', tests: [] },
  ]).card,
  'gate timed out': shipCards.gateTimedOut(batch, 60_000, '/data/logs/gate/b.log').card,
  'push timed out': shipCards.pushTimedOut(batch, 60_000).card,
};

describe('batch cards', () => {
  // A batch of one task has no strip on the Board; its Retry and Abandon are in the task's drawer.
  it.each(Object.entries(cards))('%s points at the task drawer, not a strip', (_name, card) => {
    expect(card.body).not.toMatch(/strip/i);
    expect(card.body).toContain("task's drawer on the Board");
  });

  it.each(Object.entries(worktreeAnswered))(
    '%s offers its answers on the card',
    (_name, { card, labels }) => {
      expect(card.body).not.toMatch(/strip/i);
      expect(card.options?.map((o) => o.label)).toEqual(labels);
      expect(card.detail).toMatchObject({ batchId: batch.id });
    },
  );

  it('the failed-workstream card defers to the drawer, not a strip', () => {
    const fields = batchCardFields({ id: mintId('Workstream'), batchId: batch.id });
    const later = fields?.options.find((o) => o.label === 'Later');
    expect(later?.description).toBe("Leave the batch open; decide later in the task's drawer");
  });
});

describe('the cards of a batch that failed to ship', () => {
  const failures: Record<string, ShipFailure> = {
    'dirty checkout': shipCards.dirtyCheckout(batch, ['a.ts']),
    'base markers': shipCards.baseMarkers(batch, ['a.ts']),
    'gate failed': shipCards.gateFailed(batch, gate),
    'gate failed twice, unrelated': shipCards.gateFailedUnrelated(batch, null, []),
    'gate timed out': shipCards.gateTimedOut(batch, 60_000, '/data/logs/gate/b.log'),
    'push rejected': shipCards.pushRejected(batch, 'rejected: non-fast-forward'),
    'push timed out': shipCards.pushTimedOut(batch, 60_000),
    network: shipCards.network(batch, 'gh pr create', new Error('connection reset')),
    'gh not installed': shipCards.network(batch, 'gh pr create', new GhError('not_installed', 'x')),
    'gh signed out': shipCards.network(batch, 'gh pr create', new GhError('signed_out', 'x')),
  };

  // Each offers Retry and Abandon, which the Inbox card shows as buttons over the ship and abandon routes.
  it.each(Object.entries(failures))('%s offers Retry and Abandon of its batch', (_name, f) => {
    expect(f.card.detail).toMatchObject({ batchId: batch.id, actions: ['retry', 'abandon'] });
  });
});

describe('the cards that say why a checkout stays on its branch', () => {
  const shipped = { ...batch, state: 'SHIPPED' as const, worktreePath: null };
  it.each([
    {
      name: 'a plain path and branch',
      repoPath: '/Users/me/app',
      place: { branch: 'main', sha: 'b'.repeat(40) },
      command: "git -C '/Users/me/app' switch 'main'",
    },
    {
      name: 'a detached commit',
      repoPath: '/Users/me/app',
      place: { branch: null, sha: 'b'.repeat(40) },
      command: `git -C '/Users/me/app' switch --detach '${'b'.repeat(40)}'`,
    },
    {
      name: 'a path with a space, which is never left to the shell to split',
      repoPath: '/Users/me/My App',
      place: { branch: 'main', sha: 'b'.repeat(40) },
      command: 'git switch run in `/Users/me/My App`, naming `main`',
    },
  ])('$name', ({ repoPath, place, command }) => {
    const card = checkoutCards.dirty(shipped, { name: 'App', repoPath }, place, ['a.ts']);
    expect(card.body).toContain(command);
    expect(card.body).not.toContain(`-C ${repoPath}`);
  });
});

describe('the card for a pull request not updated after the base merged', () => {
  const gateStop = { kind: 'gate' as const, name: 'pre-check' as const, logPath: null };

  it('names the files 10db settled itself', () => {
    const card = prCards.catchUpStopped(batch, {
      ...gateStop,
      settled: ['apps/daemon/src/api/app.ts', 'apps/daemon/src/api/services.ts'],
    });
    expect(card.title).toBe(
      'Pull request for "Greetings" not updated: the pre-check failed after merging main',
    );
    expect(card.body).toContain('10db settled these files itself');
    expect(card.body).toContain('apps/daemon/src/api/app.ts');
    expect(card.body).toContain('apps/daemon/src/api/services.ts');
  });

  it('says nothing of settled files when 10db settled none', () => {
    expect(prCards.catchUpStopped(batch, gateStop).body).not.toContain('settled');
    expect(prCards.catchUpStopped(batch, { ...gateStop, settled: [] }).body).not.toContain(
      'settled',
    );
  });
});
