import { AccountKind, type SupportedAccountKind } from '@10db/contracts';
import { autoModeRuns } from './auto-mode-models';

type ValueOf<T> = T[keyof T];

/** Why a session is judged by 10db's rules and not by an agent's judge. */
export const FloorReason = {
  Gateway: 'gateway',
  Model: 'model',
  Setting: 'setting',
  Codex: 'codex',
  LeftAutoMode: 'left_auto_mode',
} as const;
export type FloorReason = ValueOf<typeof FloorReason>;

/**
 * The reason a session starts on the rules floor, or null when it starts on a judge. `autoMode` is
 * whether the lane asks for auto mode (the app-wide setting); an account that never runs it says so
 * whatever the setting.
 */
export function floorReason(input: {
  kind: SupportedAccountKind;
  model: string | null;
  autoMode: boolean;
}): FloorReason | null {
  switch (input.kind) {
    case AccountKind.Gateway:
      return FloorReason.Gateway;
    case AccountKind.CodexSignin:
      return FloorReason.Codex;
    case AccountKind.ClaudeSubscription:
    case AccountKind.AnthropicApiKey:
    case AccountKind.Bedrock:
      if (!input.autoMode) return FloorReason.Setting;
      return autoModeRuns(input.kind, input.model) ? null : FloorReason.Model;
  }
}

const CARD = "A call those rules can't settle waits on a card.";

/** Why a session is on the floor, as a clause; `model` names the model a model reason is about. */
function floorCause(reason: FloorReason, model: string): string {
  switch (reason) {
    case FloorReason.Gateway:
      return "auto mode doesn't run through a gateway account yet";
    case FloorReason.Model:
      return `auto mode doesn't run on ${model} on this account`;
    case FloorReason.Setting:
      return '"Lanes decide routine permissions" is off in Settings';
    case FloorReason.Codex:
      return 'Codex has no judge in 10db yet';
    case FloorReason.LeftAutoMode:
      return 'Claude Code stopped running in auto mode during this session';
  }
}

/** What the thread says about a session on the floor; `model` is quoted for a model that auto mode doesn't run on. */
export function floorNoticeText(reason: FloorReason, model: string): string {
  const cause = floorCause(reason, `\`${model}\``);
  switch (reason) {
    case FloorReason.Gateway:
    case FloorReason.Model:
    case FloorReason.Setting:
      return `10db's rules judge this session, not auto mode: ${cause}. ${CARD}`;
    case FloorReason.Codex:
      return `10db's rules judge this session: ${cause}. ${CARD}`;
    case FloorReason.LeftAutoMode:
      return `${cause}, so 10db's rules judge its calls from here. ${CARD}`;
  }
}

/** Why an account's sessions start on the floor, as one sentence for Settings, which shows the model beside it. */
export function floorWhy(reason: FloorReason): string {
  const cause = floorCause(reason, 'this model');
  return `${cause.charAt(0).toUpperCase()}${cause.slice(1)}.`;
}
