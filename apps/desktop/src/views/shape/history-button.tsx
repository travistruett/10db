import type { ProjectId, ShapeId } from '@10db/contracts';
import { Button, Popover, Stack, Text, TextInput } from '@mantine/core';
import { IconClockHour4, IconSearch } from '@tabler/icons-react';
import { useState } from 'react';
import { useShapes } from '../../daemon/shape-queries';
import { useNow } from '../../shell/relative';
import { shortAgo } from '../factory/short-ago';
import { ConversationLink } from './conversation-link';

/** History: a searchable popover of the project's conversations, the newest first; one opens it. */
export function HistoryButton({
  projectId,
  current,
}: {
  readonly projectId: ProjectId | null;
  readonly current: ShapeId | null;
}) {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  const shapes = useShapes(projectId);
  const now = useNow();
  const needle = query.trim().toLowerCase();
  const matches = (shapes.data ?? []).filter((shape) => shape.title.toLowerCase().includes(needle));

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      // The header never scrolls away; jsdom has no layout, which would read as a detached target.
      hideDetached={false}
      position="bottom-end"
      width={340}
      shadow="md"
    >
      <Popover.Target>
        <Button
          variant="default"
          size="xs"
          aria-expanded={opened}
          leftSection={<IconClockHour4 size={14} stroke={1.5} />}
          onClick={() => {
            setOpened((o) => !o);
          }}
        >
          History
        </Button>
      </Popover.Target>
      <Popover.Dropdown p="xs">
        <TextInput
          type="search"
          size="xs"
          aria-label="Search conversations"
          placeholder="Search conversations"
          leftSection={<IconSearch size={14} stroke={1.5} />}
          value={query}
          data-autofocus
          onChange={(event) => {
            setQuery(event.currentTarget.value);
          }}
        />
        {shapes.isError ? (
          <Text size="xs" c="red" mt="xs">
            Couldn&apos;t load conversations
          </Text>
        ) : matches.length === 0 && !shapes.isLoading ? (
          <Text size="xs" c="dimmed" mt="xs">
            No conversations match
          </Text>
        ) : (
          <Stack
            component="ul"
            gap={2}
            mt="xs"
            m={0}
            p={0}
            aria-label="Conversations"
            style={{ listStyle: 'none', maxHeight: 320, overflowY: 'auto' }}
          >
            {matches.map((shape) => (
              <li key={shape.id}>
                <ConversationLink
                  shapeId={shape.id}
                  current={shape.id === current}
                  onOpen={() => {
                    setOpened(false);
                  }}
                >
                  <Text size="sm" fw={500} lineClamp={1}>
                    {shape.title}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {`${shape.state} · ${shortAgo(shape.updatedAt, now)}`}
                  </Text>
                </ConversationLink>
              </li>
            ))}
          </Stack>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
