import type { ModelSetting, PlaybookMoveEntry, ProjectId } from '@10db/contracts';

/** A setting the move could not carry over, and whose it was: a project's, or null for the global ones. */
export interface ScopedMoveEntry extends PlaybookMoveEntry {
  readonly projectId: ProjectId | null;
}

/** A model setting in words, as a report names it. */
export function describeSetting(setting: ModelSetting): string {
  switch (setting.kind) {
    case 'automatic':
      return setting.minimum === undefined
        ? 'automatic'
        : `automatic, at least ${String(setting.minimum)}`;
    case 'tier':
      return `the ${setting.tier} tier`;
    case 'top_of_tier':
      return setting.tier === undefined
        ? 'the best model on offer'
        : `the best model of the ${setting.tier} tier`;
    case 'model':
      return setting.model;
  }
}
