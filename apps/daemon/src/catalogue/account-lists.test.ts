import { AccountKind, Provider, type AccountId } from '@10db/contracts';
import {
  createTestStore,
  listAccountModels,
  listModelProfiles,
  markAccountModelUnusable,
  schema,
  seedAccount,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capturingLogger } from '../../test/fixtures';
import { readModelsDevFixture } from '../../test/models-dev-fixture';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import type { SeenAccount, SeenModel } from '../sessions';
import { createAccountLists, type AccountLists } from './account-lists';
import { parseCatalogue, type Catalogue } from './source';

const fixture = parseCatalogue(readModelsDevFixture());

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let id: AccountId;
let current: Catalogue | null;
let failWrites: boolean;
let logger: ReturnType<typeof capturingLogger>;
let lists: AccountLists;

beforeEach(() => {
  clock = new ManualClock(new Date(2026, 10, 6));
  ({ store, close } = createTestStore(() => clock.now()));
  const bus = createEventBus();
  const real = createStateStore(store, bus);
  failWrites = false;
  state = {
    db: real.db,
    now: () => real.now(),
    write(fn) {
      if (failWrites) throw new Error('disk is full');
      return real.write(fn);
    },
  };
  id = seedAccount(store, { kind: AccountKind.ClaudeSubscription, label: 'sub' }).id;
  current = fixture;
  logger = capturingLogger();
  lists = createAccountLists({ state, clock, catalogue: () => current, logger });
});
afterEach(() => {
  close();
});

const OPUS: SeenModel = { id: 'opus', resolvedId: 'claude-opus-5-5', efforts: ['low'] };
const HAIKU: SeenModel = { id: 'haiku', resolvedId: 'claude-haiku-5-5', efforts: [] };
const seenWith = (models?: readonly SeenModel[]): SeenAccount => ({
  email: 'me@example.com',
  organization: undefined,
  subscriptionType: 'Max',
  tokenSource: undefined,
  apiKeySource: 'none',
  apiProvider: 'firstParty',
  ...(models === undefined ? {} : { models }),
});
const record = (models?: readonly SeenModel[]) => {
  lists.record({ id, kind: AccountKind.ClaudeSubscription }, seenWith(models));
};
const stored = () => listAccountModels(store.db, id).map((m) => m.model);
const profileModels = () => [...new Set(listModelProfiles(store.db).map((p) => p.model))];

describe('recording an account list', () => {
  it('stores the list joined to the catalogue and builds profiles from it', () => {
    record([OPUS, HAIKU]);
    expect(stored()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
    expect(profileModels().sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
    expect(
      listModelProfiles(store.db).every((p) => p.provider === Provider.Claude && p.enabled),
    ).toBe(true);
  });

  it.each<[string, readonly SeenModel[] | undefined]>([
    ['gave no list', undefined],
    ['gave an empty list, as Codex does with every model hidden', []],
  ])('keeps the stored list, its time and its marks when the read %s', (_name, read) => {
    record([OPUS]);
    store.write((ctx) => {
      markAccountModelUnusable(ctx, id, 'claude-opus-5-5');
    });
    const before = listAccountModels(store.db, id);
    clock.advance(60 * 60_000);
    record(read);
    expect(listAccountModels(store.db, id)).toEqual(before);
  });

  it('builds profiles again only for a list that changed', () => {
    record([OPUS]);
    // Emptied by hand: a rebuild would bring the rows back.
    store.db.delete(schema.modelProfiles).run();
    clock.advance(60_000);
    record([OPUS]);
    expect(listModelProfiles(store.db)).toEqual([]);
    record([HAIKU]);
    expect(profileModels()).toEqual(['claude-haiku-5-5']);
    expect(stored()).toEqual(['claude-haiku-5-5']);
  });

  it('writes nothing while there is no catalogue to join to', () => {
    current = null;
    record([OPUS]);
    expect(stored()).toEqual([]);
  });

  it('logs and carries on when the write fails, so the identity check that read it still answers', () => {
    failWrites = true;
    expect(() => {
      record([OPUS]);
    }).not.toThrow();
    expect(logger.lines().join('\n')).toContain('keeping the last list');
  });
});
