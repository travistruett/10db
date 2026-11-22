import type { ShapePreviewDto, ShapePreviewItem } from '@10db/contracts';
import { Box, Group, Stack, Text } from '@mantine/core';
import { PlanSection } from './plan-section';
import { landingsLine, foldedSummary, hoursText } from './preview-text';

// Shape spec §10.2: how the project's lanes would run the draft, a folding section after the rows. A plan of
// one task has nothing to schedule and shows none. Work already running or queued holds its lane first; a
// lane with no task is not drawn; the critical path is one dim line when there are lanes to choose between;
// a clash is the daemon's one line; the end reads "About", as an estimate. A preview is read, never written.

/** A lane's bar: each task a segment placed by its hours, the critical ones in the accent. */
function LaneBar({
  items,
  span,
}: {
  readonly items: readonly ShapePreviewItem[];
  readonly span: number;
}) {
  return (
    <Box
      aria-hidden="true"
      h={6}
      my={8}
      style={{
        position: 'relative',
        borderRadius: 3,
        background: 'var(--tendb-color-panel)',
        overflow: 'hidden',
      }}
    >
      {items.map((item) => (
        <Box
          key={item.key}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${String((item.startHours / span) * 100)}%`,
            width: `${String(((item.endHours - item.startHours) / span) * 100)}%`,
            background: item.critical
              ? 'var(--mantine-color-blue-filled)'
              : 'var(--mantine-color-dimmed)',
            borderRight: '2px solid var(--mantine-color-body)',
          }}
        />
      ))}
    </Box>
  );
}

/** The run preview's key among the folded sections. */
export const RUN_SECTION = 'run';

export function PreviewPanel({
  preview,
  folded,
  onFold,
}: {
  readonly preview: ShapePreviewDto;
  readonly folded: boolean;
  readonly onFold: () => void;
}) {
  if (preview.tasks < 2) return null;
  const titles = new Map(preview.lanes.flatMap((l) => l.items.map((i) => [i.key, i.title])));
  const path = preview.criticalPath.map((key) => titles.get(key) ?? key);
  // The simulation returns one entry per lane the project allows, so a draft that fits in fewer leaves
  // empty ones; only a lane with a task is drawn.
  const lanes = preview.lanes.filter((lane) => lane.items.length > 0);
  const span = Math.max(
    preview.scheduleHours,
    ...lanes.flatMap((l) => l.items.map((i) => i.endHours)),
    0.1,
  );
  return (
    <PlanSection
      name="How it would run"
      {...(folded ? { aside: foldedSummary(preview) } : {})}
      folded={folded}
      onFold={onFold}
    >
      <Stack component="section" aria-label="How it would run" gap={16} px={12} pt={4} pb={4}>
        <Text size="xs" c="dimmed">
          {`About ${hoursText(preview.endEstimateHours)} · ${landingsLine(preview.landings)}`}
        </Text>
        {lanes.map((lane, index) => (
          <Box key={lane.items[0]?.key ?? index}>
            {lanes.length === 1 ? null : (
              <Text size="xs" fw={600} c="dimmed">
                {`Lane ${String(index + 1)}`}
              </Text>
            )}
            <LaneBar items={lane.items} span={span} />
            <Box component="ul" m={0} p={0} style={{ listStyle: 'none' }}>
              {lane.items.map((item) => (
                <Group
                  component="li"
                  key={item.key}
                  gap={6}
                  wrap="nowrap"
                  justify="space-between"
                  data-key={item.key}
                  data-critical={item.critical ? 'true' : 'false'}
                >
                  <Text size="xs" truncate="end">
                    {item.title}
                  </Text>
                  <Text
                    size="xs"
                    c="dimmed"
                    style={{ flex: 'none', fontVariantNumeric: 'tabular-nums' }}
                  >
                    {`${hoursText(item.startHours)}–${hoursText(item.endHours)}`}
                    {item.existing ? ' · already in the factory' : ''}
                  </Text>
                </Group>
              ))}
            </Box>
          </Box>
        ))}
        {path.length === 0 || lanes.length < 2 ? null : (
          <Text size="xs" c="dimmed">{`Critical path: ${path.join(' → ')}`}</Text>
        )}
        {preview.clashes.map((clash) => (
          <Text key={clash.area} fz={12} c="dimmed" data-clash={clash.area}>
            {clash.text}
          </Text>
        ))}
      </Stack>
    </PlanSection>
  );
}
