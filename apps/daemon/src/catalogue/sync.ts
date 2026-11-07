import { CatalogueSource, type CatalogueStatusDto } from '@10db/contracts';
import { getAppSetting, setAppSetting } from '@10db/db';
import { z } from 'zod';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { Catalogue, CATALOGUE_URL, CatalogueError, parseCatalogue } from './source';

/** models.dev is checked daily; it updates within hours, and only a real change counts. */
export const CATALOGUE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The wait before the retry after one failure; each further failure in a row doubles it, up to the cap. */
const RETRY_BASE_MS = 15 * 60 * 1000;
const RETRY_CAP_MS = 6 * 60 * 60 * 1000;
/** The file is 5.9 MB; a fetch slower than this is a failure. */
const FETCH_TIMEOUT_MS = 60 * 1000;

const DOCUMENT_KEY = 'catalogue.document';
const StoredDocument = z.object({ fetchedAt: z.iso.datetime(), catalogue: Catalogue });
type StoredDocument = z.infer<typeof StoredDocument>;

/** The wait before the retry that follows `failures` failures in a row. */
const retryDelayMs = (failures: number): number =>
  Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_CAP_MS);

export interface CatalogueSyncDeps {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly fetch: typeof fetch;
  readonly logger: Logger;
  /** The catalogue embedded in the release, read when nothing is stored; null when the build has none. */
  readonly snapshot: () => Catalogue | null;
  /** Called with the catalogue when its hash differs from the one in use before. */
  readonly onChanged: (catalogue: Catalogue) => void;
}

export interface CatalogueSync {
  status(): CatalogueStatusDto;
  /** The catalogue in use: the stored copy, else the snapshot; null when there is neither. */
  catalogue(): Catalogue | null;
  /** One fetch; one already running is joined, not repeated. It never rejects. */
  sync(): Promise<CatalogueStatusDto>;
  /**
   * Fetches now if nothing is stored or the stored copy is a day old, else a day after it was fetched.
   * After a failure the retry backs off.
   */
  start(): void;
  /** Cancels the pending fetch; one already running finishes without scheduling another. */
  stop(): void;
}

export function createCatalogueSync(deps: CatalogueSyncDeps): CatalogueSync {
  const { state } = deps;
  let running: Promise<CatalogueStatusDto> | null = null;
  let timer: Timer | null = null;
  let active = false;
  /** Failures in a row; the next wait grows with it and a good fetch resets it. */
  let failures = 0;
  /** What this process holds when the database can't be read or written. */
  let remembered: StoredDocument | null = null;
  let source: CatalogueSource | null = null;

  const stored = (): StoredDocument | null => {
    try {
      const parsed = StoredDocument.safeParse(getAppSetting(state.db, DOCUMENT_KEY));
      return parsed.success ? parsed.data : remembered;
    } catch {
      return remembered;
    }
  };
  const snapshot = (): Catalogue | null => {
    try {
      return deps.snapshot();
    } catch {
      return null;
    }
  };
  const catalogue = (): Catalogue | null => stored()?.catalogue ?? snapshot();

  const status = (): CatalogueStatusDto => {
    const doc = stored();
    if (doc !== null)
      return {
        fetchedAt: doc.fetchedAt,
        source: source ?? CatalogueSource.Stored,
        models: countOf(doc.catalogue),
      };
    const fallback = snapshot();
    if (fallback !== null)
      return { fetchedAt: null, source: CatalogueSource.Snapshot, models: countOf(fallback) };
    return { fetchedAt: null, source: CatalogueSource.None, models: 0 };
  };

  async function attempt(): Promise<void> {
    const response = await deps.fetch(CATALOGUE_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new CatalogueError(`models.dev answered ${String(response.status)}`);
    const parsed = parseCatalogue(await response.json());
    const before = catalogue();
    const doc: StoredDocument = { fetchedAt: deps.clock.now().toISOString(), catalogue: parsed };
    remembered = doc;
    state.write((ctx) => {
      setAppSetting(ctx, DOCUMENT_KEY, doc);
    });
    source = CatalogueSource.Fetched;
    deps.logger.info(
      { models: countOf(parsed), skipped: parsed.skipped },
      'model catalogue synced',
    );
    if (before?.hash !== parsed.hash) deps.onChanged(parsed);
  }

  /** A failure anywhere (the network, the document, the database) keeps the last catalogue and retries. */
  async function run(): Promise<CatalogueStatusDto> {
    try {
      await attempt();
      failures = 0;
    } catch (error) {
      failures += 1;
      deps.logger.warn(
        { err: error instanceof Error ? error.name : 'error' },
        'model catalogue sync failed; keeping the last catalogue',
      );
    }
    rearm();
    return status();
  }

  const sync = (): Promise<CatalogueStatusDto> => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };

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
  const rearm = (): void => {
    timer?.cancel();
    timer = null;
    schedule(failures === 0 ? CATALOGUE_SYNC_INTERVAL_MS : retryDelayMs(failures));
  };

  return {
    status,
    catalogue,
    sync,
    start() {
      active = true;
      const doc = stored();
      const age = doc === null ? Infinity : deps.clock.now().getTime() - Date.parse(doc.fetchedAt);
      if (age >= CATALOGUE_SYNC_INTERVAL_MS) void syncQuietly();
      else schedule(CATALOGUE_SYNC_INTERVAL_MS - age);
    },
    stop() {
      active = false;
      timer?.cancel();
      timer = null;
    },
  };
}

function countOf(c: Catalogue): number {
  return Object.values(c.providers).reduce((n, p) => n + p.models.length, 0);
}
