import {
  ActionIcon,
  Box,
  Button,
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
  IconInfoCircle,
} from '@tabler/icons-react';
import { useState } from 'react';
import type { ConversationEntry } from './entry';
import classes from './entry-view.module.css';
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
      <Markdown text={entry.text} />
      {entry.partial && (
        <Text size="sm" c="dimmed">
          Stopped here.
        </Text>
      )}
      <CopyButton value={entry.text}>
        {({ copied, copy }) => (
          <ActionIcon
            className={classes['copy']}
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={copied ? 'Copied' : 'Copy'}
            onClick={copy}
          >
            {copied ? <IconCheck size={14} stroke={1.5} /> : <IconCopy size={14} stroke={1.5} />}
          </ActionIcon>
        )}
      </CopyButton>
    </Box>
  );
}

/** The agent's thinking, closed until the builder opens it. */
function Reasoning({ entry }: { readonly entry: Entry<'reasoning'> }) {
  const [open, setOpen] = useState(false);
  const took = formatDuration(entry.durationMs);
  const label = took === null ? 'Thought' : `Thought for ${took}`;
  return (
    <Stack gap={4}>
      <UnstyledButton
        aria-expanded={open}
        onClick={() => {
          setOpen((was) => !was);
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
    case 'notice':
      return (
        <Text
          size="xs"
          c={entry.tone === 'error' ? 'red' : 'dimmed'}
          style={{ overflowWrap: 'anywhere' }}
        >
          <IconInfoCircle
            size={14}
            stroke={1.5}
            aria-hidden="true"
            style={{ verticalAlign: '-2px' }}
          />{' '}
          {entry.text}
        </Text>
      );
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
