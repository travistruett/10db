import { existsSync, readdirSync } from 'node:fs';
import { createTestStore, defaultAccountId, getAccountRow, seedDefaultAccount } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryKeychain, tempDir } from '../../test/fixtures';
import { createLauncher } from '../environment';
import { FakeAdapter, FakeScriptBook } from '../sessions';
import { createAreaNamer } from './area-namer';

let close: () => void = () => undefined;
let store: ReturnType<typeof createTestStore>['store'];
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  store = test.store;
  store.write((ctx) => seedDefaultAccount(ctx, { expectedIdentity: 'me@example.com' }));
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
  it('asks the default account for a cheap model, in an empty folder, and returns the text', async () => {
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
      model: 'haiku',
      account: { accountId: id, label: getAccountRow(store.db, id).label },
    });
    // The billing switches never reach a one-shot question on a subscription.
    expect(ask.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(ask.cwd.startsWith(scratch.path)).toBe(true);
    expect(existsSync(ask.cwd)).toBe(false);
    expect(readdirSync(scratch.path)).toEqual([]);
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
