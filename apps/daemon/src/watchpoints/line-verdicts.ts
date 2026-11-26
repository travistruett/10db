import { changedLines } from './changed-lines.ts';

/** One watchpoint's line patterns against one file's text. */
export interface LineCheck {
  readonly key: string;
  readonly path: string;
  readonly patterns: readonly string[];
  readonly patch: string;
}

/** Whether a changed line matched a pattern, and whether the file's lines were cut short (a long line). */
export interface LineVerdict {
  readonly matched: boolean;
  readonly cut: boolean;
}

/** The verdict per watchpoint key and path. A pair with no verdict was not checked, and is not cleared. */
export type LineVerdicts = ReadonlyMap<string, LineVerdict>;

export const verdictKey = (key: string, path: string): string => `${key}\0${path}`;

/**
 * Tests each check's patterns (case-insensitively) against its changed lines. A pattern can run for as long as
 * it likes on a crafted line, so production runs this in a worker thread (`line-reading.ts`).
 */
export function runChecks(checks: readonly LineCheck[]): LineVerdicts {
  const verdicts = new Map<string, LineVerdict>();
  for (const check of checks) {
    const patterns = check.patterns.map((source) => new RegExp(source, 'i'));
    const { lines, cut } = changedLines(check.patch);
    verdicts.set(verdictKey(check.key, check.path), {
      matched: lines.some((line) => patterns.some((p) => p.test(line))),
      cut,
    });
  }
  return verdicts;
}
