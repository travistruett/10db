export const SettingsSectionKey = {
  General: 'general',
  BoardColumns: 'board-columns',
  Areas: 'areas',
  NetworkHosts: 'network-hosts',
  Billing: 'billing',
  Team: 'team',
  RoutingRules: 'routing-rules',
  KeepAwake: 'keep-awake',
  LanePermissions: 'lane-permissions',
  Accounts: 'accounts',
  Decisions: 'decisions',
  Models: 'models',
  PersonasAndFlows: 'personas-and-flows',
} as const;
export type SettingsSectionKey = (typeof SettingsSectionKey)[keyof typeof SettingsSectionKey];

export const SettingsGroup = { Project: 'project', Global: 'global' } as const;
export type SettingsGroup = (typeof SettingsGroup)[keyof typeof SettingsGroup];

export interface SettingsSection {
  readonly key: SettingsSectionKey;
  readonly group: SettingsGroup;
  readonly label: string;
  /** What a section that is not built yet will hold, and which plan fills it; null once it is built. */
  readonly planned: string | null;
}

export const GENERAL_SECTION: SettingsSection = {
  key: SettingsSectionKey.General,
  group: SettingsGroup.Project,
  label: 'General',
  planned: null,
};

/** Spec §10 Settings: per project, then app-wide. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  GENERAL_SECTION,
  {
    key: SettingsSectionKey.BoardColumns,
    group: SettingsGroup.Project,
    label: 'Board columns',
    planned: null,
  },
  {
    key: SettingsSectionKey.Areas,
    group: SettingsGroup.Project,
    label: 'Areas and hazards',
    planned: null,
  },
  {
    key: SettingsSectionKey.NetworkHosts,
    group: SettingsGroup.Project,
    label: 'Network hosts',
    planned: null,
  },
  {
    key: SettingsSectionKey.Billing,
    group: SettingsGroup.Project,
    label: 'Billing',
    planned: null,
  },
  {
    key: SettingsSectionKey.Team,
    group: SettingsGroup.Project,
    label: 'Team',
    planned:
      'Which persona runs each role in this project, and its human members. The team editor plan fills it.',
  },
  {
    key: SettingsSectionKey.RoutingRules,
    group: SettingsGroup.Project,
    label: 'Routing rules',
    planned:
      'Who answers each question category, optionally per area. The team editor plan fills it.',
  },
  {
    key: SettingsSectionKey.KeepAwake,
    group: SettingsGroup.Global,
    label: 'Keep-awake',
    planned: null,
  },
  {
    key: SettingsSectionKey.LanePermissions,
    group: SettingsGroup.Global,
    label: 'Lane permissions',
    planned: null,
  },
  {
    key: SettingsSectionKey.Accounts,
    group: SettingsGroup.Global,
    label: 'Accounts',
    planned: null,
  },
  {
    key: SettingsSectionKey.Decisions,
    group: SettingsGroup.Global,
    label: 'Decisions',
    planned: null,
  },
  {
    key: SettingsSectionKey.Models,
    group: SettingsGroup.Global,
    label: 'Models and benchmarks',
    planned:
      "The Artificial Analysis key and sync, the model profiles, and the Intelligence-vs-Cost chart with AA's attribution. A later M2 plan fills it.",
  },
  {
    key: SettingsSectionKey.PersonasAndFlows,
    group: SettingsGroup.Global,
    label: 'Personas and flows',
    planned:
      'The personas, their instructions and pins, and the flows of steps. The team editor plan fills it.',
  },
];

const KEYS = new Set<string>(Object.values(SettingsSectionKey));

export function isSettingsSectionKey(value: string): value is SettingsSectionKey {
  return KEYS.has(value);
}

export function sectionByKey(key: SettingsSectionKey): SettingsSection {
  return SETTINGS_SECTIONS.find((s) => s.key === key) ?? GENERAL_SECTION;
}
