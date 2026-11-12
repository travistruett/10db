import {
  DecisionId,
  KnowledgeItemKind,
  KnowledgeState,
  PrincipleId,
  type KnowledgeItemDto,
} from '@10db/contracts';
import { Button, Loader, Radio, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import {
  useNewestVersion,
  useRetirePrinciple,
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

/** A record to remove, with the state its row showed. */
export type Withdrawable = TracedRecord & { readonly state: KnowledgeState };

/**
 * Why a current principle is removed, which decides what removing does: one that no longer applies is
 * retired; one recorded by mistake is withdrawn, which can make an older version current again.
 */
export const RemoveWhy = { NoLongerApplies: 'no-longer-applies', Mistake: 'mistake' } as const;
export type RemoveWhy = (typeof RemoveWhy)[keyof typeof RemoveWhy];

const REMOVE_WHY_LABELS: Readonly<Record<RemoveWhy, string>> = {
  [RemoveWhy.NoLongerApplies]: 'It no longer applies',
  [RemoveWhy.Mistake]: 'It was recorded by mistake',
};

const WHYS: readonly string[] = Object.values(RemoveWhy);
const isWhy = (v: string): v is RemoveWhy => WHYS.includes(v);

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
      title={`Remove ${what}`}
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
              Remove Newest Version
            </Button>
          ) : null}
        </>
      }
    >
      <Stack gap="sm">
        <Text size="sm">{`“${record.label}” has a newer version, so it can’t be removed.`}</Text>
        {newest.isPending ? <Loader size="sm" aria-label="Finding the newest version" /> : null}
        {found ? (
          <>
            <Text size="sm">
              {found.state === KnowledgeState.Current
                ? 'Remove the newest version instead:'
                : `The newest version is ${STATE_LABELS[found.state].toLowerCase()}, so there is nothing left to remove:`}
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
 * The reason step. A current principle first asks why it is removed: no longer applies retires it, a
 * mistake withdraws it. Before a withdrawal is confirmed it asks the daemon, by a dry run, which older
 * version would become current again, and names it: that text goes back into briefings.
 */
function RemoveReason({
  target,
  onClose,
}: {
  readonly target: Withdrawable;
  readonly onClose: () => void;
}) {
  const decision = useWithdrawDecision();
  const principle = useWithdrawPrinciple();
  const retire = useRetirePrinciple();
  const preview = useWithdrawPreview(target);
  const isDecision = target.kind === KnowledgeItemKind.Decision;
  // Only a current principle can be retired; a decision or an older version can only be withdrawn.
  const canRetire = !isDecision && target.state === KnowledgeState.Current;
  const [chosen, setChosen] = useState<RemoveWhy | null>(null);
  const why = canRetire ? chosen : RemoveWhy.Mistake;
  const restores = preview.data?.restores ?? null;
  // Until the dry run answers, the builder can't know whether an older text comes back, so a withdrawal
  // waits. A 400 or 409 is not a failed check: the real withdrawal meets the same check and reports it.
  const couldNotCheck = preview.isError && !isRefusal(preview.error);
  const withdraw = isDecision ? decision : principle;
  const act = why === RemoveWhy.NoLongerApplies ? retire : withdraw;
  return (
    <ReasonDialog
      title={isDecision ? 'Remove Decision' : 'Remove Principle'}
      choice={
        canRetire ? (
          <Radio.Group
            label="Why remove it?"
            value={chosen ?? ''}
            onChange={(next) => {
              if (isWhy(next)) setChosen(next);
            }}
          >
            <Stack gap={6} mt={4}>
              {Object.values(RemoveWhy).map((w) => (
                <Radio key={w} value={w} label={REMOVE_WHY_LABELS[w]} />
              ))}
            </Stack>
          </Radio.Group>
        ) : undefined
      }
      intro={
        why === null ? (
          'Either way it leaves briefings and search and stays under Past with your reason.'
        ) : why === RemoveWhy.NoLongerApplies ? (
          `“${target.label}” no longer applies. It leaves briefings and search and stays under Past with your reason.`
        ) : (
          <>
            {`“${target.label}” leaves briefings and search. It stays under Past with your reason.`}
            {restores
              ? ` “${wordsOf(restores)}” becomes current again, and returns to briefings and search.`
              : null}
            {couldNotCheck
              ? ' Couldn’t check whether an older version would become current again. If there is one, removing this brings it back to briefings and search.'
              : null}
            {preview.isPending ? (
              <>
                {' '}
                <Loader
                  size="xs"
                  aria-hidden
                  display="inline-block"
                  style={{ verticalAlign: 'middle' }}
                />
                <span role="status">
                  {' '}
                  Checking whether an older version would become current again…
                </span>
              </>
            ) : null}
          </>
        )
      }
      submitLabel="Remove"
      required
      pending={act.isPending}
      blocked={why === null || (why === RemoveWhy.Mistake && preview.isPending)}
      error={act.error?.message ?? null}
      onSubmit={(reason) => {
        if (why === RemoveWhy.NoLongerApplies)
          retire.mutate({ id: PrincipleId.parse(target.id), reason }, { onSuccess: onClose });
        else if (isDecision)
          decision.mutate({ id: DecisionId.parse(target.id), reason }, { onSuccess: onClose });
        else principle.mutate({ id: PrincipleId.parse(target.id), reason }, { onSuccess: onClose });
      }}
      onClose={onClose}
    />
  );
}

/**
 * Remove: the record leaves briefings and search and stays under Past with the reason. Asked of an
 * older version, it says which record to remove instead and offers it.
 */
export function RemoveDialog({
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
  return <RemoveReason key={target.id} target={target} onClose={onClose} />;
}
