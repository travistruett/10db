export const SettingsSectionKey = {
  Overview: 'overview',
  General: 'general',
  BoardColumns: 'board-columns',
  Planning: 'planning',
  Areas: 'areas',
  NetworkHosts: 'network-hosts',
  Billing: 'billing',
  ProjectTrust: 'project-trust',
  Team: 'team',
  Integrations: 'integrations',
  People: 'people',
  RoutingRules: 'routing-rules',
  KeepAwake: 'keep-awake',
  Updates: 'updates',
  LanePermissions: 'lane-permissions',
  Trust: 'trust',
  Accounts: 'accounts',
  Decisions: 'decisions',
  Models: 'models',
  PersonasAndFlows: 'personas-and-flows',
} as const;
export type SettingsSectionKey = (typeof SettingsSectionKey)[keyof typeof SettingsSectionKey];

/** Which half of Settings a section belongs to; the sidebar shows one half at a time. */
export const SettingsScope = { Project: 'project', App: 'app' } as const;
export type SettingsScope = (typeof SettingsScope)[keyof typeof SettingsScope];

export interface SettingsSection {
  readonly key: SettingsSectionKey;
  readonly scope: SettingsScope;
  /** The dimmed label the sidebar groups the section under; null for a section that stands alone. */
  readonly subhead: string | null;
  readonly label: string;
  /** What the section still lacks, as a line under its content; null once nothing is left. */
  readonly planned: string | null;
  /** Whether the section has content to open; the nav lists only these. A built section may still have a planned remainder. */
  readonly built: boolean;
}

function section(
  key: SettingsSectionKey,
  scope: SettingsScope,
  subhead: string | null,
  label: string,
  planned: string | null = null,
): SettingsSection {
  return { key, scope, subhead, label, planned, built: true };
}

export const GENERAL_SECTION: SettingsSection = section(
  SettingsSectionKey.General,
  SettingsScope.Project,
  'Project',
  'General',
);

const { Project, App } = SettingsScope;

/** Project sections first, then app-wide ones; each scope in the order the sidebar lists it. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  GENERAL_SECTION,
  section(SettingsSectionKey.BoardColumns, Project, 'Project', 'Board columns'),
  section(SettingsSectionKey.Planning, Project, 'Planning', 'Planning'),
  section(SettingsSectionKey.Areas, Project, 'Planning', 'Areas and hazards'),
  section(SettingsSectionKey.RoutingRules, Project, 'Planning', 'Who Answers'),
  section(SettingsSectionKey.Billing, Project, 'Agents', 'Billing'),
  section(
    SettingsSectionKey.Team,
    Project,
    'Agents',
    'Models by role',
    "Not built yet: which persona runs each role, and the project's human members.",
  ),
  section(SettingsSectionKey.ProjectTrust, Project, 'Agents', 'Trust'),
  section(SettingsSectionKey.NetworkHosts, Project, 'Agents', 'Network hosts'),
  section(SettingsSectionKey.Overview, App, null, 'Overview'),
  section(SettingsSectionKey.Accounts, App, 'Models', 'Accounts'),
  section(SettingsSectionKey.Models, App, 'Models', 'All models'),
  section(SettingsSectionKey.Decisions, App, 'Models', 'Decisions'),
  section(
    SettingsSectionKey.PersonasAndFlows,
    App,
    'Models',
    'Models by role',
    'Not built yet: personas, their instructions and pins, and the flows of steps.',
  ),
  section(SettingsSectionKey.LanePermissions, App, 'Agents', 'Lane permissions'),
  section(SettingsSectionKey.Trust, App, 'Agents', 'Trust'),
  section(SettingsSectionKey.Integrations, App, 'Connections', 'Integrations'),
  section(SettingsSectionKey.People, App, 'Connections', 'People'),
  section(SettingsSectionKey.Updates, App, 'This Mac', 'Updates'),
  section(SettingsSectionKey.KeepAwake, App, 'This Mac', 'Keep-awake'),
];

const KEYS = new Set<string>(Object.values(SettingsSectionKey));

export function isSettingsSectionKey(value: string): value is SettingsSectionKey {
  return KEYS.has(value);
}

export function sectionByKey(key: SettingsSectionKey): SettingsSection {
  return SETTINGS_SECTIONS.find((s) => s.key === key) ?? GENERAL_SECTION;
}

/** Where the sidebar's app-wide Settings opens: the first app-wide section with content. */
export function firstAppSection(): SettingsSectionKey {
  return (
    SETTINGS_SECTIONS.find((s) => s.scope === SettingsScope.App && s.built)?.key ??
    SettingsSectionKey.General
  );
}
