import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictError, InboxKind, mintId, type BatchId, type WorkstreamId } from '@10db/contracts';
import {
  getBatch,
  getEvidence,
  getInboxItem,
  getWorkstream,
  insertToolOp,
  listWorkstreams,
  setTaskStatus,
  setWorkstreamNotice,
  transitionBatch,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createInboxService, type InboxService } from '../inbox';
import { insertPlannedWorkstream, planForStart, retryWorkstream } from '../team';
import { leftOutCards } from './cards';
import { raise } from './context';
import { batchCardFields, createBatchCardAnswers } from './index';
import { leftOutNotices } from './notices';

let h: DeliveryHarness;
let inbox: InboxService;
let retries: { id: string; note: string | undefined }[];

/** The inbox the builder answers through, with the card's answers wired to `h`. */
function answering(): InboxService {
  return createInboxService({
    state: h.state,
    onParkedAnswer: () => undefined,
    onFlagAnswer: createBatchCardAnswers({
      retry: (id, note) => {
        retries.push({ id, note });
        retryWorkstream(h.state, id, note);
      },
      shipper: h.shipper,
    }),
  });
}

beforeEach(() => {
  retries = [];
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

/** The failed card the runner raises for a run in a batch. */
function failedCard(workstreamId: WorkstreamId, batchId: BatchId) {
  const fields = batchCardFields({ id: workstreamId, batchId });
  if (!fields) throw new Error('a batch member gets card actions');
  return inbox.flag({
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
async function failedInItsMerge(merged: (run: WorkstreamId) => void) {
  const alpha = h.addTask('Alpha');
  const other = h.addTask('Beta', { areas: ['ui'] });
  const started = h.only(
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [alpha.id, other.id] }),
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
    projectId: h.project.id,
    workstreamId: a.id,
    title: 'Workstream failed: Alpha',
    body: 'The gate failed 4 times',
    ...fields,
  });
  return { batchId: started.id, failed: a.id, card };
}

describe('the failed workstream card', () => {
  it('offers Retry, Ship anyway and Later only for a workstream in a batch', async () => {
    const { card, batchId, failed } = await failedInBatch('DONE');
    expect(card.options.map((o) => o.label)).toEqual([
      'Retry',
      'Ship anyway',
      'Ship without it',
      'Later',
    ]);
    expect(card.detail).toEqual({ batchCard: { batchId, workstreamId: failed } });
    expect(batchCardFields({ id: failed, batchId: null })).toBeNull();
  });

  it('says beside Ship anyway that the failed task’s commits will be in the pull request', async () => {
    const { card } = await failedInBatch('DONE');
    const describe = (label: string) => card.options.find((o) => o.label === label)?.description;
    expect(describe('Ship anyway')).toMatch(/its commits will be in the pull request/i);
    expect(describe('Ship without it')).toMatch(/reverts its commits on the batch branch/i);
    expect(describe('Ship without it')).toMatch(/every other task that failed .* is left out too/i);
  });

  it('retries the workstream, reopening a failed batch', async () => {
    const { card, batchId, failed } = await failedInBatch('DONE');
    h.state.write((c) =>
      transitionBatch(c, batchId, { to: 'FAILED', patch: { failure: 'gate_failed' } }),
    );
    expect(inbox.answer(card.id, { choice: 'Retry' }).state).toBe('RESOLVED');
    expect(getWorkstream(h.store.db, failed).state).toBe('QUEUED');
    expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
  });

  it.each([
    {
      name: 'a typed note',
      answer: { choice: 'Retry', note: 'Reuse the card.' },
      note: 'Reuse the card.',
    },
    { name: 'no note', answer: { choice: 'Retry' }, note: undefined },
    { name: 'a blank note', answer: { choice: 'Retry', note: '  ' }, note: undefined },
  ])('hands the retry $name', async ({ answer, note }) => {
    const { card, failed } = await failedInBatch('DONE');
    inbox.answer(card.id, answer);
    expect(retries).toEqual([{ id: failed, note }]);
  });

  it('refuses Ship anyway while other work is unfinished, keeping the card open, then ships', async () => {
    const { card, batchId } = await failedInBatch('WAITING_HUMAN');
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

    it('does not title the pull request after the task it left out', async () => {
      const { card, batchId } = await failedInBatch('DONE', {}, 'Alpha');
      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();
      expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
      expect(h.gh.prCreates().map((c) => c.title)).toEqual(['feat(app): beta']);
    });

    it('keeps the batch’s title when it is not the left-out task’s name', async () => {
      const { card } = await failedInBatch('DONE');
      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();
      expect(h.gh.prCreates().map((c) => c.title)).toEqual(['feat(app): greetings']);
    });

    it('keeps a batch named after the failed task when Ship anyway puts its commits in', async () => {
      const { card } = await failedInBatch('DONE', {}, 'Alpha');
      inbox.answer(card.id, { choice: 'Ship anyway' });
      await h.jobs.idle();
      expect(h.gh.prCreates().map((c) => c.title)).toEqual(['feat(app): alpha']);
    });

    it('ships the rest, with no revert commit, when the failed task committed nothing', async () => {
      const { card, batchId, failed } = await failedInBatch('DONE');
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

    it('ships nothing and raises a card naming the files when the revert conflicts', async () => {
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
    });

    it('ships nothing and says so when uncommitted changes are in a file the revert writes', async () => {
      const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
      writeFileSync(join(h.repo, 'src/api/alpha.txt'), 'edited\n');

      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();

      expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
      expect(h.gh.prCreates()).toEqual([]);
      const blocked = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
      expect(blocked.body).toContain('- src/api/alpha.txt');
      expect(blocked.body).toMatch(/uncommitted/i);
    });

    it('offers Ship without it again on the card of a stopped revert, which ships with no failed-task file', async () => {
      const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
      writeFileSync(join(h.repo, 'src/api/alpha.txt'), 'edited\n');
      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();
      const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
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

    it('says to answer it again on the conflict card too, never to ship again', async () => {
      const { card } = await failedInBatch('DONE', { 'src/api/shared.txt': 'alpha\n' });
      h.commit('src/api/shared.txt', 'alpha\nbeta\n');
      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();
      const conflict = h.only(h.cards().filter((c) => c.title.includes('conflict')));
      expect(conflict.options.map((o) => o.label)).toContain('Ship without it');
      expect(conflict.body).not.toMatch(/ship again/i);
    });

    it('leaves out every failed task in one revert commit naming them, and closes the other’s card', async () => {
      const { batchId, alpha, beta } = await twoFailedInBatch();
      const alphaCard = failedCard(alpha, batchId);
      const betaCard = failedCard(beta, batchId);

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
    });

    it('leaves out a superseded attempt’s commits with the failed task’s, and clears its notice', async () => {
      const { batchId, alpha, betaTask } = await twoFailedInBatch();
      h.state.write((w) => {
        insertPlannedWorkstream(w, betaTask, planForStart(w.tx, betaTask), null);
      });
      h.shipper.checkBatch(batchId);
      expect(h.only(getBatch(h.store.db, batchId).notices).key).toBe('superseded-attempt');

      inbox.answer(failedCard(alpha, batchId).id, { choice: 'Ship without it' });
      await h.jobs.idle();

      const shipped = getBatch(h.store.db, batchId);
      expect(shipped.state).toBe('SHIPPED');
      expect(h.origin$('diff', '--name-only', 'main', shipped.branch ?? '')).toBe(
        'src/ui/gamma.txt',
      );
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

      it('does not say the branch is unchanged when Ship anyway got there first', async () => {
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
        inbox.answer(card.id, { choice: 'Ship without it' });
        h.shipper.shipAnyway(batchId);
        await h.jobs.idle();

        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
        const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
        expect(stopped.title).toMatch(/the batch is shipping/);
        expect(stopped.body).toMatch(/Ship without it changed nothing/);
        expect(stopped.body).not.toMatch(/Nothing was shipped|branch is unchanged/);
        expect(stopped.options).toEqual([]);
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

      it('says the revert is on the branch when the state write throws', async () => {
        const revertedAt: { sha: string } = { sha: 'unset' };
        revertThen(() => {
          revertedAt.sha = h.git$('rev-parse', 'HEAD');
          vi.spyOn(h.state, 'write').mockImplementationOnce(() => {
            throw new Error('database is locked');
          });
        });
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });

        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(stopped.title).toMatch(/revert is on the branch/i);
        expect(stopped.body).toContain(revertedAt.sha.slice(0, 9));
        expect(stopped.body).toContain('database is locked');
        expect(stopped.body).not.toMatch(/branch is unchanged/);
      });

      it('says the revert is on the branch when the batch moved on before the write', async () => {
        let batch: string | null = null;
        revertThen(() => {
          if (batch === null) throw new Error('batch unset');
          h.state.write((w) =>
            transitionBatch(w, batch as BatchId, { to: 'ABANDONED', reason: 'a test' }),
          );
        });
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
        batch = batchId;

        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(stopped.title).toMatch(/revert is on the branch/i);
        expect(stopped.body).not.toMatch(/branch is unchanged/);
      });

      it('shows its own title and offers no answer when a left-out card was open already', async () => {
        revertThen(() => {
          vi.spyOn(h.state, 'write').mockImplementationOnce(() => {
            throw new Error('database is locked');
          });
        });
        const { card, batchId, failed } = await failedInBatch('DONE', {
          'src/api/alpha.txt': 'alpha\n',
        });
        // Another failed task's Ship without it stopped on a conflict and left its card open.
        raise(
          inbox,
          h.project.id,
          leftOutCards.conflict(
            getBatch(h.store.db, batchId),
            { workstreamId: failed, titles: ['Gamma'] },
            ['src/api/gamma.txt'],
          ),
        );
        const open = h.only(h.cards().filter((c) => c.title.includes('conflicts')));
        expect(open.options.map((o) => o.label)).toContain('Ship without it');

        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(stopped.id).toBe(open.id);
        expect(stopped.title).toMatch(/revert is on the branch/i);
        expect(stopped.options).toEqual([]);
        expect(h.cards().filter((c) => c.title.includes('conflicts'))).toEqual([]);
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
      /** While set, the ship's base update answers that the merge left markers. */
      let baseConflicts = false;
      /** While set, the ship's gate fails, so a Ship without it leaves the batch FAILED. */
      let gateFails = false;

      /**
       * Ships without Alpha, then retries it with the batch's gate passing; returns what the retry left.
       * `failing` makes the failed run, Alpha's first by default.
       */
      async function leftOutThenRetried(
        failing: () => ReturnType<typeof failedInBatch> = () =>
          failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' }),
        retry = true,
      ) {
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
            // Only a batch in its own copy merges its base, and these commits are in the shared
            // checkout, so the update's answer stands in for that merge.
            shipBaseUpdates: (real) => ({
              ...real,
              beforeGate: (id, signal, options) =>
                baseConflicts
                  ? Promise.resolve({
                      kind: 'conflicted',
                      base: 'origin/main',
                      paths: ['README.md'],
                      note: 'Conflict markers in README.md',
                    })
                  : real.beforeGate(id, signal, options),
            }),
          },
        );
        inbox = answering();
        const { card, batchId, failed } = await failing();
        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();
        expect(getWorkstream(h.store.db, failed).notice?.key).toBe('left-out');
        gateFails = false;
        if (retry) retryWorkstream(h.state, failed);
        return { batchId, failed };
      }

      /**
       * Starts the failed run's task over, as Start with fresh does in a shared project: the batch holds
       * Beta too, so it is kept, and the new run joins it. Returns the new run.
       */
      async function startedOver(batchId: BatchId, failed: WorkstreamId) {
        const taskId = getWorkstream(h.store.db, failed).taskId;
        h.starter.startTask(taskId);
        await h.jobs.idle();
        const run = listWorkstreams(h.store.db, { batchId }).at(-1);
        if (!run || run.id === failed || run.taskId !== taskId)
          throw new Error('the new run joined the batch');
        return run.id;
      }

      /** The revert a run's left-out notice names. */
      function revertNamedBy(run: WorkstreamId): string {
        const notice = getWorkstream(h.store.db, run).notice;
        expect(notice?.key).toBe('left-out');
        const sha = /^Revert commit: ([0-9a-f]+)$/m.exec(notice?.body ?? '')?.[1];
        if (sha === undefined) throw new Error('the notice names a revert');
        return sha;
      }

      /**
       * Alpha left out, retried and told of that revert, then its new commit left out too, with the
       * ship's gate failing so the batch stays FAILED and open to a start. Returns both reverts.
       */
      async function leftOutTwice() {
        const { batchId, failed } = await leftOutThenRetried();
        const first = getWorkstream(h.store.db, failed).notice?.body ?? '';
        commitAs(failed, 'src/api/alpha-again.txt', 'alpha again\n');
        h.settle(failed, 'FAILED');
        gateFails = true;
        inbox.answer(failedCard(failed, batchId).id, { choice: 'Ship without it' });
        await h.jobs.idle();
        gateFails = false;
        expect(getBatch(h.store.db, batchId).state).toBe('FAILED');
        const latest = revertNamedBy(failed);
        expect(first).not.toContain(latest);
        return { batchId, failed, latest };
      }

      /** The paths the shipped batch's branch holds. */
      function branchFiles(batchId: BatchId): string[] {
        const branch = getBatch(h.store.db, batchId).branch;
        if (branch === null) throw new Error('the batch has a branch');
        return h.git$('ls-tree', '-r', '--name-only', branch).split('\n');
      }

      /**
       * Finishes the retried run with the branch and the base changing one line, so the ship's base
       * merge leaves markers and sends the task that just finished to merge; returns that new run.
       */
      async function finishedThenSentToMerge(batchId: BatchId, retried: WorkstreamId) {
        baseConflicts = true;
        h.settle(retried, 'DONE');
        h.shipper.checkBatch(batchId);
        await h.jobs.idle();
        baseConflicts = false;
        expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
        const merge = listWorkstreams(h.store.db, { batchId }).at(-1);
        if (!merge) throw new Error('the batch has runs');
        expect(merge.id).not.toBe(retried);
        expect(merge.taskTitle).toBe('Alpha');
        expect(merge.nextAction.kind).toBe('merge');
        return merge.id;
      }

      /** The merge run commits the resolution and finishes, and the batch ships; returns the pull request body. */
      async function resolvedAndShipped(batchId: BatchId, merge: WorkstreamId) {
        commitAs(merge, 'README.md', '# ours and theirs\n');
        h.settle(merge, 'DONE');
        h.shipper.checkBatch(batchId);
        await h.jobs.idle();
        const shipped = getBatch(h.store.db, batchId);
        expect(shipped.state).toBe('SHIPPED');
        return h.gh.body(shipped.prUrl ?? '');
      }

      it('tells the session its commits were reverted', async () => {
        const { failed } = await leftOutThenRetried();

        const next = getWorkstream(h.store.db, failed).nextAction;
        if (next.kind !== 'fix') throw new Error(`expected a fix, got ${next.kind}`);
        const note = getEvidence(h.store.db, next.evidenceId);
        expect(note.kind).toBe('builder');
        expect(note.summary).toMatch(/reverted/i);
        expect(note.summary).toMatch(/Ship without it/);
        expect(note.summary).toMatch(/[0-9a-f]{40}/);
      });

      it('does not list the task as finished when the retry commits nothing', async () => {
        const { batchId, failed } = await leftOutThenRetried();

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

      it('still leaves the task out when a wait replaced the run’s notice', async () => {
        const { batchId, failed } = await leftOutThenRetried();
        h.state.write((w) =>
          setWorkstreamNotice(w, failed, {
            key: 'claim-wait',
            tone: 'info',
            line: 'Waiting for a claim',
            body: 'Another task holds it.',
          }),
        );

        h.settle(failed, 'DONE');
        h.shipper.checkBatch(batchId);
        await h.jobs.idle();

        const body = h.gh.body(getBatch(h.store.db, batchId).prUrl ?? '');
        expect(body).not.toContain('### Alpha');
        expect(body).toMatch(/Alpha \(done, .*reverted/);
      });

      it('lists the task as finished when the retry commits again', async () => {
        const { batchId, failed } = await leftOutThenRetried();
        commitAs(failed, 'src/api/alpha.txt', 'alpha again\n');

        h.settle(failed, 'DONE');
        h.shipper.checkBatch(batchId);
        await h.jobs.idle();

        const shipped = getBatch(h.store.db, batchId);
        expect(shipped.state).toBe('SHIPPED');
        expect(branchFiles(batchId)).toContain('src/api/alpha.txt');
        const body = h.gh.body(shipped.prUrl ?? '');
        expect(body).toContain('### Alpha');
        expect(body).not.toMatch(/reverted/);
      });

      it('does not list the task as finished when its only new commit is a merge run’s resolution', async () => {
        const { batchId, failed } = await leftOutThenRetried();

        const merge = await finishedThenSentToMerge(batchId, failed);
        const body = await resolvedAndShipped(batchId, merge);

        // The branch has the resolution, and none of Alpha's own work.
        expect(branchFiles(batchId)).not.toContain('src/api/alpha.txt');
        expect(body).not.toContain('### Alpha');
        expect(body).toMatch(/Alpha \(done, .*reverted/);
        expect(body).toContain('### Beta');
      });

      it('still lists the task as finished when it committed again before it was sent to merge', async () => {
        const { batchId, failed } = await leftOutThenRetried();
        commitAs(failed, 'src/api/alpha.txt', 'alpha again\n');

        const merge = await finishedThenSentToMerge(batchId, failed);
        const body = await resolvedAndShipped(batchId, merge);

        expect(branchFiles(batchId)).toContain('src/api/alpha.txt');
        expect(body).toContain('### Alpha');
        expect(body).not.toMatch(/reverted/);
      });

      describe('and started over in the same batch', () => {
        it('tells the new run’s session the commits were reverted', async () => {
          const { batchId, failed } = await leftOutThenRetried(undefined, false);
          const run = await startedOver(batchId, failed);

          const next = getWorkstream(h.store.db, run).nextAction;
          if (next.kind !== 'fix') throw new Error(`expected a fix, got ${next.kind}`);
          const note = getEvidence(h.store.db, next.evidenceId);
          expect(note.kind).toBe('builder');
          expect(note.summary).toMatch(/reverted/i);
          expect(note.summary).toMatch(/[0-9a-f]{40}/);
        });

        it('does not list the task as finished when the new run commits nothing, though the old run was never retried', async () => {
          const { batchId, failed } = await leftOutThenRetried(undefined, false);
          const run = await startedOver(batchId, failed);

          h.settle(run, 'DONE');
          h.shipper.checkBatch(batchId);
          await h.jobs.idle();

          const shipped = getBatch(h.store.db, batchId);
          expect(shipped.state).toBe('SHIPPED');
          expect(branchFiles(batchId)).not.toContain('src/api/alpha.txt');
          const body = h.gh.body(shipped.prUrl ?? '');
          expect(body).not.toContain('### Alpha');
          expect(body).toMatch(/Alpha \(done, .*reverted/);
        });

        it('lists the task as finished when the new run commits the work again', async () => {
          const { batchId, failed } = await leftOutThenRetried(undefined, false);
          const run = await startedOver(batchId, failed);
          commitAs(run, 'src/api/alpha.txt', 'alpha again\n');

          h.settle(run, 'DONE');
          h.shipper.checkBatch(batchId);
          await h.jobs.idle();

          const shipped = getBatch(h.store.db, batchId);
          expect(shipped.state).toBe('SHIPPED');
          expect(branchFiles(batchId)).toContain('src/api/alpha.txt');
          const body = h.gh.body(shipped.prUrl ?? '');
          expect(body).toContain('### Alpha');
          expect(body).not.toMatch(/reverted/);
        });

        it('lists the task as finished when an earlier retry left a note and the new run redoes the work', async () => {
          const { batchId, failed } = await leftOutThenRetried();
          h.settle(failed, 'FAILED');
          const run = await startedOver(batchId, failed);
          commitAs(run, 'src/api/alpha.txt', 'alpha again\n');

          h.settle(run, 'DONE');
          h.shipper.checkBatch(batchId);
          await h.jobs.idle();

          const shipped = getBatch(h.store.db, batchId);
          expect(shipped.state).toBe('SHIPPED');
          expect(branchFiles(batchId)).toContain('src/api/alpha.txt');
          const body = h.gh.body(shipped.prUrl ?? '');
          expect(body).toContain('### Alpha');
          expect(body).not.toMatch(/reverted/);
        });

        it('reads the latest revert when a retried run was left out again, and commits nothing', async () => {
          const { batchId, failed, latest } = await leftOutTwice();
          const run = await startedOver(batchId, failed);

          const next = getWorkstream(h.store.db, run).nextAction;
          if (next.kind !== 'fix') throw new Error(`expected a fix, got ${next.kind}`);
          expect(getEvidence(h.store.db, next.evidenceId).summary).toContain(latest);

          h.settle(run, 'DONE');
          h.shipper.checkBatch(batchId);
          await h.jobs.idle();

          const shipped = getBatch(h.store.db, batchId);
          expect(shipped.state).toBe('SHIPPED');
          expect(branchFiles(batchId)).not.toContain('src/api/alpha-again.txt');
          const body = h.gh.body(shipped.prUrl ?? '');
          expect(body).not.toContain('### Alpha');
          expect(body).toMatch(/Alpha \(done, .*reverted/);
        });

        it('lists the task as finished when a run started after the second revert commits the work', async () => {
          const { batchId, failed } = await leftOutTwice();
          const run = await startedOver(batchId, failed);
          commitAs(run, 'src/api/alpha-third.txt', 'alpha third\n');

          h.settle(run, 'DONE');
          h.shipper.checkBatch(batchId);
          await h.jobs.idle();

          const shipped = getBatch(h.store.db, batchId);
          expect(shipped.state).toBe('SHIPPED');
          expect(branchFiles(batchId)).toContain('src/api/alpha-third.txt');
          const body = h.gh.body(shipped.prUrl ?? '');
          expect(body).toContain('### Alpha');
          expect(body).not.toMatch(/reverted/);
        });
      });

      it('counts a merge run’s commit when that run was the one left out, retried and told to redo the work', async () => {
        const { batchId, failed } = await leftOutThenRetried(async () => {
          const {
            batchId: id,
            merge,
            card,
          } = await failedInItsMerge((run) => {
            commitAs(run, 'src/api/alpha.txt', 'alpha merged\n');
          });
          return { batchId: id, failed: merge, card };
        });
        commitAs(failed, 'src/api/alpha.txt', 'alpha again\n');

        h.settle(failed, 'DONE');
        h.shipper.checkBatch(batchId);
        await h.jobs.idle();

        const shipped = getBatch(h.store.db, batchId);
        expect(shipped.state).toBe('SHIPPED');
        expect(branchFiles(batchId)).toContain('src/api/alpha.txt');
        const body = h.gh.body(shipped.prUrl ?? '');
        expect(body).toContain('### Alpha');
        expect(body).not.toMatch(/reverted/);
      });
    });

    it('never calls a finished run left out, whatever notice it still carries', async () => {
      const { batchId, failed } = await failedInBatch('DONE');
      h.state.write((w) => setWorkstreamNotice(w, failed, leftOutNotices.nothingToRevert()));
      h.settle(failed, 'DONE');
      h.shipper.checkBatch(batchId);
      await h.jobs.idle();

      const body = h.gh.body(getBatch(h.store.db, batchId).prUrl ?? '');
      expect(body).toContain('### Alpha');
      expect(body).not.toContain('left out');
    });

    it('refuses while other work is unfinished, keeping the card open', async () => {
      const { card } = await failedInBatch('WAITING_HUMAN');
      expect(() => inbox.answer(card.id, { choice: 'Ship without it' })).toThrow(
        /still has unfinished work: Beta \(waiting_human\)/,
      );
      expect(getInboxItem(h.store.db, card.id).state).toBe('OPEN');
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

  it('does nothing for Later, and leaves other flag cards alone', async () => {
    const { card, batchId, failed } = await failedInBatch('DONE');
    expect(inbox.answer(card.id, { choice: 'Later' }).state).toBe('RESOLVED');
    expect(getWorkstream(h.store.db, failed).state).toBe('FAILED');
    expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
    const plain = inbox.flag({
      projectId: h.project.id,
      workstreamId: null,
      title: 'FYI',
      body: '',
    });
    expect(plain.kind).toBe(InboxKind.Flag);
    expect(inbox.answer(plain.id, { choice: 'dismiss' }).state).toBe('RESOLVED');
  });
});
