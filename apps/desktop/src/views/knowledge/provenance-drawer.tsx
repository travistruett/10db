import type { ProvenanceDto } from '@10db/contracts';
import { Alert, Anchor, Blockquote, Drawer, Loader, Stack, Text } from '@mantine/core';
import { useProvenance, type TracedRecord } from '../../daemon/knowledge-queries';
import { STATE_LABELS } from './knowledge-labels';
import { dateTimeText, sourceLabel, whoText } from './knowledge-labels';

type Action = NonNullable<ProvenanceDto['retired']>;

/** A retire or a withdrawal: who, when, why, and the tool that did it when it named one. */
function ActionLines({ verb, action }: { readonly verb: string; readonly action: Action }) {
  const via = action.source?.via;
  return (
    <Stack gap={2}>
      <Text size="sm">
        {`${verb} by ${whoText(action.by)} on ${dateTimeText(action.at)}${via ? ` through ${via}` : ''}`}
      </Text>
      {action.reason ? <Text size="sm">{action.reason}</Text> : null}
      {action.source?.quote ? <Blockquote>{action.source.quote}</Blockquote> : null}
    </Stack>
  );
}

/** The record this one replaced or was replaced by, named in its own words; opening it keeps that name. */
function RecordLink({
  verb,
  kind,
  id,
  text,
  onTrace,
}: {
  readonly verb: string;
  readonly kind: ProvenanceDto['kind'];
  readonly id: ProvenanceDto['supersedes'];
  readonly text: string | null;
  readonly onTrace: (record: TracedRecord) => void;
}) {
  if (id === null || text === null) return null;
  return (
    <Anchor
      component="button"
      type="button"
      size="sm"
      ta="left"
      onClick={() => {
        onTrace({ kind, id, label: text });
      }}
    >{`${verb}: ${text}`}</Anchor>
  );
}

/** Where a decision or principle came from, what it replaced or was replaced by, and what has happened to it. */
export function ProvenanceDrawer({
  record,
  onTrace,
  onClose,
}: {
  readonly record: TracedRecord | null;
  /** Follows a replaced or replacing record. */
  readonly onTrace: (record: TracedRecord) => void;
  readonly onClose: () => void;
}) {
  const provenance = useProvenance(record);
  const p = provenance.data ?? null;
  return (
    <Drawer
      opened={record !== null}
      onClose={onClose}
      position="right"
      title="Where it came from"
      size="min(480px, 50vw)"
    >
      <Stack gap="sm">
        {record ? <Text fw={600}>{record.label}</Text> : null}
        {provenance.isPending && record ? <Loader size="sm" aria-label="Loading" /> : null}
        {provenance.isError ? (
          <Alert color="red" title="Couldn't load where it came from">
            {provenance.error.message}
          </Alert>
        ) : null}
        {p ? (
          <>
            <Stack gap={2}>
              <Text>{sourceLabel(p)}</Text>
              <Text size="sm" c="dimmed">
                {`Recorded ${dateTimeText(p.recordedAt)} by ${whoText(p.by)}`}
              </Text>
              <Text size="sm" c="dimmed">
                {STATE_LABELS[p.state]}
              </Text>
            </Stack>
            {p.inbox ? (
              <Stack gap={2}>
                <Text size="sm">{p.inbox.title}</Text>
                {p.inbox.choice ? <Text size="sm">{`Answer: ${p.inbox.choice}`}</Text> : null}
                {p.inbox.note ? <Text size="sm">{`Note: ${p.inbox.note}`}</Text> : null}
              </Stack>
            ) : null}
            {p.session ? (
              <Text size="sm">{p.session.taskTitle ?? p.session.workstreamId}</Text>
            ) : null}
            {p.quote ? <Blockquote>{p.quote}</Blockquote> : null}
            {p.confirmedBy && p.confirmedAt ? (
              <Text size="sm" c="dimmed">
                {`Confirmed by ${whoText(p.confirmedBy)} on ${dateTimeText(p.confirmedAt)}${
                  p.confirmedSource ? ` through ${p.confirmedSource.via}` : ''
                }`}
              </Text>
            ) : null}
            {p.retired ? <ActionLines verb="Retired" action={p.retired} /> : null}
            {p.withdrawn ? <ActionLines verb="Withdrawn" action={p.withdrawn} /> : null}
            <RecordLink
              verb="Replaced"
              kind={p.kind}
              id={p.supersedes}
              text={p.supersedesText}
              onTrace={onTrace}
            />
            <RecordLink
              verb="Replaced by"
              kind={p.kind}
              id={p.supersededBy}
              text={p.supersededByText}
              onTrace={onTrace}
            />
          </>
        ) : null}
      </Stack>
    </Drawer>
  );
}
