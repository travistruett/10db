import { Tooltip, VisuallyHidden } from '@mantine/core';
import {
  IconBulb,
  IconFlask,
  IconBuildingFactory2,
  IconInbox,
  IconLayoutKanban,
  IconMessages,
  IconSettings,
  IconTarget,
  IconTools,
  type Icon,
} from '@tabler/icons-react';
import { Link, useRouterState } from '@tanstack/react-router';
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';
import { firstAppSection } from '../views/settings/sections';
import { AgentDownloadStatus } from './agent-download-status';
import { FactoryStatusDot } from './factory-status';
import { ProjectSwitcher } from './project-switcher';
import { RailModeContext, useRailMode } from './rail-mode';
import {
  RAIL_ITEMS,
  RAIL_ORDER,
  RailSection,
  railSectionForPath,
  type RailEntry,
} from './rail-items';
import { InboxBadge, SessionsBadge, WorkbenchBadge } from './rail-badges';
import { lastInboxSearch } from '../views/inbox/inbox-search';
import { useSelectedProject } from './selected-project';
import classes from './rail.module.css';

const ICONS: Readonly<Record<RailSection, Icon>> = {
  inbox: IconInbox,
  factory: IconBuildingFactory2,
  sessions: IconMessages,
  goals: IconTarget,
  board: IconLayoutKanban,
  workbench: IconTools,
  knowledge: IconBulb,
  evals: IconFlask,
  settings: IconSettings,
};

/** What a rail item holds: its icon, its name for assistive tech, and its count as a separate phrase. */
function RailItemContent({
  section,
  badge,
}: {
  readonly section: RailSection;
  readonly badge?: ReactNode;
}) {
  const Glyph = ICONS[section];
  const { labels } = useRailMode();
  const { label } = RAIL_ITEMS[section];
  return (
    <>
      <Glyph size={18} stroke={1.6} aria-hidden />
      {labels ? (
        <span className={classes['label']}>{label}</span>
      ) : (
        <VisuallyHidden>{label}</VisuallyHidden>
      )}
      {badge === undefined ? null : <span className={classes['badge']}>{badge}</span>}
    </>
  );
}

/** What every rail item's link shares. */
function itemProps(active: boolean, labels: boolean) {
  return {
    className: classes['item'],
    'aria-current': active ? ('page' as const) : undefined,
    'data-rail-item': true,
    'data-labelled': labels ? '' : undefined,
  };
}

/** An icon's name shows in a tooltip only when the rail has no labels. */
function RailTooltip({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactElement;
}) {
  const { labels } = useRailMode();
  return (
    <Tooltip label={label} position="right" disabled={labels}>
      {children}
    </Tooltip>
  );
}

function SettingsLink({ active }: { readonly active: boolean }) {
  const { labels } = useRailMode();
  return (
    <RailTooltip label={RAIL_ITEMS.settings.label}>
      <Link
        {...itemProps(active, labels)}
        to="/settings/$section"
        params={{ section: firstAppSection() }}
      >
        <RailItemContent section={RailSection.Settings} />
      </Link>
    </RailTooltip>
  );
}

function SectionLink({
  section,
  active,
}: {
  readonly section: Exclude<RailSection, 'settings'>;
  readonly active: boolean;
}) {
  const { project } = useSelectedProject();
  const { labels } = useRailMode();
  const { label, route } = RAIL_ITEMS[section];
  const badge =
    section === RailSection.Inbox ? (
      <InboxBadge />
    ) : section === RailSection.Factory ? (
      <FactoryStatusDot />
    ) : section === RailSection.Sessions ? (
      <SessionsBadge />
    ) : section === RailSection.Workbench && project !== null ? (
      <WorkbenchBadge projectId={project.id} />
    ) : undefined;
  return (
    <RailTooltip label={label}>
      <Link
        {...itemProps(active, labels)}
        to={route}
        {...(section === RailSection.Inbox
          ? // Read when the link is followed: a value read in render is cached by the React Compiler.
            { search: () => lastInboxSearch.get() }
          : {})}
      >
        <RailItemContent section={section} badge={badge} />
      </Link>
    </RailTooltip>
  );
}

function RailEntryView({
  entry,
  current,
}: {
  readonly entry: RailEntry;
  readonly current: RailSection | null;
}) {
  switch (entry.kind) {
    case 'divider':
      return <div className={classes['divider']} role="separator" />;
    case 'spacer':
      return <div className={classes['spacer']} />;
    case 'project-tile':
      return <ProjectSwitcher />;
    case 'download-status':
      return <AgentDownloadStatus />;
    case 'item': {
      const active = entry.section === current;
      if (entry.section === RailSection.Settings) return <SettingsLink active={active} />;
      return <SectionLink section={entry.section} active={active} />;
    }
  }
}

/** ↑ and ↓ move between the rail's items; Enter opens the focused one, as a link does. */
function moveWithArrows(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const focusable = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
  ];
  const at = focusable.findIndex((element) => element === document.activeElement);
  if (at === -1) return;
  const next = focusable[at + (event.key === 'ArrowDown' ? 1 : -1)];
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
}

/**
 * The rail: global sections, the project, its sections, then the download status and Settings. Labelled it is
 * 200 px wide and the foot is one row; icons only it is 60 px, every name in a tooltip, and the foot stacks.
 */
export function Rail({ labels }: { readonly labels: boolean }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = railSectionForPath(pathname);
  const foot = RAIL_ORDER.findIndex((entry) => entry.kind === 'spacer');
  const body = RAIL_ORDER.slice(0, foot);
  const rest = RAIL_ORDER.slice(foot);
  const settings = rest.filter((entry) => entry.kind === 'item');
  const controls = rest.filter((entry) => entry.kind === 'download-status');
  const footEntries = labels ? [...settings, ...controls] : [...controls, ...settings];
  return (
    <RailModeContext value={{ labels }}>
      {/* The group shares one delay, so scanning down the icons does not wait at each. */}
      <Tooltip.Group openDelay={300} closeDelay={0}>
        {/* ↑/↓ roving is a pointer-free shortcut on the landmark; the links stay the interactive elements. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <nav
          aria-label="Sections"
          className={classes['rail']}
          data-labelled={labels ? '' : undefined}
          onKeyDown={moveWithArrows}
        >
          {body.map((entry, index) => (
            <RailEntryView key={`${entry.kind}-${String(index)}`} entry={entry} current={current} />
          ))}
          <div className={classes['spacer']} />
          <div className={classes['foot']}>
            {footEntries.map((entry, index) => (
              <RailEntryView
                key={`${entry.kind}-${String(index)}`}
                entry={entry}
                current={current}
              />
            ))}
          </div>
        </nav>
      </Tooltip.Group>
    </RailModeContext>
  );
}
