import { ACCOUNT_CARD_DETAIL, AccountCardChoice, type AccountDto } from '@10db/contracts';
import {
  createTestStore,
  getAccount,
  getAccountRow,
  listInbox,
  patchAccount,
  seedAccount,
  seedDefaultAccount,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryKeychain } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createLauncher } from '../environment';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger } from '../log';
import { AccountProbeError, FakeAdapter, type SeenAccount } from '../sessions';
import {
  createAccountCardAnswers,
  createAccountPreparer,
  createStartGate,
  PREPARE_RETRY_MS,
  type AccountPreparer,
} from './index';

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let inbox: InboxService;
let adapter: FakeAdapter;
let preparer: AccountPreparer;
let ready: number;

beforeEach(() => {
  clock = new ManualClock();
  ({ store, close } = createTestStore(() => clock.now()));
  state = createStateStore(store, createEventBus());
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  adapter = new FakeAdapter({});
  ready = 0;
  preparer = createAccountPreparer({
    state,
    clock,
    inbox,
    adapter,
    launcher: createLauncher({
      base: { PATH: '/bin' },
      clientApp: 'test',
      keychain: createMemoryKeychain(),
    }),
    startGate: createStartGate(),
    dataDir: '/data',
    logger: silentLogger,
    onReady: () => {
      ready += 1;
    },
  });
});
afterEach(() => {
  close();
});

const openCards = () => listInbox(state.db, { states: ['OPEN'] });
/** The default account with no identity yet, as a fresh daemon seeds it, and a project on it. */
function freshDefault(configDir: string | null = null): {
  defaultAccount: AccountDto;
  projectId: ReturnType<typeof seedProject>['id'];
} {
  const defaultAccount = store.write((ctx) =>
    seedDefaultAccount(ctx, { expectedIdentity: null, configDir }),
  ).value;
  if (!defaultAccount) throw new Error('the store already had an account');
  return { defaultAccount, projectId: seedProject(store).id };
}

