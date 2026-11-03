import { KnowledgeScope, PrincipleKind, type DecisionId, type PrincipleId } from '@10db/contracts';
import { decisionBullet, principleBullet } from './render';
import { appliesTo, mostSpecific, specificity } from './scope';

/** Kept small: an always-loaded core memory that grew failed a held-out eval (spec §9). */
export const CONTEXT_PACK_BUDGET_TOKENS = 1500;
/** A rough estimate that needs no tokenizer; the budget is a ceiling, not a measurement. */
export const CHARS_PER_TOKEN = 4;
/** How many search hits for the task are considered. */
export const PACK_SEARCH_LIMIT = 20;
/** How many recent decisions stand in when nothing matches the task. */
export const PACK_RECENT_LIMIT = 5;

export interface PackPrinciple {
  readonly id: PrincipleId;
  readonly statement: string;
  readonly kind: PrincipleKind;
  readonly topicKey: string;
  readonly scope: KnowledgeScope;
  readonly area: string | null;
}

export interface PackDecision {
  readonly id: DecisionId;
  readonly question: string;
  readonly choice: string;
  readonly rationale: string;
  readonly scope: KnowledgeScope;
  readonly area: string | null;
}

export interface PackInput {
  /** The areas the task lists plus the areas the workstream holds live claims on. */
  readonly areas: readonly string[];
  /** Current confirmed principles of the project and the builder's own. */
  readonly principles: readonly PackPrinciple[];
  /** Current decisions of the project and the builder's own, newest first. */
  readonly decisions: readonly PackDecision[];
  /** Search hits for the task among those decisions, best first. */
  readonly ranked: readonly DecisionId[];
  readonly budgetTokens: number;
}

export interface PackShelves {
  readonly policies: number;
  readonly heuristics: number;
  readonly decisions: number;
}

export interface KnowledgePack {
  readonly policies: readonly PackPrinciple[];
  readonly heuristics: readonly PackPrinciple[];
  readonly decisions: readonly PackDecision[];
  readonly budgetTokens: number;
  readonly usedTokens: number;
  readonly dropped: PackShelves;
}

// The cost of an item is the line a session reads, so the budget counts what is rendered, id and scope too.
export const principleTokens = (p: PackPrinciple): number =>
  Math.ceil(principleBullet(p).length / CHARS_PER_TOKEN);
export const decisionTokens = (d: PackDecision): number =>
  Math.ceil(decisionBullet(d).length / CHARS_PER_TOKEN);

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byPrecedence = (a: PackPrinciple, b: PackPrinciple): number =>
  specificity(b.scope) - specificity(a.scope) ||
  compareText(a.topicKey, b.topicKey) ||
  compareText(a.id, b.id);

/** Area-matched hits, other hits by rank, then area decisions without a hit; else the newest that apply. */
function relevantDecisions(input: PackInput): PackDecision[] {
  const applying = input.decisions.filter((d) => appliesTo(d, input.areas));
  const byId = new Map(applying.map((d) => [d.id, d]));
  const hits = input.ranked.flatMap((id) => {
    const d = byId.get(id);
    return d ? [d] : [];
  });
  const hitIds = new Set(hits.map((d) => d.id));
  const ordered = [
    ...hits.filter((d) => d.scope === KnowledgeScope.Area),
    ...hits.filter((d) => d.scope !== KnowledgeScope.Area),
    ...applying.filter((d) => d.scope === KnowledgeScope.Area && !hitIds.has(d.id)),
  ];
  return ordered.length > 0 ? ordered : applying.slice(0, PACK_RECENT_LIMIT);
}

/** Keeps each item that still fits, in order, skipping one that doesn't (the next may be smaller). */
function fill<T>(items: readonly T[], size: (item: T) => number, room: { left: number }) {
  const kept: T[] = [];
  for (const item of items) {
    const n = size(item);
    if (n > room.left) continue;
    kept.push(item);
    room.left -= n;
  }
  return { kept, dropped: items.length - kept.length };
}

/**
 * The knowledge part of the context pack (spec §9): confirmed policies in scope, then heuristics, then
 * the decisions relevant to the task, filled greedily into the budget. Beliefs are context for
 * find_knowledge, not rules, so they are not packed; they are dropped before the most specific record
 * per key is chosen, so an area belief can't hide a project policy. Deterministic for the same rows in
 * any order.
 */
export function packKnowledge(input: PackInput): KnowledgePack {
  const rules = input.principles.filter((p) => p.kind !== PrincipleKind.Belief);
  const principles = mostSpecific(rules, input.areas).toSorted(byPrecedence);
  const room = { left: input.budgetTokens };
  const policies = fill(
    principles.filter((p) => p.kind === PrincipleKind.Policy),
    principleTokens,
    room,
  );
  const heuristics = fill(
    principles.filter((p) => p.kind === PrincipleKind.Heuristic),
    principleTokens,
    room,
  );
  const decisions = fill(relevantDecisions(input), decisionTokens, room);
  return {
    policies: policies.kept,
    heuristics: heuristics.kept,
    decisions: decisions.kept,
    budgetTokens: input.budgetTokens,
    usedTokens: input.budgetTokens - room.left,
    dropped: {
      policies: policies.dropped,
      heuristics: heuristics.dropped,
      decisions: decisions.dropped,
    },
  };
}
