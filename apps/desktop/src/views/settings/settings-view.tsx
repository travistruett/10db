import { Stack } from '@mantine/core';
import { useParams } from '@tanstack/react-router';
import { useSelectedProject } from '../../shell/selected-project';
import { useFocusTarget } from './focus-target';
import { SectionBody } from './section-body';
import { isSettingsSectionKey, SettingsSectionKey } from './sections';

export function SettingsView() {
  const { section } = useParams({ from: '/settings/$section' });
  // The route redirects unknown sections, so this fallback is only for the type.
  const key = isSettingsSectionKey(section) ? section : SettingsSectionKey.General;
  const { project } = useSelectedProject();
  // `?focus=<section>` lands on the section's first control.
  const { ref } = useFocusTarget<HTMLDivElement>(key);
  return (
    <Stack ref={ref}>
      <SectionBody sectionKey={key} project={project} />
    </Stack>
  );
}
