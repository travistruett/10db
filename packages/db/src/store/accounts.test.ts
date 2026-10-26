import {
  ConflictError,
  EventType,
  InvalidError,
  NotFoundError,
  mintId,
  type AccountId,
  type ProjectDto,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accountSecretRef,
  accountSpendUsd,
  accountUsage,
  archiveAccount,
  countLanes,
  createTestStore,
  defaultAccountId,
  getAccount,
  getAccountRow,
  getProject,
  getSession,
  insertSession,
  insertTask,
  insertWorkstream,
  listAccounts,
  listEventsAfter,
  patchAccount,
  patchProject,
  recordAccountSecret,
  seedAccount,
  seedDefaultAccount,
  seedProject,
  TEST_ACCOUNT_EMAIL,
  transitionWorkstream,
  updateSessionUsage,
  type Store,
} from './index';

let store: Store;
let close: () => void;
let now: Date;
beforeEach(() => {
  now = new Date(2026, 9, 15, 12, 0);
  ({ store, close } = createTestStore(() => now));
});
afterEach(() => {
  close();
});

const OCTOBER = {
  month: '2026-10',
  start: new Date(2026, 9, 1).toISOString(),
  end: new Date(2026, 10, 1).toISOString(),
};
const apiKey = (label = 'Client key', monthlyCapUsd: number | null = 500) =>
  seedAccount(store, { kind: 'anthropic_api_key', label, monthlyCapUsd });

