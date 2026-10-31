import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCOUNT_CARD_DETAIL,
  AccountCardChoice,
  AccountCardDetail,
  AccountCreatedDto,
  AccountDto,
  AccountIdentityDto,
  AccountPauseReason,
  AccountProblem,
  AccountSignInDto,
  AccountUsageDto,
  InboxItemDto,
  InboxKind,
  InboxState,
  ProjectDto,
  QuestionCategory,
  TaskDto,
  Urgency,
  WorkstreamDto,
  WorkstreamState,
} from '@10db/contracts';
import { getAccountRow, insertInboxItem } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { KeychainError, secretFingerprint, type Keychain } from '../src/environment';
import { AccountProbeError, FAKE_ACCOUNT_EMAIL, FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createMemoryKeychain, createTempRepo, tempDir, waitForAsync } from './fixtures';

const SECRET = 'sk-or-v1-0123456789abcdef-NEVER-SHOWN';
const QUIET = { caffeinate: () => null, watch: false } as const;

let data: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
beforeEach(() => {
  data = tempDir('accounts api');
  daemon = null;
});
afterEach(async () => {
  await daemon?.stop();
  data.cleanup();
});

async function start(opts: { keychain?: Keychain; adapter?: FakeAdapter; tickMs?: number } = {}) {
  const keychain = opts.keychain ?? createMemoryKeychain();
  const adapter = opts.adapter ?? new FakeAdapter({});
  daemon = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter,
    logLevel: 'debug',
    keychain,
    ...(opts.tickMs === undefined ? {} : { tickMs: opts.tickMs }),
    ...QUIET,
  });
  return {
    api: apiClient(daemon.url, daemon.token),
    keychain,
    adapter,
    url: daemon.url,
    token: daemon.token,
    state: daemon.state,
    scheduler: daemon.scheduler,
  };
}

type Api = Awaited<ReturnType<typeof start>>['api'];

const projectBody = (repoPath: string) => ({
  name: 'demo',
  repoPath,
  gateCommand: 'true',
  areas: [{ name: 'src', globs: ['src/**'] }],
});

/** A project on `accountId` with one started task, which waits when the account can't start a session. */
async function startedTaskOn(api: Api, repoPath: string, accountId: string) {
  const project = await api.post('/projects', ProjectDto, projectBody(repoPath));
  const moved = await api.patch(`/projects/${project.id}`, ProjectDto, { accountId });
  await api.post(`/projects/${project.id}/tasks`, TaskDto, {
    title: 'T',
    acceptanceCriteria: ['x'],
    areas: ['src'],
  });
  const task = (await api.get(`/projects/${project.id}/tasks`, z.array(TaskDto)))[0];
  if (!task) throw new Error('no task');
  await api.post(`/tasks/${task.id}/start`, z.unknown());
  return { project: moved, task };
}

const workstreamOf = async (api: Api, taskId: string) =>
  (await api.get('/workstreams', z.array(WorkstreamDto))).find((w) => w.taskId === taskId);

const accountCards = async (api: Api, accountId: string, problem: string) =>
  (await api.get('/inbox', z.array(InboxItemDto))).filter((item) => {
    const detail = AccountCardDetail.safeParse(item.detail?.[ACCOUNT_CARD_DETAIL]);
    return detail.success && detail.data.accountId === accountId && detail.data.problem === problem;
  });

