import type { BranchNote } from '@10db/contracts';
import { ActionIcon, Code, CopyButton, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';

// Workbench setup, Branch: the base branch's commits origin lacks, and the push as a command to copy.
// Setup never pushes: a push runs the repository's hooks and sends commits to a remote.

export function BranchRow({ note }: { readonly note: BranchNote }) {
  const one = note.ahead === 1;
  return (
    <Stack gap="xs">
      <Text size="sm">
        <Code>{note.branch}</Code> has {note.ahead} {one ? 'commit' : 'commits'} <Code>origin</Code>{' '}
        lacks: a pull request would carry {one ? 'it' : 'them'}.
      </Text>
      <Group gap="xs" wrap="nowrap" align="center">
        <Code block style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {note.command}
        </Code>
        <CopyButton value={note.command}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? 'Copied' : 'Copy command'} withArrow>
              <ActionIcon
                size="md"
                variant="subtle"
                color={copied ? 'green' : 'gray'}
                aria-label={copied ? 'Copied' : 'Copy command'}
                onClick={copy}
              >
                {copied ? (
                  <IconCheck size={20} stroke={1.5} />
                ) : (
                  <IconCopy size={20} stroke={1.5} />
                )}
              </ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      </Group>
    </Stack>
  );
}
