import type {
  PlanRecordDocument,
  PlanRecordDto,
  SectionIndexEntry,
  ShapeId,
} from '@10db/contracts';
import { Alert, Box, Group, Loader, NavLink, ScrollArea, Select, Stack, Text } from '@mantine/core';
import dayjs from 'dayjs';
import { useEffect, useRef } from 'react';
import { Markdown } from '../../../conversation';
import { usePlanRevision } from '../../../daemon/plan-record-queries';
import { RecordTab, type RecordSearch } from './record-tabs';

// Documents: pick a document and a revision, read its outline, and read it whole. The body is drawn in
// pieces cut at its section headings, so a section picked in the outline (or named in the address) is
// scrolled to by its own piece.

const KIND_LABELS: Readonly<Record<PlanRecordDocument['kind'], string>> = {
  research: 'Research',
  spec: 'Spec',
  plan: 'Plan',
  guide: 'Guide',
  eval: 'Eval',
};

/** "Revision 2 · after review · 12 Nov 2026". */
function revisionLabel(r: PlanRecordDocument['revisions'][number]): string {
  return [
    `Revision ${String(r.number)}`,
    r.note === null || r.note === '' ? null : r.note,
    dayjs(r.authoredAt ?? r.createdAt).format('D MMM YYYY'),
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

/** The body cut at every section's start: what comes before the first heading, then one piece per heading. */
export function bodyPieces(
  body: string,
  sections: readonly SectionIndexEntry[],
): { readonly slug: string | null; readonly text: string }[] {
  const starts = [...new Set(sections.map((s) => s.start))]
    .filter((start) => start > 0 && start < body.length)
    .sort((a, b) => a - b);
  const slugAt = new Map(sections.map((s) => [s.start, s.slug]));
  const cuts = [0, ...starts, body.length];
  return cuts.slice(0, -1).map((start, i) => ({
    slug: slugAt.get(start) ?? null,
    text: body.slice(start, cuts[i + 1]),
  }));
}

function Body({
  shapeId,
  doc,
  number,
  sections,
  section,
}: {
  readonly shapeId: ShapeId;
  readonly doc: string;
  readonly number: number;
  readonly sections: readonly SectionIndexEntry[];
  readonly section: string | undefined;
}) {
  const revision = usePlanRevision(shapeId, doc, number);
  const pieces = useRef(new Map<string, HTMLElement>());
  const body = revision.data?.body;
  useEffect(() => {
    if (section === undefined || body === undefined) return;
    pieces.current.get(section)?.scrollIntoView({ block: 'start' });
  }, [section, body]);
  if (revision.isError)
    return (
      <Alert color="red" title="Couldn't load this revision">
        {revision.error.message}
      </Alert>
    );
  if (body === undefined) return <Loader size="sm" aria-label="Loading the document" />;
  return (
    <Box>
      {bodyPieces(body, sections).map((piece, i) => (
        <Box
          // A piece is its place in the body; two revisions are never drawn at once.
          key={`${String(i)}:${piece.slug ?? ''}`}
          data-section={piece.slug ?? undefined}
          ref={(el: HTMLElement | null) => {
            if (piece.slug === null) return;
            if (el === null) pieces.current.delete(piece.slug);
            else pieces.current.set(piece.slug, el);
          }}
        >
          <Markdown text={piece.text} />
        </Box>
      ))}
    </Box>
  );
}

export function DocumentsTab({
  shapeId,
  record,
  search,
  onSearch,
}: {
  readonly shapeId: ShapeId;
  readonly record: PlanRecordDto;
  readonly search: RecordSearch;
  readonly onSearch: (next: RecordSearch) => void;
}) {
  const doc = record.documents.find((d) => d.key === search.doc) ?? record.documents[0];
  if (doc === undefined)
    return (
      <Text size="sm" c="dimmed">
        This Plan has no documents.
      </Text>
    );
  const latest = doc.revisions.at(-1);
  const revision = doc.revisions.find((r) => r.number === search.rev) ?? latest;
  const open = (next: Omit<RecordSearch, 'tab'>): void => {
    onSearch({ tab: RecordTab.Documents, ...next });
  };
  return (
    <Group align="flex-start" gap="lg" wrap="nowrap" h="100%" mih={0}>
      <Stack gap="sm" w={280} style={{ flex: 'none' }}>
        <Box component="nav" aria-label="Documents">
          {record.documents.map((d) => (
            <NavLink
              key={d.key}
              component="button"
              label={d.title}
              description={KIND_LABELS[d.kind]}
              active={d.key === doc.key}
              onClick={() => {
                open({ doc: d.key });
              }}
            />
          ))}
        </Box>
        {revision === undefined ? null : (
          <Select
            label="Revision"
            size="sm"
            allowDeselect={false}
            checkIconPosition="right"
            data={doc.revisions.map((r) => ({ value: String(r.number), label: revisionLabel(r) }))}
            value={String(revision.number)}
            onChange={(value) => {
              if (value !== null) open({ doc: doc.key, rev: Number(value) });
            }}
          />
        )}
        {revision === undefined || revision.sections.length === 0 ? null : (
          <Box component="nav" aria-label="Outline">
            <Text size="xs" c="dimmed" mb={4}>
              Outline
            </Text>
            {revision.sections.map((s) => (
              <NavLink
                key={s.slug}
                component="button"
                label={s.title}
                py={4}
                style={{ paddingLeft: 8 + (s.level - 1) * 14 }}
                active={s.slug === search.section}
                aria-current={s.slug === search.section ? 'location' : undefined}
                onClick={() => {
                  open({ doc: doc.key, rev: revision.number, section: s.slug });
                }}
              />
            ))}
          </Box>
        )}
      </Stack>
      <ScrollArea style={{ flex: 1 }} h="100%" type="auto" offsetScrollbars>
        {revision === undefined ? (
          <Text size="sm" c="dimmed">
            This document has no revision yet.
          </Text>
        ) : (
          <Body
            shapeId={shapeId}
            doc={doc.key}
            number={revision.number}
            sections={revision.sections}
            section={search.section}
          />
        )}
      </ScrollArea>
    </Group>
  );
}
