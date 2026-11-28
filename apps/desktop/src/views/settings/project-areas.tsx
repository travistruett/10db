import type { ProjectDto } from '@10db/contracts';
import { Stack } from '@mantine/core';
import { usePageGuide } from '../../shell/page-guide';
import { AreasGuide, AREAS_GUIDE } from './areas-guide';
import { AreasSection } from './areas-section';
import { HazardsSection } from './hazards-section';
import { SettingsSectionKey } from './sections';
import { SettingsPageHeader } from './settings-page';

/** The project's areas and hazards, each a table whose rows open a drawer that saves that one row. */
export function ProjectAreas({ project }: { readonly project: ProjectDto }) {
  const guide = usePageGuide(AREAS_GUIDE);
  return (
    <>
      <SettingsPageHeader
        sectionKey={SettingsSectionKey.Areas}
        project={project}
        guide={guide.opener}
      />
      <Stack gap="xl">
        <AreasSection project={project} />
        <HazardsSection project={project} />
      </Stack>
      <AreasGuide guide={guide} project={project.name} />
    </>
  );
}
