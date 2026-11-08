import { HazardEntryKind, InboxState, type HazardRemoval } from '@10db/contracts';
import {
  createTestStore,
  getProject,
  readHazardAssessment,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import {
  createInboxService,
  HazardChoice,
  pendingHazardRemovals,
  type InboxService,
} from '../inbox';
import { setHazardRemovalCard } from './removal-card';

let close: () => void;
let store: Store;
let state: StateStore;
let inbox: InboxService;
beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
});
afterEach(() => {
  close();
});

const removal = (value: string, reason = 'The repository does not use it.'): HazardRemoval => ({
  hazard: 'deps',
  kind: HazardEntryKind.Command,
  value,
  reason,
  evidence: { file: 'Makefile', line: 7 },
});

function raise(projectId: string, removals: readonly HazardRemoval[]) {
  return state.write((ctx) =>
    setHazardRemovalCard(ctx, getProject(ctx.tx, projectId as never), removals),
  );
}

const depsCommands = (projectId: string): readonly string[] | undefined =>
  getProject(store.db, projectId as never).hazards.find((h) => h.name === 'deps')?.commands;

describe('the card that lists hazards to remove', () => {
  it('lists each change with its evidence and offers Remove them or Keep them', () => {
    const project = seedProject(store);
    const card = raise(project.id, [removal('pnpm add'), removal('yarn add', 'Yarn is gone.')]);
    expect(card?.kind).toBe('flag');
    expect(card?.body).toContain('pnpm add');
    expect(card?.body).toContain('Yarn is gone.');
    expect(card?.body).toContain('Makefile line 7');
    expect(card?.options.map((o) => o.label)).toEqual([HazardChoice.Remove, HazardChoice.Keep]);
    expect(card?.recommendation).toBeNull();
    // Nothing is applied by raising it.
    expect(depsCommands(project.id)).toContain('pnpm add');
  });

  it('is one card for the project: a later look replaces what it lists', () => {
    const project = seedProject(store);
    const first = raise(project.id, [removal('pnpm add')]);
    const second = raise(project.id, [removal('pnpm add'), removal('yarn add')]);
    expect(second?.id).toBe(first?.id);
    expect(pendingHazardRemovals(store.db, project.id)).toHaveLength(2);
  });

  it('is withdrawn when a look finds nothing to remove', () => {
    const project = seedProject(store);
    raise(project.id, [removal('pnpm add')]);
    expect(raise(project.id, [])).toBeNull();
    expect(pendingHazardRemovals(store.db, project.id)).toEqual([]);
  });

  it('takes the entries out when the builder says Remove them, and not again', () => {
    const project = seedProject(store);
    const card = raise(project.id, [removal('pnpm add')]);
    inbox.answer(card?.id as never, { choice: HazardChoice.Remove });
    expect(depsCommands(project.id)).not.toContain('pnpm add');
    expect(depsCommands(project.id)).toContain('yarn add');
    expect(readHazardAssessment(store.db, project.id).declined).toEqual([
      { hazard: 'deps', kind: 'command', value: 'pnpm add' },
    ]);
  });

  it('leaves the hazards alone and remembers the choice when the builder says Keep them', () => {
    const project = seedProject(store);
    const card = raise(project.id, [removal('pnpm add')]);
    const answered = inbox.answer(card?.id as never, { choice: HazardChoice.Keep });
    expect(answered.state).toBe(InboxState.Resolved);
    expect(depsCommands(project.id)).toContain('pnpm add');
    expect(readHazardAssessment(store.db, project.id).kept).toHaveLength(1);
  });
});
