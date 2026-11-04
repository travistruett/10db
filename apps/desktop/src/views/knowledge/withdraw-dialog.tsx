import {
  DecisionId,
  KnowledgeItemKind,
  KnowledgeState,
  PrincipleId,
  type KnowledgeItemDto,
} from '@10db/contracts';
import { Button, Loader, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import {
  useNewestVersion,
  useWithdrawDecision,
  useWithdrawPreview,
  useWithdrawPrinciple,
  type NewestVersion,
  type TracedRecord,
} from '../../daemon/knowledge-queries';
import { DaemonRequestError } from '../../daemon/client';
import { FormModal } from '../../shell/form-modal';
import { ReasonDialog } from './reason-dialog';
import { STATE_LABELS } from './knowledge-labels';

/** A record to withdraw, with the state its row showed. */
export type Withdrawable = TracedRecord & { readonly state: KnowledgeState };

/** Only the newest version of a chain can be withdrawn, so an older one is pointed at it. */
function NewerVersion({
  record,
  onClose,
  onPick,
}: {
  readonly record: Withdrawable;
  readonly onClose: () => void;
  readonly onPick: (newest: NewestVersion) => void;
}) {
  const newest = useNewestVersion(record);
  const what = record.kind === KnowledgeItemKind.Decision ? 'Decision' : 'Principle';
  const found = newest.data ?? null;
  return (
    <FormModal
      opened
      onClose={onClose}
      title={`Withdraw ${what}`}
      size="md"
      error={newest.isError ? newest.error.message : null}
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          {found?.state === KnowledgeState.Current ? (
            <Button
              color="red"
              onClick={() => {
                onPick(found);
              }}
            >
              Withdraw Newest Version
            </Button>
          ) : null}
        </>
      }
    >
      <Stack gap="sm">
        <Text size="sm">{`“${record.label}” has a newer version, so it can’t be withdrawn.`}</Text>
        {newest.isPending ? <Loader size="sm" aria-label="Finding the newest version" /> : null}
        {found ? (
          <>
            <Text size="sm">
              {found.state === KnowledgeState.Current
                ? 'Withdraw the newest version instead:'
                : `The newest version is ${STATE_LABELS[found.state].toLowerCase()}, so there is nothing left to withdraw:`}
            </Text>
            <Text size="sm" fw={500}>
              {found.label}
            </Text>
          </>
        ) : null}
      </Stack>
    </FormModal>
  );
}

/** A record in words: a decision as its question and choice, a principle as its statement. */
function wordsOf(item: KnowledgeItemDto): string {
  return item.kind === KnowledgeItemKind.Decision
    ? `${item.question} → ${item.choice}`
    : item.statement;
}

/** The daemon refused the request (400 or 409): the same check meets the real write. */
function isRefusal(error: unknown): boolean {
  return error instanceof DaemonRequestError && (error.status === 400 || error.status === 409);
}

/**
 * The reason step. Before the builder confirms it asks the daemon, by a dry run, which older version a
 * withdrawal would make current again, and names it: that text goes back into briefings.
 */
function WithdrawReason({
  target,
  onClose,
}: {
  readonly target: Withdrawable;
  readonly onClose: () => void;
}) {
  const decision = useWithdrawDecision();
  const principle = useWithdrawPrinciple();
  const preview = useWithdrawPreview(target);
  const restores = preview.data?.restores ?? null;
  // Until the dry run answers, the builder can't know whether an older text comes back, so Withdraw waits.
  // A 400 or 409 is not a failed check: the real withdrawal meets the same check and reports it itself.
  const couldNotCheck = preview.isError && !isRefusal(preview.error);
  const isDecision = target.kind === KnowledgeItemKind.Decision;
  const withdraw = isDecision ? decision : principle;
  return (
    <ReasonDialog
      title={isDecision ? 'Withdraw Decision' : 'Withdraw Principle'}
      intro={
        <>
          {`“${target.label}” leaves briefings and search. It stays under History with your reason.`}
          {restores
            ? ` “${wordsOf(restores)}” becomes current again, and returns to briefings and search.`
            : null}
          {couldNotCheck
            ? ' Couldn’t check whether an older version would become current again. If there is one, withdrawing brings it back to briefings and search.'
            : null}
        </>
      }
      submitLabel="Withdraw"
      required
      pending={withdraw.isPending}
      blocked={preview.isPending}
      error={withdraw.error?.message ?? null}
      onSubmit={(reason) => {
        if (isDecision)
          decision.mutate({ id: DecisionId.parse(target.id), reason }, { onSuccess: onClose });
        else principle.mutate({ id: PrincipleId.parse(target.id), reason }, { onSuccess: onClose });
      }}
      onClose={onClose}
    />
  );
}

/**
 * Withdraw…: the record leaves briefings and search and stays under History with the reason. Asked
 * of an older version, it says which record to withdraw instead and offers it.
 */
export function WithdrawDialog({
  record,
  onClose,
}: {
  readonly record: Withdrawable;
  readonly onClose: () => void;
}) {
  const [target, setTarget] = useState<Withdrawable>(record);
  if (target.state === KnowledgeState.Superseded)
    return (
      <NewerVersion
        record={target}
        onClose={onClose}
        onPick={(newest) => {
          setTarget(newest);
        }}
      />
    );
  return <WithdrawReason key={target.id} target={target} onClose={onClose} />;
}
