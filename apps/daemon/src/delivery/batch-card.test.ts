import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictError, InboxKind, mintId, type BatchId, type WorkstreamId } from '@10db/contracts';
import {
  getBatch,
  getEvidence,
  getInboxItem,
  getWorkstream,
  insertToolOp,
  listEvidence,
  listToolOps,
  listWorkstreams,
  setTaskStatus,
  setWorkstreamNotice,
  transitionBatch,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createInboxService, type InboxService } from '../inbox';
import {
  afterMarkersResolved,
  commitResultAsStored,
  insertPlannedWorkstream,
  planForStart,
  retryWorkstream,
} from '../team';
import { leftOutCards } from './cards';
import { raise } from './context';
import { batchCardFields, createBatchCardAnswers } from './index';
import { leftOutNotices } from './notices';

let h: DeliveryHarness;
let inbox: InboxService;

/** The inbox the builder answers through, with the card's answers wired to `h`. */
function answering(): InboxService {
  return createInboxService({
    state: h.state,
    onParkedAnswer: () => undefined,
    onFlagAnswer: createBatchCardAnswers({
      retry: (id, note) => {
        retryWorkstream(h.state, id, note);
      },
      shipper: h.shipper,
    }),
  });
}

beforeEach(() => {
  h = createDeliveryHarness();
  inbox = answering();
});
afterEach(() => {
  h.close();
});

/** Records `path` as a commit `workstreamId` made through the commit tool. */
function commitAs(workstreamId: WorkstreamId, path: string, content: string): string {
  const sha = h.commit(path, content);
  h.state.write((w) => {
    insertToolOp(w, {
      workstreamId,
      sessionId: mintId('Session'),
      opId: `op-${path}-${sha}`,
      tool: 'commit',
      result: { sha, alreadyCommitted: false },
    });
  });
  return sha;
}

/**
 * Commits `path` for `workstreamId` and stores the result as the commit tool does, from the branch.
 * `gettingThroughGate` is what the tool read from the run's record: a failed gate run was outstanding.
 * The tool also reads whether a resolution of markers came before with no gate run or note after it, and
 * so does this, from the run's tool ops and evidence.
 */
async function commitAsTheToolRecords(
  workstreamId: WorkstreamId,
  path: string,
  content: string,
  gettingThroughGate = false,
): Promise<string> {
  const sha = h.commit(path, content);
  const result = await commitResultAsStored(h.git, h.repo, { sha, alreadyCommitted: false }, null, {
    throughGate: gettingThroughGate,
    afterResolution: afterMarkersResolved(
      listToolOps(h.store.db, workstreamId, 'commit'),
      listEvidence(h.store.db, workstreamId),
    ),
  });
  h.state.write((w) => {
    insertToolOp(w, {
      workstreamId,
      sessionId: mintId('Session'),
      opId: `op-${path}-${sha}`,
      tool: 'commit',
      result,
    });
  });
  return sha;
}

/** What 10db's base merge commits to the branch for a session to resolve. */
const MARKED_README = '<<<<<<< HEAD\n# ours\n||||||| base\n=======\n# theirs\n>>>>>>> main\n';

/** The failed card the runner raises for a run in a batch. */
function failedCard(workstreamId: WorkstreamId, batchId: BatchId) {
  const fields = batchCardFields({ id: workstreamId, batchId });
  if (!fields) throw new Error('a batch member gets card actions');
  return inbox.flag({
    tier: 'ask',
    urgency: 'high',
    closesWhen: { by: 'answer' },
    projectId: h.project.id,
    workstreamId,
    title: 'Workstream failed',
    body: 'The review step rejected the work',
    ...fields,
  });
}

/** A batch of Alpha and Beta, both failed with commits, and Gamma, done. */
async function twoFailedInBatch() {
  const tasks = [h.addTask('Alpha'), h.addTask('Beta'), h.addTask('Gamma', { areas: ['ui'] })];
  const started = h.only(
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: tasks.map((t) => t.id) }),
  );
  await h.jobs.idle();
  const [a, b, c] = listWorkstreams(h.store.db, { batchId: started.id });
  if (!a || !b || !c) throw new Error('three workstreams expected');
  commitAs(a.id, 'src/api/alpha.txt', 'alpha\n');
  commitAs(b.id, 'src/api/beta.txt', 'beta\n');
  h.commit('src/ui/gamma.txt');
  h.settle(c.id, 'DONE');
  h.settle(a.id, 'FAILED');
  h.settle(b.id, 'FAILED');
  return { batchId: started.id, alpha: a.id, beta: b.id, betaTask: b.taskId };
}

/**
 * Alpha finished with a commit and the shipping gate sent it to merge in the same batch, where that
 * second run failed at its limit, having committed `merged`. Beta is done.
 */
async function failedInItsMerge(merged: (run: WorkstreamId) => void, batchTitle = 'Greetings') {
  const alpha = h.addTask('Alpha');
  const other = h.addTask('Beta', { areas: ['ui'] });
  const started = h.only(
    h.starter.startBatch(h.project.id, { title: batchTitle, taskIds: [alpha.id, other.id] }),
  );
  await h.jobs.idle();
  const [a, b] = listWorkstreams(h.store.db, { batchId: started.id });
  if (!a || !b) throw new Error('two workstreams expected');
  commitAs(a.id, 'src/api/alpha.txt', 'alpha\n');
  h.commit('src/ui/beta.txt');
  h.settle(a.id, 'DONE');
  const merge = h.state.write((w) => {
    setTaskStatus(w, alpha.id, 'open');
    return insertPlannedWorkstream(w, alpha.id, planForStart(w.tx, alpha.id), started.id);
  });
  merged(merge.id);
  h.settle(merge.id, 'FAILED');
  h.settle(b.id, 'DONE');
  return { batchId: started.id, merge: merge.id, card: failedCard(merge.id, started.id) };
}

/**
 * A batch of Alpha (failed, with its card) and Beta (left in `beta`), with one commit on its branch.
 * `alphaFiles` are commits Alpha made through the commit tool, before Beta's.
 */
