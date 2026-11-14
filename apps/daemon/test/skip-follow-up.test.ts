import { ConflictError, InboxKind, type WorkstreamId } from '@10db/contracts';
import {
  approvedSkipsForTask,
  getTask,
  getWorkstream,
  listInbox,
  pendingSkipFollowUps,
  recordSkip,
  skipFollowUpOf,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { raiseSkippedCard, SKIPPED_DETAIL, SkippedChoice } from '../src/delivery';
import { createGit } from '../src/git';
import { silentLogger } from '../src/log';
import type { FakeScriptBook, LaneSessionSpec } from '../src/sessions';
import { createTestEngine, type TestEngine } from './engine';

// T4 Task 10: Run these now starts one follow-up with exactly the listed calls approved, and the
// source and its follow-up never run at once.

type FakeStep = FakeScriptBook[string][number][number];

let engine: TestEngine;
afterEach(async () => {
  await engine.close();
});

const turn: FakeStep = { do: 'turn_complete' };
const blocked: FakeStep[] = [
  { do: 'tool', toolName: 'Bash', input: { command: 'curl -s https://a.example' } },
  { do: 'mcp', tool: 'report_blocked', args: { reason: 'It needs the network' } },
  turn,
];

const skipped = () =>
  listInbox(engine.store.db, { states: ['OPEN'] }).find(
    (i) => i.kind === InboxKind.Flag && i.detail?.[SKIPPED_DETAIL] !== undefined,
  );

/** A source run that failed blocked on a skip, with its item raised. */
async function failedSource(book: FakeScriptBook = { Alpha: [blocked, [turn]] }) {
  engine = await createTestEngine(book);
  const { task, workstream } = engine.addTask('Alpha');
  engine.launch(workstream.id);
  await engine.runner.idle();
  expect(getWorkstream(engine.store.db, workstream.id).state).toBe('FAILED');
  await raiseSkippedCard(
    { state: engine.state, git: createGit(), log: silentLogger },
    workstream.id,
  );
  return { task, workstream, item: openSkipped() };
}

const followUpsOf = (id: WorkstreamId) => skipFollowUpOf(engine.store.db, id);

function openSkipped() {
  const item = skipped();
  if (item === undefined) throw new Error('no skipped item is open');
  return item;
}

describe('Run these now', () => {
  it('pressed twice, makes one follow-up task, described and approved', async () => {
    const { workstream, item } = await failedSource();
    expect(item.options.map((o) => o.label)).toEqual(['Run these now', 'Dismiss']);
    engine.inbox.answer(item.id, { choice: SkippedChoice.RunTheseNow });
    expect(() => engine.inbox.answer(item.id, { choice: SkippedChoice.RunTheseNow })).toThrow(
      ConflictError,
    );
    const follow = followUpsOf(workstream.id);
    if (!follow) throw new Error('no follow-up');
    const task = getTask(engine.store.db, follow.taskId);
    expect(task.title).toBe('Run what "Alpha" skipped');
    expect(task.description).toContain('- `curl -s https://a.example`: skipped because');
    expect(approvedSkipsForTask(engine.store.db, task.id).map((s) => s.summary)).toEqual([
      'curl -s https://a.example',
    ]);
    // Local delivery starts it at once, from the base.
    expect(task.workstreamId).not.toBeNull();
    expect(pendingSkipFollowUps(engine.store.db)).toEqual([]);
  });

  it("approves exactly the item's ids: a skip recorded after the item is not approved", async () => {
    const { workstream, item } = await failedSource();
    engine.state.write((ctx) =>
      recordSkip(ctx, {
        workstreamId: workstream.id,
        sessionId: null,
        toolName: 'Bash',
        toolUseId: 'tu-late',
        callKey: 'late',
        summary: 'curl -s https://late.example',
        kind: 'default_mode_card',
        limit: null,
        reason: 'late',
        source: 'broker',
      }),
    );
    engine.inbox.answer(item.id, { choice: SkippedChoice.RunTheseNow });
    const follow = followUpsOf(workstream.id);
    if (!follow) throw new Error('no follow-up');
    expect(approvedSkipsForTask(engine.store.db, follow.taskId).map((s) => s.summary)).toEqual([
      'curl -s https://a.example',
    ]);
  });

  it('refuses Retry on the source while its follow-up runs, naming it, and refuses Run these now while the source is retried', async () => {
    const first = await failedSource();
    engine.inbox.answer(first.item.id, { choice: SkippedChoice.RunTheseNow });
    expect(() => engine.retry(first.workstream.id)).toThrow(
      'Retry waits for the follow-up "Run what "Alpha" skipped": remove it, or let it finish.',
    );
    await engine.close();

    const second = await failedSource();
    engine.retry(second.workstream.id);
    expect(() =>
      engine.inbox.answer(second.item.id, { choice: SkippedChoice.RunTheseNow }),
    ).toThrow('"Alpha" is being retried; Run these now waits until its run ends.');
    expect(skipped()?.id).toBe(second.item.id);
  });

  it("carries the approved classifier call in the follow-up's allow lines", async () => {
    const { workstream } = await failedSource();
    engine.state.write((ctx) =>
      recordSkip(ctx, {
        workstreamId: workstream.id,
        sessionId: null,
        toolName: 'Bash',
        toolUseId: 'tu-deploy',
        callKey: 'deploy',
        summary: 'vercel deploy --prod',
        kind: 'classifier',
        limit: null,
        reason: 'it deploys',
        source: 'auto_mode',
      }),
    );
    // The first item listed only the curl; a second lists the classifier's denial.
    engine.inbox.answer(openSkipped().id, { choice: SkippedChoice.Dismiss });
    await raiseSkippedCard(
      { state: engine.state, git: createGit(), log: silentLogger },
      workstream.id,
    );
    const specs: LaneSessionSpec[] = [];
    engine.adapter.seen = (spec) => {
      specs.push(spec);
      return {};
    };
    engine.inbox.answer(openSkipped().id, { choice: SkippedChoice.RunTheseNow });
    const follow = followUpsOf(workstream.id);
    if (!follow) throw new Error('no follow-up');
    const run = getTask(engine.store.db, follow.taskId).workstreamId;
    if (run === null) throw new Error('the follow-up did not start');
    engine.launch(run);
    await engine.runner.idle();
    expect(specs[0]?.policy.allow).toEqual([
      'Approved By The Builder: the call "vercel deploy --prod", skipped earlier because "it deploys", is approved as written.',
    ]);
  });
});
