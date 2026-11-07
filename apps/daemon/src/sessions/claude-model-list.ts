import { knownEfforts } from '@10db/contracts';
import { z } from 'zod';
import type { SeenModel } from './account-check';

/** The alias Claude Code lists for the model it would start with; it repeats another row. */
const DEFAULT_ROW = 'default';

/** Claude Code appends this to a model that runs with the large context window. */
const LARGE_WINDOW = /\[1m\]$/;

// A row has more keys (names, descriptions, switches); only these are read, and a row without a value is no model.
const Row = z.looseObject({
  value: z.string().min(1),
  resolvedModel: z.string().min(1).optional(),
  supportedEffortLevels: z.array(z.string()).optional(),
});

/**
 * The models Claude Code lists for an account (`supportedModels()`). The `default` row repeats another and
 * goes. The large-window suffix is in neither the catalogue nor `init.model` on a subscription, so it goes
 * from every ID. A row that is not a model is skipped. Undefined when nothing is left, or when no row names
 * the concrete model it stands for: without that an alias cannot be joined to the catalogue.
 */
export function seenModelsFrom(rows: unknown): readonly SeenModel[] | undefined {
  const list = z.array(z.unknown()).safeParse(rows);
  if (!list.success) return undefined;
  const models: SeenModel[] = [];
  for (const raw of list.data) {
    const row = Row.safeParse(raw);
    if (!row.success || row.data.value === DEFAULT_ROW) continue;
    models.push({
      id: row.data.value.replace(LARGE_WINDOW, ''),
      resolvedId: row.data.resolvedModel?.replace(LARGE_WINDOW, '') ?? null,
      efforts: knownEfforts(row.data.supportedEffortLevels ?? []),
    });
  }
  return models.some((m) => m.resolvedId !== null) ? models : undefined;
}
