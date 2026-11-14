import { createTestStore, seedProject, upsertModelProfiles } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedProfiles } from '../../test/seed-profiles';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { conversationRun, planConversationModel } from './plan-conversation';
import { routingInputs } from './routing-inputs';

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

describe('conversationRun', () => {
  it('runs a chosen model at the conversation’s effort snapped to the efforts that model has', () => {
    const profile = routingInputs(state.db, project).profiles[0];
    expect(profile).toBeDefined();
    if (profile === undefined) return;
    // A model that runs at low and medium only, beside the seeded ones that run at every effort.
    state.write((ctx) => {
      upsertModelProfiles(
        ctx,
        (['low', 'medium'] as const).map((effort) => ({
          provider: profile.provider,
          model: 'house-limited',
          effort,
          aaSlug: null,
          enabled: true,
          maker: profile.maker,
          family: null,
          tier: profile.tier,
          status: profile.status,
          inputPrice: profile.inputPrice,
          outputPrice: profile.outputPrice,
          releaseDate: profile.releaseDate,
        })),
      );
    });
    const run = conversationRun(state.db, project, 'house-limited', 'max');
    expect(run).toEqual({ model: 'house-limited', effort: 'medium' });
  });
});
