import type { DecisionModelListDto } from '@10db/contracts';
import type { Clock } from '../clock';
import { DECISION_MODELS_URL, decisionModelsFrom } from './decision-models';
import { OpenRouterError } from './openrouter';
import { untilAborted } from './until-aborted';

/** OpenRouter's decision models change rarely; Settings reads them again after this long. */
export const DECISION_MODELS_TTL_MS = 6 * 60 * 60 * 1000;
/** A read of the list that takes longer is given up. */
const LIST_TIMEOUT_MS = 10_000;

export interface DecisionModelList {
  /** The list, read again from OpenRouter once the copy held is older than the TTL; an old copy outlives a failed read. */
  list(): Promise<DecisionModelListDto>;
  /**
   * Every listed model's id, for routing a call: the copy held however old, read once when there is none, and null
   * when it can't be read. Gives up waiting when `signal` aborts.
   */
  ids(signal?: AbortSignal): Promise<ReadonlySet<string> | null>;
}

export function createDecisionModelList(deps: {
  readonly fetch: typeof fetch;
  readonly clock: Clock;
}): DecisionModelList {
  let held: { readonly dto: DecisionModelListDto; readonly ids: ReadonlySet<string> } | null = null;
  let reading: Promise<DecisionModelListDto> | null = null;

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
      const dto = {
        models: decisionModelsFrom(body),
        fetchedAt: deps.clock.now().toISOString(),
      };
      held = { dto, ids: new Set(dto.models.map((m) => m.id)) };
      return dto;
    } catch (error) {
      if (held !== null) return held.dto;
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

  const fresh = (): boolean =>
    held !== null &&
    deps.clock.now().getTime() - Date.parse(held.dto.fetchedAt) < DECISION_MODELS_TTL_MS;

  return {
    list: () => (fresh() && held !== null ? Promise.resolve(held.dto) : load()),
    async ids(signal) {
      if (held !== null) return held.ids;
      try {
        const dto = await (signal === undefined ? load() : untilAborted(load(), signal));
        return new Set(dto.models.map((m) => m.id));
      } catch {
        return null;
      }
    },
  };
}
