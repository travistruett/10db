import { noOpenRouterSync, type OpenRouterSyncStatusDto } from '@10db/contracts';
import {
  endpointStatsReadAt,
  getAppSetting,
  replaceEndpointStats,
  type OpenRouterScoreInput,
  replaceOpenRouterScores,
  setAppSetting,
} from '@10db/db';
import { z } from 'zod';
import type { Catalogue } from '../catalogue';
import { joinOpenRouterId } from '../catalogue';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import {
  fetchEndpointStats,
  fetchOpenRouterModels,
  fetchOpenRouterScores,
  type OpenRouterModel,
  type OpenRouterOutcome,
  type OpenRouterScoreRow,
} from './openrouter-client';

/** OpenRouter's scores and model list are read at most this often. */
export const SCORES_EVERY_MS = 24 * 60 * 60 * 1000;
/** A model's provider speeds are read at most this often. */
export const SPEED_EVERY_MS = 60 * 60 * 1000;
/** Requests in any 60 s window; OpenRouter allows 30 a minute per key. */
export const MAX_PER_MINUTE = 20;
/** The wait before trying again after a refused, limited or failed run. */
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

const WINDOW_MS = 60 * 1000;
const STATUS_KEY = 'openrouter.sync_status';

type Outcome = NonNullable<OpenRouterSyncStatusDto['outcome']>;

const StoredStatus = z.object({
  lastSuccessAt: z.iso.datetime().nullable(),
  outcome: z.enum(['ok', 'no_key', 'unauthorized', 'rate_limited', 'failed']).nullable(),
  message: z.string().nullable(),
  /** When the scores were last read, so a restart does not read them again within the day. */
  scoresAt: z.iso.datetime().nullable(),
});
type StoredStatus = z.infer<typeof StoredStatus>;

const NEVER: StoredStatus = { lastSuccessAt: null, outcome: null, message: null, scoresAt: null };

export interface OpenRouterSyncDeps {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly fetch: typeof fetch;
  /** The key of the account decisions run on, read at the start of every run; null when there is none. */
  readonly readKey: () => Promise<string | null>;
  /** The catalogue ids that live accounts offer. */
  readonly offered: () => ReadonlySet<string>;
  /** The catalogue the OpenRouter ids are joined through; null while none is held. */
  readonly catalogue: () => Catalogue | null;
  /** The OpenRouter ids of the decision models 10db can call. */
  readonly decisionModelIds: () => Promise<readonly string[]>;
  readonly logger: Logger;
}

export interface OpenRouterSync {
  status(): OpenRouterSyncStatusDto;
  /** Runs when the last run is due, then every hour; never waits for it. */
  start(): void;
  /** Cancels the pending run and starts no further request; a run in flight records nothing. */
  stop(): void;
  /** Runs now. A run in flight is joined, not repeated; a key that changed meanwhile is read by one more. */
  poke(): Promise<void>;
  /** Resolves once no run is in flight. */
  idle(): Promise<void>;
}

const DATE_SUFFIX = /-\d{8}$/;

/**
 * The OpenRouter id a benchmark row's permaslug names: the listed model whose canonical slug it is (a model's
 * own id has no variant suffix, so a `:free` copy is passed over), else the permaslug without its date.
 */
function toScoreInput(
  row: OpenRouterScoreRow,
  models: readonly OpenRouterModel[],
): OpenRouterScoreInput {
  const { permaslug, ...rest } = row;
  const listed = models.find((m) => m.canonicalSlug === permaslug && !m.id.includes(':'));
  return { ...rest, id: listed?.id ?? permaslug.replace(DATE_SUFFIX, '') };
}

/** Aborts a run: a stop landed while it waited on the pacer or a request. */
class RunStopped extends Error {
  override readonly name = 'RunStopped';
}

