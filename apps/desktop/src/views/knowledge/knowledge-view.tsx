import {
  KnowledgeItemKind,
  KnowledgeState,
  type PrincipleId,
  type ProjectViewDto,
} from '@10db/contracts';
import { Badge, Button, Container, Group, Paper, Stack, Text, VisuallyHidden } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import {
  useProposals,
  useProvenance,
  type KnowledgeFilter,
  type RecordRef,
  type TracedRecord,
} from '../../daemon/knowledge-queries';
import { PageIntro, PageTabs } from '../../shell/page-intro';
import { ScopeBadge } from '../../shell/scope-badge';
import { TitleRow } from '../../shell/title-row';
import { useSelectedProject } from '../../shell/selected-project';
import { DecisionList } from './decision-list';
import { NO_FILTERS, type FilterState, type ListControls } from './knowledge-filters';
import { isPast, KnowledgeShelf, listShelf } from './knowledge-shelf';
import { PrincipleList } from './principle-list';
import { pendingPrinciples, ProposalList } from './proposal-list';
import {
  DecisionActions,
  NewDecisionButton,
  NewPrincipleButton,
  PrincipleActions,
  ProposalActions,
} from './record-actions';
import { itemOf, ProvenanceDrawer } from './provenance-drawer';
import { scopeAreas } from './knowledge-areas';
import { ContentWidth } from '../../shell/content-width';

/** Long enough to skip a request per keystroke, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 250;

const KnowledgeTab = { Principles: 'principles', Decisions: 'decisions' } as const;
type KnowledgeTab = (typeof KnowledgeTab)[keyof typeof KnowledgeTab];

/** The number of proposals waiting under Pending, after the Principles tab's label. */
function PendingCount({ pending }: { readonly pending: number }) {
  return (
    <Badge size="sm" circle>
      {/* The name computation drops a leading space inside VisuallyHidden, so the number is
          hidden from assistive tech and the hidden text carries the whole phrase. */}
      <span aria-hidden="true">{pending}</span>
      <VisuallyHidden>{`${String(pending)} pending`}</VisuallyHidden>
    </Badge>
  );
}

/**
 * One slim line above a list: proposals waiting on the builder while another shelf is shown, or which
 * shelf is shown when it is not Current, since the shelf itself sits in the first column's filter.
 */
function ShelfNote({
  what,
  shelf,
  pending,
  onShelf,
}: {
  readonly what: string;
  readonly shelf: KnowledgeShelf;
  readonly pending: number;
  readonly onShelf: (next: KnowledgeShelf) => void;
}) {
  if (shelf !== KnowledgeShelf.Current)
    return (
      <Group gap="xs">
        <Text size="sm" c="dimmed">
          {shelf === KnowledgeShelf.Pending
            ? `Showing proposed ${what}, waiting for your verdict.`
            : `Showing past ${what}: replaced, retired or withdrawn.`}
        </Text>
        <Button
          size="compact-sm"
          variant="subtle"
          onClick={() => {
            onShelf(KnowledgeShelf.Current);
          }}
        >
          Show Current
        </Button>
      </Group>
    );
  if (pending === 0) return null;
  return (
    <Paper role="status" withBorder px="sm" py={6} bg="var(--mantine-color-yellow-light)">
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Text size="sm">
          {pending === 1
            ? `1 proposed ${what.replace(/s$/, '')} waits for your verdict.`
            : `${String(pending)} proposed ${what} wait for your verdict.`}
        </Text>
        <Button
          size="compact-sm"
          variant="light"
          color="yellow"
          onClick={() => {
            onShelf(KnowledgeShelf.Pending);
          }}
        >
          Review
        </Button>
      </Group>
    </Paper>
  );
}

/** The view's header; once a project is chosen its tabs and create button sit on the toolbar under the byline. */
function KnowledgeHeader({
  project,
  tabs,
  actions,
}: {
  readonly project?: string;
  readonly tabs?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <>
      <TitleRow
        title="Knowledge"
        {...(project === undefined ? {} : { meta: <ScopeBadge name={project} /> })}
      />
      <PageIntro
        description="What you, your agents and 10db have recorded for this project."
        {...(tabs === undefined ? {} : { tabs })}
        {...(actions === undefined ? {} : { actions })}
      />
    </>
  );
}

