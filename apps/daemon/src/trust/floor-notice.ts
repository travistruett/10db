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

/** What the thread says about a session on the floor; `model` is quoted for a model that auto mode doesn't run on. */
export function floorNoticeText(reason: FloorReason, model: string): string {
  switch (reason) {
    case FloorReason.Gateway:
      return `10db's rules judge this session, not auto mode: auto mode doesn't run through a gateway account yet. ${CARD}`;
    case FloorReason.Model:
      return `10db's rules judge this session, not auto mode: auto mode doesn't run on \`${model}\` on this account. ${CARD}`;
    case FloorReason.Setting:
      return `10db's rules judge this session, not auto mode: "Lanes decide routine permissions" is off in Settings. ${CARD}`;
    case FloorReason.Codex:
      return `10db's rules judge this session: Codex has no judge in 10db yet. ${CARD}`;
    case FloorReason.LeftAutoMode:
      return `Claude Code stopped running in auto mode during this session, so 10db's rules judge its calls from here. ${CARD}`;
  }
}
