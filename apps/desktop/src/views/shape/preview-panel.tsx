import type { ShapePreviewDto, ShapePreviewItem } from '@10db/contracts';
import { Box, Group, Stack, Text } from '@mantine/core';
import { IconArrowsSplit } from '@tabler/icons-react';
import { useId } from 'react';
import { previewSummary, hoursText } from './preview-text';

// Shape spec §10.2: how the project's lanes would run the draft. Work already running or queued holds
// its lane first; the critical path is blue; a clash is a dimmed line with a Tabler arrows-split icon
// and no status color; the end is marked "estimate". A preview is read, never written.

const BLUE = 'var(--mantine-color-blue-6)';

function Bar({ item }: { readonly item: ShapePreviewItem }) {
  return (
    <Box
      component="li"
      data-key={item.key}
      data-critical={item.critical ? 'true' : 'false'}
      py={4}
      pl="xs"
      style={{
        listStyle: 'none',
        borderInlineStart: `2px solid ${item.critical ? BLUE : 'var(--mantine-color-default-border)'}`,
        ...(item.critical ? { color: BLUE } : {}),
      }}
    >
      <Group gap={6} wrap="nowrap" justify="space-between">
        <Text
          size="xs"
          truncate="end"
          {...(item.existing && !item.critical ? { c: 'dimmed' } : {})}
        >
          {item.title}
        </Text>
        <Text size="xs" c="dimmed" style={{ flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
          {`${hoursText(item.startHours)}–${hoursText(item.endHours)}`}
          {item.existing ? ' · already in the factory' : ''}
        </Text>
      </Group>
    </Box>
  );
}

export function PreviewPanel({ preview }: { readonly preview: ShapePreviewDto }) {
  const headingId = useId();
  if (preview.tasks === 0) return null;
  const titles = new Map(preview.lanes.flatMap((l) => l.items.map((i) => [i.key, i.title])));
  const path = preview.criticalPath.map((key) => titles.get(key) ?? key);
  return (
    <Box component="section" role="region" aria-labelledby={headingId} mt="md">
      <Stack gap={6}>
        <Text id={headingId} size="xs" fw={500} c="dimmed" tt="uppercase">
          Factory preview
        </Text>
        <Text size="xs">{previewSummary(preview)}</Text>
        {preview.lanes.map((lane, index) => (
          <Box key={lane.items[0]?.key ?? index}>
            <Text size="xs" c="dimmed" id={`${headingId}-lane-${String(index)}`}>
              {`Lane ${String(index + 1)}`}
            </Text>
            <Box component="ul" m={0} p={0} aria-labelledby={`${headingId}-lane-${String(index)}`}>
              {lane.items.map((item) => (
                <Bar key={item.key} item={item} />
              ))}
            </Box>
          </Box>
        ))}
        {path.length === 0 ? null : (
          <Text size="xs" style={{ color: BLUE }}>{`Critical path: ${path.join(' → ')}`}</Text>
        )}
        {preview.clashes.map((clash) => (
          <Group key={clash.area} gap={6} wrap="nowrap" align="flex-start" data-clash={clash.area}>
            <Text c="dimmed" component="span" style={{ display: 'inline-flex', flex: 'none' }}>
              <IconArrowsSplit size={16} stroke={1.5} aria-hidden="true" />
            </Text>
            <Text size="xs" c="dimmed">
              {clash.text}
            </Text>
          </Group>
        ))}
      </Stack>
    </Box>
  );
}
