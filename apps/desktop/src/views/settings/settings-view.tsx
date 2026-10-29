import { Stack } from '@mantine/core';
import { useParams } from '@tanstack/react-router';
import { useSelectedProject } from '../../shell/selected-project';
import { SectionBody } from './section-body';
import { isSettingsSectionKey, SettingsSectionKey } from './sections';

export function SettingsView() {
  const { section } = useParams({ from: '/settings/$section' });
  // The route redirects unknown sections, so this fallback is only for the type.
  const key = isSettingsSectionKey(section) ? section : SettingsSectionKey.General;
  const { project } = useSelectedProject();
  return (
    <Stack>
      <SectionBody sectionKey={key} project={project} />
    </Stack>
  );
}
