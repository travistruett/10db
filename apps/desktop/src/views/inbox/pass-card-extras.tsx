import { PassCardDetail, type InboxItemDto } from '@10db/contracts';
import { ActionIcon, Code, CopyButton, Group, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { PullRequestLink } from '../board/pull-request-link';

// Workbench spec §5.3-§5.5, §8.4: what a card a pass raised shows besides its title, body and options.
// Its body says what happened in words; this adds what the builder acts on outside 10db.

/** A command for the builder's own terminal, with a button that copies it. */
function CopyableCommand({ command }: { readonly command: string }) {
  return (
    <Group gap="xs" wrap="nowrap" align="center">
      <Code block style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {command}
      </Code>
      <CopyButton value={command}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? 'Copied' : 'Copy command'} withArrow>
            <ActionIcon
              size="md"
              variant="subtle"
              color={copied ? 'green' : 'gray'}
              aria-label={copied ? 'Copied' : 'Copy command'}
              onClick={copy}
            >
              {copied ? <IconCheck size={20} stroke={1.5} /> : <IconCopy size={20} stroke={1.5} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

/** A pass card's extras by its `detail.kind`; nothing for any other card. */
export function PassCardExtras({ item }: { readonly item: InboxItemDto }) {
  // The detail is the daemon's JSON: parsed, never trusted to be a pass card.
  const detail = PassCardDetail.safeParse(item.detail);
  if (!detail.success) return null;
  const card = detail.data;
  switch (card.kind) {
    case 'pass_branch_moved':
      return <CopyableCommand command={card.mergeCommand} />;
    case 'pass_follow_on':
      return card.prUrl === null ? null : <PullRequestLink url={card.prUrl} />;
    case 'pass_gate_failed':
      // Its `logPath` is what the card's step log link already opens.
      return null;
    // Answered by their options, or in the Workbench (Move, Retarget).
    case 'pass_move_to_copy':
    case 'pass_move':
    case 'pass_retarget':
    case 'shared_ask':
      return null;
  }
}
