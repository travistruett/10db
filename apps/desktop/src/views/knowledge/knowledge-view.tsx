import {
  KnowledgeItemKind,
  KnowledgeState,
  type PrincipleId,
  type ProjectViewDto,
} from '@10db/contracts';
import { Badge, Group, Stack, Tabs, Text, Title, VisuallyHidden } from '@mantine/core';
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
import { KnowledgeFilters, NO_FILTERS, type FilterState } from './knowledge-filters';
import { PrincipleList } from './principle-list';
import { ProposalList } from './proposal-list';
import {
  DecisionActions,
  NewDecisionButton,
  NewPrincipleButton,
  PrincipleActions,
  ProposalActions,
} from './record-actions';
import { ProvenanceDrawer } from './provenance-drawer';

/** Long enough to skip a request per keystroke, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 250;

type KnowledgeTab = 'principles' | 'decisions' | 'proposals';

function isKnowledgeTab(value: string | null): value is KnowledgeTab {
  return value === 'principles' || value === 'decisions' || value === 'proposals';
}

function ProposalsTab({ project }: { readonly project: ProjectViewDto }) {
  const count = useProposals(project.id).data?.length ?? 0;
  return (
    <Tabs.Tab
      value="proposals"
      rightSection={
        count > 0 ? (
          <Badge size="sm" circle>
            {/* The name computation drops a leading space inside VisuallyHidden, so the number is
                hidden from assistive tech and the hidden text carries the whole phrase. */}
            <span aria-hidden="true">{count}</span>
            <VisuallyHidden>{String(count)}</VisuallyHidden>
          </Badge>
        ) : undefined
      }
    >
      Proposals
    </Tabs.Tab>
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
  // State, not the prop: closing the drawer drops the id from the URL, and the tab must stay.
  const [linked] = useState<RecordRef | null>(
    linkedPrinciple ? { kind: KnowledgeItemKind.Principle, id: linkedPrinciple } : null,
  );
  const [chosenTab, setChosenTab] = useState<KnowledgeTab | null>(null);
  const [filters, setFilters] = useState<FilterState>(NO_FILTERS);
  const [q] = useDebouncedValue(filters.q, SEARCH_DEBOUNCE_MS);
  const [traced, setTraced] = useState<TracedRecord | RecordRef | null>(linked);
  // A linked principle still waiting for a verdict sits in Proposals, a decided one in Principles.
  const linkedState = useProvenance(linked).data?.state;
  const tab = chosenTab ?? (linkedState === KnowledgeState.Proposed ? 'proposals' : 'principles');
  const filter: KnowledgeFilter = {
    projectId: project.id,
    scope: filters.scope,
    area: filters.area,
    q,
    history: filters.history,
  };
  return (
    <>
      <Tabs
        value={tab}
        onChange={(next) => {
          if (isKnowledgeTab(next)) setChosenTab(next);
        }}
        keepMounted={false}
      >
        <Tabs.List>
          <Tabs.Tab value="principles">Principles</Tabs.Tab>
          <Tabs.Tab value="decisions">Decisions</Tabs.Tab>
          <ProposalsTab project={project} />
        </Tabs.List>
        {/* One set of filters for every tab, so switching tabs keeps what was typed. */}
        <Group pt="md" pb="sm">
          <KnowledgeFilters
            value={filters}
            areas={project.areas.map((a) => a.name)}
            historyDisabled={tab === 'proposals'}
            onChange={setFilters}
          />
        </Group>
        <Tabs.Panel value="principles">
          <Stack>
            <Group justify="flex-end">
              <NewPrincipleButton project={project} />
            </Group>
            <PrincipleList
              filter={filter}
              onTrace={setTraced}
              actions={(principle) => <PrincipleActions project={project} principle={principle} />}
            />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="decisions">
          <Stack>
            <Group justify="flex-end">
              <NewDecisionButton project={project} />
            </Group>
            <DecisionList
              filter={filter}
              onTrace={setTraced}
              actions={(decision) => <DecisionActions project={project} decision={decision} />}
            />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="proposals">
          <ProposalList
            projectId={project.id}
            filter={{ ...filters, q }}
            actions={(proposal) => <ProposalActions project={project} proposal={proposal} />}
          />
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
