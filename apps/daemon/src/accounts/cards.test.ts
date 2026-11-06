import { AccountCardChoice, AccountProblem } from '@10db/contracts';
import { createTestStore, getAccountRow, seedAccount } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAP_RAISE_DETAIL,
  capCard,
  confirmCard,
  credentialsCard,
  fixFor,
  recordedCard,
  refusedCard,
  secretCard,
  signInCard,
} from './cards';
import { monthOf } from './month';

let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
});

describe('the sessions-refused card', () => {
  it('tells the builder Later leaves the account paused and where to resume it', () => {
    const test = createTestStore();
    close = test.close;
    const account = getAccountRow(
      test.store.db,
      seedAccount(test.store, { kind: 'anthropic_api_key', label: 'Client key' }).id,
    );
    const card = refusedCard(account, {
      problem: AccountProblem.KeychainUnavailable,
      message: 'The Keychain is locked',
      seenIdentity: null,
    });
    const later = card.options?.find((o) => o.label === AccountCardChoice.Later);
    expect(later?.description).toContain('Settings');
    expect(later?.description).toMatch(/resume/i);
  });
});

describe('the sessions-refused card for a start that kept timing out', () => {
  function subscription() {
    const test = createTestStore();
    close = test.close;
    return getAccountRow(
      test.store.db,
      seedAccount(test.store, { kind: 'claude_subscription', label: 'Claude plan' }).id,
    );
  }

  it('says the starts timed out, not that the account is signed out, and still names the sign-in command', () => {
    const account = subscription();
    const card = refusedCard(account, {
      problem: AccountProblem.StartTimeout,
      message:
        'Claude Code reported no account within 30 s on each of 2 starts for account "Claude plan", but claude auth status says it is signed in, so its starts kept timing out',
      seenIdentity: null,
    });
    expect(card.body).toContain('its starts kept timing out');
    expect(card.body).toMatch(/load/i);
    expect(card.body).toContain('claude /login');
    expect(card.body).not.toContain('Sign in again with');
    expect(card.foldKey).toContain('start_timeout');
  });

  it('names the sign-in command for a signed-out account', () => {
    const card = refusedCard(subscription(), {
      problem: AccountProblem.SignedOut,
      message: 'it looks signed out',
      seenIdentity: null,
    });
    expect(card.body).toContain('Sign in again with:');
    expect(card.body).toContain('claude /login');
  });
});

describe('the cards that used to hold nothing', () => {
  type Made = ReturnType<typeof accounts>;
  function accounts() {
    const test = createTestStore();
    close = test.close;
    const sub = getAccountRow(
      test.store.db,
      seedAccount(test.store, { kind: 'claude_subscription', label: 'Company A' }).id,
    );
    const key = getAccountRow(
      test.store.db,
      seedAccount(test.store, { kind: 'anthropic_api_key', label: 'Client key' }).id,
    );
    return { sub, key };
  }
  const labels = (card: { options?: readonly { label: string }[] }) =>
    (card.options ?? []).map((o) => o.label);

  it.each([
    ['sign-in', (a: Made) => signInCard(a.sub)],
    [
      'credentials',
      (a: Made) =>
        credentialsCard(a.sub, {
          problem: AccountProblem.WrongCredentials,
          message: 'It reports an API key',
          seenIdentity: null,
        }),
    ],
    ['secret', (a: Made) => secretCard(a.key)],
  ])('offers Check again on the %s card', (_name, make) => {
    expect(labels(make(accounts()))).toEqual([AccountCardChoice.CheckAgain]);
  });

  it('offers Record again on the card that names the default login', () => {
    const { sub } = accounts();
    expect(labels(recordedCard(sub, 'me@example.com'))).toEqual([AccountCardChoice.RecordAgain]);
  });

  it('offers to raise the cap to a figure above what is spent, and the card says so', () => {
    const { key } = accounts();
    const window = monthOf(new Date(2026, 9, 20));
    const card = capCard(key, { spentUsd: 57.5, capUsd: 50, window });
    expect(labels(card)).toEqual(['Raise cap to $70']);
    expect(card.detail[CAP_RAISE_DETAIL]).toEqual({
      accountId: key.id,
      choice: 'Raise cap to $70',
      toUsd: 70,
    });
    expect(card.body).toContain('Raise cap to $70');
  });
});

describe('the cards for a ChatGPT account', () => {
  function codexAccount() {
    const test = createTestStore();
    close = test.close;
    const row = getAccountRow(
      test.store.db,
      seedAccount(test.store, { kind: 'codex_signin', label: 'ChatGPT plan' }).id,
    );
    // The seeded home is named for Claude; a created ChatGPT account's is named codex.
    return { ...row, configDir: '/h/accounts/a/codex' };
  }

  it('fixes a signed-out account with codex login and never names claude', () => {
    const fix = fixFor(codexAccount(), AccountProblem.SignedOut);
    expect(fix).toContain('codex login');
    expect(fix).not.toContain('claude');
  });

  it.each([AccountProblem.WrongCredentials, AccountProblem.StartTimeout])(
    'names Codex, not Claude Code, for %s',
    (problem) => {
      const fix = fixFor(codexAccount(), problem);
      expect(fix).toContain('Codex');
      expect(fix).not.toContain('Claude');
    },
  );

  it('tells the builder to sign in with codex login', () => {
    const card = signInCard(codexAccount());
    expect(card.body).toContain('codex login');
    expect(card.body).not.toContain('Claude Code');
    expect(card.body).not.toContain('claude /login');
  });

  it('asks to confirm the email and the workspace, which together are its identity', () => {
    const card = confirmCard(codexAccount(), 'me@example.com · ws-1');
    expect(card.body).toContain(
      'Codex in /h/accounts/a/codex is signed in as me@example.com · ws-1',
    );
    expect(card.body).toContain('sessions run only while they report this email and workspace.');
  });

  it('offers Confirm for a reported sign-in, as a subscription does', () => {
    const card = refusedCard(codexAccount(), {
      problem: AccountProblem.IdentityMismatch,
      message: 'it differs',
      seenIdentity: 'me@example.com · ws-1',
    });
    expect((card.options ?? []).map((o) => o.label)).toContain(AccountCardChoice.Confirm);
  });
});

describe('the confirm card for a subscription', () => {
  it('asks to confirm the email alone', () => {
    const test = createTestStore();
    close = test.close;
    const row = getAccountRow(
      test.store.db,
      seedAccount(test.store, { kind: 'claude_subscription', label: 'Claude plan' }).id,
    );
    expect(confirmCard(row, 'me@example.com').body).toContain(
      'sessions run only while they report this email.',
    );
  });
});

describe('the identity-mismatch fix', () => {
  it.each([
    ['codex_signin', 'CODEX_HOME='],
    ['claude_subscription', 'CLAUDE_CONFIG_DIR='],
  ] as const)('keeps the case of the sign-in command of a %s account', (kind, variable) => {
    const test = createTestStore();
    close = test.close;
    const account = getAccountRow(
      test.store.db,
      seedAccount(test.store, { kind, label: 'Plan' }).id,
    );
    const fix = fixFor(account, AccountProblem.IdentityMismatch);
    expect(fix).toContain(variable);
    expect(fix).toContain('otherwise sign in again with:');
  });
});
