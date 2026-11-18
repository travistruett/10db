import { normaliseCriteria } from '@10db/contracts';

/** One acceptance criterion per non-blank line. */
export function criteriaLines(text: string): string[] {
  return normaliseCriteria([text]);
}
