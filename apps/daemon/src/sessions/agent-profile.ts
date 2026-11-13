import {
  AgentProfileKind,
  type AgentSessionSpec,
  type ExploreSessionSpec,
  type LaneSessionSpec,
} from './types';

function isLane(spec: AgentSessionSpec): spec is LaneSessionSpec {
  return spec.profile.kind === AgentProfileKind.Lane;
}

/**
 * Runs the branch for the spec's profile, with the spec narrowed to it. TypeScript doesn't narrow a
 * spec by its nested `profile.kind`, so the narrowing is done here, once; a profile added to
 * `AgentSessionSpec` stops compiling until it has a branch.
 */
export function onProfile<T>(
  spec: AgentSessionSpec,
  branches: {
    readonly lane: (spec: LaneSessionSpec) => T;
    readonly explore: (spec: ExploreSessionSpec) => T;
  },
): T {
  if (isLane(spec)) return branches.lane(spec);
  return branches.explore(spec);
}
