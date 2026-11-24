import { Stack } from '@mantine/core';
import { useParams } from '@tanstack/react-router';
import { Panel } from '../../shell/panel';
import { useSelectedProject } from '../../shell/selected-project';
import { SettingsNav } from './settings-nav';
import { useFocusTarget } from './focus-target';
import { SectionBody } from './section-body';
import { SettingsDrafts } from './settings-drafts';
import { isSettingsSectionKey, SettingsSectionKey } from './sections';

export function SettingsView() {
  const { section } = useParams({ from: '/settings/$section' });
  // The route redirects unknown sections, so this fallback is only for the type.
  const key = isSettingsSectionKey(section) ? section : SettingsSectionKey.General;
  const { project } = useSelectedProject();
  // `?focus=<section>` lands on the section's first control.
  const { ref } = useFocusTarget<HTMLDivElement>(key);
  return (
    <>
      <Panel section="settings" title="Settings">
        <SettingsNav />
      </Panel>
      {/* The page fills the content area, so its save bar sits at the bottom edge and content that loads
          in above it never moves the bar under a pointer. */}
      <Stack ref={ref} flex="1 0 auto">
        {/* A page's edits are its own: another page starts with none. A page is keyed by its project, so
            its fields leave the bar when the project changes. */}
        <SettingsDrafts key={key}>
          <SectionBody sectionKey={key} project={project} />
        </SettingsDrafts>
      </Stack>
    </>
  );
}
