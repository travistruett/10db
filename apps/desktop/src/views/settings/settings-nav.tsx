import { NavLink, Stack, Text } from '@mantine/core';
import {
  IconArrowLeft,
  IconBolt,
  IconCoffee,
  IconShieldCheck,
  IconColumns,
  IconCoin,
  IconCpu,
  IconHierarchy,
  IconKey,
  IconMap,
  IconNetwork,
  IconRoute,
  IconSettings,
  IconUsers,
} from '@tabler/icons-react';
import { Link, useRouterState } from '@tanstack/react-router';
import { ProjectSwitcher } from '../../shell/project-switcher';
import {
  isSettingsSectionKey,
  SETTINGS_SECTIONS,
  SettingsGroup,
  SettingsSectionKey,
} from './sections';

const SECTION_ICON: Readonly<Record<SettingsSectionKey, typeof IconSettings>> = {
  [SettingsSectionKey.General]: IconSettings,
  [SettingsSectionKey.BoardColumns]: IconColumns,
  [SettingsSectionKey.Areas]: IconMap,
  [SettingsSectionKey.NetworkHosts]: IconNetwork,
  [SettingsSectionKey.Billing]: IconCoin,
  [SettingsSectionKey.Team]: IconUsers,
  [SettingsSectionKey.RoutingRules]: IconRoute,
  [SettingsSectionKey.KeepAwake]: IconCoffee,
  [SettingsSectionKey.LanePermissions]: IconShieldCheck,
  [SettingsSectionKey.Accounts]: IconKey,
  [SettingsSectionKey.Decisions]: IconBolt,
  [SettingsSectionKey.Models]: IconCpu,
  [SettingsSectionKey.PersonasAndFlows]: IconHierarchy,
};

/**
 * The sidebar while Settings is open: it takes the app nav's place, with Back at the top, the
 * selected project's sections and then the ones that apply everywhere. Planned sections stay out.
 */
export function SettingsNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const section = pathname.split('/')[2] ?? '';
  const current = isSettingsSectionKey(section) ? section : SettingsSectionKey.General;

  return (
    <Stack component="nav" aria-label="Settings sections" gap={2}>
      <NavLink
        label="Back to Board"
        leftSection={<IconArrowLeft size={16} stroke={1.5} />}
        renderRoot={(props) => <Link {...props} to="/board" />}
        mb="xs"
      />
      {Object.values(SettingsGroup).map((group) => (
        <Stack key={group} gap={2} mb="sm">
          {/* Both groups get the same label, so the switcher reads as the first row of Project, and
              the sections under it as that project's. */}
          <Text
            size="xs"
            fw={600}
            c="dimmed"
            px="sm"
            pt={group === SettingsGroup.Project ? 0 : 'xs'}
            pb={4}
          >
            {group === SettingsGroup.Project ? 'Project' : 'Global'}
          </Text>
          {group === SettingsGroup.Project ? <ProjectSwitcher compact /> : null}
          {SETTINGS_SECTIONS.filter((s) => s.group === group && s.planned === null).map((s) => {
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
          })}
        </Stack>
      ))}
    </Stack>
  );
}
