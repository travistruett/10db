import { Badge, Divider, Group, Stack, Text } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { Fragment } from 'react';
import { PageGuide, STILL_SURFACE, type PageGuideHandle } from '../../shell/page-guide';
import { PathSummary } from './table-cells';

export const AREAS_GUIDE = 'How areas and hazards work';

// Stills of a project split into areas, drawn with the page's own path chips and the Board's words. Nothing in
// them is live.

function Area({ children }: { readonly children: string }) {
  return (
    <Badge size="sm" tt="none" fw={500} variant="light" color="gray" style={{ flex: 'none' }}>
      {children}
    </Badge>
  );
}

/** A task and the areas it names, with the paths one of them covers. */
function TaskAreasPicture() {
  return (
    <Stack gap={8} p={10} style={STILL_SURFACE}>
      <Text size="xs" fw={600} truncate>
        Add a promo code field to checkout
      </Text>
      <Group gap={4} wrap="nowrap">
        <Area>Checkout</Area>
        <Area>API</Area>
      </Group>
      <PathSummary paths={['apps/web/checkout/**', 'packages/api/orders/**']} />
    </Stack>
  );
}

interface Lane {
  readonly task: string;
  readonly area: string;
  readonly state: string;
  readonly waits: boolean;
}

function LanesPicture({ lanes }: { readonly lanes: readonly Lane[] }) {
  return (
    <Stack gap={0} style={STILL_SURFACE}>
      {lanes.map((lane, index) => (
        <Fragment key={lane.task}>
          {index === 0 ? null : <Divider />}
          <Group gap={8} wrap="nowrap" px={10} py={6}>
            <Text size="xs" fw={500} truncate style={{ flex: 1, minWidth: 0 }}>
              {lane.task}
            </Text>
            <Area>{lane.area}</Area>
            <Text
              fz={11}
              w={92}
              ta="right"
              c={lane.waits ? 'yellow' : 'teal'}
              style={{ flex: 'none' }}
            >
              {lane.state}
            </Text>
          </Group>
        </Fragment>
      ))}
    </Stack>
  );
}

/** A lockfile one task holds, and the task that waits for it. */
function HazardPicture() {
  return (
    <Stack gap={8} p={10} style={STILL_SURFACE}>
      <Group gap={6} wrap="nowrap">
        <IconLock size={13} stroke={1.75} color="var(--mantine-color-dimmed)" />
        <Text size="xs" fw={600} style={{ flex: 'none' }}>
          Lockfile
        </Text>
        <PathSummary paths={['pnpm-lock.yaml']} />
      </Group>
      <Stack gap={2}>
        <Text fz={11}>
          <Text span fz={11} c="teal">
            Held by{' '}
          </Text>
          Add a promo code field to checkout
        </Text>
        <Text fz={11}>
          <Text span fz={11} c="yellow">
            Waits for it:{' '}
          </Text>
          Upgrade the date library
        </Text>
      </Stack>
    </Stack>
  );
}

/** How areas and hazards work: areas let tasks run side by side, hazards keep risky files to one task. */
export function AreasGuide({
  guide,
  project,
}: {
  readonly guide: PageGuideHandle;
  readonly project: string;
}) {
  return (
    <PageGuide
      guide={guide}
      lead="Areas split the project, so tasks in different parts run at once. Hazards keep lockfiles and migrations to one task at a time."
      steps={[
        {
          title: 'A task names its areas',
          caption: 'Each area is a set of paths; 10db reads which ones a task touches.',
          picture: <TaskAreasPicture />,
        },
        {
          title: 'Areas run side by side',
          caption: 'Tasks in different areas run at once. The same area takes turns.',
          picture: (
            <LanesPicture
              lanes={[
                { task: 'Promo codes', area: 'Checkout', state: 'Running', waits: false },
                { task: 'Dark mode', area: 'Settings', state: 'Running', waits: false },
                { task: 'Faster totals', area: 'Checkout', state: 'Takes its turn', waits: true },
              ]}
            />
          ),
        },
        {
          title: 'A hazard is one at a time',
          caption: 'A task that changes a hazard waits for the task holding it.',
          picture: <HazardPicture />,
        },
      ]}
      scope={`These apply in ${project} only. 10db suggests both from the repository.`}
    />
  );
}
