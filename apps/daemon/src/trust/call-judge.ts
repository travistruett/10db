import { JudgeKind } from '@10db/contracts';

type ValueOf<T> = T[keyof T];

/** The permission mode the agent reported with a call: Claude Code's auto mode, or anything else. */
export const ReportedMode = { Auto: 'auto', Other: 'other' } as const;
export type ReportedMode = ValueOf<typeof ReportedMode>;

/**
 * The judge a session starts on: its agent's, when it asks for auto mode, unless that is 10db's judge and it
 * isn't ready (no key, a switch off); else the guard's rules.
 */
export function startingJudge(
  capability: JudgeKind,
  autoMode: boolean,
  tendbReady: boolean,
): JudgeKind {
  if (!autoMode) return JudgeKind.Rules;
  if (capability === JudgeKind.Tendb && !tendbReady) return JudgeKind.Rules;
  return capability;
}

/**
 * The judge of one call. A call a `native` session reports outside auto mode goes to 10db's judge when it is
 * ready, else to the whole guard; a `tendb` session runs in default mode, so its calls stay its judge's
 * whatever mode they report; a call from an agent that reports no mode (Codex, the fake) keeps the session's
 * judge. Nothing raises a session on the rules.
 */
export function judgeForCall(
  session: JudgeKind,
  reported: ReportedMode | null,
  tendbReady: boolean,
): JudgeKind {
  switch (session) {
    case JudgeKind.Rules:
      return JudgeKind.Rules;
    case JudgeKind.Tendb:
      return JudgeKind.Tendb;
    case JudgeKind.Native:
      if (reported !== ReportedMode.Other) return JudgeKind.Native;
      return tendbReady ? JudgeKind.Tendb : JudgeKind.Rules;
  }
}
