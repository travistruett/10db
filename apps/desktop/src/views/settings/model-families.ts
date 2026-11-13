import { ModelStatus, type ModelRowDto } from '@10db/contracts';

/** One family in the model list: the row that stands for it, and its other versions under it. */
export interface ModelFamily {
  readonly key: string;
  readonly lead: ModelRowDto;
  readonly older: readonly ModelRowDto[];
}

/** A model with no maker or no family is a family of its own. */
const familyKey = (row: ModelRowDto): string =>
  row.maker === null || row.family === null ? row.model : `${row.maker}/${row.family}`;

/**
 * The sorted rows as the list's top-level entries. Every Current model leads an entry; a family's other versions
 * go under its first Current model in sorted order, or, with none, under its first row. Entries keep their lead's
 * place in the sort.
 */
export function groupByFamily(sorted: readonly ModelRowDto[]): ModelFamily[] {
  const families = new Map<string, ModelRowDto[]>();
  for (const row of sorted) {
    const key = familyKey(row);
    families.set(key, [...(families.get(key) ?? []), row]);
  }
  const entries: ModelFamily[] = [];
  for (const rows of families.values()) {
    const current = rows.filter((r) => r.status === ModelStatus.Current);
    const leads = current.length > 0 ? current : rows.slice(0, 1);
    const [first, ...others] = leads;
    if (first === undefined) continue;
    entries.push({ key: first.model, lead: first, older: rows.filter((r) => !leads.includes(r)) });
    for (const lead of others) entries.push({ key: lead.model, lead, older: [] });
  }
  const place = new Map(sorted.map((row, i) => [row.model, i]));
  return entries.sort((a, b) => (place.get(a.key) ?? 0) - (place.get(b.key) ?? 0));
}
