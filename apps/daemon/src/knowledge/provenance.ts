import {
  InboxItemId,
  NotFoundError,
  SessionId,
  SourceKind,
  WorkstreamId,
  type DecisionId,
  type PrincipleId,
  type ProvenanceDto,
  type SourceId,
} from '@10db/contracts';
import {
  BUILDER_HANDLE,
  getDecision,
  getDecisionDto,
  getInboxItem,
  getPrinciple,
  getPrincipleRow,
  getSession,
  getSource,
  getWorkstream,
  type DbReader,
} from '@10db/db';

type Ref = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function orNull<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

interface Attribution {
  readonly sourceId: SourceId;
  readonly by: string;
  readonly quote: string | null;
  readonly speaker: string | null;
  readonly confirmedBy: string | null;
  readonly confirmedAt: string | null;
}

type Common = Pick<
  ProvenanceDto,
  | 'sourceKind'
  | 'sourceRef'
  | 'origin'
  | 'recordedAt'
  | 'by'
  | 'inbox'
  | 'session'
  | 'quote'
  | 'speaker'
  | 'confirmedBy'
  | 'confirmedAt'
>;

/** What a record's `sources` row says, resolved: the card it answers, the session that wrote it, the tool. */
function describeSource(db: DbReader, a: Attribution): Common {
  const source = getSource(db, a.sourceId);
  const ref: Ref = source.ref;
  const builder = source.kind === SourceKind.Builder;
  const via = builder ? text(ref['via']) : null;
  const inboxId = InboxItemId.safeParse(ref['inboxId']);
  const card = inboxId.success ? orNull(() => getInboxItem(db, inboxId.data)) : null;
  // A builder source's sessionId is the tool's own, not one of 10db's; only other sources name 10db's.
  const sessionId = builder ? null : SessionId.safeParse(ref['sessionId']);
  const workstreamId = WorkstreamId.safeParse(ref['workstreamId']);
  const session = sessionId?.success
    ? orNull(() => {
        const workstream = workstreamId.success
          ? workstreamId.data
          : getSession(db, sessionId.data).workstreamId;
        if (workstream === null) return null;
        return {
          id: sessionId.data,
          workstreamId: workstream,
          taskTitle: orNull(() => getWorkstream(db, workstream).taskTitle),
        };
      })
    : null;
  return {
    sourceKind: source.kind,
    sourceRef: source.ref,
    origin: via === null ? null : { via, sessionId: text(ref['sessionId']), cwd: text(ref['cwd']) },
    recordedAt: source.createdAt,
    by: a.by,
    inbox: card
      ? {
          id: card.id,
          title: card.title,
          choice: card.answer?.choice ?? null,
          note: card.answer?.note ?? null,
        }
      : null,
    session,
    quote: a.quote ?? text(ref['quote']),
    speaker: a.speaker,
    confirmedBy: a.confirmedBy,
    confirmedAt: a.confirmedAt,
  };
}

/** The source a confirmation, a retire or a withdrawal named, or null when it named none. */
function actionSource(db: DbReader, id: SourceId | null): ProvenanceDto['confirmedSource'] {
  if (id === null) return null;
  const source = getSource(db, id);
  const ref: Ref = source.ref;
  const via = text(ref['via']);
  if (via === null) return null;
  return {
    via,
    sessionId: text(ref['sessionId']),
    cwd: text(ref['cwd']),
    quote: text(ref['quote']),
    recordedAt: source.createdAt,
  };
}

export function decisionProvenance(db: DbReader, id: DecisionId): ProvenanceDto {
  const d = getDecisionDto(db, id);
  const row = getDecision(db, id);
  return {
    id,
    kind: 'decision',
    state: d.state,
    ...describeSource(db, {
      sourceId: d.sourceId,
      by: d.decidedBy,
      quote: null,
      speaker: null,
      confirmedBy: null,
      confirmedAt: null,
    }),
    confirmedSource: null,
    supersedes: d.supersedesId,
    supersededBy: d.supersededById,
    retired: null,
    withdrawn:
      row.withdrawnAt === null
        ? null
        : {
            at: row.withdrawnAt,
            by: row.withdrawnBy,
            reason: row.withdrawnReason,
            source: actionSource(db, row.withdrawnSourceId),
          },
  };
}

export function principleProvenance(db: DbReader, id: PrincipleId): ProvenanceDto {
  const p = getPrinciple(db, id);
  const row = getPrincipleRow(db, id);
  return {
    id,
    kind: 'principle',
    state: p.state,
    ...describeSource(db, {
      sourceId: p.sourceId,
      by: p.speaker ?? p.confirmedBy ?? BUILDER_HANDLE,
      quote: p.sourceQuote,
      speaker: p.speaker,
      confirmedBy: p.confirmedBy,
      confirmedAt: p.confirmedAt,
    }),
    confirmedSource: actionSource(db, row.confirmedSourceId),
    supersedes: p.supersedesId,
    supersededBy: p.supersededById,
    retired:
      row.retiredAt === null
        ? null
        : {
            at: row.retiredAt,
            by: row.retiredBy,
            reason: row.retiredReason,
            source: actionSource(db, row.retiredSourceId),
          },
    withdrawn:
      row.withdrawnAt === null
        ? null
        : {
            at: row.withdrawnAt,
            by: row.withdrawnBy,
            reason: row.withdrawnReason,
            source: actionSource(db, row.withdrawnSourceId),
          },
  };
}
