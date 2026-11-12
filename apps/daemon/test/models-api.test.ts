import {
  AccountCreatedDto,
  AccountDto,
  AccountModelDto,
  CatalogueAttempt,
  CatalogueSource,
  CatalogueStatusDto,
  mintId,
  ModelRowDto,
  RolePicksDto,
  type Effort,
} from '@10db/contracts';
import { findModelProfile, listAccountModels, replaceAccountModels } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { measureForTests } from './catalogue';
import { tempDir, waitFor } from './fixtures';
import { readModelsDevFixture } from './models-dev-fixture';

const QUIET = { caffeinate: () => null, watch: false } as const;
const EFFORTS: Effort[] = ['low', 'high'];

let data: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
let fetches: number;
beforeEach(() => {
  data = tempDir('models api');
  daemon = null;
  fetches = 0;
});
afterEach(async () => {
  await daemon?.stop();
  data.cleanup();
});

/** A daemon whose one account lists the models given, against the committed catalogue fixture. */
async function start(
  models: { id: string; resolvedId: string }[],
  opts: { catalogueSync?: boolean; offline?: { value: boolean } } = {},
) {
  const adapter = new FakeAdapter({});
  adapter.probeSeen = {
    ...adapter.probeSeen,
    models: models.map((m) => ({ ...m, efforts: EFFORTS })),
  };
  const running = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter,
    logLevel: 'warn',
    ...QUIET,
    catalogueSync: opts.catalogueSync ?? true,
    fetch: () => {
      fetches += 1;
      if (opts.offline?.value === true) return Promise.reject(new Error('offline'));
      return Promise.resolve(new Response(JSON.stringify(readModelsDevFixture())));
    },
  });
  daemon = running;
  if (opts.catalogueSync !== false)
    await waitFor(() =>
      models.length > 0
        ? listAccountModels(running.state.db).length > 0
        : findModelProfile(running.state.db, 'claude', 'claude-opus-5-5', 'high') !== undefined,
    );
  return { running, api: apiClient(running.url, running.token) };
}

