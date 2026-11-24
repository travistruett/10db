import type { TrustSwitchKey } from '@10db/contracts';

/** Something of the builder's or the project's setup that a session starts without, and why. */
export interface LeftOut {
  readonly what: string;
  readonly why: string;
  /** The Trust switch whose setup this came from, where the producer knows it. */
  readonly from?: TrustSwitchKey;
  /** True for a reason the builder would expect (a duplicate name, 10db's own skill). */
  readonly expected?: boolean;
}

/** The note a session's prompt ends with, one line per item in order; null when nothing was left out. */
export function leftOutNote(items: readonly LeftOut[]): string | null {
  if (items.length === 0) return null;
  return [
    'Note from 10db: left out of this session:',
    ...items.map((i) => `- ${i.what}: ${i.why}`),
  ].join('\n');
}

/** Why 10db's own skill is never loaded from the builder's folders. */
export const OWN_SKILL_REASON =
  "10db's own skill acts for you with the app's token, so it never comes along";

/** A name already taken by an earlier skill or plugin, as the setup says it. */
const DUPLICATE_NAME = /^an? (skill|plugin) named .+ is already loaded/;

/** Whether the builder would expect a setup to leave something out for this reason, so it is shown quietly. */
export function isExpectedReason(why: string): boolean {
  return why === OWN_SKILL_REASON || DUPLICATE_NAME.test(why);
}

/** `items`, each marked with the switch that brought it and whether its reason is expected. */
export function leftOutFrom(from: TrustSwitchKey, items: readonly LeftOut[]): LeftOut[] {
  return items.map((item) => ({ ...item, from, expected: isExpectedReason(item.why) }));
}
