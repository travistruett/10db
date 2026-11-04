import type { KnowledgeHit, PrincipleHit } from '@10db/contracts';
import type { PackDecision, PackPrinciple } from './pack';

export function decisionHit(d: PackDecision): KnowledgeHit {
  return {
    kind: 'decision',
    id: d.id,
    question: d.question,
    choice: d.choice,
    rationale: d.rationale,
    scope: d.scope,
    area: d.area,
  };
}

export function principleHit(p: PackPrinciple): PrincipleHit {
  return {
    kind: 'principle',
    id: p.id,
    statement: p.statement,
    principleKind: p.kind,
    topicKey: p.topicKey,
    scope: p.scope,
    area: p.area,
  };
}
