import {
  InboxState,
  SkipKind,
  SkipSource,
  TaskStatus,
  WORKSTREAM_FAILED_TITLE_PREFIX,
} from '@10db/contracts';
import { createTestStore, listInbox, recordSkip, schema, setTaskStatus } from '@10db/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { createEventBus, createStateStore } from '../events';
import { BY_ANSWER, CardTier, createInboxService } from '../inbox';
import { silentLogger } from '../log';
import { closeFinishedSkippedCards, raiseSkippedCard, SkippedChoice } from './skipped-card';

let close: () => void = () => undefined;
afterEach(() => {
  close();
});

describe('the skipped-calls item of a run', () => {
  it('rides on the failed card of a failed run rather than making a second one, and closes with its task', async () => {
    const world = createTestStore();
    close = world.close;
    const state = createStateStore(world.store, createEventBus());
    const inbox = createInboxService({ state, onParkedAnswer: () => undefined });
    const { project, task, workstream } = seedWorkstream(world.store);
    world.store.write((ctx) => {
      ctx.tx
        .update(schema.workstreams)
        .set({ state: 'FAILED' })
        .where(eq(schema.workstreams.id, workstream.id))
        .run();
      recordSkip(ctx, {
        workstreamId: workstream.id,
        sessionId: null,
        toolName: 'WebFetch',
        toolUseId: 'toolu_1',
        callKey: 'call-1',
        summary: 'fetch https://example.com',
        kind: SkipKind.WebOrMcp,
        limit: null,
        reason: 'the web is off',
        source: SkipSource.AutoMode,
      });
    });
    const failed = inbox.flag({
      projectId: project.id,
      workstreamId: workstream.id,
      tier: CardTier.Ask,
      urgency: 'high',
      closesWhen: BY_ANSWER,
      title: `${WORKSTREAM_FAILED_TITLE_PREFIX}${task.title}`,
      body: 'The gate failed 4 times',
    });

    await raiseSkippedCard(
      {
        state,
        git: { head: () => Promise.resolve('abc'), changedFilesSince: () => Promise.resolve([]) },
        log: silentLogger,
      },
      workstream.id,
    );

    const open = listInbox(world.store.db, { states: [InboxState.Open] });
    expect(open.map((i) => i.id)).toEqual([failed.id]);
    expect(open[0]?.body).toContain('The gate failed 4 times');
    expect(open[0]?.body).toContain('fetch https://example.com');
    expect(open[0]?.options.map((o) => o.label)).toEqual([
      SkippedChoice.RunTheseNow,
      SkippedChoice.Dismiss,
    ]);

    expect(closeFinishedSkippedCards(world.store.db, inbox)).toBe(0);
    world.store.write((ctx) => {
      setTaskStatus(ctx, task.id, TaskStatus.Done);
    });
    expect(closeFinishedSkippedCards(world.store.db, inbox)).toBe(1);
    expect(listInbox(world.store.db, { states: [InboxState.Open] })).toEqual([]);
  });
});
