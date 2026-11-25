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
let answersNouls: boolean;
let calledModels: string[];
let keys: Map<string, string>;
let keychain: Keychain;

/** A Messages response to the request: a choice, or one probability per yes/no question asked. */
function reply(body: {
  readonly model?: string;
  readonly output_config?: {
    readonly format?: { readonly schema?: { readonly required?: string[] } };
  };
}): Response {
  const required = body.output_config?.format?.schema?.required;
  const ids = required?.includes('choice') === true ? undefined : required;
  if (!answers || (ids !== undefined && !answersNouls)) return new Response('{}', { status: 500 });
  const text =
    ids === undefined
      ? '{"choice":"review","confidence":0.9}'
      : JSON.stringify(Object.fromEntries(ids.map((id) => [id, 0.9])));
  return new Response(
    JSON.stringify({
      model: body.model,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200 },
  );
}

function account(kind: 'openrouter' | 'anthropic_api_key', secret: string) {
  return state.write((ctx) => {
    const made = insertAccount(
      ctx,
      { kind, label: kind },
      { configDirFor: () => '/tmp/10db-test-account' },
    );
    keys.set(`account:${made.id}`, secret);
    recordAccountSecret(ctx, made.id, secretFingerprint(secret));
    return made;
  });
}

function anthropicWithModels() {
  const made = account('anthropic_api_key', ANTHROPIC_VALUE);
  state.write((ctx) => {
    replaceAccountModels(
      ctx,
      made.id,
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
  });
  return made;
}

function services() {
  const judge = createJudge({
    state,
    clock: new ManualClock(),
    fetch: (_url, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        model?: string;
      };
      calledModels.push(body.model ?? '');
      return Promise.resolve(reply(body));
    },
    readCredential: createJudgeCredentialReader({ state, keychain, off: false }),
    decisionModelIds: () => null,
    off: false,
    logger: silentLogger,
  });
  return createJudgeServices({
    state,
    keychain,
    judge,
    models: { list: () => Promise.reject(new Error('not asked')) },
    off: false,
    clock: new ManualClock(),
  });
}

beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  seedProfiles(state);
  answers = true;
  answersNouls = true;
  calledModels = [];
  keys = new Map();
  keychain = {
    read: (name) => keys.get(name) ?? null,
    readAsync: (name) => Promise.resolve(keys.get(name) ?? null),
    write: (name, secret) => void keys.set(name, secret),
    remove: (name) => void keys.delete(name),
  };
});
afterEach(() => {
  close();
});

it('a switch whose default model fails the test is refused and changes nothing; one that answers moves every decision', async () => {
  const router = account('openrouter', ROUTER_VALUE);
  const anthropic = anthropicWithModels();
  state.write((ctx) => patchJudgeConfig(ctx, { accountId: router.id }));
  const judgeServices = services();
  const before = getJudgeConfig(store.db);

  answers = false;
  await expect(judgeServices.patchJudge({ accountId: anthropic.id })).rejects.toBeInstanceOf(
    InvalidError,
  );
  expect(getJudgeConfig(store.db)).toEqual(before);

  answers = true;
  await judgeServices.patchJudge({ accountId: anthropic.id });
  const after = getJudgeConfig(store.db);
  expect(after.accountId).toBe(anthropic.id);
  const {
    crosses_limit_second: second,
    acceptance_second: acceptanceSecond,
    ...rest
  } = after.decisions;
  expect(new Set(Object.values(rest).map((d) => d.model))).toEqual(new Set(['claude-haiku-5-5']));
  // The second opinion on limits moves a step up: the account's Balanced model.
  expect(second.model).toBe('claude-sonnet-5-5');
  expect(acceptanceSecond.model).toBe('claude-sonnet-5-5');
  // Haiku answers a choice and a yes/no question (it runs crosses_limit); Sonnet answers yes/no questions.
  expect(calledModels.slice(-3).sort()).toEqual([
    'claude-haiku-5-5',
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
  ]);
});

// Value: protects=the limits decisions run on a model that answers yes/no questions; fails_when=PATCH /judge tests crosses_limit's model with a choice, so a model that can't answer a noul is saved and every limits call falls to the rules floor; why_new=core: it decides who answers crosses_limit; no_claim=OpenRouter's decisions endpoint answers a noul
it('a model that answers choices but not yes/no questions is refused for crosses_limit and saved for task_rigor', async () => {
  const anthropic = anthropicWithModels();
  state.write((ctx) => patchJudgeConfig(ctx, { accountId: anthropic.id }));
  const judgeServices = services();
  answersNouls = false;

  await expect(
    judgeServices.patchJudge({ decisions: { crosses_limit: { model: 'claude-opus-5-5' } } }),
  ).rejects.toBeInstanceOf(InvalidError);
  expect(getJudgeConfig(store.db).decisions.crosses_limit.model).not.toBe('claude-opus-5-5');

  await judgeServices.patchJudge({ decisions: { task_rigor: { model: 'claude-opus-5-5' } } });
  expect(getJudgeConfig(store.db).decisions.task_rigor.model).toBe('claude-opus-5-5');
});
