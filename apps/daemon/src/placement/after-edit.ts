import { kindsOfTask, type KindDto, type TaskKind } from '@10db/contracts';
import { proposePlacement, type PlacementProposal } from './propose';

type Project = Parameters<typeof proposePlacement>[0];

/**
 * Where the placement rule puts a task whose areas or kinds are as given, for every edit that can change
 * them: the builder's patch and sizing. The kinds are read against the builder's own, so a kind that was
 * deleted adds nothing.
 */
export function placementAfterEdit(input: {
  readonly project: Project;
  readonly areas: readonly string[];
  readonly kinds: readonly TaskKind[];
  readonly known: readonly Pick<KindDto, 'key' | 'label' | 'ownCopy'>[];
}): PlacementProposal {
  return proposePlacement(input.project, {
    areas: input.areas,
    kinds: kindsOfTask(input.kinds, input.known),
  });
}