export function createOpenRouterSync(deps: OpenRouterSyncDeps): OpenRouterSync {
  const { state, clock } = deps;
  let running: { readonly promise: Promise<void>; readonly gen: number } | null = null;
  let timer: Timer | null = null;
  let active = false;
  /** Set by stop() and cleared by start(): a stopped sync starts no run, whoever asks. */
  let stopped = false;
  /** Moves on every stop, so a run started before it can tell it was cut short. */
  let generation = 0;
  let controller = new AbortController();
  let keyConfigured = false;
  /** The key the last run read, to tell a changed one. */
  let lastKey: string | null = null;
  let pokedDuringRun = false;
  let remembered: StoredStatus = NEVER;
  /** The pacer's request times, newest last, and the waits stop() must end. */
  let requests: number[] = [];
  const waits = new Set<{ readonly timer: Timer; readonly done: () => void }>();
  /** OpenRouter's model ids and when they were read; read again a day later. */
  let models: { readonly list: readonly OpenRouterModel[]; readonly at: number } | null = null;

  const stored = (): StoredStatus => {
    try {
      const parsed = StoredStatus.safeParse(getAppSetting(state.db, STATUS_KEY));
      return parsed.success ? parsed.data : remembered;
    } catch {
      return remembered;
    }
  };

  const status = (): OpenRouterSyncStatusDto => {
    const s = stored();
    return {
      ...noOpenRouterSync(),
      keyConfigured,
      lastSuccessAt: s.lastSuccessAt,
      outcome: s.outcome,
      message: s.message,
    };
  };

  const record = (next: Partial<StoredStatus>): void => {
    remembered = { ...stored(), ...next };
    try {
      state.write((ctx) => {
        setAppSetting(ctx, STATUS_KEY, remembered);
      });
    } catch (error) {
      deps.logger.error(
        { err: error instanceof Error ? error.name : 'error' },
        'could not record the openrouter status',
      );
    }
  };

  const schedule = (ms: number): void => {
    timer?.cancel();
    timer = null;
    if (!active) return;
    timer = clock.setTimeout(() => {
      void poke();
    }, ms);
  };

  /** Waits until the pacer allows another request in the window; every request, keyless ones too, goes through. */
  async function slot(gen: number): Promise<void> {
    for (;;) {
      if (gen !== generation) throw new RunStopped();
      const now = clock.now().getTime();
      requests = requests.filter((at) => at > now - WINDOW_MS);
      const oldest = requests[0];
      if (requests.length < MAX_PER_MINUTE || oldest === undefined) break;
      await new Promise<void>((resolve) => {
        const wait = {
          timer: clock.setTimeout(
            () => {
              waits.delete(wait);
              resolve();
            },
            oldest + WINDOW_MS - now,
          ),
          done: () => {
            waits.delete(wait);
            resolve();
          },
        };
        waits.add(wait);
      });
    }
    requests.push(clock.now().getTime());
  }

  /** Runs a client whose every request takes a slot first, so a call that makes two requests is paced as two. */
  async function paced<T>(gen: number, call: (limited: typeof fetch) => Promise<T>): Promise<T> {
    const result = await call(async (input, init) => {
      await slot(gen);
      return deps.fetch(input, init);
    });
    if (gen !== generation) throw new RunStopped();
    return result;
  }

  /** Whether an outcome ends the run: the key was refused or the limit is used up. */
  const ends = (
    outcome: OpenRouterOutcome<unknown>,
  ): outcome is {
    kind: 'unauthorized' | 'rate_limited';
    message: string;
  } => outcome.kind === 'unauthorized' || outcome.kind === 'rate_limited';

  async function attempt(gen: number): Promise<void> {
    const key = await deps.readKey();
    if (gen !== generation) return;
    keyConfigured = key !== null;
    lastKey = key;
    if (key === null) {
      record({ outcome: 'no_key', message: 'Add an OpenRouter account for measured speed' });
      return;
    }
    const signal = controller.signal;
    const finish = (outcome: Outcome, message: string, success: boolean): void => {
      record({
        outcome,
        message,
        ...(success ? { lastSuccessAt: clock.now().toISOString() } : {}),
      });
    };
    const refused = (outcome: { kind: Outcome; message: string }): void => {
      deps.logger.warn({ outcome: outcome.kind }, 'openrouter sync stopped');
      finish(outcome.kind, outcome.message, false);
    };
    const failures: string[] = [];

    // The models, daily, keyless; read first, since the scores are named by their dated slugs.
    if (models === null || clock.now().getTime() - models.at >= SCORES_EVERY_MS) {
      const read = await paced(gen, (limited) => fetchOpenRouterModels({ fetch: limited, signal }));
      if (read.kind === 'ok') models = { list: read.value, at: clock.now().getTime() };
      else if (ends(read)) {
        refused(read);
        return;
      } else failures.push(read.message);
    }
    const listed: readonly OpenRouterModel[] = models?.list ?? [];

    // Scores, daily, each source apart: a source that fails, or answers nothing usable, keeps the rows held.
    const scoresAt = stored().scoresAt;
    if (scoresAt === null || clock.now().getTime() - Date.parse(scoresAt) >= SCORES_EVERY_MS) {
      let bothRead = true;
      for (const source of ['aa', 'openrouter'] as const) {
        const scores = await paced(gen, (limited) =>
          fetchOpenRouterScores({ fetch: limited, key, signal, source }),
        );
        if (ends(scores)) {
          refused(scores);
          return;
        }
        if (scores.kind !== 'ok') {
          bothRead = false;
          failures.push(scores.message);
          continue;
        }
        const at = clock.now().toISOString();
        state.write((ctx) => {
          replaceOpenRouterScores(
            ctx,
            scores.value.map((row) => toScoreInput(row, listed)),
            at,
          );
        });
      }
      // Both sources are read again at the next run until each has answered.
      if (bothRead) record({ scoresAt: clock.now().toISOString() });
    }

    // Speed for each wanted model not read within the hour.
    const catalogue = deps.catalogue();
    const offered = deps.offered();
    const wanted = new Set<string>();
    if (catalogue !== null)
      for (const { id } of listed) {
        const model = joinOpenRouterId(id, catalogue);
        if (model !== null && offered.has(model)) wanted.add(id);
      }
    for (const id of await deps.decisionModelIds()) if (!id.startsWith('~')) wanted.add(id);
    if (gen !== generation) return;
    const readAt = endpointStatsReadAt(state.db);
    let read = 0;
    let missed = 0;
    for (const id of [...wanted].sort()) {
      const last = readAt.get(id);
      if (last !== undefined && clock.now().getTime() - Date.parse(last) < SPEED_EVERY_MS) continue;
      const stats = await paced(gen, (limited) =>
        fetchEndpointStats({ fetch: limited, key, signal, id }),
      );
      if (ends(stats)) {
        refused(stats);
        return;
      }
      if (stats.kind !== 'ok') {
        missed += 1;
        continue;
      }
      const at = clock.now().toISOString();
      state.write((ctx) => {
        replaceEndpointStats(ctx, id, stats.value, at);
      });
      read += 1;
    }
    if (read === 0 && missed > 0)
      failures.push(`Speed could not be read for ${String(missed)} models`);
    const failed = failures[0];
    deps.logger.info({ speedRead: read, speedMissed: missed }, 'openrouter synced');
    if (failed !== undefined) finish('failed', failed, false);
    else
      finish(
        'ok',
        missed > 0
          ? `Speed read for ${String(read)} models; ${String(missed)} failed`
          : `Speed read for ${String(read)} models`,
        true,
      );
  }

  async function run(): Promise<void> {
    const gen = generation;
    try {
      await attempt(gen);
    } catch (error) {
      if (error instanceof RunStopped || gen !== generation) return;
      const name = error instanceof Error ? error.name : 'error';
      deps.logger.error({ err: name }, 'openrouter sync failed');
      record({
        outcome: 'failed',
        message: `The OpenRouter sync failed (${name}); keeping the last data`,
      });
    }
  }

  const wasPoked = (): boolean => pokedDuringRun;

  /** One run, then another when a poke landed meanwhile and the key it would read is not the one this run used. */
  async function runAndRecheck(gen: number): Promise<void> {
    pokedDuringRun = false;
    await run();
    // A poke can land while the key is re-read or the second run is going, so the check repeats until none did.
    while (gen === generation && wasPoked()) {
      pokedDuringRun = false;
      let next: string | null;
      try {
        next = await deps.readKey();
      } catch {
        next = lastKey;
      }
      if (gen === generation && next !== lastKey) await run();
    }
    if (gen === generation) schedule(RETRY_AFTER_FAILURE_MS);
  }

  function poke(): Promise<void> {
    // After stop() nothing runs until start() again, including a poke that waited on a run unwinding.
    if (stopped) return Promise.resolve();
    if (running !== null) {
      if (running.gen === generation) {
        pokedDuringRun = true;
        return running.promise;
      }
      // A run cut short by stop() is still unwinding; the new one starts after it.
      return running.promise.then(poke);
    }
    const gen = generation;
    // Started a tick later, so `running` is set before anything the run calls can ask for another poke.
    const promise = Promise.resolve()
      .then(() => runAndRecheck(gen))
      .finally(() => {
        if (running?.promise === promise) running = null;
      });
    running = { promise, gen };
    return promise;
  }

  return {
    status,
    start() {
      active = true;
      stopped = false;
      void poke();
    },
    stop() {
      active = false;
      stopped = true;
      generation += 1;
      controller.abort();
      controller = new AbortController();
      timer?.cancel();
      timer = null;
      for (const wait of [...waits]) {
        wait.timer.cancel();
        wait.done();
      }
    },
    poke,
    async idle() {
      while (running !== null) await running.promise;
    },
  };
}
