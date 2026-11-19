/** A section the rail opens. */
export const RailSection = {
  Inbox: 'inbox',
  Factory: 'factory',
  Sessions: 'sessions',
  Board: 'board',
  Plan: 'plan',
  Workbench: 'workbench',
  Knowledge: 'knowledge',
  Settings: 'settings',
} as const;
export type RailSection = (typeof RailSection)[keyof typeof RailSection];

/** The status controls at the rail's foot, which are not sections. */
export const RailControl = {
  Download: 'download',
  Daemon: 'daemon',
} as const;
export type RailControl = (typeof RailControl)[keyof typeof RailControl];

export interface RailItem {
  readonly section: RailSection;
  /** The name a tooltip and the accessible name carry. */
  readonly label: string;
  /** The route's path as the router registers it. */
  readonly route: string;
}

export const RAIL_ITEMS: Readonly<Record<RailSection, RailItem>> = {
  inbox: { section: 'inbox', label: 'Inbox', route: '/inbox' },
  factory: { section: 'factory', label: 'Factory', route: '/factory' },
  sessions: { section: 'sessions', label: 'Sessions', route: '/sessions' },
  board: { section: 'board', label: 'Board', route: '/board' },
  plan: { section: 'plan', label: 'Plan', route: '/shape' },
  workbench: {
    section: 'workbench',
    label: 'UI Workbench',
    route: '/workbench',
  },
  knowledge: {
    section: 'knowledge',
    label: 'Knowledge',
    route: '/knowledge',
  },
  settings: { section: 'settings', label: 'Settings', route: '/settings' },
};

/** One slot in the rail, top to bottom. */
export type RailEntry =
  | { readonly kind: 'item'; readonly section: RailSection }
  | { readonly kind: 'divider' }
  | { readonly kind: 'project-tile' }
  | { readonly kind: 'spacer' }
  | { readonly kind: 'control'; readonly control: RailControl };

const item = (section: RailSection): RailEntry => ({ kind: 'item', section });

export const RAIL_ORDER: readonly RailEntry[] = [
  item(RailSection.Inbox),
  item(RailSection.Factory),
  item(RailSection.Sessions),
  { kind: 'divider' },
  { kind: 'project-tile' },
  item(RailSection.Board),
  item(RailSection.Plan),
  item(RailSection.Workbench),
  item(RailSection.Knowledge),
  { kind: 'spacer' },
  { kind: 'control', control: RailControl.Download },
  { kind: 'control', control: RailControl.Daemon },
  item(RailSection.Settings),
];

/** The section a pathname belongs to, or null for a path no rail item owns. */
export function railSectionForPath(pathname: string): RailSection | null {
  for (const entry of Object.values(RAIL_ITEMS)) {
    if (pathname === entry.route || pathname.startsWith(`${entry.route}/`)) return entry.section;
  }
  return null;
}
