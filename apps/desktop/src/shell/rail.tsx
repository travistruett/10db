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
import type { KeyboardEvent, ReactNode } from 'react';
import { useShapes } from '../daemon/shape-queries';
import { firstAppSection } from '../views/settings/sections';
import { AgentDownloadStatus } from './agent-download-status';
import { ColorSchemeToggle } from './color-scheme-toggle';
import { DaemonStatus } from './daemon-status';
import { KeepAwakeControl } from './keep-awake-control';
import { ProjectSwitcher } from './project-switcher';
import {
  RAIL_ITEMS,
  RAIL_ORDER,
  RailControl,
  RailSection,
  railSectionForPath,
  type RailEntry,
} from './rail-items';
import { InboxBadge, SessionsBadge, WorkbenchBadge } from './rail-badges';
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
  return (
    <>
      <Glyph size={18} stroke={1.6} aria-hidden />
      <VisuallyHidden>{RAIL_ITEMS[section].label}</VisuallyHidden>
      {badge === undefined ? null : <span className={classes['badge']}>{badge}</span>}
    </>
  );
}

/** The props every rail item's link shares. */
function itemProps(active: boolean) {
  return {
    className: classes['item'],
    'aria-current': active ? ('page' as const) : undefined,
    'data-rail-item': true,
  };
}

/** Plan opens the project's latest open conversation, or the blank composer when there is none. */
function PlanLink({ active }: { readonly active: boolean }) {
  const { project } = useSelectedProject();
  const latest = latestOpenShape(useShapes(project?.id ?? null).data);
  const navigate = useNavigate();
  return (
    <Tooltip label={RAIL_ITEMS.plan.label} position="right" openDelay={300}>
      {/* A plain anchor the router navigates, so the conversation's id is typed at this one call site. */}
      <a
        {...itemProps(active)}
        href={latest ? `/shape/${latest.id}` : '/shape'}
        onClick={(event) => {
          event.preventDefault();
          if (latest) void navigate({ to: '/shape/$shapeId', params: { shapeId: latest.id } });
          else void navigate({ to: '/shape' });
        }}
      >
        <RailItemContent section={RailSection.Plan} />
      </a>
    </Tooltip>
  );
}

function SettingsLink({ active }: { readonly active: boolean }) {
  return (
    <Tooltip label={RAIL_ITEMS.settings.label} position="right" openDelay={300}>
      <Link {...itemProps(active)} to="/settings/$section" params={{ section: firstAppSection() }}>
        <RailItemContent section={RailSection.Settings} />
      </Link>
    </Tooltip>
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
    <Tooltip label={label} position="right" openDelay={300}>
      <Link {...itemProps(active)} to={route}>
        <RailItemContent section={section} badge={badge} />
      </Link>
    </Tooltip>
  );
}

function RailControlView({ control }: { readonly control: RailControl }) {
  switch (control) {
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

/** The icon rail: global sections, the project tile and its sections, then the status icons and Settings. */
export function Rail() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = railSectionForPath(pathname);
  return (
    // ↑/↓ roving is a pointer-free shortcut on the landmark; the links stay the interactive elements.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <nav aria-label="Sections" className={classes['rail']} onKeyDown={moveWithArrows}>
      {RAIL_ORDER.map((entry, index) => (
        <RailEntryView key={`${entry.kind}-${String(index)}`} entry={entry} current={current} />
      ))}
    </nav>
  );
}
