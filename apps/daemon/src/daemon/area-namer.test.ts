import { existsSync, readdirSync } from 'node:fs';
import {
  createTestStore,
  defaultAccountId,
  getAccountRow,
  replaceAccountModels,
  seedDefaultAccount,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryKeychain, tempDir } from '../../test/fixtures';
import { seedProfiles } from '../../test/seed-profiles';
import { createLauncher } from '../environment';
import { createEventBus, createStateStore } from '../events';
import { FakeAdapter, FakeScriptBook } from '../sessions';
import { createAreaNamer } from './area-namer';

let close: () => void = () => undefined;
let store: ReturnType<typeof createTestStore>['store'];
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  store = test.store;
  store.write((ctx) => seedDefaultAccount(ctx, { expectedIdentity: 'me@example.com' }));
  seedProfiles(createStateStore(store, createEventBus()));
});
afterEach(() => {
  close();
});

const launcher = () =>
  createLauncher({
    base: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-not-for-this' },
    clientApp: '10db/test',
    keychain: createMemoryKeychain(),
  });

describe('createAreaNamer', () => {
  it('asks the default account for its fast model, in an empty folder, and returns the text', async () => {
    const adapter = new FakeAdapter(FakeScriptBook.parse({}));
    adapter.answer = () => Promise.resolve('{"areas":[]}');
    const scratch = tempDir('namer');
    const namer = createAreaNamer({
      adapter,
      launcher: launcher(),
      db: store.db,
      scratchRoot: scratch.path,
    });
    await expect(namer('Name these.')).resolves.toBe('{"areas":[]}');
    const [ask] = adapter.completions;
    const id = defaultAccountId(store.db);
    expect(id).not.toBeNull();
    if (id === null || ask === undefined) return;
    expect(ask).toMatchObject({
      prompt: 'Name these.',
      model: 'claude-haiku-5-5',
      account: { accountId: id, label: getAccountRow(store.db, id).label },
    });
    // The billing switches never reach a one-shot question on a subscription.
    expect(ask.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(ask.cwd.startsWith(scratch.path)).toBe(true);
    expect(existsSync(ask.cwd)).toBe(false);
    expect(readdirSync(scratch.path)).toEqual([]);
    scratch.cleanup();
  });

  it.each([
    {
      name: 'the ID the account launches its fast model with',
      list: [
        { model: 'claude-haiku-5-5', launchId: 'us.anthropic.claude-haiku-5-5' },
        { model: 'claude-opus-5-5', launchId: 'us.anthropic.claude-opus-5-5' },
      ],
      model: 'us.anthropic.claude-haiku-5-5',
    },
    {
      name: 'the tier above when the account lists no fast model',
      list: [{ model: 'claude-sonnet-5-5', launchId: 'claude-sonnet-5-5' }],
      model: 'claude-sonnet-5-5',
    },
  ])('asks for $name', async ({ list, model }) => {
    const id = defaultAccountId(store.db);
    if (id === null) throw new Error('no default account');
    store.write((ctx) =>
      replaceAccountModels(
        ctx,
        id,
        list.map((m) => ({
          ...m,
          family: null,
          efforts: [],
          inputPrice: null,
          outputPrice: null,
        })),
      ),
    );
    const adapter = new FakeAdapter(FakeScriptBook.parse({}));
    adapter.answer = () => Promise.resolve('x');
    const scratch = tempDir('namer');
    await createAreaNamer({
      adapter,
      launcher: launcher(),
      db: store.db,
      scratchRoot: scratch.path,
    })('Name these.');
    expect(adapter.completions[0]?.model).toBe(model);
    scratch.cleanup();
  });

  it("passes the caller's signal to the question so giving up stops the model", async () => {
    const adapter = new FakeAdapter(FakeScriptBook.parse({}));
    adapter.answer = () => Promise.resolve('x');
    const scratch = tempDir('namer');
    const namer = createAreaNamer({
      adapter,
      launcher: launcher(),
      db: store.db,
      scratchRoot: scratch.path,
    });
    const caller = new AbortController();
    await namer('Name these.', caller.signal);
    expect(adapter.completions[0]?.signal).toBe(caller.signal);
    scratch.cleanup();
  });

  it('removes its folder when the model fails', async () => {
    const adapter = new FakeAdapter(FakeScriptBook.parse({}));
    const scratch = tempDir('namer');
    const namer = createAreaNamer({
      adapter,
      launcher: launcher(),
      db: store.db,
      scratchRoot: scratch.path,
    });
    await expect(namer('x')).rejects.toThrow('no model');
    expect(readdirSync(scratch.path)).toEqual([]);
    scratch.cleanup();
  });

  it('fails when there is no default account to ask', async () => {
    close();
    const test = createTestStore();
    close = test.close;
    const adapter = new FakeAdapter(FakeScriptBook.parse({}));
    const namer = createAreaNamer({
      adapter,
      launcher: launcher(),
      db: test.store.db,
      scratchRoot: tempDir('namer').path,
    });
    await expect(namer('x')).rejects.toThrow('account');
    expect(adapter.completions).toEqual([]);
  });
});
