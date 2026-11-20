import { Button, Group } from '@mantine/core';
import type { OpenPageControl } from './open-page';
import { OpenPageButton } from './open-page-button';
import { RowMenu } from './row-menu';

export interface PageTitleActionsProps {
  /** The page's name, which names its menu. */
  readonly label: string;
  readonly open: OpenPageControl;
  /** Commit's variant, or null while the page has nothing to commit now. */
  readonly commit: 'filled' | 'default' | null;
  /** The pass is not open: nothing can be committed. */
  readonly commitDisabled: boolean;
  readonly committing: boolean;
  readonly onCommit: () => void;
  /** Discard on the page's menu; null once the pass is not open. */
  readonly onDiscard: (() => void) | null;
}

/** The shown page's actions in its title row: Open in Browser, Commit, then its ⋯ menu. */
export function PageTitleActions({
  label,
  open,
  commit,
  commitDisabled,
  committing,
  onCommit,
  onDiscard,
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
      {onDiscard === null ? null : <RowMenu label={label} onDiscard={onDiscard} />}
    </Group>
  );
}
