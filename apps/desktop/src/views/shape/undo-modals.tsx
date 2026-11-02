import type { DecisionId, GoalId, ShapeId } from '@10db/contracts';
import { Button, Stack, Text, Textarea } from '@mantine/core';
import { useState } from 'react';
import { useRemoveDraftGoal, useWithdrawDecision } from '../../daemon/shape-queries';
import { FormModal } from '../../shell/form-modal';

export interface RemoveDraftGoalTarget {
  readonly goalId: GoalId;
  readonly title: string;
  readonly taskCount: number;
}

/** The confirm before Remove Draft Goal: its tasks go with it, and the goal returns to Proposed. */
export function RemoveDraftGoalModal({
  target,
  onClose,
}: {
  readonly target: RemoveDraftGoalTarget | null;
  readonly onClose: () => void;
}) {
  const remove = useRemoveDraftGoal();
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <FormModal
      opened={target !== null}
      onClose={close}
      title="Remove Draft Goal"
      size="md"
      error={remove.error?.message ?? null}
      actions={
        <>
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button
            color="red"
            loading={remove.isPending}
            onClick={() => {
              if (target) remove.mutate(target.goalId, { onSuccess: close });
            }}
          >
            Remove Draft Goal
          </Button>
        </>
      }
    >
      <Stack gap="xs">
        <Text size="sm">
          {target === null ? '' : `Remove the draft goal “${target.title}”?`} Its tasks go with it,
          and the goal returns to Proposed, where it can be converted again.
        </Text>
        <Text size="sm" c="dimmed">
          This works only while none of its tasks has started.
        </Text>
      </Stack>
    </FormModal>
  );
}

export interface WithdrawTarget {
  readonly decisionId: DecisionId;
  readonly title: string;
}

/** Withdraw Decision…: the decision leaves searches and context packs; the builder says why. */
export function WithdrawDecisionModal({
  shapeId,
  target,
  onClose,
}: {
  readonly shapeId: ShapeId;
  readonly target: WithdrawTarget | null;
  readonly onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const withdraw = useWithdrawDecision(shapeId);
  const close = () => {
    withdraw.reset();
    setReason('');
    onClose();
  };
  return (
    <FormModal
      opened={target !== null}
      onClose={close}
      title="Withdraw Decision"
      size="md"
      error={withdraw.error?.message ?? null}
      actions={
        <>
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button
            loading={withdraw.isPending}
            disabled={reason.trim() === ''}
            onClick={() => {
              if (target)
                withdraw.mutate(
                  { decisionId: target.decisionId, reason: reason.trim() },
                  { onSuccess: close },
                );
            }}
          >
            Withdraw Decision
          </Button>
        </>
      }
    >
      <Stack gap="sm">
        <Text size="sm">
          {target === null ? '' : `“${target.title}” leaves searches and what sessions are told.`}
        </Text>
        <Textarea
          label="Reason"
          required
          autosize
          minRows={2}
          value={reason}
          onChange={(event) => {
            setReason(event.currentTarget.value);
          }}
        />
      </Stack>
    </FormModal>
  );
}
