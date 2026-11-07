import {
  RiskTag,
  StepRole,
  type ModelSetting,
  type PatternDto,
  type PatternInput,
} from '@10db/contracts';

/** A pattern while the builder edits it. */
export interface PatternDraft {
  /** Keeps a row's inputs across a reorder; a saved pattern's own ID, or a counter for a new one. */
  readonly key: string;
  readonly name: string;
  readonly roles: readonly StepRole[];
  readonly riskTags: readonly RiskTag[];
  readonly areas: readonly string[];
  readonly retryOnly: boolean;
  readonly setting: ModelSetting;
}

export const isStepRole = (value: string): value is StepRole =>
  Object.values(StepRole).some((role) => role === value);

export const isRiskTag = (value: string): value is RiskTag =>
  Object.values(RiskTag).some((tag) => tag === value);

export function draftOf(pattern: PatternDto): PatternDraft {
  return {
    key: pattern.id,
    name: pattern.name,
    roles: pattern.match.roles,
    riskTags: pattern.match.riskTags,
    areas: pattern.match.areas,
    retryOnly: pattern.match.retryOnly,
    setting: pattern.setting,
  };
}

export function newDraft(key: string): PatternDraft {
  return {
    key,
    name: '',
    roles: [],
    riskTags: [],
    areas: [],
    retryOnly: false,
    setting: { kind: 'automatic' },
  };
}

/** What is sent for a draft; the daemon trims the name and refuses a blank one. */
export function inputOf(draft: PatternDraft): PatternInput {
  return {
    name: draft.name.trim(),
    match: {
      roles: [...draft.roles],
      riskTags: [...draft.riskTags],
      areas: [...draft.areas],
      retryOnly: draft.retryOnly,
    },
    setting: draft.setting,
  };
}

/** The list with the row at `index` moved by `by` places; unchanged at either end. */
export function moved<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const target = index + by;
  const row = list[index];
  const other = list[target];
  if (row === undefined || other === undefined) return [...list];
  return list.map((item, i) => (i === index ? other : i === target ? row : item));
}
