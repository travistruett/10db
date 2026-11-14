import type { JudgeDecision } from '@10db/contracts';
import { Drawer } from '@mantine/core';
import { DECISIONS } from './decision-catalogue';

/** One decision's drawer, titled with its label. */
export function DecisionDrawer({
  decision,
  onClose,
}: {
  readonly decision: JudgeDecision | null;
  readonly onClose: () => void;
}) {
  return (
    <Drawer
      opened={decision !== null}
      onClose={onClose}
      position="right"
      title={decision === null ? '' : DECISIONS[decision].label}
    >
      {null}
    </Drawer>
  );
}