describe('the model list over HTTP', () => {
  it('answers one row per model, merging its efforts, and none for the seeded aliases', async () => {
    const { api } = await start([{ id: 'opus', resolvedId: 'claude-opus-5-5' }]);
    const rows = await api.get('/models', z.array(ModelRowDto));
    // The seeded profiles (opus, sonnet, ...) carry no catalogue fields and no account lists them.
    expect(rows.map((r) => r.model)).toEqual(['claude-opus-5-5']);
    expect(rows[0]).toMatchObject({
      maker: 'anthropic',
      tier: 'strongest',
      status: 'current',
      outputPrice: 20,
      intelligence: null,
    });
    expect(rows[0]?.availableOn).toHaveLength(1);
  });

  it('prices the list on an account, one line per effort, and refuses a bad or archived account', async () => {
    const { running, api } = await start([{ id: 'opus', resolvedId: 'claude-opus-5-5' }]);
    const [account] = await api.get('/accounts', z.array(AccountDto));
    if (!account) throw new Error('the daemon has no default account');
    // The account's stored list names only `low`; the model has a profile at every effort.
    running.state.write((ctx) => {
      replaceAccountModels(
        ctx,
        account.id,
        listAccountModels(ctx.tx, account.id).map((m) => ({
          model: m.model,
          family: m.family,
          launchId: m.launchId,
          efforts: ['low'],
          inputPrice: m.inputPrice,
          outputPrice: m.outputPrice,
        })),
      );
    });
    const efforts = async (path: string) =>
      (await api.get(path, z.array(ModelRowDto)))
        .find((r) => r.model === 'claude-opus-5-5')
        ?.efforts.map((e) => e.effort)
        .sort();
    expect(await efforts(`/models?account=${account.id}`)).toEqual(['low']);
    expect(await efforts('/models')).toEqual(['high', 'low', 'max', 'medium', 'xhigh']);

    await expect(api.get('/models?account=nope', z.array(ModelRowDto))).rejects.toThrow('-> 400');
    await expect(
      api.get(`/models?account=${mintId('Account')}`, z.array(ModelRowDto)),
    ).rejects.toThrow('-> 404');

    const { account: spare } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'codex_signin',
      label: 'Spare',
    });
    await api.post(`/accounts/${spare.id}/archive`, z.unknown());
    await expect(api.get(`/models?account=${spare.id}`, z.array(ModelRowDto))).rejects.toThrow(
      '-> 404',
    );
  });

  it('answers what routing picks for each role on an account, and refuses a bad or archived one', async () => {
    const { running, api } = await start([{ id: 'opus', resolvedId: 'claude-opus-5-5' }]);
    // Invented measurements: low scores 45, high 51, so the roles that need 48 are the ones that go up.
    measureForTests(running.state);
    const [account] = await api.get('/accounts', z.array(AccountDto));
    if (!account) throw new Error('the daemon has no default account');
    const { accountId, picks } = await api.get(`/models/picks?account=${account.id}`, RolePicksDto);
    expect(accountId).toBe(account.id);
    expect(picks.map((p) => `${p.role}:${String(p.model)}@${String(p.effort)}`)).toEqual([
      'plan:claude-opus-5-5@low',
      'plan_review:claude-opus-5-5@high',
      'implement:claude-opus-5-5@low',
      'review:claude-opus-5-5@high',
      'qa:claude-opus-5-5@low',
    ]);
    expect(picks[0]).toMatchObject({ intelligence: 45, costPerTaskUsd: 1 });

    await expect(api.get('/models/picks', RolePicksDto)).rejects.toThrow('-> 400');
    await expect(api.get('/models/picks?account=nope', RolePicksDto)).rejects.toThrow('-> 400');
    await expect(
      api.get(`/models/picks?account=${mintId('Account')}`, RolePicksDto),
    ).rejects.toThrow('-> 404');
    const { account: spare } = await api.post('/accounts', AccountCreatedDto, {
      kind: 'codex_signin',
      label: 'Spare',
    });
    await api.post(`/accounts/${spare.id}/archive`, z.unknown());
    await expect(api.get(`/models/picks?account=${spare.id}`, RolePicksDto)).rejects.toThrow(
      '-> 404',
    );
  });

  it('lists the maker’s models as available on an account whose list has not been read', async () => {
    const { running, api } = await start([]);
    expect(listAccountModels(running.state.db)).toEqual([]);
    const rows = await api.get('/models', z.array(ModelRowDto));
    const opus = rows.find((r) => r.model === 'claude-opus-5-5');
    expect(opus).toMatchObject({ status: 'current', tier: 'strongest' });
    expect(opus?.availableOn).toHaveLength(1);
  });

  it('lists a model an account reports that the catalogue does not know, as Unknown', async () => {
    const { api } = await start([{ id: 'house', resolvedId: 'house-model' }]);
    const rows = await api.get('/models', z.array(ModelRowDto));
    expect(rows).toEqual([
      expect.objectContaining({
        model: 'house-model',
        name: 'house-model',
        maker: null,
        tier: null,
        status: 'unknown',
        inputPrice: null,
      }),
    ]);
  });

  it('answers each account offer with its launch ID and own price', async () => {
    const { api } = await start([{ id: 'opus', resolvedId: 'claude-opus-5-5' }]);
    const offers = await api.get('/models/offers', z.array(AccountModelDto));
    expect(offers).toEqual([
      expect.objectContaining({ model: 'claude-opus-5-5', launchId: 'claude-opus-5-5' }),
    ]);
  });

  it('says where the catalogue came from and how many models it holds', async () => {
    const { api } = await start([{ id: 'opus', resolvedId: 'claude-opus-5-5' }]);
    const status = await api.get('/models/status', CatalogueStatusDto);
    expect(status.source).toBe(CatalogueSource.Fetched);
    expect(status.fetchedAt).not.toBeNull();
    expect(status.models).toBeGreaterThan(0);
    expect(status.lastAttempt).toBe(CatalogueAttempt.Succeeded);
  });

  it('says a refresh failed, keeping the copy it has', async () => {
    const offline = { value: false };
    const { api } = await start([{ id: 'opus', resolvedId: 'claude-opus-5-5' }], { offline });
    offline.value = true;
    const status = await api.post('/models/refresh', CatalogueStatusDto);
    expect(status).toMatchObject({
      source: CatalogueSource.Fetched,
      lastAttempt: CatalogueAttempt.Failed,
    });
    expect(status.fetchedAt).not.toBeNull();
  });

  it('says the catalogue fetch is off when the daemon was started without it', async () => {
    const { api } = await start([{ id: 'opus', resolvedId: 'claude-opus-5-5' }], {
      catalogueSync: false,
    });
    expect(await api.get('/models/status', CatalogueStatusDto)).toMatchObject({
      lastAttempt: CatalogueAttempt.Off,
    });
    expect(await api.post('/models/refresh', CatalogueStatusDto)).toMatchObject({
      lastAttempt: CatalogueAttempt.Off,
    });
    expect(fetches).toBe(0);
  });

  it('refreshes on demand: fetches the catalogue again and answers its status', async () => {
    const { api } = await start([{ id: 'opus', resolvedId: 'claude-opus-5-5' }]);
    const before = fetches;
    const status = await api.post('/models/refresh', CatalogueStatusDto);
    expect(status.source).toBe(CatalogueSource.Fetched);
    expect(fetches - before).toBe(1);
  });
});
