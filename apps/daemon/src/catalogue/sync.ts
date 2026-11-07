import { CatalogueAttempt, CatalogueSource, type CatalogueStatusDto } from '@10db/contracts';
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
/** The hash of the catalogue `onChanged` last accepted. */
const DELIVERED_KEY = 'catalogue.delivered';
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
  /**
   * Called with the catalogue when its hash differs from the one last delivered. A throw or rejection
   * leaves the change undelivered, and the next sync delivers it again.
   */
  readonly onChanged: (catalogue: Catalogue) => void | Promise<void>;
  /**
   * What follows every fetch, whether it worked or not: the accounts' lists are read again against the
   * catalogue in use. `fetched` says whether the fetch worked, so a retry after a failure can leave alone what
   * was read lately. It runs inside the fetch's single flight and a throw is logged and dropped.
   */
  readonly afterSync: (fetched: boolean) => Promise<void>;
}

export interface CatalogueSync {
  status(): CatalogueStatusDto;
  /** The catalogue in use: the stored copy, else the snapshot; null when there is neither. */
  catalogue(): Catalogue | null;
  /** One fetch and the refresh after it; one already running is joined, not repeated. It never rejects. */
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
  let deliveredInMemory: string | null = null;
  let source: CatalogueSource | null = null;
  /** How the newest fetch in this process went. */
  let attempt: CatalogueAttempt = CatalogueAttempt.NotTried;

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
        lastAttempt: attempt,
      };
    const fallback = snapshot();
    if (fallback !== null)
      return {
        fetchedAt: null,
        source: CatalogueSource.Snapshot,
        models: countOf(fallback),
        lastAttempt: attempt,
      };
    return { fetchedAt: null, source: CatalogueSource.None, models: 0, lastAttempt: attempt };
  };

  /** The hash `onChanged` last accepted; empty when it has accepted none; null before the first fetch. */
  const delivered = (): string | null => {
    try {
      const parsed = z.string().safeParse(getAppSetting(state.db, DELIVERED_KEY));
      return parsed.success ? parsed.data : deliveredInMemory;
    } catch {
      return deliveredInMemory;
    }
  };

  async function fetchAndStore(): Promise<Catalogue> {
    const response = await deps.fetch(CATALOGUE_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new CatalogueError(`models.dev answered ${String(response.status)}`);
    const parsed = parseCatalogue(await response.json());
    const doc: StoredDocument = { fetchedAt: deps.clock.now().toISOString(), catalogue: parsed };
    // Until something is delivered, consumers have what was in use before this fetch, and nothing when
    // that was nothing; recording it now keeps a failed delivery from looking like an unchanged catalogue.
    const had = delivered() ?? catalogue()?.hash ?? '';
    state.write((ctx) => {
      setAppSetting(ctx, DOCUMENT_KEY, doc);
      setAppSetting(ctx, DELIVERED_KEY, had);
    });
    remembered = doc;
    deliveredInMemory = had;
    source = CatalogueSource.Fetched;
    deps.logger.info(
      { models: countOf(parsed), skipped: parsed.skipped },
      'model catalogue synced',
    );
    return parsed;
  }

  /** Hands the catalogue to `onChanged` unless it already has it; true when nothing is left to deliver. */
  async function deliver(parsed: Catalogue): Promise<boolean> {
    if (delivered() === parsed.hash) return true;
    try {
      await deps.onChanged(parsed);
      state.write((ctx) => {
        setAppSetting(ctx, DELIVERED_KEY, parsed.hash);
      });
      deliveredInMemory = parsed.hash;
      return true;
    } catch (error) {
      deps.logger.warn(
        { err: error instanceof Error ? error.name : 'error' },
        'model catalogue stored but its change was not delivered; will retry',
      );
      return false;
    }
  }

  /** A failure anywhere (the network, the document, the database) keeps the last catalogue and retries. */
  async function run(): Promise<CatalogueStatusDto> {
    let fetched = false;
    try {
      const parsed = await fetchAndStore();
      fetched = true;
      attempt = CatalogueAttempt.Succeeded;
      failures = (await deliver(parsed)) ? 0 : failures + 1;
    } catch (error) {
      attempt = CatalogueAttempt.Failed;
      failures += 1;
      deps.logger.warn(
        { err: error instanceof Error ? error.name : 'error' },
        'model catalogue sync failed; keeping the last catalogue',
      );
    }
    try {
      await deps.afterSync(fetched);
    } catch (error) {
      deps.logger.warn(
        { err: error instanceof Error ? error.name : 'error' },
        'model refresh after the catalogue sync failed',
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
