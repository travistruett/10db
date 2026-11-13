import type { DecisionModelListDto } from '@10db/contracts';
import type { Clock } from '../clock';
import { DECISION_MODELS_URL, decisionModelsFrom } from './decision-models';
import { OpenRouterError } from './openrouter';

/** OpenRouter's decision models change rarely; the list is read again after this long. */
const TTL_MS = 6 * 60 * 60 * 1000;
/** After a failed read, no other read starts for this long, so an outage costs one request a minute, not one a call. */
const RETRY_MS = 60 * 1000;
/** A read of the list that takes longer is given up. */
const LIST_TIMEOUT_MS = 10_000;

export interface DecisionModelList {
  /**
   * The list. With no copy held it waits for a read; with a copy older than 6 hours it answers that copy at once and
   * reads again behind it.
   */
  list(): Promise<DecisionModelListDto>;
  /**
   * Every listed model's id, for routing a call, without waiting: the copy held however old, or null while there is
   * none, in which case a read starts behind the call.
   */
  ids(): ReadonlySet<string> | null;
}

export function createDecisionModelList(deps: {
  readonly fetch: typeof fetch;
  readonly clock: Clock;
}): DecisionModelList {
  let held: { readonly dto: DecisionModelListDto; readonly ids: ReadonlySet<string> } | null = null;
  let reading: Promise<DecisionModelListDto> | null = null;
  /** When the last read failed; none starts within `RETRY_MS` of it. */
  let failedAt: number | null = null;

  const now = (): number => deps.clock.now().getTime();

  async function read(): Promise<DecisionModelListDto> {
    const controller = new AbortController();
    const timer = deps.clock.setTimeout(() => {
      controller.abort();
    }, LIST_TIMEOUT_MS);
    try {
      const response = await deps.fetch(DECISION_MODELS_URL, { signal: controller.signal });
      if (!response.ok)
        throw new OpenRouterError(
          `OpenRouter's model list answered HTTP ${String(response.status)}`,
        );
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new OpenRouterError("OpenRouter's model list was not JSON");
      }
      const dto = { models: decisionModelsFrom(body), fetchedAt: deps.clock.now().toISOString() };
      held = { dto, ids: new Set(dto.models.map((m) => m.id)) };
      failedAt = null;
      return dto;
    } catch (error) {
      failedAt = now();
      throw error;
    } finally {
      timer.cancel();
    }
  }

  function load(): Promise<DecisionModelListDto> {
    reading ??= read().finally(() => {
      reading = null;
    });
    return reading;
  }

  /** Starts a read behind the caller unless one runs or one failed within the last minute. */
  function refreshBehind(): void {
    if (reading !== null || (failedAt !== null && now() - failedAt < RETRY_MS)) return;
    load().catch(() => undefined);
  }

  return {
    list() {
      if (held === null) return load();
      if (now() - Date.parse(held.dto.fetchedAt) >= TTL_MS) refreshBehind();
      return Promise.resolve(held.dto);
    },
    ids() {
      if (held === null) refreshBehind();
      return held?.ids ?? null;
    },
  };
}
