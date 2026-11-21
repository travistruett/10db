import type { ShapeId, ShapeProposalDto } from '@10db/contracts';
import { Box, SegmentedControl, Splitter } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { px, storedWidth } from '../../../shell/stored-width';
import { SurfaceDrawer } from '../../../shell/surface-drawer';
import { PlanPanel } from './plan-panel';
import classes from './plan-side.module.css';

/** The conversation keeps at least this much of the tab when the panel sits beside it. */
export const CONVERSATION_MIN_PX = 520;
/** The panel beside the conversation: the builder drags it between these, from its default. */
const PANEL_MIN_PX = 420;
const PANEL_MAX_PX = 960;
const PANEL_PX = 440;
/** The divider between the two. */
const HAIRLINE = 1;
/**
 * What the conversation's pane adds to its list's own 16 px inset, so its text is 24 px from the divider,
 * as the panel's is, and its scrollbar sits in that gutter rather than on the line.
 */
const CONVERSATION_GUTTER_PX = 8;
/** The panel as a drawer over a tab too narrow to hold both. */
const DRAWER_PX = 560;

const planWidth = storedWidth({
  key: 'tendb.plan.width',
  min: PANEL_MIN_PX,
  max: PANEL_MAX_PX,
  initial: PANEL_PX,
});

/** Whether a tab of this width holds the conversation and the panel side by side; an unmeasured tab does. */
export function planBeside(width: number): boolean {
  return width === 0 || width >= CONVERSATION_MIN_PX + PANEL_MIN_PX;
}

const Side = { Plan: 'Plan', Changes: 'Changes' } as const;
type Side = (typeof Side)[keyof typeof Side];

export interface PlanSideProps {
  readonly open: boolean;
  /** The tab's measured width; 0 before it is measured. */
  readonly width: number;
  readonly shapeId: ShapeId | null;
  readonly onClose: () => void;
  readonly onWhy: (row: ShapeProposalDto) => void;
  /** Ask for Changes on a mock-up: puts the words in the session's composer draft and focuses it. */
  readonly onAskForChanges: (text: string) => void;
  /** The session's Changes, when they are open too: the side column's head then switches between the two. */
  readonly changes?: ReactNode;
  /** The conversation, which keeps its place whether or not the panel is beside it. */
  readonly children: ReactNode;
}

/**
 * The conversation and the Plan panel beside it, split by a hairline the builder drags; on a tab too
 * narrow for both, the panel is a drawer over the conversation. With Changes open it holds either.
 */
export function PlanSide({
  open,
  width,
  shapeId,
  onClose,
  onWhy,
  onAskForChanges,
  changes = null,
  children,
}: PlanSideProps) {
  const [picked, setPicked] = useState<Side>(Side.Plan);
  const { width: stored, setWidth } = planWidth.use();
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
  const beside = planBeside(width);
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
        <PlanPanel shapeId={shapeId} onWhy={onWhy} onAskForChanges={onAskForChanges} />
      </Box>
    );
  const sideBy = open && beside;
  // A width dragged on a wider tab draws narrower here, so the conversation keeps its least, and stays stored.
  const fitted =
    width === 0
      ? stored
      : Math.max(PANEL_MIN_PX, Math.min(stored, width - CONVERSATION_MIN_PX - HAIRLINE));
  return (
    <>
      {/* The conversation is always the first pane, so opening or closing the panel never remounts it. */}
      <Splitter
        className={classes['split']}
        classNames={{ handle: classes['handle'] }}
        withHandle={false}
        lineSize={HAIRLINE}
        sizes={[100, px(fitted)]}
        onSizeChange={([, panel]) => {
          if (sideBy && panel !== undefined) setWidth(parseFloat(String(panel)));
        }}
        mod={{ side: sideBy }}
      >
        <Splitter.Pane
          defaultSize={100}
          min={px(CONVERSATION_MIN_PX)}
          className={classes['conversation']}
          style={sideBy ? { paddingRight: CONVERSATION_GUTTER_PX } : undefined}
        >
          {children}
        </Splitter.Pane>
        <Splitter.Pane
          defaultSize={px(PANEL_PX)}
          min={px(PANEL_MIN_PX)}
          max={px(PANEL_MAX_PX)}
          className={classes['side']}
          style={sideBy ? undefined : { display: 'none' }}
        >
          {sideBy ? (
            <Box component="aside" aria-label={shown} className={classes['aside']}>
              {head}
              {body}
            </Box>
          ) : null}
        </Splitter.Pane>
      </Splitter>
      {open && !beside ? (
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
      ) : null}
    </>
  );
}
