import type { SetupPreviewDto, TrustSwitchKey } from '@10db/contracts';

/** Each folded list shows this many items before its Show control. */
export const FOLD_AT = 5;

export interface SwitchItem {
  readonly what: string;
  /** Why it was left out; null for an item that comes along. */
  readonly why: string | null;
}

/** What the preview holds, by the switch that brought it. `other` holds what no switch owns. */
export interface PreviewItems {
  readonly bySwitch: ReadonlyMap<TrustSwitchKey, readonly SwitchItem[]>;
  readonly other: readonly SwitchItem[];
  /** Left out for a reason the builder would expect: shown folded in one quiet line. */
  readonly expected: readonly SwitchItem[];
}

/**
 * The preview split for the page: what comes along, then what was left out unexpectedly, under the
 * switch each belongs to; the expected left-outs together, and what no switch owns in `other`.
 */
export function previewItems(preview: SetupPreviewDto | undefined): PreviewItems {
  const bySwitch = new Map<TrustSwitchKey, SwitchItem[]>();
  const other: SwitchItem[] = [];
  const expected: SwitchItem[] = [];
  const place = (from: TrustSwitchKey | null, item: SwitchItem): void => {
    if (from === null) other.push(item);
    else bySwitch.set(from, [...(bySwitch.get(from) ?? []), item]);
  };
  if (preview !== undefined) {
    for (const item of [...preview.skills, ...preview.plugins])
      place(item.from, { what: item.what, why: null });
    for (const item of preview.leftOut) {
      if (item.expected) expected.push({ what: item.what, why: item.why });
      else place(item.from, { what: item.what, why: item.why });
    }
  }
  return { bySwitch, other, expected };
}
