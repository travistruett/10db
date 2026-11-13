import type {
  PlanRecordDocument,
  PlanRecordDto,
  SectionIndexEntry,
  ShapeAttachmentId,
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
  readonly doc: ShapeAttachmentId;
  readonly number: number;
  readonly sections: readonly SectionIndexEntry[];
  readonly section: string | undefined;
}) {
  const revision = usePlanRevision(shapeId, doc, number);
  const pieces = useRef(new Map<string, HTMLElement>());
  const body = revision.data?.body;
  useEffect(() => {
    if (section === undefined || body === undefined) return;
    // The pieces draw over a few frames, which moves the section down; it is scrolled to again each
    // time it moves, until it has stayed put for a few frames.
    let last = Number.NaN;
    let still = 0;
    let frames = 0;
    let id = 0;
    const settle = (): void => {
      const piece = pieces.current.get(section);
      if (piece) {
        const top = piece.offsetTop;
        if (top !== last) {
          piece.scrollIntoView({ block: 'start' });
          last = top;
          still = 0;
        } else still += 1;
      }
      frames += 1;
      if (still < 3 && frames < 60) id = requestAnimationFrame(settle);
    };
    settle();
    return () => {
      cancelAnimationFrame(id);
    };
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
  const doc = record.documents.find((d) => d.id === search.doc) ?? record.documents[0];
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
    <Group align="stretch" gap="lg" wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
      {/* The list and the outline scroll on their own, so a long outline never pushes the body away. */}
      <ScrollArea w={280} type="auto" offsetScrollbars style={{ flex: 'none', height: '100%' }}>
        <Stack gap="sm">
          <Box component="nav" aria-label="Documents">
            {record.documents.map((d) => (
              <NavLink
                key={d.id}
                component="button"
                label={d.title}
                description={KIND_LABELS[d.kind]}
                active={d.id === doc.id}
                onClick={() => {
                  open({ doc: d.id });
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
              data={doc.revisions.map((r) => ({
                value: String(r.number),
                label: revisionLabel(r),
              }))}
              value={String(revision.number)}
              onChange={(value) => {
                if (value !== null) open({ doc: doc.id, rev: Number(value) });
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
                    open({ doc: doc.id, rev: revision.number, section: s.slug });
                  }}
                />
              ))}
            </Box>
          )}
        </Stack>
      </ScrollArea>
      <ScrollArea
        type="auto"
        offsetScrollbars
        style={{ flex: 1, height: '100%' }}
        // The body scrolls on its own, so the keyboard can reach and scroll it.
        viewportProps={{ tabIndex: 0, role: 'region', 'aria-label': doc.title }}
      >
        {revision === undefined ? (
          <Text size="sm" c="dimmed">
            This document has no revision yet.
          </Text>
        ) : (
          <Body
            shapeId={shapeId}
            doc={doc.id}
            number={revision.number}
            sections={revision.sections}
            section={search.section}
          />
        )}
      </ScrollArea>
    </Group>
  );
}