function ProjectKnowledge({
  project,
  linkedPrinciple,
}: {
  readonly project: ProjectViewDto;
  /** A principle a link opened this view on (a resolved Inbox card). */
  readonly linkedPrinciple: PrincipleId | null;
}) {
  const navigate = useNavigate();
  // State, not the prop: closing the drawer drops the id from the URL, and the shelf must stay.
  const [linked] = useState<RecordRef | null>(
    linkedPrinciple ? { kind: KnowledgeItemKind.Principle, id: linkedPrinciple } : null,
  );
  const [tab, setTab] = useState<KnowledgeTab>(KnowledgeTab.Principles);
  const [chosenShelf, setChosenShelf] = useState<KnowledgeShelf | null>(null);
  const [decisionShelf, setDecisionShelf] = useState<KnowledgeShelf>(KnowledgeShelf.Current);
  const [filters, setFilters] = useState<FilterState>(NO_FILTERS);
  const [q] = useDebouncedValue(filters.q, SEARCH_DEBOUNCE_MS);
  const [traced, setTraced] = useState<TracedRecord | RecordRef | null>(linked);
  const pending = pendingPrinciples(useProposals(project.id).data ?? []).length;
  // A linked principle still waiting for a verdict sits under Pending, a decided one under Current or Past.
  const linkedState = useProvenance(linked).data?.state;
  const principleShelf =
    chosenShelf ??
    (linkedState === KnowledgeState.Proposed
      ? KnowledgeShelf.Pending
      : linkedState !== undefined && isPast(linkedState)
        ? KnowledgeShelf.Past
        : KnowledgeShelf.Current);
  const filterFor = (shelf: KnowledgeShelf): KnowledgeFilter => ({
    projectId: project.id,
    scope: filters.scope,
    area: filters.area,
    q,
    shelf: listShelf(shelf),
  });
  const areas = scopeAreas(project.areas);
  const principleControls: ListControls = {
    shelves: [
      { shelf: KnowledgeShelf.Pending, count: pending },
      { shelf: KnowledgeShelf.Current, count: null },
      { shelf: KnowledgeShelf.Past, count: null },
    ],
    shelf: principleShelf,
    onShelf: setChosenShelf,
    filters,
    areas,
    onFilters: setFilters,
  };
  const decisionControls: ListControls = {
    shelves: [
      { shelf: KnowledgeShelf.Current, count: null },
      { shelf: KnowledgeShelf.Past, count: null },
    ],
    shelf: decisionShelf,
    onShelf: setDecisionShelf,
    filters,
    areas,
    onFilters: setFilters,
  };
  return (
    <>
      <KnowledgeHeader
        project={project.name}
        tabs={
          <PageTabs
            label="Knowledge"
            tabs={[
              {
                value: KnowledgeTab.Principles,
                label: 'Principles',
                ...(pending > 0 ? { rightSection: <PendingCount pending={pending} /> } : {}),
              },
              { value: KnowledgeTab.Decisions, label: 'Decisions' },
            ]}
            value={tab}
            onChange={setTab}
          />
        }
        actions={
          tab === KnowledgeTab.Principles ? (
            <NewPrincipleButton project={project} />
          ) : (
            <NewDecisionButton project={project} />
          )
        }
      />
      {tab === KnowledgeTab.Principles ? (
        <Stack gap="sm">
          <ShelfNote
            what="principles"
            shelf={principleShelf}
            pending={pending}
            onShelf={setChosenShelf}
          />
          {principleShelf === KnowledgeShelf.Pending ? (
            <ProposalList
              projectId={project.id}
              filter={{ ...filters, q }}
              controls={principleControls}
              onTrace={setTraced}
              actions={(proposal) => <ProposalActions project={project} proposal={proposal} />}
            />
          ) : (
            <PrincipleList
              filter={filterFor(principleShelf)}
              controls={principleControls}
              onTrace={setTraced}
              openId={traced?.id ?? null}
              actions={(principle) => <PrincipleActions project={project} principle={principle} />}
            />
          )}
        </Stack>
      ) : (
        <Stack gap="sm">
          <ShelfNote
            what="decisions"
            shelf={decisionShelf}
            pending={0}
            onShelf={setDecisionShelf}
          />
          <DecisionList
            filter={filterFor(decisionShelf)}
            controls={decisionControls}
            onTrace={setTraced}
            openId={traced?.id ?? null}
            actions={(decision) => <DecisionActions project={project} decision={decision} />}
          />
        </Stack>
      )}
      <ProvenanceDrawer
        record={traced}
        onTrace={setTraced}
        actions={(provenance) => {
          const item = itemOf(provenance);
          if (item === null) return null;
          return item.kind === KnowledgeItemKind.Decision ? (
            <DecisionActions project={project} decision={item} />
          ) : (
            <PrincipleActions project={project} principle={item} />
          );
        }}
        onClose={() => {
          setTraced(null);
          // The id must not reopen the drawer, least of all in another project once the switcher moves.
          if (linkedPrinciple) void navigate({ to: '/knowledge', search: {}, replace: true });
        }}
      />
    </>
  );
}

/**
 * Knowledge: the decisions and principles recorded for the project chosen in the switcher, and the
 * proposals waiting on the builder. These are recorded decisions; 10db's own judgement settings are
 * Settings › Decisions.
 */
export function KnowledgeView() {
  const { project } = useSelectedProject();
  const { principle } = useSearch({ from: '/knowledge' });
  return (
    <Container size={ContentWidth.Page} w="100%">
      <Stack>
        {project ? (
          // Keyed by project so filters, tab and an open provenance never carry into another one.
          <ProjectKnowledge
            key={project.id}
            project={project}
            linkedPrinciple={principle ?? null}
          />
        ) : (
          <KnowledgeHeader />
        )}
      </Stack>
    </Container>
  );
}
