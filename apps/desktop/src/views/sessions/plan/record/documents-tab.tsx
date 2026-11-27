import {
  PlanEval,
  type PlanRecordDocument,
  type PlanRecordDto,
  type ProjectId,
  type SectionIndexEntry,
  type ShapeAttachmentId,
  type ShapeId,
} from '@10db/contracts';
import { Alert, Box, Button, Group, NavLink, ScrollArea, Select, Stack, Text } from '@mantine/core';
import dayjs from 'dayjs';
import { useEffect, useRef, useState } from 'react';
import { PageLoading, PageLoadingShape } from '../../../../shell/page-loading';
import { Markdown } from '../../../../conversation';
import { usePlanRevision } from '../../../../daemon/plan-record-queries';
import { NewEvalModal, prefillFromPlanEval } from '../../../evals/new-eval-modal';
import { RecordTab, type RecordSearch } from './record-tabs';

// Documents: pick a document and a revision, read its outline, and read it whole. The body is drawn
// once, so a footnote or a reference link keeps its definition wherever it is; a section picked in the
// outline (or named in the address) is scrolled to by its heading's line.

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

/**
 * The line a section's heading is on, counted as markdown counts lines (CR LF, LF or a lone CR each
 * end one), so it names the heading the drawn body marks with `data-line`.
 */
export function sectionLine(body: string, start: number): number {
  return (body.slice(0, start).match(/\r\n|\r|\n/g)?.length ?? 0) + 1;
}

/** A goal's proposed eval, when the document's text is one. */
function proposedEval(body: string): PlanEval | null {
  try {
    const parsed = PlanEval.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** New Eval over a goal's proposed eval, which fills the form's behavior, decision, oracle, models and bar. */
function NewEvalFromPlan({
  projectId,
  plan,
}: {
  readonly projectId: ProjectId;
  readonly plan: PlanEval;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <Button
        size="xs"
        variant="default"
        mb="sm"
        onClick={() => {
          setOpened(true);
        }}
      >
        New Eval
      </Button>
      <NewEvalModal
        projectId={projectId}
        prefill={opened ? prefillFromPlanEval(plan) : null}
        onClose={() => {
          setOpened(false);
        }}
      />
    </>
  );
}

function Body({
  shapeId,
  projectId,
  kind,
  doc,
  number,
  sections,
  section,
}: {
  readonly shapeId: ShapeId;
  readonly projectId: ProjectId;
  readonly kind: PlanRecordDocument['kind'];
  readonly doc: ShapeAttachmentId;
  readonly number: number;
  readonly sections: readonly SectionIndexEntry[];
  readonly section: string | undefined;
}) {
  const revision = usePlanRevision(shapeId, doc, number);
  const drawn = useRef<HTMLDivElement>(null);
  const body = revision.data?.body;
  const start = sections.find((s) => s.slug === section)?.start;
  const line = body === undefined || start === undefined ? undefined : sectionLine(body, start);
  useEffect(() => {
    if (line === undefined) return;
    // The body draws over a few frames, which moves the heading down; it is scrolled to again each
    // time it moves, until it has stayed put for a few frames.
    let last = Number.NaN;
    let still = 0;
    let frames = 0;
    let id = 0;
    const settle = (): void => {
      const heading = drawn.current?.querySelector<HTMLElement>(`[data-line="${String(line)}"]`);
      if (heading) {
        const top = heading.offsetTop;
        if (top !== last) {
          heading.scrollIntoView({ block: 'start' });
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
  }, [line]);
  if (revision.isError)
    return (
      <Alert color="red" title="Couldn't load this revision">
        {revision.error.message}
      </Alert>
    );
  if (body === undefined)
    return <PageLoading shape={PageLoadingShape.Lines} rows={8} label="Loading the document" />;
  const plan = kind === 'eval' ? proposedEval(body) : null;
  return (
    <Box ref={drawn}>
      {plan === null ? null : <NewEvalFromPlan projectId={projectId} plan={plan} />}
      <Markdown text={body} />
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
        No documents yet. A spec the agent writes for this plan shows here.
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
            projectId={record.projectId}
            kind={doc.kind}
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
