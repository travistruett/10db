import type { EvalModelDto, EvalModelSuiteDto } from '@10db/contracts';

/** One suite, as each of two models last did in it. */
export interface CompareRow {
  readonly key: string;
  readonly label: string;
  readonly a: EvalModelSuiteDto | null;
  readonly b: EvalModelSuiteDto | null;
}

/** Every suite either model ran: those where they differ first, then by key. */
export function compareRows(a: EvalModelDto, b: EvalModelDto): CompareRow[] {
  const rows = new Map<string, CompareRow>();
  for (const s of a.suites) rows.set(s.key, { key: s.key, label: s.label, a: s, b: null });
  for (const s of b.suites) {
    const row = rows.get(s.key);
    rows.set(s.key, { key: s.key, label: s.label, a: row?.a ?? null, b: s });
  }
  const differs = (r: CompareRow): boolean => r.a?.passed !== r.b?.passed;
  return [...rows.values()].sort(
    (x, y) => Number(differs(y)) - Number(differs(x)) || x.key.localeCompare(y.key),
  );
}

/**
 * What `b` costs against `a` over the suites both ran with a known cost, as a share ("+11%"); null when
 * there are none or `a` cost nothing.
 */
export function costDifference(rows: readonly CompareRow[]): number | null {
  let a = 0;
  let b = 0;
  let any = false;
  for (const row of rows) {
    if (row.a?.costUsd == null || row.b?.costUsd == null) continue;
    a += row.a.costUsd;
    b += row.b.costUsd;
    any = true;
  }
  return !any || a === 0 ? null : (b - a) / a;
}

export function shareText(share: number): string {
  const pct = Math.round(share * 100);
  return `${pct > 0 ? '+' : ''}${String(pct)}%`;
}
