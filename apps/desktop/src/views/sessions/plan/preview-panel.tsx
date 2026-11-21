import type { ShapePreviewDto, ShapePreviewItem } from '@10db/contracts';
import { Box, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useId, useState } from 'react';
import { landingsLine, foldedSummary, hoursText } from './preview-text';

// Shape spec §10.2: how the project's lanes would run the draft, folded under the cards. Work already
// running or queued holds its lane first; a lane with no task is not drawn; the critical path is one
// dim line; a clash is the daemon's one line; the end is marked "estimate". A preview is read, never written.

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
      my={4}
      style={{
        position: 'relative',
        borderRadius: 3,
        background: 'var(--mantine-color-body)',
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
            borderRight: '2px solid var(--tendb-color-panel)',
          }}
        />
      ))}
    </Box>
  );
}

export function PreviewPanel({ preview }: { readonly preview: ShapePreviewDto }) {
  const regionId = useId();
  const [opened, setOpened] = useState(false);
  if (preview.tasks === 0) return null;
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
    <Box
      component="section"
      aria-label="How it would run"
      mt={12}
      p={8}
      style={{ borderRadius: 'var(--mantine-radius-md)', background: 'var(--tendb-color-panel)' }}
    >
      <UnstyledButton
        aria-expanded={opened}
        aria-controls={opened ? regionId : undefined}
        onClick={() => {
          setOpened((o) => !o);
        }}
        w="100%"
        px={12}
        py={4}
        style={{ position: 'relative' }}
      >
        {/* The chevron hangs in the left padding, so the label starts on the cards' title edge. */}
        <span style={{ position: 'absolute', left: 0, top: 8, display: 'inline-flex' }}>
          {opened ? (
            <IconChevronDown size={12} stroke={1.5} aria-hidden="true" />
          ) : (
            <IconChevronRight size={12} stroke={1.5} aria-hidden="true" />
          )}
        </span>
        <Group gap={8} wrap="nowrap" justify="space-between">
          <Text fz={13} fw={600} c="dimmed" style={{ flex: 'none' }}>
            How it would run
          </Text>
          <Text fz={12} c="dimmed" truncate="end" style={{ minWidth: 0 }}>
            {foldedSummary(preview)}
          </Text>
        </Group>
      </UnstyledButton>
      {opened ? (
        <Stack id={regionId} gap={8} px={12} pt={6} pb={4}>
          <Text size="xs" c="dimmed">
            {`Ends in about ${hoursText(preview.endEstimateHours)} (estimate) · ${landingsLine(preview.landings)}`}
          </Text>
          {lanes.map((lane, index) => (
            <Box key={lane.items[0]?.key ?? index}>
              {lanes.length === 1 ? null : (
                <Text size="xs" c="dimmed">
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
          {path.length === 0 ? null : (
            <Text size="xs" c="dimmed">{`Critical path: ${path.join(' → ')}`}</Text>
          )}
          {preview.clashes.map((clash) => (
            <Text key={clash.area} fz={12} c="dimmed" data-clash={clash.area}>
              {clash.text}
            </Text>
          ))}
        </Stack>
      ) : null}
    </Box>
  );
}
