import {
  DecisionItem,
  KnowledgeItemKind,
  KnowledgeListDto,
  KnowledgeState,
  PrincipleItem,
  ProposalDto,
  ProvenanceDto,
  type DecisionEdit,
  type DecisionId,
  type DecisionWrite,
  type KnowledgeScope,
  type PrincipleEdit,
  type PrincipleId,
  type PrincipleWrite,
  type ProjectId,
  type ProposalId,
  type ProposalVerdictAccept,
  type ProposalVerdictReject,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';
import { queryKeys } from './queries';

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
export function useProposals(projectId: ProjectId, enabled = true) {
  const { client } = useDaemon();
  return useQuery({
    enabled,
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

/** A record by its id, as a link knows it before anything has loaded. */
export interface RecordRef {
  readonly kind: KnowledgeItemKind;
  readonly id: DecisionId | PrincipleId;
}

/** The record whose provenance is open. `label` names it for the drawer. */
export interface TracedRecord extends RecordRef {
  readonly label: string;
}

/**
 * Where a record came from and what has happened to it. A retire, a withdrawal or a replacement changes
 * it, so the record's events refetch it.
 */
export function useProvenance(record: RecordRef | null) {
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

/** The most versions one chain is followed through; a chain is a handful, so this only ends a loop. */
const MAX_CHAIN = 100;

/** The newest version of a record, in its own words, and what state it is in. */
export interface NewestVersion {
  readonly id: DecisionId | PrincipleId;
  readonly kind: KnowledgeItemKind;
  readonly label: string;
  readonly state: KnowledgeState;
}

/**
 * Follows a superseded record to the newest version of its chain, the only one that can be withdrawn.
 * Each step reads the provenance of the next version, which also says in words what the version after it is.
 */
export function useNewestVersion(record: TracedRecord | null) {
  const { client } = useDaemon();
  const read = async (kind: KnowledgeItemKind, id: DecisionId | PrincipleId) =>
    readJson(
      kind === KnowledgeItemKind.Decision
        ? await client.decisions[':id'].provenance.$get({ param: { id } })
        : await client.principles[':id'].provenance.$get({ param: { id } }),
      ProvenanceDto,
    );
  return useQuery({
    queryKey: record ? ['provenance', 'newest', record.id] : ['provenance', 'newest', 'none'],
    enabled: record !== null,
    queryFn: async (): Promise<NewestVersion | null> => {
      if (record === null) return null;
      let at = await read(record.kind, record.id);
      let newest: NewestVersion = { ...record, state: at.state };
      for (let step = 0; step < MAX_CHAIN; step += 1) {
        if (at.state !== KnowledgeState.Superseded || at.supersededBy === null) break;
        const next = await read(record.kind, at.supersededBy);
        newest = {
          id: at.supersededBy,
          kind: record.kind,
          label: at.supersededByText ?? record.label,
          state: next.state,
        };
        at = next;
      }
      return newest;
    },
  });
}

/** Every knowledge write can change all three lists and its provenance, and a verdict closes an inbox card. */
function useKnowledgeWrite<V, R>(mutationFn: (variables: V) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () =>
      Promise.all(
        [knowledgeKeys.all, ['proposals'], ['provenance'], queryKeys.inbox].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      ),
  });
}

export function useRecordDecision(projectId: ProjectId) {
  const { client } = useDaemon();
  return useKnowledgeWrite(async (input: DecisionWrite) =>
    readJson(
      await client.projects[':projectId'].decisions.$post({ param: { projectId }, json: input }),
      DecisionItem,
    ),
  );
}

/** Edit on a decision: a successor linked to it by the route, which moves the old one to History. */
export function useSupersedeDecision() {
  const { client } = useDaemon();
  return useKnowledgeWrite(
    async ({ id, input }: { readonly id: DecisionId; readonly input: DecisionEdit }) =>
      readJson(
        await client.decisions[':id'].supersede.$post({ param: { id }, json: input }),
        DecisionItem,
      ),
  );
}

export function useWithdrawDecision() {
  const { client } = useDaemon();
  return useKnowledgeWrite(
    async ({ id, reason }: { readonly id: DecisionId; readonly reason: string }) =>
      readJson(
        await client.decisions[':id'].withdraw.$post({ param: { id }, json: { reason } }),
        DecisionItem,
      ),
  );
}

export function useCreatePrinciple(projectId: ProjectId) {
  const { client } = useDaemon();
  return useKnowledgeWrite(async (input: PrincipleWrite) =>
    readJson(
      await client.projects[':projectId'].principles.$post({ param: { projectId }, json: input }),
      PrincipleItem,
    ),
  );
}

/** Edit on a principle: a successor linked to it by the route, with its key unless the body changes it. */
export function useSupersedePrinciple() {
  const { client } = useDaemon();
  return useKnowledgeWrite(
    async ({ id, input }: { readonly id: PrincipleId; readonly input: PrincipleEdit }) =>
      readJson(
        await client.principles[':id'].supersede.$post({ param: { id }, json: input }),
        PrincipleItem,
      ),
  );
}

export function useRetirePrinciple() {
  const { client } = useDaemon();
  return useKnowledgeWrite(
    async ({ id, reason }: { readonly id: PrincipleId; readonly reason: string }) =>
      readJson(
        await client.principles[':id'].retire.$post({ param: { id }, json: { reason } }),
        PrincipleItem,
      ),
  );
}

export function useWithdrawPrinciple() {
  const { client } = useDaemon();
  return useKnowledgeWrite(
    async ({ id, reason }: { readonly id: PrincipleId; readonly reason: string }) =>
      readJson(
        await client.principles[':id'].withdraw.$post({ param: { id }, json: { reason } }),
        PrincipleItem,
      ),
  );
}

export function useAcceptProposal() {
  const { client } = useDaemon();
  return useKnowledgeWrite(
    async ({ id, input }: { readonly id: ProposalId; readonly input: ProposalVerdictAccept }) =>
      readJson(
        await client.proposals[':id'].accept.$post({ param: { id }, json: input }),
        ProposalDto,
      ),
  );
}

export function useRejectProposal() {
  const { client } = useDaemon();
  return useKnowledgeWrite(
    async ({ id, input }: { readonly id: ProposalId; readonly input: ProposalVerdictReject }) =>
      readJson(
        await client.proposals[':id'].reject.$post({ param: { id }, json: input }),
        ProposalDto,
      ),
  );
}
