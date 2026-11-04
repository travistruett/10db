import {
  KnowledgeItemKind,
  KnowledgeListDto,
  ProposalDto,
  ProvenanceDto,
  type DecisionId,
  type KnowledgeScope,
  type PrincipleId,
  type ProjectId,
} from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

/** What the Knowledge view asks the list route for; `kind` is the tab. */
export interface KnowledgeFilter {
  readonly projectId: ProjectId;
  readonly scope: KnowledgeScope | null;
  readonly area: string | null;
  readonly q: string;
  readonly history: boolean;
}

/** Query keys; `decision`, `principle` and `proposal` events invalidate by their first element. */
export const knowledgeKeys = {
  all: ['knowledge'],
  list: (kind: KnowledgeItemKind, f: KnowledgeFilter) => ['knowledge', kind, f] as const,
  proposals: (projectId: ProjectId) => ['proposals', projectId] as const,
  provenance: (id: DecisionId | PrincipleId) => ['provenance', id] as const,
} as const;

/** The most the list route answers; past it the view says the list is cut short. */
const LIST_LIMIT = 500;

function useKnowledge(kind: KnowledgeItemKind, f: KnowledgeFilter) {
  const { client } = useDaemon();
  const q = f.q.trim();
  return useQuery({
    queryKey: knowledgeKeys.list(kind, f),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].knowledge.$get({
          param: { projectId: f.projectId },
          query: {
            kind,
            limit: String(LIST_LIMIT),
            history: f.history ? '1' : '0',
            ...(f.scope ? { scope: f.scope } : {}),
            ...(f.area ? { area: f.area } : {}),
            ...(q ? { q } : {}),
          },
        }),
        KnowledgeListDto,
      ),
  });
}

export const useKnowledgePrinciples = (f: KnowledgeFilter) =>
  useKnowledge(KnowledgeItemKind.Principle, f);
export const useKnowledgeDecisions = (f: KnowledgeFilter) =>
  useKnowledge(KnowledgeItemKind.Decision, f);

const Proposals = z.array(ProposalDto);

/** The project's pending proposals; the Proposals tab and its count share this query. */
export function useProposals(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: knowledgeKeys.proposals(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].proposals.$get({
          param: { projectId },
          query: { status: 'pending' },
        }),
        Proposals,
      ),
  });
}

/** The record whose provenance is open. `label` names it for the drawer. */
export interface TracedRecord {
  readonly kind: KnowledgeItemKind;
  readonly id: DecisionId | PrincipleId;
  readonly label: string;
}

/**
 * Where a record came from and what has happened to it. A retire, a withdrawal or a replacement changes
 * it, so the record's events refetch it.
 */
export function useProvenance(record: TracedRecord | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: record ? knowledgeKeys.provenance(record.id) : ['provenance', 'none'],
    enabled: record !== null,
    queryFn: async () => {
      if (record === null) return null;
      const res =
        record.kind === KnowledgeItemKind.Decision
          ? await client.decisions[':id'].provenance.$get({ param: { id: record.id } })
          : await client.principles[':id'].provenance.$get({ param: { id: record.id } });
      return readJson(res, ProvenanceDto);
    },
  });
}
