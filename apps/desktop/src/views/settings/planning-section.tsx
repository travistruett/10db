import type { ProjectDto } from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import { OneWayPathsSetting } from './one-way-paths-setting';
import { ShapeJevSetting } from './shape-jev-setting';
import { SmallProposalLimitSetting } from './small-proposal-limit-setting';

/** How Plan treats a project's work before a lane starts it: the three settings that shape it. */
export function PlanningSection({ project }: { readonly project: ProjectDto }) {
  return (
    <Stack gap="lg">
      <Text size="sm" c="dimmed">
        How Plan treats this project's work before a lane starts it.
      </Text>
      <ShapeJevSetting project={project} />
      <OneWayPathsSetting project={project} />
      <SmallProposalLimitSetting project={project} />
    </Stack>
  );
}
