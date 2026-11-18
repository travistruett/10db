import { InboxKind, InboxListState, InboxOutcome } from '@10db/contracts';
import { ActionIcon, Indicator, Menu } from '@mantine/core';
import { IconCheck, IconFilter } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { usePeople } from '../../daemon/people';
import { useProjects } from '../../daemon/queries';
import { OUTCOME_LABELS } from './inbox-row-item';
import {
  filtersSet,
  InboxSince,
  withFilter,
  withoutFilters,
  type InboxPanelState,
  type InboxSearch,
} from './inbox-search';
import { KIND_LABELS } from './permission-labels';

const SINCE_LABELS: Readonly<Record<InboxSince, string>> = {
  [InboxSince.Day]: 'Today',
  [InboxSince.Week]: 'Last 7 Days',
  [InboxSince.Month]: 'Last 30 Days',
};

/** One choice of a filter, a check on the right when it is the chosen one. */
function Choice({
  label,
  checked,
  onChoose,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChoose: () => void;
}): ReactNode {
  return (
    <Menu.Item
      aria-current={checked ? true : undefined}
      rightSection={checked ? <IconCheck size={14} /> : null}
      onClick={onChoose}
    >
      {label}
    </Menu.Item>
  );
}

function FilterGroup({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div role="group" aria-label={label}>
      <Menu.Label>{label}</Menu.Label>
      {children}
    </div>
  );
}

/**
 * The panel's Filter menu: the project and kind, who a question waits on (Waiting), and how and when a card
 * closed (Resolved). Each choice goes to the URL, and a dot on the button says a filter is set.
 */
export function InboxFilterMenu({
  state,
  search,
  onChange,
}: {
  readonly state: InboxPanelState;
  readonly search: InboxSearch;
  readonly onChange: (next: InboxSearch) => void;
}): ReactNode {
  const projects = useProjects().data ?? [];
  const people = (usePeople().data ?? []).filter((p) => !p.isBuilder);
  return (
    <Menu position="bottom-end" width={220} withinPortal>
      <Menu.Target>
        <ActionIcon variant="subtle" color="gray" size={28} aria-label="Filter">
          <Indicator size={7} offset={-2} disabled={!filtersSet(search)}>
            <IconFilter size={16} stroke={1.6} />
          </Indicator>
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown mah={420} style={{ overflowY: 'auto' }}>
        <FilterGroup label="Project">
          <Choice
            label="All projects"
            checked={search.project === undefined}
            onChoose={() => {
              onChange(withFilter(search, 'project', null));
            }}
          />
          {projects.map((project) => (
            <Choice
              key={project.id}
              label={project.name}
              checked={search.project === project.id}
              onChoose={() => {
                onChange(withFilter(search, 'project', project.id));
              }}
            />
          ))}
        </FilterGroup>
        {state === 'activity' ? null : (
          <>
            <Menu.Divider />
            <FilterGroup label="Kind">
              <Choice
                label="Any Kind"
                checked={search.kind === undefined}
                onChoose={() => {
                  onChange(withFilter(search, 'kind', null));
                }}
              />
              {Object.values(InboxKind).map((kind) => (
                <Choice
                  key={kind}
                  label={KIND_LABELS[kind]}
                  checked={search.kind === kind}
                  onChoose={() => {
                    onChange(withFilter(search, 'kind', kind));
                  }}
                />
              ))}
            </FilterGroup>
          </>
        )}
        {state === InboxListState.Waiting ? (
          <>
            <Menu.Divider />
            <FilterGroup label="With">
              <Choice
                label="Anyone"
                checked={search.person === undefined}
                onChoose={() => {
                  onChange(withFilter(search, 'person', null));
                }}
              />
              {people.map((person) => (
                <Choice
                  key={person.id}
                  label={person.name}
                  checked={search.person === person.id}
                  onChoose={() => {
                    onChange(withFilter(search, 'person', person.id));
                  }}
                />
              ))}
            </FilterGroup>
          </>
        ) : null}
        {state === InboxListState.Resolved ? (
          <>
            <Menu.Divider />
            <FilterGroup label="Outcome">
              <Choice
                label="Any Outcome"
                checked={search.outcome === undefined}
                onChoose={() => {
                  onChange(withFilter(search, 'outcome', null));
                }}
              />
              {Object.values(InboxOutcome).map((outcome) => (
                <Choice
                  key={outcome}
                  label={OUTCOME_LABELS[outcome]}
                  checked={search.outcome === outcome}
                  onChoose={() => {
                    onChange(withFilter(search, 'outcome', outcome));
                  }}
                />
              ))}
            </FilterGroup>
            <Menu.Divider />
            <FilterGroup label="When">
              <Choice
                label="Any Time"
                checked={search.since === undefined}
                onChoose={() => {
                  onChange(withFilter(search, 'since', null));
                }}
              />
              {Object.values(InboxSince).map((since) => (
                <Choice
                  key={since}
                  label={SINCE_LABELS[since]}
                  checked={search.since === since}
                  onChoose={() => {
                    onChange(withFilter(search, 'since', since));
                  }}
                />
              ))}
            </FilterGroup>
          </>
        ) : null}
        <Menu.Divider />
        <Menu.Item
          disabled={!filtersSet(search)}
          onClick={() => {
            onChange(withoutFilters(search));
          }}
        >
          Clear Filters
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
