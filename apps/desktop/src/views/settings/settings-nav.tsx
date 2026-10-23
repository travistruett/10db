import type { ProjectDto, ProjectId } from '@10db/contracts';
import { Badge, NavLink, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { ProjectPicker } from '../../shell/project-picker';
import { SETTINGS_SECTIONS, SettingsGroup, type SettingsSectionKey } from './sections';

export interface SettingsNavProps {
  readonly current: SettingsSectionKey;
  readonly project: ProjectDto | null;
  readonly onProject: (id: ProjectId | null) => void;
}

const GROUP_LABEL: Readonly<Record<SettingsGroup, string>> = {
  [SettingsGroup.Project]: 'Project',
  [SettingsGroup.App]: 'App',
};

export function SettingsNav({ current, project, onProject }: SettingsNavProps) {
  return (
    <Stack component="nav" aria-label="Settings sections" w={240} gap={4}>
      {Object.values(SettingsGroup).map((group) => (
        <Stack key={group} gap={4} mb="sm">
          <Text size="xs" fw={700} c="dimmed" tt="uppercase">
            {GROUP_LABEL[group]}
          </Text>
          {group === SettingsGroup.Project && project ? (
            <ProjectPicker value={project.id} onChange={onProject} width="100%" />
          ) : null}
          {SETTINGS_SECTIONS.filter((s) => s.group === group).map((s) => (
            <NavLink
              key={s.key}
              label={s.label}
              active={s.key === current}
              rightSection={
                s.planned ? (
                  <Badge size="xs" variant="light" color="gray">
                    Planned
                  </Badge>
                ) : undefined
              }
              renderRoot={(props) => (
                <Link {...props} to="/settings/$section" params={{ section: s.key }} />
              )}
            />
          ))}
        </Stack>
      ))}
    </Stack>
  );
}
