import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCOUNT_CARD_DETAIL,
  AccountCardChoice,
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
} from '@10db/contracts';
import { insertInboxItem } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { KeychainError } from '../src/environment';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createMemoryKeychain, createTempRepo, tempDir } from './fixtures';

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

async function start(keychain = createMemoryKeychain()) {
  daemon = await startDaemon({
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    keychain,
    ...QUIET,
  });
  return {
    api: apiClient(daemon.url, daemon.token),
    keychain,
    url: daemon.url,
    token: daemon.token,
    state: daemon.state,
  };
}

describe('accounts over HTTP', () => {
  it('takes a secret into the Keychain and never returns, emits or logs it', async () => {
    const { api, keychain } = await start();
    const { account, signIn } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'gateway',
      label: 'OpenRouter',
      monthlyCapUsd: 100,
      settings: { baseUrl: 'https://openrouter.ai/api', aliases: ['haiku'] },
    });
    expect(signIn).toBeNull();
    expect(account.secretSet).toBe(false);
    const stored = await api.put(`/accounts/${account.id}/secret`, AccountDto, { secret: SECRET });
    expect(stored.secretSet).toBe(true);
    expect(keychain.read(`account:${account.id}`)).toBe(SECRET);

    const seen = [
      JSON.stringify(stored),
      JSON.stringify(await api.get('/accounts', z.array(AccountDto))),
      JSON.stringify(await api.patch(`/accounts/${account.id}`, AccountDto, { payer: 'Client B' })),
      JSON.stringify(await api.get(`/accounts/${account.id}/identity`, AccountIdentityDto)),
      JSON.stringify(await api.get(`/accounts/${account.id}/usage`, AccountUsageDto)),
      JSON.stringify(await api.get('/events?after=0&limit=1000', z.unknown())),
      JSON.stringify(await api.get('/inbox', z.unknown())),
      readFileSync(join(data.path, 'logs', 'daemon.log'), 'utf8'),
    ];
    for (const text of seen) expect(text).not.toContain('NEVER-SHOWN');
  });

  it('creates a subscription with a private config directory and a sign-in command quoting its path', async () => {
    const { api } = await start();
    const { account, signIn } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'claude_subscription',
      label: 'Company A',
    });
    const configDir = join(data.path, 'accounts', account.id, 'claude');
    expect(account.configDir).toBe(configDir);
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(data.path, 'accounts')).mode & 0o777).toBe(0o700);
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
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(configDir)).toEqual([]);
    expect(signIn).toBeNull();
  });

  it('answers 409 when the Keychain refuses the secret, and records nothing', async () => {
    const { api } = await start({
      read: () => null,
      write: (account) => {
        throw new KeychainError(
          `Writing the Keychain item ${account} failed (security exit status 36)`,
        );
      },
    });
    const { account } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'anthropic_api_key',
      label: 'Client key',
    });
    await expect(
      api.put(`/accounts/${account.id}/secret`, AccountDto, { secret: SECRET }),
    ).rejects.toThrow(/409/);
    expect(
      (await api.get('/accounts', z.array(AccountDto))).find((a) => a.id === account.id)?.secretSet,
    ).toBe(false);
  });

  it.each<[string, string, string, unknown]>([
    ['a reserved kind', 'POST', '/accounts', { kind: 'openai_api_key', label: 'x' }],
    ['a short secret', 'PUT', '/accounts/{id}/secret', { secret: 'short' }],
    ['a malformed month', 'GET', '/accounts/{id}/usage?month=2026-13', undefined],
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

  it('moves a project to another account, with work in flight too', async () => {
    const repo = createTempRepo();
    try {
      const { api } = await start();
      const project = await api.post('/projects', ProjectDto, {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
      const accounts = await api.get('/accounts', z.array(AccountDto));
      expect(accounts.map((a) => [a.label, a.isDefault])).toEqual([['Claude plan', true]]);
      expect(project.accountId).toBe(accounts[0]?.id);
      const { account } = await api.post('/accounts', AccountCreatedDto, {
        kind: 'anthropic_api_key',
        label: 'K',
      });
      const moved = await api.patch(`/projects/${project.id}`, ProjectDto, {
        accountId: account.id,
      });
      expect(moved.accountId).toBe(account.id);
      await api.post(`/projects/${project.id}/tasks`, TaskDto, {
        title: 'T',
        acceptanceCriteria: ['x'],
        areas: ['src'],
      });
      const task = (await api.get(`/projects/${project.id}/tasks`, z.array(TaskDto)))[0];
      if (!task) throw new Error('no task');
      await api.post(`/tasks/${task.id}/start`, z.unknown());
      const defaultId = accounts[0]?.id ?? '';
      // The task waits on the keyed account, which has no secret; the move takes it along.
      const back = await api.patch(`/projects/${project.id}`, ProjectDto, { accountId: defaultId });
      expect(back.accountId).toBe(defaultId);
    } finally {
      repo.cleanup();
    }
  });

  it('refuses an answer the card does not offer before acting on it', async () => {
    const repo = createTempRepo();
    try {
      const { api, state } = await start();
      const project = await api.post('/projects', ProjectDto, {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
      const { account } = await api.post('/accounts', AccountCreatedDto, {
        kind: 'anthropic_api_key',
        label: 'K',
      });
      // A keyed account's identity-mismatch card offers Resume and Later, never Confirm.
      const card = state.write((ctx) =>
        insertInboxItem(ctx, {
          projectId: project.id,
          kind: InboxKind.Flag,
          title: 'K: sessions refused',
          body: 'The organization differs.',
          options: [
            { label: AccountCardChoice.Resume, description: 'try again' },
            { label: AccountCardChoice.Later, description: 'wait' },
          ],
          recommendation: null,
          category: QuestionCategory.Other,
          urgency: Urgency.High,
          detail: {
            [ACCOUNT_CARD_DETAIL]: {
              accountId: account.id,
              reason: AccountPauseReason.Refused,
              problem: AccountProblem.IdentityMismatch,
              seenIdentity: 'other@example.com',
            },
          },
          foldKey: `account:${account.id}:refused:identity_mismatch`,
          targets: [],
        }),
      );
      const eventsBefore = JSON.stringify(await api.get('/events?after=0&limit=1000', z.unknown()));

      await expect(
        api.post(`/inbox/${card.id}/answer`, z.unknown(), { choice: AccountCardChoice.Confirm }),
      ).rejects.toThrow(/400/);

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
