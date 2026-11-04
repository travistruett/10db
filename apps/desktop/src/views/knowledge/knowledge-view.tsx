import type { ProjectViewDto } from '@10db/contracts';
import { Badge, Group, Stack, Tabs, Text, Title, VisuallyHidden } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useState } from 'react';
import {
  useProposals,
  type KnowledgeFilter,
  type TracedRecord,
} from '../../daemon/knowledge-queries';
import { useSelectedProject } from '../../shell/selected-project';
import { DecisionList } from './decision-list';
import { KnowledgeFilters, NO_FILTERS, type FilterState } from './knowledge-filters';
import { PrincipleList } from './principle-list';
import { ProposalList } from './proposal-list';
import { ProvenanceDrawer } from './provenance-drawer';

/** Long enough to skip a request per keystroke, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 250;

type Tab = 'principles' | 'decisions' | 'proposals';

function isTab(value: string | null): value is Tab {
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

function ProjectKnowledge({ project }: { readonly project: ProjectViewDto }) {
  const [tab, setTab] = useState<Tab>('principles');
  const [filters, setFilters] = useState<FilterState>(NO_FILTERS);
  const [q] = useDebouncedValue(filters.q, SEARCH_DEBOUNCE_MS);
  const [traced, setTraced] = useState<TracedRecord | null>(null);
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
          if (isTab(next)) setTab(next);
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
          <PrincipleList filter={filter} onTrace={setTraced} />
        </Tabs.Panel>
        <Tabs.Panel value="decisions">
          <DecisionList filter={filter} onTrace={setTraced} />
        </Tabs.Panel>
        <Tabs.Panel value="proposals">
          <ProposalList projectId={project.id} filter={{ ...filters, q }} />
        </Tabs.Panel>
      </Tabs>
      <ProvenanceDrawer
        record={traced}
        onTrace={setTraced}
        onClose={() => {
          setTraced(null);
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
        <ProjectKnowledge key={project.id} project={project} />
      ) : null}
    </Stack>
  );
}
