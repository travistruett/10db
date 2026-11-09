import {
  KnowledgeScope,
  KnowledgeState,
  PrincipleKind,
  SourceKind,
  type ProvenanceDto,
} from '@10db/contracts';
import type { MantineColor } from '@mantine/core';
import dayjs from 'dayjs';

export const PRINCIPLE_KIND_LABELS: Readonly<Record<PrincipleKind, string>> = {
  [PrincipleKind.Policy]: 'Rule',
  [PrincipleKind.Heuristic]: 'Preference',
  [PrincipleKind.Belief]: 'Background',
};

/** What each kind does to an agent, as the context pack treats it: policies and heuristics brief every session, beliefs never. */
export const PRINCIPLE_KIND_DESCRIPTIONS: Readonly<Record<PrincipleKind, string>> = {
  [PrincipleKind.Policy]: 'Agents must follow it. Every session is briefed with it.',
  [PrincipleKind.Heuristic]:
    'Agents follow it unless the task gives a reason not to. Briefed after rules.',
  [PrincipleKind.Belief]:
    'Context, not an instruction. Agents find it when they search; sessions are not briefed with it.',
};

/** A policy is the loud one, a heuristic quieter, a belief only context. */
export const PRINCIPLE_KIND_COLORS: Readonly<Record<PrincipleKind, MantineColor>> = {
  [PrincipleKind.Policy]: 'orange',
  [PrincipleKind.Heuristic]: 'blue',
  [PrincipleKind.Belief]: 'gray',
};

export const STATE_LABELS: Readonly<Record<KnowledgeState, string>> = {
  [KnowledgeState.Proposed]: 'Proposed',
  [KnowledgeState.Current]: 'Current',
  [KnowledgeState.Superseded]: 'Superseded',
  [KnowledgeState.Retired]: 'Retired',
  [KnowledgeState.Withdrawn]: 'Withdrawn',
};

// DESIGN.md: yellow waits on a human, green is done or ready, gray is out of play. A withdrawn record
// is out of play too; red would read as a failure.
export const STATE_COLORS: Readonly<Record<KnowledgeState, MantineColor>> = {
  [KnowledgeState.Proposed]: 'yellow',
  [KnowledgeState.Current]: 'green',
  [KnowledgeState.Superseded]: 'gray',
  [KnowledgeState.Retired]: 'gray',
  [KnowledgeState.Withdrawn]: 'gray',
};

/** The scope a record applies to, said the same wherever it is shown or chosen. */
export const SCOPE_ALL_PROJECTS = 'All Projects';
export const SCOPE_THIS_PROJECT = 'This Project';
export const SCOPE_THIS_AREA = 'This Area';

/** "All Projects", "This Project", or the area's own name. */
export function scopeText(r: {
  readonly scope: KnowledgeScope;
  readonly area: string | null;
}): string {
  if (r.scope === KnowledgeScope.You) return SCOPE_ALL_PROJECTS;
  if (r.scope === KnowledgeScope.Area && r.area !== null) return r.area;
  return SCOPE_THIS_PROJECT;
}

export const dateText = (iso: string): string => dayjs(iso).format('D MMM YYYY');
/** A table cell's date: day and month this year, the year too before it. */
export function shortDateText(iso: string, now: Date = new Date()): string {
  const day = dayjs(iso);
  return day.year() === now.getFullYear() ? day.format('D MMM') : day.format('D MMM YYYY');
}
export const dateTimeText = (iso: string): string => dayjs(iso).format('D MMM YYYY, HH:mm');

/** The builder is `me` in the daemon's records; an agent is `agent:<session>`. */
export function whoText(by: string | null): string {
  if (by === null || by === 'me' || by === 'builder') return 'you';
  return by.startsWith('agent:') ? 'an agent' : by;
}

/** Tools that write on the builder's behalf and are Claude Code (`builder_mcp` is its 10db tools). */
const CLAUDE_CODE_VIAS: readonly string[] = ['claude_code', 'builder_mcp'];

/** A tool that wrote through the API, in the builder's words; an unknown tool keeps its own name. */
export function viaLabel(via: string): string {
  return CLAUDE_CODE_VIAS.includes(via) ? 'Claude Code' : via;
}

/**
 * Where a record came from, in the builder's words. An answered card, an agent and 10db itself have
 * their own source kinds; a builder source says more in its ref: a Plan conversation names its
 * `shapeId`, and a write through the API names its tool in `origin.via`.
 */
export function sourceLabel(p: Pick<ProvenanceDto, 'sourceKind' | 'sourceRef' | 'origin'>): string {
  switch (p.sourceKind) {
    case SourceKind.InboxAnswer:
      return 'Inbox answer';
    case SourceKind.Agent:
      return 'Agent';
    case SourceKind.Daemon:
      return 'The app';
    case SourceKind.Builder: {
      if (typeof p.sourceRef['shapeId'] === 'string') return 'Plan conversation';
      const via = p.origin?.via;
      if (via === undefined) return 'The app';
      return viaLabel(via);
    }
  }
}
