import type { ProjectDto } from '@10db/contracts';
import { Stack } from '@mantine/core';
import { AreasSection } from './areas-section';
import { HazardsSection } from './hazards-section';

/** The project's areas and hazards, each a table whose rows open a drawer that saves that one row. */
export function ProjectAreas({ project }: { readonly project: ProjectDto }) {
  return (
    <Stack gap="xl">
      <AreasSection project={project} />
      <HazardsSection project={project} />
    </Stack>
  );
}
