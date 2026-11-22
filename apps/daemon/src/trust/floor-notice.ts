import { Provider, type SupportedAccountKind } from '@10db/contracts';
import { autoModeRuns } from './auto-mode-models';

type ValueOf<T> = T[keyof T];

/** Why a session, or a call, is judged by 10db's rules and not by a judge. */
export const FloorReason = {
  Setting: 'setting',
  /** The account's judge is 10db's, and it isn't ready: no account that can power Decisions, or a switch off. */
  NoJudge: 'no_judge',
  /** 10db's judge timed out or failed mid-session, so its calls meet the rules for a while. */
  JudgeUnavailable: 'judge_unavailable',
  LeftAutoMode: 'left_auto_mode',
} as const;
export type FloorReason = ValueOf<typeof FloorReason>;

/**
 * The reason a session starts on the rules floor, or null when it starts on a judge. `autoMode` is
 * whether the lane asks for auto mode (the app-wide setting); `tendbReady` whether 10db's judge can answer,
 * for an account auto mode doesn't judge (the Codex harness, a model auto mode doesn't run on).
 */
export function floorReason(input: {
  kind: SupportedAccountKind;
  harness: Provider;
  model: string | null;
  autoMode: boolean;
  tendbReady: boolean;
}): FloorReason | null {
  if (!input.autoMode) return FloorReason.Setting;
  const tendb = input.harness === Provider.Codex || !autoModeRuns(input.kind, input.model);
  return tendb && !input.tendbReady ? FloorReason.NoJudge : null;
}

const CARD = "A call those rules can't settle waits on a card.";
const SKIP = "A call those rules can't settle is skipped, not asked about.";

/** Why a session is on the floor, as a clause; `detail` says what 10db's judge answered. */
function floorCause(reason: FloorReason, detail: string): string {
  switch (reason) {
    case FloorReason.Setting:
      return '"Lanes decide routine permissions" is off in Settings';
    case FloorReason.NoJudge:
      return "10db's judge needs an account that can power Decisions and its Limits switch on in Settings › Decisions";
    case FloorReason.JudgeUnavailable:
      return `10db's judge didn't answer (${detail})`;
    case FloorReason.LeftAutoMode:
      return 'Claude Code stopped running in auto mode during this session';
  }
}

/**
 * What the thread says about a session on the floor. `attended` is whether the builder is in the session, so a
 * call the rules can't settle waits on a card; in a lane it is skipped. `detail` is what 10db's judge answered.
 */
export function floorNoticeText(
  reason: FloorReason,
  context: { readonly attended: boolean; readonly detail?: string },
): string {
  const cause = floorCause(reason, context.detail ?? '');
  switch (reason) {
    case FloorReason.Setting:
      return `10db's rules judge this session, not auto mode: ${cause}. ${CARD}`;
    case FloorReason.NoJudge:
      return `10db's rules judge this session: ${cause}. ${context.attended ? CARD : SKIP}`;
    case FloorReason.JudgeUnavailable:
      return `${cause}, so 10db's rules judge calls until it answers again.`;
    case FloorReason.LeftAutoMode:
      return `${cause}, so 10db's rules judge its calls from here. ${CARD}`;
  }
}

/** Why an account's sessions start on the floor, as one sentence for Settings. */
export function floorWhy(reason: FloorReason): string {
  const cause = floorCause(reason, 'no answer');
  return `${cause.charAt(0).toUpperCase()}${cause.slice(1)}.`;
}
