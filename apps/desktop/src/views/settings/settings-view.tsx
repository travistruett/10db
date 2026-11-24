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
      <Stack ref={ref}>
        {/* A page's edits are its own: another page or project starts with none. */}
        <SettingsDrafts key={`${key}:${project?.id ?? ''}`}>
          <SectionBody sectionKey={key} project={project} />
        </SettingsDrafts>
      </Stack>
    </>
  );
}
