import { Button, Group } from '@mantine/core';
import type { OpenPageControl } from './open-page';
import { OpenPageButton } from './open-page-button';

export interface PageTitleActionsProps {
  readonly open: OpenPageControl;
  /** Commit's variant, or null while the page has nothing to commit now. */
  readonly commit: 'filled' | 'default' | null;
  /** The pass is not open: nothing can be committed. */
  readonly commitDisabled: boolean;
  readonly committing: boolean;
  readonly onCommit: () => void;
}

/**
 * The shown page's actions in its title row: Open in Browser, then Commit. Discard Page is the queue
 * row's alone, where every page has it, the shown one included.
 */
export function PageTitleActions({
  open,
  commit,
  commitDisabled,
  committing,
  onCommit,
}: PageTitleActionsProps) {
  return (
    <Group gap="xs" wrap="nowrap">
      <OpenPageButton control={open} />
      {commit === null ? null : (
        <Button
          variant={commit}
          size="xs"
          loading={committing}
          disabled={commitDisabled}
          onClick={onCommit}
        >
          Commit
        </Button>
      )}
    </Group>
  );
}
