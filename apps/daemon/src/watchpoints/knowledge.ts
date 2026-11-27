import {
  PrincipleKind,
  type PrincipleDto,
  type PrincipleId,
  type Watchpoint,
} from '@10db/contracts';
import { mostSpecific } from '../knowledge';

/** The most principles one watchpoint's guidance takes in. */
export const MAX_WATCHPOINT_PRINCIPLES = 5;

/** A principle as a brief carries it: its id to cite, and its words. */
export interface WatchpointPrinciple {
  readonly id: PrincipleId;
  readonly statement: string;
}

/** Each watchpoint's resolved principles, by its key; a watchpoint with none has no entry. */
export type WatchpointPrinciples = ReadonlyMap<string, readonly WatchpointPrinciple[]>;

const underTopic = (topicKey: string, topic: string): boolean =>
  topicKey === topic || topicKey.startsWith(`${topic}.`);

/**
 * The current principles each watchpoint links: those whose topic key is one of its `knowledge` keys or starts with
 * `key.`, newest first, at most `MAX_WATCHPOINT_PRINCIPLES`. `principles` is the project's and the builder's current
 * set, newest first. As the context pack does, a belief is no rule and is left out, and for each topic key only the
 * most specific scope that applies to `areas` is kept, so a project's rule hides the builder's own on the same key.
 */
export function watchpointPrinciples(
  watchpoints: readonly Pick<Watchpoint, 'key' | 'knowledge'>[],
  principles: readonly PrincipleDto[],
  areas: readonly string[],
): WatchpointPrinciples {
  const rules = mostSpecific(
    principles.filter((p) => p.kind !== PrincipleKind.Belief),
    areas,
  );
  const resolved = new Map<string, WatchpointPrinciple[]>();
  for (const watchpoint of watchpoints) {
    const linked = rules
      .filter((p) => watchpoint.knowledge.some((topic) => underTopic(p.topicKey, topic)))
      .slice(0, MAX_WATCHPOINT_PRINCIPLES)
      .map((p) => ({ id: p.id, statement: p.statement }));
    if (linked.length > 0) resolved.set(watchpoint.key, linked);
  }
  return resolved;
}