describe('the preparer', () => {
  it.each<[string, string | null]>([
    ["Claude Code's default directory", null],
    ["the login shell's own directory", '/h/b/.claude-work'],
  ])(
    "records the default account's identity from its first probe of %s, with a card that holds nothing, then asks for a tick",
    async (_where, configDir) => {
      const { defaultAccount, projectId } = freshDefault(configDir);
      adapter.probeSeen = { ...adapter.probeSeen, email: 'me@example.com' };
      preparer.prepare(getAccountRow(state.db, defaultAccount.id), projectId);
      await preparer.idle();
      expect(getAccount(state.db, defaultAccount.id).expectedIdentity).toBe('me@example.com');
      expect(adapter.probes).toHaveLength(1);
      expect(adapter.probes[0]?.env['CLAUDE_CONFIG_DIR']).toBe(configDir ?? undefined);
      expect(ready).toBe(1);
      const cards = openCards();
      expect(cards.map((c) => c.title)).toEqual(['Claude plan runs as me@example.com']);
      expect(cards[0]?.options.map((o) => o.label)).toEqual([]);
      expect(cards[0]?.body).toContain(configDir ?? 'claude /login');
      expect(cards[0]?.detail?.[ACCOUNT_CARD_DETAIL]).toMatchObject({
        accountId: defaultAccount.id,
        seenIdentity: 'me@example.com',
      });
    },
  );

  it('raises one sign-in card when the default directory is signed out, and probes again only after a minute', async () => {
    const { defaultAccount, projectId } = freshDefault();
    adapter.probeSeen = { ...adapter.probeSeen, email: undefined, subscriptionType: undefined };
    const row = getAccountRow(state.db, defaultAccount.id);
    preparer.prepare(row, projectId);
    await preparer.idle();
    preparer.prepare(row, projectId);
    await preparer.idle();
    expect(adapter.probes).toHaveLength(1);
    expect(openCards().map((c) => c.body)).toEqual([expect.stringContaining('claude /login')]);
    clock.advance(PREPARE_RETRY_MS);
    preparer.prepare(row, projectId);
    await preparer.idle();
    expect(adapter.probes).toHaveLength(2);
    expect(openCards()).toHaveLength(1);
  });

  it('asks the builder to confirm an account on its own directory, and Confirm records it', async () => {
    seedProject(store);
    const sub = seedAccount(store, { kind: 'claude_subscription', label: 'Company A' });
    const projectId = seedProject(store, { accountId: sub.id }).id;
    adapter.probeSeen = { ...adapter.probeSeen, email: 'a@company.example' };
    preparer.prepare(getAccountRow(state.db, sub.id), projectId);
    await preparer.idle();
    expect(getAccount(state.db, sub.id).expectedIdentity).toBeNull();
    const card = openCards()[0];
    expect(card?.options.map((o) => o.label)).toEqual(['Confirm', 'Later']);
    expect(card?.detail?.[ACCOUNT_CARD_DETAIL]).toMatchObject({
      accountId: sub.id,
      problem: 'unconfirmed',
      seenIdentity: 'a@company.example',
    });
    expect(adapter.probes[0]?.env['CLAUDE_CONFIG_DIR']).toBe(sub.configDir);

    const confirmed: string[] = [];
    const answers = createAccountCardAnswers({
      resume: () => undefined,
      confirm: (_id, identity) => {
        confirmed.push(identity);
      },
    });
    if (!card) throw new Error('no confirm card');
    answers(card, { choice: AccountCardChoice.Confirm });
    expect(confirmed).toEqual(['a@company.example']);
  });

  it('probes no more while a Confirm card waits on the builder', async () => {
    seedProject(store);
    const sub = seedAccount(store, { kind: 'claude_subscription', label: 'Company A' });
    const projectId = seedProject(store, { accountId: sub.id }).id;
    const row = getAccountRow(state.db, sub.id);
    preparer.prepare(row, projectId);
    await preparer.idle();
    clock.advance(PREPARE_RETRY_MS);
    preparer.prepare(row, projectId);
    await preparer.idle();
    expect(adapter.probes).toHaveLength(1);
    expect(openCards().map((c) => c.title)).toEqual(['Confirm the account Company A']);
  });

  it('asks for the secret of a keyed account that has none, without probing', async () => {
    seedProject(store);
    const key = seedAccount(store, { kind: 'anthropic_api_key', label: 'Client key' });
    const projectId = seedProject(store, { accountId: key.id }).id;
    preparer.prepare(getAccountRow(state.db, key.id), projectId);
    await preparer.idle();
    expect(adapter.probes).toEqual([]);
    expect(openCards()[0]?.body).toContain(`PUT /accounts/${key.id}/secret`);
  });

  it('asks the default account to sign in when its probe gets no account in time', async () => {
    const { defaultAccount, projectId } = freshDefault();
    adapter.probeAccount = () =>
      Promise.reject(new AccountProbeError('Claude Code reported no account within 15 s'));
    preparer.prepare(getAccountRow(state.db, defaultAccount.id), projectId);
    await preparer.idle();
    const cards = openCards();
    expect(cards.map((c) => c.title)).toEqual(['Sign in the account Claude plan']);
    expect(cards[0]?.body).toMatch(/reported no account within 15 s.*claude \/login/);
    expect(getAccount(state.db, defaultAccount.id).expectedIdentity).toBeNull();
  });

  it.each<[string, Partial<SeenAccount>, string]>([
    [
      'a default directory whose settings force Bedrock',
      { email: undefined, subscriptionType: undefined, apiProvider: 'bedrock' },
      'bedrock',
    ],
    [
      'an apiKeyHelper',
      { email: undefined, subscriptionType: undefined, apiKeySource: 'apiKeyHelper' },
      'apiKeyHelper',
    ],
    [
      'a Console login with an email and no plan',
      { email: 'me@example.com', subscriptionType: undefined },
      'needs',
    ],
  ])('raises a credentials card, not a sign-in card, for %s', async (_name, seen, mention) => {
    const { defaultAccount, projectId } = freshDefault();
    adapter.probeSeen = { ...adapter.probeSeen, ...seen };
    preparer.prepare(getAccountRow(state.db, defaultAccount.id), projectId);
    await preparer.idle();
    const cards = openCards();
    expect(cards.map((c) => c.title)).toEqual(['Fix the credentials of Claude plan']);
    expect(cards[0]?.body).toContain(mention);
    expect(cards[0]?.body).not.toContain('claude /login');
    expect(getAccount(state.db, defaultAccount.id).expectedIdentity).toBeNull();
  });

  it('keeps quiet after Later, until the account is saved', async () => {
    seedProject(store);
    const sub = seedAccount(store, { kind: 'claude_subscription', label: 'Company A' });
    const projectId = seedProject(store, { accountId: sub.id }).id;
    const row = () => getAccountRow(state.db, sub.id);
    preparer.prepare(row(), projectId);
    await preparer.idle();
    const card = openCards()[0];
    if (!card) throw new Error('no confirm card');
    clock.advance(1000);
    inbox.answer(card.id, { choice: AccountCardChoice.Later });
    clock.advance(PREPARE_RETRY_MS);
    preparer.prepare(row(), projectId);
    await preparer.idle();
    expect(adapter.probes).toHaveLength(1);
    expect(openCards()).toEqual([]);
    clock.advance(1000);
    state.write((ctx) => patchAccount(ctx, sub.id, { laneCap: 3 }));
    clock.advance(PREPARE_RETRY_MS);
    preparer.prepare(row(), projectId);
    await preparer.idle();
    expect(adapter.probes).toHaveLength(2);
    expect(openCards().map((c) => c.title)).toEqual(['Confirm the account Company A']);
  });

  it('probes no more while a Confirm card waits in any project of the account', async () => {
    seedProject(store);
    const sub = seedAccount(store, { kind: 'claude_subscription', label: 'Company A' });
    const first = seedProject(store, { accountId: sub.id }).id;
    const second = seedProject(store, { accountId: sub.id }).id;
    const row = getAccountRow(state.db, sub.id);
    preparer.prepare(row, first);
    await preparer.idle();
    clock.advance(PREPARE_RETRY_MS);
    preparer.prepare(row, second);
    await preparer.idle();
    expect(adapter.probes).toHaveLength(1);
    expect(openCards().map((c) => c.projectId)).toEqual([first]);
  });

  it('closes the sign-in card once the identity is recorded', async () => {
    const { defaultAccount, projectId } = freshDefault();
    const row = getAccountRow(state.db, defaultAccount.id);
    adapter.probeSeen = { ...adapter.probeSeen, email: undefined, subscriptionType: undefined };
    preparer.prepare(row, projectId);
    await preparer.idle();
    expect(openCards().map((c) => c.title)).toEqual(['Sign in the account Claude plan']);
    adapter.probeSeen = {
      ...adapter.probeSeen,
      email: 'me@example.com',
      subscriptionType: 'Claude Max',
    };
    clock.advance(PREPARE_RETRY_MS);
    preparer.prepare(row, projectId);
    await preparer.idle();
    expect(openCards().map((c) => c.title)).toEqual(['Claude plan runs as me@example.com']);
  });

  it('does nothing for a ready account', async () => {
    // seedProject's default account is confirmed for builder@example.com.
    const project = seedProject(store);
    preparer.prepare(getAccountRow(state.db, project.accountId), project.id);
    await preparer.idle();
    expect(adapter.probes).toEqual([]);
    expect(openCards()).toEqual([]);
  });
});
