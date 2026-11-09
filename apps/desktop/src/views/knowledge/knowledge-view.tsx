import {
  KnowledgeItemKind,
  KnowledgeState,
  type PrincipleId,
  type ProjectViewDto,
} from '@10db/contracts';
import {
  Badge,
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Tabs,
  Text,
  Title,
  VisuallyHidden,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useProposals,
  useProvenance,
  type KnowledgeFilter,
  type RecordRef,
  type TracedRecord,
} from '../../daemon/knowledge-queries';
import { useSelectedProject } from '../../shell/selected-project';
import { DecisionList } from './decision-list';
import { NO_FILTERS, type FilterState, type ListControls } from './knowledge-filters';
import { isPast, KnowledgeShelf } from './knowledge-shelf';
import { PrincipleList } from './principle-list';
import { pendingPrinciples, ProposalList } from './proposal-list';
import {
  DecisionActions,
  NewDecisionButton,
  NewPrincipleButton,
  PrincipleActions,
  ProposalActions,
} from './record-actions';
import { ProvenanceDrawer } from './provenance-drawer';
import { scopeAreas } from './knowledge-areas';

/** Long enough to skip a request per keystroke, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 250;

const KnowledgeTab = { Principles: 'principles', Decisions: 'decisions' } as const;
type KnowledgeTab = (typeof KnowledgeTab)[keyof typeof KnowledgeTab];

const TABS: readonly string[] = Object.values(KnowledgeTab);
function isKnowledgeTab(value: string | null): value is KnowledgeTab {
  return value !== null && TABS.includes(value);
}

/** The Principles tab, with the number of proposals waiting under Pending. */
function PrinciplesTab({ pending }: { readonly pending: number }) {
  return (
    <Tabs.Tab
      value={KnowledgeTab.Principles}
      rightSection={
        pending > 0 ? (
          <Badge size="sm" circle>
            {/* The name computation drops a leading space inside VisuallyHidden, so the number is
                hidden from assistive tech and the hidden text carries the whole phrase. */}
            <span aria-hidden="true">{pending}</span>
            <VisuallyHidden>{`${String(pending)} pending`}</VisuallyHidden>
          </Badge>
        ) : undefined
      }
    >
      Principles
    </Tabs.Tab>
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
    history: shelf === KnowledgeShelf.Past,
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
      <Tabs
        value={tab}
        onChange={(next) => {
          if (isKnowledgeTab(next)) setTab(next);
        }}
        keepMounted={false}
      >
        {/* The create button sits on the tab row, so nothing stands between the tabs and the list. */}
        <Group justify="space-between" align="flex-end" wrap="nowrap" gap="md">
          <Tabs.List style={{ flex: 1 }}>
            <PrinciplesTab pending={pending} />
            <Tabs.Tab value={KnowledgeTab.Decisions}>Decisions</Tabs.Tab>
          </Tabs.List>
          <Box pb={6}>
            {tab === KnowledgeTab.Principles ? (
              <NewPrincipleButton project={project} />
            ) : (
              <NewDecisionButton project={project} />
            )}
          </Box>
        </Group>
        <Tabs.Panel value={KnowledgeTab.Principles} pt="md">
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
                actions={(principle) => (
                  <PrincipleActions project={project} principle={principle} />
                )}
              />
            )}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value={KnowledgeTab.Decisions} pt="md">
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
              actions={(decision) => <DecisionActions project={project} decision={decision} />}
            />
          </Stack>
        </Tabs.Panel>
      </Tabs>
      <ProvenanceDrawer
        record={traced}
        onTrace={setTraced}
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
    <Stack>
      <Stack gap={2}>
        <Title order={2}>Knowledge</Title>
        <Text size="sm" c="dimmed">
          What you, your agents and 10db have recorded for this project. The settings for
          10db&apos;s own judgement calls are in Settings.
        </Text>
      </Stack>
      {project ? (
        // Keyed by project so filters, tab and an open provenance never carry into another one.
        <ProjectKnowledge key={project.id} project={project} linkedPrinciple={principle ?? null} />
      ) : null}
    </Stack>
  );
}
