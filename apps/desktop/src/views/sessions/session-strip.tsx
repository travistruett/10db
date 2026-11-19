import { Group, Text, Tooltip, UnstyledButton } from '@mantine/core';
import type { ReactNode } from 'react';
import classes from './session-strip.module.css';

export interface StripChanges {
  /** Null while the diff can't be read (a gone worktree whose pull request holds the changes). */
  readonly totals: {
    readonly files: number;
    readonly added: number;
    readonly removed: number;
  } | null;
  readonly open: boolean;
  readonly onToggle: () => void;
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/**
 * The thin line under a session's composer: where the session works on the left, then the agent running it,
 * the context ring and what changed, which opens the Changes drawer.
 */
export function SessionStrip({
  place,
  agent,
  context,
  changes,
}: {
  /** The project and its git state, in git's words (`sessionMeta`). */
  readonly place: string;
  /** The agent's name ("Claude Code", "Codex"). */
  readonly agent: string;
  readonly context: ReactNode;
  /** Null when nothing has changed: the count shows only once there is something to open. */
  readonly changes: StripChanges | null;
}) {
  const { totals } = changes ?? { totals: null };
  return (
    <Group gap={12} wrap="nowrap" className={classes['strip']}>
      <Text size="xs" c="dimmed" truncate title={place} className={classes['place']}>
        {place}
      </Text>
      <Tooltip label={`${agent} runs this session`}>
        <Text size="xs" c="dimmed" component="span" tabIndex={0} className={classes['agent']}>
          {agent}
        </Text>
      </Tooltip>
      {context}
      {changes === null ? null : (
        <Tooltip label={`${changes.open ? 'Hide' : 'Show'} the changes  ⌘⇧D`}>
          <UnstyledButton
            className={classes['changes']}
            aria-pressed={changes.open}
            aria-label={
              totals === null
                ? 'Changes'
                : `Changes: ${plural(totals.files, 'file', 'files')}, ${String(totals.added)} added, ${String(totals.removed)} removed`
            }
            onClick={changes.onToggle}
          >
            {totals === null ? (
              'Changes'
            ) : (
              <>
                <span className={classes['added']}>+{totals.added}</span>
                <span className={classes['removed']}>−{totals.removed}</span>
              </>
            )}
          </UnstyledButton>
        </Tooltip>
      )}
    </Group>
  );
}
