import { Box, Button, Group, List, Popover, Stack, Text } from '@mantine/core';
import { IconTerminal2 } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useEffect, useRef, useState } from 'react';

// Sessions UI spec §10.2: a chat in the builder's terminal. The banner is neutral: nothing here is wrong.

export interface TerminalBannerProps {
  /** The agent's name, `capabilities.label`. */
  readonly label: string;
  /** When the chat went to the terminal, once read. */
  readonly since: string | null;
  /** What the builder was told when it opened. */
  readonly notes: readonly string[];
  readonly onHandBack: () => void;
  readonly handingBack: boolean;
  readonly onCopyCommand: () => void;
  /** The Copy Command button says "Copied" for a moment. */
  readonly copied: boolean;
  readonly error: string | null;
}

export function TerminalBanner({
  label,
  since,
  notes,
  onHandBack,
  handingBack,
  onCopyCommand,
  copied,
  error,
}: TerminalBannerProps) {
  const [asking, setAsking] = useState(false);
  const handBack = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  // Switching to this tab puts the focus on Hand Back, the likely next act; Tab reaches the composer.
  useEffect(() => {
    handBack.current?.focus();
  }, []);
  // The question's Hand Back takes the focus, so Enter confirms.
  useEffect(() => {
    if (asking) confirm.current?.focus();
  }, [asking]);
  return (
    <Box
      role="region"
      aria-label="In your terminal"
      mx="md"
      mb="xs"
      p="sm"
      bg="var(--mantine-color-body)"
      style={{
        flex: 'none',
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-md)',
      }}
    >
      <Group gap="sm" align="flex-start" wrap="nowrap">
        <IconTerminal2 size={16} stroke={1.5} aria-hidden="true" style={{ marginTop: 3 }} />
        <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
          <Text size="sm" fw={600}>
            {since === null
              ? 'In your terminal'
              : `In your terminal since ${dayjs(since).format('HH:mm')}`}
          </Text>
          <Text size="sm">
            This runs outside 10db&apos;s sandbox. 10db won&apos;t touch this session until you hand
            it back.
          </Text>
          {notes.length === 0 ? null : (
            <List size="xs" c="dimmed" spacing={2} aria-label="What to know">
              {notes.map((note) => (
                <List.Item key={note}>{note}</List.Item>
              ))}
            </List>
          )}
          {error === null ? null : (
            <Text size="sm" c="red" role="alert">
              {error}
            </Text>
          )}
          <Group gap="xs" pt={4}>
            <Popover
              opened={asking}
              onChange={setAsking}
              position="top-start"
              withArrow
              hideDetached={false}
            >
              <Popover.Target>
                <Button
                  ref={handBack}
                  size="xs"
                  loading={handingBack}
                  onClick={() => {
                    setAsking((open) => !open);
                  }}
                >
                  Hand Back
                </Button>
              </Popover.Target>
              <Popover.Dropdown aria-label="Hand Back">
                <Stack gap="xs">
                  <Text size="sm">Is {label} closed in your terminal?</Text>
                  <Group gap="xs">
                    <Button
                      size="xs"
                      ref={confirm}
                      onClick={() => {
                        setAsking(false);
                        onHandBack();
                      }}
                    >
                      Hand Back
                    </Button>
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() => {
                        setAsking(false);
                      }}
                    >
                      Cancel
                    </Button>
                  </Group>
                </Stack>
              </Popover.Dropdown>
            </Popover>
            <Button size="xs" variant="default" onClick={onCopyCommand}>
              {copied ? 'Copied' : 'Copy Command'}
            </Button>
          </Group>
        </Stack>
      </Group>
    </Box>
  );
}
