import type { TaskId } from '@10db/contracts';
import { CopyButton, Group, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { shortTaskId } from './task-id';

/**
 * A task's ID in a quiet style: the short form, which copies the full ID on one click. The ID is
 * what the API, Run Next and the builder MCP accept.
 */
export function CopyTaskId({ id }: { readonly id: TaskId }) {
  return (
    <CopyButton value={id} timeout={1500}>
      {({ copied, copy }) => (
        <Group gap={6} wrap="nowrap">
          <Tooltip label={copied ? 'Copied' : `Copy task ID: ${id}`} withArrow>
            <UnstyledButton
              aria-label={`Copy task ID ${id}`}
              onClick={copy}
              c={copied ? 'green' : 'dimmed'}
              fz="xs"
              ff="monospace"
            >
              {shortTaskId(id)}
            </UnstyledButton>
          </Tooltip>
          {copied ? (
            <Text span size="xs" c="green" role="status">
              <IconCheck size={12} stroke={1.5} /> Copied
            </Text>
          ) : null}
        </Group>
      )}
    </CopyButton>
  );
}
