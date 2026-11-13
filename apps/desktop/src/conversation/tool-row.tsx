import { Box, Group, Text, UnstyledButton } from '@mantine/core';
import {
  IconBrain,
  IconChevronRight,
  IconFile,
  IconHierarchy,
  IconPencil,
  IconPlug,
  IconSearch,
  IconTerminal2,
  IconTool,
  IconWorld,
  type Icon,
} from '@tabler/icons-react';
import { ToolIcon } from './tool-words';

const ICONS: Readonly<Record<ToolIcon, Icon>> = {
  [ToolIcon.Terminal]: IconTerminal2,
  [ToolIcon.Pencil]: IconPencil,
  [ToolIcon.File]: IconFile,
  [ToolIcon.Search]: IconSearch,
  [ToolIcon.Plug]: IconPlug,
  [ToolIcon.Hierarchy]: IconHierarchy,
  [ToolIcon.World]: IconWorld,
  [ToolIcon.Tool]: IconTool,
  [ToolIcon.Brain]: IconBrain,
};

export interface ToolRowProps {
  readonly icon: ToolIcon;
  readonly verb: string;
  readonly target: string | null;
  readonly meta: string | null;
  readonly tone: 'dimmed' | 'red';
  /** The whole row as a screen reader says it. */
  readonly name: string;
  readonly running: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
}

/**
 * One 28 px row: the kind's icon (a blue dot while it runs), the verb, the target in mono, the meta
 * dimmed or red, and a chevron. The row is a button that opens what it holds.
 */
export function ToolRow({
  icon,
  verb,
  target,
  meta,
  tone,
  name,
  running,
  open,
  onToggle,
}: ToolRowProps) {
  const Glyph = ICONS[icon];
  const color = tone === 'red' ? 'red' : 'dimmed';
  return (
    <UnstyledButton
      aria-expanded={open}
      aria-label={name}
      onClick={onToggle}
      h={28}
      w="100%"
      style={{ minWidth: 0, borderRadius: 'var(--mantine-radius-sm)' }}
    >
      <Group gap={8} wrap="nowrap" h={28} px={4}>
        <Box w={16} h={16} style={{ display: 'grid', placeItems: 'center', flex: 'none' }}>
          {running ? (
            <Box
              data-status="running"
              w={8}
              h={8}
              bg="blue"
              style={{ borderRadius: '50%' }}
              aria-hidden="true"
            />
          ) : (
            <Glyph
              size={16}
              stroke={1.5}
              color={`var(--mantine-color-${color === 'red' ? 'red-text' : 'dimmed'})`}
              aria-hidden="true"
            />
          )}
        </Box>
        <Text size="sm" style={{ flex: 'none' }}>
          {verb}
        </Text>
        {target !== null && (
          <Text size="sm" ff="monospace" truncate="end" style={{ minWidth: 0, flex: 1 }}>
            {target}
          </Text>
        )}
        {target === null && <Box style={{ flex: 1 }} />}
        {meta !== null && (
          <Text size="xs" c={color} style={{ flex: 'none' }}>
            {meta}
          </Text>
        )}
        <IconChevronRight
          size={14}
          stroke={1.5}
          aria-hidden="true"
          style={{
            flex: 'none',
            color: 'var(--mantine-color-dimmed)',
            transform: open ? 'rotate(90deg)' : undefined,
          }}
        />
      </Group>
    </UnstyledButton>
  );
}
