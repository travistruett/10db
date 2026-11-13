import { NavLink, SegmentedControl, Stack, Text } from '@mantine/core';
import {
  IconArrowLeft,
  IconBolt,
  IconCoffee,
  IconShieldCheck,
  IconColumns,
  IconCoin,
  IconCpu,
  IconDownload,
  IconHierarchy,
  IconKey,
  IconLock,
  IconLayoutDashboard,
  IconMap,
  IconNetwork,
  IconPlug,
  IconListCheck,
  IconRoute,
  IconSettings,
  IconUserPlus,
  IconUsers,
} from '@tabler/icons-react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useId } from 'react';
import { ProjectSwitcher } from '../../shell/project-switcher';
import {
  isSettingsSectionKey,
  sectionByKey,
  SETTINGS_SECTIONS,
  type SettingsSection,
  SettingsScope,
  SettingsSectionKey,
} from './sections';

const SECTION_ICON: Readonly<Record<SettingsSectionKey, typeof IconSettings>> = {
  [SettingsSectionKey.Overview]: IconLayoutDashboard,
  [SettingsSectionKey.General]: IconSettings,
  [SettingsSectionKey.BoardColumns]: IconColumns,
  [SettingsSectionKey.Planning]: IconListCheck,
  [SettingsSectionKey.Areas]: IconMap,
  [SettingsSectionKey.NetworkHosts]: IconNetwork,
  [SettingsSectionKey.Billing]: IconCoin,
  [SettingsSectionKey.Team]: IconUsers,
  [SettingsSectionKey.RoutingRules]: IconRoute,
  [SettingsSectionKey.Integrations]: IconPlug,
  [SettingsSectionKey.People]: IconUserPlus,
  [SettingsSectionKey.KeepAwake]: IconCoffee,
  [SettingsSectionKey.Updates]: IconDownload,
  [SettingsSectionKey.LanePermissions]: IconShieldCheck,
  [SettingsSectionKey.Trust]: IconLock,
  [SettingsSectionKey.ProjectTrust]: IconLock,
  [SettingsSectionKey.Accounts]: IconKey,
  [SettingsSectionKey.Decisions]: IconBolt,
  [SettingsSectionKey.Models]: IconCpu,
  [SettingsSectionKey.PersonasAndFlows]: IconHierarchy,
};

const SCOPE_OPTIONS = [
  { value: SettingsScope.Project, label: 'This project' },
  { value: SettingsScope.App, label: 'All projects' },
];

function isScope(value: string): value is SettingsScope {
  return value === SettingsScope.Project || value === SettingsScope.App;
}

/** The scope's sections cut into runs that share a subhead, in order. */
function subheadRuns(scope: SettingsScope): readonly {
  readonly subhead: string | null;
  readonly sections: readonly SettingsSection[];
}[] {
  const runs: { subhead: string | null; sections: SettingsSection[] }[] = [];
  for (const s of SETTINGS_SECTIONS) {
    if (s.scope !== scope || !s.built) continue;
    const last = runs.at(-1);
    if (last?.subhead === s.subhead) last.sections.push(s);
    else runs.push({ subhead: s.subhead, sections: [s] });
  }
  return runs;
}

function SectionLinks({
  sections,
  current,
}: {
  readonly sections: readonly SettingsSection[];
  readonly current: SettingsSectionKey;
}) {
  return sections.map((s) => {
    const Icon = SECTION_ICON[s.key];
    return (
      <NavLink
        key={s.key}
        label={s.label}
        active={s.key === current}
        leftSection={<Icon size={16} stroke={1.5} />}
        renderRoot={(props) => (
          <Link {...props} to="/settings/$section" params={{ section: s.key }} />
        )}
      />
    );
  });
}

function Subhead({
  subhead,
  sections,
  current,
}: {
  readonly subhead: string | null;
  readonly sections: readonly SettingsSection[];
  readonly current: SettingsSectionKey;
}) {
  const labelId = useId();
  if (subhead === null) return <SectionLinks sections={sections} current={current} />;
  return (
    <Stack gap={2} role="group" aria-labelledby={labelId} mb="xs">
      <Text id={labelId} size="xs" fw={600} c="dimmed" px="sm" pt="xs" pb={4}>
        {subhead}
      </Text>
      <SectionLinks sections={sections} current={current} />
    </Stack>
  );
}

/**
 * The sidebar while Settings is open: it takes the app nav's place, with Back at the top and a
 * switch between the selected project's sections and the ones that apply everywhere. It lists one
 * scope at a time, under subheads. Planned sections stay out.
 */
export function SettingsNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const section = pathname.split('/')[2] ?? '';
  const current = isSettingsSectionKey(section) ? section : SettingsSectionKey.General;
  const scope = sectionByKey(current).scope;

  return (
    <Stack component="nav" aria-label="Settings sections" gap={2}>
      <NavLink
        label="Back to Board"
        leftSection={<IconArrowLeft size={16} stroke={1.5} />}
        renderRoot={(props) => <Link {...props} to="/board" />}
        mb="xs"
      />
      <SegmentedControl
        aria-label="Settings scope"
        fullWidth
        size="xs"
        mb="sm"
        value={scope}
        data={SCOPE_OPTIONS}
        onChange={(value) => {
          if (!isScope(value) || value === scope) return;
          void navigate({
            to: '/settings/$section',
            params: {
              section:
                value === SettingsScope.Project
                  ? SettingsSectionKey.General
                  : SettingsSectionKey.Overview,
            },
          });
        }}
      />
      {scope === SettingsScope.Project ? <ProjectSwitcher compact /> : null}
      {subheadRuns(scope).map((run) => (
        <Subhead
          key={run.subhead ?? ''}
          subhead={run.subhead}
          sections={run.sections}
          current={current}
        />
      ))}
    </Stack>
  );
}
