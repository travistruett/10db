import { Group, Stack, Title } from '@mantine/core';
import { useParams } from '@tanstack/react-router';
import { useSelectedProject } from '../../shell/selected-project';
import { SectionBody } from './section-body';
import { isSettingsSectionKey, SettingsSectionKey } from './sections';
import { SettingsNav } from './settings-nav';

export function SettingsView() {
  const { section } = useParams({ from: '/settings/$section' });
  // The route redirects unknown sections, so this fallback is only for the type.
  const key = isSettingsSectionKey(section) ? section : SettingsSectionKey.General;
  const { project, select } = useSelectedProject();
  return (
    <Stack>
      <Title order={2}>Settings</Title>
      <Group align="flex-start" wrap="nowrap" gap="lg">
        <SettingsNav current={key} project={project} onProject={select} />
        <Stack flex={1} miw={0}>
          <SectionBody sectionKey={key} project={project} />
        </Stack>
      </Group>
    </Stack>
  );
}
