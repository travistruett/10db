import type { BranchNote } from '@10db/contracts';
import { ActionIcon, Code, CopyButton, Group, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';

/**
 * The setup's Branch: the base branch's commits `origin` lacks, and the push to run. Pushing runs the
 * repository's hooks and sends commits to a remote, so it stays the builder's own act: a command to
 * copy, never a button.
 */
export function BranchSection({ branch }: { readonly branch: BranchNote }) {
  return (
    <Stack gap="sm" component="section" aria-label="Branch">
      <Title order={3}>Branch</Title>
      <Text size="sm">
        <Code>{branch.branch}</Code>
        {` has ${String(branch.ahead)} ${branch.ahead === 1 ? 'commit' : 'commits'} `}
        <Code>origin</Code>
        {' lacks: a pull request would carry them.'}
      </Text>
      <Group gap="xs" wrap="nowrap">
        <Code style={{ overflowWrap: 'anywhere' }}>{branch.command}</Code>
        <CopyButton value={branch.command}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? 'Copied' : 'Copy command'} withArrow>
              <ActionIcon
                variant="subtle"
                color={copied ? 'green' : 'gray'}
                aria-label={copied ? 'Copied' : 'Copy command'}
                onClick={copy}
              >
                {copied ? (
                  <IconCheck size={18} stroke={1.5} />
                ) : (
                  <IconCopy size={18} stroke={1.5} />
                )}
              </ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      </Group>
    </Stack>
  );
}
