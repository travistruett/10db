import { ModelTier, StepRole, type KindDto, type ModelSetting } from '@10db/contracts';
import type { LegacyPattern } from '@10db/db';
import { describeSetting, type ScopedMoveEntry } from './move-entries';

type Overrides = KindDto['overrides'];

const TIERS: readonly ModelTier[] = [
  ModelTier.Efficient,
  ModelTier.Balanced,
  ModelTier.Capable,
  ModelTier.Frontier,
];

/**
 * How demanding a setting is, for deciding whether it raises another: automatic by its minimum, then each
 * tier, with the best of a tier just above it and the best of any tier on top. One model has no place in
 * the order, so it is null.
 */
export function strength(setting: ModelSetting): number | null {
  switch (setting.kind) {
    case 'automatic':
      return (setting.minimum ?? 0) / 101;
    case 'tier':
      return 1 + 2 * TIERS.indexOf(setting.tier);
    case 'top_of_tier':
      return setting.tier === undefined ? 9 : 2 + 2 * TIERS.indexOf(setting.tier);
    case 'model':
      return null;
  }
}

/** The pattern 10db seeded: the best model for work tagged security, auth and migration, on every role. */
function isSeededHighRisk(pattern: LegacyPattern): boolean {
  const { match, setting } = pattern;
  const tags = new Set<string>(match.riskTags);
  return (
    pattern.projectId === null &&
    match.roles.length === 0 &&
    match.areas.length === 0 &&
    !match.retryOnly &&
    setting.kind === 'top_of_tier' &&
    setting.tier === undefined &&
    tags.size === 3 &&
    ['security', 'auth', 'migration'].every((tag) => tags.has(tag))
  );
}

const ROLES: readonly StepRole[] = Object.values(StepRole);

export interface PatternMoves {
  /** The overrides of each kind that a pattern changed, by the kind's key. */
  readonly overrides: ReadonlyMap<string, Overrides>;
  readonly entries: readonly ScopedMoveEntry[];
}

/**
 * Turns global patterns on risk tags into per-kind overrides. The pattern first by position wins a kind
 * and role, as it did a task with that tag; it sets the override when none is there and replaces one only
 * when it asks for more, since a kind can raise a step and never lower it. Everything else is reported:
 * a project's pattern, an area or retry pattern, one on no risk tag, one that would not raise.
 */
export function movePatterns(
  patterns: readonly LegacyPattern[],
  kinds: readonly KindDto[],
): PatternMoves {
  const current = new Map<string, Overrides>(kinds.map((k) => [k.key, { ...k.overrides }]));
  const changed = new Set<string>();
  const claimed = new Set<string>();
  const entries: ScopedMoveEntry[] = [];
  const report = (pattern: LegacyPattern, what: string, why: string): void => {
    entries.push({
      projectId: pattern.projectId,
      setting: `Pattern "${pattern.name}"`,
      value: `${describeSetting(pattern.setting)}${what === '' ? '' : ` for ${what}`}`,
      why,
    });
  };
  const ordered = [...patterns].sort((a, b) => a.position - b.position);
  for (const pattern of ordered) {
    const { match } = pattern;
    if (pattern.projectId !== null) {
      report(
        pattern,
        '',
        'A project’s own patterns have no place in the playbook, which kinds replace',
      );
      continue;
    }
    if (isSeededHighRisk(pattern)) continue;
    if (match.areas.length > 0 || match.retryOnly) {
      report(pattern, '', 'Patterns on an area, or on a retry, have no place in the playbook');
      continue;
    }
    if (match.riskTags.length === 0) {
      report(pattern, '', 'A pattern on no risk tag matched every task, which no kind can say');
      continue;
    }
    const roles = match.roles.length === 0 ? ROLES : match.roles;
    const notRaised: string[] = [];
    const noKind: string[] = [];
    for (const key of match.riskTags) {
      const overrides = current.get(key);
      if (!overrides) {
        noKind.push(key);
        continue;
      }
      for (const role of roles) {
        const id = `${key}/${role}`;
        if (claimed.has(id)) continue;
        claimed.add(id);
        const existing = overrides[role];
        const had = existing?.model ?? null;
        const stronger = strength(pattern.setting);
        const was = had === null ? null : strength(had);
        const raises = had === null || (stronger !== null && was !== null && stronger > was);
        if (!raises) {
          notRaised.push(`${key} ${role}`);
          continue;
        }
        overrides[role] = {
          personaId: existing?.personaId ?? null,
          model: pattern.setting,
          effort: existing?.effort ?? null,
        };
        changed.add(key);
      }
    }
    if (notRaised.length > 0)
      report(
        pattern,
        notRaised.join(', '),
        'The kind already asks at least as much of that step, and a kind can only raise a model',
      );
    if (noKind.length > 0)
      report(pattern, noKind.join(', '), 'No kind has the key of that risk tag');
  }
  return {
    overrides: new Map(
      [...changed].flatMap((key) => {
        const overrides = current.get(key);
        return overrides ? [[key, overrides] as const] : [];
      }),
    ),
    entries,
  };
}
