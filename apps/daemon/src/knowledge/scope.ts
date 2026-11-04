import { KnowledgeScope } from '@10db/contracts';

export interface Scoped {
  readonly scope: KnowledgeScope;
  readonly area: string | null;
}

/** An area rule is more specific than a project rule, which is more specific than the builder's own. */
export function specificity(scope: KnowledgeScope): number {
  switch (scope) {
    case KnowledgeScope.You:
      return 0;
    case KnowledgeScope.Project:
      return 1;
    case KnowledgeScope.Area:
      return 2;
  }
}

/**
 * Whether a record of the task's project (or one of the builder's own) applies to work in `areas`.
 * Callers pass only records of that project and the builder's own.
 */
export function appliesTo(record: Scoped, areas: readonly string[]): boolean {
  switch (record.scope) {
    case KnowledgeScope.You:
    case KnowledgeScope.Project:
      return true;
    case KnowledgeScope.Area:
      return record.area !== null && areas.includes(record.area);
  }
}

/**
 * For each topic key, the applying records of the highest specificity. It ignores kind, so callers
 * drop the kinds they don't want first: the packer drops beliefs, so a belief never hides a rule.
 */
export function mostSpecific<T extends Scoped & { readonly topicKey: string }>(
  records: readonly T[],
  areas: readonly string[],
): T[] {
  const applying = records.filter((r) => appliesTo(r, areas));
  const best = new Map<string, number>();
  for (const r of applying)
    best.set(r.topicKey, Math.max(best.get(r.topicKey) ?? -1, specificity(r.scope)));
  return applying.filter((r) => specificity(r.scope) === best.get(r.topicKey));
}
