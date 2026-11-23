import type { TaskId } from '@10db/contracts';
import { ActionIcon, CopyButton, Tooltip } from '@mantine/core';
import { IconCheck, IconId } from '@tabler/icons-react';

/**
 * A task's ID as an icon button that copies the full ID on one click, the ID in its tooltip. The ID is
 * what the API, Run Next and the builder MCP accept.
 */
export function CopyTaskId({ id }: { readonly id: TaskId }) {
  return (
    <CopyButton value={id} timeout={1500}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? 'Copied' : `Copy task ID: ${id}`} withArrow>
          <ActionIcon
            variant="subtle"
            color={copied ? 'green' : 'gray'}
            aria-label={`Copy task ID ${id}`}
            onClick={copy}
          >
            {copied ? <IconCheck size={18} stroke={1.5} /> : <IconId size={18} stroke={1.5} />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  );
}
