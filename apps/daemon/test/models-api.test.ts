import {
  AccountModelDto,
  CatalogueAttempt,
  CatalogueSource,
  CatalogueStatusDto,
  ModelRowDto,
  type Effort,
} from '@10db/contracts';
import { findModelProfile, listAccountModels } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
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
