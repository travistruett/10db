export const SettingsSectionKey = {
  Overview: 'overview',
  General: 'general',
  PagesAndPictures: 'pages-and-pictures',
  Sharing: 'sharing',
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
  Linear: 'linear',
  KeepAwake: 'keep-awake',
  AgentSkill: 'agent-skill',
  Appearance: 'appearance',
  Updates: 'updates',
  LanePermissions: 'lane-permissions',
  Trust: 'trust',
  Sessions: 'sessions',
  Accounts: 'accounts',
  Playbook: 'playbook',
  Decisions: 'decisions',
  Models: 'models',
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
  section(SettingsSectionKey.PagesAndPictures, Project, 'Project', 'App Preview'),
  section(SettingsSectionKey.Sharing, Project, 'Project', 'Sharing'),
  section(SettingsSectionKey.BoardColumns, Project, 'Project', 'Board Columns'),
  section(SettingsSectionKey.Planning, Project, 'Planning', 'Planning'),
  section(SettingsSectionKey.Areas, Project, 'Planning', 'Areas and Hazards'),
  section(SettingsSectionKey.RoutingRules, Project, 'Planning', 'Question Routing'),
  section(SettingsSectionKey.Linear, Project, 'Planning', 'Linear'),
  section(SettingsSectionKey.Team, Project, 'Agents', 'Playbook'),
  section(SettingsSectionKey.Billing, Project, 'Agents', 'Billing'),
  section(SettingsSectionKey.ProjectTrust, Project, 'Agents', 'Trust'),
  // The key keeps the address the section had as Network Hosts, so an old link still lands here.
  section(SettingsSectionKey.NetworkHosts, Project, 'Agents', 'Sandbox'),
  section(SettingsSectionKey.Overview, App, null, 'Overview'),
  section(SettingsSectionKey.Accounts, App, 'AI', 'Accounts'),
  section(SettingsSectionKey.Playbook, App, 'AI', 'Playbook'),
  section(SettingsSectionKey.Decisions, App, 'AI', 'Decisions'),
  section(SettingsSectionKey.Models, App, 'AI', 'Models'),
  section(SettingsSectionKey.LanePermissions, App, 'Agents', 'Lane Permissions'),
  section(SettingsSectionKey.Trust, App, 'Agents', 'Trust'),
  section(SettingsSectionKey.Sessions, App, 'Agents', 'Sessions'),
  section(SettingsSectionKey.Integrations, App, 'Connections', 'Integrations'),
  section(SettingsSectionKey.People, App, 'Connections', 'People'),
  section(SettingsSectionKey.Appearance, App, 'App', 'Appearance'),
  section(SettingsSectionKey.Updates, App, 'App', 'Updates'),
  section(SettingsSectionKey.KeepAwake, App, 'App', 'Keep-Awake'),
  section(SettingsSectionKey.AgentSkill, App, 'App', 'Agent Skill'),
];

const KEYS = new Set<string>(Object.values(SettingsSectionKey));

/** Sections that no longer exist, by the address they had, and the section their content moved to. */
const RETIRED_SECTIONS: Readonly<Record<string, SettingsSectionKey>> = {
  'personas-and-flows': SettingsSectionKey.Playbook,
  'sign-ins': SettingsSectionKey.Integrations,
  'project-integrations': SettingsSectionKey.Integrations,
};

/** Where an address that is not a section now lands: the section that took over its content, else General. */
export function sectionForAddress(value: string): SettingsSectionKey {
  return RETIRED_SECTIONS[value] ?? SettingsSectionKey.General;
}

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
