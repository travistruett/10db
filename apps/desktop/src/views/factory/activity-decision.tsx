import {
  CardDecider,
  DECISION_RULE_NAMES,
  type ActivityRow,
  type NoticeDecision,
} from '@10db/contracts';
import { Button, Group, Stack, Text } from '@mantine/core';
import { useAskNextTime, useUndoActivity } from '../../daemon/activity-queries';

/** Who decided, as a row says it: the rule's name, or the judge and how sure it was. */
export function decidedByText(decision: NoticeDecision): string {
  if (decision.by === CardDecider.Judge) {
    return `The judge, ${String(Math.round((decision.confidence ?? 0) * 100))}% sure`;
  }
  return DECISION_RULE_NAMES[decision.rule];
}

/** What a row says about taking the decision back. */
export function undoText(row: ActivityRow & { readonly decision: NoticeDecision }): string | null {
  if (row.undone) return 'Undone';
  return row.decision.undo.state === 'final' ? "Can't be undone now" : null;
}

/**
 * Who decided a row's move, with Undo where it can be taken back (or why it can't) and Ask Me Next Time, which
 * turns the rule back into a card in the row's project.
 */
export function ActivityDecision({
  row,
}: {
  readonly row: ActivityRow & { readonly decision: NoticeDecision };
}) {
  const undo = useUndoActivity();
  const ask = useAskNextTime();
  const refused = undo.error ?? ask.error;
  const note = undoText(row);
  return (
    <Stack gap="xs" data-testid="activity-decision">
      <Text size="sm">{`Decided by: ${decidedByText(row.decision)}`}</Text>
      <Group gap="xs">
        {note === null ? (
          <Button
            size="xs"
            variant="default"
            loading={undo.isPending}
            onClick={() => {
              undo.mutate(row.seq);
            }}
          >
            Undo
          </Button>
        ) : (
          <Text size="xs" c="dimmed">
            {note}
          </Text>
        )}
        {row.projectId === null ? null : (
          <Button
            size="xs"
            variant="default"
            loading={ask.isPending}
            onClick={() => {
              ask.mutate({ seq: row.seq, asking: !row.asking });
            }}
          >
            {row.asking ? 'Stop Asking' : 'Ask Me Next Time'}
          </Button>
        )}
      </Group>
      {row.asking ? (
        <Text size="xs" c="dimmed">
          This rule asks in this project: its next occurrence is a card in the Inbox.
        </Text>
      ) : null}
      {refused ? (
        <Text size="xs" c="red" role="alert">
          {refused.message}
        </Text>
      ) : null}
    </Stack>
  );
}
