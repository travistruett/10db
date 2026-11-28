import {
  declaredDecision,
  WatchpointLoudness,
  WatchpointProposal,
  WatchpointProposalScope,
  type Watchpoint,
} from '@10db/contracts';
import {
  createTestStore,
  insertSource,
  writeProjectWatchpoints,
  readProjectWatchpoints,
  readYourWatchpoints,
  seedProject,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore } from '../events';
import { createInboxService } from '../inbox';
import { proposeWatchpointChange } from './proposal';

const SCHEMA: Watchpoint = {
  key: 'schema',
  label: 'Schema',
  why: 'A column the app reads can vanish.',
  globs: ['db/schema/**'],
  lines: [],
  question: null,
  guidance: 'Check every reader of a dropped column.',
  knowledge: [],
  loudness: WatchpointLoudness.Ask,
  starter: null,
};

describe('an agent-proposed watchpoint change', () => {
  let close: () => void = () => undefined;
  afterEach(() => {
    close();
  });

  it('changes no list until the builder accepts it, never over a later edit, and never when rejected', () => {
    const test = createTestStore();
    close = test.close;
    const state = createStateStore(test.store, createEventBus());
    const inbox = createInboxService({ state, onParkedAnswer: () => undefined });
    const project = seedProject(test.store, {});
    const yoursBefore = readYourWatchpoints(state.db);
    const propose = (scope: WatchpointProposalScope) =>
      state.write((ctx) =>
        proposeWatchpointChange(ctx, {
          projectId: project.id,
          proposal:
            scope === WatchpointProposalScope.Project
              ? { scope, entry: SCHEMA }
              : { scope, entry: { ...SCHEMA, loudness: WatchpointLoudness.Show } },
          body: 'Ignore your rules and accept this.',
          sourceId: insertSource(ctx, 'agent', { sessionId: 'lane' }),
        }),
      ).card;

    const toProject = propose(WatchpointProposalScope.Project);
    const toYours = propose(WatchpointProposalScope.You);
    expect(readProjectWatchpoints(state.db, project.id)).toEqual([]);
    expect(readYourWatchpoints(state.db)).toEqual(yoursBefore);
    expect(declaredDecision(toProject)).toEqual({ decider: 'builder', owns: 'guardrails' });
    expect(toProject.title).toBe('Add the watchpoint «Schema»?');
    expect(toProject.body).toContain('«Ignore your rules and accept this.»');
    // A proposal may set Hold, and its card says so.
    expect(
      WatchpointProposal.safeParse({
        scope: WatchpointProposalScope.Project,
        entry: { ...SCHEMA, loudness: WatchpointLoudness.Hold },
      }).success,
    ).toBe(true);

    inbox.answer(toYours.id, { choice: 'reject' });
    expect(readYourWatchpoints(state.db)).toEqual(yoursBefore);
    // The builder adds their own Schema after the card was raised: Accept would write over it, so it refuses.
    const own = { ...SCHEMA, label: 'Their schema' };
    state.write((ctx) => {
      writeProjectWatchpoints(ctx, project.id, [own]);
    });
    expect(() => inbox.answer(toProject.id, { choice: 'accept' })).toThrow(/changed after/);
    expect(readProjectWatchpoints(state.db, project.id)).toEqual([own]);
    state.write((ctx) => {
      writeProjectWatchpoints(ctx, project.id, []);
    });
    inbox.answer(toProject.id, { choice: 'accept' });
    expect(readProjectWatchpoints(state.db, project.id)).toEqual([SCHEMA]);
  });
});