async function failedInBatch(
  beta: 'WAITING_HUMAN' | 'DONE' | 'CANCELLED',
  alphaFiles: Record<string, string> = {},
  batchTitle = 'Greetings',
) {
  const alpha = h.addTask('Alpha');
  const other = h.addTask('Beta', { areas: ['ui'] });
  const started = h.only(
    h.starter.startBatch(h.project.id, {
      title: batchTitle,
      taskIds: [alpha.id, other.id],
    }),
  );
  await h.jobs.idle();
  const [a, b] = listWorkstreams(h.store.db, { batchId: started.id });
  if (!a || !b) throw new Error('two workstreams expected');
  for (const [path, content] of Object.entries(alphaFiles)) {
    const sha = h.commit(path, content);
    h.state.write((w) => {
      insertToolOp(w, {
        workstreamId: a.id,
        sessionId: mintId('Session'),
        opId: `op-${path}`,
        tool: 'commit',
        result: { sha, alreadyCommitted: false },
      });
    });
  }
  h.commit('src/ui/beta.txt');
  h.settle(b.id, beta);
  h.settle(a.id, 'FAILED');
  const fields = batchCardFields({ id: a.id, batchId: started.id });
  if (!fields) throw new Error('a batch member gets card actions');
  const card = inbox.flag({
    tier: 'ask',
    urgency: 'high',
    closesWhen: { by: 'answer' },
    projectId: h.project.id,
    workstreamId: a.id,
    title: 'Workstream failed: Alpha',
    body: 'The gate failed 4 times',
    ...fields,
  });
  return { batchId: started.id, failed: a.id, card };
}

