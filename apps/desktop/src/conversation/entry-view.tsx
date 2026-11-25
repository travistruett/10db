import {
  ActionIcon,
  Box,
  Button,
  Code,
  CopyButton,
  Divider,
  Group,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import {
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconAlertTriangle,
  IconX,
  IconInfoCircle,
} from '@tabler/icons-react';
import type { ConversationEntry } from './entry';
import classes from './entry-view.module.css';
import { useRowOpen } from './row-state';
import { Markdown } from './markdown';
import { formatDuration } from './tool-words';

type Entry<K extends ConversationEntry['kind']> = Extract<ConversationEntry, { kind: K }>;

/** The builder's message, on the `bg_1` panel that is theirs alone. */
function BuilderMessage({ entry }: { readonly entry: Entry<'builder'> }) {
  return (
    <Box
      data-panel
      bg="var(--tendb-color-panel)"
      py={10}
      px={12}
      style={{ borderRadius: 'var(--mantine-radius-md)' }}
    >
      <Text size="sm" c="bright" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {entry.text}
      </Text>
      {entry.extra}
    </Box>
  );
}

/** The agent's reply as markdown, with a Copy of its source; a cut one ends "Stopped here." */
function Reply({ entry }: { readonly entry: Entry<'reply'> }) {
  return (
    <Box className={classes['reply']}>
      <Markdown text={entry.text} streaming={entry.streaming === true} />
      {entry.partial && (
        <Text size="sm" c="dimmed">
          Stopped here.
        </Text>
      )}
      <Box className={classes['copy']}>
        <CopyButton value={entry.text}>
          {({ copied, copy }) => (
            <ActionIcon
              variant="subtle"
              color="gray"
              size="md"
              aria-label={copied ? 'Copied' : 'Copy'}
              onClick={copy}
            >
              {copied ? <IconCheck size={16} stroke={1.5} /> : <IconCopy size={16} stroke={1.5} />}
            </ActionIcon>
          )}
        </CopyButton>
      </Box>
    </Box>
  );
}

/** The agent's thinking, closed until the builder opens it. */
function Reasoning({ entry }: { readonly entry: Entry<'reasoning'> }) {
  const [opened, setOpened] = useRowOpen(entry.id, 'closed');
  const open = opened !== 'closed';
  const took = formatDuration(entry.durationMs);
  const label = took === null ? 'Thought' : `Thought for ${took}`;
  return (
    <Stack gap={4}>
      <UnstyledButton
        aria-expanded={open}
        onClick={() => {
          setOpened(open ? 'closed' : 'open');
        }}
        h={28}
      >
        <Group gap={8} wrap="nowrap" px={4}>
          <IconBrain
            size={16}
            stroke={1.5}
            color="var(--mantine-color-dimmed)"
            aria-hidden="true"
          />
          <Text size="sm" c="dimmed">
            {label}
          </Text>
          <IconChevronRight
            size={14}
            stroke={1.5}
            aria-hidden="true"
            style={{
              color: 'var(--mantine-color-dimmed)',
              transform: open ? 'rotate(90deg)' : undefined,
            }}
          />
        </Group>
      </UnstyledButton>
      {open && (
        <Text size="sm" className={classes['reasoning']} style={{ whiteSpace: 'pre-wrap' }}>
          {entry.text}
        </Text>
      )}
    </Stack>
  );
}

/** One entry that is not a tool call (those are rows of their own). */
export function ConversationEntryView({ entry }: { readonly entry: ConversationEntry }) {
  switch (entry.kind) {
    case 'builder':
      return <BuilderMessage entry={entry} />;
    case 'reply':
      return <Reply entry={entry} />;
    case 'reasoning':
      return <Reasoning entry={entry} />;
    case 'notice': {
      // A failure the builder must act on is red with a warning triangle; an answered ask is a quiet line
      // with a green check or a red cross; anything else is dim with an info icon.
      const Icon =
        entry.tone === 'error'
          ? IconAlertTriangle
          : entry.tone === 'allowed'
            ? IconCheck
            : entry.tone === 'refused'
              ? IconX
              : IconInfoCircle;
      const iconColor =
        entry.tone === 'allowed' ? 'green' : entry.tone === 'refused' ? 'red' : undefined;
      return (
        <Text
          fz={entry.tone === 'allowed' || entry.tone === 'refused' ? 13 : 'xs'}
          c={entry.tone === 'error' ? 'red' : 'dimmed'}
          style={{ overflowWrap: 'anywhere' }}
        >
          <Icon
            size={14}
            stroke={1.5}
            aria-hidden="true"
            color={iconColor === undefined ? undefined : `var(--mantine-color-${iconColor}-6)`}
            style={{ verticalAlign: '-2px' }}
          />{' '}
          {entry.text}
          {entry.call === undefined ? null : (
            <>
              {' '}
              <Code>{entry.call}</Code>
            </>
          )}
          {entry.tail}
        </Text>
      );
    }
    case 'divider':
      return (
        <Divider
          label={
            <Group gap={6}>
              <Text size="xs" c="dimmed">
                {entry.text}
              </Text>
              {entry.action !== null && (
                <Button size="compact-xs" variant="subtle" onClick={entry.action.onClick}>
                  {entry.action.label}
                </Button>
              )}
            </Group>
          }
          labelPosition="center"
        />
      );
    case 'custom':
      return <>{entry.render()}</>;
    case 'tool':
      return null;
  }
}
