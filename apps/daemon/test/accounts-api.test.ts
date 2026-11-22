import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCOUNT_CARD_DETAIL,
  AccountCardDetail,
  AccountCreatedDto,
  AccountDto,
  AccountIdentityDto,
  AccountProblem,
  AccountSignInDto,
  AccountUsageDto,
  InboxItemDto,
  ProjectDto,
  TaskDto,
} from '@10db/contracts';
import { getAccountRow } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { secretFingerprint, type Keychain } from '../src/environment';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createMemoryKeychain, createTempRepo, tempDir, waitForAsync } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

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

async function start(
  opts: {
    keychain?: Keychain;
    adapter?: FakeAdapter;
    tickMs?: number;
    loginEnv?: Record<string, string>;
  } = {},
) {
  const keychain = opts.keychain ?? createMemoryKeychain();
  const adapter = opts.adapter ?? new FakeAdapter({});
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter,
    logLevel: 'debug',
    keychain,
    ...(opts.tickMs === undefined ? {} : { tickMs: opts.tickMs }),
    ...(opts.loginEnv === undefined ? {} : { loginEnv: opts.loginEnv }),
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
        kind: 'anthropic_api_key',
        label: 'API key',
        monthlyCapUsd: 100,
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
});
