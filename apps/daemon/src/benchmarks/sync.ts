import { BenchmarkStatusDto, type AaModelDto, type ModelProfileDto } from '@10db/contracts';
import {
  applyAaMeasurement,
  getAppSetting,
  listAaModels,
  listModelProfiles,
  replaceAaModels,
  setAppSetting,
} from '@10db/db';
import type { z } from 'zod';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { fetchAaModels } from './aa-client';

/** A daily sync stays far inside the free tier's 100 requests a day. */
export const AA_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

const STATUS_KEY = 'benchmarks.status';
/** Everything but the model count is recorded at sync time, so reading the status never touches the Keychain. */
const StoredStatus = BenchmarkStatusDto.omit({ models: true });
type StoredStatus = z.infer<typeof StoredStatus>;
const NEVER: StoredStatus = {
  keyConfigured: false,
  lastSyncAt: null,
  lastSuccessAt: null,
  outcome: null,
  message: null,
  unmeasuredProfiles: [],
};

export interface BenchmarkSyncDeps {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly fetch: typeof fetch;
  /** The builder's AA key, read fresh for every sync; null when there is none. */
  readonly readKey: () => string | null;
  readonly logger: Logger;
}

export interface BenchmarkSync {
  status(): BenchmarkStatusDto;
  /** One sync; a sync already running is joined, not repeated. It never rejects. */
  sync(): Promise<BenchmarkStatusDto>;
  /** Syncs now if the last success is a day old, then once a day. */
  start(): void;
  stop(): void;
}

function measurement(model: AaModelDto) {
  const e = model.evaluations;
  return {
    scores: {
      intelligence: e['artificial_analysis_intelligence_index'] ?? null,
      coding: e['artificial_analysis_coding_index'] ?? null,
      agentic: e['artificial_analysis_agentic_index'] ?? null,
    },
    costPerTaskUsd: model.costPerTaskUsd,
    outputTokensPerSecond: model.performance['median_output_tokens_per_second'] ?? null,
    indexVersion: model.indexVersion,
    measuredAt: model.fetchedAt,
  };
}

/** A profile the router can use for at least one role: a cost and some score. */
const measured = (p: ModelProfileDto) =>
  p.costPerTaskUsd !== null &&
  (p.scores.intelligence !== null || p.scores.coding !== null || p.scores.agentic !== null);

export function createBenchmarkSync(deps: BenchmarkSyncDeps): BenchmarkSync {
  const { state } = deps;
  let running: Promise<BenchmarkStatusDto> | null = null;
  let timer: Timer | null = null;
  let stopped = false;

  const stored = (): StoredStatus => {
    const parsed = StoredStatus.safeParse(getAppSetting(state.db, STATUS_KEY));
    return parsed.success ? parsed.data : NEVER;
  };
  const status = (): BenchmarkStatusDto => ({ ...stored(), models: listAaModels(state.db).length });
  /** Records the outcome; if even that write fails, the status is returned unrecorded. */
  const record = (next: Partial<StoredStatus>): BenchmarkStatusDto => {
    const merged = { ...stored(), ...next };
    try {
      state.write((ctx) => {
        setAppSetting(ctx, STATUS_KEY, merged);
      });
    } catch (error) {
      deps.logger.error(
        { err: error instanceof Error ? error.name : 'error' },
        'could not record the benchmark status',
      );
    }
    return { ...merged, models: listAaModels(state.db).length };
  };

  async function attempt(now: string): Promise<BenchmarkStatusDto> {
    const key = deps.readKey();
    if (key === null)
      return record({
        keyConfigured: false,
        lastSyncAt: now,
        outcome: 'no_key',
        message: 'Add an Artificial Analysis key to route by score',
      });
    const outcome = await fetchAaModels({ fetch: deps.fetch, key, now });
    if (outcome.kind !== 'ok') {
      deps.logger.warn({ outcome: outcome.kind }, 'artificial analysis sync failed');
      return record({
        keyConfigured: true,
        lastSyncAt: now,
        outcome: outcome.kind,
        message: outcome.message,
      });
    }
    if (outcome.models.length === 0)
      return record({
        keyConfigured: true,
        lastSyncAt: now,
        outcome: 'failed',
        message: 'Artificial Analysis returned no models; keeping the last list',
      });
    const bySlug = new Map(outcome.models.map((m) => [m.slug, m]));
    state.write((ctx) => {
      replaceAaModels(ctx, outcome.models);
      for (const profile of listModelProfiles(ctx.tx)) {
        const model = profile.aaSlug ? bySlug.get(profile.aaSlug) : undefined;
        if (model) applyAaMeasurement(ctx, profile.id, measurement(model));
      }
    });
    const unmeasuredProfiles = listModelProfiles(state.db)
      .filter((p) => p.enabled && !measured(p))
      .map((p) => `${p.model}@${p.effort}`);
    deps.logger.info(
      { models: outcome.models.length, unmeasured: unmeasuredProfiles.length },
      'artificial analysis synced',
    );
    return record({
      keyConfigured: true,
      lastSyncAt: now,
      lastSuccessAt: now,
      outcome: 'ok',
      message: `${String(outcome.models.length)} models`,
      unmeasuredProfiles,
    });
  }

  /** A failure anywhere (the Keychain, the network, the database) becomes a status, never a rejection. */
  async function run(): Promise<BenchmarkStatusDto> {
    const now = deps.clock.now().toISOString();
    try {
      return await attempt(now);
    } catch (error) {
      const name = error instanceof Error ? error.name : 'error';
      deps.logger.error({ err: name }, 'artificial analysis sync failed');
      return record({
        lastSyncAt: now,
        outcome: 'failed',
        message: `The sync failed (${name}); keeping the last data`,
      });
    }
  }

  const sync = (): Promise<BenchmarkStatusDto> => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = deps.clock.setTimeout(() => {
      void sync().then(() => {
        schedule(AA_SYNC_INTERVAL_MS);
      });
    }, ms);
  };

  return {
    status,
    sync,
    start() {
      stopped = false;
      const last = stored().lastSuccessAt;
      const age = last === null ? Infinity : deps.clock.now().getTime() - Date.parse(last);
      if (age >= AA_SYNC_INTERVAL_MS) {
        void sync();
        schedule(AA_SYNC_INTERVAL_MS);
      } else {
        schedule(AA_SYNC_INTERVAL_MS - age);
      }
    },
    stop() {
      stopped = true;
      timer?.cancel();
      timer = null;
    },
  };
}
