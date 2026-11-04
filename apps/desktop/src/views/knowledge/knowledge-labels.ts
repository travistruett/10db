import {
  KnowledgeScope,
  SourceKind,
  type KnowledgeState,
  type PrincipleKind,
  type ProvenanceDto,
} from '@10db/contracts';
import type { MantineColor } from '@mantine/core';
import dayjs from 'dayjs';

export const PRINCIPLE_KIND_LABELS: Readonly<Record<PrincipleKind, string>> = {
  policy: 'Policy',
  heuristic: 'Heuristic',
  belief: 'Belief',
};

/** Policies first, then heuristics, then beliefs: the order the context pack uses. */
export const PRINCIPLE_KIND_ORDER: readonly PrincipleKind[] = ['policy', 'heuristic', 'belief'];

export const STATE_LABELS: Readonly<Record<KnowledgeState, string>> = {
  proposed: 'Proposed',
  current: 'Current',
  superseded: 'Superseded',
  retired: 'Retired',
  withdrawn: 'Withdrawn',
};

// DESIGN.md: yellow waits on a human, green is done or ready, gray is out of play. A withdrawn record
// is out of play too; red would read as a failure.
export const STATE_COLORS: Readonly<Record<KnowledgeState, MantineColor>> = {
  proposed: 'yellow',
  current: 'green',
  superseded: 'gray',
  retired: 'gray',
  withdrawn: 'gray',
};

/** "You", "Project", or the area's own name. */
export function scopeText(r: {
  readonly scope: KnowledgeScope;
  readonly area: string | null;
}): string {
  if (r.scope === KnowledgeScope.You) return 'You';
  if (r.scope === KnowledgeScope.Area && r.area !== null) return r.area;
  return 'Project';
}

export const dateText = (iso: string): string => dayjs(iso).format('D MMM YYYY');
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
