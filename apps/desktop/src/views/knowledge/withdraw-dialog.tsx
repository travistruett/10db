import { DecisionId, KnowledgeItemKind, KnowledgeState, PrincipleId } from '@10db/contracts';
import { Button, Loader, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import {
  useNewestVersion,
  useWithdrawDecision,
  useWithdrawPrinciple,
  type NewestVersion,
  type TracedRecord,
} from '../../daemon/knowledge-queries';
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
  const decision = useWithdrawDecision();
  const principle = useWithdrawPrinciple();
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
  const isDecision = target.kind === KnowledgeItemKind.Decision;
  const withdraw = isDecision ? decision : principle;
  return (
    <ReasonDialog
      title={isDecision ? 'Withdraw Decision' : 'Withdraw Principle'}
      intro={`“${target.label}” leaves briefings and search. It stays under History with your reason.`}
      submitLabel="Withdraw"
      required
      pending={withdraw.isPending}
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
