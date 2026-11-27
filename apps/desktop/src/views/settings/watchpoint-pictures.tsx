import type { ToolCallHunk } from '@10db/contracts';
import { Badge, Box, Button, Group, Stack, Text } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconEyeCheck } from '@tabler/icons-react';
import { HunkDiff } from '../../conversation/hunk-diff';

// Stills of where a watchpoint shows up, drawn with the same parts and words as the real places: the changed file
// and its hunk, a fold of the task's For You, and the Inbox's Look card. The guide and the When It Matches card
// show them; nothing in them is live.

const TASK = 'Speed up order lookups';
const FILE = 'packages/db/drizzle/0042_order_lookups.sql';

const HUNK: ToolCallHunk = {
  oldStart: 0,
  oldLines: 0,
  newStart: 1,
  newLines: 2,
  before: '',
  after: 'CREATE INDEX orders_by_customer\n  ON orders (customer_id);\n',
};

/** The surface a still's part sits on, as the drawer and the Inbox draw it. */
const ON_PAGE = {
  background: 'var(--mantine-color-body)',
  border: '1px solid var(--mantine-color-default-border)',
  borderRadius: 'var(--mantine-radius-md)',
} as const;

/** The file a task changed, with its hunk, as Changes and a fold draw it. */
export function ChangedFilePicture() {
  return (
    <Stack gap={6}>
      <Group gap="xs" wrap="nowrap">
        <Text size="xs" ff="monospace" truncate>
          {FILE}
        </Text>
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
          new
        </Text>
      </Group>
      <Box fz={11}>
        <HunkDiff hunk={HUNK} first />
      </Box>
    </Stack>
  );
}

/** A fold's head: the watchpoint, how loud it is and how many files. */
function FoldHead({
  loudness,
  open,
}: {
  readonly loudness: 'Show' | 'Ask';
  readonly open: boolean;
}) {
  const Chevron = open ? IconChevronDown : IconChevronRight;
  return (
    <Group gap={6} wrap="nowrap">
      <Chevron size={12} stroke={1.75} color="var(--mantine-color-dimmed)" />
      <Text size="xs" fw={600}>
        Migrations
      </Text>
      <Badge size="xs" variant="light" color={loudness === 'Ask' ? 'yellow' : 'gray'}>
        {loudness}
      </Badge>
      <Text size="xs" c="dimmed">
        1 file
      </Text>
    </Group>
  );
}

function Note({
  who,
  children,
  tone,
}: {
  readonly who: string;
  readonly children: string;
  readonly tone?: string;
}) {
  return (
    <>
      <Text fz={10} fw={600} c="dimmed">
        {who}
      </Text>
      <Text size="xs" {...(tone === undefined ? {} : { c: tone })}>
        {children}
      </Text>
    </>
  );
}

/** The task's For You, opened on the watchpoint: the file with the agent's reason and the reviewer's check. */
export function ForYouPicture() {
  return (
    <Stack gap={8} p={10} style={ON_PAGE}>
      <FoldHead loudness="Ask" open />
      <Text size="xs" ff="monospace" truncate>
        {FILE}
      </Text>
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: '52px minmax(0, 1fr)',
          columnGap: 8,
          rowGap: 4,
          alignItems: 'baseline',
        }}
      >
        <Note who="Agent">Adds an index so a customer&apos;s orders load at once.</Note>
        <Note who="Reviewer" tone="green">
          ✓ Built without locking the table.
        </Note>
      </Box>
    </Stack>
  );
}

/** The Look card the Inbox holds for a change that touched a watchpoint set to Ask. */
export function LookCardPicture() {
  return (
    <Stack gap={6} p={10} style={ON_PAGE}>
      <Group gap={6} wrap="nowrap">
        <IconEyeCheck size={13} stroke={1.75} color="var(--mantine-color-yellow-text)" />
        <Text fz={11} c="dimmed" truncate>
          Look · acme-web · 2m
        </Text>
      </Group>
      <Text size="xs" fw={600} truncate>
        {`Look at these changes: ${TASK}`}
      </Text>
      <Group justify="flex-end" gap={6} pt={6} style={{ borderTop: ON_PAGE.border }}>
        <Button size="compact-xs" variant="default" tabIndex={-1}>
          Send Back
        </Button>
        <Button size="compact-xs" tabIndex={-1}>
          Looks Right
        </Button>
      </Group>
    </Stack>
  );
}

/** One line of a still, for a hover card's option: a fold's head as For You shows it. */
export function FoldChip({ loudness }: { readonly loudness: 'Show' | 'Ask' }) {
  return (
    <Box px={8} py={5} style={{ ...ON_PAGE, display: 'inline-block' }}>
      <FoldHead loudness={loudness} open={false} />
    </Box>
  );
}

/** One line of a still, for a hover card's option: the Look card's title as the Inbox lists it. */
export function LookChip() {
  return (
    <Group gap={6} wrap="nowrap" px={8} py={5} style={{ ...ON_PAGE, display: 'inline-flex' }}>
      <IconEyeCheck size={13} stroke={1.75} color="var(--mantine-color-yellow-text)" />
      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
        Look
      </Text>
      <Text size="xs" truncate>
        {TASK}
      </Text>
    </Group>
  );
}
