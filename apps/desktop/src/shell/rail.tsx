import { Tooltip, VisuallyHidden } from '@mantine/core';
import {
  IconBulb,
  IconBuildingFactory2,
  IconInbox,
  IconLayoutKanban,
  IconMessages,
  IconRoute,
  IconSettings,
  IconTools,
  type Icon,
} from '@tabler/icons-react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import type { KeyboardEvent, MouseEvent, ReactElement, ReactNode } from 'react';
import { useShapes } from '../daemon/shape-queries';
import { firstAppSection } from '../views/settings/sections';
import { AgentDownloadStatus } from './agent-download-status';
import { StatusLineControl } from './status-line';
import { ColorSchemeToggle } from './color-scheme-toggle';
import { DaemonStatus } from './daemon-status';
import { KeepAwakeControl } from './keep-awake-control';
import { ProjectSwitcher } from './project-switcher';
import { RailModeContext, useRailMode } from './rail-mode';
import {
  RAIL_ITEMS,
  RAIL_ORDER,
  RailControl,
  RailSection,
  railSectionForPath,
  type RailEntry,
} from './rail-items';
import { InboxBadge, SessionsBadge, WorkbenchBadge } from './rail-badges';
import { lastInboxSearch } from '../views/inbox/inbox-search';
import { latestOpenShape } from './shape-nav';
import { useSelectedProject } from './selected-project';
import classes from './rail.module.css';

const ICONS: Readonly<Record<RailSection, Icon>> = {
  inbox: IconInbox,
  factory: IconBuildingFactory2,
  sessions: IconMessages,
  board: IconLayoutKanban,
  plan: IconRoute,
  workbench: IconTools,
  knowledge: IconBulb,
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

/**
 * What every rail item's link shares. `claim` is the click on the open section's own row: it shows or hides
 * the section's panel (when it has one) instead of navigating, and says whether it did.
 */
function useItemProps(active: boolean) {
  const { labels, onActiveClick } = useRailMode();
  return {
    props: {
      className: classes['item'],
      'aria-current': active ? ('page' as const) : undefined,
      'data-rail-item': true,
      'data-labelled': labels ? '' : undefined,
    },
    claim: (event: MouseEvent<HTMLElement>): boolean => {
      if (!active || onActiveClick === null) return false;
      event.preventDefault();
      onActiveClick();
      return true;
    },
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

/** Plan opens the project's latest open conversation, or the blank composer when there is none. */
function PlanLink({ active }: { readonly active: boolean }) {
  const { project } = useSelectedProject();
  const latest = latestOpenShape(useShapes(project?.id ?? null).data);
  const navigate = useNavigate();
  const { props, claim } = useItemProps(active);
  return (
    <RailTooltip label={RAIL_ITEMS.plan.label}>
      {/* A plain anchor the router navigates, so the conversation's id is typed at this one call site. */}
      <a
        {...props}
        href={latest ? `/shape/${latest.id}` : '/shape'}
        onClick={(event) => {
          event.preventDefault();
          if (claim(event)) return;
          if (latest) void navigate({ to: '/shape/$shapeId', params: { shapeId: latest.id } });
          else void navigate({ to: '/shape' });
        }}
      >
        <RailItemContent section={RailSection.Plan} />
      </a>
    </RailTooltip>
  );
}

function SettingsLink({ active }: { readonly active: boolean }) {
  const { props, claim } = useItemProps(active);
  return (
    <RailTooltip label={RAIL_ITEMS.settings.label}>
      <Link
        {...props}
        to="/settings/$section"
        params={{ section: firstAppSection() }}
        onClick={claim}
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
  readonly section: Exclude<RailSection, 'plan' | 'settings'>;
  readonly active: boolean;
}) {
  const { project } = useSelectedProject();
  const { props, claim } = useItemProps(active);
  const { label, route } = RAIL_ITEMS[section];
  const badge =
    section === RailSection.Inbox ? (
      <InboxBadge />
    ) : section === RailSection.Sessions ? (
      <SessionsBadge />
    ) : section === RailSection.Workbench && project !== null ? (
      <WorkbenchBadge projectId={project.id} />
    ) : undefined;
  return (
    <RailTooltip label={label}>
      <Link
        {...props}
        to={route}
        {...(section === RailSection.Inbox
          ? // Read when the link is followed: a value read in render is cached by the React Compiler.
            { search: () => lastInboxSearch.get() }
          : {})}
        onClick={claim}
      >
        <RailItemContent section={section} badge={badge} />
      </Link>
    </RailTooltip>
  );
}

function RailControlView({ control }: { readonly control: RailControl }) {
  switch (control) {
    case RailControl.Status:
      return <StatusLineControl />;
    case RailControl.Download:
      return <AgentDownloadStatus />;
    case RailControl.Daemon:
      return <DaemonStatus />;
    case RailControl.KeepAwake:
      return <KeepAwakeControl />;
    case RailControl.ColorScheme:
      return <ColorSchemeToggle />;
  }
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
    case 'control':
      return <RailControlView control={entry.control} />;
    case 'item': {
      const active = entry.section === current;
      if (entry.section === RailSection.Plan) return <PlanLink active={active} />;
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
 * The rail: global sections, the project, its sections, then the status controls and Settings. Labelled it is
 * 200 px wide and the foot is one row; icons only it is 76 px, every name in a tooltip, and the foot stacks.
 */
export function Rail({
  labels,
  onActiveClick,
}: {
  readonly labels: boolean;
  /** Set when the open section has a panel: a click on its own row shows or hides it. */
  readonly onActiveClick: (() => void) | null;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = railSectionForPath(pathname);
  const foot = RAIL_ORDER.findIndex((entry) => entry.kind === 'spacer');
  const body = RAIL_ORDER.slice(0, foot);
  const rest = RAIL_ORDER.slice(foot);
  const settings = rest.filter((entry) => entry.kind === 'item');
  const controls = rest.filter((entry) => entry.kind === 'control');
  const footEntries = labels ? [...settings, ...controls] : [...controls, ...settings];
  return (
    <RailModeContext value={{ labels, onActiveClick }}>
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
