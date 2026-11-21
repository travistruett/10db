import type { DecisionId, GoalId, PrincipleId, ShapeAcceptDto, ShapeId } from '@10db/contracts';
import { Button, Stack, Text, Textarea } from '@mantine/core';
import { useState } from 'react';
import {
  useRemoveDraftGoal,
  useUndoAccept,
  useWithdrawDecision,
  useWithdrawPrinciple,
} from '../../../daemon/shape-queries';
import { FormModal } from '../../../shell/form-modal';
import { useNow } from '../../../shell/relative';
import { shortAgo } from '../../factory/short-ago';

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

export interface PrincipleWithdrawTarget {
  readonly principleId: PrincipleId;
  readonly title: string;
}

/** The reason form both withdrawals share: the record leaves searches and context packs, and the builder says why. */
function WithdrawReasonModal({
  noun,
  title,
  opened,
  pending,
  error,
  onSubmit,
  onReset,
  onClose,
}: {
  /** `Decision` or `Principle`: names the modal and its button. */
  readonly noun: string;
  /** The record's own words, quoted in the sentence under the title. */
  readonly title: string;
  readonly opened: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: (reason: string, done: () => void) => void;
  readonly onReset: () => void;
  readonly onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const close = () => {
    onReset();
    setReason('');
    onClose();
  };
  return (
    <FormModal
      opened={opened}
      onClose={close}
      title={`Withdraw ${noun}`}
      size="md"
      error={error}
      actions={
        <>
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button
            loading={pending}
            disabled={reason.trim() === ''}
            onClick={() => {
              onSubmit(reason.trim(), close);
            }}
          >
            {`Withdraw ${noun}`}
          </Button>
        </>
      }
    >
      <Stack gap="sm">
        <Text size="sm">
          {opened ? `“${title}” leaves searches and what sessions are told.` : ''}
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

/** Withdraw Decision: the decision leaves searches and context packs; the builder says why. */
export function WithdrawDecisionModal({
  shapeId,
  target,
  onClose,
}: {
  readonly shapeId: ShapeId;
  readonly target: WithdrawTarget | null;
  readonly onClose: () => void;
}) {
  const withdraw = useWithdrawDecision(shapeId);
  return (
    <WithdrawReasonModal
      noun="Decision"
      title={target?.title ?? ''}
      opened={target !== null}
      pending={withdraw.isPending}
      error={withdraw.error?.message ?? null}
      onSubmit={(reason, done) => {
        if (target) withdraw.mutate({ decisionId: target.decisionId, reason }, { onSuccess: done });
      }}
      onReset={withdraw.reset}
      onClose={onClose}
    />
  );
}

/** Withdraw Principle: the principle leaves searches and context packs; the builder says why. */
export function WithdrawPrincipleModal({
  shapeId,
  target,
  onClose,
}: {
  readonly shapeId: ShapeId;
  readonly target: PrincipleWithdrawTarget | null;
  readonly onClose: () => void;
}) {
  const withdraw = useWithdrawPrinciple(shapeId);
  return (
    <WithdrawReasonModal
      noun="Principle"
      title={target?.title ?? ''}
      opened={target !== null}
      pending={withdraw.isPending}
      error={withdraw.error?.message ?? null}
      onSubmit={(reason, done) => {
        if (target)
          withdraw.mutate({ principleId: target.principleId, reason }, { onSuccess: done });
      }}
      onReset={withdraw.reset}
      onClose={onClose}
    />
  );
}

const plural = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/** What Undo Accept takes back, a zero part dropped: "1 goal, 2 tasks; withdraws 1 record". */
function undoSummary(accept: ShapeAcceptDto): string {
  const board = [
    accept.goals === 0 ? null : plural(accept.goals, 'goal'),
    accept.tasks === 0 ? null : plural(accept.tasks, 'task'),
  ]
    .filter((part) => part !== null)
    .join(', ');
  const records = accept.records === 0 ? '' : `withdraws ${plural(accept.records, 'record')}`;
  return [board, records].filter((part) => part !== '').join('; ');
}

/**
 * The confirm before Undo Accept: the plan's latest Accept is taken back (its goals, tasks and records),
 * and its rows are proposed again. The daemon refuses in words when a task has started; they show here.
 */
export function UndoAcceptModal({
  shapeId,
  accept,
  onClose,
}: {
  readonly shapeId: ShapeId;
  readonly accept: ShapeAcceptDto | null;
  readonly onClose: () => void;
}) {
  const undo = useUndoAccept(shapeId);
  const now = useNow();
  const close = () => {
    undo.reset();
    onClose();
  };
  const summary = accept === null ? '' : undoSummary(accept);
  return (
    <FormModal
      opened={accept !== null}
      onClose={close}
      title="Undo Accept"
      size="md"
      error={undo.error?.message ?? null}
      actions={
        <>
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button
            color="red"
            loading={undo.isPending}
            onClick={() => {
              if (accept) undo.mutate(accept.id, { onSuccess: close });
            }}
          >
            Undo Accept
          </Button>
        </>
      }
    >
      <Stack gap="xs">
        {accept === null ? null : (
          <Text size="sm">
            {`Takes back what the Accept of ${shortAgo(accept.at, now)} put on the Board${summary === '' ? '' : `: ${summary}`}.`}
          </Text>
        )}
        {accept === null || accept.kept === 0 ? null : (
          <Text size="sm" c="dimmed">{`${String(accept.kept)} stay.`}</Text>
        )}
      </Stack>
    </FormModal>
  );
}
