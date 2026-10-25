import {
  BenchmarkStatusDto,
  ScoreKind,
  type AaModelDto,
  type ModelProfileDto,
} from '@10db/contracts';
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
/** The wait before the retry after one failure; each further failure in a row doubles it, up to the cap. */
const AA_RETRY_BASE_MS = 15 * 60 * 1000;
const AA_RETRY_CAP_MS = 6 * 60 * 60 * 1000;

/** The wait before the retry that follows `failures` failures in a row. */
function retryDelayMs(failures: number): number {
  return Math.min(AA_RETRY_BASE_MS * 2 ** (failures - 1), AA_RETRY_CAP_MS);
}

/** The outcomes that keep the last good data and retry on the backoff. */
const isFailure = (outcome: BenchmarkStatusDto['outcome']): boolean =>
  outcome === 'unauthorized' || outcome === 'rate_limited' || outcome === 'failed';

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
  missingScores: [],
  indexVersion: null,
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
  /**
   * Syncs now if the last sync failed or the last success is a day old. Then the next sync is a day after
   * a good one, and after a failure the backoff, which a later sync replaces.
   */
  start(): void;
  /** Cancels the pending sync; a sync already running finishes without scheduling another. */
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

/** Clears a profile AA no longer lists, so a stale score can't keep routing steps. */
const unmeasured = (now: string) => ({
  scores: { intelligence: null, coding: null, agentic: null },
  costPerTaskUsd: null,
  outputTokensPerSecond: null,
  indexVersion: null,
  measuredAt: now,
});

const profileName = (p: ModelProfileDto) => `${p.model}@${p.effort}`;

/** A profile routing can use for the Intelligence comparison: a cost and an Intelligence score. */
const routable = (p: ModelProfileDto) =>
  p.costPerTaskUsd !== null && p.scores.intelligence !== null;

/** The score kinds AA gave no value for. */
const missingKinds = (p: ModelProfileDto) =>
  Object.values(ScoreKind).filter((kind) => p.scores[kind] === null);

/** The major part of AA's `major.minor` index version. */
const majorOf = (version: string): string => version.split('.')[0] ?? version;

export function createBenchmarkSync(deps: BenchmarkSyncDeps): BenchmarkSync {
  const { state } = deps;
  let running: Promise<BenchmarkStatusDto> | null = null;
  let timer: Timer | null = null;
  let active = false;
  /** Failures in a row; the next wait grows with it and a good sync resets it. */
  let failures = 0;

  /** The latest status this process computed, used when the database can't be read or written. */
  let remembered: StoredStatus = NEVER;

  const stored = (): StoredStatus => {
    try {
      const parsed = StoredStatus.safeParse(getAppSetting(state.db, STATUS_KEY));
      return parsed.success ? parsed.data : remembered;
    } catch {
      return remembered;
    }
  };
  const modelCount = (): number => {
    try {
      return listAaModels(state.db).length;
    } catch {
      return 0;
    }
  };
  const status = (): BenchmarkStatusDto => ({ ...stored(), models: modelCount() });
  /**
   * Records the outcome and re-arms the timer for it, so the timer and the status move together. A database
   * that can't be read or written leaves the status in memory only.
   */
  const record = (next: Partial<StoredStatus>): BenchmarkStatusDto => {
    const merged = { ...stored(), ...next };
    remembered = merged;
    failures = isFailure(merged.outcome) ? failures + 1 : 0;
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
    rearm();
    return { ...merged, models: modelCount() };
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
        else applyAaMeasurement(ctx, profile.id, unmeasured(now));
      }
    });
    const enabled = listModelProfiles(state.db).filter((p) => p.enabled);
    const unmeasuredProfiles = enabled.filter((p) => !routable(p)).map(profileName);
    const missingScores = enabled
      .filter((p) => p.costPerTaskUsd !== null)
      .map((p) => ({ profile: profileName(p), kinds: missingKinds(p) }))
      .filter((m) => m.kinds.length > 0);
    deps.logger.info(
      {
        models: outcome.models.length,
        unmeasured: unmeasuredProfiles.length,
        missingScores: missingScores.length,
      },
      'artificial analysis synced',
    );
    const indexVersion = outcome.models.find((m) => m.indexVersion !== null)?.indexVersion ?? null;
    const before = stored().indexVersion;
    let versionNote = '';
    if (before !== null && indexVersion !== null && majorOf(before) !== majorOf(indexVersion)) {
      deps.logger.warn(
        { from: before, to: indexVersion },
        'artificial analysis index major version changed',
      );
      versionNote = `. Intelligence Index major version changed from ${majorOf(before)} to ${majorOf(indexVersion)}; review the step needs and floors.`;
    }
    return record({
      keyConfigured: true,
      lastSyncAt: now,
      lastSuccessAt: now,
      outcome: 'ok',
      message: `${String(outcome.models.length)} models${versionNote}`,
      indexVersion: indexVersion ?? before,
      unmeasuredProfiles,
      missingScores,
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

  /** `sync` never rejects; the catch is a last guard so a daemon-wide unhandled rejection can't happen. */
  const syncQuietly = (): Promise<void> =>
    sync().then(
      () => undefined,
      (error: unknown) => {
        deps.logger.error({ err: error instanceof Error ? error.name : 'error' }, 'sync failed');
      },
    );
  const schedule = (ms: number): void => {
    if (!active) return;
    timer = deps.clock.setTimeout(() => {
      void syncQuietly();
    }, ms);
  };

  /** Called from `record`, so the timer is re-armed in the same step as the status it follows. */
  const rearm = (): void => {
    timer?.cancel();
    timer = null;
    schedule(failures === 0 ? AA_SYNC_INTERVAL_MS : retryDelayMs(failures));
  };

  return {
    status,
    sync,
    start() {
      active = true;
      const last = stored();
      const age =
        last.lastSuccessAt === null
          ? Infinity
          : deps.clock.now().getTime() - Date.parse(last.lastSuccessAt);
      if (isFailure(last.outcome) || age >= AA_SYNC_INTERVAL_MS) void syncQuietly();
      else schedule(AA_SYNC_INTERVAL_MS - age);
    },
    stop() {
      active = false;
      timer?.cancel();
      timer = null;
    },
  };
}