describe('accounts over HTTP', () => {
  it('takes a secret into the Keychain and never returns, emits, stores or logs it', async () => {
    const repo = createTempRepo();
    try {
      const { api, keychain, state } = await start();
      const { account, signIn } = await api.post('/accounts', AccountCreatedDto, {
        kind: 'gateway',
        label: 'OpenRouter',
        monthlyCapUsd: 100,
        settings: { baseUrl: 'https://openrouter.ai/api', aliases: ['haiku'] },
      });
      expect(signIn).toBeNull();
      expect(account.secretSet).toBe(false);
      // Work waiting on the account raises a card, so the inbox has something that could leak.
      await startedTaskOn(api, repo.path, account.id);
      await waitForAsync(async () =>
        (await accountCards(api, account.id, AccountProblem.SecretMissing)).length > 0
          ? true
          : undefined,
      );
      const stored = await api.put(`/accounts/${account.id}/secret`, AccountDto, {
        secret: SECRET,
      });
      expect(stored.secretSet).toBe(true);
      expect(keychain.read(`account:${account.id}`)).toBe(SECRET);
      // Only the fingerprint reaches the database.
      expect(getAccountRow(state.db, account.id).secretFingerprint).toBe(secretFingerprint(SECRET));

      const seen = [
        JSON.stringify(stored),
        JSON.stringify(await api.get('/accounts', z.array(AccountDto))),
        JSON.stringify(
          await api.patch(`/accounts/${account.id}`, AccountDto, { payer: 'Client B' }),
        ),
        JSON.stringify(await api.get(`/accounts/${account.id}/identity`, AccountIdentityDto)),
        JSON.stringify(await api.get(`/accounts/${account.id}/usage`, AccountUsageDto)),
        JSON.stringify(await api.get('/events?after=0&limit=1000', z.unknown())),
        JSON.stringify(await api.get('/inbox', z.unknown())),
      ];
      for (const text of seen) expect(text).not.toContain('NEVER-SHOWN');

      // The log and the database are read once the daemon has flushed and closed them.
      await daemon?.stop();
      const files = ['logs/daemon.log', '10db.sqlite', '10db.sqlite-wal'].map((name) =>
        join(data.path, name),
      );
      expect(files.filter(existsSync)).toContain(join(data.path, '10db.sqlite'));
      for (const file of files.filter(existsSync))
        expect(readFileSync(file).includes(SECRET), file).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('creates a subscription with a private config directory and a sign-in command quoting its path', async () => {
    const { api } = await start();
    const { account, signIn } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'claude_subscription',
      label: 'Company A',
    });
    const configDir = join(data.path, 'accounts', account.id, 'claude');
    expect(account.configDir).toBe(configDir);
    for (const dir of [
      configDir,
      join(data.path, 'accounts', account.id),
      join(data.path, 'accounts'),
    ])
      expect(statSync(dir).mode & 0o777, dir).toBe(0o700);
    expect(signIn?.command).toBe(`CLAUDE_CONFIG_DIR='${configDir}' claude /login`);
    expect(await api.get(`/accounts/${account.id}/signin`, AccountSignInDto)).toEqual(signIn);
  });

  it('gives a keyed account its own empty config directory, and no sign-in command', async () => {
    const { api } = await start();
    const { account, signIn } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'anthropic_api_key',
      label: 'Client key',
    });
    const configDir = join(data.path, 'accounts', account.id, 'claude');
    expect(account.configDir).toBe(configDir);
    for (const dir of [configDir, join(data.path, 'accounts', account.id)])
      expect(statSync(dir).mode & 0o777, dir).toBe(0o700);
    expect(readdirSync(configDir)).toEqual([]);
    expect(signIn).toBeNull();
  });

  it('answers 409 when the Keychain refuses the secret, and records nothing', async () => {
    const { api, url, token } = await start({
      keychain: {
        read: () => null,
        readAsync: () => Promise.resolve(null),
        write: (account) => {
          throw new KeychainError(
            `Writing the Keychain item ${account} failed (security exit status 36)`,
          );
        },
        remove: () => undefined,
      },
    });
    const { account } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'anthropic_api_key',
      label: 'Client key',
    });
    const res = await fetch(`${url}/accounts/${account.id}/secret`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ secret: SECRET }),
    });
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain('NEVER-SHOWN');
    expect(
      (await api.get('/accounts', z.array(AccountDto))).find((a) => a.id === account.id)?.secretSet,
    ).toBe(false);
  });

  it.each<[string, string, string, unknown]>([
    ['a reserved kind', 'POST', '/accounts', { kind: 'openai_api_key', label: 'x' }],
    ['a short secret', 'PUT', '/accounts/{id}/secret', { secret: 'short' }],
    ['a malformed month', 'GET', '/accounts/{id}/usage?month=2026-13', undefined],
    ['a repeated month', 'GET', '/accounts/{id}/usage?month=2026-10&month=2026-11', undefined],
    ['sign-in for a keyed account', 'GET', '/accounts/{id}/signin', undefined],
  ])('answers 400 for %s', async (_name, method, path, body) => {
    const { api, url, token } = await start();
    const { account } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'anthropic_api_key',
      label: 'K',
    });
    const res = await fetch(`${url}${path.replace('{id}', account.id)}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(res.status).toBe(400);
  });

  it('moves a project to another account, and the work waiting on the old one follows it', async () => {
    const repo = createTempRepo();
    try {
      // No periodic tick: only a request from the move itself can start the waiting work.
      const { api, scheduler } = await start({ tickMs: 3_600_000 });
      const accounts = await api.get('/accounts', z.array(AccountDto));
      expect(accounts.map((a) => [a.label, a.isDefault])).toEqual([['Claude plan', true]]);
      const defaultId = accounts[0]?.id ?? '';
      const { account } = await api.post('/accounts', AccountCreatedDto, {
        kind: 'anthropic_api_key',
        label: 'K',
      });
      const { project, task } = await startedTaskOn(api, repo.path, account.id);
      expect(project.accountId).toBe(account.id);
      // The keyed account has no secret, so its work is held.
      await scheduler.idle();
      expect((await workstreamOf(api, task.id))?.state).toBe(WorkstreamState.Queued);

      const back = await api.patch(`/projects/${project.id}`, ProjectDto, {
        accountId: defaultId,
      });
      expect(back.accountId).toBe(defaultId);
      const started = await waitForAsync(async () => {
        const workstream = await workstreamOf(api, task.id);
        return workstream && workstream.state !== WorkstreamState.Queued ? workstream : undefined;
      });
      expect(started.state).not.toBe(WorkstreamState.Queued);
    } finally {
      repo.cleanup();
    }
  });

  it('closes the secret-missing card and starts the work when the secret is saved', async () => {
    const repo = createTempRepo();
    try {
      const { api, scheduler } = await start({ tickMs: 3_600_000 });
      const { account } = await api.post('/accounts', AccountCreatedDto, {
        kind: 'anthropic_api_key',
        label: 'K',
      });
      const { task } = await startedTaskOn(api, repo.path, account.id);
      const card = await waitForAsync(async () => {
        const open = (await accountCards(api, account.id, AccountProblem.SecretMissing)).find(
          (item) => item.state === InboxState.Open,
        );
        return open ?? undefined;
      });
      await scheduler.idle();
      expect((await workstreamOf(api, task.id))?.state).toBe(WorkstreamState.Queued);

      await api.put(`/accounts/${account.id}/secret`, AccountDto, { secret: SECRET });

      const items = await api.get('/inbox', z.array(InboxItemDto));
      expect(items.find((i) => i.id === card.id)?.state).not.toBe(InboxState.Open);
      const started = await waitForAsync(async () => {
        const workstream = await workstreamOf(api, task.id);
        return workstream && workstream.state !== WorkstreamState.Queued ? workstream : undefined;
      });
      expect(started.state).not.toBe(WorkstreamState.Queued);
    } finally {
      repo.cleanup();
    }
  });

  it('confirms a new subscription from its Confirm card and starts the work waiting on it', async () => {
    const repo = createTempRepo();
    try {
      const { api } = await start();
      const { account } = await api.post('/accounts', AccountCreatedDto, {
        kind: 'claude_subscription',
        label: 'Company A',
      });
      const { task } = await startedTaskOn(api, repo.path, account.id);
      const card = await waitForAsync(async () => {
        const open = (await accountCards(api, account.id, AccountProblem.Unconfirmed)).find(
          (item) => item.state === InboxState.Open,
        );
        return open ?? undefined;
      });
      const seen = AccountCardDetail.parse(card.detail?.[ACCOUNT_CARD_DETAIL]).seenIdentity;

      const answered = await api.post(`/inbox/${card.id}/answer`, InboxItemDto, {
        choice: AccountCardChoice.Confirm,
      });

      expect(answered).toMatchObject({ state: InboxState.Resolved, answer: { choice: 'Confirm' } });
      const after = (await api.get('/accounts', z.array(AccountDto))).find(
        (a) => a.id === account.id,
      );
      expect(after?.expectedIdentity).toBe(seen);
      const started = await waitForAsync(async () => {
        const workstream = await workstreamOf(api, task.id);
        return workstream && workstream.state !== WorkstreamState.Queued ? workstream : undefined;
      });
      expect(started.state).not.toBe(WorkstreamState.Queued);
    } finally {
      repo.cleanup();
    }
  });

  const AnyCard = {
    options: [
      { label: AccountCardChoice.Resume, description: 'try again' },
      { label: AccountCardChoice.Later, description: 'wait' },
    ],
    reason: AccountPauseReason.Refused,
    problem: AccountProblem.IdentityMismatch,
  };
  it.each([
    {
      name: 'Confirm on a keyed identity-mismatch card that offers Resume and Later',
      ...AnyCard,
      choice: AccountCardChoice.Confirm,
    },
    {
      name: 'Confirm on the recorded-identity card, which offers nothing',
      options: [],
      reason: null,
      problem: null,
      choice: AccountCardChoice.Confirm,
    },
    {
      name: 'Resume on the secret card, which offers nothing',
      options: [],
      reason: null,
      problem: AccountProblem.SecretMissing,
      choice: AccountCardChoice.Resume,
    },
    {
      name: 'Resume on a monthly-cap card, which offers nothing',
      options: [],
      reason: AccountPauseReason.MonthlyCap,
      problem: null,
      choice: AccountCardChoice.Resume,
    },
  ])('refuses $name, before acting on it', async ({ options, reason, problem, choice }) => {
    const repo = createTempRepo();
    try {
      const { api, state } = await start();
      const project = await api.post('/projects', ProjectDto, projectBody(repo.path));
      const { account } = await api.post('/accounts', AccountCreatedDto, {
        kind: 'anthropic_api_key',
        label: 'K',
      });
      const card = state.write((ctx) =>
        insertInboxItem(ctx, {
          projectId: project.id,
          kind: InboxKind.Flag,
          title: 'K: a card',
          body: 'Something about the account.',
          options,
          recommendation: null,
          category: QuestionCategory.Other,
          urgency: Urgency.High,
          detail: {
            [ACCOUNT_CARD_DETAIL]: {
              accountId: account.id,
              reason,
              problem,
              seenIdentity: 'other@example.com',
            },
          },
          foldKey: `account:${account.id}:card`,
          targets: [],
        }),
      );
      const eventsBefore = JSON.stringify(await api.get('/events?after=0&limit=1000', z.unknown()));

      await expect(api.post(`/inbox/${card.id}/answer`, z.unknown(), { choice })).rejects.toThrow(
        /400/,
      );

      const after = (await api.get('/accounts', z.array(AccountDto))).find(
        (a) => a.id === account.id,
      );
      expect(after?.expectedIdentity).toBeNull();
      const items = await api.get('/inbox', z.array(InboxItemDto));
      expect(items.find((i) => i.id === card.id)?.state).toBe(InboxState.Open);
      expect(JSON.stringify(await api.get('/events?after=0&limit=1000', z.unknown()))).toBe(
        eventsBefore,
      );
    } finally {
      repo.cleanup();
    }
  });
});

describe('account identity over HTTP', () => {
  const identityOf = async (api: Api, id: string) =>
    api.get(`/accounts/${id}/identity`, AccountIdentityDto);

  it('reports a fresh subscription as seen but unconfirmed', async () => {
    const { api, adapter } = await start();
    const { account } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'claude_subscription',
      label: 'Company A',
    });
    const identity = await identityOf(api, account.id);
    expect(identity.email).toBe(FAKE_ACCOUNT_EMAIL);
    expect(identity.subscription).toBe(true);
    expect(identity.refusal).toMatchObject({
      problem: AccountProblem.Unconfirmed,
      seenIdentity: FAKE_ACCOUNT_EMAIL,
    });
    expect(adapter.probes).toHaveLength(1);
  });

  it('reports a confirmed subscription with no refusal', async () => {
    const { api } = await start();
    const { account } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'claude_subscription',
      label: 'Company A',
    });
    await api.patch(`/accounts/${account.id}`, AccountDto, {
      expectedIdentity: FAKE_ACCOUNT_EMAIL,
    });
    const identity = await identityOf(api, account.id);
    expect(identity.email).toBe(FAKE_ACCOUNT_EMAIL);
    expect(identity.refusal).toBeNull();
  });

  it('refuses a keyed account with no secret without starting Claude Code', async () => {
    const { api, adapter } = await start();
    const { account } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'anthropic_api_key',
      label: 'Client key',
    });
    const identity = await identityOf(api, account.id);
    expect(identity.refusal).toMatchObject({ problem: AccountProblem.SecretMissing });
    expect(identity.email).toBeNull();
    expect(adapter.probes).toEqual([]);
  });

  it('answers 409 when Claude Code reports no account', async () => {
    const adapter = new FakeAdapter({});
    adapter.probeAccount = () => Promise.reject(new AccountProbeError('no account in time'));
    const { api, url, token } = await start({ adapter });
    const { account } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'claude_subscription',
      label: 'Company A',
    });
    const res = await fetch(`${url}/accounts/${account.id}/identity`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(409);
  });

  it('answers 409 when the Keychain is locked', async () => {
    let locked = false;
    const memory = createMemoryKeychain();
    const { api, url, token } = await start({
      keychain: {
        write: (name, secret) => {
          memory.write(name, secret);
        },
        remove: (name) => {
          memory.remove(name);
        },
        read: (name) => {
          if (locked)
            throw new KeychainError('Reading the Keychain failed (security exit status 51)');
          return memory.read(name);
        },
        readAsync: (name) => Promise.resolve(memory.read(name)),
      },
    });
    const { account } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'anthropic_api_key',
      label: 'Client key',
    });
    await api.put(`/accounts/${account.id}/secret`, AccountDto, { secret: SECRET });
    locked = true;
    const res = await fetch(`${url}/accounts/${account.id}/identity`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain('NEVER-SHOWN');
  });

  it('lets a bug in the probe surface as a server error, not a conflict', async () => {
    const adapter = new FakeAdapter({});
    adapter.probeAccount = () => Promise.reject(new TypeError('programming error'));
    const { api, url, token } = await start({ adapter });
    const { account } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'claude_subscription',
      label: 'Company A',
    });
    const res = await fetch(`${url}/accounts/${account.id}/identity`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(500);
  });
});
