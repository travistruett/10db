import { SectionSlug, ShapeAttachmentId, type PlanRecordDto } from '@10db/contracts';
import { z } from 'zod';

// The Record view's tabs and its address: which tab, document, revision and section are open. Each
// part of the address is kept only when it parses, so a hand-edited link opens what it can.

export const RecordTab = {
  Documents: 'documents',
  Decisions: 'decisions',
  Evidence: 'evidence',
  Reviews: 'reviews',
  Questions: 'questions',
  Tasks: 'tasks',
} as const;
export type RecordTab = (typeof RecordTab)[keyof typeof RecordTab];

export const RECORD_TABS: readonly {
  readonly tab: RecordTab;
  readonly label: string;
  readonly count: (record: PlanRecordDto) => number;
}[] = [
  { tab: RecordTab.Documents, label: 'Documents', count: (r) => r.documents.length },
  { tab: RecordTab.Decisions, label: 'Decisions', count: (r) => r.counts.decisions },
  { tab: RecordTab.Evidence, label: 'Evidence', count: (r) => r.counts.evidence },
  { tab: RecordTab.Reviews, label: 'Reviews', count: (r) => r.counts.reviews },
  { tab: RecordTab.Questions, label: 'Questions', count: (r) => r.counts.questions },
  { tab: RecordTab.Tasks, label: 'Tasks', count: (r) => r.counts.tasks },
];

export interface RecordSearch {
  readonly tab?: RecordTab;
  /** A document's id: two documents of one Plan can share a key. */
  readonly doc?: ShapeAttachmentId;
  /** A revision number of that document. */
  readonly rev?: number;
  /** A section slug of that revision. */
  readonly section?: string;
}

const Tab = z.enum(RecordTab);
const Revision = z.coerce.number().int().min(1);

/** The parts of a Record address that parse; the rest are dropped. */
export function recordSearch(search: Record<string, unknown>): RecordSearch {
  const tab = Tab.safeParse(search['tab']);
  const doc = ShapeAttachmentId.safeParse(search['doc']);
  const rev = Revision.safeParse(search['rev']);
  const section = SectionSlug.safeParse(search['section']);
  return {
    ...(tab.success ? { tab: tab.data } : {}),
    ...(doc.success ? { doc: doc.data } : {}),
    ...(rev.success ? { rev: rev.data } : {}),
    ...(section.success ? { section: section.data } : {}),
  };
}
