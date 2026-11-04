import {
  KnowledgeDraftDto,
  KnowledgeItemKind,
  type DecisionDto,
  type DecisionItem,
  type KnowledgeItemDto,
  type PrincipleDto,
  type PrincipleItem,
} from '@10db/contracts';

export function decisionItem(d: DecisionDto): DecisionItem {
  return { ...d, kind: KnowledgeItemKind.Decision };
}

/** A principle's own `kind` (policy, heuristic, belief) is `principleKind` on the item; `kind` says it is a principle. */
export function principleItem(p: PrincipleDto): PrincipleItem {
  const { kind, ...rest } = p;
  return { ...rest, kind: KnowledgeItemKind.Principle, principleKind: kind };
}

/** What a write would produce: the item without the id and source it would be given (the schema drops them). */
export function draftOf(item: KnowledgeItemDto): KnowledgeDraftDto {
  return KnowledgeDraftDto.parse(item);
}