describe('the failed workstream card', () => {
  it('does nothing for Later, leaves other flag cards alone, and retries the workstream, reopening a failed batch', async () => {
    const { card, batchId, failed } = await failedInBatch('DONE');
    expect(inbox.answer(card.id, { choice: 'Later' }).state).toBe('RESOLVED');
    expect(getWorkstream(h.store.db, failed).state).toBe('FAILED');
    expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
    const plain = inbox.flag({
      tier: 'ask',
      urgency: 'high',
      closesWhen: { by: 'answer' },
      projectId: h.project.id,
      workstreamId: null,
      title: 'FYI',
      body: '',
    });
    expect(plain.kind).toBe(InboxKind.Flag);
    expect(inbox.answer(plain.id, { choice: 'dismiss' }).state).toBe('RESOLVED');

    h.state.write((c) =>
      transitionBatch(c, batchId, { to: 'FAILED', patch: { failure: 'gate_failed' } }),
    );
    expect(inbox.answer(failedCard(failed, batchId).id, { choice: 'Retry' }).state).toBe(
      'RESOLVED',
    );
    expect(getWorkstream(h.store.db, failed).state).toBe('QUEUED');
    expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
  });

  it('refuses Ship anyway and Ship without it while other work is unfinished, keeping the card open, then ships', async () => {
    const { card, batchId } = await failedInBatch('WAITING_HUMAN');
    expect(() => inbox.answer(card.id, { choice: 'Ship without it' })).toThrow(
      /still has unfinished work: Beta \(waiting_human\)/,
    );
    expect(getInboxItem(h.store.db, card.id).state).toBe('OPEN');
    expect(() => inbox.answer(card.id, { choice: 'Ship anyway' })).toThrow(ConflictError);
    expect(getInboxItem(h.store.db, card.id).state).toBe('OPEN');
    const beta = listWorkstreams(h.store.db, { batchId }).find((w) => w.state === 'WAITING_HUMAN');
    if (!beta) throw new Error('Beta waits');
    h.settle(beta.id, 'DONE');
    expect(inbox.answer(card.id, { choice: 'Ship anyway' }).state).toBe('RESOLVED');
    await h.jobs.idle();
    expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
  });

  it('refuses Ship anyway in a failed batch with unfinished work instead of reopening it, then ships', async () => {
    const { card, batchId } = await failedInBatch('WAITING_HUMAN');
    h.state.write((c) =>
      transitionBatch(c, batchId, { to: 'FAILED', patch: { failure: 'wrong_branch' } }),
    );
    expect(() => inbox.answer(card.id, { choice: 'Ship anyway' })).toThrow(
      /still has unfinished work: Beta \(waiting_human\)/,
    );
    expect(getInboxItem(h.store.db, card.id).state).toBe('OPEN');
    expect(getBatch(h.store.db, batchId)).toMatchObject({
      state: 'FAILED',
      failure: 'wrong_branch',
    });
    const beta = listWorkstreams(h.store.db, { batchId }).find((w) => w.state === 'WAITING_HUMAN');
    if (!beta) throw new Error('Beta waits');
    h.settle(beta.id, 'DONE');
    expect(inbox.answer(card.id, { choice: 'Ship anyway' }).state).toBe('RESOLVED');
    await h.jobs.idle();
    expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
  });

  describe('Ship without it', () => {
    it('opens a pull request with every other task’s changes and none of the failed one’s, from one revert commit naming it', async () => {
      const { card, batchId, failed } = await failedInBatch('DONE', {
        'src/api/alpha-1.txt': 'one\n',
        'src/api/alpha-2.txt': 'two\n',
      });
      expect(inbox.answer(card.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
      await h.jobs.idle();

      const shipped = getBatch(h.store.db, batchId);
      expect(shipped.state).toBe('SHIPPED');
      const branch = shipped.branch ?? '';
      expect(h.origin$('diff', '--name-only', 'main', branch)).toBe('src/ui/beta.txt');
      const subjects = h
        .origin$('log', '--format=%s', `main..${branch}`)
        .split('\n')
        .filter((s) => s.startsWith('revert'));
      expect(subjects).toEqual(['revert: leave out "Alpha"']);
      expect(h.git$('status', '--porcelain', '--untracked-files=all')).toBe('');

      // The task's drawer says so; the pull request's body leaves its work out of "What and why".
      const alpha = getWorkstream(h.store.db, failed);
      expect(alpha.notice).toMatchObject({
        key: 'left-out',
        line: 'Left out of the pull request: its 2 commits were reverted',
      });
      const body = h.gh.body(shipped.prUrl ?? '');
      expect(body).toContain('- Alpha (failed, left out of this pull request)');
      expect(body).not.toContain('### Alpha');
    });

    it('is offered with Retry, Ship anyway and Later only for a workstream in a batch, and ships the rest, with no revert commit, when the failed task committed nothing', async () => {
      const { card, batchId, failed } = await failedInBatch('DONE');
      expect(card.options.map((o) => o.label)).toEqual([
        'Retry',
        'Ship anyway',
        'Ship without it',
        'Later',
      ]);
      expect(card.detail).toEqual({ batchCard: { batchId, workstreamId: failed } });
      expect(batchCardFields({ id: failed, batchId: null })).toBeNull();

      expect(inbox.answer(card.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
      await h.jobs.idle();

      const shipped = getBatch(h.store.db, batchId);
      expect(shipped.state).toBe('SHIPPED');
      expect(h.origin$('log', '--format=%s', `main..${shipped.branch ?? ''}`)).toBe(
        'Add src/ui/beta.txt',
      );
      expect(getWorkstream(h.store.db, failed).notice?.line).toBe(
        'Left out of the pull request: it had no commits to revert',
      );
    });

    it('ships nothing and raises a card naming the files when the revert conflicts, which the batch’s abandon closes', async () => {
      const { card, batchId, failed } = await failedInBatch('DONE', {
        'src/api/shared.txt': 'alpha\n',
      });
      // Beta built on Alpha's file, so undoing Alpha's commit can't be done cleanly.
      h.commit('src/api/shared.txt', 'alpha\nbeta\n');
      const tip = h.git$('rev-parse', 'HEAD');

      expect(inbox.answer(card.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
      await h.jobs.idle();

      expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
      expect(h.gh.prCreates()).toEqual([]);
      expect(h.git$('rev-parse', 'HEAD')).toBe(tip);
      expect(getWorkstream(h.store.db, failed).notice).toBeNull();
      const conflict = h.only(h.cards().filter((c) => c.title.includes('conflict')));
      expect(conflict.title).toBe('Alpha was not left out: reverting its commits conflicts');
      expect(conflict.body).toContain('- src/api/shared.txt');
      expect(conflict.body).toMatch(/Nothing was shipped/);

      h.shipper.abandon(batchId);
      expect(getInboxItem(h.store.db, conflict.id).state).not.toBe('OPEN');
    });

    it('ships nothing and says so when uncommitted changes are in a file the revert writes, then offers Ship without it again, which ships with no failed-task file', async () => {
      const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
      writeFileSync(join(h.repo, 'src/api/alpha.txt'), 'edited\n');
      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();

      expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
      expect(h.gh.prCreates()).toEqual([]);
      const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
      expect(stopped.body).toContain('- src/api/alpha.txt');
      expect(stopped.body).toMatch(/uncommitted/i);
      expect(stopped.options.map((o) => o.label)).toEqual([
        'Retry',
        'Ship anyway',
        'Ship without it',
        'Later',
      ]);
      expect(stopped.body).not.toMatch(/ship again/i);
      expect(stopped.body).toMatch(/answer Ship without it/);

      writeFileSync(join(h.repo, 'src/api/alpha.txt'), 'alpha\n');
      expect(inbox.answer(stopped.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
      await h.jobs.idle();

      const shipped = getBatch(h.store.db, batchId);
      expect(shipped.state).toBe('SHIPPED');
      expect(h.origin$('diff', '--name-only', 'main', shipped.branch ?? '')).toBe(
        'src/ui/beta.txt',
      );
    });

    it('leaves out every failed task in one revert commit naming them, with a superseded attempt’s commits, clears its notice, and closes the other’s card', async () => {
      const { batchId, alpha, beta, betaTask } = await twoFailedInBatch();
      const alphaCard = failedCard(alpha, batchId);
      const betaCard = failedCard(beta, batchId);
      h.state.write((w) => {
        insertPlannedWorkstream(w, betaTask, planForStart(w.tx, betaTask), null);
      });
      h.shipper.checkBatch(batchId);
      expect(h.only(getBatch(h.store.db, batchId).notices).key).toBe('superseded-attempt');

      expect(inbox.answer(alphaCard.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
      await h.jobs.idle();

      const shipped = getBatch(h.store.db, batchId);
      expect(shipped.state).toBe('SHIPPED');
      const branch = shipped.branch ?? '';
      expect(h.origin$('diff', '--name-only', 'main', branch)).toBe('src/ui/gamma.txt');
      const subjects = h
        .origin$('log', '--format=%s', `main..${branch}`)
        .split('\n')
        .filter((s) => s.startsWith('revert'));
      expect(subjects).toEqual(['revert: leave out "Alpha", "Beta"']);
      for (const id of [alpha, beta])
        expect(getWorkstream(h.store.db, id).notice).toMatchObject({
          key: 'left-out',
          line: 'Left out of the pull request: its commit was reverted',
        });
      const body = h.gh.body(shipped.prUrl ?? '');
      expect(body).toContain('- Alpha (failed, left out of this pull request)');
      expect(body).toContain('- Beta (failed, left out of this pull request)');
      expect(getInboxItem(h.store.db, betaCard.id).state).toBe('CANCELLED');
      expect(shipped.notices).toEqual([]);
    });

    it('reverts the commits of every run the task made in the batch, its merge run’s too', async () => {
      const { card, batchId } = await failedInItsMerge((run) => {
        commitAs(run, 'src/api/alpha-merge.txt', 'merge\n');
      });

      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();

      const shipped = getBatch(h.store.db, batchId);
      expect(shipped.state).toBe('SHIPPED');
      expect(h.origin$('diff', '--name-only', 'main', shipped.branch ?? '')).toBe(
        'src/ui/beta.txt',
      );
    });

    it('reverts a commit a session’s own message says was reverted, is not stopped by a revert listing a commit the repository does not hold, and reports what it undid', async () => {
      const made = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
      // A revert carried in from the base, whose listed commits have since been pruned.
      h.git$(
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        `revert: leave out "Old"\n\n- ${'a'.repeat(40)} (Old)`,
      );
      const committed = h.git$('log', '--format=%H', '-1', '--', 'src/api/alpha.txt');
      writeFileSync(join(h.repo, 'src/api/note.txt'), 'note\n');
      // Through the same path as the commit tool, which passes a session's message through.
      const forged = await h.git.commit({
        repo: h.repo,
        paths: ['src/api/note.txt'],
        message: `revert: leave out "Alpha"\n\n- ${committed} (Alpha)`,
        opId: 'op-forged-revert',
        branch: getBatch(h.store.db, made.batchId).branch ?? '',
      });
      h.state.write((w) => {
        insertToolOp(w, {
          workstreamId: made.failed,
          sessionId: mintId('Session'),
          opId: 'op-forged-revert',
          tool: 'commit',
          result: { sha: forged.sha, alreadyCommitted: false },
        });
      });

      inbox.answer(made.card.id, { choice: 'Ship without it' });
      await h.jobs.idle();

      const shipped = getBatch(h.store.db, made.batchId);
      expect(shipped.state).toBe('SHIPPED');
      expect(h.origin$('diff', '--name-only', 'main', shipped.branch ?? '')).toBe(
        'src/ui/beta.txt',
      );
      const notice = getWorkstream(h.store.db, made.failed).notice;
      expect(notice?.line).toMatch(/its 2 commits were reverted/);
      expect(notice?.body).not.toContain(forged.sha);
      expect(notice?.body).not.toContain('a'.repeat(40));
    });

    it('ships nothing and raises a card when the revert would bring conflict markers back', async () => {
      const { card, batchId, merge } = await failedInItsMerge((run) => {
        h.commit('src/api/merged.txt', '<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n');
        commitAs(run, 'src/api/merged.txt', 'a\nb\n');
      });
      const tip = h.git$('rev-parse', 'HEAD');

      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();

      expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
      expect(h.gh.prCreates()).toEqual([]);
      expect(h.git$('rev-parse', 'HEAD')).toBe(tip);
      expect(getWorkstream(h.store.db, merge).notice).toBeNull();
      const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
      expect(stopped.title).toBe('Alpha was not left out: its commits resolved conflict markers');
      expect(stopped.body).toContain('- src/api/merged.txt');
      expect(stopped.options.map((o) => o.label)).toContain('Ship without it');
    });

    describe('when it stops between the answer and the job', () => {
      it('raises a card saying a waiting update paused the ship, and offers the answer again', async () => {
        let draining = false;
        h.close();
        h = createDeliveryHarness({}, { holdShips: () => draining });
        inbox = answering();
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
        const tip = h.git$('rev-parse', 'HEAD');

        expect(inbox.answer(card.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
        draining = true;
        await h.jobs.idle();

        expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
        expect(h.git$('rev-parse', 'HEAD')).toBe(tip);
        const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
        expect(stopped.title).toMatch(/waiting update/);
        expect(stopped.body).toMatch(/Nothing was shipped and the branch is unchanged/);
        expect(stopped.options.map((o) => o.label)).toContain('Ship without it');

        draining = false;
        expect(inbox.answer(stopped.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
        await h.jobs.idle();
        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
      });

      it('raises a card when the batch moved on, with no answer to give', async () => {
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
        inbox.answer(card.id, { choice: 'Ship without it' });
        h.state.write((w) =>
          transitionBatch(w, batchId, { to: 'ABANDONED', reason: 'abandoned by a test' }),
        );
        await h.jobs.idle();

        const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
        expect(stopped.title).toMatch(/abandoned/);
        expect(stopped.options).toEqual([]);
      });

      it('raises a card when the daemon was stopping before the job began', async () => {
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.stop();

        expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
        const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
        expect(stopped.title).toMatch(/stopping/);
        expect(stopped.options.map((o) => o.label)).toContain('Ship without it');
      });

      it('raises no card for a second answer the first one already carried out', async () => {
        const { batchId, alpha, beta } = await twoFailedInBatch();
        const alphaCard = failedCard(alpha, batchId);
        const betaCard = failedCard(beta, batchId);

        expect(inbox.answer(alphaCard.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
        expect(inbox.answer(betaCard.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
        await h.jobs.idle();

        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
        for (const id of [alpha, beta])
          expect(getWorkstream(h.store.db, id).notice?.key).toBe('left-out');
        expect(h.cards().filter((c) => c.title.includes('was not left out'))).toEqual([]);
      });
    });

    describe('when the batch moves on during a job with nothing to revert', () => {
      /** A harness that runs `harness.moveOn` once, in the job, after its first await. */
      function movingOn() {
        const harness = { moveOn: (): void => undefined };
        h.close();
        h = createDeliveryHarness(
          {},
          {
            wrapGit: (git) => ({
              ...git,
              currentBranch: async (repo) => {
                const current = await git.currentBranch(repo);
                const { moveOn } = harness;
                harness.moveOn = () => undefined;
                moveOn();
                return current;
              },
            }),
          },
        );
        inbox = answering();
        return harness;
      }

      it('raises a card naming the state, with no answer to give', async () => {
        const harness = movingOn();
        const { card, batchId } = await failedInBatch('DONE');
        const tip = h.git$('rev-parse', 'HEAD');
        harness.moveOn = () => {
          h.state.write((w) =>
            transitionBatch(w, batchId, { to: 'ABANDONED', reason: 'abandoned by a test' }),
          );
        };

        expect(inbox.answer(card.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
        await h.jobs.idle();

        expect(h.git$('rev-parse', 'HEAD')).toBe(tip);
        const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
        expect(stopped.title).toMatch(/the batch is abandoned/);
        expect(stopped.options).toEqual([]);
      });

      it('raises no card when the run was left out already and the batch went on to ship', async () => {
        const harness = movingOn();
        const { card, batchId, failed } = await failedInBatch('DONE');
        h.state.write((w) => setWorkstreamNotice(w, failed, leftOutNotices.nothingToRevert()));
        harness.moveOn = () => {
          h.state.write((w) => transitionBatch(w, batchId, { to: 'SHIPPING', reason: 'a test' }));
        };

        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        expect(h.cards().filter((c) => c.title.includes('was not left out'))).toEqual([]);
      });
    });

    describe('once the revert commit is on the branch', () => {
      /** A harness whose revert runs `after` once the real one has committed. */
      function revertThen(after: () => void) {
        h.close();
        h = createDeliveryHarness(
          {},
          {
            wrapGit: (git) => ({
              ...git,
              revertCommits: async (request) => {
                const reverted = await git.revertCommits(request);
                after();
                return reverted;
              },
            }),
          },
        );
        inbox = answering();
      }

      it('writes the notice and moves the batch when the daemon began stopping during the revert', async () => {
        revertThen(() => {
          void h.jobs.stop();
        });
        const { card, batchId, failed } = await failedInBatch('DONE', {
          'src/api/alpha.txt': 'alpha\n',
        });

        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        // The revert is on the branch, so the batch moved and the drawer says why; the ship itself
        // is what a restart resumes from SHIPPING.
        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPING');
        expect(getWorkstream(h.store.db, failed).notice?.key).toBe('left-out');
      });

      it('offers Ship without it again when the write threw, and that answer reverts nothing more', async () => {
        const reverts: string[] = [];
        h.close();
        h = createDeliveryHarness(
          {},
          {
            wrapGit: (git) => ({
              ...git,
              revertCommits: async (request) => {
                const before = h.git$('rev-parse', 'HEAD');
                const reverted = await git.revertCommits(request);
                reverts.push(reverted.kind);
                // The second request finds the first one's revert on the tip and changes nothing.
                if (reverts.length === 2) expect(h.git$('rev-parse', 'HEAD')).toBe(before);
                if (reverts.length === 1)
                  vi.spyOn(h.state, 'write').mockImplementationOnce(() => {
                    throw new Error('database is locked');
                  });
                return reverted;
              },
            }),
          },
        );
        inbox = answering();
        const { card, batchId, failed } = await failedInBatch('DONE', {
          'src/api/alpha.txt': 'alpha\n',
        });

        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(stopped.options.map((o) => o.label)).toContain('Ship without it');
        expect(stopped.body).not.toMatch(/do not answer Ship without it again|twice/i);
        expect(stopped.body).toMatch(/Ship without it again.* nothing more/i);
        expect(stopped.detail).toMatchObject({
          resolvesWhen: { event: 'batch_shipped', batchId },
        });

        expect(inbox.answer(stopped.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
        await h.jobs.idle();

        // The second answer leaves the reverted commits out of its work, so git is not asked again.
        expect(reverts).toEqual(['reverted']);
        expect(getWorkstream(h.store.db, failed).notice?.key).toBe('left-out');
        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
        expect(getInboxItem(h.store.db, stopped.id).state).not.toBe('OPEN');
      });

      const failNextWrite = (message: string): void => {
        vi.spyOn(h.state, 'write').mockImplementationOnce(() => {
          throw new Error(message);
        });
      };

      /**
       * A harness that records each revert asked of git, and whose first revert's state write throws.
       * `failJobWrite` makes the next job's state write throw, whether or not it reverts anything.
       */
      function revertsWithFailedWrite(ship: Parameters<typeof createDeliveryHarness>[1] = {}) {
        const asked: (readonly string[])[] = [];
        const armed = { job: false };
        h.close();
        h = createDeliveryHarness(
          {},
          {
            ...ship,
            wrapGit: (git) => ({
              ...git,
              currentBranch: async (repo) => {
                if (armed.job) failNextWrite('database is still locked');
                armed.job = false;
                return git.currentBranch(repo);
              },
              revertCommits: async (request) => {
                asked.push(request.shas);
                const reverted = await git.revertCommits(request);
                if (asked.length === 1) failNextWrite('database is locked');
                return reverted;
              },
            }),
          },
        );
        inbox = answering();
        return {
          asked,
          failJobWrite: () => {
            armed.job = true;
          },
        };
      }

      it('reverts only the commits the first revert does not cover', async () => {
        const { asked } = revertsWithFailedWrite();
        const { card, batchId, failed } = await failedInBatch('DONE', {
          'src/api/alpha.txt': 'one\n',
        });
        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();
        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));
        const later = commitAs(failed, 'src/api/later.txt', 'later\n');

        inbox.answer(stopped.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        expect(asked).toHaveLength(2);
        expect(asked[1]).toEqual([later]);
        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
        // Newest first, on the batch's branch: the ship may have left the checkout on another.
        const reverts = h.git$('log', '--all', '--grep=leave out', '--format=%H').split('\n');
        expect(reverts).toHaveLength(2);
        const notice = getWorkstream(h.store.db, failed).notice;
        expect(notice?.body).toContain(`Revert commit: ${reverts[0] ?? ''}`);
        // Both of its commits are undone: the first revert's and this one's.
        expect(notice?.line).toMatch(/its 2 commits were reverted/);
      });

      it('keeps the revert on the card when the second answer stops as well, then moves a run with two commits on one file past the next answer', async () => {
        const { failJobWrite } = revertsWithFailedWrite();
        const { card, batchId, failed } = await failedInBatch('DONE', {
          'src/api/alpha.txt': 'one\n',
        });
        commitAs(failed, 'src/api/alpha.txt', 'two\n');
        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();
        const revert = h.git$('rev-parse', 'HEAD');
        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));

        failJobWrite();
        inbox.answer(stopped.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
        const again = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(again.body).toContain(revert.slice(0, 9));
        expect(again.body).toContain('database is still locked');
        expect(again.body).not.toMatch(/branch is unchanged/);

        inbox.answer(again.id, { choice: 'Ship without it' });
        await h.jobs.idle();
        expect(h.cards().filter((c) => c.title.includes('conflict'))).toEqual([]);
        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
        const notice = getWorkstream(h.store.db, failed).notice;
        expect(notice?.key).toBe('left-out');
        expect(notice?.line).toMatch(/its 2 commits were reverted/);
        expect(notice?.body).toContain(`Revert commit: ${revert}`);
        expect(notice?.body).not.toMatch(/no commits|reverted nothing/);
      });

      describe('while the revert card is open', () => {
        it('keeps the revert on the card a stopped answer on another failed card raises, and does not revert commits again when the next one is answered', async () => {
          const { asked, failJobWrite } = revertsWithFailedWrite();
          const made = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
          inbox.answer(made.card.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const revert = h.git$('rev-parse', 'HEAD');
          h.only(h.cards().filter((c) => c.title.includes('revert')));
          expect(getWorkstream(h.store.db, made.failed).notice).toBeNull();

          // The failed card of the same run as it stood before the revert: it names no revert.
          failJobWrite();
          inbox.answer(failedCard(made.failed, made.batchId).id, { choice: 'Ship without it' });
          await h.jobs.idle();

          const folded = h.only(h.cards().filter((c) => c.title.includes('revert')));
          expect(folded.detail).toMatchObject({ batchCard: { revert } });

          inbox.answer(failedCard(made.failed, made.batchId).id, { choice: 'Ship without it' });
          await h.jobs.idle();

          expect(asked).toHaveLength(1);
          expect(getBatch(h.store.db, made.batchId).state).toBe('SHIPPED');
          expect(getWorkstream(h.store.db, made.failed).notice?.body).toContain(
            `Revert commit: ${revert}`,
          );
        });

        it('reverts a finished task’s commit the revert did not undo when its merge run fails after it', async () => {
          const { asked } = revertsWithFailedWrite();
          const made = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
          const [, beta] = listWorkstreams(h.store.db, { batchId: made.batchId });
          if (!beta) throw new Error('Beta expected');
          // Beta finished with this commit before the revert, which does not touch it.
          const finished = commitAs(beta.id, 'src/ui/beta-done.txt', 'done\n');
          inbox.answer(made.card.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const first = h.git$('rev-parse', 'HEAD');
          expect(asked).toHaveLength(1);
          const merge = h.state.write((w) => {
            setTaskStatus(w, beta.taskId, 'open');
            return insertPlannedWorkstream(
              w,
              beta.taskId,
              planForStart(w.tx, beta.taskId),
              made.batchId,
            );
          });
          h.settle(merge.id, 'FAILED');
          // Beta's task has a failed run now, so another task has to be the one that finished.
          const gamma = h.addTask('Gamma', { areas: ['ui'] });
          const gammaRun = h.state.write((w) =>
            insertPlannedWorkstream(w, gamma.id, planForStart(w.tx, gamma.id), made.batchId),
          );
          h.settle(gammaRun.id, 'DONE');
          const plain = batchCardFields({ id: merge.id, batchId: made.batchId });
          if (!plain) throw new Error('a batch member gets card actions');
          const other = inbox.flag({
            tier: 'ask',
            urgency: 'high',
            closesWhen: { by: 'answer' },
            projectId: h.project.id,
            workstreamId: merge.id,
            title: 'Workstream failed: Beta',
            body: 'The merge failed',
            ...plain,
          });

          inbox.answer(other.id, { choice: 'Ship without it' });
          await h.jobs.idle();

          // Alpha's commit is covered by the first revert; Beta's is not, so only it is reverted now.
          expect(asked).toHaveLength(2);
          expect(asked[1]).toEqual([finished]);
          const shipped = getBatch(h.store.db, made.batchId);
          expect(shipped.state).toBe('SHIPPED');
          expect(h.origin$('diff', '--name-only', 'main', shipped.branch ?? '')).toBe(
            'src/ui/beta.txt',
          );
          const mergeNotice = getWorkstream(h.store.db, merge.id).notice;
          expect(mergeNotice?.line).toMatch(/its commit was reverted/);
          expect(mergeNotice?.body).not.toContain(first);
          expect(getWorkstream(h.store.db, made.failed).notice?.body).toContain(
            `Revert commit: ${first}`,
          );
        });

        it('gets past commits that built on each other when the revert is on no card', async () => {
          const { asked } = revertsWithFailedWrite();
          const made = await failedInBatch('DONE', { 'src/api/alpha.txt': 'one\n' });
          commitAs(made.failed, 'src/api/alpha.txt', 'two\n');
          inbox.answer(made.card.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const revert = h.git$('rev-parse', 'HEAD');
          // The card holding the revert is closed, so no answer carries its id.
          const open = h.only(h.cards().filter((c) => c.title.includes('revert')));
          inbox.answer(open.id, { choice: 'Later' });
          const plain = batchCardFields({ id: made.failed, batchId: made.batchId });
          if (!plain) throw new Error('a batch member gets card actions');
          const other = inbox.flag({
            tier: 'ask',
            urgency: 'high',
            closesWhen: { by: 'answer' },
            projectId: h.project.id,
            workstreamId: made.failed,
            title: 'Workstream failed: Alpha again',
            body: 'The gate failed 4 times',
            ...plain,
          });

          inbox.answer(other.id, { choice: 'Ship without it' });
          await h.jobs.idle();

          expect(h.cards().filter((c) => c.title.includes('conflict'))).toEqual([]);
          expect(asked).toHaveLength(1);
          expect(getBatch(h.store.db, made.batchId).state).toBe('SHIPPED');
          const notice = getWorkstream(h.store.db, made.failed).notice;
          expect(notice?.line).toMatch(/its 2 commits were reverted/);
          expect(notice?.body).toContain(`Revert commit: ${revert}`);
        });

        it('closes the card when an answer on another card writes the notices', async () => {
          revertsWithFailedWrite({
            shipGate: (gate) => ({
              run: async (request) => ({ ...(await gate.run(request)), exitCode: 1 }),
            }),
          });
          const made = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
          inbox.answer(made.card.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const open = h.only(h.cards().filter((c) => c.title.includes('revert')));

          inbox.answer(failedCard(made.failed, made.batchId).id, { choice: 'Ship without it' });
          await h.jobs.idle();

          expect(getBatch(h.store.db, made.batchId).state).toBe('FAILED');
          expect(getInboxItem(h.store.db, open.id).state).not.toBe('OPEN');
        });
      });

      it('reverts as usual when the revert the card names is no longer on the branch', async () => {
        const { batchId, failed } = await failedInBatch('DONE', {
          'src/api/alpha.txt': 'alpha\n',
        });
        raise(
          inbox,
          h.project.id,
          leftOutCards.revertKept(
            getBatch(h.store.db, batchId),
            { workstreamId: failed, titles: ['Alpha'] },
            'a'.repeat(40),
            'a test',
            'OPEN',
          ),
        );
        const stale = h.only(h.cards().filter((c) => c.title.includes('revert')));

        inbox.answer(stale.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
        const notice = getWorkstream(h.store.db, failed).notice;
        expect(notice?.body).not.toContain('a'.repeat(40));
        expect(notice?.line).toMatch(/its commit was reverted/);
      });

      describe('when the second answer stops before it reverts anything', () => {
        /** The revert-kept card of a first answer whose write failed, and that revert's commit id. */
        async function keptCard() {
          revertsWithFailedWrite();
          const made = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
          inbox.answer(made.card.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const revert = h.git$('rev-parse', 'HEAD');
          const kept = h.only(h.cards().filter((c) => c.title.includes('revert')));
          return { ...made, revert, kept };
        }

        /** What a card that says the revert is on the branch holds, whichever stop raised it. */
        function expectNamesRevert(card: { body: string; detail: unknown }, revert: string): void {
          expect(card.body).not.toMatch(/branch is unchanged/);
          expect(card.body).toContain(revert.slice(0, 9));
          expect(card.body).not.toMatch(/put the commits of/);
          expect(card.detail).toMatchObject({ batchCard: { revert } });
        }

        it('names the revert when the daemon is stopping, on an answerable card the batch’s abandon closes', async () => {
          const { kept, revert, batchId } = await keptCard();
          expect(kept.options.map((o) => o.label)).toContain('Ship without it');

          inbox.answer(kept.id, { choice: 'Ship without it' });
          await h.jobs.stop();

          expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
          const stopped = h.only(h.cards().filter((c) => c.title.includes('stopping')));
          expectNamesRevert(stopped, revert);
          expect(stopped.options.map((o) => o.label)).toContain('Ship without it');

          h.shipper.abandon(batchId);

          expect(getInboxItem(h.store.db, stopped.id).state).not.toBe('OPEN');
          expect(h.cards().filter((c) => c.title.includes('revert'))).toEqual([]);
        });
      });

      it('withdraws the other failed tasks’ cards when the write threw', async () => {
        revertThen(() => {
          vi.spyOn(h.state, 'write').mockImplementationOnce(() => {
            throw new Error('database is locked');
          });
        });
        const { batchId, alpha, beta } = await twoFailedInBatch();
        const alphaCard = failedCard(alpha, batchId);
        const betaCard = failedCard(beta, batchId);

        inbox.answer(alphaCard.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        expect(getInboxItem(h.store.db, betaCard.id).state).not.toBe('OPEN');
        const open = h.cards().filter((c) => c.title.includes('revert'));
        expect(h.only(open).options.map((o) => o.label)).toContain('Ship without it');
      });

      it('offers Ship without it again on the card it waited on when that ship fails, or reopens the batch for a merge', async () => {
        const ships: [string, Parameters<typeof createDeliveryHarness>[1], 'FAILED' | 'OPEN'][] = [
          [
            'the gate fails',
            {
              shipGate: (gate) => ({
                run: async (request) => ({ ...(await gate.run(request)), exitCode: 1 }),
              }),
            },
            'FAILED',
          ],
          [
            'the base update reopens the batch for a merge',
            {
              shipBaseUpdates: (real) => ({
                ...real,
                beforeGate: () =>
                  Promise.resolve({
                    kind: 'conflicted',
                    base: 'origin/main',
                    paths: ['README.md'],
                    note: 'Conflict markers in README.md',
                  }),
              }),
            },
            'OPEN',
          ],
        ];
        for (const [name, ship, state] of ships) {
          let batch: BatchId | null = null;
          h.close();
          h = createDeliveryHarness(
            {},
            {
              ...ship,
              wrapGit: (git) => ({
                ...git,
                revertCommits: async (request) => {
                  const reverted = await git.revertCommits(request);
                  if (batch === null) throw new Error('batch unset');
                  const id = batch;
                  h.state.write((w) =>
                    transitionBatch(w, id, { to: 'SHIPPING', reason: 'a test' }),
                  );
                  return reverted;
                },
              }),
            },
          );
          inbox = answering();
          const { card, batchId } = await failedInBatch('DONE', {
            'src/api/alpha.txt': 'alpha\n',
          });
          batch = batchId;
          inbox.answer(card.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const revert = h.git$('rev-parse', 'HEAD');
          const waiting = h.only(h.cards().filter((c) => c.title.includes('revert')));
          expect.soft(waiting.options, `${name}: no answer while it waits`).toEqual([]);

          h.shipper.resume(batchId);
          await h.jobs.idle();

          expect.soft(getBatch(h.store.db, batchId).state, `${name}: batch state`).toBe(state);
          const again = h.only(h.cards().filter((c) => c.title.includes('revert')));
          expect.soft(again.id, `${name}: the same card`).toBe(waiting.id);
          expect.soft(again.body, `${name}: body`).not.toMatch(/nothing to answer/i);
          expect
            .soft(
              again.options.map((o) => o.label),
              `${name}: options`,
            )
            .toContain('Ship without it');
          if (state === 'FAILED') {
            expect
              .soft(
                again.options.map((o) => o.label),
                `${name}: options`,
              )
              .toEqual(['Ship anyway', 'Ship without it', 'Later']);
            expect
              .soft(again.detail, `${name}: detail`)
              .toMatchObject({ batchCard: { batchId, revert } });
            expect
              .soft(again.detail, `${name}: resolves when`)
              .toMatchObject({ resolvesWhen: { event: 'batch_shipped', batchId } });
          }
        }
      });

      describe('when the builder abandons the batch while the answer runs', () => {
        /** A harness whose `revert`th revert abandons the batch and then answers `stop`. */
        function abandonsDuringRevert(
          stop: () => Awaited<ReturnType<DeliveryHarness['git']['revertCommits']>>,
          revert = 1,
        ) {
          const on: { batchId: BatchId | null; reverts: number } = { batchId: null, reverts: 0 };
          h.close();
          h = createDeliveryHarness(
            {},
            {
              wrapGit: (git) => ({
                ...git,
                revertCommits: async (request) => {
                  on.reverts += 1;
                  if (on.reverts !== revert) {
                    const reverted = await git.revertCommits(request);
                    failNextWrite('database is locked');
                    return reverted;
                  }
                  if (on.batchId === null) throw new Error('batch unset');
                  h.shipper.abandon(on.batchId);
                  return stop();
                },
              }),
            },
          );
          inbox = answering();
          return on;
        }

        it('raises no card offering an answer on a stop by a conflict, markers, a blocked revert or a thrown error', async () => {
          const stops: [string, Parameters<typeof abandonsDuringRevert>[0]][] = [
            ['conflict', () => ({ kind: 'conflict', paths: ['src/api/alpha.txt'] }) as const],
            ['markers', () => ({ kind: 'markers', paths: ['src/api/alpha.txt'] }) as const],
            ['blocked', () => ({ kind: 'blocked', changed: ['src/api/alpha.txt'] }) as const],
            [
              'a thrown error',
              () => {
                throw new Error('git broke');
              },
            ],
          ];
          for (const [name, stop] of stops) {
            const on = abandonsDuringRevert(stop);
            const { card, batchId } = await failedInBatch('DONE', {
              'src/api/alpha.txt': 'alpha\n',
            });
            on.batchId = batchId;

            inbox.answer(card.id, { choice: 'Ship without it' });
            await h.jobs.idle();

            expect.soft(getBatch(h.store.db, batchId).state, `${name}: batch`).toBe('ABANDONED');
            const stopped = h.only(h.cards().filter((c) => c.title.includes('not left out')));
            expect.soft(stopped.title, `${name}: title`).toMatch(/abandoned/);
            expect
              .soft(stopped.body, `${name}: body`)
              .not.toMatch(/answer Ship without it|Ship anyway/);
            expect.soft(stopped.options, `${name}: options`).toEqual([]);
            expect.soft(stopped.detail, `${name}: detail`).toBeNull();
          }
        });
      });
    });

    it('lets a batch reopened after a left-out run ship by itself once the rest is done', async () => {
      const { batchId, failed } = await failedInBatch('WAITING_HUMAN');
      h.state.write((w) => setWorkstreamNotice(w, failed, leftOutNotices.nothingToRevert()));
      const beta = listWorkstreams(h.store.db, { batchId }).find(
        (w) => w.state === 'WAITING_HUMAN',
      );
      if (!beta) throw new Error('Beta waits');

      h.settle(beta.id, 'DONE');
      h.shipper.checkBatch(batchId);
      await h.jobs.idle();

      expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
    });

    it('takes the left-out notice off a run that is retried, so the pull request counts its work', async () => {
      let gateFails = true;
      h.close();
      h = createDeliveryHarness(
        {},
        {
          shipGate: (gate) => ({
            run: async (request) => {
              const result = await gate.run(request);
              return gateFails ? { ...result, exitCode: 1 } : result;
            },
          }),
        },
      );
      inbox = answering();
      const { card, batchId, failed } = await failedInBatch('DONE', {
        'src/api/alpha.txt': 'alpha\n',
      });
      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();
      expect(getBatch(h.store.db, batchId).state).toBe('FAILED');
      expect(getWorkstream(h.store.db, failed).notice?.key).toBe('left-out');

      gateFails = false;
      retryWorkstream(h.state, failed);
      // No longer left out, but the revert is still on the branch, so the run says so.
      expect(getWorkstream(h.store.db, failed).notice?.key).toBe('reverted-work');
      commitAs(failed, 'src/api/alpha.txt', 'alpha again\n');

      h.settle(failed, 'DONE');
      h.shipper.checkBatch(batchId);
      await h.jobs.idle();
      const shipped = getBatch(h.store.db, batchId);
      expect(shipped.state).toBe('SHIPPED');
      const body = h.gh.body(shipped.prUrl ?? '');
      expect(body).toContain('### Alpha');
      expect(body).not.toContain('left out');
    });

    describe('a left-out run that is retried after its commits were reverted', () => {
      /** While set, the ship's gate fails, so a Ship without it leaves the batch FAILED. */
      let gateFails = false;

      /** Ships without Alpha, then retries it with the batch's gate passing; returns what the retry left. */
      async function leftOutThenRetried() {
        gateFails = true;
        h.close();
        h = createDeliveryHarness(
          {},
          {
            shipGate: (gate) => ({
              run: async (request) => {
                const result = await gate.run(request);
                return gateFails ? { ...result, exitCode: 1 } : result;
              },
            }),
          },
        );
        inbox = answering();
        const { card, batchId, failed } = await failedInBatch('DONE', {
          'src/api/alpha.txt': 'alpha\n',
        });
        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();
        expect(getWorkstream(h.store.db, failed).notice?.key).toBe('left-out');
        gateFails = false;
        retryWorkstream(h.state, failed);
        return { batchId, failed };
      }

      /** The paths the shipped batch's branch holds. */
      function branchFiles(batchId: BatchId): string[] {
        const branch = getBatch(h.store.db, batchId).branch;
        if (branch === null) throw new Error('the batch has a branch');
        return h.git$('ls-tree', '-r', '--name-only', branch).split('\n');
      }

      /**
       * Alpha left out with its notices written, then its retry commits `path` and fails again, so the
       * next answer has that commit to revert. Returns what Ship without it was left with.
       */
      async function retryFailedWith(path: string) {
        const { batchId, failed } = await leftOutThenRetried();
        const again = commitAs(failed, path, 'again\n');
        h.settle(failed, 'FAILED');
        return { batchId, failed, again };
      }

      it('keeps the ordinary card when reverting a retried run’s new commit conflicts', async () => {
        const { batchId, failed } = await retryFailedWith('src/ui/again.txt');
        // Another lane builds on its file, so reverting the new commit conflicts.
        h.commit('src/ui/again.txt', 'built on\n');

        inbox.answer(failedCard(failed, batchId).id, { choice: 'Ship without it' });
        await h.jobs.idle();

        // The revert is on the run's record already, and the new commit is not undone by it.
        const card = h.only(h.cards().filter((c) => c.title.includes('conflicts')));
        expect(card.options.map((o) => o.label)).toContain('Retry');
        expect(JSON.stringify(card.detail)).not.toContain('"revert"');
        expect(card.body).toContain('Ship anyway would put the commits of "Alpha"');
        expect(getBatch(h.store.db, batchId).state).not.toBe('SHIPPED');
      });

      it('does not call a recorded revert unfinished when the next revert cannot run', async () => {
        const { batchId, failed } = await retryFailedWith('src/ui/again.txt');
        h.commit('src/ui/again.txt', 'built on\n');
        const revertCommits = vi
          .spyOn(h.git, 'revertCommits')
          .mockRejectedValue(new Error('is a merge or a first commit'));

        inbox.answer(failedCard(failed, batchId).id, { choice: 'Ship without it' });
        await h.jobs.idle();

        expect(revertCommits).toHaveBeenCalledOnce();
        expect(h.cards().filter((c) => c.title.includes('the revert is on the branch'))).toEqual(
          [],
        );
        const card = h.only(h.cards().filter((c) => c.title.includes('not left out')));
        expect(card.options.map((o) => o.label)).toContain('Retry');
      });

      it('tells the session its commits were reverted, and does not list the task as finished when the retry commits nothing', async () => {
        const { batchId, failed } = await leftOutThenRetried();

        const next = getWorkstream(h.store.db, failed).nextAction;
        if (next.kind !== 'fix') throw new Error(`expected a fix, got ${next.kind}`);
        const note = getEvidence(h.store.db, next.evidenceId);
        expect(note.kind).toBe('builder');
        expect(note.summary).toMatch(/reverted/i);
        expect(note.summary).toMatch(/Ship without it/);
        expect(note.summary).toMatch(/[0-9a-f]{40}/);

        h.settle(failed, 'DONE');
        h.shipper.checkBatch(batchId);
        await h.jobs.idle();

        const shipped = getBatch(h.store.db, batchId);
        expect(shipped.state).toBe('SHIPPED');
        // The diff has none of Alpha's work, so the body must not say it is done.
        expect(branchFiles(batchId)).not.toContain('src/api/alpha.txt');
        const body = h.gh.body(shipped.prUrl ?? '');
        expect(body).not.toContain('### Alpha');
        expect(body).toMatch(/Alpha \(done, .*reverted/);
        expect(body).toContain('### Beta');
      });

      it('does not list the task as finished when its only new commit resolves conflict markers of its own gate’s base merge', async () => {
        const { batchId, failed } = await leftOutThenRetried();

        // The same run, not a new one, is queued to merge when its gate's base merge leaves markers.
        h.commit('README.md', MARKED_README);
        await commitAsTheToolRecords(failed, 'README.md', '# ours and theirs\n');
        h.settle(failed, 'DONE');
        h.shipper.checkBatch(batchId);
        await h.jobs.idle();

        const shipped = getBatch(h.store.db, batchId);
        expect(shipped.state).toBe('SHIPPED');
        expect(branchFiles(batchId)).toContain('README.md');
        expect(branchFiles(batchId)).not.toContain('src/api/alpha.txt');
        const body = h.gh.body(shipped.prUrl ?? '');
        expect(body).not.toContain('### Alpha');
        expect(body).toMatch(/Alpha \(done, .*reverted/);
        expect(body).toContain('### Beta');
      });
    });

    it('refuses when no other task finished, since nothing would be left to ship', async () => {
      const { card } = await failedInBatch('CANCELLED');
      expect(() => inbox.answer(card.id, { choice: 'Ship without it' })).toThrow(ConflictError);
      expect(() => inbox.answer(card.id, { choice: 'Ship without it' })).toThrow(
        /no other task in batch "Greetings" finished/,
      );
      expect(getInboxItem(h.store.db, card.id).state).toBe('OPEN');
    });
  });
});
