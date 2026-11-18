import type { WorkstreamChangesDto } from '@10db/contracts';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { SurfaceDrawer } from '../../shell/surface-drawer';
import { ChangesPanel } from './changes-panel';

/** The drawer's share of a surface wide enough to put the conversation beside it, as `SurfaceDrawer` sizes it. */
export const DRAWER_WIDTH = 'clamp(480px, 50%, 760px)';
/** At this width of the session the conversation column moves left of the drawer instead of under it. */
export const BESIDE_PX = 1200;

export interface ChangesDrawerProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly changes: UseQueryResult<WorkstreamChangesDto>;
  /** The session's pull request, which has the changes once its worktree is gone. */
  readonly pullRequest: string | null;
  /** The quote to put in the composer for a clicked line. */
  readonly onQuote: (text: string) => void;
}

/** What a session changed (sessions spec §6.6), in the shell's slide-out drawer. */
export function ChangesDrawer({
  opened,
  onClose,
  changes,
  pullRequest,
  onQuote,
}: ChangesDrawerProps): ReactNode {
  return (
    <SurfaceDrawer opened={opened} onClose={onClose} label="Changes">
      <ChangesPanel changes={changes} pullRequest={pullRequest} onQuote={onQuote} />
    </SurfaceDrawer>
  );
}
