import { z } from 'zod';

/** How many example paths a coverage answer lists for one watchpoint. */
export const MAX_COVERAGE_EXAMPLES = 5;

/** Whether a count is read (`counted`), still being read in the background (`counting`), or could not be read. */
export const WatchpointCoverageState = {
  Counted: 'counted',
  Counting: 'counting',
  Unreadable: 'unreadable',
} as const;
export type WatchpointCoverageState =
  (typeof WatchpointCoverageState)[keyof typeof WatchpointCoverageState];

/** The tracked files in a project's checkout that one watchpoint covers. */
export const WatchpointCoverage = z.object({
  key: z.string(),
  files: z.int().nonnegative(),
  examples: z.array(z.string()).max(MAX_COVERAGE_EXAMPLES),
  state: z.enum(WatchpointCoverageState),
});
export type WatchpointCoverage = z.infer<typeof WatchpointCoverage>;

/**
 * `GET /projects/:projectId/watchpoints/coverage` and `GET /settings/watchpoints/coverage` (summed across projects):
 * one entry for each watchpoint that applies and each starter.
 */
export const WatchpointCoverageDto = z.array(WatchpointCoverage);
export type WatchpointCoverageDto = z.infer<typeof WatchpointCoverageDto>;
