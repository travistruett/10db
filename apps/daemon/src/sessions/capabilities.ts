import {
  ImageFormat,
  isMetered,
  JudgeKind,
  ModelSwitch,
  Provider,
  providerOf,
  SteerMode,
  type AgentCapabilitiesDto,
  type AgentAccountKind,
} from '@10db/contracts';
import { autoModeRuns } from '../trust';

/** What an agent can do on an account (sessions spec §5.3). */
export type AgentCapabilities = AgentCapabilitiesDto;

const IMAGES = [ImageFormat.Png, ImageFormat.Jpeg, ImageFormat.Webp];

/**
 * Claude Code: auto mode judges a call where it runs on the kind and the model; elsewhere (a gateway,
 * an older or unreadable model) the guard's rules are the judge until 10db's judge exists (trust line §4,
 * §12).
 */
export function claudeCapabilities(
  kind: AgentAccountKind,
  model: string | null,
): AgentCapabilities {
  return {
    harness: Provider.Claude,
    label: 'Claude Code',
    steer: SteerMode.Inject,
    receipts: true,
    readBack: false,
    images: [...IMAGES],
    slashCommands: true,
    plan: true,
    reasoning: true,
    subagents: true,
    modelSwitch: ModelSwitch.NextTurn,
    takeover: true,
    costUsd: isMetered(kind),
    judge: autoModeRuns(kind, model) ? JudgeKind.Native : JudgeKind.Rules,
  };
}

/**
 * Codex through app-server: the guard's rules judge its calls until 10db's judge exists. Codex can do
 * the same on every kind it runs on.
 */
export const codexCapabilities: (kind: AgentAccountKind) => AgentCapabilities = () => ({
  harness: Provider.Codex,
  label: 'Codex',
  steer: SteerMode.Inject,
  receipts: true,
  readBack: true,
  images: [...IMAGES],
  slashCommands: true,
  plan: true,
  reasoning: true,
  subagents: false,
  modelSwitch: ModelSwitch.NextTurn,
  takeover: true,
  costUsd: false,
  judge: JudgeKind.Rules,
});

const CAPABILITIES_BY_ADAPTER: Readonly<
  Record<Provider, (kind: AgentAccountKind, model: string | null) => AgentCapabilities>
> = {
  [Provider.Claude]: claudeCapabilities,
  [Provider.Codex]: (kind) => codexCapabilities(kind),
};

/** The capabilities of whichever agent runs the kind: for a stand-in, such as the fake, that is both. */
export function capabilitiesOf(kind: AgentAccountKind, model: string | null): AgentCapabilities {
  return CAPABILITIES_BY_ADAPTER[providerOf(kind)](kind, model);
}
