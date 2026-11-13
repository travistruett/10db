import { AccountKind, type AgentAccountKind } from '@10db/contracts';

/** A model Claude Code can be launched on by alias; each resolves to a current model on the plan and the API. */
const ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable', 'default', 'best']);
/** The aliases whose model runs auto mode on Bedrock, where `haiku` and `default` may name an older one. */
const BEDROCK_ALIASES = new Set(['opus', 'sonnet', 'fable']);

const FAMILY = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/;
const REGION_PREFIX = /^(?:us|eu|apac|global)\.anthropic\./;
const VERSION_SUFFIX = /-v\d+:\d+$/;
const LONG_CONTEXT = /\[1m\]$/;

type Family = 'opus' | 'sonnet' | 'haiku' | 'fable';
/** The oldest version of each family auto mode runs on, as [major, minor]; null for any version. */
type Floors = Readonly<Record<Family, readonly [number, number] | null>>;

const DIRECT_FLOORS: Floors = { opus: [4, 6], sonnet: [4, 6], haiku: [5, 5], fable: null };
const BEDROCK_FLOORS: Floors = { opus: [4, 7], sonnet: [5, 0], haiku: [5, 5], fable: null };

const isFamily = (name: string | undefined): name is Family =>
  name === 'opus' || name === 'sonnet' || name === 'haiku' || name === 'fable';

/** The family and version an id names, or null when 10db can't read it. */
function readModel(model: string): { family: Family; major: number; minor: number } | null {
  const bare = model
    .replace(REGION_PREFIX, '')
    .replace(VERSION_SUFFIX, '')
    .replace(LONG_CONTEXT, '');
  const found = FAMILY.exec(bare);
  const family = found?.[1];
  if (!found || !isFamily(family)) return null;
  return { family, major: Number(found[2]), minor: Number(found[3] ?? '0') };
}

function meetsFloor(model: string, floors: Floors): boolean {
  const read = readModel(model);
  if (read === null) return false;
  const floor = floors[read.family];
  if (floor === null) return true;
  return read.major > floor[0] || (read.major === floor[0] && read.minor >= floor[1]);
}

/**
 * Whether Claude Code's auto mode runs on the kind and model (research §4, "Availability"). An id it
 * can't read, and every kind auto mode doesn't run on, is false: the session falls back to the rules.
 */
export function autoModeRuns(kind: AgentAccountKind, model: string | null): boolean {
  switch (kind) {
    case AccountKind.ClaudeSubscription:
    case AccountKind.AnthropicApiKey: {
      if (model === null) return true;
      const alias = model.replace(LONG_CONTEXT, '');
      return ALIASES.has(alias) || meetsFloor(model, DIRECT_FLOORS);
    }
    case AccountKind.Bedrock: {
      // Bedrock's default model may be older than auto mode supports.
      if (model === null) return false;
      const alias = model.replace(LONG_CONTEXT, '');
      if (ALIASES.has(alias)) return BEDROCK_ALIASES.has(alias);
      return meetsFloor(model, BEDROCK_FLOORS);
    }
    case AccountKind.Gateway:
    case AccountKind.CodexSignin:
      return false;
  }
}