/** One session of `usage` on a fresh task in `project`, started at `at`. */
function spend(
  project: ProjectDto,
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number },
  at: Date,
) {
  now = at;
  return store.write((ctx) => {
    const task = insertTask(ctx, project.id, {
      title: `t-${String(at.getTime())}`,
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    const ws = insertWorkstream(ctx, task.id);
    const session = insertSession(ctx, {
      workstreamId: ws.id,
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
      mode: 'managed',
      mcpTokenHash: `hash-${String(Math.random())}`,
    });
    updateSessionUsage(ctx, session.id, usage);
    return session;
  }).value;
}

describe('accounts', () => {
  it("seeds the default account once, as Claude plan, on the login's own directory", () => {
    const seeded = store.write((ctx) =>
      seedDefaultAccount(ctx, { expectedIdentity: null, configDir: '/Users/b/.claude-work' }),
    ).value;
    expect(seeded).toMatchObject({
      kind: 'claude_subscription',
      label: 'Claude plan',
      configDir: '/Users/b/.claude-work',
      expectedIdentity: null,
      laneCap: 4,
      isDefault: true,
      secretSet: false,
      archived: false,
    });
    expect(
      store.write((ctx) => seedDefaultAccount(ctx, { expectedIdentity: null })).value,
    ).toBeNull();
    expect(defaultAccountId(store.db)).toBe(seeded?.id);
  });

  it('gives every new account its own config directory, and a keyed account a Keychain item', () => {
    const defaultAccount = store.write((ctx) =>
      seedDefaultAccount(ctx, { expectedIdentity: null }),
    ).value;
    expect(defaultAccount?.configDir).toBeNull();
    const created = seedAccount(store, { kind: 'claude_subscription', label: 'Company A' });
    expect(created.configDir).toBe(`/tmp/10db-test-accounts/${created.id}/claude`);
    expect(created.isDefault).toBe(false);
    const key = apiKey();
    expect(getAccountRow(store.db, key.id)).toMatchObject({
      configDir: `/tmp/10db-test-accounts/${key.id}/claude`,
      secretRef: accountSecretRef(key.id),
      secretFingerprint: null,
    });
    expect(listAccounts(store.db).map((a) => a.label)).toEqual([
      'Claude plan',
      'Client key',
      'Company A',
    ]);
  });

  it('lets the builder rename the default account, and keeps labels unique', () => {
    const seeded = store.write((ctx) => seedDefaultAccount(ctx, { expectedIdentity: null })).value;
    if (!seeded) throw new Error('the store already had an account');
    expect(
      store.write((ctx) => patchAccount(ctx, seeded.id, { label: 'Work plan' })).value,
    ).toMatchObject({ label: 'Work plan', isDefault: true });
    apiKey('Client key');
    expect(() =>
      store.write((ctx) => patchAccount(ctx, seeded.id, { label: 'Client key' })),
    ).toThrow(ConflictError);
  });

  it('writes account.saved with the changed fields and never a value', () => {
    const key = apiKey();
    const after = listEventsAfter(store.db, 0, 100).at(-1)?.seq ?? 0;
    store.write((ctx) => patchAccount(ctx, key.id, { monthlyCapUsd: 250, payer: 'Client B' }));
    store.write((ctx) => recordAccountSecret(ctx, key.id, 'sha256:0123456789abcdef'));
    const events = listEventsAfter(store.db, after, 100);
    expect(events.map((e) => [e.type, e.entityType, e.data])).toEqual([
      [EventType.AccountSaved, 'account', { fields: ['monthlyCapUsd', 'payer'] }],
      [EventType.AccountSaved, 'account', { fields: ['secret'] }],
    ]);
    expect(JSON.stringify(events)).not.toContain('0123456789abcdef');
    expect(getAccount(store.db, key.id).secretSet).toBe(true);
  });

  it.each<{
    name: string;
    act: (id: AccountId) => void;
    error: typeof InvalidError | typeof ConflictError;
  }>([
    {
      name: 'a monthly cap on a subscription',
      act: (id) => store.write((ctx) => patchAccount(ctx, id, { monthlyCapUsd: 10 })),
      error: InvalidError,
    },
    {
      name: 'an expected identity that is not an email on a subscription',
      act: (id) => store.write((ctx) => patchAccount(ctx, id, { expectedIdentity: 'org-1' })),
      error: InvalidError,
    },
    {
      name: 'gateway settings on a subscription',
      act: (id) =>
        store.write((ctx) => patchAccount(ctx, id, { settings: { baseUrl: 'https://g.example' } })),
      error: InvalidError,
    },
    {
      name: 'a secret on a subscription',
      act: (id) => store.write((ctx) => recordAccountSecret(ctx, id, 'sha256:0000000000000000')),
      error: InvalidError,
    },
    {
      name: 'a label another account has',
      act: (id) => {
        apiKey('Taken');
        store.write((ctx) => patchAccount(ctx, id, { label: 'Taken' }));
      },
      error: ConflictError,
    },
  ])('refuses $name', ({ act, error }) => {
    const sub = seedAccount(store, { kind: 'claude_subscription', label: 'Company A' });
    expect(() => {
      act(sub.id);
    }).toThrow(error);
  });

  it('turns a Bedrock account to a bearer token and back, keeping the secret only while it needs one', () => {
    const bedrock = seedAccount(store, {
      kind: 'bedrock',
      label: 'Client C',
      settings: { region: 'us-west-2', awsProfile: 'client-c' },
    });
    expect(getAccountRow(store.db, bedrock.id).secretRef).toBeNull();
    store.write((ctx) =>
      patchAccount(ctx, bedrock.id, { settings: { region: 'us-west-2', awsProfile: null } }),
    );
    store.write((ctx) => recordAccountSecret(ctx, bedrock.id, 'sha256:1111111111111111'));
    expect(getAccount(store.db, bedrock.id).secretSet).toBe(true);
    store.write((ctx) =>
      patchAccount(ctx, bedrock.id, { settings: { region: 'us-west-2', awsProfile: 'p' } }),
    );
    expect(getAccountRow(store.db, bedrock.id)).toMatchObject({
      secretRef: null,
      secretFingerprint: null,
    });
  });

  it('archives an unused account, but not the default or one a project binds', () => {
    const project = seedProject(store);
    const defaultId = defaultAccountId(store.db);
    if (!defaultId) throw new Error('seedProject seeds the default account');
    expect(() => store.write((ctx) => archiveAccount(ctx, defaultId))).toThrow(ConflictError);
    const key = apiKey();
    store.write((ctx) => patchProject(ctx, project.id, { accountId: key.id }));
    expect(() => store.write((ctx) => archiveAccount(ctx, key.id))).toThrow(/demo/);
    const spare = apiKey('Spare');
    expect(store.write((ctx) => archiveAccount(ctx, spare.id)).value.archived).toBe(true);
    expect(listAccounts(store.db).map((a) => a.label)).not.toContain('Spare');
    expect(listAccounts(store.db, { includeArchived: true }).map((a) => a.label)).toContain(
      'Spare',
    );
    expect(() => store.write((ctx) => patchAccount(ctx, spare.id, { payer: 'x' }))).toThrow(
      ConflictError,
    );
  });

  it('throws NotFoundError for an unknown account', () => {
    expect(() => getAccount(store.db, mintId('Account'))).toThrow(NotFoundError);
  });
});

describe('projects on accounts', () => {
  it('binds a new project to the default account, or the one it names', () => {
    const plain = seedProject(store);
    expect(plain.accountId).toBe(defaultAccountId(store.db));
    expect(getAccount(store.db, plain.accountId).expectedIdentity).toBe(TEST_ACCOUNT_EMAIL);
    const key = apiKey();
    expect(seedProject(store, { accountId: key.id }).accountId).toBe(key.id);
  });

  it('still binds the default account when a non-default account was created first', () => {
    apiKey();
    const project = seedProject(store);
    const defaultId = defaultAccountId(store.db);
    expect(defaultId).not.toBeNull();
    expect(project.accountId).toBe(defaultId);
  });

  it('moves a project with work in flight, but never to an archived or unknown account', () => {
    const project = seedProject(store);
    const key = apiKey();
    const spare = apiKey('Spare');
    store.write((ctx) => archiveAccount(ctx, spare.id));
    expect(() =>
      store.write((ctx) => patchProject(ctx, project.id, { accountId: spare.id })),
    ).toThrow(InvalidError);
    expect(() =>
      store.write((ctx) => patchProject(ctx, project.id, { accountId: mintId('Account') })),
    ).toThrow(NotFoundError);
    store.write((ctx) => {
      const task = insertTask(ctx, project.id, {
        title: 't',
        acceptanceCriteria: ['x'],
        areas: ['api'],
      });
      const ws = insertWorkstream(ctx, task.id);
      transitionWorkstream(ctx, ws.id, { to: 'STARTING', fence: null });
    });
    store.write((ctx) => patchProject(ctx, project.id, { accountId: key.id }));
    expect(getProject(store.db, project.id).accountId).toBe(key.id);
  });

  it('counts lanes per account', () => {
    const key = apiKey();
    const a = seedProject(store, { accountId: key.id });
    const b = seedProject(store, { accountId: key.id });
    for (const project of [a, b]) {
      store.write((ctx) => {
        const task = insertTask(ctx, project.id, {
          title: 't',
          acceptanceCriteria: ['x'],
          areas: ['api'],
        });
        const ws = insertWorkstream(ctx, task.id);
        transitionWorkstream(ctx, ws.id, { to: 'STARTING', fence: null });
      });
    }
    expect(countLanes(store.db).byAccount.get(key.id)).toBe(2);
  });
});

describe('usage', () => {
  it('records the account a session launches on, which a move may have made differ from the project', () => {
    const project = seedProject(store);
    const key = apiKey();
    const session = store.write((ctx) => {
      const task = insertTask(ctx, project.id, {
        title: 'launched before the move',
        acceptanceCriteria: ['x'],
        areas: ['api'],
      });
      return insertSession(ctx, {
        workstreamId: insertWorkstream(ctx, task.id).id,
        accountId: key.id,
        provider: 'claude',
        model: 'sonnet',
        effort: 'medium',
        mode: 'managed',
        mcpTokenHash: 'hash-launched',
      });
    }).value;
    expect(session).toMatchObject({ accountId: key.id, costUsd: 0 });
  });

  it('records the account a session ran on, and no dollars on a subscription', () => {
    const project = seedProject(store);
    const session = spend(
      project,
      { inputTokens: 100, outputTokens: 10, cachedTokens: 50, costUsd: 0.4 },
      new Date(2026, 9, 2),
    );
    expect(session.accountId).toBe(project.accountId);
    expect(getSession(store.db, session.id).costUsd).toBeNull();
    expect(accountSpendUsd(store.db, project.accountId, OCTOBER)).toBe(0);
    const usage = accountUsage(store.db, project.accountId, OCTOBER);
    expect(usage.total).toEqual({ tokensIn: 100, tokensOut: 10, tokensCached: 50, costUsd: null });
  });

  it('sums a metered account in the month the sessions started, in total and per project', () => {
    const key = apiKey();
    const a = seedProject(store, { name: 'alpha', accountId: key.id });
    const b = seedProject(store, { name: 'beta', accountId: key.id });
    const u = (n: number) => ({
      inputTokens: n,
      outputTokens: n,
      cachedTokens: n,
      costUsd: n / 100,
    });
    spend(a, u(100), new Date(2026, 9, 1, 0, 0));
    spend(a, u(50), new Date(2026, 9, 31, 23, 59));
    spend(b, u(10), new Date(2026, 9, 10));
    spend(b, u(999), new Date(2026, 8, 30, 23, 59));
    spend(b, u(999), new Date(2026, 10, 1, 0, 0));
    const usage = accountUsage(store.db, key.id, OCTOBER);
    expect(usage.month).toBe('2026-10');
    expect(usage.monthlyCapUsd).toBe(500);
    expect(usage.total.tokensIn).toBe(160);
    expect(usage.total.costUsd).toBeCloseTo(1.6);
    expect(usage.byProject.map((p) => [p.projectName, p.tokensIn])).toEqual([
      ['alpha', 150],
      ['beta', 10],
    ]);
    expect(accountSpendUsd(store.db, key.id, OCTOBER)).toBeCloseTo(1.6);
  });

  it('counts a session under the account it ran on, even after the project moved', () => {
    const key = apiKey();
    const other = apiKey('Other');
    const project = seedProject(store, { accountId: key.id });
    spend(
      project,
      { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 2 },
      new Date(2026, 9, 3),
    );
    store.write((ctx) => patchProject(ctx, project.id, { accountId: other.id }));
    expect(accountSpendUsd(store.db, key.id, OCTOBER)).toBe(2);
    expect(accountSpendUsd(store.db, other.id, OCTOBER)).toBe(0);
  });
});
