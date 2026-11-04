import { type InboxItemDto, type PrincipleDto, ProposalId } from '@10db/contracts';
import { useProposals } from '../../daemon/knowledge-queries';
import { isPrincipleCard } from './permission-labels';

/**
 * The principle a proposal card asks about, as the Knowledge view's proposals list it: its kind and
 * the area it is for. Null while it loads, for a card about no principle, and when `enabled` is false
 * (a card nobody has opened needs none of it).
 */
export function usePrincipleOf(item: InboxItemDto, enabled: boolean): PrincipleDto | null {
  const principleCard = isPrincipleCard(item);
  const proposals = useProposals(item.projectId, enabled && principleCard);
  if (!principleCard) return null;
  // The detail is JSON read back from the daemon: a boundary, so parse it.
  const id = ProposalId.safeParse(item.detail?.['proposalId']);
  if (!id.success) return null;
  return proposals.data?.find((p) => p.id === id.data)?.principle ?? null;
}
