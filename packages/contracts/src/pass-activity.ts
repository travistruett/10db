import { z } from 'zod';
import { PassTurnId, WorkstreamId } from './ids';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §4.3: while a turn works, the
// Workbench says what the agent is doing ("editing settings/page.tsx") and how many files it touched.

const Timestamp = z.iso.datetime();

/**
 * `session.activity`'s data. `tool` names the tool the agent called and the file or command it aimed
 * at; null while it writes text. `turn` is set for a lane of a pass task: its turn and the files that
 * turn has written so far; null for any other lane.
 */
export const SessionActivityData = z.object({
  workstreamId: WorkstreamId,
  kind: z.string(),
  summary: z.string(),
  tool: z.object({ name: z.string().min(1), target: z.string().nullable() }).nullable(),
  turn: z.object({ id: PassTurnId, filesTouched: z.array(z.string()) }).nullable(),
});
export type SessionActivityData = z.infer<typeof SessionActivityData>;

/** What a working turn is doing now, as its page's row and live line read it. */
export const PassTurnActivity = z.object({
  /** The tool the agent called last; null while it writes text. */
  tool: z.string().nullable(),
  /** The file or command that call aimed at. */
  target: z.string().nullable(),
  /** The files the turn has written so far. */
  filesTouched: z.array(z.string()),
  at: Timestamp,
});
export type PassTurnActivity = z.infer<typeof PassTurnActivity>;

/** One line of a turn's log (Show Log). */
export const TurnActivityDto = z.object({ at: Timestamp, kind: z.string(), summary: z.string() });
export type TurnActivityDto = z.infer<typeof TurnActivityDto>;
