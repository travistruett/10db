import {
  KnowledgeItemKind,
  KnowledgeState,
  type ChatId,
  type DecisionItem,
  type PrincipleItem,
  type ProvenanceDto,
} from '@10db/contracts';
import { Alert, Anchor, Blockquote, Group, Loader, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { SurfaceDrawer } from '../../shell/surface-drawer';
import { useOpenSessionNotice } from '../sessions/open-session';
import { useProvenance, type RecordRef, type TracedRecord } from '../../daemon/knowledge-queries';
import {
  dateText,
  dateTimeText,
  scopeText,
  sourceLabel,
  viaLabel,
  whoText,
} from './knowledge-labels';
import { KindBadge } from './knowledge-table';
import { StateBadge } from './record-cells';

type Action = NonNullable<ProvenanceDto['retired']>;

/** Long words (paths, ids) break anywhere, so a record never widens the drawer. */
const WRAP = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;

/** One part of the record, under a small label. */
function Part({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Stack gap={6}>
      <Text size="xs" fw={700} c="dimmed">
        {label}
      </Text>
      {children}
    </Stack>
  );
}

/** A retire or a withdrawal: who, when, why, and the tool that did it when it named one. */
function ActionLines({ verb, action }: { readonly verb: string; readonly action: Action }) {
  const via = action.source?.via;
  return (
    <Stack gap={2}>
      <Text size="sm">
        {`${verb} by ${whoText(action.by)} on ${dateTimeText(action.at)}${via ? ` through ${viaLabel(via)}` : ''}`}
      </Text>
      {action.reason ? <Text size="sm">{action.reason}</Text> : null}
      {action.source?.quote ? <Blockquote>{action.source.quote}</Blockquote> : null}
    </Stack>
  );
}

/** "Plan session: <title>", opening the session when it still exists; plain words when it does not. */
function PlanSessionLink({
  chatId,
  title,
}: {
  readonly chatId: ChatId | null;
  readonly title: string;
}) {
  const { open, notice } = useOpenSessionNotice();
  if (chatId === null) return <Text size="sm">{`Plan session: ${title}`}</Text>;
  return (
    <>
      <Anchor
        component="button"
        type="button"
        size="sm"
        ta="left"
        onClick={() => {
          open(chatId);
        }}
      >{`Plan session: ${title}`}</Anchor>
      {notice}
    </>
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
      style={WRAP}
      onClick={() => {
        onTrace({ kind, id, label: text });
      }}
    >{`${verb}: ${text}`}</Anchor>
  );
}

/** Where the record came from: the tool, who and when, the session or Inbox card, and what befell it. */
function Origin({ p }: { readonly p: ProvenanceDto }) {
  const recorded = `${whoText(p.by)} on ${dateTimeText(p.recordedAt)}`;
  const confirmed =
    p.confirmedBy && p.confirmedAt
      ? `${whoText(p.confirmedBy)} on ${dateTimeText(p.confirmedAt)}`
      : null;
  return (
    <Stack gap={6}>
      <Text size="sm">{sourceLabel(p)}</Text>
      <Text size="sm" c="dimmed">{`Recorded by ${recorded}`}</Text>
      {/* A record the builder wrote is confirmed as it is written: a second line would only repeat the first. */}
      {confirmed !== null && confirmed !== recorded ? (
        <Text size="sm" c="dimmed">
          {`Confirmed by ${confirmed}${p.confirmedSource ? ` through ${viaLabel(p.confirmedSource.via)}` : ''}`}
        </Text>
      ) : null}
      {p.inbox ? (
        <Stack gap={2}>
          <Text size="sm">{p.inbox.title}</Text>
          {p.inbox.choice ? <Text size="sm">{`Answer: ${p.inbox.choice}`}</Text> : null}
          {p.inbox.note ? <Text size="sm">{`Note: ${p.inbox.note}`}</Text> : null}
        </Stack>
      ) : null}
      {p.session?.shapeId === null ? (
        <Text size="sm">{p.session.taskTitle ?? p.session.workstreamId}</Text>
      ) : p.session ? (
        <PlanSessionLink
          chatId={p.session.chatId}
          title={p.session.shapeTitle ?? p.session.shapeId}
        />
      ) : p.conversation ? (
        <PlanSessionLink
          chatId={p.conversation.chatId}
          title={p.conversation.title ?? p.conversation.id}
        />
      ) : null}
      {p.retired ? <ActionLines verb="Retired" action={p.retired} /> : null}
      {p.withdrawn ? <ActionLines verb="Withdrawn" action={p.withdrawn} /> : null}
    </Stack>
  );
}

/** The record whole: its type, scope and state, its words, why, the builder's own words and its history. */
function RecordBody({
  p,
  onTrace,
}: {
  readonly p: ProvenanceDto;
  readonly onTrace: (record: TracedRecord) => void;
}) {
  const record = p.decision ?? p.principle;
  const rationale = p.decision?.rationale ?? p.principle?.rationale ?? null;
  const history = p.supersedes !== null || p.supersededBy !== null;
  return (
    <Stack gap="lg">
      <Group gap="xs">
        {p.principle ? <KindBadge kind={p.principle.kind} /> : null}
        {p.state === KnowledgeState.Current ? null : <StateBadge state={p.state} />}
        {record ? (
          <Text size="xs" c="dimmed">
            {`${scopeText(record)} · ${dateText(record.createdAt)}`}
          </Text>
        ) : null}
      </Group>
      {p.decision ? (
        <>
          <Text fw={600} style={WRAP}>
            {p.decision.question}
          </Text>
          <Part label="Choice">
            <Text size="sm" style={WRAP}>
              {p.decision.choice}
            </Text>
          </Part>
        </>
      ) : (
        <Text fw={600} style={WRAP}>
          {p.text}
        </Text>
      )}
      {rationale ? (
        <Part label="Why">
          <Text size="sm" style={WRAP}>
            {rationale}
          </Text>
        </Part>
      ) : null}
      {p.quote ? (
        <Part label="In Your Words">
          <Blockquote py="xs" style={WRAP}>
            {p.quote}
          </Blockquote>
        </Part>
      ) : null}
      <Part label="Where It Came From">
        <Origin p={p} />
      </Part>
      {history ? (
        <Part label="History">
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
        </Part>
      ) : null}
    </Stack>
  );
}

/** The list item a provenance answer holds, for the record's own menu. */
export function itemOf(p: ProvenanceDto): DecisionItem | PrincipleItem | null {
  if (p.decision) return { ...p.decision, kind: KnowledgeItemKind.Decision };
  if (p.principle) {
    const { kind, ...rest } = p.principle;
    return { ...rest, kind: KnowledgeItemKind.Principle, principleKind: kind };
  }
  return null;
}

/**
 * A decision or principle opened from its row: the record whole, why it holds, where it came from, and
 * what it replaced or was replaced by. A press beside it on the content closes it; a press on another
 * row opens that one.
 */
export function ProvenanceDrawer({
  record,
  onTrace,
  onClose,
  actions,
}: {
  /** Without a label (a link from outside the view), the provenance names the record once it loads. */
  readonly record: TracedRecord | RecordRef | null;
  /** Follows a replaced or replacing record. */
  readonly onTrace: (record: TracedRecord) => void;
  readonly onClose: () => void;
  /** The record's menu, as its row has it. */
  readonly actions: (provenance: ProvenanceDto) => ReactNode;
}) {
  const provenance = useProvenance(record);
  const p = provenance.data ?? null;
  const kind = record?.kind ?? KnowledgeItemKind.Principle;
  return (
    <SurfaceDrawer
      opened={record !== null}
      onClose={onClose}
      label={kind === KnowledgeItemKind.Decision ? 'Decision' : 'Principle'}
      widthPx={560}
      closeOnClickOutside
      {...(record ? { showing: record.id } : {})}
      actions={p ? actions(p) : null}
    >
      <Stack gap="sm">
        {p === null && record && 'label' in record ? (
          <Text fw={600} style={WRAP}>
            {record.label}
          </Text>
        ) : null}
        {provenance.isPending && record ? <Loader size="sm" aria-label="Loading" /> : null}
        {provenance.isError ? (
          <Alert color="red" title="Couldn't load this record">
            {provenance.error.message}
          </Alert>
        ) : null}
        {p ? <RecordBody p={p} onTrace={onTrace} /> : null}
      </Stack>
    </SurfaceDrawer>
  );
}
