import { SettingField, type ProjectPatch, type SettingSuggestion } from '@10db/contracts';

// Workbench setup: the suggested settings as the builder ticks and edits them before Apply.

/** One suggested setting as the builder has it: ticked or not, and its value as edited. */
export interface SettingDraft {
  readonly field: SettingField;
  readonly ticked: boolean;
  /** The text the builder edits; empty for Allow Docker, which has no text. */
  readonly value: string;
  readonly suggestion: SettingSuggestion;
}

/** Every suggestion ticked, with its value as suggested. */
export function settingDrafts(settings: readonly SettingSuggestion[]): SettingDraft[] {
  return settings.map((suggestion) => ({
    field: suggestion.field,
    ticked: true,
    value: suggestion.field === SettingField.SandboxDocker ? '' : suggestion.value,
    suggestion,
  }));
}

/** The ticked drafts Apply sends: a row with text needs some, trimmed. */
function applied(drafts: readonly SettingDraft[]): SettingDraft[] {
  return drafts.filter(
    (d) => d.ticked && (d.field === SettingField.SandboxDocker || d.value.trim() !== ''),
  );
}

/**
 * The fields of the project patch Apply sends for the ticked settings. An unticked Allow Docker sends
 * nothing, so it records no opt-out.
 */
export function settingsPatch(drafts: readonly SettingDraft[]): ProjectPatch {
  const patch: ProjectPatch = {};
  for (const draft of applied(drafts)) {
    const value = draft.value.trim();
    switch (draft.field) {
      case SettingField.AppUrl:
        patch.appUrl = value;
        break;
      case SettingField.DevLoginCommand:
        patch.devLoginCommand = value;
        break;
      case SettingField.ChangedCheckCommand:
        patch.changedCheckCommand = value;
        break;
      case SettingField.SandboxDocker:
        patch.sandboxDocker = true;
        break;
    }
  }
  return patch;
}
