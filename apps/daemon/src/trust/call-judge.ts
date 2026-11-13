import { JudgeKind } from '@10db/contracts';

type ValueOf<T> = T[keyof T];

/** The permission mode the agent reported with a call: Claude Code's auto mode, or anything else. */
export const ReportedMode = { Auto: 'auto', Other: 'other' } as const;
export type ReportedMode = ValueOf<typeof ReportedMode>;

/** The judge a session starts on: its agent's, when it asks for auto mode; else the guard's rules. */
export function startingJudge(capability: JudgeKind, autoMode: boolean): JudgeKind {
  return autoMode ? capability : JudgeKind.Rules;
}

/**
 * The judge of one call. A call the agent reports outside auto mode meets the whole guard; a call from
 * an agent that reports no mode (Codex, the fake) keeps the session's judge. Nothing raises a session
 * on the rules.
 */
export function judgeForCall(session: JudgeKind, reported: ReportedMode | null): JudgeKind {
  switch (session) {
    case JudgeKind.Rules:
      return JudgeKind.Rules;
    case JudgeKind.Native:
    case JudgeKind.Tendb:
      return reported === ReportedMode.Other ? JudgeKind.Rules : session;
  }
}
