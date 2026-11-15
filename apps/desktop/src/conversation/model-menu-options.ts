import { Effort, type ModelRowDto, type ShapeModelOption } from '@10db/contracts';
import { LIST_TIER_ORDER, modelLabel } from '../views/settings/model-setting-options';

/** Most models the menu lists before More models. */
export const MAIN_MODELS_MAX = 4;

/** The efforts a model offers, strongest last, as its row lists them; none while the list loads or lacks it. */
export function effortsOf(
  model: string | null,
  rows: ReadonlyMap<string, ModelRowDto>,
): readonly Effort[] {
  const row = model === null ? undefined : rows.get(model);
  const offered = new Set(row?.efforts.map((e) => e.effort));
  return Object.values(Effort).filter((e) => offered.has(e));
}

/** An effort as the menu words it: "xhigh" reads "Xhigh". */
export function effortLabel(effort: Effort): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** A model as the menu words it, else its id while the list loads. */
export function nameOf(model: string, rows: ReadonlyMap<string, ModelRowDto>): string {
  const row = rows.get(model);
  return row === undefined ? model : modelLabel(row);
}

/**
 * The effort the model's next turn runs at: the stored one when the model offers it, else the nearest
 * it offers, the higher on a tie, as the launch does. Null runs the model's own, and a model the list
 * does not describe keeps what is stored.
 */
export function effortRun(
  model: string | null,
  effort: Effort | null,
  rows: ReadonlyMap<string, ModelRowDto>,
): Effort | null {
  if (effort === null || model === null || !rows.has(model)) return effort;
  const order = Object.values(Effort);
  const level = (e: Effort): number => order.indexOf(e);
  const nearest = effortsOf(model, rows).toSorted(
    (a, b) =>
      Math.abs(level(a) - level(effort)) - Math.abs(level(b) - level(effort)) ||
      level(b) - level(a),
  )[0];
  return nearest ?? null;
}

/** The chip's words: the model's name and its effort ("… High"), the model alone when it runs at its own effort. */
export function chipLabel(
  model: string | null,
  effort: Effort | null,
  rows: ReadonlyMap<string, ModelRowDto>,
): string {
  if (model === null) return 'Model';
  const name = nameOf(model, rows);
  const run = effortRun(model, effort, rows);
  return run === null ? name : `${name} ${effortLabel(run)}`;
}

/**
 * The offered models split into the ones the menu lists and the ones behind More models. The model in
 * use and the account's default are always listed; the rest fill up to `MAIN_MODELS_MAX` from the
 * strongest tier down, keeping the daemon's order within a tier.
 */
export function splitModels(
  offered: readonly ShapeModelOption[],
  inUse: string | null,
  max: number = MAIN_MODELS_MAX,
): { readonly main: readonly string[]; readonly more: readonly string[] } {
  const strongestFirst = [...LIST_TIER_ORDER.slice(0, -1).reverse(), null].flatMap((tier) =>
    offered.filter((o) => o.tier === tier).map((o) => o.model),
  );
  const main = new Set<string>(
    inUse !== null && offered.some((o) => o.model === inUse) ? [inUse] : [],
  );
  for (const model of strongestFirst) {
    if (main.size >= max) break;
    main.add(model);
  }
  const order = offered.map((o) => o.model);
  return {
    main: order.filter((m) => main.has(m)),
    more: order.filter((m) => !main.has(m)),
  };
}

/** The models whose name or id holds the query, ignoring case; every model for an empty query. */
export function matching(
  models: readonly string[],
  query: string,
  rows: ReadonlyMap<string, ModelRowDto>,
): readonly string[] {
  const q = query.trim().toLowerCase();
  if (q === '') return models;
  return models.filter(
    (m) => m.toLowerCase().includes(q) || nameOf(m, rows).toLowerCase().includes(q),
  );
}
