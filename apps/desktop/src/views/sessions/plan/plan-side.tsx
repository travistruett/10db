import type { ShapeId, ShapeProposalDto } from '@10db/contracts';
import { Box, SegmentedControl } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { SurfaceDrawer } from '../../../shell/surface-drawer';
import { PlanPanel } from './plan-panel';

/** The conversation keeps at least this much of the tab when the panel sits beside it. */
export const CONVERSATION_MIN_PX = 520;
/** The panel beside the conversation takes between these two widths. */
const PANEL_MIN_PX = 420;
const PANEL_MAX_PX = 480;
/** What the panel adds to its own 16 px inset, so the divider has the same 20 px on each side. */
const GUTTER_EXTRA_PX = 4;
/** The panel as a drawer over a tab too narrow to hold both. */
const DRAWER_PX = 560;

/** Whether a tab of this width holds the conversation and the panel side by side; an unmeasured tab does. */
export function planBeside(width: number): boolean {
  return width === 0 || width >= CONVERSATION_MIN_PX + PANEL_MIN_PX;
}

const Side = { Plan: 'Plan', Changes: 'Changes' } as const;
type Side = (typeof Side)[keyof typeof Side];

export interface PlanSideProps {
  readonly open: boolean;
  /** The tab holds the panel beside the conversation; otherwise it is a drawer over it. */
  readonly beside: boolean;
  readonly shapeId: ShapeId | null;
  readonly onClose: () => void;
  readonly onWhy: (row: ShapeProposalDto) => void;
  /** Ask for Changes on a mock-up: puts the words in the session's composer draft and focuses it. */
  readonly onAskForChanges: (text: string) => void;
  /** The session's Changes, when they are open too: the side column's head then switches between the two. */
  readonly changes?: ReactNode;
}

/** The Plan panel's place beside a conversation, or its drawer; with Changes open it holds either. */
export function PlanSide({
  open,
  beside,
  shapeId,
  onClose,
  onWhy,
  onAskForChanges,
  changes = null,
}: PlanSideProps) {
  const [picked, setPicked] = useState<Side>(Side.Plan);
  // Opening the Plan shows it, even while Changes are open: the builder asked for it last.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setPicked(Side.Plan);
  }
  const both = changes !== null;
  // Opening Changes beside an open Plan shows them: the builder asked for them last.
  const [hadBoth, setHadBoth] = useState(both);
  if (both !== hadBoth) {
    setHadBoth(both);
    if (both) setPicked(Side.Changes);
  }
  if (!open) return null;
  const shown = both ? picked : Side.Plan;
  const head = both ? (
    <Box px="md" pt="xs" style={{ flex: 'none' }}>
      <SegmentedControl
        size="xs"
        fullWidth
        aria-label="Side column"
        value={picked}
        data={[Side.Plan, Side.Changes]}
        onChange={(value) => {
          setPicked(value === Side.Changes ? Side.Changes : Side.Plan);
        }}
      />
    </Box>
  ) : null;
  const body =
    shown === Side.Changes ? (
      <Box style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} px="md" py="sm">
        {changes}
      </Box>
    ) : (
      <Box style={{ flex: 1, minHeight: 0 }}>
        <PlanPanel
          shapeId={shapeId}
          onWhy={onWhy}
          onAskForChanges={onAskForChanges}
          {...(beside ? { onClose } : {})}
        />
      </Box>
    );
  if (beside) {
    return (
      <Box
        component="aside"
        aria-label={shown}
        style={{
          flex: 'none',
          width: `clamp(${String(PANEL_MIN_PX)}px, 36%, ${String(PANEL_MAX_PX)}px)`,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          borderLeft: '1px solid var(--mantine-color-default-border)',
          // The panel's own px md plus this is the 20 px the conversation keeps between its text and the divider.
          paddingLeft: GUTTER_EXTRA_PX,
        }}
      >
        {head}
        {body}
      </Box>
    );
  }
  return (
    <SurfaceDrawer
      opened
      onClose={onClose}
      label={shown}
      closeLabel="Close Plan"
      widthPx={DRAWER_PX}
    >
      <Box style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {head}
        {body}
      </Box>
    </SurfaceDrawer>
  );
}
