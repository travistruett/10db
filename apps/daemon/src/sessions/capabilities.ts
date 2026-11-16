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
 * an older or unreadable model) 10db's judge does (trust line §4, §10). Whether it is ready is the session's
 * to read as it starts: a session on 10db's judge without a key starts on the rules.
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
    backgroundTasks: true,
    webSearch: true,
    modelSwitch: ModelSwitch.NextTurn,
    takeover: true,
    costUsd: isMetered(kind),
    judge: autoModeRuns(kind, model) ? JudgeKind.Native : JudgeKind.Tendb,
  };
}

/**
 * Codex through app-server: 10db's judge judges its calls through the guard hook, with approvals closed
 * (decision `2026-11-12-codex-is-judged-by-10dbs-judge.md`). Codex can do the same on every kind it runs on.
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
  // app-server reports no background commands for a thread, so a Codex chat has none to list.
  backgroundTasks: false,
  // Live search runs on OpenAI's servers, so 10db's judge never sees a search or page URL before it is fetched.
  webSearch: true,
  modelSwitch: ModelSwitch.NextTurn,
  takeover: true,
  costUsd: false,
  judge: JudgeKind.Tendb,
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
