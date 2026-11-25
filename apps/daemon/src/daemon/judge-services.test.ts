import { InvalidError } from '@10db/contracts';
import {
  createTestStore,
  getJudgeConfig,
  insertAccount,
  patchJudgeConfig,
  recordAccountSecret,
  replaceAccountModels,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { seedProfiles } from '../../test/seed-profiles';
import { ManualClock } from '../clock';
import { secretFingerprint, type Keychain } from '../environment';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createJudge } from '../judge';
import { silentLogger } from '../log';
import { createJudgeCredentialReader, createJudgeServices } from './judge-services';

// Value: protects=who answers crosses_limit: Decisions move to another account only once its default model answers a test decision, and then every decision runs on that model; fails_when=a switch saves an account whose model can't answer, or leaves a decision on the old account's model; why_new=core: it changes who answers crosses_limit; no_claim=a live Anthropic or Bedrock call answers

const ANTHROPIC_VALUE = 'stand-in-one';
const ROUTER_VALUE = 'stand-in-two';

let store: Store;
let close: () => void;
let state: StateStore;
let answers: boolean;
let calledModels: string[];

beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  seedProfiles(state);
  answers = true;
  calledModels = [];
});
afterEach(() => {
  close();
});

it('a switch whose default model fails the test is refused and changes nothing; one that answers moves every decision', async () => {
  const keys = new Map<string, string>();
  const keychain: Keychain = {
    read: (account) => keys.get(account) ?? null,
    readAsync: (account) => Promise.resolve(keys.get(account) ?? null),
    write: (account, secret) => void keys.set(account, secret),
    remove: (account) => void keys.delete(account),
  };
  const account = (kind: 'openrouter' | 'anthropic_api_key', secret: string) =>
    state.write((ctx) => {
      const made = insertAccount(
        ctx,
        { kind, label: kind },
        { configDirFor: () => '/tmp/10db-test-account' },
      );
      keys.set(`account:${made.id}`, secret);
      recordAccountSecret(ctx, made.id, secretFingerprint(secret));
      return made;
    });
  const router = account('openrouter', ROUTER_VALUE);
  const anthropic = account('anthropic_api_key', ANTHROPIC_VALUE);
  state.write((ctx) => {
    replaceAccountModels(
      ctx,
      anthropic.id,
      ['claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'].map(
        (model) => ({
          model,
          family: null,
          launchId: model,
          efforts: [],
          inputPrice: null,
          outputPrice: null,
        }),
      ),
    );
    patchJudgeConfig(ctx, { accountId: router.id });
  });

  const judge = createJudge({
    state,
    clock: new ManualClock(),
    fetch: (_url, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        model?: string;
      };
      calledModels.push(body.model ?? '');
      return Promise.resolve(
        answers
          ? new Response(
              JSON.stringify({
                model: body.model,
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: '{"choice":"review","confidence":0.9}' }],
                usage: { input_tokens: 10, output_tokens: 5 },
              }),
              { status: 200 },
            )
          : new Response('{}', { status: 500 }),
      );
    },
    readCredential: createJudgeCredentialReader({ state, keychain, off: false }),
    decisionModelIds: () => null,
    off: false,
    logger: silentLogger,
  });
  const services = createJudgeServices({
    state,
    keychain,
    judge,
    models: { list: () => Promise.reject(new Error('not asked')) },
    off: false,
    clock: new ManualClock(),
  });
  const before = getJudgeConfig(store.db);

  answers = false;
  await expect(services.patchJudge({ accountId: anthropic.id })).rejects.toBeInstanceOf(
    InvalidError,
  );
  expect(getJudgeConfig(store.db)).toEqual(before);

  answers = true;
  await services.patchJudge({ accountId: anthropic.id });
  const after = getJudgeConfig(store.db);
  expect(after.accountId).toBe(anthropic.id);
  const { crosses_limit_second: second, ...rest } = after.decisions;
  expect(new Set(Object.values(rest).map((d) => d.model))).toEqual(new Set(['claude-haiku-5-5']));
  // The second opinion on limits moves a step up: the account's Balanced model.
  expect(second.model).toBe('claude-sonnet-5-5');
  expect(calledModels.slice(-2).sort()).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
});
