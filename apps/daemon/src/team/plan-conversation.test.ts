import { createTestStore, seedProject } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedProfiles } from '../../test/seed-profiles';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { planConversationModel } from './plan-conversation';

let state: StateStore;
let close: () => void;
let project: ReturnType<typeof seedProject>;
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  project = seedProject(test.store);
  seedProfiles(state);
});
afterEach(() => {
  close();
});

describe('planConversationModel', () => {
  it('runs the plan role’s own effort, without Careful’s step up, and the builder’s when chosen', () => {
    expect(planConversationModel(state.db, project, null)).toMatchObject({ effort: 'high' });
    expect(planConversationModel(state.db, project, 'low')).toMatchObject({ effort: 'low' });
  });
});
